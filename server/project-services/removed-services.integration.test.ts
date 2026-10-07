import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { parseDefinition, type VerbResult } from "../../shared/project-contract";
import { staticServes, stopStaticServe } from "../preview-serve";
import type { ContainerQuery } from "./container-ports";
import { DetachedDriver } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";
import { readRegistry } from "./store";
import { approve, defHashOf } from "./trust";
import { reservePorts } from "../test-ports";

/**
 * A service that left `.sova/project.json` (§app.project-services/down, /up, /apply, /teardown,
 * /reconcile): down and teardown stop it by unit and by its recorded container, up and apply stop
 * it and say so, and reconcile never starts it again, even once a later definition declares it.
 * Detached driver; the container engine is faked (`box` is a plain process standing in for one). The other
 * decisions run on a host in memory in removed-services.test.ts.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-removed-agent-"));

const op: Caller = { kind: "operator" };
/** Below the kernel's ephemeral range (32768+), and free now: a random port there can be any outgoing socket's. */
let BASE = 0;
const ENGINE = "podman";

const full = () => ({
  version: 1,
  slots: { cap: 2 },
  services: {
    site: { static: "public", ports: { http: { base: BASE } } },
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

/** Write and approve `def` in `checkout`. */
const define = (def: object, checkout = project) => {
  writeFileSync(join(checkout, ".sova", "project.json"), JSON.stringify(def, null, 2));
  const hash = defHashOf(parseDefinition(JSON.stringify(def)));
  approve(project, hash, hash);
};
const recOf = (id: string) => readRegistry().instances.find((i) => i.id === id)!;
const unitState = async (id: string, svc: string) => (await engine.driver.status(engine.unitOf(id, svc))).state;
const live = (s: string) => s === "active" || s === "activating";
const stepOf = (r: VerbResult, id: string) => r.steps.find((s) => s.id === id);

before(async () => {
  BASE = await reservePorts(42);
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
  engine = new ProjectEngine({ driver: new DetachedDriver(3_000), pollMs: 100, containerQuery: fakeQuery, containerExec: fakeExec });
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
