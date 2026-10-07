// The Spec review playbook (playbooks/spec-review): a Markdown-only,
// operator-run bundle the real catalog loader lists with no schedule, whose published shell blocks run
// as written with their placeholders filled: the preflight refuses a bad root or base before it lists
// anything and caps its list, the metadata block's known-base flags are accepted by the trusted tools,
// and the reading call lists the contents, then reads one passage within its budget. Throwaway repositories and agent dir only.
// The playbook's shell steps run against a real repository; its listing by the real loader is spec-review-playbook.test.ts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { listPlaybooks, parseFrontmatter } from "./playbooks";

const PLAYBOOK = fileURLToPath(new URL("../playbooks/spec-review/", import.meta.url));
const TEXT = readFileSync(join(PLAYBOOK, "PLAYBOOK.md"), "utf8");
const CORE = fileURLToPath(new URL("../pi-config/extensions/spec/core", import.meta.url));
const SPEC_MODE = fileURLToPath(new URL("../pi-config/extensions/mode/spec-mode.md", import.meta.url));
/** The playbook's shell blocks, in order: the preflight, the metadata call, the reading call (toc, then read). */
const BLOCKS = [...TEXT.matchAll(/^```sh\n([\s\S]*?)^```$/gm)].map((m) => m[1]!);

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "spec-review-playbook-")));
after(() => rmSync(tmp, { recursive: true, force: true }));
const write = (root: string, p: string, s: string) => {
  mkdirSync(dirname(join(root, p)), { recursive: true });
  writeFileSync(join(root, p), s);
};
const git = (root: string, ...a: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=master", "-C", root, ...a], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
let n = 0;
/** A committed one-claim project, then a change to its mapped file and one untracked file. */
function project() {
  const R = join(tmp, `project-${n++}`);
  write(R, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, boundary: { include: ["lib"], exclude: [] }, claims: {
    "§app/rule": { kind: "behavior", requires: [], authority: "accepted", evidence: "verified", code: ["lib/rule.js"] },
    // An always-on frame of ~5.7 KB: the first read carries it outside its budget (§tools.spec/frame).
    "§app/ground": { kind: "note", authority: "accepted", core: true },
  } }));
  write(R, ".sova/spec/claims/app/rule.md", `# §app/rule\n\n${"Meter fill warns at ≥80%. ".repeat(200)}\n`);
  write(R, ".sova/spec/claims/app/ground.md", `# §app/ground\n\n${"Every task keeps the ground rules. ".repeat(160)}\n`);
  write(R, "lib/rule.js", "export const threshold = 80;\n");
  write(R, ".gitignore", ".sova/spec/drafts/\n");
  git(R, "init");
  git(R, "add", ".");
  git(R, "commit", "-m", "baseline");
  const B = git(R, "rev-parse", "HEAD");
  write(R, "lib/rule.js", "export const threshold = 90;\n");
  write(R, "lib/new.js", "export const n = 1;\n");
  return { R, B };
}
/** A block with its placeholders written out, as the playbook tells the agent to. */
const fill = (block: string, v: Record<string, string>) => Object.entries(v).reduce((s, [k, x]) => s.replaceAll(`<${k}>`, x), block);
/** One shell call, in a throwaway agent dir whose spec core is the canonical one. */
function sh(script: string) {
  const agent = join(tmp, "agent");
  if (!existsSync(agent)) {
    mkdirSync(join(agent, "extensions", "spec"), { recursive: true });
    symlinkSync(CORE, join(agent, "extensions", "spec", "core"));
  }
  // The node running this test comes first: a version-manager shim may refuse an untrusted config here.
  const PATH = [dirname(process.execPath), process.env.PATH ?? ""].join(":");
  const r = spawnSync("sh", ["-c", script], { cwd: tmp, encoding: "utf8", env: { ...process.env, PATH, PI_CODING_AGENT_DIR: agent }, timeout: 120_000 });
  assert.ifError(r.error);
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("preflight: an ancestor base prints itself and the change since it; a bad root or base is refused before anything is listed", () => {
  const { R, B } = project();
  let r = sh(fill(BLOCKS[0]!, { root: R, base: "master" }));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.out.trim().split("\n"), [`base ${B}`, "lib/new.js", "lib/rule.js"]);

  git(R, "checkout", "-q", "-b", "side");
  write(R, "lib/side.js", "1\n");
  git(R, "add", "lib/side.js");
  git(R, "commit", "-qm", "side");
  git(R, "checkout", "-q", "master");
  const refusals: [Record<string, string>, RegExp][] = [
    [{ root: R, base: "side" }, /^refused: side is not an ancestor of HEAD$/],
    [{ root: R, base: "no-such-rev" }, /^refused: no-such-rev is not a commit here$/],
    [{ root: join(R, "lib"), base: "master" }, /^refused: .*\/lib is not a checkout's top folder$/],
    [{ root: join(tmp, "absent"), base: "master" }, /is not a checkout's top folder$/],
  ];
  for (const [v, refusal] of refusals) {
    r = sh(fill(BLOCKS[0]!, v));
    assert.equal(r.code, 2, `${JSON.stringify(v)}: ${r.out}`);
    assert.match(r.out.trim(), refusal, "one refusal line and nothing listed");
  }
});

test("preflight: the change list stops at 201 lines, one past the 200 a brief may carry", () => {
  const { R } = project();
  for (let i = 0; i < 250; i++) write(R, `lib/many/f${String(i).padStart(3, "0")}.js`, `${i}\n`);
  const r = sh(fill(BLOCKS[0]!, { root: R, base: "master" }));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim().split("\n").length, 1 + 201);
});

test("the metadata call's known-base flags are accepted by git and the trusted tools, and the reading call lists contents, then reads one exact passage within its budget", () => {
  const { R, B } = project();
  const r = sh(fill(BLOCKS[1]!, { root: R, base: B, paths: "lib/rule.js" }));
  assert.match(r.out, /^ lib\/rule\.js \| 2 \+-$/m, "diff --stat against the base, scoped");
  assert.doesNotMatch(r.out, /lib\/new\.js \|/, "the stat carries only the scoped paths");
  const docs = r.out.slice(r.out.indexOf("{")).split(/\n(?=\{)/).map((d) => JSON.parse(d));
  assert.deepEqual(docs.map((d) => d.command), ["census", "foreign"]);
  for (const d of docs) assert.notEqual(d.exit, 2, JSON.stringify(d.findings));
  assert.equal(docs[0].census.base.commit, B);
  assert.deepEqual(docs[0].census.claimed.map((c: { path: string }) => c.path), ["lib/rule.js"]);

  assert.doesNotMatch(BLOCKS[2]!, /\b(packet|scope)\b/, "whole-chain packet and scope are not the reading step");
  const passage = readFileSync(join(R, ".sova/spec/claims/app/rule.md"), "utf8");
  for (const budget of ["12000", "1024"]) {
    const p = sh(fill(BLOCKS[2]!, { root: R, "§id": "§app/rule" }).replace("--budget 12000", `--budget ${budget}`));
    const [toc, page, ...rest] = p.out.trimEnd().split("\n");
    assert.deepEqual(rest, [], "one line per call");
    const contents = JSON.parse(toc!), read = JSON.parse(page!);
    assert.deepEqual([contents.command, contents.dir, read.command], ["toc", "out", "read"]);
    assert.notEqual(contents.exit, 2, toc);
    assert.deepEqual(contents.footer.delivered, [], "contents only: no passage");
    assert.notEqual(read.exit, 2, page);
    assert.equal(read.budget, Number(budget));
    // The first read carries the always-on frame outside its budget: the page without the frame's passages fits.
    assert.deepEqual(read.frame.items.map((i: { id: string }) => i.id), ["§app/ground"], "the first read brings the frame");
    const { items: frameItems, ...frameSummary } = read.frame;
    const withoutFrame = JSON.stringify({ ...read, frame: frameSummary });
    assert.ok(Buffer.byteLength(withoutFrame) + 1 <= Number(budget), `${Buffer.byteLength(withoutFrame)} bytes, the frame aside, over a ${budget} budget`);
    assert.ok(Buffer.byteLength(page!) > Buffer.byteLength(withoutFrame) + Buffer.byteLength(frameItems[0].text), "the frame's passage is on the page too");
    assert.deepEqual([...new Set(read.items.map((i: { id: string }) => i.id))], ["§app/rule"], "one passage, nothing it links");
    const item = read.items[0];
    assert.equal(item.fragment.start, 0);
    assert.ok(passage.startsWith(item.text), "the passage, exact");
    assert.equal(read.next === null, item.fragment.end === item.fragment.total, "a cut passage names its continuation");
    // Every later read adds --no-frame, as the block says: then the whole page is within the budget.
    assert.match(BLOCKS[2]!, /every later read adds --no-frame/);
    const later = sh(fill(BLOCKS[2]!, { root: R, "§id": "§app/rule" }).replace("--budget 12000", `--budget ${budget} --no-frame`));
    const laterPage = later.out.trimEnd().split("\n")[1]!;
    const laterRead = JSON.parse(laterPage);
    assert.notEqual(laterRead.exit, 2, laterPage);
    assert.equal(laterRead.frame?.items, undefined, "--no-frame drops the frame");
    assert.ok(Buffer.byteLength(laterPage) + 1 <= Number(budget), `${Buffer.byteLength(laterPage)} bytes over a ${budget} budget`);
  }
});
