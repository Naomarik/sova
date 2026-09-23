// Black-box fixture tests for core/sova-spec-draft.mjs. Node stdlib only; Git fixtures use the git CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readdirSync, statSync, readFileSync, existsSync, chmodSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../core/sova-spec-draft.mjs");
const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "../core/sova-spec.mjs");
const sha = (s) => createHash("sha256").update(s).digest("hex");

const roots = [];
process.on("exit", () => { for (const r of roots) { try { chmodSync(join(r, ".sova/spec"), 0o755); } catch {} rmSync(r, { recursive: true, force: true }); } });

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
  "§a.top/two": { kind: "behavior", authority: "accepted", requires: [], code: ["lib/two.txt"] },
  "§b/other": { kind: "behavior", authority: "accepted", requires: [], code: ["lib/other.txt"] },
};
const TOP = "# §a/top\n\nThe top surface.\n\n## §a.top/one\n\nOne does X.\n\n### Detail\n\nPlain H3 prose.\n\n## §a.top/two\n\nTwo does Y.\n";
function project({ spec = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sova-draft-test-"));
  roots.push(root);
  if (spec) {
    write(root, ".sova/spec/manifest.json", manifest(CLAIMS));
    write(root, ".sova/spec/claims/a/top.md", TOP);
    write(root, ".sova/spec/claims/b/other.md", "# §b/other\n\nOther does Z.\n");
  }
  for (const f of ["one", "two", "other"]) write(root, `lib/${f}.txt`, `${f} v1\n`);
  return root;
}
function run(root, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--root", root, "--json"], { encoding: "utf8", cwd: root });
  let j;
  try { j = JSON.parse(r.stdout); } catch { assert.fail(`non-JSON stdout (status ${r.status}): ${r.stdout}\n${r.stderr}`); }
  assert.equal(r.status, j.exit, "process status equals JSON exit");
  return j;
}
const codes = (j) => [...j.findings.map((f) => f.code), ...(j.refusals ?? []).map((r) => r.code)];
const D = (name, rel = "") => `.sova/spec/drafts/${name}/spec${rel ? `/${rel}` : ""}`;
const newDraft = (root, name = "f1") => { const j = run(root, "new", name, "--write"); assert.equal(j.exit, 0, JSON.stringify(j.findings)); return j; };
const snap = (root, name, ...ids) => run(root, "evidence", name, ...ids.flatMap((i) => ["--id", i]), "--by", "tester", "--verification", "ran the suite: pass", "--snapshot", "--write");
const editManifest = (root, rel, fn) => { const m = JSON.parse(read(root, rel)); fn(m); write(root, rel, JSON.stringify(m, null, 2) + "\n"); };
function tree(root, sub = ".sova/spec") {
  const out = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n), st = statSync(p); if (st.isDirectory()) walk(p); else out[p] = sha(readFileSync(p)); } };
  if (existsSync(join(root, sub))) walk(join(root, sub));
  return out;
}
const current = (root) => Object.fromEntries(Object.entries(tree(root)).filter(([p]) => !p.includes("/drafts/")));
const core = (root, ...a) => JSON.parse(spawnSync(process.execPath, [CORE, ...a, "--root", root, "--json"], { encoding: "utf8" }).stdout);
function git(root, ...a) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-C", root, ...a], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
const hasGit = spawnSync("git", ["--version"]).status === 0;

// ---------------------------------------------------------------- new: literal, complete copy
test("new previews without writing, then copies manifest and the whole claims tree byte-exact", () => {
  const root = project();
  const before = tree(root);
  const p = run(root, "new", "f1");
  assert.equal(p.exit, 0);
  assert.equal(p.written, false);
  assert.deepEqual(tree(root), before, "preview writes nothing");
  assert.deepEqual(p.files.map((f) => f.path), ["manifest.json", "claims/a/top.md", "claims/b/other.md"]);
  newDraft(root);
  for (const side of ["base", "spec"]) for (const f of ["manifest.json", "claims/a/top.md", "claims/b/other.md"])
    assert.equal(read(root, `.sova/spec/drafts/f1/${side}/${f}`), read(root, `.sova/spec/${f}`), `${side}/${f}`);
  const d = JSON.parse(read(root, ".sova/spec/drafts/f1/draft.json"));
  assert.equal(d.format, "sova-spec-draft/1");
  assert.deepEqual(Object.keys(d.base.files).sort(), ["claims/a/top.md", "claims/b/other.md", "manifest.json"]);
  assert.equal(d.base.files["manifest.json"], sha(read(root, ".sova/spec/manifest.json")));
  assert.deepEqual(current(root), before, "current untouched");
  assert.ok(codes(run(root, "new", "f1", "--write")).includes("name-taken"));
  assert.equal(run(root, "status", "f1").ids.length, 0, "a fresh draft proposes nothing");
});

