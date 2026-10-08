import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { exitOf, isVerbResult, type VerbResult } from "../../shared/project-contract";
import { staticServes, stopStaticServe } from "../preview-serve";
import { conformer } from "./conform";
import { DetachedDriver, SystemdDriver } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";
import { readRegistry, sharedIdOf } from "./store";
import { reservePorts } from "../test-ports";

/**
 * The engine end to end on this host: real services, readiness probes over real sockets, a signal, a
 * real port holder, static serves and conform. The verbs' decisions run in memory in engine.test.ts.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-engine-agent-"));

const op: Caller = { kind: "operator" };
const PORTS = { site: 0, web: 0, bus: 0 };

let parent = "";
let project = "";
let engine: ProjectEngine;
const git = (args: string[], cwd = project) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

const def = () => ({
  version: 1,
  slots: { cap: 4 },
  setup: [{ id: "mark", run: ["node", "setup.mjs"], inputs: ["setup.mjs"] }],
  // `cache` sits in the checkout under a folder-only ignore pattern (`.agent/`), as Sova's own `.agent` does.
  data: { store: { kind: "dir" }, cache: { kind: "dir", path: ".agent" } },
  services: {
    bus: { cmd: ["node", "bus.mjs"], scope: "shared", ports: { tcp: { fixed: PORTS.bus } } },
    web: { cmd: ["node", "web.mjs"], env: { STORE: "${data.store}" }, ports: { http: { base: PORTS.web } }, requires: ["bus"], ready: { http: "http", path: "/health", timeout: 20 }, reload: { signal: "HUP" } },
    site: { static: "public", ports: { http: { base: PORTS.site } } },
  },
  hooks: { probe: { run: ["node", "probe.mjs"] } },
  share: { endpoints: ["web.http", "site.http"] },
  open: { endpoint: "web.http", path: "/home" },
});

const FILES: Record<string, string> = {
  "setup.mjs": `import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync(process.env.SOVA_DATA, { recursive: true }); writeFileSync(process.env.SOVA_DATA + "/setup-ran", "yes");`,
  "bus.mjs": `import { createServer } from "node:net"; createServer((s) => s.end()).listen(Number(process.env.SOVA_PORT_TCP), "127.0.0.1"); console.log("bus up");`,
  "web.mjs": `import { createServer } from "node:http"; process.on("SIGHUP", () => console.log("reloaded")); createServer((q, r) => { if (q.url === "/home") { r.setHeader("content-type", "text/html"); return r.end("<h1>home</h1>"); } r.end(q.url === "/health" ? "ok" : "web " + process.env.SOVA_INSTANCE); }).listen(Number(process.env.SOVA_PORT_HTTP), "127.0.0.1", () => console.log("web up on", process.env.SOVA_PORT_HTTP));`,
  "probe.mjs": `import { existsSync, writeFileSync } from "node:fs"; const [op, token] = process.argv.slice(2); const f = process.env.SOVA_DATA + "/store/" + token; if (op === "write") writeFileSync(f, "1"); else process.exit(existsSync(f) ? 0 : 1);`,
  "public/index.html": "<h1>site</h1>",
  ".gitignore": ".agent/\n",
};

before(async () => {
  const base = await reservePorts(60);
  Object.assign(PORTS, { site: base, web: base + 20, bus: base + 40 });
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-engine-proj-")));
  project = join(parent, "demo");
  mkdirSync(join(project, ".sova"), { recursive: true });
  mkdirSync(join(project, "public"), { recursive: true });
  for (const [f, body] of Object.entries(FILES)) writeFileSync(join(project, f), body);
  const DEF = def();
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(DEF, null, 2));
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  engine = new ProjectEngine({ driver: new DetachedDriver(3_000), pollMs: 100 });
  engine.conformer = conformer(engine);
  a = shaped(await engine.run("create", { project, branch: "sova/a" }, op));
  assert.equal(a.ok, true, JSON.stringify(a.error));
  assert.equal(a.steps.find((s) => s.id === "setup:mark")?.result, "done", "the real setup ran");
});

after(async () => {
  // Nothing may outlive the tests: every instance torn down, the shared bus stopped.
  for (const i of readRegistry().instances) if (i.slot !== 0) await engine.run("teardown", { instance: i.id }, op);
  for (const main of readRegistry().instances.filter((i) => i.slot === 0))
    await engine.run("down", main.project === project ? { instance: main.id, services: ["web", "site", "bus"], confirm: true } : { instance: main.id }, op);
  for (const s of staticServes()) await stopStaticServe(s.id);
  // Whatever failed above: the project's shared bus is stopped by its unit.
  await engine.driver.stop(engine.unitOf(sharedIdOf(project), "bus"));
  rmSync(parent, { recursive: true, force: true });
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
});

const shaped = (r: VerbResult) => {
  assert.ok(isVerbResult(r), `result shape: ${JSON.stringify(r).slice(0, 400)}`);
  return r;
};

let a: VerbResult;

test("up starts shared services first, waits for readiness; again leaves the same pids", async () => {
  const up = shaped(await engine.run("up", { instance: a.instance }, op));
  assert.equal(up.ok, true, JSON.stringify(up.error));
  assert.equal(up.state, "running");
  assert.equal(up.generation, 1);
  assert.deepEqual(up.steps.filter((s) => s.kind === "start").map((s) => s.id), ["start:bus", "start:web", "start:site"]);
  const web = up.services.find((s) => s.name === "web")!;
  assert.deepEqual(web.ports, { http: PORTS.web + 1 });
  assert.equal((await (await fetch(`http://127.0.0.1:${PORTS.web + 1}/`)).text()), `web ${a.instance}`);
  assert.equal(await (await fetch(`http://127.0.0.1:${PORTS.site + 1}/`)).text(), "<h1>site</h1>");
  const again = shaped(await engine.run("up", { instance: a.instance }, op));
  assert.equal(again.changed, false);
  assert.equal(again.generation, 1);
  assert.deepEqual(again.services.map((s) => s.pid), up.services.map((s) => s.pid));
  const st = shaped(await engine.run("status", { instance: a.instance }, op));
  assert.deepEqual(st.services.map((s) => [s.name, s.state]), [["bus", "ready"], ["web", "ready"], ["site", "ready"]]);
  // A running process service's resident memory; a static one, served in the server, has none of its own.
  assert.ok((st.services.find((s) => s.name === "web")!.rssBytes ?? 0) > 1024 * 1024, JSON.stringify(st.services));
  assert.equal(st.services.find((s) => s.name === "site")!.rssBytes, undefined);
  const all = shaped(await engine.run("status", { project }, op));
  assert.deepEqual(all.instances?.map((i) => [i.instance, i.state]), [[a.instance, "running"]]);
});

test("apply signals a service whose reload is a signal, and waits for readiness again", async () => {
  const before = shaped(await engine.run("status", { instance: a.instance }, op)).services.find((s) => s.name === "web")!.pid;
  const r = shaped(await engine.run("apply", { instance: a.instance, services: ["web"] }, op));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.steps.map((s) => [s.id, s.result]), [["reload:web", "done"], ["ready:web", "done"]]);
  assert.equal(r.services.find((s) => s.name === "web")!.pid, before, "a signal keeps the process");
  const logs = shaped(await engine.run("logs", { instance: a.instance, services: ["web"] }, op));
  // The handler's line reaches the log a moment after the signal: a poll with a generous hang guard.
  for (let i = 0; i < 300 && !logs.lines?.some((l) => l.text === "reloaded"); i++) {
    await new Promise((res) => setTimeout(res, 100));
    logs.lines = (await engine.run("logs", { instance: a.instance, services: ["web"] }, op)).lines;
  }
  assert.ok(logs.lines?.some((l) => l.text === "reloaded"), JSON.stringify(logs.lines));
});

test("a port something else holds refuses the start and is never touched", async () => {
  const b = shaped(await engine.run("create", { project, branch: "sova/b" }, op));
  assert.equal(b.slot, 2);
  const squatter: Server = createServer();
  await new Promise<void>((r) => squatter.listen(PORTS.web + 2, "127.0.0.1", r));
  try {
    const up = shaped(await engine.run("up", { instance: b.instance }, op));
    assert.equal(up.error?.code, "port-held");
    assert.match(up.error!.message, new RegExp(`pid ${process.pid}`));
    assert.equal(exitOf(up), 2);
    assert.ok(squatter.listening, "the holder still listens");
  } finally {
    await new Promise((r) => squatter.close(r));
  }
  const up = shaped(await engine.run("up", { instance: b.instance }, op));
  assert.equal(up.ok, true, JSON.stringify(up.error));
  assert.equal(up.steps.find((s) => s.id === "start:bus")?.result, "skipped", "the shared bus is already up");
  const td = shaped(await engine.run("teardown", { instance: b.instance }, op));
  assert.equal(td.ok, true);
});

test("with no supervisor reachable, process verbs are unsupported and change nothing; static folders still serve", async () => {
  const bare = new ProjectEngine({ driver: new SystemdDriver(async () => ({ code: 1, stdout: "", stderr: "Failed to connect to bus" })), pollMs: 100 });
  const before = readRegistry().instances.length;
  const r = shaped(await bare.run("up", { project, branch: "sova/nobus" }, op));
  assert.equal(r.error?.code, "unsupported");
  assert.match(r.error!.message, /no systemd user manager reachable/);
  assert.equal(exitOf(r), 2);
  assert.equal(readRegistry().instances.length, before, "nothing was made");
  assert.ok(!existsSync(join(parent, ".worktrees", "demo-nobus")));
  // A static-only project needs no supervisor.
  const site = join(parent, "site");
  mkdirSync(join(site, ".sova"), { recursive: true });
  writeFileSync(join(site, "index.html"), "static");
  const def = { version: 1, services: { site: { static: ".", ports: { http: { base: PORTS.site + 10 } } } } };
  writeFileSync(join(site, ".sova", "project.json"), JSON.stringify(def));
  git(["init", "-q", "-b", "main"], site);
  git(["add", "-A"], site);
  git(["commit", "-q", "-m", "site"], site);
  const up = shaped(await bare.run("up", { project: site }, op));
  assert.equal(up.ok, true, JSON.stringify(up.error));
  assert.equal(await (await fetch(`http://127.0.0.1:${PORTS.site + 10}/`)).text(), "static");
  assert.equal(shaped(await bare.run("down", { instance: up.instance }, op)).state, "stopped");
});

test("reconcile brings an instance back to what it should be doing", async () => {
  const st = shaped(await engine.run("status", { instance: a.instance }, op));
  const web = st.services.find((s) => s.name === "web")!;
  const site = st.services.find((s) => s.name === "site")!;
  // What a server restart loses: the in-process static serve; and a process that died meanwhile.
  await stopStaticServe(site.unit!);
  await engine.driver.stop(web.unit!);
  assert.equal(shaped(await engine.run("status", { instance: a.instance }, op)).state, "degraded");
  const gen = st.generation!;
  const did = await engine.reconcile();
  assert.ok(did.some((d) => d.includes("started web")) && did.some((d) => d.includes("started site")), JSON.stringify(did));
  const back = shaped(await engine.run("status", { instance: a.instance }, op));
  assert.equal(back.state, "running");
  assert.equal(back.generation, gen + 1, "nothing of A ran (the shared bus is the project's): a start from nothing is a new generation");
  assert.deepEqual(await engine.reconcile(), [], "a second reconcile has nothing to do");
});

// A hang guard only, never a speed bound: conform starts and stops every service several times.
test("conform passes on the fixture: two copies, every verb twice, isolation, nothing left", { timeout: 300_000 }, async () => {
  const r = shaped(await engine.run("conform", { project }, op));
  assert.equal(r.ok, true, `${r.error?.message}\n${JSON.stringify(r.conform?.checks, null, 1)}`);
  assert.equal(r.conform?.pass, true);
  assert.deepEqual(r.conform?.leaks, []);
  const ids = r.conform!.checks.map((c) => c.id);
  for (const id of ["create-a", "create-a-again", "setup-twice", "doctor", "up-a", "ports-owned", "up-a-again", "status-a", "up-b-parallel", "lock-busy", "disjoint", "isolation", "apply-a", "logs-a", "reset-a", "down-a", "down-a-again", "teardown", "teardown-again", "no-leaks"])
    assert.ok(ids.includes(id), `check ${id} ran`);
  assert.match(r.conform!.checks.find((c) => c.id === "isolation")!.detail, /read in B 1/);
  // Suite 3: each share endpoint answers through the preview proxy's request path, no link minted.
  assert.match(r.conform!.checks.find((c) => c.id === "share-endpoints")!.detail, /^web\.http \(port \d+\): GET \/ through the preview proxy answered 200; site\.http \(port \d+\): GET \/ through the preview proxy answered 200$/);
  // Suite 4: the entry point answers in A, its content type named (a page, not the web's plain-text root).
  assert.equal(r.conform!.suiteVersion, 4);
  assert.match(r.conform!.checks.find((c) => c.id === "open")!.detail, /^web\.http \(port \d+\): GET \/home answered 200 \(text\/html\)$/);
  assert.equal(git(["branch", "--list", "sova/conform-*"]).trim(), "", "scratch branches are gone");
});
