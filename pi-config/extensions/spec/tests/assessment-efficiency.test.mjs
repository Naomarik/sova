// Independent prior CLI source expectations, never generated from the new reader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInspection } from "../core/sova-spec.mjs";
import { inspectDraft } from "../core/sova-spec-draft.mjs";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "../core");
const PRIOR = join(ROOT, ".sova/spec/drafts/spec-change-assessments/attachments/efficiency-prior");
const write = (root, p, v) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), v); };
const sha = (s) => createHash("sha256").update(s).digest("hex");
function mutateAfterGraphRead(root, path, before, after, duplicate = false) {
  const hook = join(root, "graph-mutation.cjs"), target = join(root, path), log = join(root, "graph-mutation.json");
  writeFileSync(hook, `const fs=require('node:fs'); const {syncBuiltinESMExports}=require('node:module'); const {createHash}=require('node:crypto'); const fds=new Map(); const open=fs.openSync,read=fs.readFileSync,write=fs.writeFileSync;let changed=false;
fs.openSync=function(p,...args){const fd=open.call(this,p,...args);fds.set(fd,String(p));return fd;};
fs.readFileSync=function(p,...args){const b=read.call(this,p,...args);if(!changed&&fds.get(p)===${JSON.stringify(target)}){changed=true;const next=b.toString().replace(${JSON.stringify(before)},${JSON.stringify(after)});write(${JSON.stringify(target)},next);write(${JSON.stringify(log)},JSON.stringify({returnedSha:createHash('sha256').update(b).digest('hex'),currentSha:createHash('sha256').update(next).digest('hex')}));}return b;};
${duplicate ? `const list=fs.readdirSync;fs.readdirSync=function(p,...args){const names=list.call(this,p,...args);return String(p)===${JSON.stringify(dirname(target))}?[...names,${JSON.stringify(path.split("/").at(-1))}]:names;};` : ""}
syncBuiltinESMExports();`);
  return { hook, log };
}
function mutateAfterDraftRead(root, path, before, after) {
  const hook = join(root, "draft-mutation.cjs"), target = join(root, path), log = join(root, "draft-mutation.json");
  writeFileSync(hook, `const fs=require('node:fs'),fp=require('node:fs/promises');const {syncBuiltinESMExports}=require('node:module');const {createHash}=require('node:crypto');const open=fp.open;let changed=false;
fp.open=async function(p,...args){const fh=await open.call(this,p,...args);if(String(p)===${JSON.stringify(target)}){const read=fh.readFile;fh.readFile=async function(...a){const b=await read.call(this,...a);if(!changed){changed=true;const next=b.toString().replace(${JSON.stringify(before)},${JSON.stringify(after)});fs.writeFileSync(${JSON.stringify(target)},next);fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({returnedSha:createHash('sha256').update(b).digest('hex'),currentSha:createHash('sha256').update(next).digest('hex')}));}return b;};}return fh;};syncBuiltinESMExports();`);
  return { hook, log };
}
function contentObserver(root, path) {
  const hook = join(root, "content-observer.cjs"), log = join(root, "content-observer.jsonl"), target = join(root, path);
  writeFileSync(hook, `const fs=require('node:fs');const {syncBuiltinESMExports}=require('node:module');const fds=new Map(),open=fs.openSync,append=fs.appendFileSync;
fs.openSync=function(p,...a){const fd=open.call(this,p,...a);fds.set(fd,String(p));return fd;};
for(const op of ['readFileSync','readSync']){const original=fs[op];fs[op]=function(p,...a){if((typeof p==='number'?fds.get(p):String(p))===${JSON.stringify(target)})append(${JSON.stringify(log)},JSON.stringify({op,target:${JSON.stringify(path)}})+'\\n');return original.call(this,p,...a);};}
const fp=require('node:fs/promises'),promiseOpen=fp.open;fp.open=async function(p,...a){const fh=await promiseOpen.call(this,p,...a);if(String(p)===${JSON.stringify(target)}){const read=fh.readFile;fh.readFile=async function(...args){append(${JSON.stringify(log)},JSON.stringify({op:'promise.readFile',target:${JSON.stringify(path)}})+'\\n');return read.call(this,...args);};}return fh;};syncBuiltinESMExports();`);
  return { hook, log, events: () => { try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } }, clear: () => rmSync(log, { force: true }) };
}
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
  write(root, ".gitignore", ".sova/spec/assessments/\n");
  git(root, "init", "-b", "main"); git(root, "add", "."); git(root, "commit", "-m", "fixed graph");
  return root;
}
function draftFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "spec-triage-binding-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  write(root, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, boundary: { include: ["lib"], exclude: [] }, claims: {
    "§fixture/limit": { kind: "behavior", requires: [], code: ["lib/limit.mjs"] },
    "§design/limit": { kind: "behavior", requires: [], code: ["lib/display.mjs"] },
  } }));
  write(root, ".sova/spec/claims/fixture/limit.md", "# §fixture/limit\n\nWarnings begin at ≥80%.\n");
  write(root, ".sova/spec/claims/design/limit.md", "# §design/limit\n\nWarnings begin at ≥80%.\n");
  write(root, ".sova/spec/claims/extra/triage-data.txt", "unmapped tree input\n");
  write(root, "lib/limit.mjs", "export const threshold=80;\n"); write(root, "lib/display.mjs", "export const display=true;\n");
  write(root, ".gitignore", ".sova/spec/assessments/\n.sova/spec/drafts/\n");
  git(root, "init", "-b", "main"); git(root, "add", "."); git(root, "commit", "-m", "fixed triage graph");
  assert.equal(cli(root, "sova-spec-draft.mjs", ["new", "change", "--write"]).out.exit, 0);
  const path = ".sova/spec/drafts/change/spec/claims/fixture/limit.md";
  write(root, path, readFileSync(join(root, path), "utf8").replace("80%", "90%"));
  write(root, "lib/limit.mjs", "export const threshold=90;\n");
  return { root, path };
}
function cli(root, file, args, dir = CORE, flags = [], env = {}) {
  const r = spawnSync(process.execPath, [...flags, join(dir, file), ...args, "--root", root, "--json"], { encoding: "utf8", timeout: 60000, env: { ...process.env, ...env } });
  assert.ifError(r.error); const out = JSON.parse(r.stdout); assert.equal(r.status, out.exit); return { out, stdout: r.stdout, stderr: r.stderr };
}
const assess = (root, dir = CORE, args = []) => cli(root, "sova-spec-assess.mjs", ["prepare", "comparison", ...args], dir).out;

