// Independent M1 seam tests. Dummy temp projects only; no model, auth, or live state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, symlinkSync, linkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const coreDir = resolve(dirname(fileURLToPath(import.meta.url)), "../core");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const currentFile = ".sova/spec/claims/app/rule.md";
const draftDir = ".sova/spec/drafts/repair";
const oldText = "# §app/rule\n\nOld promise.\n";
const newText = "# §app/rule\n\nNew promise.\n";
function write(root, rel, value) {
  const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, value);
}
const read = (root, rel) => readFileSync(join(root, rel), "utf8");
function fixture(t, { code = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sova-m1-independent-"));
  t.after(() => { try { chmodSync(join(root, draftDir), 0o755); } catch {} rmSync(root, { recursive: true, force: true }); });
  write(root, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, boundary: { include: ["lib"], exclude: [] }, claims: {
    "§app/rule": { kind: "behavior", authority: "accepted", requires: [], ...(code ? { code: ["lib/rule.txt"] } : {}) },
  } }));
  write(root, currentFile, oldText); write(root, "lib/rule.txt", "dummy implementation\n");
  return root;
}
const hermeticEnv = (root) => ({ ...process.env, HOME: join(root, ".fixture-home"), XDG_CONFIG_HOME: join(root, ".fixture-home/config"), GIT_CONFIG_NOSYSTEM: "1" });
function run(root, tool, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [join(coreDir, `sova-spec${tool ? `-${tool}` : ""}.mjs`), ...args, "--root", root, "--json"], {
    cwd: root, encoding: "utf8", timeout: 30_000, env: { ...hermeticEnv(root), ...extraEnv },
  });
  assert.ifError(r.error);
  let j; try { j = JSON.parse(r.stdout); } catch { assert.fail(`harness: non-JSON status=${r.status}: ${r.stdout}\n${r.stderr}`); }
  assert.equal(r.status, j.exit, "CLI status and JSON exit agree"); return j;
}
const draft = (root, ...args) => run(root, "draft", args);
const core = (root, ...args) => run(root, "", args);
const codes = (j) => [...(j.findings ?? []), ...(j.refusals ?? [])].map((f) => f.code);
function metadata(root, fn) {
  const p = join(root, draftDir, "draft.json"); const m = JSON.parse(readFileSync(p));
  if (fn) { fn(m); writeFileSync(p, JSON.stringify(m)); } return m;
}
function prepare(root, { unmapped = false, log = false, commit = false } = {}) {
  assert.equal(draft(root, "new", "repair", "--write").exit, 0);
  write(root, `${draftDir}/spec/claims/app/rule.md`, newText);
  if (log) write(root, "run.txt", "dummy verification log distinct from implementation\n");
  const ev = draft(root, "evidence", "repair", "--id", "§app/rule", "--by", "fixture", "--verification", "dummy verified bytes",
    ...(commit ? ["--commit", "HEAD"] : ["--snapshot"]), ...(unmapped ? ["--path", "lib/rule.txt"] : []), ...(log ? ["--log", join(root, "run.txt")] : []), "--write");
  assert.equal(ev.exit, 0, JSON.stringify(ev)); return ev;
}
function untouched(root) {
  assert.equal(read(root, currentFile), oldText, "refusal did not publish");
  assert.equal(metadata(root).promotions.length, 0, "refusal did not append a receipt");
}
function git(root, ...args) {
  const r = spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-C", root, ...args], { encoding: "utf8", timeout: 30_000, env: hermeticEnv(root) });
  assert.equal(r.status, 0, `fixture Git: ${r.stderr}`); return r.stdout.trim();
}
function initGit(root) { git(root, "init", "-b", "main"); git(root, "add", "."); git(root, "commit", "-m", "dummy baseline"); }

