// The companion reader (createInspection) and the draft tool's inspectDraft: the same JSON envelopes as the CLI,
// detached results, the review read policy isolated per reader. Moved from the retired assessment's tests
// (assessment-efficiency.test.mjs) when the assessment tool was retired; these are the reader's own contracts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInspection } from "../core/sova-spec.mjs";
import { inspectDraft } from "../core/sova-spec-draft.mjs";
const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "../core");
const write = (root, p, v) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), v); };
const sha = (s) => createHash("sha256").update(s).digest("hex");
function git(root, ...args) {
  const r = spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-C", root, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "spec-efficiency-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  write(root, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, boundary: { include: ["lib"], exclude: [] }, claims: {
    "§app/top": { kind: "surface", authority: "accepted" },
    "§app.top/rule": { kind: "behavior", requires: ["§dep/rule"], code: ["lib/rule.bin"] },
    "§app.top/sibling": { kind: "behavior", requires: [] },
    "§dep/rule": { kind: "behavior", code: ["lib/missing"], incumbent: [{ file: "legacy.md", lines: [1, 1], spanSha256: sha("legacy") }] },
    "§section/task": { kind: "section", members: ["§app.top/rule", "§app.top/sibling"] },
  } }));
  write(root, ".sova/spec/claims/app/top.md", "# §app/top\n\nOrientation.\n\n## §app.top/rule\n\nPromise 80%.\n\n## §app.top/sibling\n\nSibling promise.\n");
  write(root, ".sova/spec/claims/dep/rule.md", "# §dep/rule\n\nDependency.\n");
  write(root, ".sova/spec/claims/section/task.md", "# §section/task\n\nWorking set.\n");
  write(root, "legacy.md", "legacy\n"); write(root, "lib/rule.bin", Buffer.from([0, 10, 255, 128, 1]));
  git(root, "init", "-b", "main"); git(root, "add", "."); git(root, "commit", "-m", "fixed graph");
  return root;
}
function cli(root, file, args, dir = CORE, flags = [], env = {}) {
  const r = spawnSync(process.execPath, [...flags, join(dir, file), ...args, "--root", root, "--json"], { encoding: "utf8", timeout: 60000, env: { ...process.env, ...env } });
  assert.ifError(r.error); const out = JSON.parse(r.stdout); assert.equal(r.status, out.exit); return { out, stdout: r.stdout, stderr: r.stderr };
}

test("shared reader repeats exact CLI envelopes without accumulated findings or mutated graph data", (t) => {
  const root = fixture(t);
  const claim = ".sova/spec/claims/app/top.md";
  write(root, claim, "Outside any declaration.\n" + readFileSync(join(root, claim), "utf8"));
  const reader = createInspection(root, { readPolicy: "review" });
  const cases = [
    ["check", [], () => reader.check()],
    ["scope", ["§app.top/rule"], () => reader.scope("§app.top/rule")],
    ["scope", ["§section/task"], () => reader.scope("§section/task")],
    ["impact", ["§dep/rule"], () => reader.impact("§dep/rule")],
    ["scope", ["§absent/rule"], () => reader.scope("§absent/rule")],
    ["census", ["--changed", "--related", "--base", "HEAD"], () => reader.census({ base: "HEAD", related: true })],
  ];
  for (let pass = 0; pass < 2; pass++) for (const [cmd, extra, query] of cases) {
    const expected = cli(root, "sova-spec.mjs", [cmd, ...extra, "--read-policy", "review"]).out;
    assert.deepEqual(query(), expected);
  }
  const result = reader.scope("§app.top/rule");
  result.findings[0].message = "consumer tainted inherited graph finding";
  result.findings.push({ severity: "error", code: "injected", message: "consumer mutation" });
  result.passages[0].lines[0] = -999; result.passages[1].labels.authority = "candidate";
  result.passages[0].reasons.push({ reason: "invented" }); result.code[0].claims.push("§fake/rule");
  assert.deepEqual(reader.scope("§app.top/rule"), cli(root, "sova-spec.mjs", ["scope", "§app.top/rule", "--read-policy", "review"]).out);
});

test("interleaved factories restore review policy and failed query state", (t) => {
  const root = fixture(t); write(root, ".env", "PRIVATE_REFUSED_SENTINEL\n");
  const p = ".sova/spec/manifest.json", m = JSON.parse(readFileSync(join(root, p)));
  m.claims["§dep/rule"].incumbent = [{ file: ".env", lines: [1, 1], spanSha256: sha("PRIVATE_REFUSED_SENTINEL") }]; write(root, p, JSON.stringify(m));
  const strict = createInspection(root, { readPolicy: "review" }), ordinary = createInspection(root);
  const a = strict.scope("§dep/rule"), b = ordinary.scope("§dep/rule");
  assert.equal(a.passages[0].provenance.entries[0].state, "refused"); assert.equal(b.passages[0].provenance.entries[0].state, "current-equal");
  assert.deepEqual(strict.scope("§dep/rule"), a); assert.deepEqual(ordinary.scope("§dep/rule"), b);
  const invalid = createInspection(root, { spec: "../outside" }); assert.equal(invalid.check().exit, 2);
  assert.deepEqual(strict.scope("§dep/rule"), a);
  assert.throws(() => strict.scope({ toString() { throw new Error("controlled query exception"); } }), /controlled query exception/);
  assert.deepEqual(ordinary.scope("§dep/rule"), b); assert.deepEqual(strict.scope("§dep/rule"), a);
});

