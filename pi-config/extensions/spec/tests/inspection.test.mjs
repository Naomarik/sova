// Inspection regressions assert forbidden effects in disposable fixtures, not only refusal exits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, linkSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "../core/sova-spec.mjs");
const REVIEW = resolve(dirname(CORE), "sova-spec-review.mjs");
const roots = [];
process.on("exit", () => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const tmp = () => { const r = mkdtempSync(join(tmpdir(), "spec-inspection-")); roots.push(r); return r; };
function write(root, rel, text) { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }
const envOf = (root) => ({ ...process.env, HOME: root, XDG_CONFIG_HOME: root });
function git(root, ...args) {
  const r = spawnSync("git", ["-c", "core.fsmonitor=false", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-C", root, ...args], { encoding: "utf8", env: envOf(root) });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
}
function project(extra = {}) {
  const root = tmp();
  write(root, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, claims: { "§a/top": { kind: "behavior", requires: [], code: ["src/a.txt"] } }, boundary: { include: ["src"], exclude: [] }, ...extra }));
  write(root, ".sova/spec/claims/a/top.md", "# §a/top\n\nA dummy requirement.\n");
  write(root, "src/a.txt", "before\n"); return root;
}
function repo(extra) { const root = project(extra); git(root, "init", "-q"); git(root, "add", "."); git(root, "commit", "-qm", "fixture"); return root; }
function run(root, cli, args, env = {}) {
  const r = spawnSync(process.execPath, [cli, ...args, "--root", root, "--json"], { encoding: "utf8", env: { ...envOf(root), ...env } });
  const j = JSON.parse(r.stdout); assert.equal(r.status, j.exit, r.stderr); return j;
}
const has = (j, code) => assert.ok(j.findings.some((f) => f.code === code), JSON.stringify(j));
function observe(root, watched, denyOpen) {
  const hookRoot = tmp(), hook = join(hookRoot, "observe.mjs"), log = join(hookRoot, "reads.jsonl");
  writeFileSync(hook, `import fs from 'node:fs'; import fsp from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
const watched=JSON.parse(process.env.INSPECT_WATCH), log=process.env.INSPECT_LOG, append=fs.appendFileSync.bind(fs), readlink=fs.readlinkSync.bind(fs);
function pathOf(p){ if(typeof p==='number'){try{return readlink('/proc/self/fd/'+p)}catch{return ''}} return String(p); }
function hit(op,p){p=pathOf(p); if(watched.some(w=>p===w||p.startsWith(w+'/'))) append(log,JSON.stringify({op,path:p})+'\\n'); }
for(const key of ['readFileSync','readdirSync','openSync']){const fn=fs[key];fs[key]=function(p,...a){hit(key,p);if(key==='openSync'&&pathOf(p)===process.env.INSPECT_DENY)throw Object.assign(new Error('fixture EACCES'),{code:'EACCES'});return fn.call(this,p,...a)};}
const open=fsp.open; fsp.open=async function(p,...a){hit('open',p);const fh=await open.call(this,p,...a), read=fh.readFile.bind(fh);fh.readFile=(...x)=>{hit('readFile',p);return read(...x)};return fh}; syncBuiltinESMExports();`);
  return { env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${hook}`, INSPECT_WATCH: JSON.stringify(watched), INSPECT_LOG: log, ...(denyOpen ? { INSPECT_DENY: denyOpen } : {}) }, events: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [], reset: () => rmSync(log, { force: true }) };
}

test("configured unused clean/process driver permits ordinary working-tree census", () => {
  const root = repo();
  git(root, "config", "filter.unused.clean", "dummy-command-not-to-execute");
  git(root, "config", "filter.unused.process", "dummy-process-not-to-execute");
  git(root, "config", "filter.unspecified.clean", "dummy-sentinel-command-not-to-execute");
  write(root, "src/a.txt", "after\n");
  const j = run(root, CORE, ["census", "--changed"]);
  assert.equal(j.exit, 0); assert.equal(j.census.claimed[0].path, "src/a.txt");
});

for (const [kind, driver] of [["clean", "fixture"], ["process", "fixture"], ["clean", "set"], ["clean", "unset"], ["clean", "unspecified"]]) test(`attribute-selected ${driver} ${kind} filter refused before execution`, () => {
  const root = repo(); const helperRoot = tmp(), marker = join(helperRoot, "executed"), script = join(helperRoot, "filter.cjs");
  writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran'); process.stdin.pipe(process.stdout);`);
  write(root, ".gitattributes", `src/a.txt filter=${driver}\n`);
  git(root, "add", ".gitattributes"); git(root, "commit", "-qm", "attributes");
  git(root, "config", `filter.${driver}.${kind}`, `${process.execPath} ${script}`);
  write(root, "src/a.txt", "after\n");
  // Positive control on the clean driver proves this fixture really executes through raw Git diff.
  if (kind === "clean") { git(root, "diff", "--name-only", "HEAD"); assert.ok(existsSync(marker)); rmSync(marker); }
  for (const args of [["census", "--changed"], ["foreign", "--base", "HEAD", "--landing"]]) {
    const j = run(root, CORE, args); assert.equal(j.exit, 2); has(j, "git-filter-refused"); assert.ok(!existsSync(marker), "configured script never ran");
    assert.ok(!JSON.stringify(j).includes(script), "configured command values not disclosed");
  }
});

