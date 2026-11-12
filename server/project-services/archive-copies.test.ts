import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { exitOf, httpStatusOf } from "../../shared/project-contract";
import type { AdoptedStatus } from "./drivers";
import { ARCHIVED_REFUSAL, ProjectEngine, type Caller } from "./engine";
import { FakeHost } from "./fake-host";
import { readRegistry, sharedIdOf } from "./store";

/**
 * Archiving a project with running copies (§app.organizations/archive) and the start limit's give-up
 * (§app.project-services/supervisor), on a host in memory (fake-host.ts): which copies an archive waits
 * for and how each is stopped, what an archived project refuses, and what reconcile leaves alone.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-archive-copies-agent-"));

const op: Caller = { kind: "operator" };
const BASE = 23_000;
const UNIT = "sova-archive-standin.service";
const host = new FakeHost();
const archived = new Set<string>();
let adopted: AdoptedStatus = { state: "active", pid: process.pid, startedAt: null, rssBytes: null };
let parent = "";
let demo = "";
let self = "";
let engine: ProjectEngine;

function repo(dir: string, def: unknown) {
  mkdirSync(join(dir, ".sova"), { recursive: true });
  writeFileSync(join(dir, ".sova", "project.json"), JSON.stringify(def));
  for (const f of ["bus.mjs", "web.mjs"]) writeFileSync(join(dir, f), "");
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
}

before(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-archive-copies-")));
  demo = join(parent, "demo");
  self = join(parent, "self");
  repo(demo, {
    version: 1,
    slots: { cap: 4 },
    test: { run: ["node", "-e", "0"], smoke: ["all"] },
    data: { store: { kind: "dir" } },
    services: {
      bus: { cmd: ["node", "bus.mjs"], scope: "shared", ports: { tcp: { fixed: BASE + 5 } } },
      web: { cmd: ["node", "web.mjs"], ports: { http: { base: BASE + 20 } }, requires: ["bus"], ready: { tcp: "http", timeout: 5 } },
    },
  });
  repo(self, {
    version: 1,
    slots: { cap: 2 },
    services: { server: { cmd: ["node", "web.mjs"], ports: { http: { base: BASE + 60, stride: 10 } }, adopt: { unit: UNIT, ports: { http: BASE + 50 } } } },
  });
  host.listen(BASE + 50, process.pid, self);
  engine = new ProjectEngine(host.deps({ adoptedStatus: async () => adopted, projectArchived: async (root) => archived.has(root), selfCheckout: () => null }));
});

after(() => {
  rmSync(parent, { recursive: true, force: true });
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
});

let a = "";
let b = "";

test("the copies an archive waits for: each running copy and the shared services, a failing one about to restart too, each with the down that stops it", async () => {
  assert.deepEqual(await engine.liveCopies(demo), [], "nothing runs yet");
  const ua = await engine.run("up", { project: demo, branch: "sova/a" }, op);
  assert.equal(ua.ok, true, ua.error?.message);
  a = ua.instance!;
  const ub = await engine.run("up", { project: demo, branch: "sova/b" }, op);
  assert.equal(ub.ok, true, ub.error?.message);
  b = ub.instance!;
  host.driver.restarting(engine.unitOf(b, "web"));
  const copies = await engine.liveCopies(demo);
  assert.deepEqual(
    copies.map((c) => [c.instance, c.name, c.services, c.adopted, c.down]),
    [
      [a, "sova/a", [{ name: "web", state: "running" }], false, { instance: a, confirm: true }],
      [b, "sova/b", [{ name: "web", state: "restarting" }], false, { instance: b, confirm: true }],
      [null, "Shared services", [{ name: "bus", state: "running" }], false, { project: demo, shared: true, confirm: true }],
    ],
  );
});

test("a copy that gave up restarting is failed, not listed, and holds no archive up", async () => {
  host.driver.giveUp(engine.unitOf(b, "web"));
  const st = await engine.run("status", { instance: b }, op);
  assert.equal(st.services.find((s) => s.name === "web")?.state, "failed");
  assert.equal(st.services.find((s) => s.name === "web")?.gaveUp, true, "marked for the Failed chip");
  assert.equal(st.services.find((s) => s.name === "web")?.detail, "start limit hit");
  assert.deepEqual(
    (await engine.liveCopies(demo)).map((c) => c.instance),
    [a, null],
  );
});

test("reconcile leaves a service that gave up failed, until an up starts it", async () => {
  const gen = readRegistry().instances.find((i) => i.id === b)!.generation;
  const did = await engine.reconcile();
  assert.ok(did.includes(`${b}: left web failed (it gave up restarting; it starts again on up)`), JSON.stringify(did));
  assert.ok(!did.some((d) => d.startsWith(`${b}: started`)), JSON.stringify(did));
  assert.equal((await host.driver.status(engine.unitOf(b, "web"))).gaveUp, true, "still given up");
  assert.equal(readRegistry().instances.find((i) => i.id === b)!.generation, gen, "nothing started: no new generation");
  const up = await engine.run("up", { instance: b }, op);
  assert.equal(up.ok, true, up.error?.message);
  const st = await host.driver.status(engine.unitOf(b, "web"));
  assert.equal(st.state, "active", "up starts it again");
  assert.equal(st.gaveUp, undefined, "and clears it");
  assert.equal((await engine.run("status", { instance: b }, op)).services.find((s) => s.name === "web")?.gaveUp, undefined);
});

test("an archived project refuses create, up, apply, test and reset of its copies; down, status and logs still run", async () => {
  archived.add(demo);
  try {
    for (const [verb, body] of [
      ["create", { project: demo, branch: "sova/c" }],
      ["up", { instance: a }],
      ["up", { project: demo }],
      ["apply", { instance: a }],
      ["test", { instance: a }],
      ["reset", { instance: a }],
    ] as const) {
      const r = await engine.run(verb, body, op);
      assert.equal(r.error?.code, "refused-archived", `${verb}: ${JSON.stringify(r.error)}`);
      assert.equal(r.error?.message, ARCHIVED_REFUSAL);
      assert.equal(r.error?.message, "This project is archived; unarchive it first");
      assert.equal(r.steps.length, 0, `${verb} did nothing`);
      assert.equal(exitOf(r), 2);
      assert.equal(httpStatusOf(r), 409);
    }
    assert.ok(!readRegistry().instances.some((i) => i.branch === "sova/c"), "no copy was made");
    // Every caller: a coding session's own worktree too.
    const session: Caller = { kind: "session", id: "s1", root: demo, own: [readRegistry().instances.find((i) => i.id === a)!.checkout] };
    assert.equal((await engine.run("up", { instance: a }, session)).error?.code, "refused-archived");
    assert.equal((await engine.run("status", { instance: a }, op)).ok, true);
    assert.equal((await engine.run("logs", { instance: a }, op)).ok, true);

    // Reconcile starts nothing in it and stops nothing (what still runs keeps running).
    host.driver.crash(engine.unitOf(b, "web"));
    const did = await engine.reconcile();
    assert.ok(did.includes(`${b}: left web stopped (the project is archived)`), JSON.stringify(did));
    assert.equal((await host.driver.status(engine.unitOf(a, "web"))).state, "active", "a's web still runs");
    assert.equal((await host.driver.status(engine.unitOf(b, "web"))).state, "failed", "b's is not started again");

    // The dialog's stops: each copy's down as listed, the shared services' with its confirm.
    for (const c of await engine.liveCopies(demo)) {
      assert.ok(c.down, c.name);
      const r = await engine.run("down", c.down, op);
      assert.equal(r.ok, true, `${c.name}: ${r.error?.message}`);
    }
    assert.deepEqual(await engine.liveCopies(demo), [], "nothing runs: an archive may go ahead");
    assert.equal((await host.driver.status(engine.unitOf(sharedIdOf(demo), "bus"))).state, "missing", "the shared bus stopped");
  } finally {
    archived.delete(demo);
  }
  const back = await engine.run("up", { instance: a }, op);
  assert.equal(back.ok, true, `unarchived, it starts again: ${back.error?.message}`);
  await engine.run("down", { instance: a }, op);
  await engine.run("down", { instance: a, services: ["bus"], confirm: true }, op);
});

test("the shared services' down without confirm needs it: the dialog's click is what confirms", async () => {
  await engine.run("up", { instance: a }, op);
  const shared = (await engine.liveCopies(demo)).find((c) => c.instance === null)!;
  const { confirm: _, ...bare } = shared.down!;
  assert.equal((await engine.run("down", bare, op)).error?.code, "needs-confirm");
  for (const c of await engine.liveCopies(demo)) assert.equal((await engine.run("down", c.down!, op)).ok, true);
  assert.deepEqual(await engine.liveCopies(demo), []);
});

test("an adopted main copy is listed as running outside Sova, with no down, and never holds an archive up", async () => {
  const c = await engine.run("create", { project: self }, op);
  assert.equal(c.ok, true, c.error?.message);
  const copies = await engine.liveCopies(self);
  assert.deepEqual(copies, [
    { instance: c.instance, name: "Main copy", branch: "main", checkout: self, slot: 0, services: [{ name: "server", state: "running", adopted: true }], adopted: true, down: null },
  ]);
  adopted = { state: "activating", pid: null, startedAt: null, rssBytes: null, detail: "activating/auto-restart" };
  assert.deepEqual((await engine.liveCopies(self))[0]!.services, [{ name: "server", state: "restarting", adopted: true }]);
  adopted = { state: "inactive", pid: null, startedAt: null, rssBytes: null };
  assert.deepEqual(await engine.liveCopies(self), [], "stopped outside Sova: not listed");
});

test("an archived project with shared services running and no copy: the shared row's down needs no copy, stops them, and reconcile leaves them stopped", async () => {
  // A copy starts the shared bus; tearing every copy down leaves the bus running with no copy to go through.
  const up = await engine.run("up", { project: demo, branch: "sova/lone" }, op);
  assert.equal(up.ok, true, up.error?.message);
  for (const i of readRegistry().instances.filter((x) => x.project === demo)) {
    const t = await engine.run("teardown", { instance: i.id, confirm: true }, op);
    assert.equal(t.ok, true, `${i.id}: ${t.error?.message}`);
  }
  assert.ok(!readRegistry().instances.some((i) => i.project === demo), "no copy of the project is left");
  const bus = engine.unitOf(sharedIdOf(demo), "bus");
  assert.equal((await host.driver.status(bus)).state, "active", "the shared bus still runs");
  archived.add(demo);
  try {
    const copies = await engine.liveCopies(demo);
    assert.deepEqual(copies, [{ instance: null, name: "Shared services", branch: null, checkout: demo, slot: null, services: [{ name: "bus", state: "running" }], adopted: false, down: { project: demo, shared: true, confirm: true } }]);
    // Only the operator, confirmed: a coding session or an unconfirmed down is refused before anything stops.
    const session: Caller = { kind: "session", id: "s1", root: demo, own: [] };
    assert.equal((await engine.run("down", copies[0]!.down, session)).error?.code, "needs-confirm");
    assert.equal((await engine.run("down", { project: demo, shared: true }, op)).error?.code, "needs-confirm");
    assert.equal((await engine.run("down", { project: demo, shared: true, instance: "x", confirm: true }, op)).error?.code, "invalid-request");
    assert.equal((await engine.run("up", { project: demo, shared: true }, op)).error?.code, "invalid-request");
    assert.equal((await host.driver.status(bus)).state, "active", "still running after the refusals");
    // The dialog's (and the archived page's) Stop: allowed while archived.
    const r = await engine.run("down", copies[0]!.down, op);
    assert.equal(r.ok, true, r.error?.message);
    assert.ok(r.steps.some((x) => x.id === "stop:bus" && x.result === "done"), JSON.stringify(r.steps));
    assert.equal((await host.driver.status(bus)).state, "missing", "the shared bus stopped");
    assert.equal(readRegistry().shared.find((x) => x.project === demo)?.desired.bus, "stopped", "marked stopped");
    assert.deepEqual(await engine.liveCopies(demo), [], "nothing runs: an archive may go ahead");
  } finally {
    archived.delete(demo);
  }
  await engine.reconcile();
  assert.equal((await host.driver.status(bus)).state, "missing", "reconcile doesn't start it again");
});
