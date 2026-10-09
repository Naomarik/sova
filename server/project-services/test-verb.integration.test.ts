import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { exitOf, httpStatusOf, isVerbResult, type VerbResult } from "../../shared/project-contract";
import { conformer } from "./conform";
import { DetachedDriver } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";
import { conformDir, dataRootOf, readRegistry } from "./store";
import { reservePorts } from "../test-ports";

/**
 * The test verb and on-demand services (§app.project-services/test, /up, /down, /conform suite 2), on
 * real processes (detached driver): a REPL-style on-demand service the test command needs, a runner that
 * talks to it on the instance's own port and writes SOVA_OUT; its timeout and a cancel kill it. The
 * verb's other decisions, and conform suite 2, run on a host in memory in test-verb.test.ts.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-testverb-agent-"));

const op: Caller = { kind: "operator" };
let BASE = 0;

const def = (over: { test?: object | null; timeout?: number } = {}) => ({
  version: 1,
  slots: { cap: 2 },
  services: {
    web: { cmd: ["node", "web.mjs"], ports: { http: { base: BASE } }, ready: { http: "http", path: "/", timeout: 10 } },
    repl: { cmd: ["node", "repl.mjs"], start: "on-demand", ports: { nrepl: { base: BASE + 10 } }, ready: { tcp: "nrepl", timeout: 10 }, about: "Test REPL: node client.mjs ${ports.repl.nrepl}" },
  },
  ...(over.test === null ? {} : { test: over.test ?? { run: ["node", "runner.mjs"], requires: ["repl"], timeout: over.timeout ?? 20, smoke: ["unit/a", "unit/b"] } }),
});

const RUNNER = `
import { connect } from "node:net";
import { writeFileSync } from "node:fs";
const sel = process.argv.slice(2);
console.log("runner select " + JSON.stringify(sel) + " env " + process.env.SOVA_TEST_SELECT + " verb " + process.env.SOVA_VERB);
if (sel.includes("slow")) { writeFileSync(process.env.SOVA_OUT + ".pid", String(process.pid)); setInterval(() => {}, 1000); }
else if (sel.includes("raw3")) process.exit(3);
else {
  const s = connect(Number(process.env.SOVA_PORT_REPL_NREPL), "127.0.0.1");
  s.on("error", (e) => { console.log("no repl " + e.message); process.exit(2); });
  s.on("connect", () => {
    s.end();
    const failed = sel.filter((x) => x.startsWith("fail"));
    const passed = (sel.length || 4) - failed.length;
    globalThis.keep = Buffer.alloc(16 * 1024 * 1024, 1);
    writeFileSync(process.env.SOVA_OUT, JSON.stringify({ passed, failed: failed.length, skipped: 1, failures: failed.map((n) => ({ name: n, message: "expected 1, got 2".repeat(200), file: "t.mjs", line: 3 })) }));
    console.log("ran " + passed + " passed " + failed.length + " failed");
    // Held for the memory sampler (200 ms) only in the run whose peak is asserted; the rest exit at once.
    setTimeout(() => process.exit(failed.length ? 1 : 0), sel.includes("unit/b:c*") ? 500 : 0);
  });
}
`;

let parent = "";
let project = "";
let engine: ProjectEngine;

const define = (d: object, checkout = project) => {
  // Never the real cwd: before `before` has set `project` it is "", and join("", ".sova", ...) is
  // the repository's own .sova/project.json (it once was, under a runner that didn't await `before`).
  assert.ok(checkout.startsWith(realpathSync(tmpdir()) + "/"), `define() outside the temp dir: "${checkout}"`);
  writeFileSync(join(checkout, ".sova", "project.json"), JSON.stringify(d, null, 2));
};
const unitLive = async (id: string, svc: string) => ["active", "activating"].includes((await engine.driver.status(engine.unitOf(id, svc))).state);
const svc = (r: VerbResult, name: string) => r.services.find((s) => s.name === name)!;

before(async () => {
  BASE = await reservePorts(15);
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-testverb-proj-")));
  project = join(parent, "demo");
  mkdirSync(join(project, ".sova"), { recursive: true });
  writeFileSync(join(project, "web.mjs"), `import { createServer } from "node:http"; createServer((q, r) => r.end("ok")).listen(Number(process.env.SOVA_PORT_HTTP), "127.0.0.1"); console.log("web up");`);
  writeFileSync(join(project, "repl.mjs"), `import { createServer } from "node:net"; createServer((s) => { s.on("error", () => {}); s.end("ok\\n"); }).listen(Number(process.env.SOVA_PORT_NREPL), "127.0.0.1"); console.log("repl up");`);
  writeFileSync(join(project, "runner.mjs"), RUNNER);
  define(def());
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project });
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  engine = new ProjectEngine({ driver: new DetachedDriver(3_000), pollMs: 100 });
  engine.conformer = conformer(engine);
});

after(async () => {
  for (const i of readRegistry().instances) await engine.run(i.slot === 0 ? "down" : "teardown", { instance: i.id }, op);
  for (const i of readRegistry().instances) for (const s of ["web", "repl"]) await engine.driver.stop(engine.unitOf(i.id, s));
  rmSync(parent, { recursive: true, force: true });
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
});

/** The slow runner's own pid, as it wrote it, gone: nothing of this run is left (never a scan of every process on the host). */
function slowRunnerGone(): void {
  const rec = readRegistry().instances.find((i) => i.id === wt)!;
  const pid = Number(readFileSync(join(dataRootOf(rec.id), ".out", "test.json.pid"), "utf8"));
  assert.ok(pid > 0);
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch (e) {
    alive = (e as NodeJS.ErrnoException).code === "EPERM";
  }
  assert.equal(alive, false, `the runner (pid ${pid}) is gone`);
}