test("invalid claimsRoot never enumerates or reads outside declarations", () => {
  const outer = tmp(), root = join(outer, "project"), outside = join(outer, "outside"); mkdirSync(root);
  write(root, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, grammar: { claimsRoot: "../../../outside" }, claims: { "§a/top": { kind: "note" } } }));
  write(outside, "a/top.md", "# §a/top\n\nDUMMY OUTSIDE.\n");
  const spy = observe(root, [outside]);
  for (const args of [["check"], ["scope", "§a/top"], ["census"], ["census", "--changed"]]) {
    const j = run(root, CORE, args, spy.env); assert.equal(j.exit, 2); has(j, "grammar-invalid"); assert.deepEqual(spy.events(), []);
    assert.ok(!JSON.stringify(j).includes("DUMMY OUTSIDE"));
  }
});

for (const mode of ["secret", "hardlink", "oversize"]) test(`review policy prevents ${mode} incumbent contents in both captures and rechecks`, () => {
  const root = project(), rel = mode === "secret" ? ".env" : "docs/incumbent.txt", text = mode === "oversize" ? "x".repeat(2 * 1024 * 1024 + 1) : "DUMMY INCUMBENT\n";
  write(root, rel, text);
  if (mode === "hardlink") linkSync(join(root, rel), join(tmp(), "alias"));
  const m = JSON.parse(readFileSync(join(root, ".sova/spec/manifest.json"), "utf8"));
  m.claims["§a/top"].incumbent = [{ file: rel, lines: [1, 1], hash: createHash("sha256").update(text.trimEnd()).digest("hex") }];
  write(root, ".sova/spec/manifest.json", JSON.stringify(m));
  const spy = observe(root, [join(root, rel)]);
  if (mode === "secret") { assert.equal(run(root, CORE, ["scope", "§a/top"], spy.env).exit, 0); assert.ok(spy.events().some((e) => e.op === "readFileSync"), "positive control: observer sees allowed default core incumbent contents"); spy.reset(); }
  const p = run(root, REVIEW, ["prepare", "§a/top", "--name", "p", "--write"], spy.env);
  assert.equal(p.exit, 0); assert.equal(p.inputs.find((i) => i.path === rel).state, "refused"); assert.deepEqual(spy.events(), [], "neither core nor capture opened/read refused incumbent");
  assert.equal(run(root, REVIEW, ["record", "p", "--by", "fixture", "--conclusion", "unresolved", "--note", "refused dummy input"], spy.env).exit, 0);
  assert.equal(run(root, REVIEW, ["status", "p"], spy.env).exit, 1); assert.deepEqual(spy.events(), []);
});