// The private slow snapshot supplements these controls when available; the committed historical
// legacy-envelope fixture remains the always-available standalone compatibility oracle.
let priorAvailable = false;
try {
  priorAvailable = sha(readFileSync(join(PRIOR, "sova-spec-assess.mjs"))) === "2cdea41e4a0b47d245c241c4ca6e9451e75c6e8e8be8f6917f9fb38e03580b33" &&
    sha(readFileSync(join(PRIOR, "sova-spec.mjs"))) === "d2b5a47d8d4c9767adbe4ce4e2f49582bc9767a6ea6804d8c0182f2687e7b90f";
} catch { /* explicit skip, never regenerate a personal expectation */ }

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
  const sources = reader.sourceHashes(), original = sources.files[0].sha256;
  sources.files[0].sha256 = "consumer mutation"; sources.files.push({ path: "invented", sha256: "bad" });
  assert.equal(reader.sourceHashes().files[0].sha256, original); assert.equal(reader.sourceHashes().conflict, false);
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

test("each fresh capture observes changed input state instead of sharing a previous graph/refusal snapshot", (t) => {
  const root = fixture(t); const before = createInspection(root, { readPolicy: "review" }).scope("§app.top/rule");
  const p = ".sova/spec/claims/app/top.md"; write(root, p, readFileSync(join(root, p), "utf8").replace("80%", "90%"));
  const after = createInspection(root, { readPolicy: "review" }).scope("§app.top/rule");
  assert.notEqual(after.passages[0].text, before.passages[0].text);
  rmSync(join(root, "legacy.md")); symlinkSync(join(root, "lib/rule.bin"), join(root, "legacy.md"));
  assert.equal(createInspection(root, { readPolicy: "review" }).scope("§dep/rule").passages[0].provenance.entries[0].state, "refused");
});