let wt = "";
let checkout = "";

test("up leaves an on-demand service stopped; the first test starts it, runs the selection in the instance and reports counts", async () => {
  const up = await engine.run("up", { project, branch: "feat-tests" }, op);
  assert.equal(up.state, "running", up.error?.message);
  wt = up.instance!;
  checkout = readRegistry().instances.find((i) => i.id === wt)!.checkout;
  assert.equal(svc(up, "web").state, "ready");
  assert.equal(svc(up, "repl").state, "stopped", "on-demand: up leaves it stopped");
  assert.ok(!(await unitLive(wt, "repl")));

  const t = await engine.run("test", { instance: wt, select: ["unit/a", "unit/b:c*"] }, op);
  assert.ok(isVerbResult(t), "the fixed result shape, tests between conform and error");
  assert.equal(t.ok, true, t.error?.message);
  assert.equal(t.changed, true, "it started the on-demand service");
  assert.equal(svc(t, "repl").state, "ready", "test started what it requires and keeps it warm");
  assert.equal(readRegistry().instances.find((i) => i.id === wt)!.desired.repl, "running");
  const tests = t.tests!;
  assert.deepEqual([tests.select, tests.pass, tests.passed, tests.failed, tests.errors, tests.skipped, tests.exit, tests.timedOut], [["unit/a", "unit/b:c*"], true, 2, 0, 0, 1, 0, false]);
  assert.ok(tests.ms > 0);
  assert.ok((tests.peakBytes ?? 0) > 16 * 1024 * 1024, `the run's sampled memory peak: ${tests.peakBytes}`);
  const out = (t.lines ?? []).map((l) => l.text).join("\n");
  assert.match(out, /runner select \["unit\/a","unit\/b:c\*"\] env \["unit\/a","unit\/b:c\*"\] verb test/, "selectors appended as argv, and in SOVA_TEST_SELECT");
  assert.ok((t.lines ?? []).every((l) => l.service === "test"));
  assert.equal(t.steps.find((s) => s.id === "test")?.kind, "test");

  // Warm: a second run starts nothing, and only this run's output is in its lines.
  const t2 = await engine.run("test", { instance: wt }, op);
  assert.equal(t2.ok, true, t2.error?.message);
  assert.equal(t2.changed, false, JSON.stringify(t2.steps));
  assert.equal(t2.tests!.passed, 4, "no select: the whole suite");
  assert.equal((t2.lines ?? []).filter((l) => l.text.startsWith("runner select")).length, 1, "the run's own output only");
});

test("a failing selection, a runner with no SOVA_OUT, a timeout and a cancelled call are tests-failed (exit 1, 502)", async () => {
  const f = await engine.run("test", { instance: wt, select: ["unit/a", "unit/b", "fail:one"] }, op);
  assert.equal(f.error?.code, "tests-failed");
  assert.equal(exitOf(f), 1);
  assert.equal(httpStatusOf(f), 502);
  assert.equal(f.error!.message, "1 of 3 failed");
  assert.equal(f.tests!.pass, false);
  assert.equal(f.tests!.failures.length, 1);
  assert.equal(f.tests!.failures[0]!.name, "fail:one");
  assert.equal(f.tests!.failures[0]!.message!.length, 2000, "a message is cut to 2000 characters");
  assert.equal(f.tests!.failures[0]!.line, 3);
  assert.ok(isVerbResult(f));

  const raw = await engine.run("test", { instance: wt, select: ["raw3"] }, op);
  assert.equal(raw.error?.code, "tests-failed");
  assert.equal(raw.error!.message, "the test command exited with 3");
  assert.deepEqual([raw.tests!.passed, raw.tests!.failed, raw.tests!.exit], [null, null, 3]);

  define(def({ timeout: 1 }), checkout);
  const slow = await engine.run("test", { instance: wt, select: ["slow"] }, op);
  assert.equal(slow.error?.code, "tests-failed");
  assert.equal(slow.error!.message, "timed out after 1s");
  assert.equal(slow.tests!.timedOut, true);
  slowRunnerGone();
  define(def(), checkout);

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 600);
  const cut = await engine.run("test", { instance: wt, select: ["slow"] }, op, { signal: ac.signal });
  assert.equal(cut.error?.code, "tests-failed");
  // Waited out, it would end "timed out after 20s": cancelled says the abort stopped it.
  assert.match(cut.error!.message, /cancelled/);
  slowRunnerGone();
});
