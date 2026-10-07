import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { exitOf, isVerbResult, type VerbResult } from "../../shared/project-contract";
import { SelectedDriver } from "./adapters";
import { DetachedDriver, SystemdDriver } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";
import { FakeHost } from "./fake-host";
import { readRegistry } from "./store";
import { approve, defHashOf } from "./trust";
import { parseDefinition } from "../../shared/project-contract";

/**
 * The verbs' decisions on a host in memory (fake-host.ts): no process starts and no port opens. The real
 * services, readiness probes, signals, static serves and conform run in engine.integration.test.ts.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-engine-agent-"));

const op: Caller = { kind: "operator" };
const BASE = 21_000;
const PORTS = { web: BASE + 20, bus: BASE + 40 };

let parent = "";
let project = "";
let host: FakeHost;
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
  },
  hooks: { probe: { run: ["node", "probe.mjs"] } },
  share: { endpoints: ["web.http"] },
  open: { endpoint: "web.http", path: "/home" },
};

const FILES: Record<string, string> = {
  "setup.mjs": "// run by the fake driver's runOnce, never by node",
  "bus.mjs": "",
  "web.mjs": "",
  "probe.mjs": "",
  ".gitignore": ".agent/\n",
};

/** probe.mjs as the fake driver runs it: `write <token>` writes it in the store, `read <token>` exits 0 when it is there. */
function fakeOnce(spec: { argv: string[]; env: Record<string, string> }) {
  if (spec.argv[1] !== "probe.mjs") return { code: 0 };
  const [op, token] = spec.argv.slice(2);
  const f = join(spec.env.SOVA_DATA!, "store", token!);
  if (op === "write") {
    writeFileSync(f, "1");
    return { code: 0 };
  }
  return { code: existsSync(f) ? 0 : 1 };
}

before(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-engine-proj-")));
  project = join(parent, "demo");
  mkdirSync(join(project, ".sova"), { recursive: true });
  for (const [f, body] of Object.entries(FILES)) writeFileSync(join(project, f), body);
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(DEF, null, 2));
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  host = new FakeHost();
  host.driver.once = fakeOnce;
  engine = new ProjectEngine(host.deps());
});

after(() => {
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
  assert.deepEqual(host.driver.running(), [], "nothing started");
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
  assert.deepEqual(host.driver.onceRuns.map((r) => [r.argv.join(" "), r.cwd]), [["node setup.mjs", a.checkout]], "setup ran once, in the copy");
  assert.equal(a.data.find((d) => d.name === "cache")?.ref, join(a.checkout!, ".agent"));
  assert.ok(a.data.every((d) => d.exists));
  const again = shaped(await engine.run("create", { project, branch: "sova/a" }, op));
  assert.equal(again.instance, a.instance);
  assert.equal(again.changed, false);
  assert.ok(again.steps.every((s) => s.result === "skipped"), JSON.stringify(again.steps));
  assert.equal(host.driver.onceRuns.length, 1, "setup did not run again");
});

test("up starts shared services first, waits for readiness; again leaves the same pids", async () => {
  // web answers its health path only after two polls: up waits for it.
  let polls = 0;
  host.httpOk = (_port, path) => path === "/health" && ++polls > 2;
  const up = shaped(await engine.run("up", { instance: a.instance }, op));
  host.httpOk = () => true;
  assert.equal(up.ok, true, JSON.stringify(up.error));
  assert.equal(up.state, "running");
  assert.equal(up.generation, 1);
  assert.deepEqual(up.steps.filter((s) => s.kind === "start").map((s) => s.id), ["start:bus", "start:web"]);
  assert.deepEqual(up.steps.filter((s) => s.kind === "ready").map((s) => [s.id, s.result, s.detail]), [["ready:bus", "done", `tcp :${PORTS.bus}`], ["ready:web", "done", `http :${PORTS.web + 1}/health`]]);
  assert.ok(polls >= 3, `web's health was asked until it answered (${polls})`);
  const web = up.services.find((s) => s.name === "web")!;
  assert.deepEqual(web.ports, { http: PORTS.web + 1 });
  assert.equal(host.portOwner(PORTS.web + 1) !== "none" && (host.portOwner(PORTS.web + 1) as { pid: number }).pid, web.pid, "web listens on its slot's port");
  const again = shaped(await engine.run("up", { instance: a.instance }, op));
  assert.equal(again.changed, false);
  assert.equal(again.generation, 1);
  assert.deepEqual(again.services.map((s) => s.pid), up.services.map((s) => s.pid));
  const st = shaped(await engine.run("status", { instance: a.instance }, op));
  assert.deepEqual(st.services.map((s) => [s.name, s.state]), [["bus", "ready"], ["web", "ready"]]);
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
  const web = shaped(await engine.run("status", { instance: a.instance }, op)).services.find((s) => s.name === "web")!;
  host.driver.onSignal = (unit, sig) => host.driver.log(unit, sig === "HUP" ? "reloaded" : `got ${sig}`);
  const r = shaped(await engine.run("apply", { instance: a.instance, services: ["web"] }, op));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.steps.map((s) => [s.id, s.result]), [["reload:web", "done"], ["ready:web", "done"]]);
  assert.equal(r.services.find((s) => s.name === "web")!.pid, web.pid, "a signal keeps the process");
  assert.deepEqual(host.driver.signalsOf(web.unit!), ["HUP"]);
  const logs = shaped(await engine.run("logs", { instance: a.instance, services: ["web"] }, op));
  assert.ok(logs.lines?.some((l) => l.text === "reloaded"), JSON.stringify(logs.lines));
});