test("graph source metadata hashes exact raw bytes, not decoded/reencoded claim text", (t) => {
  const root = fixture(t), path = ".sova/spec/claims/app/top.md";
  const raw = Buffer.concat([Buffer.from(readFileSync(join(root, path), "utf8").replaceAll("\n", "\r\n")), Buffer.from([255]), Buffer.from(" raw tail\r\n")]);
  write(root, path, raw);
  assert.notEqual(sha(raw), sha(raw.toString("utf8")), "invalid UTF8 makes reencoded-text hashing detectably different");
  const reader = createInspection(root, { readPolicy: "review" }), source = reader.sourceHashes().files.find(f => f.path === path);
  assert.equal(source.sha256, sha(raw));
  const captured = assess(root, CORE, ["--id", "§app.top/rule"]); assert.equal(captured.exit, 0);
  assert.equal(captured.inputs.find(i => i.path === path).sha256, source.sha256);
});

test("one capture refuses parent-orientation-only mutation after constructor read instead of binding its old graph to new bytes", (t) => {
  const root = fixture(t); write(root, "lib/rule.bin", "changed implementation\n");
  const control = assess(root), own = control.candidates.find(c => c.id === "§app.top/rule").textSha256;
  const path = ".sova/spec/claims/app/top.md", watcher = mutateAfterGraphRead(root, path, "Orientation.", "Changed parent orientation.");
  const run = spawnSync(process.execPath, ["--require", watcher.hook, join(CORE, "sova-spec-assess.mjs"), "prepare", "racing", "--root", root, "--json"], { encoding: "utf8" });
  const observed = JSON.parse(readFileSync(watcher.log)); assert.notEqual(observed.returnedSha, observed.currentSha, "controlled mutation happened after exact graph bytes were returned");
  const quiet = assess(root); assert.equal(quiet.exit, 0); assert.equal(quiet.candidates.find(c => c.id === "§app.top/rule").textSha256, own, "child promise unchanged: this control cannot be accidentally satisfied by own-prose hash changes");
  const raced = JSON.parse(run.stdout); assert.equal(raced.exit, run.status); assert.equal(raced.exit, 1, "mixed graph and bound source bytes must refuse"); assert.equal(raced.findings[0].code, "race");
});

test("conflicting repeated graph reads are flagged without overwriting the first raw hash", (t) => {
  const root = fixture(t), path = ".sova/spec/claims/app/top.md", watcher = mutateAfterGraphRead(root, path, "Orientation.", "Changed parent orientation.", true);
  const source = `import {createInspection} from ${JSON.stringify(new URL("../core/sova-spec.mjs", import.meta.url).href)}; process.stdout.write(JSON.stringify(createInspection(${JSON.stringify(root)},{readPolicy:'review'}).sourceHashes()));`;
  const run = spawnSync(process.execPath, ["--require", watcher.hook, "--input-type=module", "-e", source], { encoding: "utf8" });
  assert.equal(run.status, 0); const hashes = JSON.parse(run.stdout), reads = hashes.files.filter(f => f.path === path);
  assert.equal(hashes.conflict, true); assert.equal(reads.length, 2); assert.notEqual(reads[0].sha256, reads[1].sha256);
  const observed = JSON.parse(readFileSync(watcher.log)); assert.equal(reads[0].sha256, observed.returnedSha); assert.equal(reads[1].sha256, observed.currentSha);
});

test("one capture refuses manifest mutation after its graph bytes were returned", (t) => {
  const root = fixture(t); write(root, "lib/rule.bin", "changed implementation\n");
  const path = ".sova/spec/manifest.json", watcher = mutateAfterGraphRead(root, path, '"authority":"accepted"', '"authority":"candidate"');
  const run = spawnSync(process.execPath, ["--require", watcher.hook, join(CORE, "sova-spec-assess.mjs"), "prepare", "racing", "--root", root, "--json"], { encoding: "utf8" });
  const observed = JSON.parse(readFileSync(watcher.log)); assert.notEqual(observed.returnedSha, observed.currentSha);
  const raced = JSON.parse(run.stdout); assert.equal(raced.exit, run.status); assert.equal(raced.exit, 1); assert.equal(raced.findings[0].code, "race");
});

