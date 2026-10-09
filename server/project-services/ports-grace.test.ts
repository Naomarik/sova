import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { conformer } from "./conform";
import { FakeHost, ownPorts } from "./fake-host";
import { ProjectEngine, type Caller } from "./engine";
import { readRegistry } from "./store";

/**
 * A service's second port opening after the one its readiness asks (MotorSaif's nREPL a few seconds
 * after its HTTP server; §app.project-services/contract, /up, /conform): up waits for every declared
 * port within the ready timeout, conform's ports-owned too; a port that never opens fails not-ready by
 * name, and one a foreign process takes meanwhile fails port-held at once. On a host in memory
 * (fake-host.ts) whose clock the waits step; ports-grace.integration.test.ts runs real services.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-ports-grace-agent-"));

const op: Caller = { kind: "operator" };
const LATE_MS = 1_000;
const base = 21_000;
const FOREIGN = { pid: 4_242, cwd: "/elsewhere" };

let parent = "";
let project = "";
let host: FakeHost;
let engine: ProjectEngine;
/** The main checkout's instance (down names an instance, never a project). */
const mainId = () => readRegistry().instances.find((i) => i.project === project && i.slot === 0)!.id;
const svc = (at: number, timeout: number, onDemand: boolean) => ({
  cmd: ["node", "server.mjs"],
  ports: { http: { base: at, stride: 2 }, nrepl: { base: at + 1, stride: 2 } },
  ready: { http: "http", timeout },
  ...(onDemand ? { start: "on-demand" } : {}),
});
/** Per service: whether its nREPL port opens LATE_MS after the start (web), never (stuck), or is left to the test (racy). */
const LATE: Record<string, number | null> = { web: LATE_MS, stuck: null, racy: null };

before(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-ports-grace-proj-")));
  project = join(parent, "demo");
  mkdirSync(join(project, ".sova"), { recursive: true });
  writeFileSync(join(project, "server.mjs"), "");
  const d = {
    version: 1,
    slots: { cap: 2 },
    services: {
      web: svc(base, 20, false),
      stuck: svc(base + 10, 3, true),
      // The ready timeout is long: waiting it out would end not-ready, so port-held proves it never waited.
      racy: svc(base + 20, 60, true),
    },
  };
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(d, null, 2));
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project });
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  host = new FakeHost();
  // HTTP at once; the second port as LATE says.
  host.driver.behave = (spec) => {
    const [http, nrepl] = [Number(spec.env.SOVA_PORT_HTTP), Number(spec.env.SOVA_PORT_NREPL)];
    const late = LATE[spec.unit.split("-").at(-1)!];
    assert.deepEqual(ownPorts(spec).sort(), [http, nrepl].sort());
    return { ports: [http], late: late === null ? [] : [{ port: nrepl, ms: late! }] };
  };
  engine = new ProjectEngine(host.deps());
  engine.conformer = conformer(engine);
});

after(() => {
  rmSync(parent, { recursive: true, force: true });
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
});

test("up waits for a port that opens after the probed one: once up answers ready, the late port listens", async () => {
  const t0 = host.clock.now();
  const r = await engine.run("up", { project }, op);
  assert.equal(r.ok, true, r.error?.message);
  assert.notEqual(host.portOwner(base + 1), "none", "the late nREPL port listens when up says ready");
  assert.ok(host.clock.now() - t0 >= LATE_MS, "up waited for it");
  assert.ok(host.clock.now() - t0 < 20_000, "and no longer than the port took, never the ready timeout");
  const dn = await engine.run("down", { instance: r.instance }, op);
  assert.equal(dn.ok, true, dn.error?.message);
  assert.equal(host.portOwner(base + 1), "none");
});

test("conform's ports-owned waits for the late port within the ready timeout, and passes", async () => {
  const r = await engine.run("conform", { project }, op);
  assert.equal(r.ok, true, `${r.error?.message}\n${JSON.stringify(r.conform?.checks, null, 1)}`);
  assert.ok(r.conform!.checks.find((c) => c.id === "ports-owned")?.ok);
});

test("a port that never opens fails not-ready by name at the ready timeout", async () => {
  const t0 = host.clock.now();
  const r = await engine.run("up", { project, services: ["stuck"] }, op);
  assert.equal(r.error?.code, "not-ready");
  assert.match(r.error!.message, /answered, but nothing listens on stuck\.nrepl \(\d+\)/);
  assert.ok(host.clock.now() - t0 >= 3_000, "at the ready timeout, not before");
  await engine.run("down", { instance: mainId(), services: ["stuck"] }, op);
});

test("a port a foreign process takes while the service is coming up fails port-held at once, never waits out the timeout", async () => {
  // Past the start's own port check: racy's HTTP answers; then something else takes its late port.
  host.httpOk = (port) => {
    if (port === base + 20) host.listen(base + 21, FOREIGN.pid, FOREIGN.cwd);
    return true;
  };
  try {
    const r = await engine.run("up", { project, services: ["racy"] }, op);
    assert.equal(r.error?.code, "port-held", r.error?.message);
    assert.match(r.error!.message, /racy\.nrepl needs port \d+, which pid 4242 \(\/elsewhere\) holds/);
    assert.deepEqual(host.listeners.get(base + 21), FOREIGN, "the holder is never touched");
  } finally {
    host.httpOk = () => true;
    host.close(base + 21);
    await engine.run("down", { instance: mainId(), services: ["racy"] }, op);
  }
  assert.equal(readRegistry().instances.filter((i) => i.slot !== 0).length, 0, "conform left nothing");
});
