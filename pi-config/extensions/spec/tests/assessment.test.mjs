import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync, chmodSync, readdirSync, cpSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "../core");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const write = (root, p, s) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), s); };
function git(root, ...args) {
  const r = spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
}
function fixture(t, useGit = true) {
  const root = mkdtempSync(join(tmpdir(), "spec-assess-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  write(root, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, boundary: { include: ["lib"], exclude: [] }, claims: {
    "§app/rule": { kind: "behavior", requires: [], authority: "accepted", evidence: "verified", code: ["lib/rule.js"] },
    "§design/rule": { kind: "behavior", requires: [], authority: "migrated", evidence: "unreviewed", code: ["lib/rule.js"] },
    "§other/rule": { kind: "behavior", requires: [], code: ["lib/other.js"] },
  } }));
  write(root, ".sova/spec/claims/app/rule.md", "# §app/rule\n\nMeter fill warns at ≥80%.\n");
  write(root, ".sova/spec/claims/design/rule.md", "# §design/rule\n\nMeter fill warns at ≥80%.\n");
  write(root, ".sova/spec/claims/other/rule.md", "# §other/rule\n\nOther promise.\n");
  write(root, "lib/rule.js", "export const threshold = 80; // PRIVATE_RAW_SENTINEL\n");
  write(root, "lib/other.js", "export const other = 1;\n");
  write(root, ".gitignore", ".sova/spec/assessments/\n.sova/spec/drafts/\n");
  if (useGit) { git(root, "init", "-b", "main"); git(root, "add", "."); git(root, "commit", "-m", "baseline"); }
  return root;
}
function run(root, tool, args, core = CORE) {
  const r = spawnSync(process.execPath, [join(core, `sova-spec${tool ? `-${tool}` : ""}.mjs`), ...args, "--root", root, "--json"], { cwd: root, encoding: "utf8", timeout: 60000 });
  assert.ifError(r.error); let j; try { j = JSON.parse(r.stdout); } catch { assert.fail(r.stdout + r.stderr); }
  assert.equal(r.status, j.exit); return j;
}
const assess = (root, ...args) => run(root, "assess", args);
const prep = (root, name = "change", ...args) => assess(root, "prepare", name, "--write", ...args);
const basis = (result = "passed", revision = null) => [{ kind: "inspection", revision, result, summary: "Inspected comparison over captured inputs" }];
const decisions = (ids, disposition = "preserved", result = "passed") => ({ decisions: [{ ids, disposition, reason: "Explicitly compared shared input behavior", basis: basis(result), acceptedIntent: true }], files: [] });
const record = (root, name, d) => assess(root, "record", name, "--by", "fixture", "--decisions-json", JSON.stringify(d), "--write", "--self");
const ids = ["§app/rule", "§design/rule"];