test("assessment policy rejects its STORE incumbent before contents while ordinary/review policies stay historical and isolated", (t) => {
  const root = fixture(t), path = ".sova/spec/assessments/context/receipt-context.md", body = "PRIVATE_STORE_SENTINEL";
  write(root, path, body + "\n"); const mf = ".sova/spec/manifest.json", m = JSON.parse(readFileSync(join(root, mf)));
  m.claims["§dep/rule"].incumbent = [{ file: path, lines: [1, 1], spanSha256: sha(body) }]; write(root, mf, JSON.stringify(m));
  const observer = contentObserver(root, path);
  const ordinary = cli(root, "sova-spec.mjs", ["scope", "§dep/rule", "--read-policy", "review"], CORE, ["--require", observer.hook]);
  assert.equal(ordinary.out.passages[0].provenance.entries[0].state, "current-equal"); assert.ok(observer.events().length > 0, "calibration sees actual legacy content reads, not just a declared present path");
  observer.clear();
  const captured = cli(root, "sova-spec-assess.mjs", ["prepare", "store", "--id", "§dep/rule"], CORE, ["--require", observer.hook]).out;
  assert.equal(captured.exit, 0); assert.equal(captured.inputs.find(i => i.path === path).state, "refused"); assert.ok(captured.unknowns.some(u => u.path === path));
  assert.deepEqual(observer.events(), [], "refused STORE contents are never opened/read just to hash provenance"); assert.doesNotMatch(JSON.stringify(captured), /PRIVATE_STORE_SENTINEL/);
  const review = createInspection(root, { readPolicy: "review" }), assessment = createInspection(root, { readPolicy: "assessment" }), defaultReader = createInspection(root);
  const stateOf = r => r.scope("§dep/rule").passages[0].provenance.entries[0].state;
  assert.equal(stateOf(assessment), "refused"); assert.equal(stateOf(review), "current-equal"); assert.equal(stateOf(defaultReader), "current-equal"); assert.equal(stateOf(assessment), "refused");
  assert.throws(() => assessment.scope({ toString() { throw new Error("controlled policy exception"); } }));
  assert.equal(stateOf(review), "current-equal"); assert.equal(stateOf(defaultReader), "current-equal");
  const excludedGraph = createInspection(root, { spec: ".sova/spec/assessments/context", readPolicy: "assessment" }); assert.equal(excludedGraph.check().exit, 2);
  assert.equal(stateOf(review), "current-equal");
});

