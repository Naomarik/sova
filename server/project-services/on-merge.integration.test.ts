import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DetachedDriver } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";
import { mainMoved, onMergeNotes, SYSTEM_ON_MERGE, withOnMerge, type OnMergeDeps } from "./on-merge";
import { readRegistry } from "./store";
import { reservePorts } from "../test-ports";

/**
 * onMerge (§app.project-services/on-merge): when main's HEAD moves, the main checkout's copy (slot 0)
 * reloads the running services that declare `onMerge: "reload"`, as the system caller, others untouched;
 * a first sight only records HEAD; a stopped service stays stopped; never on Sova's own checkout; each
 * outcome is a note in the project's feed. Real processes under the detached driver, a real git repo; the
 * other cases run on a host in memory in on-merge.test.ts.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-onmerge-agent-"));

let BASE = 0;
let parent = "";
let project = "";
let engine: ProjectEngine;
let self: string | null = null;
let file = "";
const op: Caller = { kind: "operator" };

const SERVER = `import { createServer } from "node:http";
createServer((_q, s) => s.end(String(process.pid))).listen(Number(process.env.PORT), "127.0.0.1");
`;

const defOf = (extra: Record<string, string> = {}) => ({
  version: 1,
  slots: { cap: 1 },
  services: {
    web: { cmd: ["node", "server.mjs"], env: { PORT: "${ports.web.http}", ...extra }, ports: { http: { base: BASE } }, ready: { http: "http" }, reload: "restart", onMerge: "reload" },
    api: { cmd: ["node", "server.mjs"], env: { PORT: "${ports.api.http}" }, ports: { http: { base: BASE + 10 } }, ready: { http: "http" }, reload: "restart" },
  },
});

const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project, encoding: "utf8" }).trim();
/** A commit on main, as a hand merge or a release would make one. */
function commit(name: string, content = name): void {
  writeFileSync(join(project, name), content);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", name]);
}
function writeDef(def: object): void {
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(def));
}
const pidOn = async (port: number): Promise<string> => (await (await fetch(`http://127.0.0.1:${port}/`)).text()).trim();
const deps = (): Partial<OnMergeDeps> => ({ run: (verb, body, caller) => engine.run(verb, body, caller), selfCheckout: () => self, file });

before(async () => {
  BASE = await reservePorts(14);
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-onmerge-proj-")));
  project = join(parent, "shop");
  file = join(parent, "on-merge.json");
  mkdirSync(join(project, ".sova"), { recursive: true });
  writeFileSync(join(project, "server.mjs"), SERVER);
  writeDef(defOf());
  git(["init", "-q", "-b", "main"]);
  commit(".gitignore", "");
  engine = new ProjectEngine({ driver: new DetachedDriver(3_000), pollMs: 50, selfCheckout: () => self, hostBusy: () => null });
});

after(async () => {
  for (const i of readRegistry().instances) await engine.run("down", { instance: i.id, confirm: true }, op);
  rmSync(parent, { recursive: true, force: true });
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
});

test("main moved: the main checkout's copy reloads only its running onMerge services, as the system caller, with a note", async () => {
  const up = await engine.run("up", { project }, op);
  assert.equal(up.state, "running", up.error?.message);
  assert.equal(up.slot, 0);
  const web0 = await pidOn(BASE);
  const api0 = await pidOn(BASE + 10);

  assert.equal(await mainMoved(project, deps()), null, "a first sight only records HEAD");
  assert.equal(await mainMoved(project, deps()), null, "HEAD unchanged: nothing");
  assert.equal(await pidOn(BASE), web0);

  commit("feature.txt");
  const head = git(["rev-parse", "HEAD"]);
  const line = await mainMoved(project, deps());
  assert.equal(line, `Main moved to ${head.slice(0, 7)}: onMerge reloaded web on the main checkout's copy.`);
  assert.notEqual(await pidOn(BASE), web0, "web restarted");
  assert.equal(await pidOn(BASE + 10), api0, "api untouched");
  assert.equal(onMergeNotes(project, file)[0]?.line, line);
  assert.equal(await mainMoved(project, deps()), null, "the same move never reloads twice");
});