test("a port something else holds refuses the start and is never touched", async () => {
  const b = shaped(await engine.run("create", { project, branch: "sova/b" }, op));
  assert.equal(b.slot, 2);
  const squatter = { pid: 4_242, cwd: "/elsewhere" };
  host.listen(PORTS.web + 2, squatter.pid, squatter.cwd);
  try {
    const up = shaped(await engine.run("up", { instance: b.instance }, op));
    assert.equal(up.error?.code, "port-held");
    assert.match(up.error!.message, /pid 4242 \(\/elsewhere\)/);
    assert.equal(exitOf(up), 2);
    assert.deepEqual(host.listeners.get(PORTS.web + 2), squatter, "the holder still listens");
    assert.ok(!up.steps.some((s) => s.id === "start:web" && s.result === "done"), "web never started");
  } finally {
    host.close(PORTS.web + 2);
  }
  const up = shaped(await engine.run("up", { instance: b.instance }, op));
  assert.equal(up.ok, true, JSON.stringify(up.error));
  assert.equal(up.steps.find((s) => s.id === "start:bus")?.result, "skipped", "the shared bus is already up");
  const td = shaped(await engine.run("teardown", { instance: b.instance }, op));
  assert.equal(td.ok, true);
  assert.equal(host.portOwner(PORTS.web + 2), "none", "its process is gone with it");
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
  const d = await engine.run("down", { instance: a.instance, services: ["web"] }, po());
  assert.equal(d.ok, true, JSON.stringify(d.error));
  assert.deepEqual(acts, [`down:${a.instance}`]);
  assert.equal((await engine.run("up", { instance: a.instance }, op)).ok, true);
});

test("with no supervisor reachable, process verbs are unsupported and change nothing", async () => {
  const bare = new ProjectEngine(host.deps({ driver: new SystemdDriver(async () => ({ code: 1, stdout: "", stderr: "Failed to connect to bus" })) }));
  const before = readRegistry().instances.length;
  const r = shaped(await bare.run("up", { project, branch: "sova/nobus" }, op));
  assert.equal(r.error?.code, "unsupported");
  assert.match(r.error!.message, /no systemd user manager reachable/);
  assert.equal(exitOf(r), 2);
  assert.equal(readRegistry().instances.length, before, "nothing was made");
  assert.ok(!existsSync(join(parent, ".worktrees", "demo-nobus")));
});

test("doctor and status name the supervisor adapter and why; a reserved adapter leaves process verbs unsupported", async () => {
  // The detached driver is only asked whether it is available: nothing starts.
  const sel = new ProjectEngine(host.deps({ driver: new SelectedDriver({ env: { SOVA_PROJECT_NO_SYSTEMD: "1" }, detached: () => new DetachedDriver() }) }));
  const doc = shaped(await sel.run("doctor", { project }, op));
  const sup = doc.checks!.find((c) => c.id === "supervisor")!;
  assert.equal(sup.ok, true);
  // Linux reads /proc; macOS's ps has no session column (§app.project-services/supervisor).
  const reads = process.platform === "linux" ? "\\/proc" : "ps \\(no session ids: process trees and groups\\)";
  assert.match(sup.detail, new RegExp(`^detached: detached sessions, processes read from ${reads}; chosen because systemd treated as absent \\(SOVA_PROJECT_NO_SYSTEMD=1\\)$`));
  const st = shaped(await sel.run("status", { project }, op));
  assert.deepEqual(st.checks, [sup], "status carries the same check");
  const launchd = new ProjectEngine(host.deps({ driver: new SelectedDriver({ env: { SOVA_PROJECT_DRIVER: "launchd" } }) }));
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

test("deploy verbs without a deployer, and malformed requests", async () => {
  const r = shaped(await engine.run("deploy.run", { project }, op));
  assert.equal(r.error?.code, "unsupported");
  assert.equal(exitOf(r), 2);
  assert.equal((await engine.run("deploy", { project }, op)).error?.code, "invalid-request", "the bare name is no verb");
  assert.equal((await engine.run("explode", { project }, op)).error?.code, "invalid-request");
  assert.equal((await engine.run("up", { project, bogus: 1 }, op)).error?.code, "invalid-request");
  assert.equal((await engine.run("up", { instance: "nope-00000000" }, op)).error?.code, "not-found");
  assert.equal(exitOf(await engine.run("up", { instance: "nope-00000000" }, op)), 3);
});

test("reconcile brings an instance back to what it should be doing", async () => {
  const st = shaped(await engine.run("status", { instance: a.instance }, op));
  const web = st.services.find((s) => s.name === "web")!;
  // A process that died meanwhile.
  host.driver.crash(web.unit!);
  assert.equal(shaped(await engine.run("status", { instance: a.instance }, op)).state, "degraded");
  const gen = st.generation!;
  const did = await engine.reconcile();
  assert.ok(did.some((d) => d.includes("started web")), JSON.stringify(did));
  const back = shaped(await engine.run("status", { instance: a.instance }, op));
  assert.equal(back.state, "running");
  assert.notEqual(back.services.find((s) => s.name === "web")!.pid, web.pid, "a new process");
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