test("draft edits and the draft graph stay isolated from current", () => {
  const root = project();
  newDraft(root);
  const before = current(root);
  write(root, D("f1", "claims/c/new.md"), "# §c/new\n\nNew feature.\n");
  editManifest(root, D("f1", "manifest.json"), (m) => { m.claims["§c/new"] = { kind: "behavior", authority: "accepted", requires: ["§b/other"], code: ["lib/new.txt"] }; });
  const chk = run(root, "check", "f1");
  assert.ok(chk.exit <= 1, JSON.stringify(chk.coreFindings));
  assert.equal(chk.counts.records, 5);
  assert.equal(core(root, "check").counts.records, 4, "current graph still has 4");
  const s = run(root, "status", "f1");
  assert.deepEqual(s.ids.map((i) => [i.id, i.change, i.current, i.evidence.state]), [["§c/new", "added", "pending", "none"]]);
  const df = run(root, "diff", "f1");
  assert.ok(df.files[0].diff.includes("+ New feature."));
  assert.deepEqual(current(root), before, "status/diff/check never write current");
});

// ---------------------------------------------------------------- no Git: bootstrap and snapshot evidence
test("no-Git, no-spec bootstrap: starter draft, snapshot evidence, promotion creates the docs", () => {
  const root = project({ spec: false });
  const n = newDraft(root, "boot");
  assert.equal(n.specExisted, false);
  assert.ok(!existsSync(join(root, ".sova/spec/manifest.json")));
  write(root, D("boot", "claims/a/top.md"), "# §a/top\n\nExisting baseline behavior.\n");
  editManifest(root, D("boot", "manifest.json"), (m) => { m.claims["§a/top"] = { kind: "behavior", authority: "accepted", requires: [], code: ["lib/one.txt"] }; });
  assert.ok(codes(run(root, "promote", "boot", "--id", "§a/top")).includes("evidence-missing"));
  assert.ok(codes(run(root, "evidence", "boot", "--id", "§a/top", "--by", "t", "--verification", "v", "--commit", "HEAD")).includes("not-git"));
  const ev = snap(root, "boot", "§a/top");
  assert.equal(ev.exit, 0, JSON.stringify(ev.findings));
  assert.ok(existsSync(join(root, `.sova/spec/drafts/boot/evidence/objects/${sha("one v1\n")}`)), "exact bytes retained");
  const pv = run(root, "promote", "boot", "--id", "§a/top");
  assert.equal(pv.exit, 0, JSON.stringify(pv.refusals));
  assert.deepEqual(pv.meta, ["formatVersion"], "bootstrap takes the manifest's top-level keys");
  assert.ok(!existsSync(join(root, ".sova/spec/manifest.json")), "preview writes nothing");
  const w = run(root, "promote", "boot", "--id", "§a/top", "--plan", pv.plan, "--write");
  assert.equal(w.exit, 0, JSON.stringify(w.findings));
  assert.equal(read(root, ".sova/spec/claims/a/top.md"), "# §a/top\n\nExisting baseline behavior.\n");
  assert.equal(core(root, "check").exit, 0);
  assert.equal(JSON.parse(read(root, ".sova/spec/drafts/boot/draft.json")).promotions.length, 1);
  assert.equal(run(root, "status", "boot").ids[0].current, "already-current");
});

test("snapshot evidence binds to the proposed prose and the implementation bytes", () => {
  const root = project();
  newDraft(root);
  write(root, D("f1", "claims/b/other.md"), "# §b/other\n\nOther does Z better.\n");
  write(root, "lib/other.txt", "other v2\n");
  assert.equal(snap(root, "f1", "§b/other").exit, 0);
  assert.equal(run(root, "promote", "f1", "--id", "§b/other").exit, 0);
  write(root, "lib/other.txt", "other v3\n");
  let p = run(root, "promote", "f1", "--id", "§b/other");
  assert.ok(codes(p).includes("evidence-stale"));
  assert.match(p.evidence[0].reasons.join(), /working tree differs/);
  write(root, "lib/other.txt", "other v2\n");
  write(root, D("f1", "claims/b/other.md"), "# §b/other\n\nOther does Z much better.\n");
  p = run(root, "promote", "f1", "--id", "§b/other");
  assert.match(p.evidence[0].reasons.join(), /prose changed after evidence/);
  assert.equal(snap(root, "f1", "§b/other").exit, 0, "re-record after the edit");
  assert.equal(run(root, "promote", "f1", "--id", "§b/other", "--write").exit, 0);
  assert.equal(read(root, ".sova/spec/claims/b/other.md"), "# §b/other\n\nOther does Z much better.\n");
});

