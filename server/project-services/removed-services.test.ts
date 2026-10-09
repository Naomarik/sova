import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { type VerbResult } from "../../shared/project-contract";
import { staticServes, stopStaticServe } from "../preview-serve";
import type { ContainerQuery } from "./container-ports";
import { FakeHost } from "./fake-host";
import { ProjectEngine, type Caller } from "./engine";
import { readRegistry } from "./store";

/**
 * A service that left `.sova/project.json` (§app.project-services/down, /up, /apply, /teardown,
 * /reconcile): down and teardown stop it by unit and by its recorded container, up and apply stop
 * it and say so, and reconcile never starts it again, even once a later definition declares it.
 * On a host in memory (fake-host.ts), `site` a process service here; the container engine is faked. The real
 * run (detached driver, a static `site`, `box` a plain process standing in for a container) is in
 * removed-services.integration.test.ts.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-removed-agent-"));

const op: Caller = { kind: "operator" };
const BASE = 21_000;
const ENGINE = "podman";

const full = () => ({
  version: 1,
  slots: { cap: 2 },
  services: {
    site: { cmd: ["node", "api.mjs"], ports: { http: { base: BASE } }, ready: { tcp: "http", timeout: 10 } },
    api: { cmd: ["node", "api.mjs"], ports: { http: { base: BASE + 20 } }, ready: { tcp: "http", timeout: 10 } },
    box: { cmd: ["node", "api.mjs"], container: { name: "rbox-${instance}", engine: ENGINE }, ports: { http: { base: BASE + 40 } }, ready: { tcp: "http", timeout: 10 } },
  },
});
const siteOnly = () => ({ version: 1, slots: { cap: 2 }, services: { site: full().services.site } });

let parent = "";
let project = "";
let engine: ProjectEngine;
/** Every `<engine> …` the engine ran. */
const execs: string[] = [];

const fakeQuery: ContainerQuery = async (_eng, args) => (args[0] === "ps" ? { code: 0, stdout: "" } : { code: 125, stdout: "" });
const fakeExec = async (eng: string, args: string[]) => {
  execs.push(`${eng} ${args.join(" ")}`);
  return 0;
};

/** Write `def` in `checkout`. */
const define = (def: object, checkout = project) => {
  writeFileSync(join(checkout, ".sova", "project.json"), JSON.stringify(def, null, 2));
};
const recOf = (id: string) => readRegistry().instances.find((i) => i.id === id)!;
const unitState = async (id: string, svc: string) => (await engine.driver.status(engine.unitOf(id, svc))).state;
const live = (s: string) => s === "active" || s === "activating";
const stepOf = (r: VerbResult, id: string) => r.steps.find((s) => s.id === id);

before(async () => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-removed-proj-")));
  project = join(parent, "demo");
  mkdirSync(join(project, ".sova"), { recursive: true });
  mkdirSync(join(project, "public"), { recursive: true });
  writeFileSync(join(project, "public", "index.html"), "<h1>site</h1>");
  writeFileSync(join(project, "api.mjs"), `import { createServer } from "node:net"; createServer((s) => s.end()).listen(Number(process.env.SOVA_PORT_HTTP), "127.0.0.1"); console.log("up");`);
  define(full());
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project });
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  engine = new ProjectEngine(new FakeHost().deps({ containerQuery: fakeQuery, containerExec: fakeExec }));
});

beforeEach(() => {
  execs.length = 0;
});

after(async () => {
  define(full());
  for (const i of readRegistry().instances) await engine.run(i.slot === 0 ? "down" : "teardown", { instance: i.id }, op);
  for (const i of readRegistry().instances) for (const svc of ["api", "box"]) await engine.driver.stop(engine.unitOf(i.id, svc));
  for (const s of staticServes()) await stopStaticServe(s.id);
  rmSync(parent, { recursive: true, force: true });
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
});

/** The main instance with every service of full() running. */
async function upFull(): Promise<string> {
  define(full());
  const r = await engine.run("up", { project }, op);
  assert.equal(r.state, "running", r.error?.message);
  return r.instance!;
}

test("down stops services that left the definition, by unit and by recorded container, and marks them stopped", async () => {
  const id = await upFull();
  assert.deepEqual(recOf(id).containers, { box: { engine: ENGINE, name: `rbox-${id}` } }, "the container a start ran as is recorded");
  define(siteOnly());
  execs.length = 0;
  const dn = await engine.run("down", { instance: id }, op);
  assert.equal(dn.ok, true, dn.error?.message);
  for (const svc of ["api", "box"]) {
    assert.equal(stepOf(dn, `stop:${svc}`)?.result, "done");
    assert.match(stepOf(dn, `stop:${svc}`)!.detail!, /no longer in the definition/);
    assert.ok(!live(await unitState(id, svc)), `${svc}'s unit is stopped`);
    assert.equal(recOf(id).desired[svc], "stopped");
  }
  assert.ok(execs.includes(`${ENGINE} rm -f rbox-${id}`), `the recorded container is removed: ${execs.join("; ")}`);
  assert.equal(recOf(id).desired.site, "stopped");
  const again = await engine.run("down", { instance: id }, op);
  assert.equal(again.changed, false, JSON.stringify(again.steps));

  // The definition brings them back: reconcile starts none of them (the live run revived api and box here).
  define(full());
  const did = await engine.reconcile();
  assert.ok(!did.some((d) => d.startsWith(id) && d.includes("started")), did.join("; "));
  for (const svc of ["api", "box"]) assert.ok(!live(await unitState(id, svc)), `${svc} stays down`);
});

