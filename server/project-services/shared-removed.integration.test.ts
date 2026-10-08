import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type VerbResult } from "../../shared/project-contract";
import { DetachedDriver } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";
import { readRegistry, sharedIdOf } from "./store";
import { reservePorts } from "../test-ports";

/**
 * A shared service that left every definition (§app.project-services/down, /up, /reconcile) is stopped
 * and marked stopped; one a definition still declares, or while one is unreadable, is left alone. And
 * status lists what left the definition while its unit still runs (§app.project-services/status-logs).
 * Detached driver, real processes; the other decisions run on a host in memory in shared-removed.test.ts.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-shrm-agent-"));

const op: Caller = { kind: "operator" };
let BASE = 0;

const full = () => ({
  version: 1,
  slots: { cap: 2 },
  services: {
    cache: { cmd: ["node", "srv.mjs"], scope: "shared", ports: { tcp: { fixed: BASE + 10 } }, ready: { tcp: "tcp", timeout: 10 } },
    api: { cmd: ["node", "srv.mjs"], requires: ["cache"], ports: { http: { base: BASE } }, ready: { tcp: "http", timeout: 10 } },
    extra: { cmd: ["node", "srv.mjs"], ports: { http: { base: BASE + 5 } }, ready: { tcp: "http", timeout: 10 } },
  },
});
const apiOnly = () => ({ version: 1, slots: { cap: 2 }, services: { api: { cmd: ["node", "srv.mjs"], ports: { http: { base: BASE } }, ready: { tcp: "http", timeout: 10 } } } });

let parent = "";
let project = "";
let engine: ProjectEngine;

const define = (def: object, checkout = project) => {
  writeFileSync(join(checkout, ".sova", "project.json"), JSON.stringify(def, null, 2));
};
const cacheUnit = () => engine.unitOf(sharedIdOf(project), "cache");
const live = async (unit: string) => ["active", "activating"].includes((await engine.driver.status(unit)).state);
const stepOf = (r: VerbResult, id: string) => r.steps.find((s) => s.id === id);
const sharedDesired = () => readRegistry().shared.find((x) => x.project === project)?.desired.cache;

before(async () => {
  BASE = await reservePorts(11);
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-shrm-proj-")));
  project = join(parent, "demo");
  mkdirSync(join(project, ".sova"), { recursive: true });
  writeFileSync(join(project, "srv.mjs"), `import { createServer } from "node:net"; createServer((s) => s.end()).listen(Number(process.env.SOVA_PORT_HTTP ?? process.env.SOVA_PORT_TCP), "127.0.0.1");`);
  define(full());
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project });
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  engine = new ProjectEngine({ driver: new DetachedDriver(3_000), pollMs: 100 });
});

after(async () => {
  define(full());
  for (const i of readRegistry().instances) await engine.run(i.slot === 0 ? "down" : "teardown", { instance: i.id }, op);
  for (const i of readRegistry().instances) for (const svc of ["api", "extra"]) await engine.driver.stop(engine.unitOf(i.id, svc));
  await engine.driver.stop(cacheUnit());
  rmSync(parent, { recursive: true, force: true });
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
});

test("down stops a shared service no definition declares any more, marks it stopped, then is idempotent", async () => {
  define(full());
  const up = await engine.run("up", { project }, op);
  assert.equal(up.state, "running", up.error?.message);
  assert.ok(await live(cacheUnit()));
  define(apiOnly());
  const st = await engine.run("status", { instance: up.instance }, op);
  const cache = st.services.find((s) => s.name === "cache");
  assert.equal(cache?.state, "degraded");
  assert.equal(cache?.scope, "shared");
  assert.equal(cache?.detail, "shared, no longer in any definition");
  const dn = await engine.run("down", { instance: up.instance }, op);
  assert.equal(dn.ok, true, dn.error?.message);
  assert.equal(stepOf(dn, "stop:cache")?.result, "done");
  assert.match(stepOf(dn, "stop:cache")!.detail!, /shared, no longer in any definition/);
  assert.ok(!(await live(cacheUnit())));
  assert.equal(sharedDesired(), "stopped");
  const again = await engine.run("down", { instance: up.instance }, op);
  assert.equal(again.changed, false, JSON.stringify(again.steps));
  // Reconcile never starts it again while no definition declares it.
  const did = await engine.reconcile();
  assert.ok(!did.some((d) => d.includes("started shared")), did.join("; "));
  assert.ok(!(await live(cacheUnit())));
  define(full());
});