test("evidence refuses unchanged ids, missing code, spec paths and non-note --doc-only", () => {
  const root = project();
  newDraft(root);
  assert.ok(codes(snap(root, "f1", "§b/other")).includes("not-changed"));
  write(root, D("f1", "claims/c/new.md"), "# §c/new\n\nNew.\n");
  editManifest(root, D("f1", "manifest.json"), (m) => { m.claims["§c/new"] = { kind: "behavior", authority: "accepted", requires: [] }; });
  assert.ok(codes(snap(root, "f1", "§c/new")).includes("evidence-no-code"));
  assert.ok(codes(run(root, "evidence", "f1", "--id", "§c/new", "--by", "t", "--verification", "v", "--snapshot", "--path", ".sova/spec/manifest.json")).includes("path-refused"));
  assert.ok(codes(run(root, "evidence", "f1", "--id", "§c/new", "--by", "t", "--verification", "v", "--doc-only")).includes("doc-only-refused"));
  editManifest(root, D("f1", "manifest.json"), (m) => { m.claims["§c/new"].code = [".sova/spec/claims/b/other.md"]; });
  assert.ok(codes(snap(root, "f1", "§c/new")).includes("path-refused"), "mapped code under .sova/spec is refused too");
  editManifest(root, D("f1", "manifest.json"), (m) => { delete m.claims["§c/new"].code; });
  assert.equal(run(root, "evidence", "f1", "--id", "§c/new", "--by", "t", "--verification", "v", "--snapshot", "--path", "lib/one.txt", "--write").exit, 0);
  // a note may be promoted on doc-only evidence
  write(root, D("f1", "claims/n/why.md"), "# §n/why\n\nDecision rationale.\n");
  editManifest(root, D("f1", "manifest.json"), (m) => { m.claims["§n/why"] = { kind: "note", authority: "accepted" }; });
  assert.equal(run(root, "evidence", "f1", "--id", "§n/why", "--by", "t", "--verification", "doc only", "--doc-only", "--write").exit, 0);
  assert.equal(run(root, "promote", "f1", "--id", "§c/new").exit, 0, "another record's edit does not stale §c/new");
  assert.equal(run(root, "promote", "f1", "--id", "§n/why", "--write").exit, 0);
});

// ---------------------------------------------------------------- selection, conflicts, merge
test("a file moves whole: every changed id in it must be selected", () => {
  const root = project();
  newDraft(root);
  write(root, D("f1", "claims/a/top.md"), TOP.replace("One does X.", "One does X2.").replace("Two does Y.", "Two does Y2."));
  write(root, "lib/one.txt", "one v2\n");
  snap(root, "f1", "§a.top/one");
  const p = run(root, "promote", "f1", "--id", "§a.top/one");
  assert.ok(codes(p).includes("selection-incomplete"));
  assert.match(p.refusals.find((r) => r.code === "selection-incomplete").message, /§a\.top\/two/);
  snap(root, "f1", "§a.top/two");
  assert.equal(run(root, "promote", "f1", "--id", "§a.top/one", "--id", "§a.top/two", "--write").exit, 0);
});

test("a prose file changed on both sides is a conflict that preserves current and draft", () => {
  const root = project();
  newDraft(root);
  write(root, D("f1", "claims/b/other.md"), "# §b/other\n\nDraft wording.\n");
  snap(root, "f1", "§b/other");
  write(root, ".sova/spec/claims/b/other.md", "# §b/other\n\nSomeone else promoted this.\n");
  const cur = current(root), dr = tree(root, ".sova/spec/drafts");
  const p = run(root, "promote", "f1", "--id", "§b/other", "--write");
  assert.equal(p.exit, 1);
  assert.ok(codes(p).includes("conflict"));
  assert.deepEqual(current(root), cur);
  assert.deepEqual(tree(root, ".sova/spec/drafts"), dr);
  assert.equal(run(root, "status", "f1").ids[0].current, "conflict");
  // identical on both sides is a no-op, not a conflict
  write(root, ".sova/spec/claims/b/other.md", "# §b/other\n\nDraft wording.\n");
  assert.equal(run(root, "status", "f1").ids[0].current, "already-current");
});

