import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { historyOf } from "../harness/pi/reader";
import { stateView } from "../harness/state-view";
import { staticServes, stopStaticServe } from "../preview-serve";
import { DetachedDriver, parseMemoryPeak, systemdRunArgv } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";
import { instanceNote, lastNoteDigest, NOTE_MESSAGE, noteDigest, registerInstanceNote, resultNote } from "./note";
import { readRegistry } from "./store";
import { renderResult } from "./tools";
import { reservePorts } from "../test-ports";

/**
 * The instance note (§app.project-services/instance-note): rendered from the checkout's definition and the
 * registry, with no live state; delivered hidden at a turn's start only when it changed, again after a
 * compaction, and after single-instance results. A real static serve started under the note here; every
 * case runs on a host in memory in note.test.ts.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-note-agent-"));

const op: Caller = { kind: "operator" };
const BASE = await reservePorts(60);
const def = (about = "Test REPL: node client.mjs ${ports.repl.nrepl}") => ({
  version: 1,
  slots: { cap: 2 },
  data: { db: { kind: "dir" } },
  services: {
    site: { static: "public", ports: { http: { base: BASE, stride: 10 } }, about: "The site at its own port" },
    api: { cmd: ["node", "api.mjs"], ports: { http: { base: BASE + 1, stride: 10 } }, ready: { http: "http", path: "/health" } },
    repl: { cmd: ["node", "repl.mjs"], start: "on-demand", ports: { nrepl: { base: BASE + 2, stride: 10 } }, about },
  },
  test: { run: ["node", "t.mjs"], requires: ["repl"], smoke: ["unit/a", "unit/b"] },
});

let parent = "";
let project = "";
let checkout = "";
let id = "";
let engine: ProjectEngine;

const define = (d: object, where = project) => {
  // Never the real cwd: before `before` has set `project` it is "", and join("", ".sova", ...) is
  // the repository's own .sova/project.json.
  assert.ok(where.startsWith(realpathSync(tmpdir()) + "/"), `define() outside the temp dir: "${where}"`);
  writeFileSync(join(where, ".sova", "project.json"), JSON.stringify(d, null, 2));
};

before(async () => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-note-proj-")));
  project = join(parent, "demo");
  mkdirSync(join(project, ".sova"), { recursive: true });
  mkdirSync(join(project, "public"), { recursive: true });
  writeFileSync(join(project, "public", "index.html"), "<h1>x</h1>");
  define(def());
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project });
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  engine = new ProjectEngine({ driver: new DetachedDriver(3_000), pollMs: 50 });
});

after(async () => {
  for (const s of staticServes()) await stopStaticServe(s.id);
  for (const i of readRegistry().instances) if (i.slot !== 0) await engine.run("teardown", { instance: i.id }, op);
  rmSync(parent, { recursive: true, force: true });
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
});

test("a worktree's note: its own ports beside the main checkout's, abouts, data and tests; no live state", async () => {
  // A worktree with a definition but no instance yet.
  execFileSync("git", ["worktree", "add", "-q", "-b", "feat-note", join(parent, "demo-note")], { cwd: project });
  checkout = realpathSync(join(parent, "demo-note"));
  const none = await engine.noteFacts(checkout);
  assert.equal(instanceNote(none!, false), `Sova instance note for ${checkout}: it has no running copy yet; project_verbs up gives it its own ports.`);
  assert.equal(await engine.noteFacts(project), null, "the main checkout gets none");
  assert.equal(await engine.noteFacts(parent), null, "a folder outside a project gets none");

  const c = await engine.run("create", { project, checkout }, op);
  assert.equal(c.ok, true, c.error?.message);
  id = c.instance!;
  const slot = c.slot!;
  const text = instanceNote((await engine.noteFacts(checkout))!, false);
  const p = (off: number) => BASE + off + slot * 10;
  assert.equal(
    text,
    [
      `Sova instance note for ${checkout} (branch feat-note): instance ${id}, slot ${slot}, its own running copy of ${project}.`,
      "Ports, this instance's (the main checkout's in brackets):",
      `- site.http: ${p(0)} (main checkout: ${BASE})`,
      `- api.http: ${p(1)} (main checkout: ${BASE + 1}), http://127.0.0.1:${p(1)}/health`,
      `- repl.nrepl: ${p(2)} (main checkout: ${BASE + 2})`,
      "Services:",
      "- site: The site at its own port",
      `- repl, on-demand (test or up with services starts it): Test REPL: node client.mjs ${p(2)}`,
      "Data:",
      `- db: ${readRegistry().instances.find((i) => i.id === id)!.data.db}`,
      'Tests: project_verbs {verb: "test", select: [...]} runs them in this instance; no select runs the whole suite. Smoke selection: unit/a unit/b.',
      "Start, reload and stop these through project_verbs, never by hand.",
    ].join("\n"),
  );
  assert.match(instanceNote((await engine.noteFacts(checkout))!, true), /\nYour shell is sandboxed and cannot reach these ports: use project_verbs\.$/);
  // Starting a service changes nothing in it.
  const up = await engine.run("up", { instance: id, services: ["site"] }, op);
  assert.equal(up.ok, true, up.error?.message);
  assert.equal(instanceNote((await engine.noteFacts(checkout))!, false), text);

  // Edited in the worktree: the note is the copy's as before, its first line unchanged; then invalid.
  define({ ...def(), slots: { cap: 3 } }, checkout);
  assert.equal(instanceNote((await engine.noteFacts(checkout))!, false).split("\n")[0], text.split("\n")[0]);
  writeFileSync(join(checkout, ".sova", "project.json"), "{ nope");
  assert.match(instanceNote((await engine.noteFacts(checkout))!, false), /^Sova instance note for .*: its \.sova\/project\.json is invalid \(\$: not JSON/);
  define(def(), checkout);
});
