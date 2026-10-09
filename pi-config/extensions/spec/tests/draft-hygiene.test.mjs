// Black-box fixture checks for the drafts-left-behind report and the approved-list prune (sova-spec-draft.mjs).
// Node stdlib only; Git fixtures use the git CLI. Each fixture lives in its own temp dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../core/sova-spec-draft.mjs");
const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "../core/sova-spec.mjs");
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
const core = (root, ...a) => JSON.parse(spawnSync(process.execPath, [CORE, ...a, "--root", root, "--json"], { encoding: "utf8", cwd: root, env: fixtureEnv(root) }).stdout);
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

// The report under test: `drafts [--older-than <days>]`, read-only. Entries: { name, state, reasons: [string] }.
const report = (root, ...a) => run(root, "drafts", ...a);
const entry = (j, name) => (j.drafts ?? []).find((d) => d.name === name);
const stateOf = (j, name) => entry(j, name)?.state ?? "(not listed)";

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
  assert.equal(pre.exit, 0, JSON.stringify(pre));
  assert.notEqual(stateOf(pre, "leftover"), "landed", "unmerged work is not reported as landed");

  git(root, "merge", "-q", "--no-ff", "-m", "merge feat", "feat");
  const after = report(wt);
  assert.equal(after.exit, 0);
  assert.equal(stateOf(after, "leftover"), "landed", JSON.stringify(after.drafts));
  assert.ok(entry(after, "leftover").reasons.join(" ").includes("§b/other"), "the reason names the pending id");
  assert.ok(Array.isArray(entry(after, "leftover").reasons) && entry(after, "leftover").reasons.length > 0);

  // the census mentions the pending draft (once)
  const census = JSON.stringify(core(wt, "census", "--changed"));
  assert.ok(census.includes("leftover"), "census names the landed draft");

  const pv = run(wt, "promote", "leftover", "--id", "§b/other");
  assert.equal(pv.exit, 0, JSON.stringify(pv.findings));
  const w = run(wt, "promote", "leftover", "--id", "§b/other", "--plan", pv.plan, "--write");
  assert.equal(w.exit, 0, JSON.stringify(w.findings));
  assert.notEqual(stateOf(report(wt), "leftover"), "landed", "after promote the draft is no longer landed-and-pending");
});

// ---------------------------------------------------------------- (ii) superseded, conflict, stale; fresh is not flagged
test("superseded, conflict and old drafts are each listed with a reason; a fresh active draft is not flagged", () => {
  const root = project();
  newDraft(root, "sup");
  write(root, D("sup", "claims/b/other.md"), "# §b/other\n\nOther does Z better.\n");
  newDraft(root, "clash");
  write(root, D("clash", "claims/a/top.md"), TOP.replace("One does X.", "One does X twice."));
  newDraft(root, "fresh");
  write(root, D("fresh", "claims/a/top.md"), TOP.replace("The top surface.", "The top surface, renamed."));
  newDraft(root, "old");
  write(root, D("old", "claims/a/top.md"), TOP.replace("The top surface.", "The top surface, renamed."));
  editJson(root, ".sova/spec/drafts/old/draft.json", (d) => { d.createdAt = new Date(Date.now() - 30 * 864e5).toISOString(); });
  // another change lands the same prose `sup` proposes, and different prose for what `clash` edits
  write(root, ".sova/spec/claims/b/other.md", "# §b/other\n\nOther does Z better.\n");
  write(root, ".sova/spec/claims/a/top.md", TOP.replace("One does X.", "One does X once."));
  assert.ok(run(root, "status", "sup").ids.every((i) => i.current === "already-current"), "fixture: sup is fully current");
  assert.ok(run(root, "status", "clash").ids.some((i) => i.current === "conflict"), "fixture: clash conflicts");

  const before = tree(root, ".sova/spec");
  const j = report(root, "--older-than", "7");
  assert.equal(j.exit, 0, JSON.stringify(j));
  assert.deepEqual(tree(root, ".sova/spec"), before, "the report writes nothing");
  assert.equal(stateOf(j, "sup"), "superseded", JSON.stringify(j.drafts));
  assert.equal(stateOf(j, "clash"), "conflict", JSON.stringify(j.drafts));
  assert.equal(stateOf(j, "old"), "stale", JSON.stringify(j.drafts));
  for (const n of ["sup", "clash", "old"]) assert.ok(entry(j, n).reasons.length > 0, `${n} has a reason`);
  assert.ok(!["superseded", "conflict", "stale", "landed"].includes(stateOf(j, "fresh")), `fresh draft not flagged: ${stateOf(j, "fresh")}`);
  // the age threshold is the caller's: with a longer window the old draft is no longer stale
  assert.notEqual(stateOf(report(root, "--older-than", "60"), "old"), "stale");
});

test("one unreadable draft does not hide the others from the report", () => {
  const root = project();
  newDraft(root, "broken");
  newDraft(root, "sup");
  write(root, D("sup", "claims/b/other.md"), "# §b/other\n\nOther does Z better.\n");
  write(root, ".sova/spec/claims/b/other.md", "# §b/other\n\nOther does Z better.\n");
  write(root, ".sova/spec/drafts/broken/base/claims/b/other.md", "# §b/other\n\nRewritten history.\n");
  const j = report(root);
  assert.equal(j.exit, 0, JSON.stringify(j));
  assert.equal(stateOf(j, "sup"), "superseded");
  assert.ok(entry(j, "broken")?.reasons.length > 0, "the unreadable draft is listed with a reason");
});

// ---------------------------------------------------------------- (iii) prune only what the approved list names
test("prune deletes exactly the drafts on the approved list, and nothing without one", () => {
  const root = project();
  for (const n of ["keep", "drop1", "drop2"]) newDraft(root, n);
  const spec = current(root);
  const list = join(tmp(), "approved.txt");
  writeFileSync(list, "drop1\ndrop2\n");

  const none = run(root, "prune");
  assert.notEqual(none.exit, 0, "prune without a list refuses");
  const none2 = run(root, "prune", "--write");
  assert.notEqual(none2.exit, 0, "prune --write without a list refuses");
  assert.deepEqual(draftNames(root), ["drop1", "drop2", "keep"], "nothing deleted without a list");

  const pv = run(root, "prune", "--approved", list);
  assert.equal(pv.exit, 0, JSON.stringify(pv));
  assert.deepEqual(draftNames(root), ["drop1", "drop2", "keep"], "preview deletes nothing");

  const bad = join(tmp(), "bad.txt");
  writeFileSync(bad, "drop1\n../../claims\n");
  assert.notEqual(run(root, "prune", "--approved", bad, "--write").exit, 0, "a list with an unsafe name is refused");
  assert.deepEqual(draftNames(root), ["drop1", "drop2", "keep"], "a refused list deletes nothing");

  const w = run(root, "prune", "--approved", list, "--write");
  assert.equal(w.exit, 0, JSON.stringify(w));
  assert.deepEqual(draftNames(root), ["keep"], "exactly the listed drafts are gone");
  assert.deepEqual(current(root), spec, "the current spec is untouched");
  assert.equal(run(root, "status", "keep").exit, 0, "the kept draft is intact");
});