test("unrelated current changes survive a promotion; records merge per id", () => {
  const root = project();
  newDraft(root);
  editManifest(root, D("f1", "manifest.json"), (m) => { m.claims["§b/other"].code = ["lib/other.txt", "lib/two.txt"]; });
  snap(root, "f1", "§b/other");
  // meanwhile current gains an unrelated record, file and prose edit
  write(root, ".sova/spec/claims/z/late.md", "# §z/late\n\nLate.\n");
  editManifest(root, ".sova/spec/manifest.json", (m) => { m.claims["§z/late"] = { kind: "note", authority: "accepted" }; });
  write(root, ".sova/spec/claims/a/top.md", TOP.replace("The top surface.", "The top surface, edited in current."));
  const w = run(root, "promote", "f1", "--id", "§b/other", "--write");
  assert.equal(w.exit, 0, JSON.stringify([w.findings, w.refusals]));
  const m = JSON.parse(read(root, ".sova/spec/manifest.json"));
  assert.deepEqual(m.claims["§b/other"].code, ["lib/other.txt", "lib/two.txt"]);
  assert.deepEqual(m.claims["§z/late"], { kind: "note", authority: "accepted" });
  assert.match(read(root, ".sova/spec/claims/a/top.md"), /edited in current/);
  assert.ok(existsSync(join(root, ".sova/spec/claims/z/late.md")));
});

test("the merged graph is validated: a dangling requires is refused, deletions are explicit", () => {
  const root = project();
  newDraft(root);
  write(root, D("f1", "claims/c/one.md"), "# §c/one\n\nC one.\n");
  write(root, D("f1", "claims/c/two.md"), "# §c/two\n\nC two.\n");
  editManifest(root, D("f1", "manifest.json"), (m) => {
    m.claims["§c/one"] = { kind: "behavior", authority: "accepted", requires: ["§c/two"], code: ["lib/one.txt"] };
    m.claims["§c/two"] = { kind: "behavior", authority: "accepted", requires: [], code: ["lib/two.txt"] };
    delete m.claims["§b/other"];
  });
  rmSync(join(root, D("f1", "claims/b/other.md")));
  snap(root, "f1", "§c/one", "§c/two", "§b/other");
  const p = run(root, "promote", "f1", "--id", "§c/one");
  assert.ok(codes(p).includes("candidate-dangling"), JSON.stringify(p.refusals));
  const s = run(root, "status", "f1");
  assert.equal(s.ids.find((i) => i.id === "§b/other").change, "deleted");
  const w = run(root, "promote", "f1", "--id", "§c/one", "--id", "§c/two", "--id", "§b/other", "--write");
  assert.equal(w.exit, 0, JSON.stringify([w.findings, w.refusals]));
  assert.ok(!existsSync(join(root, ".sova/spec/claims/b/other.md")));
  assert.equal(JSON.parse(read(root, ".sova/spec/manifest.json")).claims["§b/other"], undefined);
  assert.equal(core(root, "check").exit, 0);
});

test("a record still labelled candidate is not promoted", () => {
  const root = project();
  newDraft(root);
  editManifest(root, D("f1", "manifest.json"), (m) => { m.claims["§b/other"].authority = "candidate"; });
  snap(root, "f1", "§b/other");
  assert.ok(codes(run(root, "promote", "f1", "--id", "§b/other")).includes("candidate-label"));
});

test("--plan binds the write to the previewed plan", () => {
  const root = project();
  newDraft(root);
  write(root, D("f1", "claims/b/other.md"), "# §b/other\n\nNew.\n");
  snap(root, "f1", "§b/other");
  const pv = run(root, "promote", "f1", "--id", "§b/other");
  write(root, D("f1", "claims/b/other.md"), "# §b/other\n\nNewer.\n");
  snap(root, "f1", "§b/other");
  const w = run(root, "promote", "f1", "--id", "§b/other", "--plan", pv.plan, "--write");
  assert.ok(codes(w).includes("plan-changed"));
});

