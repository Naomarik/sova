import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseDefinition, type VerbResult } from "../../shared/project-contract";
import { DetachedDriver } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";
import { readRegistry, sharedIdOf } from "./store";
import { approve, defHashOf } from "./trust";

/**
 * A shared service that left every definition (§app.project-services/down, /up, /reconcile) is stopped
 * and marked stopped; one a definition still declares, or while one is unreadable, is left alone. And
 * status lists what left the definition while its unit still runs (§app.project-services/status-logs).
 * Detached driver, real processes.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-shrm-agent-"));

const op: Caller = { kind: "operator" };
let BASE = 0;
const isFree = (port: number) => new Promise<boolean>((done) => { const s = createServer(); s.once("error", () => done(false)); s.listen(port, "127.0.0.1", () => s.close(() => done(true))); });
async function pickBase(): Promise<number> {
  for (;;) {
    const b = 20_000 + Math.floor(Math.random() * 12_000);
    if ((await Promise.all([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((o) => isFree(b + o)))).every(Boolean)) return b;
  }
}

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
  const hash = defHashOf(parseDefinition(JSON.stringify(def)));
  approve(project, hash, hash);
};
const cacheUnit = () => engine.unitOf(sharedIdOf(project), "cache");
const live = async (unit: string) => ["active", "activating"].includes((await engine.driver.status(unit)).state);
const stepOf = (r: VerbResult, id: string) => r.steps.find((s) => s.id === id);
const sharedDesired = () => readRegistry().shared.find((x) => x.project === project)?.desired.cache;

before(async () => {
  BASE = await pickBase();
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

test("status lists a removed service while its unit runs, as degraded, after the declared ones", async () => {
  define(full());
  const up = await engine.run("up", { project }, op);
  assert.equal(up.state, "running", up.error?.message);
  const id = up.instance!;
  define({ ...full(), services: { cache: full().services.cache, api: full().services.api } });
  const st = await engine.run("status", { instance: id }, op);
  const extra = st.services.find((s) => s.name === "extra");
  assert.ok(extra, `the removed service is listed: ${JSON.stringify(st.services.map((s) => s.name))}`);
  assert.equal(extra.state, "degraded");
  assert.equal(extra.detail, "no longer in the definition");
  assert.ok(extra.pid, "with its pid");
  assert.equal(st.services.at(-1)?.name, "extra", "after the declared ones");
  // Once down stops it, status no longer lists it.
  await engine.run("down", { instance: id, services: ["extra"] }, op);
  const st2 = await engine.run("status", { instance: id }, op);
  assert.ok(!st2.services.some((s) => s.name === "extra"), JSON.stringify(st2.services.map((s) => s.name)));
  define(full());
  await engine.run("down", { instance: id }, op);
});

test("a shared service another definition still declares is never stopped by an instance's down", async () => {
  define(full());
  const main = await engine.run("up", { project }, op);
  assert.equal(main.state, "running", main.error?.message);
  const wt = await engine.run("up", { project, branch: "feat-keep" }, op);
  assert.equal(wt.state, "running", wt.error?.message);
  // The branch drops the shared cache; main still declares it.
  define(apiOnly(), readRegistry().instances.find((i) => i.id === wt.instance)!.checkout);
  const dn = await engine.run("down", { instance: wt.instance }, op);
  assert.equal(dn.ok, true, dn.error?.message);
  assert.ok(!stepOf(dn, "stop:cache"), JSON.stringify(dn.steps));
  assert.ok(await live(cacheUnit()), "main's definition still declares it");
  await engine.run("teardown", { instance: wt.instance }, op);
  await engine.run("down", { instance: main.instance }, op);
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

test("up stops it too, and reconcile stops an orphan; an unreadable definition leaves it alone", async () => {
  define(full());
  const up = await engine.run("up", { project }, op);
  assert.equal(up.state, "running", up.error?.message);
  define(apiOnly());
  const up2 = await engine.run("up", { instance: up.instance }, op);
  assert.equal(up2.ok, true, up2.error?.message);
  assert.equal(stepOf(up2, "stop:cache")?.result, "done");
  assert.ok(!(await live(cacheUnit())));

  // Back up, then the definition drops it while the server is away: reconcile stops it.
  define(full());
  const back = await engine.run("up", { instance: up.instance }, op);
  assert.equal(back.state, "running", back.error?.message);
  assert.ok(await live(cacheUnit()));
  define(apiOnly());
  const did = await engine.reconcile();
  assert.ok(did.includes(`${sharedIdOf(project)}: stopped cache (shared, no longer in any definition)`), did.join("; "));
  assert.ok(!(await live(cacheUnit())));

  // With a definition unreadable, nothing can tell who still wants it: left running.
  define(full());
  const back2 = await engine.run("up", { instance: up.instance }, op);
  assert.equal(back2.state, "running", back2.error?.message);
  writeFileSync(join(project, ".sova", "project.json"), "{ not json");
  const did2 = await engine.reconcile();
  assert.ok(!did2.some((d) => d.includes("stopped cache")), did2.join("; "));
  assert.ok(await live(cacheUnit()));
  define(full());
  await engine.run("down", { instance: up.instance }, op);
});
