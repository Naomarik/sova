// Black-box fixture checks for the drafts-left-behind report and the approved-list prune (sova-spec-draft.mjs).
// Node stdlib only; Git fixtures use the git CLI. Each fixture lives in its own temp dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../core/sova-spec-draft.mjs");
const fixtureEnv = (root) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home") });
const sha = (s) => createHash("sha256").update(s).digest("hex");
const hasGit = spawnSync("git", ["--version"]).status === 0;

const roots = [];
process.on("exit", () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const tmp = () => { const r = mkdtempSync(join(tmpdir(), "sova-draft-hygiene-")); roots.push(r); return r; };

function write(root, rel, text) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}
const read = (root, rel) => readFileSync(join(root, rel), "utf8");
const manifest = (claims) => JSON.stringify({ formatVersion: 1, claims }, null, 2) + "\n";
const CLAIMS = {
  "§a/top": { kind: "surface", authority: "accepted" },
  "§a.top/one": { kind: "behavior", authority: "accepted", requires: [], code: ["lib/one.txt"] },
  "§b/other": { kind: "behavior", authority: "accepted", requires: [], code: ["lib/other.txt"] },
};
const TOP = "# §a/top\n\nThe top surface.\n\n## §a.top/one\n\nOne does X.\n";
const OTHER = "# §b/other\n\nOther does Z.\n";
function project(root = tmp()) {
  write(root, ".sova/spec/manifest.json", manifest(CLAIMS));
  write(root, ".sova/spec/claims/a/top.md", TOP);
  write(root, ".sova/spec/claims/b/other.md", OTHER);
  write(root, ".sova/spec/.gitignore", "/drafts/\n"); // as in a real project: drafts are local, never committed
  for (const f of ["one", "other"]) write(root, `lib/${f}.txt`, `${f} v1\n`);
  return root;
}
function run(root, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--root", root, "--json"], { encoding: "utf8", cwd: root, env: fixtureEnv(root) });
  let j;
  try { j = JSON.parse(r.stdout); } catch { assert.fail(`non-JSON stdout (status ${r.status}): ${r.stdout}\n${r.stderr}`); }
  assert.equal(r.status, j.exit, "process status equals JSON exit");
  return j;
}
function git(root, ...a) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-C", root, ...a], { encoding: "utf8", env: fixtureEnv(root) });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
const D = (name, rel = "") => `.sova/spec/drafts/${name}/spec${rel ? `/${rel}` : ""}`;
const newDraft = (root, name) => { const j = run(root, "new", name, "--write"); assert.equal(j.exit, 0, JSON.stringify(j.findings)); return j; };
const editJson = (root, rel, fn) => { const m = JSON.parse(read(root, rel)); fn(m); write(root, rel, JSON.stringify(m, null, 2) + "\n"); };
const draftNames = (root) => existsSync(join(root, ".sova/spec/drafts")) ? readdirSync(join(root, ".sova/spec/drafts")).filter((n) => !n.startsWith(".")).sort() : [];
function tree(root, sub) {
  const out = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n), st = statSync(p); if (st.isDirectory()) walk(p); else out[p] = sha(readFileSync(p)); } };
  if (existsSync(join(root, sub))) walk(join(root, sub));
  return out;
}
const current = (root) => Object.fromEntries(Object.entries(tree(root, ".sova/spec")).filter(([p]) => !p.includes("/drafts/")));


// The report under test: `drafts [--days N]`, read-only; exit 0 when nothing is flagged, 1 otherwise.
// Entries: { name, state, reasons: [string], draftSha256, ... }; flagged states: landed, promoted, superseded, old, unreadable.
const report = (root, ...a) => { const j = run(root, "drafts", ...a); assert.notEqual(j.exit, 2, JSON.stringify(j)); return j; };
const entry = (j, name) => (j.drafts ?? []).find((d) => d.name === name);
const stateOf = (j, name) => entry(j, name)?.state ?? "(not listed)";
const FLAGGED = ["landed", "promoted", "superseded", "old", "unreadable"];
const backdate = (root, name, days) => {
  const when = new Date(Date.now() - days * 864e5);
  editJson(root, `.sova/spec/drafts/${name}/draft.json`, (d) => { d.createdAt = when.toISOString(); });
  const walk = (p) => { if (statSync(p).isDirectory()) for (const n of readdirSync(p)) walk(join(p, n)); utimesSync(p, when, when); };
  walk(join(root, ".sova/spec/drafts", name));
};

