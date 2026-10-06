import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseDefinition } from "../../shared/project-contract";
import { conformer } from "./conform";
import { DetachedDriver } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";
import { readRegistry } from "./store";
import { approve, defHashOf } from "./trust";

/**
 * A service's second port opening after the one its readiness asks (MotorSaif's nREPL a few seconds
 * after its HTTP server; §app.project-services/contract, /up, /conform): up waits for every declared
 * port within the ready timeout, conform's ports-owned too; a port that never opens fails not-ready by
 * name, and one a foreign process takes meanwhile fails port-held at once.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-ports-grace-agent-"));

const op: Caller = { kind: "operator" };
const LATE_MS = 1_000;
const isFree = (port: number) => new Promise<boolean>((done) => { const s = createServer(); s.once("error", () => done(false)); s.listen(port, "127.0.0.1", () => s.close(() => done(true))); });
const listens = (port: number) => new Promise<boolean>((done) => { const s = connect(port, "127.0.0.1"); s.once("connect", () => (s.destroy(), done(true))); s.once("error", () => done(false)); });
async function pickBase(): Promise<number> {
  for (;;) {
    const b = 20_000 + Math.floor(Math.random() * 12_000);
    if ((await Promise.all(Array.from({ length: 40 }, (_, o) => isFree(b + o)))).every(Boolean)) return b;
  }
}

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
const svc = (name: string, at: number, late: number, timeout: number, onDemand: boolean) => ({
  cmd: ["node", "server.mjs"],
  env: { HTTP: `\${ports.${name}.http}`, SLOW: `\${ports.${name}.nrepl}`, LATE: String(late) },
  ports: { http: { base: at, stride: 2 }, nrepl: { base: at + 1, stride: 2 } },
  ready: { http: "http", timeout },
  ...(onDemand ? { start: "on-demand" } : {}),
});

before(async () => {
  base = await pickBase();
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
      racy: svc("racy", base + 20, 4_000, 20, true),
    },
  };
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(d, null, 2));
  const hash = defHashOf(parseDefinition(JSON.stringify(d)));
  approve(project, hash, hash);
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project });
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  engine = new ProjectEngine({ driver: new DetachedDriver(3_000), pollMs: 100 });
  engine.conformer = conformer(engine);
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
  await engine.run("down", { project, confirm: true }, op);
});

test("conform's ports-owned waits for the late port within the ready timeout, and passes", async () => {
  const r = await engine.run("conform", { project }, op);
  assert.equal(r.ok, true, `${r.error?.message}\n${JSON.stringify(r.conform?.checks, null, 1)}`);
  assert.ok(r.conform!.checks.find((c) => c.id === "ports-owned")?.ok);
});

test("a port that never opens fails not-ready by name at the ready timeout", async () => {
  const r = await engine.run("up", { project, services: ["stuck"] }, op);
  assert.equal(r.error?.code, "not-ready");
  assert.match(r.error!.message, /answered, but nothing listens on stuck\.nrepl \(\d+\)/);
  await engine.run("down", { project, services: ["stuck"], confirm: true }, op);
});

test("a port a foreign process takes while the service is coming up fails port-held at once, never waits out the timeout", async () => {
  let foreign: Server | null = null;
  const t0 = Date.now();
  const up = engine.run("up", { project, services: ["racy"] }, op);
  // Past the start's own port check: racy's HTTP port listens; then something else takes its late port.
  while (!(await listens(base + 20))) await new Promise((r) => setTimeout(r, 50));
  foreign = createServer((s) => s.end());
  await new Promise<void>((ok) => foreign!.listen(base + 21, "127.0.0.1", () => ok()));
  try {
    const r = await up;
    assert.equal(r.error?.code, "port-held", r.error?.message);
    assert.match(r.error!.message, /racy\.nrepl needs port \d+, which .* holds/);
    assert.ok(Date.now() - t0 < 10_000, "failed at once, not at the 20 s timeout");
  } finally {
    await new Promise((ok) => foreign!.close(() => ok(null)));
    await engine.run("down", { project, services: ["racy"], confirm: true }, op);
  }
});