// ---------------------------------------------------------------- Git evidence
test("Git: evidence needs an existing committed implementation matching the working tree", { skip: !hasGit }, () => {
  const root = project();
  git(root, "init", "-q"); git(root, "add", "-A"); git(root, "commit", "-qm", "base");
  newDraft(root);
  write(root, D("f1", "claims/b/other.md"), "# §b/other\n\nOther does Z better.\n");
  const ev = (rev, write = true) => run(root, "evidence", "f1", "--id", "§b/other", "--by", "t", "--verification", "npm test: pass", "--commit", rev, ...(write ? ["--write"] : []));
  assert.ok(codes(snap(root, "f1", "§b/other")).includes("git-requires-commit"));
  write(root, "lib/other.txt", "other v2\n");
  assert.ok(codes(ev("HEAD")).includes("input-uncommitted"), "dirty implementation is not evidence");
  assert.ok(codes(ev("nosuchrev")).includes("commit-missing"));
  git(root, "add", "lib/other.txt"); git(root, "commit", "-qm", "implement");
  const impl = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-qb", "side"); write(root, "x.txt", "x"); git(root, "add", "x.txt"); git(root, "commit", "-qm", "side");
  const side = git(root, "rev-parse", "HEAD"); git(root, "checkout", "-q", "main");
  assert.ok(codes(ev(side)).includes("commit-not-ancestor"));
  const ok = ev(impl.slice(0, 10));
  assert.equal(ok.exit, 0, JSON.stringify(ok.findings));
  assert.equal(ok.commit, impl, "the full object id is recorded");
  assert.equal(run(root, "promote", "f1", "--id", "§b/other").exit, 0);
  write(root, "lib/other.txt", "other v3 uncommitted\n");
  assert.ok(codes(run(root, "promote", "f1", "--id", "§b/other")).includes("evidence-stale"));
  write(root, "lib/other.txt", "other v2\n");
  const w = run(root, "promote", "f1", "--id", "§b/other", "--write");
  assert.equal(w.exit, 0, JSON.stringify(w.findings));
  assert.equal(git(root, "rev-parse", "HEAD"), impl, "the tool never commits");
});

// ---------------------------------------------------------------- integrity, safety
test("tampering, symlinks, malformed draft state and bad names are refused", () => {
  const root = project();
  newDraft(root);
  assert.equal(run(root, "status", "../x").exit, 2);
  assert.equal(run(root, "status", "nope").exit, 2);
  write(root, ".sova/spec/drafts/f1/base/claims/b/other.md", "# §b/other\n\nRewritten history.\n");
  assert.ok(codes(run(root, "status", "f1")).includes("base-tampered"));
  const r2 = project();
  newDraft(r2);
  symlinkSync(join(r2, "lib/one.txt"), join(r2, D("f1", "claims/b/link.md")));
  assert.equal(run(r2, "status", "f1").exit, 2);
  const r3 = project();
  newDraft(r3);
  editManifest(r3, ".sova/spec/drafts/f1/draft.json", (d) => { d.evidence.push({ mode: "commit", by: "x", verification: "trust me", ids: [{ id: "§b/other", recordSha: null, textSha256: null }], inputs: [] }); });
  assert.ok(codes(run(r3, "status", "f1")).includes("draft-corrupt"), "evidence without a commit id is malformed");
  const r4 = project();
  newDraft(r4);
  write(r4, "lib/.env", "SECRET=1");
  write(r4, D("f1", "claims/b/other.md"), "# §b/other\n\nx\n");
  assert.ok(codes(run(r4, "evidence", "f1", "--id", "§b/other", "--by", "t", "--verification", "v", "--snapshot", "--path", "lib/.env")).includes("path-refused"));
});

test("hand-forged snapshot evidence still has to match the retained and working bytes", () => {
  const root = project();
  newDraft(root);
  write(root, D("f1", "claims/b/other.md"), "# §b/other\n\nForged.\n");
  const st = run(root, "status", "f1");
  assert.equal(st.ids[0].evidence.state, "none");
  const textSha = JSON.parse(spawnSync(process.execPath, [CORE, "check", "--root", root, "--spec", D("f1"), "--json"], { encoding: "utf8" }).stdout).declarations.find((d) => d.id === "§b/other").textSha256;
  const recSha = sha(JSON.stringify({ authority: "accepted", code: ["lib/other.txt"], kind: "behavior", requires: [] }));
  editManifest(root, ".sova/spec/drafts/f1/draft.json", (d) => { d.evidence.push({ mode: "snapshot", by: "x", verification: "trust me", ids: [{ id: "§b/other", recordSha: recSha, textSha256: textSha }], inputs: [{ path: "lib/other.txt", state: "present", sha256: sha("other v1\n") }] }); });
  const p = run(root, "promote", "f1", "--id", "§b/other");
  assert.ok(codes(p).includes("evidence-stale"));
  assert.match(p.evidence[0].reasons.join(), /retained snapshot/);
});