test("draft API is check-only, silent, default-byte-equivalent and propagates assessment policy through nested triage", async (t) => {
  const root = fixture(t), path = ".sova/spec/assessments/context/receipt-context.md", body = "PRIVATE_DRAFT_STORE_SENTINEL";
  write(root, path, body + "\n"); const mf = ".sova/spec/manifest.json", m = JSON.parse(readFileSync(join(root, mf)));
  m.claims["§dep/rule"].incumbent = [{ file: path, lines: [1, 1], spanSha256: sha(body) }]; write(root, mf, JSON.stringify(m));
  assert.equal(cli(root, "sova-spec-draft.mjs", ["new", "privacy", "--write"]).out.exit, 0);
  const expected = cli(root, "sova-spec-draft.mjs", ["check", "privacy"]);
  assert.equal(JSON.stringify(await inspectDraft(root, "privacy"), null, 2) + "\n", expected.stdout);
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `process.exitCode=7; await import(${JSON.stringify(new URL("../core/sova-spec-draft.mjs", import.meta.url).href)});process.stdout.write(String(process.exitCode));`], { encoding: "utf8" });
  assert.equal(imported.status, 7); assert.equal(imported.stdout, "7"); assert.equal(imported.stderr, "");
  const alias = join(root, "trusted-draft-core"); symlinkSync(CORE, alias);
  const linked = cli(root, "sova-spec-draft.mjs", ["check", "privacy"], alias, ["--preserve-symlinks-main", "--preserve-symlinks"]);
  assert.equal(linked.stdout, expected.stdout); assert.equal(linked.stderr, expected.stderr);
  const observer = contentObserver(root, path);
  const observedEnv = { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${observer.hook}`.trim() };
  const ordinary = cli(root, "sova-spec-draft.mjs", ["check", "privacy"], CORE, [], observedEnv);
  assert.ok(observer.events().length > 0, "ordinary draft control really reaches the incumbent content"); assert.equal(ordinary.stdout, expected.stdout);
  observer.clear();
  const captured = cli(root, "sova-spec-assess.mjs", ["prepare", "draft-store", "--draft", "privacy", "--id", "§dep/rule"], CORE, [], observedEnv).out;
  assert.equal(captured.exit, 0); assert.equal(captured.inputs.find(i => i.path === path).state, "refused"); assert.deepEqual(observer.events(), [], "ALL nested draft graph checks share assessment pre-read policy");
  assert.doesNotMatch(JSON.stringify(captured), /PRIVATE_DRAFT_STORE_SENTINEL/);
  await inspectDraft(root, "privacy", { readPolicy: "assessment" });
  assert.equal(cli(root, "sova-spec-draft.mjs", ["check", "privacy"]).stdout, expected.stdout, "assessment API cannot bleed into standalone default CLI");
  assert.equal((await inspectDraft(root, "privacy", { readPolicy: "invalid" })).exit, 2);
  assert.equal(cli(root, "sova-spec-draft.mjs", ["check", "privacy"]).stdout, expected.stdout);
});

test("assessment draft triage refuses a STORE current claim-tree before async contents despite a safe selected proposed graph", async (t) => {
  const { root } = draftFixture(t), path = ".sova/spec/assessments/canonical/source.md", sentinel = "PRIVATE_CURRENT_TREE_STORE_SENTINEL";
  write(root, path, "# §fixture/limit\n\n" + sentinel + "\n");
  const mf = ".sova/spec/manifest.json", m = JSON.parse(readFileSync(join(root, mf)));
  m.grammar = { claimsRoot: "assessments/canonical" }; write(root, mf, JSON.stringify(m));
  const observer = contentObserver(root, path), observedEnv = { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${observer.hook}`.trim() };
  cli(root, "sova-spec.mjs", ["check"], CORE, [], observedEnv);
  assert.ok(observer.events().some(e => e.op === "readFileSync"), "ordinary core really reads the same STORE graph via a sync FD");
  observer.clear();
  const ordinary = cli(root, "sova-spec-draft.mjs", ["check", "change"], CORE, [], observedEnv);
  assert.ok(observer.events().some(e => e.op === "promise.readFile"), "ordinary draft really reads the current tree via an async FD");
  observer.clear();
  const review = await inspectDraft(root, "change", { readPolicy: "review" });
  assert.equal(review.exit, ordinary.out.exit, "internal review/default policies are not tightened");
  const captured = cli(root, "sova-spec-assess.mjs", ["prepare", "current-store", "--spec", ".sova/spec/drafts/change/spec", "--draft", "change", "--write"], CORE, [], observedEnv).out;
  assert.equal(captured.exit, 2); assert.equal(captured.findings[0].code, "draft-untrusted");
  assert.deepEqual(observer.events(), [], "receipt-store current tree is refused before contents, not by a late hash race");
  assert.doesNotMatch(JSON.stringify(captured), /PRIVATE_CURRENT_TREE_STORE_SENTINEL/);
  assert.throws(() => readFileSync(join(root, ".sova/spec/assessments/current-store/packet.json")), { code: "ENOENT" });
  const meta = await inspectDraft(root, "change", { readPolicy: "assessment" });
  assert.equal(meta.inputSources.find(s => s.path === path).state, "refused");
  assert.equal(cli(root, "sova-spec-draft.mjs", ["check", "change"]).stdout, ordinary.stdout, "default standalone output remains unchanged after assessment policy");
});