// Observe attempted content opens/reads and directory enumeration in both CLI and spawned core.
// The observer only records; it never blocks or changes the target command's result.
function observer(root) {
  const p = join(root, "observer.cjs"), log = join(root, "reads.jsonl");
  write(root, "observer.cjs", `const fs = require('node:fs'); const fsp = require('node:fs/promises');
const { syncBuiltinESMExports } = require('node:module'); const append = fs.appendFileSync;
const log = process.env.M1_READ_LOG; const fds=new Map(); const record = (op, p) => {
 if (typeof p==='number') p=fds.get(p);
 if (typeof p === 'string' || Buffer.isBuffer(p) || p instanceof URL) append(log, JSON.stringify({op, path:String(p)})+'\\n');
};
const originalOpen=fs.openSync; fs.openSync=function(p,...a){record('openSync',p); const fd=originalOpen.call(this,p,...a); fds.set(fd,p); return fd;};
for (const op of ['readFileSync','readdirSync','readSync','readFile','open','readdir']) { const orig=fs[op]; fs[op]=function(p,...a){record(op,p); return orig.call(this,p,...a);}; }
for (const op of ['readFile','readdir']) { const orig=fsp[op]; fsp[op]=function(p,...a){record('promises.'+op,p); return orig.call(this,p,...a);}; }
const originalAsyncOpen=fsp.open; fsp.open=async function(p,...a){record('promises.open',p); const fh=await originalAsyncOpen.call(this,p,...a); for(const op of ['readFile','read']) { const orig=fh[op]; fh[op]=function(...args){record('FileHandle.'+op,p); return orig.apply(this,args);}; } return fh;};
syncBuiltinESMExports();\n`);
  const env = { NODE_OPTIONS: `--require=${p}`, M1_READ_LOG: log };
  const accesses = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((s) => JSON.parse(s)) : [];
  const clear = () => { if (existsSync(log)) rmSync(log); };
  return { env, accesses, clear };
}
function observedPath(accesses, path) { return accesses.some((a) => a.path === path || a.path.startsWith(`${path}/`)); }
function observedContent(accesses, path) { return observedPath(accesses.filter((a) => /read(?:File|Sync)|FileHandle\.read/.test(a.op)), path); }

test("M1: receipt write failure cannot leave unrecorded, unrecoverable publication", (t) => {
  assert.notEqual(process.getuid?.(), 0, "harness: chmod failure fixture requires nonroot");
  const root = fixture(t); prepare(root); const preview = draft(root, "promote", "repair", "--id", "§app/rule");
  assert.equal(preview.exit, 0);
  chmodSync(join(root, draftDir), 0o555);
  const result = draft(root, "promote", "repair", "--id", "§app/rule", "--plan", preview.plan, "--write");
  const published = read(root, currentFile) === newText, receipted = metadata(root).promotions.length === 1;
  const recovery = draft(root, "recover");
  assert.ok(!published || receipted || recovery.pending === true, `published without receipt or recovery: ${JSON.stringify(result)}`);
  if (result.exit === 0) assert.ok(published && receipted, "success must include publication and receipt");
  chmodSync(join(root, draftDir), 0o755);
  if (recovery.pending) assert.equal(draft(root, "recover", "--write").exit, 0);
  assert.ok(read(root, currentFile) === oldText || (read(root, currentFile) === newText && metadata(root).promotions.length === 1), "recovery restores prior or fully recorded state");
  if (read(root, currentFile) === oldText) {
    const retry = draft(root, "promote", "repair", "--id", "§app/rule", "--write");
    assert.equal(retry.exit, 0, "ordinary failure is retryable after permission repair");
    assert.equal(metadata(root).promotions.length, 1); assert.equal(read(root, currentFile), newText);
  }
});

test("M1: forged input-free unmapped behavior cannot publish validly bound prose", (t) => {
  const root = fixture(t, { code: false }); prepare(root, { unmapped: true });
  assert.equal(draft(root, "promote", "repair", "--id", "§app/rule").exit, 0, "control: explicit implementation path covers unmapped claim");
  metadata(root, (m) => { m.evidence.at(-1).inputs = []; });
  for (const writeFlag of [[], ["--write"]]) {
    const result = draft(root, "promote", "repair", "--id", "§app/rule", ...writeFlag);
    assert.notEqual(result.exit, 0, "minimum implementation-input policy must be revalidated"); untouched(root);
  }
});

for (const damage of ["missing", "corrupt"]) test(`M1: ${damage} retained verification log prevents publication`, (t) => {
  const root = fixture(t); prepare(root, { log: true });
  assert.equal(draft(root, "promote", "repair", "--id", "§app/rule").exit, 0, "control: valid retained log");
  const log = metadata(root).evidence.at(-1).log; const p = join(root, draftDir, "evidence/objects", log.sha256);
  if (damage === "missing") rmSync(p); else writeFileSync(p, "wrong retained bytes\n");
  const result = draft(root, "promote", "repair", "--id", "§app/rule", "--write");
  assert.notEqual(result.exit, 0, "retained log loss/corruption cannot remain valid");
  assert.match(JSON.stringify(result), /log|retained/i); untouched(root);
});