test("lock held by another writer refuses writes", () => {
  const root = project();
  write(root, ".sova/spec/drafts/.lock", `${process.pid} other-host tok 2026`);
  assert.ok(codes(run(root, "new", "f1", "--write")).includes("lock-occupied"));
  assert.ok(existsSync(join(root, ".sova/spec/drafts/.lock")), "never removed");
});

// ---------------------------------------------------------------- transaction
function readyDraft(root) {
  newDraft(root);
  write(root, D("f1", "claims/b/other.md"), "# §b/other\n\nNew text.\n");
  editManifest(root, D("f1", "manifest.json"), (m) => { m.claims["§b/other"].requires = ["§a/top"]; });
  assert.equal(snap(root, "f1", "§b/other").exit, 0);
}

test("a failed write mid-promotion rolls every applied file back", { skip: process.getuid?.() === 0 }, () => {
  const root = project();
  readyDraft(root);
  const before = current(root);
  chmodSync(join(root, ".sova/spec"), 0o555); // claims/b/other.md can be replaced, manifest.json cannot
  const w = run(root, "promote", "f1", "--id", "§b/other", "--write");
  chmodSync(join(root, ".sova/spec"), 0o755);
  assert.ok(codes(w).includes("write-failed"), JSON.stringify(w.findings));
  assert.match(w.findings[0].message, /rolled back/);
  assert.deepEqual(current(root), before, "rolled back");
  assert.ok(!existsSync(join(root, ".sova/spec/drafts/.txn")), "no pending transaction after a clean rollback");
  assert.equal(run(root, "promote", "f1", "--id", "§b/other", "--write").exit, 0);
});

test("an interrupted promotion blocks writes until recover rolls it back", () => {
  const root = project();
  readyDraft(root);
  const oldBytes = read(root, ".sova/spec/claims/b/other.md");
  // Simulate a crash after the first file was renamed into place: journal + backups + half-applied tree.
  const txn = join(root, ".sova/spec/drafts/.txn");
  mkdirSync(txn);
  writeFileSync(join(txn, "old-0"), oldBytes);
  writeFileSync(join(txn, "new-0"), "# §b/other\n\nNew text.\n");
  writeFileSync(join(root, ".sova/spec/claims/b/other.md"), "# §b/other\n\nNew text.\n");
  writeFileSync(join(txn, "journal.json"), JSON.stringify({ format: "sova-spec-draft/1", draft: "f1", startedAt: "x", pid: 1,
    targets: [{ path: "claims/b/other.md", before: sha(oldBytes), after: sha("# §b/other\n\nNew text.\n"), i: 0 }] }));
  write(root, ".sova/spec/drafts/.lock", "999999999 " + spawnSync("hostname", { encoding: "utf8" }).stdout.trim() + " tok t");
  assert.ok(codes(run(root, "promote", "f1", "--id", "§b/other", "--write")).some((c) => c === "pending-transaction" || c === "lock-occupied"));
  const pv = run(root, "recover");
  assert.equal(pv.pending, true);
  assert.equal(pv.targets[0].state, "applied");
  const r = run(root, "recover", "--write");
  assert.equal(r.exit, 0, JSON.stringify(r.findings));
  assert.equal(read(root, ".sova/spec/claims/b/other.md"), oldBytes, "rolled back to the pre-promotion bytes");
  assert.ok(!existsSync(txn) && !existsSync(join(root, ".sova/spec/drafts/.lock")));
  assert.equal(run(root, "promote", "f1", "--id", "§b/other", "--write").exit, 0);
});

test("recover refuses when a file matches neither side of the journal", () => {
  const root = project();
  const txn = join(root, ".sova/spec/drafts/.txn");
  mkdirSync(txn, { recursive: true });
  writeFileSync(join(txn, "journal.json"), JSON.stringify({ format: "sova-spec-draft/1", draft: "f1", startedAt: "x", pid: 1,
    targets: [{ path: "claims/b/other.md", before: sha("a"), after: sha("b"), i: 0 }] }));
  const before = current(root);
  assert.ok(codes(run(root, "recover", "--write")).includes("recover-conflict"));
  assert.deepEqual(current(root), before);
  assert.ok(existsSync(txn));
});

