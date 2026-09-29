// Black-box tests for the tools that make the spec rules mechanical: core `foreign`, census `mappedOutside`,
// the draft tool's drift checks, `promote` alsoChanges and `merge-manifest`. Node stdlib and the git CLI only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(HERE, "../core/sova-spec.mjs");
const DRAFT = resolve(HERE, "../core/sova-spec-draft.mjs");

const roots = [];
process.on("exit", () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function write(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}
const read = (root, rel) => readFileSync(join(root, rel), "utf8");
function git(root, ...a) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=master", "-C", root, ...a], { encoding: "utf8", env });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}
const ok = (root, ...a) => { const r = git(root, ...a); assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.err}`); return r.out; };
function cli(tool, root, ...args) {
  const r = spawnSync(process.execPath, [tool, ...args, "--root", root, "--json"], { encoding: "utf8", cwd: root });
  let j;
  try { j = JSON.parse(r.stdout); } catch { assert.fail(`non-JSON stdout (status ${r.status}): ${r.stdout}\n${r.stderr}`); }
  assert.equal(r.status, j.exit, "process status equals JSON exit");
  return j;
}
const core = (root, ...a) => cli(CORE, root, ...a);
const draft = (root, ...a) => cli(DRAFT, root, ...a);
const codes = (j) => [...j.findings.map((f) => f.code), ...(j.refusals ?? []).map((r) => r.code)];

const CLAIMS = {
  "§app/list": { kind: "surface", authority: "accepted" },
  "§app.list/mark": { kind: "behavior", authority: "accepted", requires: [], code: ["src/list.ts"] },
  "§app.list/rows": { kind: "behavior", authority: "accepted", requires: [], code: ["src/list.ts"] },
  "§design/copy": { kind: "note", authority: "accepted" },
  "§chat/bridge": { kind: "behavior", authority: "accepted", requires: [], code: ["tools/bridge.ts"] },
};
const LIST = "# §app/list\n\nThe session list.\n\n## §app.list/mark\n\nA session that needs you shows a speech bubble followed by the count.\n\n## §app.list/rows\n\nRows sort by recency.\n";
const COPY = "# §design/copy\n\nOpen questions: speech bubble with the count.\n";
const BRIDGE = "# §chat/bridge\n\nThe bridge never resumes a session.\n";
const M = (claims) => JSON.stringify({ formatVersion: 1, boundary: { include: ["src"], exclude: [] }, claims }, null, 2) + "\n";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "sova-enforce-"));
  roots.push(root);
  write(root, ".sova/spec/manifest.json", M(CLAIMS));
  write(root, ".sova/spec/claims/app/list.md", LIST);
  write(root, ".sova/spec/claims/design/copy.md", COPY);
  write(root, ".sova/spec/claims/chat/bridge.md", BRIDGE);
  write(root, ".gitignore", ".sova/spec/drafts/\n");
  write(root, "src/list.ts", "v1\n");
  write(root, "tools/bridge.ts", "v1\n");
  ok(root, "init", "-q"); ok(root, "add", "-A"); ok(root, "commit", "-qm", "base");
  return root;
}
const editManifest = (root, rel, fn) => { const m = JSON.parse(read(root, rel)); fn(m.claims, m); write(root, rel, JSON.stringify(m, null, 2) + "\n"); };

// ---------------------------------------------------------------- core foreign
test("foreign: § whose prose or record changed between two revisions, minus § created there", () => {
  const root = repo();
  const base = ok(root, "rev-parse", "HEAD");
  write(root, ".sova/spec/claims/app/list.md", LIST.replace("a speech bubble followed by the count", "the count alone") + "\n## §app.list/filter\n\nA filter narrows the rows.\n");
  write(root, ".sova/spec/claims/chat/new.md", "# §chat/new\n\nNew.\n");
  editManifest(root, ".sova/spec/manifest.json", (c) => {
    c["§app.list/filter"] = { kind: "behavior", authority: "accepted", requires: [] };
    c["§chat/new"] = { kind: "surface", authority: "accepted" };
    c["§app.list/rows"].evidence = "verified";
  });
  ok(root, "add", "-A"); ok(root, "commit", "-qm", "spec");
  const j = core(root, "foreign", "--base", base, "--head", "HEAD");
  assert.equal(j.exit, 0, JSON.stringify(j.findings));
  assert.deepEqual(j.foreign, ["§app.list/mark", "§app.list/rows", "§app/list"]);
  assert.deepEqual(j.changes, [
    { id: "§app.list/mark", change: "text" },
    { id: "§app.list/rows", change: "record" },
    { id: "§app/list", change: "child-added", children: ["§app.list/filter"] },
  ]);
  assert.deepEqual(j.created, ["§app.list/filter", "§chat/new"]);
  assert.equal(j.base.commit, base);
  const h = spawnSync(process.execPath, [CORE, "foreign", "--base", base, "--head", "HEAD", "--root", root], { encoding: "utf8" });
  assert.match(h.stdout, /Foreign § changed: §app\.list\/mark, §app\.list\/rows, §app\/list\nexit 0\n$/);
});

test("foreign: without --head reads the working tree; deletions count; no spec at base means all created", () => {
  const root = repo();
  write(root, ".sova/spec/claims/design/copy.md", "");
  rmSync(join(root, ".sova/spec/claims/design/copy.md"));
  editManifest(root, ".sova/spec/manifest.json", (c) => { delete c["§design/copy"]; });
  const j = core(root, "foreign", "--base", "HEAD");
  assert.deepEqual(j.changes, [{ id: "§design/copy", change: "deleted" }]);
  assert.equal(j.head.worktree, true);
  const empty = mkdtempSync(join(tmpdir(), "sova-enforce-")); roots.push(empty);
  write(empty, "x.txt", "x\n"); ok(empty, "init", "-q"); ok(empty, "add", "-A"); ok(empty, "commit", "-qm", "x");
  const first = ok(empty, "rev-parse", "HEAD");
  write(empty, ".sova/spec/manifest.json", M({ "§a/b": { kind: "surface" } }));
  write(empty, ".sova/spec/claims/a/b.md", "# §a/b\n\nB.\n");
  ok(empty, "add", "-A"); ok(empty, "commit", "-qm", "spec");
  const k = core(empty, "foreign", "--base", first, "--head", "HEAD");
  assert.deepEqual([k.foreign, k.created], [[], ["§a/b"]]);
});

test("foreign --spec: a draft's graph is the head, compared with the base revision", () => {
  const root = repo();
  assert.equal(draft(root, "new", "d0", "--write").exit, 0);
  write(root, ".sova/spec/drafts/d0/spec/claims/design/copy.md", "# §design/copy\n\nOpen questions: the count.\n");
  const j = core(root, "foreign", "--base", "HEAD", "--spec", ".sova/spec/drafts/d0/spec");
  assert.deepEqual([j.exit, j.foreign, j.head.spec], [0, ["§design/copy"], ".sova/spec/drafts/d0/spec"]);
  assert.deepEqual(core(root, "foreign", "--base", "HEAD").foreign, [], "current is untouched");
  assert.ok(codes(core(root, "foreign", "--base", "HEAD", "--head", "HEAD", "--spec", ".sova/spec/drafts/d0/spec")).includes("usage"));
});

test("foreign: usage and bad revisions", () => {
  const root = repo();
  assert.ok(codes(core(root, "foreign")).includes("usage"));
  assert.ok(codes(core(root, "census", "--head", "HEAD")).includes("usage"));
  const b = core(root, "foreign", "--base", "no-such-rev");
  assert.deepEqual([b.exit, codes(b)], [2, ["bad-rev"]]);
});

// ---------------------------------------------------------------- census mappedOutside
test("census --changed: a changed file outside the boundary that a claim maps is mappedOutside and its § foreign", () => {
  const root = repo();
  write(root, "tools/bridge.ts", "v2\n");
  write(root, "tools/unmapped.ts", "x\n");
  const j = core(root, "census", "--changed", "--related");
  assert.deepEqual(j.census.mappedOutside, [{ path: "tools/bridge.ts", claims: ["§chat/bridge"] }]);
  assert.deepEqual(j.census.outside, ["tools/bridge.ts", "tools/unmapped.ts"]);
  assert.deepEqual(j.census.unclaimed, [], "the boundary is not widened");
  assert.deepEqual(j.census.claimed, []);
  assert.deepEqual(j.census.foreign, ["§chat/bridge"]);
  assert.deepEqual(j.census.touched.map((t) => t.id), ["§chat/bridge"]);
  assert.equal(j.exit, 0, JSON.stringify(j.findings));
});

// ---------------------------------------------------------------- draft check: drift
test("draft check: a phrase removed from one § that another § still says is a warning", () => {
  const root = repo();
  assert.equal(draft(root, "new", "d1", "--write").exit, 0);
  write(root, ".sova/spec/drafts/d1/spec/claims/app/list.md", LIST.replace("a speech bubble followed by the count", "the count alone"));
  const j = draft(root, "check", "d1");
  assert.equal(j.exit, 1);
  const r = j.drift.removedElsewhere.find((x) => x.phrase === "speech bubble");
  assert.deepEqual(r, { id: "§app.list/mark", phrase: "speech bubble", alsoIn: ["§design/copy"] });
  assert.ok(!j.drift.removedElsewhere.some((x) => x.phrase.includes("speech bubble") && x.phrase !== "speech bubble"), "no longer phrase around a reported one");
  const f = j.findings.find((x) => x.code === "removed-phrase-elsewhere");
  assert.equal(f.severity, "warn");
  assert.match(f.message, /removed "speech bubble" from §app\.list\/mark, but §design\/copy still say/);
  write(root, ".sova/spec/drafts/d1/spec/claims/design/copy.md", "# §design/copy\n\nOpen questions: the count.\n");
  const k = draft(root, "check", "d1");
  assert.deepEqual(k.drift.removedElsewhere, []);
  assert.equal(k.exit, 0, JSON.stringify(k.findings));
});

test("draft check: code changed since the draft's base commit under a § whose prose it left alone is a note", () => {
  const root = repo();
  const head = ok(root, "rev-parse", "HEAD");
  assert.equal(draft(root, "new", "d2", "--write").exit, 0);
  assert.equal(JSON.parse(read(root, ".sova/spec/drafts/d2/draft.json")).base.commit, head, "new records the base commit");
  write(root, "tools/bridge.ts", "v2: resumes\n");
  write(root, "src/list.ts", "v2\n");
  write(root, ".sova/spec/drafts/d2/spec/claims/app/list.md", LIST.replace("Rows sort by recency.", "Rows sort by recency, newest first."));
  const j = draft(root, "check", "d2");
  assert.equal(j.drift.base, head);
  assert.deepEqual(j.drift.proseUnchanged, [{ id: "§app.list/mark", files: ["src/list.ts"] }, { id: "§chat/bridge", files: ["tools/bridge.ts"] }]);
  assert.deepEqual(j.findings.filter((f) => f.code === "code-changed-prose-unchanged").map((f) => [f.severity, f.id]), [["note", "§app.list/mark"], ["note", "§chat/bridge"]]);
  assert.equal(j.exit, 0, "a note never changes the exit");
  ok(root, "add", "src", "tools"); ok(root, "commit", "-qm", "code");
  assert.deepEqual(draft(root, "check", "d2", "--base", "HEAD").drift.proseUnchanged, [], "--base overrides the recorded commit");
  assert.ok(codes(draft(root, "check", "d2", "--base", "nope")).includes("bad-rev"));
});

test("draft check: an evidence commit that is not an ancestor of HEAD is a warning", () => {
  const root = repo();
  assert.equal(draft(root, "new", "d3", "--write").exit, 0);
  write(root, ".sova/spec/drafts/d3/spec/claims/chat/bridge.md", "# §chat/bridge\n\nThe bridge resumes a forked session.\n");
  ok(root, "checkout", "-qb", "side");
  write(root, "tools/bridge.ts", "v2\n");
  ok(root, "commit", "-qam", "bridge");
  const c = ok(root, "rev-parse", "HEAD");
  const e = draft(root, "evidence", "d3", "--id", "§chat/bridge", "--by", "t", "--verification", "ran it", "--commit", c, "--write");
  assert.equal(e.exit, 0, JSON.stringify(e.findings));
  assert.deepEqual(draft(root, "check", "d3").evidenceNotAncestor, []);
  ok(root, "checkout", "-q", "master");
  const j = draft(root, "check", "d3");
  assert.deepEqual(j.evidenceNotAncestor, [{ commit: c, reason: "not-ancestor", ids: ["§chat/bridge"] }]);
  assert.equal(j.findings.find((f) => f.code === "evidence-not-ancestor").severity, "warn");
  assert.equal(j.exit, 1);
});

test("draft check and promote: a quantity the draft changed that another § states about the same thing (M2's ≥80%)", () => {
  const root = mkdtempSync(join(tmpdir(), "sova-enforce-"));
  roots.push(root);
  const claims = {
    "§app/usage": { kind: "behavior", authority: "accepted", requires: [], code: ["src/usage.ts"] },
    "§design/deviations": { kind: "note", authority: "accepted" },
    "§chat/context": { kind: "behavior", authority: "accepted", requires: [] },
  };
  write(root, ".sova/spec/manifest.json", M(claims));
  write(root, ".sova/spec/claims/app/usage.md", "# §app/usage\n\nFill color. The fill is neutral; it gets `.meter-fill-warn` at ≥80% and a Near limit chip. A window at 80% or more is high.\n");
  write(root, ".sova/spec/claims/design/deviations.md", "# §design/deviations\n\n`.meter-fill` is muted. At ≥80% the fill turns `--status-warn`.\n");
  write(root, ".sova/spec/claims/chat/context.md", "# §chat/context\n\nThe ring stays filled; `.context-warn` at ≥80% and `.context-error` at ≥95%, the same thresholds the session list uses for its own ring.\n\nA context window at 80% warns.\n");
  write(root, ".gitignore", ".sova/spec/drafts/\n");
  write(root, "src/usage.ts", "v1\n");
  ok(root, "init", "-q"); ok(root, "add", "-A"); ok(root, "commit", "-qm", "base");
  assert.equal(draft(root, "new", "q", "--write").exit, 0);
  write(root, ".sova/spec/drafts/q/spec/claims/app/usage.md", read(root, ".sova/spec/claims/app/usage.md").replace("≥80%", "≥90%").replace("at 80%", "at 90%"));
  const j = draft(root, "check", "q");
  assert.deepEqual(j.drift.removedElsewhere, [{ id: "§app/usage", phrase: "≥80%", alsoIn: ["§design/deviations"], near: ["fill"] }], "the context meter's ≥80% and 80% are not the same fact");
  assert.equal(j.exit, 1);
  write(root, "src/usage.ts", "v2\n");
  ok(root, "commit", "-qam", "code");
  assert.equal(draft(root, "evidence", "q", "--id", "§app/usage", "--by", "t", "--verification", "ran it", "--commit", "HEAD", "--write").exit, 0);
  const p = draft(root, "promote", "q", "--id", "§app/usage");
  assert.equal(p.exit, 0, "drift never refuses a promotion");
  assert.equal(p.driftWarnings.length, 1);
  assert.match(p.driftWarnings[0], /removed "≥80%" from §app\/usage, but §design\/deviations still says it \(near fill\)/);
});

test("rebase after evidence: promote refuses with evidence-not-ancestor; census --changed reports the orphaned evidence", () => {
  const root = repo();
  ok(root, "checkout", "-qb", "feat");
  assert.equal(draft(root, "new", "rb", "--write").exit, 0);
  write(root, ".sova/spec/drafts/rb/spec/claims/chat/bridge.md", "# §chat/bridge\n\nThe bridge resumes a forked session.\n");
  write(root, "tools/bridge.ts", "v2\n");
  ok(root, "commit", "-qam", "bridge");
  const c = ok(root, "rev-parse", "HEAD");
  assert.equal(draft(root, "evidence", "rb", "--id", "§chat/bridge", "--by", "t", "--verification", "ran it", "--commit", c, "--write").exit, 0);
  assert.equal(draft(root, "promote", "rb", "--id", "§chat/bridge").exit, 0, "valid before the rebase");
  assert.deepEqual(core(root, "census", "--changed").census.orphanedEvidence, []);
  ok(root, "checkout", "-q", "master");
  write(root, "src/list.ts", "v2\n");
  ok(root, "commit", "-qam", "master moves");
  ok(root, "checkout", "-q", "feat");
  ok(root, "rebase", "-q", "master");
  const p = draft(root, "promote", "rb", "--id", "§chat/bridge");
  assert.equal(p.exit, 1);
  const r = p.refusals.find((x) => x.code === "evidence-not-ancestor");
  assert.match(r.message, new RegExp(`evidence commit ${c.slice(0, 12)} was rewritten \\(rebase\\?\\).*never rebase after evidence; re-record evidence on the current commit, or merge master in instead`));
  const k = core(root, "census", "--changed");
  assert.deepEqual(k.census.orphanedEvidence, [{ draft: "rb", commit: c, ids: ["§chat/bridge"] }]);
  assert.ok(k.findings.some((f) => f.code === "evidence-orphaned" && f.severity === "note"));
});

// ---------------------------------------------------------------- promote alsoChanges
test("promote: alsoChanges names the foreign § the promotion changes, never the draft's new ones", () => {
  const root = repo();
  assert.equal(draft(root, "new", "d4", "--write").exit, 0);
  write(root, ".sova/spec/drafts/d4/spec/claims/app/list.md", LIST.replace("a speech bubble followed by the count", "the count alone") + "\n## §app.list/filter\n\nA filter narrows the rows.\n");
  editManifest(root, ".sova/spec/drafts/d4/spec/manifest.json", (c) => { c["§app.list/filter"] = { kind: "behavior", authority: "accepted", requires: [], code: ["src/list.ts"] }; });
  write(root, "src/list.ts", "v2\n");
  ok(root, "commit", "-qam", "code");
  const ids = ["§app.list/mark", "§app.list/filter"];
  const e = draft(root, "evidence", "d4", ...ids.flatMap((i) => ["--id", i]), "--by", "t", "--verification", "ran it", "--commit", "HEAD", "--write");
  assert.equal(e.exit, 0, JSON.stringify(e.findings));
  const p = draft(root, "promote", "d4", ...ids.flatMap((i) => ["--id", i]));
  assert.equal(p.exit, 0, JSON.stringify([p.findings, p.refusals]));
  assert.deepEqual(p.alsoChanges, ["§app.list/mark", "§app/list"]);
  assert.deepEqual(p.alsoChangesDetail, [{ id: "§app.list/mark", change: "text" }, { id: "§app/list", change: "child-added", children: ["§app.list/filter"] }]);
  const w = draft(root, "promote", "d4", ...ids.flatMap((i) => ["--id", i]), "--plan", p.plan, "--write");
  assert.equal(w.exit, 0);
  assert.deepEqual(w.alsoChanges, ["§app.list/mark", "§app/list"]);
});

// ---------------------------------------------------------------- B3: the branch merged master in, then lands
test("B3: after the branch merges master in, promote alsoChanges and the merge's foreign are only the branch's §", () => {
  const root = repo();
  ok(root, "checkout", "-qb", "feat");
  write(root, ".sova/spec/claims/app/list.md", LIST.replace("Rows sort by recency.", "Rows sort by recency, newest first."));
  ok(root, "commit", "-qam", "feat: rows");
  assert.equal(draft(root, "new", "late", "--write").exit, 0);
  const now = read(root, ".sova/spec/claims/app/list.md");
  write(root, ".sova/spec/drafts/late/spec/claims/app/list.md", now.replace("a speech bubble followed by the count", "the count alone"));
  // Meanwhile master (another task) changes other §.
  ok(root, "checkout", "-q", "master");
  write(root, ".sova/spec/claims/design/copy.md", "# §design/copy\n\nOpen questions: the count.\n");
  editManifest(root, ".sova/spec/manifest.json", (c) => { c["§chat/bridge"].evidence = "verified"; });
  ok(root, "commit", "-qam", "master: copy and bridge");
  const before = ok(root, "rev-parse", "master");
  ok(root, "checkout", "-q", "feat");
  ok(root, "merge", "-q", "--no-edit", "master");
  write(root, "src/list.ts", "v2\n");
  ok(root, "commit", "-qam", "feat: count alone");
  const ev = draft(root, "evidence", "late", "--id", "§app.list/mark", "--by", "t", "--verification", "ran it", "--commit", "HEAD", "--write");
  assert.equal(ev.exit, 0, JSON.stringify(ev.findings));
  const p = draft(root, "promote", "late", "--id", "§app.list/mark");
  assert.equal(p.exit, 0, JSON.stringify([p.findings, p.refusals]));
  assert.deepEqual(p.alsoChanges, ["§app.list/mark"], "master's §design/copy and §chat/bridge are not this promotion's");
  assert.equal(draft(root, "promote", "late", "--id", "§app.list/mark", "--plan", p.plan, "--write").exit, 0);
  ok(root, "commit", "-qam", "spec: count alone");
  ok(root, "checkout", "-q", "master");
  ok(root, "merge", "-q", "--no-edit", "feat");
  // The target before the merge vs after it: only what the branch changed.
  const j = core(root, "foreign", "--base", before, "--head", "master");
  assert.deepEqual(j.foreign, ["§app.list/mark", "§app.list/rows"]);
  // The branch's own start is the wrong base: it would add master's § the branch absorbed.
  const wrong = core(root, "foreign", "--base", ok(root, "merge-base", "feat", `${before}~1`), "--head", "master");
  assert.ok(wrong.foreign.includes("§design/copy"), "why callers must pass the target's tip before the merge");
});

// ---------------------------------------------------------------- merge-manifest
function conflicted() {
  const root = repo();
  ok(root, "checkout", "-qb", "feat");
  editManifest(root, ".sova/spec/manifest.json", (c) => { c["§chat/bridge"].evidence = "verified"; c["§chat/one"] = { kind: "surface" }; });
  ok(root, "commit", "-qam", "feat");
  ok(root, "checkout", "-q", "master");
  editManifest(root, ".sova/spec/manifest.json", (c) => { c["§app.list/rows"].evidence = "reviewed"; c["§chat/two"] = { kind: "surface" }; });
  ok(root, "commit", "-qam", "master");
  assert.notEqual(git(root, "merge", "-q", "feat").status, 0, "the manifest conflicts in Git");
  return root;
}

test("merge-manifest: merges index stages record by record; previews without --write; never stages", () => {
  const root = conflicted();
  const before = read(root, ".sova/spec/manifest.json");
  assert.match(before, /^<<<<<<< /m);
  const p = draft(root, "merge-manifest");
  assert.deepEqual([p.exit, p.written, p.conflicts], [0, false, []]);
  assert.deepEqual(p.fromTheirs, [{ key: "§chat/bridge", kind: "claim", action: "replace" }, { key: "§chat/one", kind: "claim", action: "add" }]);
  assert.equal(read(root, ".sova/spec/manifest.json"), before, "a preview writes nothing");
  const w = draft(root, "merge-manifest", "--write");
  assert.equal(w.written, true);
  const m = JSON.parse(read(root, ".sova/spec/manifest.json"));
  assert.equal(m.claims["§chat/bridge"].evidence, "verified");
  assert.equal(m.claims["§app.list/rows"].evidence, "reviewed");
  assert.ok(m.claims["§chat/one"] && m.claims["§chat/two"]);
  assert.deepEqual(Object.keys(m), ["formatVersion", "boundary", "claims"]);
  assert.match(git(root, "ls-files", "-u").out, /manifest\.json/, "still unmerged: the tool never stages");
  assert.ok(codes(draft(root, "merge-manifest", "--base", "x")).includes("usage"));
});

test("merge-manifest: the same record changed differently on both sides is refused and nothing is written", () => {
  const root = repo();
  ok(root, "checkout", "-qb", "feat");
  editManifest(root, ".sova/spec/manifest.json", (c) => { c["§chat/bridge"].evidence = "verified"; });
  ok(root, "commit", "-qam", "feat");
  ok(root, "checkout", "-q", "master");
  editManifest(root, ".sova/spec/manifest.json", (c) => { c["§chat/bridge"].evidence = "reviewed"; });
  ok(root, "commit", "-qam", "master");
  assert.notEqual(git(root, "merge", "-q", "feat").status, 0);
  const before = read(root, ".sova/spec/manifest.json");
  const j = draft(root, "merge-manifest", "--write");
  assert.deepEqual([j.exit, j.written, j.conflicts, codes(j)], [1, false, [{ key: "§chat/bridge", kind: "claim" }], ["manifest-conflict"]]);
  assert.equal(read(root, ".sova/spec/manifest.json"), before);
});

test("merge-manifest: outside a conflict it refuses; the merge-driver form writes %A", () => {
  const root = repo();
  assert.ok(codes(draft(root, "merge-manifest")).includes("not-conflicted"));
  const b = join(root, "b.json"), o = join(root, "o.json"), t = join(root, "t.json");
  const base = { formatVersion: 1, claims: { "§a/x": { kind: "surface" }, "§a/y": { kind: "surface" } } };
  writeFileSync(b, JSON.stringify(base));
  writeFileSync(o, JSON.stringify({ ...base, claims: { ...base.claims, "§a/z": { kind: "surface" } } }));
  writeFileSync(t, JSON.stringify({ formatVersion: 1, claims: { "§a/x": { kind: "surface", evidence: "verified" } } }));
  const j = draft(root, "merge-manifest", "--base", b, "--ours", o, "--theirs", t, "--write");
  assert.equal(j.exit, 0, JSON.stringify(j.findings));
  assert.deepEqual(JSON.parse(readFileSync(o, "utf8")).claims, { "§a/x": { kind: "surface", evidence: "verified" }, "§a/z": { kind: "surface" } });
  assert.ok(existsSync(t));
  writeFileSync(b, "");
  writeFileSync(o, JSON.stringify({ formatVersion: 1, claims: { "§a/x": { kind: "surface", evidence: "reviewed" } } }));
  const k = draft(root, "merge-manifest", "--base", b, "--ours", o, "--theirs", t);
  assert.deepEqual(k.conflicts, [{ key: "§a/x", kind: "claim" }], "an empty %O (add/add) is an empty base");
});

test("merge-manifest as a git merge driver resolves a manifest conflict during git merge", () => {
  const root = repo();
  write(root, ".gitattributes", ".sova/spec/manifest.json merge=sova-spec-manifest\n");
  ok(root, "add", ".gitattributes"); ok(root, "commit", "-qm", "attrs");
  ok(root, "config", "merge.sova-spec-manifest.driver", `"${process.execPath}" "${DRAFT}" merge-manifest --root . --base %O --ours %A --theirs %B --write`);
  ok(root, "checkout", "-qb", "feat");
  editManifest(root, ".sova/spec/manifest.json", (c) => { c["§chat/bridge"].evidence = "verified"; c["§chat/one"] = { kind: "surface" }; });
  ok(root, "commit", "-qam", "feat");
  ok(root, "checkout", "-q", "master");
  editManifest(root, ".sova/spec/manifest.json", (c) => { c["§app.list/rows"].evidence = "reviewed"; });
  ok(root, "commit", "-qam", "master");
  const r = git(root, "merge", "-q", "--no-edit", "feat");
  assert.equal(r.status, 0, r.err);
  const m = JSON.parse(read(root, ".sova/spec/manifest.json"));
  assert.deepEqual([m.claims["§chat/bridge"].evidence, m.claims["§app.list/rows"].evidence, !!m.claims["§chat/one"]], ["verified", "reviewed", true]);
});

// ---------------------------------------------------------------- Phase 3: the task's own claims (M2)
// M3-B-s2-2's shape: the branch promotes a NEW claim, merges master in (master changed another § and created its own
// claim), relabels its new claim's evidence in a second draft, promotes, and master fast-forwards to it.
test("own claims: a claim the task created in an earlier promotion is never foreign; master's new claims stay foreign", () => {
  const root = repo();
  const start = ok(root, "rev-parse", "master");
  ok(root, "checkout", "-qb", "feat");
  assert.equal(draft(root, "new", "d1", "--write").exit, 0);
  write(root, ".sova/spec/drafts/d1/spec/claims/app/list.md", LIST + "\n## §app.list/filter\n\nA filter narrows the rows.\n");
  editManifest(root, ".sova/spec/drafts/d1/spec/manifest.json", (c) => { c["§app.list/filter"] = { kind: "behavior", authority: "accepted", requires: [], code: ["src/filter.ts"] }; });
  write(root, "src/filter.ts", "v1\n");
  ok(root, "add", "src/filter.ts"); ok(root, "commit", "-qm", "feat: filter");
  assert.equal(draft(root, "evidence", "d1", "--id", "§app.list/filter", "--by", "t", "--verification", "ran", "--commit", "HEAD", "--write").exit, 0);
  const p1 = draft(root, "promote", "d1", "--id", "§app.list/filter");
  assert.deepEqual(p1.alsoChanges, ["§app/list"], "the new claim's parent gains a child");
  assert.equal(draft(root, "promote", "d1", "--id", "§app.list/filter", "--plan", p1.plan, "--write").exit, 0);
  ok(root, "add", ".sova/spec"); ok(root, "commit", "-qm", "spec: filter");
  // Master moves: another task edits §design/copy and creates §chat/poll.
  ok(root, "checkout", "-q", "master");
  write(root, ".sova/spec/claims/design/copy.md", "# §design/copy\n\nOpen questions: the count.\n");
  write(root, ".sova/spec/claims/chat/poll.md", "# §chat/poll\n\nPolls every minute.\n");
  editManifest(root, ".sova/spec/manifest.json", (c) => { c["§chat/poll"] = { kind: "surface", authority: "accepted" }; });
  ok(root, "add", "-A"); ok(root, "commit", "-qm", "master: copy, poll");
  const runStart = ok(root, "rev-parse", "master");
  ok(root, "checkout", "-q", "feat");
  if (git(root, "merge", "-q", "--no-edit", "master").status !== 0) { // adjacent manifest records: the sanctioned resolution
    assert.equal(draft(root, "merge-manifest", "--write").exit, 0);
    ok(root, "add", ".sova/spec/manifest.json"); ok(root, "commit", "-qm", "merge master");
  }
  const merged = ok(root, "rev-parse", "HEAD");
  // Second draft: relabel the new claim's evidence and change §app.list/mark.
  assert.equal(draft(root, "new", "d2", "--write").exit, 0);
  write(root, ".sova/spec/drafts/d2/spec/claims/app/list.md", read(root, ".sova/spec/claims/app/list.md").replace("a speech bubble followed by the count", "the count alone"));
  editManifest(root, ".sova/spec/drafts/d2/spec/manifest.json", (c) => { c["§app.list/filter"].evidence = "verified"; });
  write(root, "src/list.ts", "v2\n"); write(root, "src/filter.ts", "v2\n");
  ok(root, "commit", "-qam", "feat: count alone");
  const ids = ["§app.list/filter", "§app.list/mark"];
  assert.equal(draft(root, "evidence", "d2", ...ids.flatMap((i) => ["--id", i]), "--by", "t", "--verification", "ran", "--commit", "HEAD", "--write").exit, 0);
  const p2 = draft(root, "promote", "d2", ...ids.flatMap((i) => ["--id", i]));
  assert.equal(p2.exit, 0, JSON.stringify(p2.refusals));
  assert.deepEqual(p2.alsoChanges, ["§app.list/mark"], "§app.list/filter is the task's own (absent on master and at the fork point)");
  assert.equal(draft(root, "promote", "d2", ...ids.flatMap((i) => ["--id", i]), "--plan", p2.plan, "--write").exit, 0);
  ok(root, "add", ".sova/spec"); ok(root, "commit", "-qm", "spec: count alone");
  // The promote's range as a turn check sees it: filter's record changed, but it is own.
  const r = core(root, "foreign", "--base", merged, "--head", "HEAD", "--own-base", start, "--own-base", runStart);
  assert.deepEqual(r.foreign, ["§app.list/mark"]);
  assert.deepEqual(r.own, ["§app.list/filter"]);
  assert.deepEqual(core(root, "foreign", "--base", merged, "--head", "HEAD").foreign, ["§app.list/filter", "§app.list/mark"], "without --own-base: the old per-range definition");
  // Master's new claim is never own: it exists on master's tip.
  const wide = core(root, "foreign", "--base", start, "--head", "HEAD", "--own-base", start, "--own-base", runStart);
  assert.ok(!wide.own.includes("§chat/poll") && wide.foreign.includes("§design/copy"));
  // The fast-forward: the target before vs after; the new claim is created there, its parent gains a child.
  ok(root, "checkout", "-q", "master");
  ok(root, "merge", "-q", "--ff-only", "feat");
  const land = core(root, "foreign", "--base", runStart, "--head", "master", "--own-base", start, "--own-base", runStart);
  assert.deepEqual(land.foreign, ["§app.list/mark", "§app/list"]);
  assert.deepEqual(land.created, ["§app.list/filter"]);
  // census --changed agrees: the own claim is touched but not foreign.
  write(root, "src/filter.ts", "v3\n");
  const c = core(root, "census", "--changed", "--own-base", start, "--own-base", runStart);
  assert.deepEqual([c.census.foreign, c.census.own], [[], ["§app.list/filter"]]);
  assert.deepEqual(core(root, "census", "--changed").census.foreign, ["§app.list/filter"]);
});

// ---------------------------------------------------------------- Phase 3: the landing gate (M1)
test("landing: a deleted mapped file lands in its claim (census and mappedUntouched); a deleted unmapped file is unmappedChanged", () => {
  const root = repo();
  write(root, "src/extra.ts", "x\n");
  ok(root, "add", "-A"); ok(root, "commit", "-qm", "extra");
  const base = ok(root, "rev-parse", "HEAD");
  rmSync(join(root, "tools/bridge.ts"));
  rmSync(join(root, "src/extra.ts"));
  const c = core(root, "census", "--changed");
  assert.deepEqual(c.census.deleted, ["src/extra.ts", "tools/bridge.ts"]);
  assert.deepEqual(c.census.mappedOutside, [{ path: "tools/bridge.ts", claims: ["§chat/bridge"], deleted: true }]);
  assert.deepEqual(c.census.foreign, ["§chat/bridge"]);
  assert.deepEqual(c.census.unclaimed, [], "a deleted file has nothing to claim");
  ok(root, "commit", "-qam", "delete");
  const l = core(root, "foreign", "--base", base, "--head", "HEAD", "--landing");
  assert.deepEqual(l.foreign, []);
  assert.deepEqual(l.unmappedChanged, [{ path: "src/extra.ts", status: "D", inBoundary: true }]);
  assert.deepEqual(l.mappedUntouched, [{ id: "§chat/bridge", files: ["tools/bridge.ts"] }]);
  assert.deepEqual([l.unpromotedDrafts, l.handResolved], [[], []]);
  const h = spawnSync(process.execPath, [CORE, "foreign", "--base", base, "--head", "HEAD", "--landing", "--root", root], { encoding: "utf8" });
  assert.match(h.stdout, /unmapped D src\/extra\.ts \(in boundary\)/);
  assert.match(h.stdout, /mapped code changed, prose not: §chat\/bridge \(tools\/bridge\.ts\)/);
});

// The public-links shape: a worktree changes code under a foreign § and an unmapped outside file, its draft is never
// promoted, and the branch merges into master.
test("landing: a merged worktree's unpromoted draft, code under an unchanged foreign §, and an unmapped outside file", () => {
  const root = repo();
  const wt = join(mkdtempSync(join(tmpdir(), "sova-enforce-wt-")), "wt");
  roots.push(dirname(wt));
  ok(root, "worktree", "add", "-q", "-b", "links", wt);
  assert.equal(draft(wt, "new", "links", "--write").exit, 0);
  write(wt, ".sova/spec/drafts/links/spec/claims/app/list.md", LIST.replace("Rows sort by recency.", "Rows sort by recency; each links out."));
  write(wt, "src/list.ts", "v2 links\n");
  write(wt, "scripts/links.sh", "echo\n");
  ok(wt, "add", "-A"); ok(wt, "commit", "-qm", "links");
  const before = ok(root, "rev-parse", "master");
  ok(root, "merge", "-q", "--no-edit", "--no-ff", "links");
  const l = core(root, "foreign", "--base", before, "--head", "master", "--landing");
  assert.deepEqual(l.foreign, []);
  assert.deepEqual(l.unmappedChanged, [{ path: "scripts/links.sh", status: "A", inBoundary: false }]);
  assert.deepEqual(l.mappedUntouched, [{ id: "§app.list/mark", files: ["src/list.ts"] }, { id: "§app.list/rows", files: ["src/list.ts"] }]);
  assert.equal(l.unpromotedDrafts.length, 1);
  assert.deepEqual([l.unpromotedDrafts[0].draft, l.unpromotedDrafts[0].ids], ["links", ["§app.list/rows"]]);
  assert.deepEqual(l.handResolved, [], "a clean merge resolves nothing by hand");
  // The same range once the draft is promoted (evidence, promote, commit on the branch, merge again): nothing left.
  assert.equal(draft(wt, "evidence", "links", "--id", "§app.list/rows", "--by", "t", "--verification", "ran", "--commit", "HEAD", "--write").exit, 0);
  const p = draft(wt, "promote", "links", "--id", "§app.list/rows");
  assert.deepEqual(p.unpromotedDrafts, [], "the preview's own selection is not left behind");
  assert.deepEqual(p.unmappedChanged.map((f) => f.path), ["scripts/links.sh"]);
  const w = draft(wt, "promote", "links", "--id", "§app.list/rows", "--plan", p.plan, "--write");
  assert.deepEqual([w.exit, w.unpromotedDrafts, w.mappedUntouched.map((m) => m.id)], [0, [], ["§app.list/mark"]]);
  ok(wt, "add", ".sova/spec"); ok(wt, "commit", "-qm", "spec: links");
  const before2 = ok(root, "rev-parse", "master");
  ok(root, "merge", "-q", "--no-edit", "links");
  const l2 = core(root, "foreign", "--base", before2, "--head", "master", "--landing");
  assert.deepEqual([l2.foreign, l2.unpromotedDrafts], [["§app.list/rows"], []]);
});

test("landing: a merge commit whose § differs from both parents is hand-resolved; a renamed § says where it went", () => {
  const root = repo();
  ok(root, "checkout", "-qb", "feat");
  write(root, ".sova/spec/claims/design/copy.md", "# §design/copy\n\nOpen questions: the branch's text.\n");
  ok(root, "commit", "-qam", "feat copy");
  ok(root, "checkout", "-q", "master");
  write(root, ".sova/spec/claims/design/copy.md", "# §design/copy\n\nOpen questions: master's text.\n");
  ok(root, "commit", "-qam", "master copy");
  const before = ok(root, "rev-parse", "master");
  assert.notEqual(git(root, "merge", "-q", "feat").status, 0);
  write(root, ".sova/spec/claims/design/copy.md", "# §design/copy\n\nOpen questions: a third text.\n");
  ok(root, "commit", "-qam", "merge by hand");
  const l = core(root, "foreign", "--base", before, "--head", "master", "--landing");
  assert.deepEqual(l.handResolved, [{ commit: ok(root, "rev-parse", "master"), ids: ["§design/copy"] }]);
  // A rename: §chat/bridge's body moves to §chat/relay.
  const b2 = ok(root, "rev-parse", "HEAD");
  rmSync(join(root, ".sova/spec/claims/chat/bridge.md"));
  write(root, ".sova/spec/claims/chat/relay.md", BRIDGE.replace("§chat/bridge", "§chat/relay"));
  editManifest(root, ".sova/spec/manifest.json", (c) => { c["§chat/relay"] = c["§chat/bridge"]; delete c["§chat/bridge"]; });
  ok(root, "add", "-A"); ok(root, "commit", "-qm", "rename");
  const r = core(root, "foreign", "--base", b2, "--head", "HEAD");
  assert.deepEqual(r.changes, [{ id: "§chat/bridge", change: "deleted", renamedTo: "§chat/relay" }]);
  assert.deepEqual(r.foreign, ["§chat/bridge"], "a rename never hides the deleted foreign §");
});