test("M1: grammar refusal precedes outside traversal, with observer positive control", (t) => {
  const root = fixture(t); const watch = observer(root);
  assert.equal(run(root, "", ["check"], watch.env).exit, 0);
  assert.ok(observedPath(watch.accesses(), join(root, currentFile)), "observer sees legitimate claim content read");
  write(root, "outside/app/rule.md", newText);
  const m = JSON.parse(read(root, ".sova/spec/manifest.json")); m.grammar = { claimsRoot: "../../outside" };
  write(root, ".sova/spec/manifest.json", JSON.stringify(m));
  for (const [tool, args] of [["", ["check"]], ["draft", ["new", "unsafe"]], ["review", ["prepare", "§app/rule", "--name", "unsafe"]]]) {
    watch.clear(); const result = run(root, tool, args, watch.env);
    assert.notEqual(result.exit, 0, `${tool || "core"} refuses invalid grammar`);
    assert.ok(!observedPath(watch.accesses(), join(root, "outside")), `${tool || "core"} never enumerates or reads refused claimsRoot`);
  }
});

for (const placement of ["include", "exclude"]) test(`M1: invalid boundary ${placement} cannot quietly classify changed files outside`, (t) => {
  const root = fixture(t); initGit(root); write(root, "lib/rule.txt", "changed dummy implementation\n");
  const m = JSON.parse(read(root, ".sova/spec/manifest.json"));
  m.boundary[placement] = placement === "include" ? ["../outside"] : [{ path: "../outside", reason: "dummy" }];
  write(root, ".sova/spec/manifest.json", JSON.stringify(m));
  for (const args of [["census"], ["census", "--changed"]]) {
    const result = core(root, ...args); assert.notEqual(result.exit, 0, JSON.stringify(result));
    assert.ok(codes(result).some((c) => /boundary/.test(c)), "explicit boundary finding");
  }
});

for (const type of ["credential", "hardlink", "oversize"]) test(`M1: review refuses ${type} incumbent before content access`, (t) => {
  const root = fixture(t); const watch = observer(root);
  const m = JSON.parse(read(root, ".sova/spec/manifest.json"));
  const path = type === "credential" ? ".env" : "incumbent.txt";
  const text = type === "oversize" ? `${"x".repeat(2 * 1024 * 1024 + 1)}\n` : "dummy incumbent contents\n";
  write(root, path, text); if (type === "hardlink") linkSync(join(root, path), join(root, "alias.txt"));
  m.claims["§app/rule"].incumbent = [{ file: path, lines: [1, 1], spanSha256: sha(text) }];
  write(root, ".sova/spec/manifest.json", JSON.stringify(m));
  const result = run(root, "review", ["prepare", "§app/rule", "--name", "refused", "--write"], watch.env);
  assert.ok(!observedContent(watch.accesses(), join(root, path)), `refused ${type} incumbent contents were read`);
  if (type === "credential") assert.ok(!observedPath(watch.accesses(), join(root, path)), "credential incumbent was opened");
  assert.ok(JSON.stringify(result).includes("refused"), "refusal is explicit rather than silently omitted");
});

test("M1: review observer sees allowed incumbent content (negative-control calibration)", (t) => {
  const root = fixture(t); const watch = observer(root); const text = "dummy allowed provenance\n";
  write(root, "incumbent.txt", text); const m = JSON.parse(read(root, ".sova/spec/manifest.json"));
  m.claims["§app/rule"].incumbent = [{ file: "incumbent.txt", lines: [1, 1], spanSha256: sha(text) }];
  write(root, ".sova/spec/manifest.json", JSON.stringify(m));
  const result = run(root, "review", ["prepare", "§app/rule", "--name", "allowed"], watch.env);
  assert.equal(result.exit, 0); assert.ok(observedContent(watch.accesses(), join(root, "incumbent.txt")), "observer detects legitimate incumbent CONTENT read across companion/core");
});