// ---------------------------------------------------------------- review findings
test("secret-named data is refused, but docs and code named after secrets are not", () => {
  const root = project();
  write(root, ".sova/spec/claims/app/secrets.md", "# §app/secrets\n\nHow secrets are handled.\n");
  editManifest(root, ".sova/spec/manifest.json", (m) => { m.claims["§app/secrets"] = { kind: "behavior", authority: "accepted", requires: [], code: ["lib/secrets.ts"] }; });
  write(root, "lib/secrets.ts", "export const load = () => {};\n");
  newDraft(root);
  write(root, D("f1", "claims/app/secrets.md"), "# §app/secrets\n\nHow secrets are handled, now rotated.\n");
  for (const f of ["secrets.test.ts", "secrets-manager.ts"]) write(root, `lib/${f}`, "x");
  assert.equal(run(root, "evidence", "f1", "--id", "§app/secrets", "--by", "t", "--verification", "v", "--snapshot", "--path", "lib/secrets.test.ts", "--path", "lib/secrets-manager.ts").exit, 0, "code named after secrets is allowed");
  assert.equal(snap(root, "f1", "§app/secrets").exit, 0, "secrets.ts is code, secrets.md is prose");
  assert.equal(run(root, "promote", "f1", "--id", "§app/secrets", "--write").exit, 0);
  for (const f of ["secret", "secrets.json", "secrets.local.json", "secrets-prod.yaml", "secrets.sops.yaml", "secrets.prod.yaml", ".env.example", ".env.local", "credentials.json", "id_ed25519", "server.pem"]) {
    write(root, `lib/${f}`, "x");
    assert.ok(codes(run(root, "evidence", "f1", "--id", "§app/secrets", "--by", "t", "--verification", "v", "--snapshot", "--path", `lib/${f}`)).includes("path-refused"), f);
  }
  const r2 = project();
  write(r2, ".sova/spec/claims/b/key.pem", "-----BEGIN-----");
  assert.equal(run(r2, "new", "f1").exit, 2, "key material in the claims tree is refused");
  for (const f of [".env", "credentials.json", "secrets.json", "id_rsa", ".npmrc"]) {
    const r3 = project();
    write(r3, `.sova/spec/claims/a/${f}`, "TOKEN=1");
    const j = run(r3, "new", "f1", "--write");
    assert.equal(j.exit, 2, `credential data in the claims tree is refused too: ${f}`);
    assert.ok(!existsSync(join(r3, ".sova/spec/drafts/f1")), `${f} never copied`);
  }
  assert.ok(existsSync(join(root, ".sova/spec/drafts/f1/base/claims/app/secrets.md")), "secrets.md prose was copied");
});

test("every mapped code path must be present; --path cannot stand in for it", () => {
  const root = project();
  newDraft(root);
  write(root, D("f1", "claims/c/new.md"), "# §c/new\n\nNew.\n");
  editManifest(root, D("f1", "manifest.json"), (m) => { m.claims["§c/new"] = { kind: "behavior", authority: "accepted", requires: [], code: ["lib/never-written.ts"] }; });
  const ev = run(root, "evidence", "f1", "--id", "§c/new", "--by", "t", "--verification", "v", "--snapshot", "--path", "lib/one.txt");
  assert.ok(codes(ev).includes("evidence-code-missing"), JSON.stringify(ev.findings));
  // a hand-made entry that skips the check is still refused at promotion
  const textSha = JSON.parse(spawnSync(process.execPath, [CORE, "check", "--root", root, "--spec", D("f1"), "--json"], { encoding: "utf8" }).stdout).declarations.find((d) => d.id === "§c/new").textSha256;
  const recSha = sha(JSON.stringify({ authority: "accepted", code: ["lib/never-written.ts"], kind: "behavior", requires: [] }));
  editManifest(root, ".sova/spec/drafts/f1/draft.json", (d) => { d.evidence.push({ mode: "snapshot", by: "x", verification: "v", ids: [{ id: "§c/new", recordSha: recSha, textSha256: textSha }], inputs: [{ path: "lib/never-written.ts", state: "absent" }] }); });
  const p = run(root, "promote", "f1", "--id", "§c/new");
  assert.ok(codes(p).includes("evidence-stale"));
  assert.match(p.evidence[0].reasons.join(), /as a present file/);
});