test("down with an unreadable definition stops every service the record names, its container included", async () => {
  const id = await upFull();
  writeFileSync(join(project, ".sova", "project.json"), "{ not json");
  execs.length = 0;
  const dn = await engine.run("down", { instance: id }, op);
  assert.equal(dn.ok, true, dn.error?.message);
  for (const svc of ["api", "box"]) assert.ok(!live(await unitState(id, svc)));
  assert.ok(execs.includes(`${ENGINE} rm -f rbox-${id}`), execs.join("; "));
  assert.ok(Object.values(recOf(id).desired).every((d) => d === "stopped"), JSON.stringify(recOf(id).desired));
  define(full());
});

test("up stops and marks stopped what left the definition, says so, and is then idempotent", async () => {
  const id = await upFull();
  define(siteOnly());
  execs.length = 0;
  const up = await engine.run("up", { instance: id }, op);
  assert.equal(up.ok, true, up.error?.message);
  assert.equal(up.state, "running", "site is all the definition wants");
  assert.equal(up.changed, true);
  for (const svc of ["api", "box"]) {
    assert.equal(stepOf(up, `stop:${svc}`)?.result, "done");
    assert.match(stepOf(up, `stop:${svc}`)!.detail!, /no longer in the definition/);
    assert.ok(!live(await unitState(id, svc)));
    assert.equal(recOf(id).desired[svc], "stopped");
  }
  assert.ok(execs.includes(`${ENGINE} rm -f rbox-${id}`), execs.join("; "));
  const again = await engine.run("up", { instance: id }, op);
  assert.equal(again.changed, false, JSON.stringify(again.steps));
  assert.ok(!stepOf(again, "stop:api") && !stepOf(again, "stop:box"), "nothing left to stop");
  await engine.run("down", { instance: id }, op);
});

test("apply stops what left the definition too", async () => {
  const id = await upFull();
  define(siteOnly());
  const ap = await engine.run("apply", { instance: id }, op);
  assert.equal(ap.ok, true, ap.error?.message);
  for (const svc of ["api", "box"]) {
    assert.equal(stepOf(ap, `stop:${svc}`)?.result, "done");
    assert.ok(!live(await unitState(id, svc)));
    assert.equal(recOf(id).desired[svc], "stopped");
  }
  await engine.run("down", { instance: id }, op);
});

test("reconcile stops an orphan unit of a removed service and never starts one the definition lacks", async () => {
  const id = await upFull();
  // The server was away: the definition lost api and box, and box's process died meanwhile.
  define(siteOnly());
  await engine.driver.stop(engine.unitOf(id, "box"));
  execs.length = 0;
  const did = await engine.reconcile();
  assert.ok(did.includes(`${id}: stopped api (no longer in the definition)`), did.join("; "));
  assert.ok(did.includes(`${id}: stopped box (no longer in the definition)`), did.join("; "));
  assert.ok(!did.some((d) => d.includes("started api") || d.includes("started box")), did.join("; "));
  assert.ok(!live(await unitState(id, "api")));
  assert.ok(!live(await unitState(id, "box")));
  assert.ok(execs.includes(`${ENGINE} rm -f rbox-${id}`), execs.join("; "));
  assert.equal(recOf(id).desired.api, "stopped");
  assert.equal(recOf(id).desired.box, "stopped");
  assert.equal(recOf(id).desired.site, "running", "what the definition still declares is untouched");
  const again = await engine.reconcile();
  assert.ok(!again.some((d) => d.startsWith(id)), again.join("; "));
  define(full());
  await engine.run("down", { instance: id }, op);
});

test("teardown stops services that left the definition before it removes the instance", async () => {
  define(full());
  const up = await engine.run("up", { project, branch: "feat-gone" }, op);
  assert.equal(up.state, "running", up.error?.message);
  const id = up.instance!;
  const checkout = recOf(id).checkout;
  define(siteOnly(), checkout);
  execs.length = 0;
  const td = await engine.run("teardown", { instance: id }, op);
  assert.equal(td.ok, true, td.error?.message);
  assert.equal(td.state, "absent");
  for (const svc of ["api", "box"]) {
    assert.equal(stepOf(td, `stop:${svc}`)?.result, "done");
    assert.ok(!live(await unitState(id, svc)), `${svc}'s unit is stopped`);
  }
  assert.ok(execs.includes(`${ENGINE} rm -f rbox-${id}`), execs.join("; "));
});
