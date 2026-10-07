import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseDefinition } from "../../shared/project-contract";
import { ProjectEngine, type Caller } from "./engine";
import { FakeHost } from "./fake-host";
import { mainMoved, onMergeNotes, SYSTEM_ON_MERGE, withOnMerge, type OnMergeDeps } from "./on-merge";
import { readRegistry } from "./store";
import { approve, defHashOf } from "./trust";

/**
 * onMerge (§app.project-services/on-merge): when main's HEAD moves, the main checkout's copy (slot 0)
 * reloads the running services that declare `onMerge: "reload"`, as the system caller, others untouched;
 * a first sight only records HEAD; a stopped service stays stopped; never on Sova's own checkout; each
 * outcome is a note in the project's feed. On a host in memory (fake-host.ts), a real git repo;
 * on-merge.integration.test.ts reloads a real running service.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-onmerge-agent-"));

const BASE = 21_000;
const host = new FakeHost();
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
function writeDef(def: object, approved: boolean): void {
  const text = JSON.stringify(def);
  writeFileSync(join(project, ".sova", "project.json"), text);
  if (approved) {
    const h = defHashOf(parseDefinition(text));
    approve(project, h, h);
  }
}
/** The pid listening on `port` (as the real test's server answers its own). */
const pidOn = async (port: number): Promise<string> => {
  const o = host.portOwner(port);
  assert.ok(typeof o === "object", `something listens on ${port}`);
  return String(o.pid);
};
const deps = (): Partial<OnMergeDeps> => ({ run: (verb, body, caller) => engine.run(verb, body, caller), selfCheckout: () => self, file });

before(async () => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-onmerge-proj-")));
  project = join(parent, "shop");
  file = join(parent, "on-merge.json");
  mkdirSync(join(project, ".sova"), { recursive: true });
  writeFileSync(join(project, "server.mjs"), SERVER);
  writeDef(defOf(), true);
  git(["init", "-q", "-b", "main"]);
  commit(".gitignore", "");
  engine = new ProjectEngine(host.deps({ selfCheckout: () => self }));
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

test("after Merge Branch, a HEAD never seen before counts as moved; the tick's first sight doesn't", async () => {
  const other = join(parent, "other.json");
  commit("merged.txt");
  const web0 = await pidOn(BASE);
  assert.equal(await mainMoved(project, { ...deps(), file: other }), null, "the tick: first sight");
  commit("merged-2.txt");
  rmSync(other);
  assert.match((await mainMoved(project, { ...deps(), file: other }, { merged: true })) ?? "", /onMerge reloaded web/);
  assert.notEqual(await pidOn(BASE), web0);
  // The main file has not seen these moves: it catches up once, then stays quiet.
  await mainMoved(project, deps());
});

test("the merge and the tick at once reload once", async () => {
  commit("twice.txt");
  const web0 = await pidOn(BASE);
  const both = await Promise.all([mainMoved(project, deps()), mainMoved(project, deps())]);
  assert.equal(both.filter(Boolean).length, 1, JSON.stringify(both));
  assert.notEqual(await pidOn(BASE), web0);
});

test("a stopped onMerge service stays stopped; Sova's own checkout never reloads; a refused apply says why", async () => {
  const main = (await engine.run("status", { project }, op)).instances!.find((i) => i.slot === 0)!.instance;
  const dn = await engine.run("down", { instance: main, services: ["web"] }, op);
  assert.equal(dn.ok, true, dn.error?.message);
  commit("stopped.txt");
  assert.equal(await mainMoved(project, deps()), null, "nothing running carries the key: no apply, no note");
  const st = await engine.run("status", { instance: main }, op);
  assert.equal(st.services.find((s) => s.name === "web")?.state, "stopped", "never started by onMerge");
  assert.equal((await engine.run("up", { instance: main }, op)).ok, true);

  self = project;
  const web0 = await pidOn(BASE);
  commit("self.txt");
  const selfLine = await mainMoved(project, deps());
  assert.match(selfLine ?? "", /onMerge never reloads the checkout this Sova runs from/);
  assert.equal(await pidOn(BASE), web0, "Sova's own checkout: nothing reloaded");
  self = null;

  // main's definition changed and is not approved here: the reload is refused, and the note says so.
  writeDef(defOf({ MODE: "new" }), false);
  commit("def.txt", "x");
  const refused = await mainMoved(project, deps());
  assert.match(refused ?? "", /onMerge could not reload web: .*not approved/);
  assert.equal(await pidOn(BASE), web0);
});

test("the system caller runs apply and reads, nothing else", async () => {
  writeDef(defOf(), true);
  commit("back.txt");
  const main = (await engine.run("status", { project }, SYSTEM_ON_MERGE)).instances!.find((i) => i.slot === 0)!.instance;
  for (const verb of ["down", "up", "reset", "teardown", "share"]) {
    const r = await engine.run(verb, { instance: main, endpoint: "web.http" }, SYSTEM_ON_MERGE);
    assert.equal(r.error?.code, "forbidden", `${verb}: ${r.error?.message}`);
  }
});

test("the project's software feed shows the notes among its own lines, newest first", () => {
  const feed = [{ at: "2026-10-03T10:00:00.000Z", line: "registered" }, { at: "2026-10-01T10:00:00.000Z", line: "approved" }];
  const notes = [{ at: "2026-10-02T10:00:00.000Z", line: "Main moved to abc1234: onMerge reloaded web on the main checkout's copy." }];
  assert.deepEqual(withOnMerge(feed, notes).map((l) => l.line), ["registered", notes[0]!.line, "approved"]);
  assert.equal(withOnMerge(feed, []), feed);
  assert.equal(withOnMerge(feed, notes, 2).length, 2);
});