test("M1: log parent symlink is refused without opening linked dummy bytes", (t) => {
  const root = fixture(t); assert.equal(draft(root, "new", "repair", "--write").exit, 0);
  write(root, `${draftDir}/spec/claims/app/rule.md`, newText); write(root, "external/run.txt", "dummy outside log\n");
  symlinkSync(join(root, "external"), join(root, "logs")); const watch = observer(root);
  const result = run(root, "draft", ["evidence", "repair", "--id", "§app/rule", "--by", "fixture", "--verification", "dummy",
    "--snapshot", "--log", join(root, "logs/run.txt"), "--write"], watch.env);
  assert.notEqual(result.exit, 0); assert.equal(metadata(root).evidence.length, 0);
  assert.ok(!observedPath(watch.accesses(), join(root, "logs/run.txt")) && !observedPath(watch.accesses(), join(root, "external/run.txt")), "symlinked log bytes never opened");
});

for (const [filter, driver] of ["clean", "process"].flatMap((kind) => ["m1dummy", "set", "unset", "unspecified"].map((driver) => [kind, driver]))) test(`M1: selected Git ${filter} driver ${driver} never executes during inspection`, (t) => {
  const root = fixture(t); write(root, ".gitattributes", `lib/rule.txt filter=${driver}\n`); initGit(root);
  prepare(root, { commit: true });
  const marker = join(root, "FILTER-RAN"); const script = join(root, "filter.cjs");
  write(root, "filter.cjs", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'dummy executed');\n${filter === "clean" ? "process.stdin.pipe(process.stdout);" : "process.exit(1);"}\n`);
  git(root, "config", `filter.${driver}.${filter}`, `${process.execPath} ${script}`);
  write(root, "lib/rule.txt", "changed implementation for filter probe\n");
  for (const [tool, args] of [["", ["census", "--changed"]], ["", ["foreign", "--base", "HEAD", "--landing"]], ["draft", ["check", "repair"]], ["draft", ["promote", "repair", "--id", "§app/rule"]]]) {
    run(root, tool, args); assert.ok(!existsSync(marker), `${tool || "core"} ${args[0]} ran configured ${filter} filter`);
    untouched(root);
  }
  // Deliberately invoke Git only as a calibration control after testing the product.
  spawnSync("git", ["-C", root, "diff", "--name-only"], { encoding: "utf8", timeout: 10_000, env: hermeticEnv(root) });
  assert.ok(existsSync(marker), "fixture configured filter really executes under ordinary Git diff");
});

test("M1: corrupt draft inventory is explicit incomplete, never a clean empty landing", (t) => {
  const root = fixture(t); initGit(root); write(root, ".sova/spec/drafts/corrupt/draft.json", "{ invalid dummy JSON");
  const result = core(root, "foreign", "--base", "HEAD", "--landing");
  assert.ok(codes(result).some((c) => /draft.*(unread|incomplete|corrupt)/.test(c)), `corrupt draft silently omitted: ${JSON.stringify(result)}`);
  assert.equal(result.complete, false, "landing explicitly reports incomplete inventory");
  assert.equal(result.draftScan.complete, false);
});

for (const driver of ["unused", "set", "unset", "unspecified"]) test(`M1: configured but unused driver ${driver} does not disable ordinary inspection`, (t) => {
  const root = fixture(t); initGit(root); prepare(root, { commit: true });
  const marker = join(root, "UNUSED-FILTER-RAN");
  write(root, "unused.cjs", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed'); process.stdin.pipe(process.stdout);\n`);
  git(root, "config", `filter.${driver}.clean`, `${process.execPath} ${join(root, "unused.cjs")}`);
  write(root, "lib/rule.txt", "changed with no selecting attribute\n");
  const result = core(root, "census", "--changed");
  assert.equal(result.exit, 0, "unused configured driver cannot disable ordinary census");
  assert.ok(!codes(result).includes("git-filter-refused")); assert.ok(!existsSync(marker));
  for (const [tool, args] of [["", ["foreign", "--base", "HEAD", "--landing"]], ["draft", ["check", "repair"]], ["draft", ["promote", "repair", "--id", "§app/rule"]]]) {
    const inspected = run(root, tool, args);
    assert.notEqual(inspected.exit, 2, "unused driver must not cause an inspection failure");
    assert.ok(!codes(inspected).includes("git-filter-refused")); assert.ok(!existsSync(marker));
  }
  untouched(root);
});
