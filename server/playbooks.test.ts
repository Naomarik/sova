// Run: npx tsx --test server/playbooks.test.ts (or npm test)
// The playbook catalog (server/playbooks.ts): three folders, one frontmatter grammar, and the
// project cwd handled on /api/files's terms. Uses a throwaway PI_CODING_AGENT_DIR in the OS temp
// dir; ~/.pi is never read or written. The shipped playbooks/ folder is read, never modified.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-playbooks-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const { isPlaybookId, listPlaybooks, parseFrontmatter, PROJECT_PLAYBOOKS, userPlaybooksDir } = await import("./playbooks");

after(() => rmSync(agentDir, { recursive: true, force: true }));

const scratch = mkdtempSync(join(agentDir, "trees-"));
let n = 0;
/** A fresh empty folder per call, so no test sees another's playbooks. */
const fresh = (label: string) => {
  const dir = join(scratch, `${label}-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
/** One playbook directory with the given PLAYBOOK.md text. */
const drop = (root: string, id: string, text: string) => {
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(join(root, id, "PLAYBOOK.md"), text);
};
const fm = (fields: Record<string, string>, body: string) =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n${body}`;
/** A shipped folder and an absent user folder: the baseline every test starts from. */
const base = () => ({ shippedDir: fresh("shipped"), userDir: join(fresh("user-parent"), "playbooks") });

test("shipped only: every well-formed playbook, sorted by title, with its absolute dir and stripped body", async () => {
  const deps = base();
  drop(deps.shippedDir, "zeta", fm({ title: "Alpha Last Id", description: "Sorts first by title" }, "# Z\n"));
  drop(deps.shippedDir, "alpha", fm({ title: "Beta", description: "d", promptHint: "Name your brand" }, "# A\nbody\n"));
  const cat = await listPlaybooks(undefined, deps);
  assert.deepEqual(cat.playbooks.map((p) => p.id), ["zeta", "alpha"], "title order, not id order");
  const a = cat.playbooks.find((p) => p.id === "alpha")!;
  assert.equal(a.source, "sova");
  assert.equal(a.dir, join(deps.shippedDir, "alpha"));
  assert.equal(a.body, "# A\nbody\n");
  assert.equal(a.promptHint, "Name your brand");
  assert.equal(cat.playbooks.find((p) => p.id === "zeta")!.promptHint, undefined, "no promptHint → absent, not empty");
  assert.deepEqual(cat.project, { state: "none" });
  assert.equal(cat.error, undefined, "a user folder that doesn't exist is empty, not an error");
});

test("the real shipped catalog: brandmaker parses, and its body no longer carries the fence", async () => {
  const cat = await listPlaybooks(undefined, { userDir: join(fresh("nouser"), "absent") });
  const b = cat.playbooks.find((p) => p.id === "brandmaker");
  assert.ok(b, "brandmaker is shipped");
  assert.equal(b.title, "Brandmaker");
  assert.ok(b.description.length > 0 && b.promptHint && b.promptHint.length > 0);
  assert.equal(b.dir, fileURLToPath(new URL("../playbooks/brandmaker", import.meta.url)));
  assert.match(b.body, /^# Brandmaker/);
  assert.ok(!b.body.includes("promptHint:"), "frontmatter stripped");
});

test("a user playbook with a shipped id replaces it, marked replacesSova; others are simply added", async () => {
  const deps = base();
  drop(deps.shippedDir, "brand", fm({ title: "Shipped Brand" }, "shipped"));
  drop(deps.shippedDir, "other", fm({ title: "Other" }, "other"));
  drop(deps.userDir, "brand", fm({ title: "My Brand" }, "mine"));
  drop(deps.userDir, "extra", fm({ title: "Extra" }, "extra"));
  const cat = await listPlaybooks(undefined, deps);
  assert.deepEqual(
    cat.playbooks.map((p) => [p.source, p.id]),
    [["sova", "other"], ["user", "extra"], ["user", "brand"]],
  );
  const brand = cat.playbooks.filter((p) => p.id === "brand");
  assert.equal(brand.length, 1, "the shipped copy is gone, not listed twice");
  assert.equal(brand[0]!.body, "mine");
  assert.equal(brand[0]!.replacesSova, true);
  assert.equal(cat.playbooks.find((p) => p.id === "extra")!.replacesSova, undefined);
});

test("the default user folder is <state root>/playbooks", async () => {
  assert.equal(userPlaybooksDir(), join(agentDir, "sova", "playbooks"));
  drop(userPlaybooksDir(), "from-state-root", fm({ title: "Via state root" }, "x"));
  const cat = await listPlaybooks(undefined, { shippedDir: fresh("shipped") });
  assert.deepEqual(cat.playbooks.map((p) => [p.source, p.id]), [["user", "from-state-root"]]);
  rmSync(userPlaybooksDir(), { recursive: true, force: true });
});

test("an unreadable user folder is reported in `error` and the rest is still listed", async () => {
  const deps = base();
  drop(deps.shippedDir, "one", fm({ title: "One" }, "1"));
  writeFileSync(deps.userDir, "a file where the folder should be"); // readdir → ENOTDIR, not ENOENT
  const cat = await listPlaybooks(undefined, deps);
  assert.ok(cat.error, "the failure is reported");
  assert.deepEqual(cat.playbooks.map((p) => p.id), ["one"]);
});

test("project playbooks are found under the cwd's .sova/marketing/playbooks", async () => {
  const deps = base();
  const cwd = fresh("project");
  drop(join(cwd, PROJECT_PLAYBOOKS), "launch", fm({ title: "Launch", description: "Ship it" }, "# Launch\n"));
  drop(deps.shippedDir, "launch", fm({ title: "Shipped Launch" }, "s"));
  const cat = await listPlaybooks(cwd, deps);
  assert.deepEqual(cat.project, { state: "ok" });
  assert.deepEqual(cat.playbooks.map((p) => [p.source, p.id]), [["sova", "launch"], ["project", "launch"]], "a project id replaces nothing");
  const p = cat.playbooks.find((x) => x.source === "project")!;
  assert.equal(p.dir, join(cwd, ".sova", "marketing", "playbooks", "launch"));
  assert.equal(p.description, "Ship it");
});

test("a cwd without .sova is ok and empty", async () => {
  const cat = await listPlaybooks(fresh("plain"), base());
  assert.deepEqual(cat.project, { state: "ok" });
  assert.equal(cat.playbooks.length, 0);
});

test("a nonexistent cwd is `missing` — a state, never a throw", async () => {
  const cat = await listPlaybooks(join(scratch, "no-such-folder"), base());
  assert.equal(cat.project.state, "missing");
  assert.ok(cat.project.message);
  assert.equal(cat.playbooks.length, 0);
});

test("a relative cwd is refused as `missing` without touching the fs", async () => {
  const cat = await listPlaybooks("relative/path", base());
  assert.equal(cat.project.state, "missing");
  assert.match(cat.project.message ?? "", /absolute/);
});

test("a remote placeholder cwd is `remote`, even when the placeholder holds playbooks a scan would find", async () => {
  // A real directory under <agent>/sova/targets/<name>/…, stocked with a playbook: if the refusal
  // weren't lexical and first, the scan below would list it.
  const cwd = join(agentDir, "sova", "targets", "box", "srv", "app");
  drop(join(cwd, PROJECT_PLAYBOOKS), "leak", fm({ title: "Leak" }, "x"));
  const cat = await listPlaybooks(cwd, base());
  assert.equal(cat.project.state, "remote");
  assert.match(cat.project.message ?? "", /box/);
  assert.ok(!cat.playbooks.some((p) => p.source === "project"));
});

test("a legacy-pi-web placeholder and a legacy sshfs mount are `remote` too", async () => {
  for (const cwd of [join(agentDir, "pi-web", "targets", "box", "srv"), join(agentDir, "mounts", "box", "srv")]) {
    const cat = await listPlaybooks(cwd, base());
    assert.equal(cat.project.state, "remote", cwd);
  }
});

test("path-map applies AFTER the remote refusal: a moved local root lists, a mapped placeholder stays remote", async () => {
  const oldRoot = join(scratch, "old-root");
  const newRoot = fresh("new-root");
  drop(join(newRoot, PROJECT_PLAYBOOKS), "moved", fm({ title: "Moved" }, "m"));
  const placeholder = join(agentDir, "sova", "targets", "box", "mapped");
  writeFileSync(
    join(agentDir, "sova", "path-map.json"),
    JSON.stringify({ version: 1, moved: [{ from: oldRoot, to: newRoot }, { from: placeholder, to: newRoot }] }),
  );
  try {
    const moved = await listPlaybooks(oldRoot, base());
    assert.deepEqual(moved.project, { state: "ok" });
    assert.deepEqual(moved.playbooks.map((p) => p.id), ["moved"]);
    assert.equal(moved.playbooks[0]!.dir, join(newRoot, PROJECT_PLAYBOOKS, "moved"));
    const remote = await listPlaybooks(placeholder, base());
    assert.equal(remote.project.state, "remote", "a placeholder is never re-read as a moved local folder");
    assert.equal(remote.playbooks.length, 0);
  } finally {
    rmSync(join(agentDir, "sova", "path-map.json"), { force: true });
  }
});

test("malformed or absent frontmatter still yields an entry with fallbacks", async () => {
  const deps = base();
  drop(deps.shippedDir, "bare", "# Just a body\n");
  drop(deps.shippedDir, "unclosed", "---\ntitle: Never closed\n# body\n");
  drop(deps.shippedDir, "junk", "---\nnot a pair\n: no key\ntitle:\n---\nbody");
  drop(deps.shippedDir, "spaces", '---\ntitle: "   "\ndescription: ""\n---\nbody');
  const cat = await listPlaybooks(undefined, deps);
  const by = Object.fromEntries(cat.playbooks.map((p) => [p.id, p]));
  assert.deepEqual([by.bare!.title, by.bare!.description, by.bare!.body], ["bare", "", "# Just a body\n"]);
  assert.equal(by.unclosed!.title, "unclosed", "an unclosed fence is no frontmatter");
  assert.equal(by.unclosed!.body, "---\ntitle: Never closed\n# body\n", "and the whole text is the body");
  assert.equal(by.junk!.title, "junk", "an empty title falls back to the id");
  assert.equal(by.junk!.body, "body");
  assert.equal(by.spaces!.title, "spaces", "a whitespace-only title (quoted, so it survives the parse) falls back to the id");
  assert.equal(by.spaces!.description, "", "an empty description stays empty");
});

test("traversal-shaped and non-id directory names are skipped; so are dirs without PLAYBOOK.md and plain files", async () => {
  const deps = base();
  for (const bad of [".hidden", "-lead", "Upper", "under_score", "dot.name", "..sneaky"]) drop(deps.shippedDir, bad, fm({ title: bad }, "x"));
  mkdirSync(join(deps.shippedDir, "empty-dir"));
  writeFileSync(join(deps.shippedDir, "loose-file"), "not a dir");
  drop(deps.shippedDir, "ok-1", fm({ title: "Ok" }, "fine"));
  const cat = await listPlaybooks(undefined, deps);
  assert.deepEqual(cat.playbooks.map((p) => p.id), ["ok-1"]);
  for (const id of ["..", "../etc", "a/b", "a\\b", "", ".", "A"]) assert.equal(isPlaybookId(id), false, id);
  for (const id of ["a", "0", "brand-maker", "x1-2"]) assert.equal(isPlaybookId(id), true, id);
});

test("parseFrontmatter: quotes, CRLF, BOM, colons in values, and a body that looks like frontmatter", () => {
  const r = parseFrontmatter('﻿---\r\ntitle: "Quoted: with colon"\r\ndescription: a: b\r\npromptHint: \'hint\'\r\n---\r\n\r\nBody\r\n');
  assert.deepEqual(r.fields, { title: "Quoted: with colon", description: "a: b", promptHint: "hint" });
  assert.equal(r.body, "Body\r\n");
  const later = parseFrontmatter("# Title\n---\ntitle: nope\n---\n");
  assert.deepEqual(later.fields, {}, "a fence not on line 1 is body text");
  assert.equal(later.body, "# Title\n---\ntitle: nope\n---\n");
});