test("authority is checked on every selected id, including prose-only changes", () => {
  const root = project();
  editManifest(root, ".sova/spec/manifest.json", (m) => { m.claims["§b/other"].authority = "candidate"; });
  newDraft(root);
  write(root, D("f1", "claims/b/other.md"), "# §b/other\n\nProse-only change.\n");
  snap(root, "f1", "§b/other");
  assert.ok(codes(run(root, "promote", "f1", "--id", "§b/other")).includes("candidate-label"), "record unchanged, still candidate");
  const r2 = project();
  editManifest(r2, ".sova/spec/manifest.json", (m) => { delete m.claims["§b/other"].authority; });
  newDraft(r2);
  write(r2, D("f1", "claims/b/other.md"), "# §b/other\n\nProse-only change.\n");
  snap(r2, "f1", "§b/other");
  assert.ok(codes(run(r2, "promote", "f1", "--id", "§b/other")).includes("authority-missing"));
  editManifest(r2, D("f1", "manifest.json"), (m) => { m.claims["§b/other"].authority = "migrated"; });
  snap(r2, "f1", "§b/other");
  assert.equal(run(r2, "promote", "f1", "--id", "§b/other").exit, 0, "migrated is an explicit, allowed label");
});

test("a claims tree without a manifest is refused, not treated as no spec", () => {
  const root = project();
  rmSync(join(root, ".sova/spec/manifest.json"));
  const before = tree(root);
  const j = run(root, "new", "f1", "--write");
  assert.ok(codes(j).includes("orphaned-spec"));
  assert.equal(j.exit, 2);
  assert.deepEqual(tree(root), before, "nothing written");
});

test("an enclosing repository that ignores the project is not the project's Git", { skip: !hasGit }, () => {
  const outer = mkdtempSync(join(tmpdir(), "sova-draft-outer-"));
  roots.push(outer);
  git(outer, "init", "-q");
  write(outer, ".gitignore", "*\n!.gitignore\n");
  git(outer, "add", ".gitignore"); git(outer, "commit", "-qm", "dotfiles");
  const root = join(outer, "work/proj");
  mkdirSync(root, { recursive: true });
  write(root, ".sova/spec/manifest.json", manifest(CLAIMS));
  write(root, ".sova/spec/claims/a/top.md", TOP);
  write(root, ".sova/spec/claims/b/other.md", "# §b/other\n\nOther does Z.\n");
  for (const f of ["one", "two", "other"]) write(root, `lib/${f}.txt`, `${f} v1\n`);
  newDraft(root);
  write(root, D("f1", "claims/b/other.md"), "# §b/other\n\nChanged.\n");
  assert.equal(run(root, "status", "f1").git, false);
  assert.equal(snap(root, "f1", "§b/other").exit, 0, "snapshot evidence works");
  assert.equal(run(root, "promote", "f1", "--id", "§b/other", "--write").exit, 0);
  // a project the outer repository does track stays a Git project
  const inner = join(outer, "tracked");
  mkdirSync(inner);
  write(outer, ".gitignore", "*\n!.gitignore\n!tracked/\n!tracked/**\n");
  write(inner, ".sova/spec/manifest.json", manifest(CLAIMS));
  write(inner, ".sova/spec/claims/a/top.md", TOP);
  write(inner, ".sova/spec/claims/b/other.md", "# §b/other\n\nOther does Z.\n");
  for (const f of ["one", "two", "other"]) write(inner, `lib/${f}.txt`, `${f} v1\n`);
  git(outer, "add", "-A"); git(outer, "commit", "-qm", "track");
  newDraft(inner);
  write(inner, D("f1", "claims/b/other.md"), "# §b/other\n\nChanged.\n");
  assert.ok(codes(snap(inner, "f1", "§b/other")).includes("git-requires-commit"));
});

test("recover's dead-lock takeover fails closed when a competitor takes the lock first", () => {
  const root = project();
  const host = spawnSync("hostname", { encoding: "utf8" }).stdout.trim();
  write(root, ".sova/spec/drafts/.lock", `999999999 ${host} tok t`);
  // Test-only preload: right after the tool unlinks the dead lock, a competitor creates it (once).
  const preload = join(root, "competitor.mjs");
  writeFileSync(preload, `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";
const real = fs.promises.unlink; let done = false;
fs.promises.unlink = async (p, ...r) => { const out = await real(p, ...r);
  if (!done && String(p).endsWith(".lock")) { done = true; fs.writeFileSync(p, "1 elsewhere competitor t", { flag: "wx" }); } return out; };
syncBuiltinESMExports();\n`);
  const r = spawnSync(process.execPath, ["--import", preload, CLI, "recover", "--write", "--root", root, "--json"], { encoding: "utf8" });
  const j = JSON.parse(r.stdout);
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(codes(j), ["lock-occupied"]);
  assert.equal(read(root, ".sova/spec/drafts/.lock"), "1 elsewhere competitor t", "the competitor's lock is left alone");
});
