import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseDefinition } from "../../shared/project-contract";
import { FakeHost } from "./fake-host";
import { ProjectEngine, type Caller, type VerbAct } from "./engine";
import { readRegistry } from "./store";
import { approve, defHashOf } from "./trust";

/**
 * Sova hosting itself (§app.project-services/self-host): on the server's own checkout, apply, down,
 * reset and teardown of slot 0 need the operator's confirm for every caller, and are refused while a
 * hosted session is busy; a worktree's instance of the same project, and another project, stay free.
 * On a host in memory (fake-host.ts): the rules are the engine's, whatever runs.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-selfhost-agent-"));

const BASE = 21_000;

let parent = "";
let project = "";
let other = "";
let busy: string | null = null;
let engine: ProjectEngine;
const op: Caller = { kind: "operator" };
const taken: VerbAct = async () => undefined;

function makeProject(dir: string, base: number) {
  mkdirSync(join(dir, ".sova"), { recursive: true });
  writeFileSync(join(dir, "site.mjs"), "");
  const def = { version: 1, slots: { cap: 2 }, services: { site: { cmd: ["node", "site.mjs"], ports: { http: { base } } } }, data: { db: { kind: "dir" } } };
  writeFileSync(join(dir, ".sova", "project.json"), JSON.stringify(def));
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
  git(["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, ".gitignore"), "");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  const h = defHashOf(parseDefinition(JSON.stringify(def)));
  approve(dir, h, h);
}

before(async () => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-selfhost-proj-")));
  project = join(parent, "sova");
  other = join(parent, "other");
  makeProject(project, BASE);
  makeProject(other, BASE + 10);
  engine = new ProjectEngine(new FakeHost().deps({ selfCheckout: () => project, hostBusy: () => busy }));
});

after(async () => {
  rmSync(parent, { recursive: true, force: true });
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
});

test("slot 0 of the server's own checkout: every stop or restart needs the operator's confirm, and none runs while a session is busy", async () => {
  const up = await engine.run("up", { project }, op);
  assert.equal(up.state, "running", up.error?.message);
  const main = up.instance!;
  for (const verb of ["apply", "down", "reset"]) {
    const r = await engine.run(verb, { instance: main }, op);
    assert.equal(r.error?.code, "needs-confirm", `${verb} unconfirmed: ${r.error?.message}`);
    assert.match(r.error!.message, /Sova server's own checkout/);
    assert.equal(r.steps.length, 0);
    assert.equal(r.state, "running", "nothing changed");
  }
  // Teardown is refused for slot 0 anyway; unconfirmed it never gets that far.
  assert.equal((await engine.run("teardown", { instance: main }, op)).error?.code, "needs-confirm");
  // Every other caller: needs-confirm, confirm or not (the project overseer's act is taken, as at L3).
  const callers: Caller[] = [
    { kind: "overseer", id: "o1" },
    { kind: "project-overseer", id: "po", root: project, act: taken },
  ];
  for (const c of callers) {
    const r = await engine.run("down", { instance: main, confirm: true }, c);
    assert.equal(r.error?.code, "needs-confirm", `${c.kind}: ${r.error?.message}`);
  }
  // Confirmed, but a hosted session is busy: refused as busy, nothing changes.
  busy = "1 hosted session busy: 1 with a turn in flight";
  const held = await engine.run("down", { instance: main, confirm: true }, op);
  assert.equal(held.error?.code, "busy", held.error?.message);
  assert.match(held.error!.message, /1 hosted session busy/);
  assert.equal(held.state, "running");
  // Idle and confirmed: it runs.
  busy = null;
  const dn = await engine.run("down", { instance: main, confirm: true }, op);
  assert.equal(dn.ok, true, dn.error?.message);
  assert.equal(dn.state, "stopped");
  // up never stops anything: no confirm.
  assert.equal((await engine.run("up", { instance: main }, op)).ok, true);
  await engine.run("down", { instance: main, confirm: true }, op);
});

test("a worktree's instance of the server's own project, and another project's main, stay free", async () => {
  busy = "2 hosted sessions busy: 2 with working subagents";
  const wt = await engine.run("up", { project, branch: "feat-free" }, op);
  assert.equal(wt.state, "running", wt.error?.message);
  assert.notEqual(wt.slot, 0);
  for (const verb of ["apply", "reset", "down"]) assert.equal((await engine.run(verb, { instance: wt.instance }, op)).ok, true, verb);
  assert.equal((await engine.run("teardown", { instance: wt.instance }, op)).ok, true);
  const o = await engine.run("up", { project: other }, op);
  assert.equal(o.ok, true, o.error?.message);
  assert.equal((await engine.run("down", { instance: o.instance }, op)).ok, true, "another project's main needs no confirm");
  busy = null;
  assert.ok(readRegistry().instances.every((i) => i.slot === 0));
});

test("hostedBusy reads this server's fresh live records: a working subagent or a turn in flight, never a stale or another pid's record", async () => {
  const { LIVE_DIR } = await import("../paths");
  const { hostedBusy } = await import("./self-host");
  // Only ever in a throwaway home (hermetic-env or this file's agent dir), never the real agent dir.
  assert.ok(LIVE_DIR.startsWith(tmpdir()), `LIVE_DIR ${LIVE_DIR} must be a throwaway`);
  mkdirSync(LIVE_DIR, { recursive: true });
  const rec = (name: string, pid: number, beat: number, presence: object) =>
    writeFileSync(join(LIVE_DIR, `${name}.json`), JSON.stringify({ session: { pid, sessionFile: join(parent, `${name}.jsonl`) }, heartbeat: beat, presence }));
  const files = ["a", "b", "c", "d"].map((n) => join(LIVE_DIR, `p${process.pid}-${n}.json`));
  try {
    rec(`p${process.pid}-a`, process.pid, Date.now(), { activity: { state: "idle", since: 0 } });
    assert.equal(hostedBusy(), null, "idle");
    rec(`p${process.pid}-b`, process.pid, Date.now() - 60_000, { activity: { state: "working", since: 0 } });
    assert.equal(hostedBusy(), null, "a stale record is ignored");
    // pid 1 is alive (another process: a TUI, another server), and none of this server's sessions.
    rec(`p1-e`, 1, Date.now(), { activity: { state: "working", since: 0 } });
    files.push(join(LIVE_DIR, "p1-e.json"));
    assert.equal(hostedBusy(), null, "another pid's record is ignored");
    rec(`p${process.pid}-c`, process.pid, Date.now(), { activity: { state: "working", since: 0 } });
    rec(`p${process.pid}-d`, process.pid, Date.now(), { workerCounts: { working: 2, total: 3 }, activity: { state: "idle", since: 0 } });
    assert.equal(hostedBusy(), "2 hosted sessions busy: 1 with working subagents, 1 with a turn in flight");
  } finally {
    for (const f of files) rmSync(f, { force: true });
  }
});
