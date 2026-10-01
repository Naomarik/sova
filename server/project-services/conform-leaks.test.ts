import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseDefinition, type VerbResult } from "../../shared/project-contract";
import { conformer } from "./conform";
import { DetachedDriver } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";
import { readRegistry, servicesRoot } from "./store";
import { approve, defHashOf } from "./trust";

/**
 * conform's no-leaks check (§app.project-services/conform) while something else happens on the same
 * state root: another instance's unit that appears mid-run (a session's up, the server's reconcile)
 * is never a leak; a unit or data dir that belongs to no registered instance still is.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-conform-leaks-agent-"));

const op: Caller = { kind: "operator" };
/** Below the kernel's ephemeral range (32768+), and free now: a random port there can be any outgoing socket's. */
let BASE = 0;
const isFree = (port: number) => new Promise<boolean>((done) => { const s = createServer(); s.once("error", () => done(false)); s.listen(port, "127.0.0.1", () => s.close(() => done(true))); });
async function pickBase(): Promise<number> {
  for (;;) {
    const b = 20_000 + Math.floor(Math.random() * 12_000);
    if ((await Promise.all([0, 1, 2, 3].map((o) => isFree(b + o)))).every(Boolean)) return b;
  }
}

const def = () => ({
  version: 1,
  slots: { cap: 2 },
  services: { api: { cmd: ["node", "api.mjs"], ports: { http: { base: BASE } }, ready: { tcp: "http", timeout: 10 } } },
});

let parent = "";
let project = "";
let engine: ProjectEngine;
let mainId = "";
/** Runs once, just before conform's first up: what another caller does meanwhile. */
let midRun: (() => Promise<void>) | null = null;

before(async () => {
  BASE = await pickBase();
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-conform-leaks-proj-")));
  project = join(parent, "demo");
  mkdirSync(join(project, ".sova"), { recursive: true });
  writeFileSync(join(project, "api.mjs"), `import { createServer } from "node:net"; createServer((s) => s.end()).listen(Number(process.env.SOVA_PORT_HTTP), "127.0.0.1"); console.log("api up");`);
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(def(), null, 2));
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project });
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  const hash = defHashOf(parseDefinition(readFileSync(join(project, ".sova/project.json"), "utf8")));
  approve(project, hash, hash);
  engine = new ProjectEngine({ driver: new DetachedDriver(3_000), pollMs: 100 });
  engine.conformer = conformer(engine);
  const real = engine.run.bind(engine);
  engine.run = async (verb, body, caller) => {
    if (midRun && caller.kind === "conform" && verb === "up") {
      const f = midRun;
      midRun = null;
      await f();
    }
    return real(verb, body, caller);
  };
  // The main instance is registered before any conform run, and not running.
  const c = await engine.run("create", { project }, op);
  assert.equal(c.ok, true, c.error?.message);
  mainId = c.instance!;
});

after(async () => {
  for (const i of readRegistry().instances) await engine.run(i.slot === 0 ? "down" : "teardown", { instance: i.id }, op);
  rmSync(parent, { recursive: true, force: true });
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
});

const leaksOf = (r: VerbResult) => r.conform?.checks.find((c) => c.id === "no-leaks");

test("another instance's unit that appears during the run is not a leak", async () => {
  let mainUp = null as VerbResult | null;
  midRun = async () => {
    mainUp = await engine.run("up", { instance: mainId }, op);
  };
  const r = await engine.run("conform", { project }, op);
  assert.ok(mainUp, "the main instance came up while conform ran");
  assert.equal(mainUp!.state, "running");
  assert.equal(r.ok, true, `${r.error?.message}\n${JSON.stringify(r.conform?.checks, null, 1)}`);
  assert.deepEqual(r.conform?.leaks, []);
  assert.equal(leaksOf(r)?.ok, true);
  const st = await engine.run("status", { instance: mainId }, op);
  assert.equal(st.state, "running", "conform left the main instance alone");
  await engine.run("down", { instance: mainId }, op);
});

test("a unit and a data dir of no registered instance are still leaks", async () => {
  const orphanUnit = `${engine.unitPrefix()}gone-0badc0de-api`;
  const orphanData = join(servicesRoot(), "data", "gone-0badc0de");
  midRun = async () => {
    await engine.driver.start({ unit: orphanUnit, argv: ["node", "-e", "setInterval(() => {}, 1e9)"], cwd: project, env: { PATH: process.env.PATH ?? "" } });
    mkdirSync(orphanData, { recursive: true });
  };
  try {
    const r = await engine.run("conform", { project }, op);
    assert.equal(r.ok, false);
    assert.equal(r.error?.step, "no-leaks", r.error?.message);
    assert.ok(r.conform?.leaks.includes(`unit ${orphanUnit}`), JSON.stringify(r.conform?.leaks));
    assert.ok(r.conform?.leaks.includes("data dir gone-0badc0de"), JSON.stringify(r.conform?.leaks));
    assert.equal(r.conform?.leaks.length, 2, "nothing but the orphans");
  } finally {
    await engine.driver.stop(orphanUnit);
    rmSync(orphanData, { recursive: true, force: true });
  }
});