test("80 to 90 unchanged verified prose begins unresolved, exact hashes and no source retained", (t) => {
  const root = fixture(t); write(root, "lib/rule.js", "export const threshold = 90; // PRIVATE_RAW_SENTINEL\n");
  const p = prep(root); assert.equal(p.exit, 0, JSON.stringify(p)); assert.deepEqual(p.changedFiles, ["lib/rule.js"]);
  assert.deepEqual(p.candidates.map((c) => c.id).sort(), ids); assert.ok(p.candidates.every((c) => c.disposition === "unresolved"));
  assert.equal(p.candidates.find((c) => c.id === ids[0]).declaredLabels.evidence, "verified");
  const input = p.inputs.find((i) => i.path === "lib/rule.js"); assert.notEqual(input.sha256, input.baseline.sha256);
  const s = assess(root, "status", "change"); assert.equal(s.applicability, "current"); assert.equal(s.assessmentState, "outstanding"); assert.deepEqual(s.coverage.unresolvedIds.sort(), ids);
  const stored = readFileSync(join(root, p.packet), "utf8"); assert.doesNotMatch(stored, /PRIVATE_RAW_SENTINEL|export const|\/tmp\//);
  assert.equal(readdirSync(join(root, ".sova/spec/assessments/change")).length, 1);
});

test("benign refactor preserved batch, independent intent, failed verification separate and restart durable", (t) => {
  const root = fixture(t); write(root, "lib/rule.js", "export const threshold = Number(80);\n");
  assert.equal(prep(root).exit, 0); assert.equal(record(root, "change", decisions(ids, "preserved", "failed")).exit, 0);
  const s = assess(root, "status", "change"); assert.equal(s.exit, 0); assert.equal(s.applicability, "current"); assert.equal(s.assessmentState, "recorded"); assert.equal(s.verification.failed.length, 1); assert.equal(s.verification.passed.length, 0);
  assert.equal(s.decisions.decisions[0].acceptedIntent, true); assert.equal(s.recorder.selfReview, true);
  assert.equal(readFileSync(join(root, ".sova/spec/claims/app/rule.md"), "utf8").includes("≥80%"), true);
  assert.equal(record(root, "change", decisions(ids)).findings[0].code, "record-exists");
});

test("input changes stale; old preserved record cannot hide newest unresolved", (t) => {
  const root = fixture(t); write(root, "lib/rule.js", "refactor one\n"); prep(root); record(root, "change", decisions(ids));
  write(root, "lib/rule.js", "refactor two\n"); assert.equal(assess(root, "status", "change").applicability, "stale");
  assert.equal(record(root, "change", decisions(ids)).exit, 1); prep(root, "next");
  const all = assess(root, "status", "--owner-session", "owner"); assert.equal(all.observations.length, 2); assert.ok(all.observations.some((s) => s.name === "next" && s.assessmentState === "outstanding"));
});

test("initial dirty snapshot excluded only if equal; repeat samepath retained; committed task bytes remain observed", (t) => {
  const root = fixture(t); write(root, "lib/rule.js", "initial dirty 85\n");
  const initial = assess(root, "prepare", "preview", "--path", "lib/rule.js");
  const i = initial.inputs.find((i) => i.path === "lib/rule.js");
  const baseline = JSON.stringify({ inputs: [{ path: i.path, state: i.state, sha256: i.sha256, bytes: i.bytes }] });
  const base = git(root, "rev-parse", "HEAD");
  assert.deepEqual(assess(root, "prepare", "before", "--base", base, "--baseline-json", baseline).changedFiles, []);
  write(root, "lib/rule.js", "changed dirty 90\n"); git(root, "add", "lib/rule.js"); git(root, "commit", "-m", "task bytes");
  const p = prep(root, "after", "--base", base, "--baseline-json", baseline);
  assert.deepEqual(p.changedFiles, ["lib/rule.js"]); const target = p.inputs.find((i) => i.path === "lib/rule.js");
  assert.equal(target.baseline.source, "declared-snapshot"); assert.equal(target.baseline.sha256, i.sha256);
  assert.equal(target.sha256, sha("changed dirty 90\n"));
  assert.notEqual(target.baseline.sha256, sha("export const threshold = 80; // PRIVATE_RAW_SENTINEL\n"));
  assert.notEqual(target.baseline.sha256, target.sha256);
});

test("explicit Git path subset does not assign unrelated pre-existing changes", (t) => {
  const root = fixture(t); write(root, "lib/rule.js", "task changed\n"); write(root, "lib/other.js", "foreign changed\n");
  const p = prep(root, "subset", "--path", "lib/rule.js"); assert.deepEqual(p.changedFiles, ["lib/rule.js"]); assert.deepEqual(p.candidates.map((c) => c.id).sort(), ids);
});

test("noGit absent baseline unknown; declared snapshot enables applicability without truth claim", (t) => {
  const root = fixture(t, false); const p = prep(root, "unknown", "--path", "lib/rule.js"); assert.equal(p.exit, 0); assert.equal(assess(root, "status", "unknown").applicability, "unknown");
  const input = p.inputs.find((i) => i.path === "lib/rule.js");
  const baseline = JSON.stringify({ inputs: [{ path: input.path, state: "present", sha256: sha("old bytes"), bytes: 9 }] });
  prep(root, "snapshot", "--path", "lib/rule.js", "--baseline-json", baseline); assert.equal(assess(root, "status", "snapshot").applicability, "current");
  assert.equal(prep(root, "empty").unknowns.some((i) => i.code === "change-inventory-unknown"), true);
});

test("batch nonapplicability requires rationale/basis, omitted candidate unresolved, unmapped file not plumbing", (t) => {
  const root = fixture(t); write(root, "lib/rule.js", "changed\n"); write(root, "lib/unmapped.js", "new unclassified\n");
  const p = prep(root); assert.deepEqual(p.unmappedFiles, ["lib/unmapped.js"]);
  const d = decisions([ids[0]], "not-applicable"); assert.equal(record(root, "change", { ...d, decisions: [{ ...d.decisions[0], reason: "" }] }).exit, 2);
  assert.equal(record(root, "change", d).exit, 0); const s = assess(root, "status", "change"); assert.deepEqual(s.coverage.unresolvedIds, [ids[1]]); assert.deepEqual(s.coverage.unresolvedFiles, ["lib/unmapped.js"]);
});

for (const unsafe of ["symlink", "hardlink", "oversize", "credential", "missing"]) test(`${unsafe} input remains unknown/refused and never false current`, (t) => {
  const root = fixture(t); const path = unsafe === "credential" ? ".env" : "lib/rule.js";
  if (unsafe === "symlink") { rmSync(join(root, path)); symlinkSync(join(root, "lib/other.js"), join(root, path)); }
  if (unsafe === "hardlink") linkSync(join(root, path), join(root, "lib/alias.js"));
  if (unsafe === "oversize") write(root, path, "x".repeat(2 * 1024 * 1024 + 1));
  if (unsafe === "credential") write(root, path, "DUMMY_SECRET_SENTINEL");
  if (unsafe === "missing") rmSync(join(root, path));
  const p = prep(root, "unsafe", "--path", path); assert.equal(p.exit, 0, JSON.stringify(p)); assert.ok(p.unknowns.length);
  assert.notEqual(assess(root, "status", "unsafe").applicability, "current"); assert.doesNotMatch(JSON.stringify(p), /DUMMY_SECRET_SENTINEL/);
});

test("owner attribution exact/null, conflicting owner excluded; corrupt enumeration explicit", (t) => {
  const root = fixture(t); write(root, "lib/rule.js", "changed\n");
  const attr = (owner) => JSON.stringify({ ownerSessionId: owner, sessionId: "worker-session", workerId: "worker", teamId: "team", taskId: "task", attemptId: "attempt" });
  prep(root, "mine", "--attribution-json", attr("owner")); prep(root, "other", "--attribution-json", attr("foreign")); prep(root, "unknown");
  const all = assess(root, "status", "--owner-session", "owner"); assert.equal(all.excluded, 1); assert.equal(all.observations.length, 2);
  write(root, ".sova/spec/assessments/broken/packet.json", "{}");
  const bad = assess(root, "status", "--owner-session", "owner"); assert.equal(bad.state, "incomplete"); assert.ok(bad.reasons.some((s) => s.includes("packet-corrupt")));
});

test("immutable name, occupied lock, corrupt record and safe standalone copy", (t) => {
  const root = fixture(t); write(root, "lib/rule.js", "changed\n"); prep(root); assert.equal(prep(root).findings[0].code, "name-taken");
  write(root, ".sova/spec/assessments/.lock", "another writer"); assert.equal(prep(root, "locked").findings[0].code, "lock-occupied"); rmSync(join(root, ".sova/spec/assessments/.lock"));
  record(root, "change", decisions(ids)); write(root, ".sova/spec/assessments/change/record.json", "{}"); assert.equal(assess(root, "status", "change").exit, 2);
  const tools = join(root, "standalone"); mkdirSync(tools);
  for (const f of readdirSync(CORE).filter((f) => f.endsWith(".mjs"))) cpSync(join(CORE, f), join(tools, f));
  const p = run(root, "assess", ["prepare", "standalone", "--path", "lib/rule.js"], tools); assert.equal(p.exit, 0);
});

test("draft threshold restatement candidates retain old80 outstanding without editing frozen oracle", (t) => {
  const root = fixture(t); assert.equal(run(root, "draft", ["new", "threshold", "--write"]).exit, 0);
  write(root, ".sova/spec/drafts/threshold/spec/claims/app/rule.md", "# §app/rule\n\nMeter fill warns at ≥90%.\n"); write(root, "lib/rule.js", "threshold 90\n");
  const p = prep(root, "drift", "--draft", "threshold", "--spec", ".sova/spec/drafts/threshold/spec");
  assert.equal(p.exit, 0, JSON.stringify(p)); assert.ok(p.candidates.find((c) => c.id === "§design/rule").reasons.some((r) => r.route === "heuristic-restatement"));
  assert.equal(assess(root, "status", "drift").assessmentState, "outstanding");
});

for (const mutation of ["mapping", "prose", "label"]) test(`${mutation} change stales the original exact claim binding`, (t) => {
  const root = fixture(t); write(root, "lib/rule.js", "changed\n"); prep(root);
  if (mutation === "prose") write(root, ".sova/spec/claims/app/rule.md", "# §app/rule\n\nDifferent adopted promise.\n");
  else {
    const p = ".sova/spec/manifest.json", m = JSON.parse(readFileSync(join(root, p)));
    if (mutation === "mapping") m.claims["§app/rule"].code.push("lib/other.js"); else m.claims["§app/rule"].evidence = "unreviewed";
    write(root, p, JSON.stringify(m));
  }
  assert.equal(assess(root, "status", "change").applicability, "stale");
});

test("verification revision is independently matching, mismatched or unknown; never test execution proof", (t) => {
  const root = fixture(t); const base = git(root, "rev-parse", "HEAD"); write(root, "lib/rule.js", "changed\n"); prep(root);
  const d = decisions(ids); d.decisions[0].basis = [...basis("passed", base), ...basis("failed", null)]; record(root, "change", d);
  const s = assess(root, "status", "change"); assert.equal(s.applicability, "current");
  assert.equal(s.verification.passed[0].revisionBinding.inputApplicability, "mismatched");
  assert.equal(s.verification.failed[0].revisionBinding.inputApplicability, "unknown");
  git(root, "add", "lib/rule.js"); git(root, "commit", "-m", "actual bytes"); prep(root, "committed", "--base", base);
  const exact = decisions(ids); exact.decisions[0].basis = basis("passed", git(root, "rev-parse", "HEAD")); record(root, "committed", exact);
  assert.equal(assess(root, "status", "committed").verification.passed[0].revisionBinding.inputApplicability, "matching");
});

test("partial draft inventories remain explicit unknown, not filtered for convenient current status", (t) => {
  const root = fixture(t); write(root, "lib/rule.js", "changed\n"); write(root, ".sova/spec/drafts/broken/draft.json", "{}");
  const p = prep(root); assert.ok(p.unknowns.some((u) => /draft/.test(u.code)));
  assert.equal(assess(root, "status", "change").applicability, "unknown");
});

test("actual concurrent preparations never overwrite a single immutable observation", async (t) => {
  const root = fixture(t); write(root, "lib/rule.js", "changed\n");
  const invoke = () => new Promise((ok, bad) => {
    const ch = spawn(process.execPath, [join(CORE, "sova-spec-assess.mjs"), "prepare", "same", "--root", root, "--write", "--json"]);
    let stdout = ""; ch.stdout.on("data", (b) => stdout += b); ch.on("error", bad); ch.on("close", (exit) => { try { const j = JSON.parse(stdout); assert.equal(j.exit, exit); ok(j); } catch (e) { bad(e); } });
  });
  const results = await Promise.all([invoke(), invoke()]);
  assert.equal(results.filter((r) => r.exit === 0).length, 1); assert.equal(results.filter((r) => r.exit === 1).length, 1);
  assert.equal(assess(root, "status", "same").applicability, "current");
});

test("ignored nested project is noGit, not the enclosing repository's task baseline", (t) => {
  const root = fixture(t); write(root, ".gitignore", ".sova/spec/assessments/\n.sova/spec/drafts/\nignored/\n"); git(root, "add", ".gitignore"); git(root, "commit", "-m", "ignore unrelated project");
  const sub = join(root, "ignored"); mkdirSync(sub);
  cpSync(join(root, ".sova"), join(sub, ".sova"), { recursive: true }); cpSync(join(root, "lib"), join(sub, "lib"), { recursive: true });
  const p = prep(sub, "nested", "--path", "lib/rule.js"); assert.equal(p.exit, 0); assert.equal(p.query.base, null);
  assert.equal(assess(sub, "status", "nested").applicability, "unknown");
});

test("unborn Git baseline is explicit unknown, not an invented current revision", (t) => {
  const root = fixture(t, false); git(root, "init", "-b", "main");
  const p = prep(root, "unborn", "--path", "lib/rule.js"); assert.equal(p.exit, 0); assert.equal(p.query.base, null);
  assert.equal(assess(root, "status", "unborn").applicability, "unknown");
});

test("unsafe mapped paths remain durable refused metadata, not self-corrupting successful receipts", (t) => {
  const root = fixture(t); const p = ".sova/spec/manifest.json", m = JSON.parse(readFileSync(join(root, p)));
  m.claims["§app/rule"].code = ["../outside"]; write(root, p, JSON.stringify(m));
  const prepared = prep(root, "refused-path", "--path", "lib/rule.js", "--id", "§app/rule");
  assert.equal(prepared.exit, 0); assert.equal(prepared.inputs.find((i) => i.path === "../outside").state, "refused");
  const s = assess(root, "status", "refused-path"); assert.equal(s.exit, 1); assert.equal(s.applicability, "unknown");
});