for (const location of ["include", "exclude"]) test(`invalid ${location} boundary rejected by full and changed census before traversal`, () => {
  const outside = tmp(), boundary = location === "include" ? { include: [outside], exclude: [] } : { include: ["src"], exclude: [{ path: "../outside", reason: "dummy" }] };
  const root = repo({ boundary }); write(root, "src/a.txt", "after\n");
  const spy = observe(root, [outside]);
  for (const args of [["census"], ["census", "--changed"]]) { const j = run(root, CORE, args, spy.env); assert.equal(j.exit, 2); has(j, "boundary-refused"); assert.deepEqual(spy.events(), []); }
});

test("code-only mapping checks readability without relying on provenance", () => {
  const root = project(), spy = observe(root, [], join(root, "src/a.txt"));
  const j = run(root, CORE, ["check"], spy.env); assert.equal(j.exit, 1); has(j, "code-unreadable"); assert.equal(j.code[0].state, "unreadable");
});

test("corrupt and symlinked draft inventories are explicitly incomplete", () => {
  const root = repo(), outside = tmp(); write(root, ".sova/spec/drafts/corrupt/draft.json", "{bad");
  write(outside, "draft.json", '{"evidence":[],"promotions":[]}'); symlinkSync(outside, join(root, ".sova/spec/drafts/alias"));
  const spy = observe(root, [outside]);
  const c = run(root, CORE, ["census", "--changed"], spy.env); assert.equal(c.exit, 1); has(c, "evidence-draft-unread"); assert.equal(c.census.draftScan.complete, false); assert.equal(c.census.draftScan.unread.length, 2);
  const f = run(root, CORE, ["foreign", "--base", "HEAD", "--landing"], spy.env); assert.equal(f.exit, 1); has(f, "landing-draft-unread"); assert.equal(f.complete, false); assert.ok(f.incomplete.includes("landing-draft-unread")); assert.deepEqual(f.unpromotedDrafts, []); assert.deepEqual(spy.events(), []);
});

test("capped landing draft inventory cannot be reported as exact empty", () => {
  const root = repo();
  for (let i = 0; i < 21; i++) write(root, `.sova/spec/drafts/d${String(i).padStart(2, "0")}/draft.json`, "{bad");
  const j = run(root, CORE, ["foreign", "--base", "HEAD", "--landing"]); assert.equal(j.complete, false); assert.equal(j.draftScan.scanned, 20); assert.equal(j.draftScan.capped, true); has(j, "landing-drafts-capped"); assert.ok(j.incomplete.includes("landing-drafts-capped"));
});

test("active orphan evidence is folded latest-per-ID without invalid fallback", () => {
  const root = repo(), head = git(root, "rev-parse", "HEAD"), old = "a".repeat(40);
  const evidence = [
    { mode: "commit", commit: old, ids: [{ id: "§a/top" }, { id: "§a/other" }] },
    { mode: "commit", commit: head, ids: [{ id: "§a/top" }] },
  ];
  write(root, ".sova/spec/drafts/d/draft.json", JSON.stringify({ evidence, promotions: [] }));
  const j = run(root, CORE, ["census", "--changed"]); assert.equal(j.exit, 0); assert.deepEqual(j.census.orphanedEvidence, [{ draft: "d", commit: old, ids: ["§a/other"] }]);
  evidence.push({ mode: "snapshot", ids: [{ id: "§a/other" }] });
  write(root, ".sova/spec/drafts/d/draft.json", JSON.stringify({ evidence, promotions: [] }));
  assert.deepEqual(run(root, CORE, ["census", "--changed"]).census.orphanedEvidence, []);
});