// ---------------------------------------------------------------- (i) landed, not promoted
test("a worktree draft whose code merged into the default branch is reported as landed until promoted", { skip: !hasGit }, () => {
  const root = project();
  git(root, "init", "-q"); git(root, "add", "-A"); git(root, "commit", "-qm", "base");
  const wt = join(tmp(), "wt");
  git(root, "worktree", "add", "-q", "-b", "feat", wt);
  newDraft(wt, "leftover");
  write(wt, D("leftover", "claims/b/other.md"), "# §b/other\n\nOther does Z better.\n");
  write(wt, "lib/other.txt", "other v2\n");
  git(wt, "add", "lib/other.txt"); git(wt, "commit", "-qm", "implement other");
  const ev = run(wt, "evidence", "leftover", "--id", "§b/other", "--by", "t", "--verification", "npm test: pass", "--commit", "HEAD", "--write");
  assert.equal(ev.exit, 0, JSON.stringify(ev.findings));
  assert.equal(run(wt, "status", "leftover").ids[0].current, "pending");

  // guard: the branch is not on the default branch yet, so the draft is active work, not left behind
  const pre = report(wt);
  assert.equal(stateOf(pre, "leftover"), "active", JSON.stringify(pre.drafts));
  assert.equal(pre.exit, 0, "nothing flagged before the merge");

  git(root, "merge", "-q", "--no-ff", "-m", "merge feat", "feat");
  const after = report(wt);
  assert.equal(stateOf(after, "leftover"), "landed", JSON.stringify(after.drafts));
  assert.equal(after.exit, 1, "a flagged draft exits 1");
  assert.ok(entry(after, "leftover").reasons.join(" ").includes("§b/other"), "the reason names the pending id");

  const pv = run(wt, "promote", "leftover", "--id", "§b/other");
  assert.equal(pv.exit, 0, JSON.stringify(pv.findings));
  const w = run(wt, "promote", "leftover", "--id", "§b/other", "--plan", pv.plan, "--write");
  assert.equal(w.exit, 0, JSON.stringify(w.findings));
  const done = report(wt);
  assert.notEqual(stateOf(done, "leftover"), "landed", "after promote the draft is no longer landed-and-pending");
  assert.equal(stateOf(done, "leftover"), "promoted", JSON.stringify(done.drafts));
});

// ---------------------------------------------------------------- (ii) promoted, superseded, old; fresh is not flagged
test("fully current, conflict-only and old drafts are each listed with a reason; a fresh active draft is not flagged", () => {
  const root = project();
  newDraft(root, "same");
  write(root, D("same", "claims/b/other.md"), "# §b/other\n\nOther does Z better.\n");
  newDraft(root, "clash");
  write(root, D("clash", "claims/a/top.md"), TOP.replace("One does X.", "One does X twice."));
  newDraft(root, "fresh");
  write(root, D("fresh", "claims/a/top.md"), TOP.replace("The top surface.", "The top surface, renamed."));
  newDraft(root, "old");
  write(root, D("old", "claims/a/top.md"), TOP.replace("The top surface.", "The top surface, renamed."));
  backdate(root, "old", 30);
  // another change lands the same prose `same` proposes, and different prose for what `clash` edits
  write(root, ".sova/spec/claims/b/other.md", "# §b/other\n\nOther does Z better.\n");
  write(root, ".sova/spec/claims/a/top.md", TOP.replace("One does X.", "One does X once."));
  assert.ok(run(root, "status", "same").ids.every((i) => i.current === "already-current"), "fixture: same is fully current");
  assert.ok(run(root, "status", "clash").ids.every((i) => i.current === "conflict"), "fixture: clash only conflicts");
  for (const n of ["fresh", "old"]) assert.ok(run(root, "status", n).ids.every((i) => i.current === "pending"), `fixture: ${n} is pending`);

  const before = tree(root, ".sova/spec");
  const j = report(root, "--days", "7");
  assert.deepEqual(tree(root, ".sova/spec"), before, "the report writes nothing");
  assert.equal(j.exit, 1);
  assert.equal(stateOf(j, "same"), "promoted", JSON.stringify(j.drafts));
  assert.equal(stateOf(j, "clash"), "superseded", JSON.stringify(j.drafts));
  assert.equal(stateOf(j, "old"), "old", JSON.stringify(j.drafts));
  for (const n of ["same", "clash", "old"]) assert.ok(entry(j, n).reasons.length > 0, `${n} has a reason`);
  assert.equal(stateOf(j, "fresh"), "active", "a fresh pending draft is not flagged");
  // the age threshold is the caller's: with a longer window the old draft is no longer old
  assert.equal(stateOf(report(root, "--days", "60"), "old"), "active");

  // promote mentions the old drafts in the root, once
  const ev = run(root, "evidence", "fresh", "--id", "§a/top", "--by", "t", "--verification", "ran the suite: pass", "--snapshot", "--path", "lib/one.txt", "--write");
  assert.equal(ev.exit, 0, JSON.stringify(ev.findings));
  const pv = run(root, "promote", "fresh", "--id", "§a/top");
  assert.equal(pv.staleDrafts?.count, 1, JSON.stringify(pv.staleDrafts));
});

