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