test("draft triage binds proposed sources even when quantities change without changing candidate identities or reasons", async (t) => {
  const { root, path } = draftFixture(t);
  const first = cli(root, "sova-spec-assess.mjs", ["prepare", "before", "--draft", "change", "--write"]).out;
  assert.equal(first.exit, 0); assert.equal(first.written, true);
  assert.equal(first.query.spec, ".sova/spec", "draft triage is independent of selected canonical graph");
  assert.ok(first.candidates.find(c => c.id === "§design/limit")?.reasons.some(r => r.route === "heuristic-restatement" && r.of === "§fixture/limit"));
  assert.equal(first.inputs.find(i => i.path === path).sha256, sha(readFileSync(join(root, path))));
  assert.equal(cli(root, "sova-spec-assess.mjs", ["status", "before"]).out.applicability, "current");
  const packet = readFileSync(join(root, first.packet)), canonical = readFileSync(join(root, ".sova/spec/claims/fixture/limit.md")), state = readFileSync(join(root, ".sova/spec/drafts/change/draft.json"));
  write(root, path, readFileSync(join(root, path), "utf8").replace("90%", "95%"));
  const second = cli(root, "sova-spec-assess.mjs", ["prepare", "middle", "--draft", "change", "--write"]).out;
  assert.equal(second.exit, 0); assert.deepEqual(second.candidates, first.candidates, "cannot pass merely because routing changed");
  assert.notEqual(second.fingerprint, first.fingerprint);
  assert.deepEqual(readFileSync(join(root, ".sova/spec/claims/fixture/limit.md")), canonical);
  assert.deepEqual(readFileSync(join(root, ".sova/spec/drafts/change/draft.json")), state);
  assert.deepEqual(readFileSync(join(root, first.packet)), packet, "old metadata receipt stays immutable");
  assert.equal(cli(root, "sova-spec-assess.mjs", ["status", "before"]).out.applicability, "stale");
  const mf = ".sova/spec/drafts/change/spec/manifest.json", m = JSON.parse(readFileSync(join(root, mf)));
  m.description = "Changed proposed metadata, same candidates"; write(root, mf, JSON.stringify(m));
  const third = cli(root, "sova-spec-assess.mjs", ["prepare", "manifest", "--draft", "change", "--write"]).out;
  assert.equal(third.exit, 0); assert.deepEqual(third.candidates, second.candidates); assert.notEqual(third.fingerprint, second.fingerprint);
  assert.equal(cli(root, "sova-spec-assess.mjs", ["status", "middle"]).out.applicability, "stale");
  const extra = ".sova/spec/drafts/change/spec/claims/extra/triage-data.txt";
  assert.ok(third.inputs.find(i => i.path === extra)?.roles.includes("draft-triage"), "readTree inputs need not be declarations");
  write(root, extra, "changed unmapped tree input\n");
  assert.equal(cli(root, "sova-spec-assess.mjs", ["status", "manifest"]).out.applicability, "stale");
  const meta = await inspectDraft(root, "change", { readPolicy: "assessment" });
  assert.ok(meta.inputSources.some(s => s.path === path && s.sha256 === sha(readFileSync(join(root, path)))));
  meta.inputSources[0].sha256 = "consumer mutation";
  assert.notEqual((await inspectDraft(root, "change", { readPolicy: "assessment" })).inputSources[0].sha256, "consumer mutation");
  assert.equal((await inspectDraft(root, "change")).inputSources, undefined, "default API shape is unchanged");
});

test("draft triage preserves conflicting repeated parsed versions instead of binding later bytes to an earlier parse", async (t) => {
  const { root, path } = draftFixture(t), observer = mutateAfterGraphRead(root, path, "90%", "95%", true);
  const raw = spawnSync(process.execPath, ["--require", observer.hook, "--input-type=module", "-e", `const {inspectDraft}=await import(${JSON.stringify(new URL("../core/sova-spec-draft.mjs", import.meta.url).href)}); console.log(JSON.stringify(await inspectDraft(${JSON.stringify(root)},'change',{readPolicy:'assessment'})));`], { encoding: "utf8" });
  assert.equal(raw.status, 0, raw.stderr); const meta = JSON.parse(raw.stdout), observed = JSON.parse(readFileSync(observer.log));
  assert.notEqual(observed.returnedSha, observed.currentSha);
  const versions = meta.inputSources.filter(s => s.path === path).map(s => s.sha256);
  assert.ok(versions.includes(observed.returnedSha)); assert.ok(versions.includes(observed.currentSha), "retain both actual parse versions");
  write(root, path, readFileSync(join(root, path), "utf8").replace("95%", "90%"));
  const failed = cli(root, "sova-spec-assess.mjs", ["prepare", "race", "--draft", "change", "--write"], CORE, ["--require", observer.hook]).out;
  assert.equal(failed.exit, 1); assert.equal(failed.findings[0].code, "race");
  assert.throws(() => readFileSync(join(root, ".sova/spec/assessments/race/packet.json")), { code: "ENOENT" });
});