test("import is silent/no exit-state mutation; direct directory-symlink and preserve-symlink launch stay byte-equal", (t) => {
  const root = fixture(t), alias = join(root, "trusted-core"); symlinkSync(CORE, alias);
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `process.exitCode=7; await import(${JSON.stringify(new URL("../core/sova-spec.mjs", import.meta.url).href)}); process.stdout.write(String(process.exitCode));`], { encoding: "utf8" });
  assert.equal(imported.status, 7); assert.equal(imported.stdout, "7"); assert.equal(imported.stderr, "");
  for (const args of [["scope", "§app.top/rule"], ["census", "--changed", "--related"], ["packet", "§app.top/rule", "--budget", "1024"]]) {
    const a = cli(root, "sova-spec.mjs", args);
    const b = cli(root, "sova-spec.mjs", args, alias);
    const c = cli(root, "sova-spec.mjs", args, alias, ["--preserve-symlinks-main", "--preserve-symlinks"]);
    assert.equal(b.stdout, a.stdout); assert.equal(b.stderr, a.stderr); assert.equal(c.stdout, a.stdout); assert.equal(c.stderr, a.stderr);
  }
});

test("each fresh reader observes changed input state instead of sharing a previous graph/refusal snapshot", (t) => {
  const root = fixture(t); const before = createInspection(root, { readPolicy: "review" }).scope("§app.top/rule");
  const p = ".sova/spec/claims/app/top.md"; write(root, p, readFileSync(join(root, p), "utf8").replace("80%", "90%"));
  const after = createInspection(root, { readPolicy: "review" }).scope("§app.top/rule");
  assert.notEqual(after.passages[0].text, before.passages[0].text);
  rmSync(join(root, "legacy.md")); symlinkSync(join(root, "lib/rule.bin"), join(root, "legacy.md"));
  assert.equal(createInspection(root, { readPolicy: "review" }).scope("§dep/rule").passages[0].provenance.entries[0].state, "refused");
});

test("draft API is check-only, silent and default-byte-equivalent; review is its only other policy", async (t) => {
  const root = fixture(t);
  assert.equal(cli(root, "sova-spec-draft.mjs", ["new", "privacy", "--write"]).out.exit, 0);
  const expected = cli(root, "sova-spec-draft.mjs", ["check", "privacy"]);
  assert.equal(JSON.stringify(await inspectDraft(root, "privacy"), null, 2) + "\n", expected.stdout);
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `process.exitCode=7; await import(${JSON.stringify(new URL("../core/sova-spec-draft.mjs", import.meta.url).href)});process.stdout.write(String(process.exitCode));`], { encoding: "utf8" });
  assert.equal(imported.status, 7); assert.equal(imported.stdout, "7"); assert.equal(imported.stderr, "");
  const alias = join(root, "trusted-draft-core"); symlinkSync(CORE, alias);
  const linked = cli(root, "sova-spec-draft.mjs", ["check", "privacy"], alias, ["--preserve-symlinks-main", "--preserve-symlinks"]);
  assert.equal(linked.stdout, expected.stdout); assert.equal(linked.stderr, expected.stderr);
  const review = await inspectDraft(root, "privacy", { readPolicy: "review" });
  assert.equal(review.exit, expected.out.exit, "the review policy is not tightened");
  assert.equal(review.inputSources, undefined, "no input-source metadata: that was the retired assessment's");
  for (const policy of ["assessment", "invalid"]) assert.equal((await inspectDraft(root, "privacy", { readPolicy: policy })).exit, 2, `${policy} is not a read policy`);
  assert.equal(cli(root, "sova-spec-draft.mjs", ["check", "privacy"]).stdout, expected.stdout, "the API cannot bleed into the standalone CLI");
});

test("the reader takes default and review only, and has no source-hash capture", (t) => {
  const root = fixture(t);
  assert.equal(createInspection(root, { readPolicy: "assessment" }).check().exit, 2, "assessment is not a read policy");
  assert.equal(createInspection(root, { readPolicy: "review" }).check().exit, createInspection(root).check().exit);
  assert.equal(createInspection(root).sourceHashes, undefined);
  assert.equal(cli(root, "sova-spec.mjs", ["check", "--read-policy", "assessment"]).out.exit, 2, "the CLI accepts review only");
});