test("one unreadable draft does not hide the others from the report", () => {
  const root = project();
  newDraft(root, "broken");
  newDraft(root, "same");
  write(root, D("same", "claims/b/other.md"), "# §b/other\n\nOther does Z better.\n");
  write(root, ".sova/spec/claims/b/other.md", "# §b/other\n\nOther does Z better.\n");
  write(root, ".sova/spec/drafts/broken/base/claims/b/other.md", "# §b/other\n\nRewritten history.\n");
  const j = report(root);
  assert.equal(stateOf(j, "same"), "promoted");
  assert.equal(stateOf(j, "broken"), "unreadable");
  assert.ok(entry(j, "broken").reasons.length > 0, "the unreadable draft is listed with a reason");
});

// ---------------------------------------------------------------- (iii) prune only what the approved list names
test("prune deletes exactly the drafts on the approved list, and nothing without one", () => {
  const root = project();
  for (const n of ["keep", "drop1", "drop2"]) newDraft(root, n);
  const spec = current(root);
  const all = ["drop1", "drop2", "keep"];
  const listFile = (text) => { const f = join(tmp(), "approved.txt"); writeFileSync(f, text); return f; };
  const sha1 = entry(report(root), "drop1").draftSha256;
  assert.ok(sha1, "the report gives each draft a sha to approve");

  assert.notEqual(run(root, "prune").exit, 0, "prune without a list refuses");
  assert.notEqual(run(root, "prune", "--write").exit, 0, "prune --write without a list refuses");
  assert.deepEqual(draftNames(root), all, "nothing deleted without a list");

  const list = listFile(`# approved by the user\ndrop1 ${sha1}\ndrop2\n`);
  const pv = run(root, "prune", "--approved", list);
  assert.equal(pv.exit, 0, JSON.stringify(pv));
  assert.deepEqual(draftNames(root), all, "preview deletes nothing");

  for (const [why, text] of [["an unsafe name", "drop1\n../../claims\n"], ["a missing name", "drop1\nnope\n"], ["a sha mismatch", `drop1 ${"0".repeat(64)}\ndrop2\n`]]) {
    assert.notEqual(run(root, "prune", "--approved", listFile(text), "--write").exit, 0, `a list with ${why} is refused`);
    assert.deepEqual(draftNames(root), all, `a list with ${why} deletes nothing`);
  }
  // a draft edited after approval no longer matches its approved sha
  write(root, D("drop1", "claims/b/other.md"), "# §b/other\n\nEdited after approval.\n");
  assert.notEqual(run(root, "prune", "--approved", list, "--write").exit, 0, "a draft changed since approval is refused");
  assert.deepEqual(draftNames(root), all);
  write(root, D("drop1", "claims/b/other.md"), OTHER);

  const w = run(root, "prune", "--approved", list, "--write");
  assert.equal(w.exit, 0, JSON.stringify(w));
  assert.deepEqual(draftNames(root), ["keep"], "exactly the listed drafts are gone");
  assert.deepEqual(current(root), spec, "the current spec is untouched");
  assert.equal(run(root, "status", "keep").exit, 0, "the kept draft is intact");
});