test("draft triage rejects a mutation after an actual async FD read before source binding", (t) => {
  const { root, path } = draftFixture(t), observer = mutateAfterDraftRead(root, path, "90%", "95%");
  const failed = cli(root, "sova-spec-assess.mjs", ["prepare", "async-race", "--draft", "change", "--write"], CORE, ["--require", observer.hook]).out;
  const observed = JSON.parse(readFileSync(observer.log)); assert.notEqual(observed.returnedSha, observed.currentSha, "actual returned bytes precede the mutation");
  assert.equal(failed.exit, 1); assert.equal(failed.findings[0].code, "race");
  assert.throws(() => readFileSync(join(root, ".sova/spec/assessments/async-race/packet.json")), { code: "ENOENT" });
});

test("fixed slow-source capture oracle: complete binary and unusual paths/tree/link baselines remain exact", { skip: !priorAvailable && "private frozen slow-source snapshot unavailable" }, (t) => {
  const root = fixture(t), p = ".sova/spec/manifest.json", m = JSON.parse(readFileSync(join(root, p)));
  const unusual = ["lib/漢🙂.bin", "lib/tab\tname", "lib/new\nline", "check-ignore", ":(top)literal"];
  for (const name of unusual) write(root, name, Buffer.from([0, 255, 10, 128, 42]));
  mkdirSync(join(root, "lib/directory")); write(root, "lib/directory/child", "child\n");
  symlinkSync("rule.bin", join(root, "lib/symlink"));
  m.claims["§app.top/rule"].code.push(...unusual, "lib/directory", "lib/directory/child", "lib/symlink", "lib/gitlink", "lib/truly-absent");
  write(root, p, JSON.stringify(m)); git(root, "add", "."); git(root, "commit", "-m", "immutable binary and modes");
  const oid = git(root, "rev-parse", "HEAD"); git(root, "update-index", "--add", "--cacheinfo", `160000,${oid},lib/gitlink`); git(root, "commit", "-m", "dummy gitlink");
  write(root, "lib/rule.bin", Buffer.from([0, 10, 254, 128, 2]));
  const a = assess(root, PRIOR), b = assess(root);
  assert.deepEqual(b, a, "old source supplies exact full capture/fingerprint, not new implementation expectation");
  const input = (path) => b.inputs.find(i => i.path === path).baseline;
  for (const path of ["lib/directory", "lib/symlink", "lib/gitlink"]) assert.deepEqual(input(path), { source: "git-commit", state: "refused", why: "baseline is not a regular blob" });
  assert.equal(input("lib/truly-absent").state, "absent"); assert.equal(input("lib/directory/child").sha256, sha("child\n"));
  for (const name of unusual) assert.equal(input(name).sha256, sha(Buffer.from([0, 255, 10, 128, 42])));
});

test("fixed slow-source capture oracle: oversize/credential/hardlink refusals and declared dirty baselines survive batching", { skip: !priorAvailable && "private frozen slow-source snapshot unavailable" }, (t) => {
  const root = fixture(t), p = ".sova/spec/manifest.json", m = JSON.parse(readFileSync(join(root, p)));
  write(root, "lib/oversize", "x".repeat(2 * 1024 * 1024 + 1)); write(root, ".env", "PRIVATE_CREDENTIAL_SENTINEL");
  m.claims["§app.top/rule"].code.push("lib/oversize", ".env"); write(root, p, JSON.stringify(m)); git(root, "add", "."); git(root, "commit", "-m", "refused fixture inputs");
  linkSync(join(root, "lib/rule.bin"), join(root, "lib/alias"));
  const args = ["--id", "§app.top/rule", "--baseline-json", JSON.stringify({ inputs: [{ path: "lib/rule.bin", state: "refused", why: "task initial input unknown" }] })];
  const a = assess(root, PRIOR, args), b = assess(root, CORE, args); assert.deepEqual(b, a);
  assert.equal(b.inputs.find(i => i.path === "lib/oversize").baseline.why, "baseline unavailable or oversize");
  assert.equal(b.inputs.find(i => i.path === ".env").baseline.why, "unsafe baseline path");
  assert.equal(b.inputs.find(i => i.path === "lib/rule.bin").baseline.source, "declared-snapshot");
  assert.doesNotMatch(JSON.stringify(b), /PRIVATE_CREDENTIAL_SENTINEL/);
});
