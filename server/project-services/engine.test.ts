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
import { SelectedDriver } from "./adapters";
import { DetachedDriver, SystemdDriver } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";
import { readRegistry, sharedIdOf } from "./store";
import { approve, defHashOf } from "./trust";
import { parseDefinition } from "../../shared/project-contract";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-engine-agent-"));

const op: Caller = { kind: "operator" };
const BASE = 30_000 + Math.floor(Math.random() * 20_000);
const PORTS = { site: BASE, web: BASE + 20, bus: BASE + 40 };

let parent = "";
let project = "";
let engine: ProjectEngine;
const git = (args: string[], cwd = project) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

const DEF = {
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
};

const FILES: Record<string, string> = {
  "setup.mjs": `import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync(process.env.SOVA_DATA, { recursive: true }); writeFileSync(process.env.SOVA_DATA + "/setup-ran", "yes");`,
  "bus.mjs": `import { createServer } from "node:net"; createServer((s) => s.end()).listen(Number(process.env.SOVA_PORT_TCP), "127.0.0.1"); console.log("bus up");`,
  "web.mjs": `import { createServer } from "node:http"; process.on("SIGHUP", () => console.log("reloaded")); createServer((q, r) => { r.end(q.url === "/health" ? "ok" : "web " + process.env.SOVA_INSTANCE); }).listen(Number(process.env.SOVA_PORT_HTTP), "127.0.0.1", () => console.log("web up on", process.env.SOVA_PORT_HTTP));`,
  "probe.mjs": `import { existsSync, writeFileSync } from "node:fs"; const [op, token] = process.argv.slice(2); const f = process.env.SOVA_DATA + "/store/" + token; if (op === "write") writeFileSync(f, "1"); else process.exit(existsSync(f) ? 0 : 1);`,
  "public/index.html": "<h1>site</h1>",
  ".gitignore": ".agent/\n",
};

before(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-engine-proj-")));
  project = join(parent, "demo");
  mkdirSync(join(project, ".sova"), { recursive: true });
  mkdirSync(join(project, "public"), { recursive: true });
  for (const [f, body] of Object.entries(FILES)) writeFileSync(join(project, f), body);
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(DEF, null, 2));
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  engine = new ProjectEngine({ driver: new DetachedDriver(3_000), pollMs: 100 });
  engine.conformer = conformer(engine);
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

test("nothing runs before the operator approves the definition's hash", async () => {
  const r = shaped(await engine.run("up", { project, branch: "sova/a" }, op));
  assert.equal(r.error?.code, "not-approved");
  assert.equal(exitOf(r), 2);
  assert.equal(readRegistry().instances.length, 0, "nothing was made");
  assert.ok(!existsSync(join(parent, ".worktrees")), "no worktree was cut");
  const d = shaped(await engine.run("doctor", { project }, op));
  assert.equal(d.ok, false);
  assert.equal(d.checks?.find((c) => c.id === "approved")?.ok, false);
  assert.equal(exitOf(d), 0, "doctor reports; it does not fail");
  const hash = defHashOf(parseDefinition(readFileSync(join(project, ".sova/project.json"), "utf8")));
  assert.throws(() => approve(project, "sha256:other", hash), /changed since it was shown/);
  approve(project, hash, hash);
});

let a: VerbResult;

test("create cuts a worktree, allocates a slot, provisions data and runs setup; again changes nothing", async () => {
  a = shaped(await engine.run("create", { project, branch: "sova/a" }, op));
  assert.equal(a.ok, true, JSON.stringify(a.error));
  assert.equal(a.slot, 1);
  assert.equal(a.state, "stopped");
  assert.ok(existsSync(join(a.checkout!, "web.mjs")));
  assert.deepEqual(a.steps.map((s) => [s.id, s.result]), [["slot", "done"], ["worktree", "done"], ["data:store", "done"], ["data:cache", "done"], ["setup:mark", "done"]]);
  assert.equal(a.data.find((d) => d.name === "cache")?.ref, join(a.checkout!, ".agent"));
  assert.ok(a.data.every((d) => d.exists));
  const again = shaped(await engine.run("create", { project, branch: "sova/a" }, op));
  assert.equal(again.instance, a.instance);
  assert.equal(again.changed, false);
  assert.ok(again.steps.every((s) => s.result === "skipped"), JSON.stringify(again.steps));
});

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

test("a second verb on a busy instance answers busy at once", async () => {
  const [x, y] = await Promise.all([engine.run("apply", { instance: a.instance, restart: true }, op), engine.run("apply", { instance: a.instance }, op)]);
  const codes = [x.error?.code, y.error?.code];
  assert.deepEqual(codes.filter((c) => c === "busy").length, 1, JSON.stringify(codes));
  const busy = [x, y].find((r) => r.error?.code === "busy")!;
  assert.equal(exitOf(busy), 4);
  assert.ok(busy.steps.length === 0, "the refused call did nothing");
  const won = [x, y].find((r) => r !== busy)!;
  assert.equal(won.ok, true, `the other call ran: ${JSON.stringify(won.error)} ${JSON.stringify(won.steps)}`);
  assert.equal(won.state, "running", JSON.stringify(won.services));
});

