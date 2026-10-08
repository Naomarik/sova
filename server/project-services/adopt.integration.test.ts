import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as httpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DetachedDriver, type AdoptedStatus } from "./drivers";
import { ProjectEngine, type Caller, type VerbAct } from "./engine";
import { readRegistry } from "./store";
import { reservePorts } from "../test-ports";

/**
 * Slot 0 adopts a unit Sova did not start (§app.project-services/adopt): read only, up, down, reset and
 * teardown refused, and apply, under the self-host rule for every caller, schedules the unit's gated
 * restart instead of reloading it. The unit is a stand-in: its status and the schedule are faked, and
 * a plain listener in this process plays its port. Nothing here reaches a user bus. Real probes and a real
 * service here; every case runs on a host in memory in adopt.test.ts.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-adopt-agent-"));

const UNIT = "sova-gate-standin.service";
let BASE = 0;
let parent = "";
let project = "";
let busy: string | null = null;
let unit: AdoptedStatus = { state: "active", pid: process.pid, startedAt: "2026-10-03T12:00:00.000Z", rssBytes: 1024 };
const scheduled: [string, number | null][] = [];
let scheduleFails: string | null = null;
let listener: Server;
let engine: ProjectEngine;
const op: Caller = { kind: "operator" };
const taken: VerbAct = async () => undefined;

before(async () => {
  BASE = await reservePorts(61);
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-adopt-proj-")));
  project = join(parent, "app");
  mkdirSync(join(project, ".sova"), { recursive: true });
  const serve = "require('http').createServer((q,r)=>r.end('ok')).listen(+process.env.SOVA_PORT_HTTP,'127.0.0.1')";
  const def = {
    version: 1,
    slots: { cap: 2 },
    setup: [{ id: "mark", run: ["node", "-e", "require('fs').writeFileSync('setup-ran','')"] }],
    services: { server: { cmd: ["node", "-e", serve], ports: { http: { base: BASE + 10, stride: 10 } }, ready: { http: "http" }, adopt: { unit: UNIT, ports: { http: BASE } } } },
  };
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(def));
  writeFileSync(join(project, ".gitignore"), "setup-ran\n");
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project });
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  // The stand-in unit's port, answered by this process.
  listener = httpServer((_q, r) => r.end("ok"));
  await new Promise<void>((ok) => listener.listen(BASE, "127.0.0.1", () => ok()));
  engine = new ProjectEngine({
    driver: new DetachedDriver(3_000),
    pollMs: 50,
    selfCheckout: () => "/not/this/project",
    hostBusy: () => busy,
    adoptedStatus: async () => unit,
    scheduleRestart: async (u, pid) => {
      if (scheduleFails) return scheduleFails;
      scheduled.push([u, pid]);
      return null;
    },
  });
});

after(async () => {
  for (const i of readRegistry().instances) if (i.slot !== 0) await engine.run("teardown", { instance: i.id }, op);
  await new Promise((ok) => listener.close(ok));
  rmSync(parent, { recursive: true, force: true });
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
});

let main = "";

test("create on the main checkout records slot 0 and sets nothing up; status reads the adopted unit, ready on its own port", async () => {
  const c = await engine.run("create", { project }, op);
  assert.equal(c.ok, true, c.error?.message);
  assert.equal(c.slot, 0);
  main = c.instance!;
  assert.deepEqual(c.steps.map((s) => [s.id, s.result]), [["slot", "done"], ["setup", "skipped"]]);
  assert.match(c.steps[1]!.detail!, /adopted unit sova-gate-standin\.service: nothing is set up/);
  const st = await engine.run("status", { instance: main }, op);
  const svc = st.services[0]!;
  assert.equal(svc.unit, UNIT);
  assert.equal(svc.pid, process.pid);
  assert.deepEqual(svc.ports, { http: BASE });
  assert.equal(svc.state, "ready");
  assert.equal(svc.ready?.probe, `http :${BASE}/`);
  assert.equal(svc.rssBytes, 1024);
  assert.match(svc.detail!, /^adopted unit, started 2026-10-03T12:00:00\.000Z$/);
  assert.equal(st.state, "running", "the adopted unit is always wanted");
  unit = { state: "failed", pid: null, startedAt: null, rssBytes: null, detail: "failed/failed (exit-code)" };
  const down = await engine.run("status", { instance: main }, op);
  assert.equal(down.services[0]!.state, "failed");
  assert.equal(down.state, "degraded");
  unit = { state: "active", pid: process.pid, startedAt: "2026-10-03T12:00:00.000Z", rssBytes: 1024 };
});

test("every other slot runs the service as usual, on its allocated port, with its setup", async () => {
  const wt = await engine.run("up", { project, branch: "feat-adopt" }, op);
  assert.equal(wt.state, "running", wt.error?.message);
  assert.equal(wt.slot, 1);
  assert.deepEqual(wt.services[0]!.ports, { http: BASE + 20 });
  assert.notEqual(wt.services[0]!.unit, UNIT);
  assert.equal(wt.steps.find((s) => s.id === "setup:mark")?.result, "done");
  const ap = await engine.run("apply", { instance: wt.instance }, op);
  assert.equal(ap.ok, true, ap.error?.message);
  assert.ok(ap.steps.some((s) => s.id === "reload:server" && s.detail === "restarted"), "an ordinary restart, no schedule");
  assert.equal((await engine.run("teardown", { instance: wt.instance }, op)).ok, true);
  assert.equal(scheduled.length, 0, "an ordinary restart schedules nothing");
});
