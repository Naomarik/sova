import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DetachedDriver } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";
import { readRegistry } from "./store";
import { reservePorts } from "../test-ports";

/**
 * A service's second port opening after the one its readiness asks (MotorSaif's nREPL a few seconds
 * after its HTTP server; §app.project-services/contract, /up, /conform): up waits for every declared
 * port within the ready timeout, conform's ports-owned too; a port that never opens fails not-ready by
 * name, and one a foreign process takes meanwhile fails port-held at once. Real services on this host; the
 * not-ready and conform cases, and these two again, run on a host in memory in ports-grace.test.ts.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-ports-grace-agent-"));

const op: Caller = { kind: "operator" };
const LATE_MS = 1_000;
const listens = (port: number) => new Promise<boolean>((done) => { const s = connect(port, "127.0.0.1"); s.once("connect", () => (s.destroy(), done(true))); s.once("error", () => done(false)); });

// HTTP at once; the second port after LATE (never, for LATE < 0); a refused listen is ignored, so a foreign holder stays foreign.
const SERVER = `
import { createServer } from "node:http";
import { createServer as tcp } from "node:net";
const [httpPort, slowPort, late] = [process.env.HTTP, process.env.SLOW, process.env.LATE].map(Number);
createServer((q, r) => r.end("ok")).listen(httpPort, "127.0.0.1", () => console.log("http up"));
if (late >= 0) setTimeout(() => tcp((s) => s.end()).on("error", () => console.log("slow port taken")).listen(slowPort, "127.0.0.1", () => console.log("slow up")), late);
`;

let base = 0;
let parent = "";
let project = "";
let engine: ProjectEngine;
/** The main checkout's instance (down names an instance, never a project). */
const mainId = () => readRegistry().instances.find((i) => i.project === project && i.slot === 0)!.id;
const svc = (name: string, at: number, late: number, timeout: number, onDemand: boolean) => ({
  cmd: ["node", "server.mjs"],
  env: { HTTP: `\${ports.${name}.http}`, SLOW: `\${ports.${name}.nrepl}`, LATE: String(late) },
  ports: { http: { base: at, stride: 2 }, nrepl: { base: at + 1, stride: 2 } },
  ready: { http: "http", timeout },
  ...(onDemand ? { start: "on-demand" } : {}),
});

before(async () => {
  base = await reservePorts(40);
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-ports-grace-proj-")));
  project = join(parent, "demo");
  mkdirSync(join(project, ".sova"), { recursive: true });
  writeFileSync(join(project, "server.mjs"), SERVER);
  const d = {
    version: 1,
    slots: { cap: 2 },
    services: {
      web: svc("web", base, LATE_MS, 20, false),
      stuck: svc("stuck", base + 10, -1, 3, true),
      // Its late port never opens of itself, and its ready timeout is long: waiting it out would end not-ready,
      // so port-held proves the engine never waited (no clock asked).
      racy: svc("racy", base + 20, -1, 60, true),
    },
  };
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(d, null, 2));
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project });
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  engine = new ProjectEngine({ driver: new DetachedDriver(3_000), pollMs: 100 });
});

after(async () => {
  for (const i of readRegistry().instances) await engine.run(i.slot === 0 ? "down" : "teardown", { instance: i.id }, op);
  rmSync(parent, { recursive: true, force: true });
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
});

test("up waits for a port that opens after the probed one: once up answers ready, the late port listens", async () => {
  const t0 = Date.now();
  const r = await engine.run("up", { project }, op);
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(await listens(base + 1), true, "the late nREPL port listens when up says ready");
  assert.ok(Date.now() - t0 >= LATE_MS - 200, "up waited for it");
  await engine.run("down", { instance: mainId() }, op);
});

test("a port a foreign process takes while the service is coming up fails port-held at once, never waits out the timeout", { timeout: 150_000 }, async () => {
  let foreign: Server | null = null;
  const up = engine.run("up", { project, services: ["racy"] }, op);
  // Past the start's own port check: racy's HTTP port listens; then something else takes its late port.
  while (!(await listens(base + 20))) await new Promise((r) => setTimeout(r, 50));
  foreign = createServer((s) => s.end());
  await new Promise<void>((ok) => foreign!.listen(base + 21, "127.0.0.1", () => ok()));
  try {
    const r = await up;
    assert.equal(r.error?.code, "port-held", r.error?.message);
    assert.match(r.error!.message, /racy\.nrepl needs port \d+, which .* holds/);
  } finally {
    await new Promise((ok) => foreign!.close(() => ok(null)));
    await engine.run("down", { instance: mainId(), services: ["racy"] }, op);
  }
});