test("apply signals a service whose reload is a signal, and waits for readiness again", async () => {
  const before = shaped(await engine.run("status", { instance: a.instance }, op)).services.find((s) => s.name === "web")!.pid;
  const r = shaped(await engine.run("apply", { instance: a.instance, services: ["web"] }, op));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.steps.map((s) => [s.id, s.result]), [["reload:web", "done"], ["ready:web", "done"]]);
  assert.equal(r.services.find((s) => s.name === "web")!.pid, before, "a signal keeps the process");
  const logs = shaped(await engine.run("logs", { instance: a.instance, services: ["web"] }, op));
  for (let i = 0; i < 20 && !logs.lines?.some((l) => l.text === "reloaded"); i++) {
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

test("who may call what", async () => {
  const other: Caller = { kind: "session", id: "s1", root: project, own: ["/elsewhere"] };
  assert.equal((await engine.run("up", { instance: a.instance }, other)).error?.code, "forbidden");
  assert.equal((await engine.run("status", { instance: a.instance }, other)).ok, true, "reads are free in its project");
  const owner: Caller = { kind: "session", id: "s1", root: project, own: [a.checkout!] };
  assert.equal((await engine.run("up", { instance: a.instance }, owner)).ok, true);
  assert.equal((await engine.run("teardown", { instance: a.instance }, owner)).error?.code, "needs-confirm", "not its creation");
  assert.equal((await engine.run("up", { project }, { kind: "session", id: "s1", root: project, own: [project] })).error?.code, "forbidden", "never the main checkout");
  assert.equal((await engine.run("status", { project }, { kind: "session", id: "s2", root: "/other", own: [] })).error?.code, "forbidden");
  // The project overseer's level is its statechart's act, sent after the engine's own checks and before anything
  // changes; a refusal passes through as thrown, and nothing runs.
  const acts: string[] = [];
  const po = (refuse?: Error): Caller => ({ kind: "project-overseer", id: "po", root: project, act: async (verb, instance) => {
    acts.push(`${verb}:${instance}`);
    if (refuse) throw refuse;
  } });
  const refused = new Error("the statechart refused it");
  assert.equal(shaped(await engine.run("status", { instance: a.instance }, op)).state, "running");
  await assert.rejects(() => engine.run("down", { instance: a.instance }, po(refused)), (e) => e === refused);
  assert.deepEqual(acts, [`down:${a.instance}`]);
  assert.equal(shaped(await engine.run("status", { instance: a.instance }, op)).state, "running", "nothing ran");
  assert.equal((await engine.run("status", { instance: a.instance }, po(refused))).ok, true, "a read is no act");
  await assert.rejects(() => engine.run("conform", { project }, po(refused)), (e) => e === refused);
  assert.deepEqual(acts, [`down:${a.instance}`, "conform:null"]);
  acts.length = 0;
  const taken = await engine.run("apply", { instance: a.instance }, po());
  assert.equal(taken.ok, true, JSON.stringify(taken.error));
  assert.deepEqual(acts, [`apply:${a.instance}`]);
  acts.length = 0;
  assert.equal((await engine.run("reset", { instance: a.instance }, po())).error?.code, "needs-confirm");
  assert.equal((await engine.run("up", { project: "/elsewhere" }, po())).error?.code, "not-found");
  assert.deepEqual(acts, [], "the engine's own refusals come first: no act");
  assert.equal((await engine.run("teardown", { instance: a.instance }, { kind: "overseer", id: "o" })).error?.code, "needs-confirm");
  assert.equal((await engine.run("down", { instance: a.instance, services: ["bus"] }, op)).error?.code, "needs-confirm", "a shared service needs the operator's confirm");
  assert.equal((await engine.run("down", { instance: a.instance, services: ["bus"] }, po())).error?.code, "needs-confirm");
  const d = await engine.run("down", { instance: a.instance, services: ["site"] }, po());
  assert.equal(d.ok, true, JSON.stringify(d.error));
  assert.deepEqual(acts, [`down:${a.instance}`]);
  assert.equal((await engine.run("up", { instance: a.instance }, op)).ok, true);
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
  const h = defHashOf(parseDefinition(JSON.stringify(def)));
  approve(site, h, h);
  const up = shaped(await bare.run("up", { project: site }, op));
  assert.equal(up.ok, true, JSON.stringify(up.error));
  assert.equal(await (await fetch(`http://127.0.0.1:${PORTS.site + 10}/`)).text(), "static");
  assert.equal(shaped(await bare.run("down", { instance: up.instance }, op)).state, "stopped");
});

test("doctor and status name the supervisor adapter and why; a reserved adapter leaves process verbs unsupported", async () => {
  const sel = new ProjectEngine({ driver: new SelectedDriver({ env: { SOVA_PROJECT_NO_SYSTEMD: "1" }, detached: () => engine.driver }), pollMs: 100 });
  const doc = shaped(await sel.run("doctor", { project }, op));
  const sup = doc.checks!.find((c) => c.id === "supervisor")!;
  assert.equal(sup.ok, true);
  assert.match(sup.detail, /^detached: detached sessions, processes read from \/proc; chosen because systemd treated as absent \(SOVA_PROJECT_NO_SYSTEMD=1\)$/);
  const st = shaped(await sel.run("status", { project }, op));
  assert.deepEqual(st.checks, [sup], "status carries the same check");
  const launchd = new ProjectEngine({ driver: new SelectedDriver({ env: { SOVA_PROJECT_DRIVER: "launchd" } }), pollMs: 100 });
  const before = readRegistry().instances.length;
  const r = shaped(await launchd.run("up", { project, branch: "sova/launchd" }, op));
  assert.equal(r.error?.code, "unsupported");
  assert.match(r.error!.message, /launchd adapter .* is reserved and not built yet/);
  assert.equal(readRegistry().instances.length, before, "nothing was made");
  const ls = shaped(await launchd.run("status", { project }, op));
  assert.equal(ls.ok, true, "status stays a read that succeeds");
  assert.equal(ls.checks![0]!.ok, false);
  assert.match(ls.checks![0]!.detail, /^launchd: no supervisor/);
});

test("reserved and malformed requests", async () => {
  for (const v of ["deploy", "deploy.run"]) {
    const r = shaped(await engine.run(v, { project }, op));
    assert.equal(r.error?.code, "unsupported", v);
    assert.equal(exitOf(r), 2);
  }
  assert.equal((await engine.run("explode", { project }, op)).error?.code, "invalid-request");
  assert.equal((await engine.run("up", { project, bogus: 1 }, op)).error?.code, "invalid-request");
  assert.equal((await engine.run("up", { instance: "nope-00000000" }, op)).error?.code, "not-found");
  assert.equal(exitOf(await engine.run("up", { instance: "nope-00000000" }, op)), 3);
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

test("reset gives fresh data; down keeps it; teardown deletes it and keeps the branch", async () => {
  const rec = readRegistry().instances.find((i) => i.id === a.instance)!;
  assert.equal(await engine.probeHook(rec, ["write", "tok"]), 0);
  assert.equal(await engine.probeHook(rec, ["read", "tok"]), 0);
  const rs = shaped(await engine.run("reset", { instance: a.instance }, op));
  assert.equal(rs.ok, true, JSON.stringify(rs.error));
  assert.equal(rs.state, "running");
  assert.notEqual(await engine.probeHook(rec, ["read", "tok"]), 0, "the token is gone");
  const dn = shaped(await engine.run("down", { instance: a.instance }, op));
  assert.equal(dn.state, "stopped");
  assert.ok(dn.data.every((d) => d.exists), "down keeps data");
  assert.equal(shaped(await engine.run("down", { instance: a.instance }, op)).changed, false);
  const td = shaped(await engine.run("teardown", { instance: a.instance }, op));
  assert.equal(td.ok, true, JSON.stringify(td.error));
  assert.equal(td.state, "absent");
  assert.ok(!existsSync(a.checkout!));
  assert.match(git(["branch", "--list", "sova/a"]), /sova\/a/, "the branch stays");
  const again = shaped(await engine.run("teardown", { project, instance: a.instance }, op));
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.equal(again.state, "absent");
  assert.equal(shaped(await engine.run("teardown", { instance: a.instance }, op)).state, "absent", "absent without the project too");
  const main = readRegistry().instances.find((i) => i.project === project && i.slot === 0);
  assert.equal(main, undefined);
  const m = shaped(await engine.run("create", { project }, op));
  assert.equal(m.slot, 0);
  assert.equal((await engine.run("teardown", { instance: m.instance }, op)).error?.code, "refused-slot0");
});

test("conform passes on the fixture: two copies, every verb twice, isolation, nothing left", async () => {
  const r = shaped(await engine.run("conform", { project }, op));
  assert.equal(r.ok, true, `${r.error?.message}\n${JSON.stringify(r.conform?.checks, null, 1)}`);
  assert.equal(r.conform?.pass, true);
  assert.deepEqual(r.conform?.leaks, []);
  const ids = r.conform!.checks.map((c) => c.id);
  for (const id of ["create-a", "create-a-again", "setup-twice", "doctor", "up-a", "ports-owned", "up-a-again", "status-a", "up-b-parallel", "lock-busy", "disjoint", "isolation", "apply-a", "logs-a", "reset-a", "down-a", "down-a-again", "teardown", "teardown-again", "no-leaks"])
    assert.ok(ids.includes(id), `check ${id} ran`);
  assert.match(r.conform!.checks.find((c) => c.id === "isolation")!.detail, /read in B 1/);
  assert.equal(git(["branch", "--list", "sova/conform-*"]).trim(), "", "scratch branches are gone");
});
