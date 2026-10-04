// scripts/hermetic-agent-dir.mjs with copied sessions: no wake-nudge link and blank schedules, sticky
// across re-runs; a dir with no copied session is set up as before. Each case runs the script for
// real against a throwaway HOME (its ~/.pi/agent/sessions is the "real" set) and agent dir.
//   node --test scripts/hermetic-agent-dir.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

const SCRIPT = resolve(import.meta.dirname, "hermetic-agent-dir.mjs");
const scratch = mkdtempSync(join(tmpdir(), "sova-hermetic-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const BLANK = { version: 1, seq: 0, schedules: [], logins: {} };
/** The real scheduler's store, and one the hermetic server made itself (same id, its own approval). */
const STORE = { version: 1, seq: 3, schedules: [{ id: "s1", root: "/home/u/webapps/sova", playbook: "merge-round", approved: { pin: "d1e9", at: 1790837808159 }, fires: [] }], logins: {} };
const OWN = { version: 1, seq: 1, schedules: [{ id: "s1", root: "/tmp/scratch-project", playbook: "merge-round", approved: { pin: "aa11", at: 1791000000000 }, fires: [] }], logins: {} };
const PROJECT = "--home-u-webapps-sova--";
const REAL_NAME = "2026-09-30T20-52-10-542Z_01a0f416-ceae-763c-8dc1-cbb968d07d6d.jsonl";
const REAL_TWO = "2026-09-30T20-51-22-759Z_01a0f416-1407-763c-8dc1-cbb60a574764.jsonl";
let n = 0;

/** A fake HOME whose ~/.pi/agent/sessions holds `names`, and an empty agent dir. */
function setup(names = [REAL_NAME, REAL_TWO]) {
  const root = join(scratch, `case-${++n}`);
  const home = join(root, "home");
  mkdirSync(join(home, ".pi", "agent", "sessions", PROJECT), { recursive: true });
  for (const name of names) writeFileSync(join(home, ".pi", "agent", "sessions", PROJECT, name), "{}\n");
  mkdirSync(join(home, ".pi", "agent", "sova"));
  writeFileSync(join(home, ".pi", "agent", "sova", "schedules.json"), JSON.stringify(STORE));
  const agent = join(root, "agent");
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, HOME: home, HERMETIC_AGENT_DIR: agent, SOVA_TOKEN: "" }, encoding: "utf8" });
  const ok = (...args) => {
    const r = run(...args);
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    return r.stdout;
  };
  const session = (name, project = PROJECT) => {
    mkdirSync(join(agent, "sessions", project), { recursive: true });
    writeFileSync(join(agent, "sessions", project, name), "{}\n");
  };
  const schedules = (store = STORE, runs = true) => {
    mkdirSync(join(agent, "sova"), { recursive: true });
    writeFileSync(join(agent, "sova", "schedules.json"), JSON.stringify(store));
    if (runs) writeFileSync(join(agent, "sova", "schedule-runs.jsonl"), '{"id":"s1"}\n');
  };
  const store = () => JSON.parse(readFileSync(join(agent, "sova", "schedules.json"), "utf8"));
  const linked = () => {
    try {
      return lstatSync(join(agent, "extensions", "wake-nudge.ts")).isSymbolicLink();
    } catch {
      return false;
    }
  };
  return { agent, run, ok, session, schedules, store, linked, runs: () => existsSync(join(agent, "sova", "schedule-runs.jsonl")) };
}

test("a fresh dir with no copied session is set up as before: wake-nudge linked, schedules kept", () => {
  const d = setup();
  d.schedules(OWN);
  d.ok();
  assert.ok(d.linked(), "wake-nudge is linked");
  assert.deepEqual(d.store(), OWN, "its own schedules are kept");
  assert.ok(d.runs());
  assert.equal(existsSync(join(d.agent, "copied-sessions.json")), false, "no marker");
  // The server's own sessions are not copies.
  d.session("2026-10-04T10-00-00-000Z_01a1aaaa-0000-7000-8000-000000000001.jsonl");
  d.ok();
  assert.ok(d.linked(), "still linked with sessions of its own");
  assert.deepEqual(d.store(), OWN);
  d.ok("--check");
});

test("copied sessions: wake-nudge left out and the scheduler's state blanked; a re-run never links it back", () => {
  const d = setup();
  d.ok();
  assert.ok(d.linked());
  d.session(REAL_NAME); // copied in by hand, with the real scheduler state
  d.schedules();
  assert.equal(d.run("--check").status, 1, "--check notices copies not set up for");
  const out = d.ok();
  assert.match(out, /copied sessions \(1 found\)/);
  assert.equal(d.linked(), false, "no wake-nudge link");
  assert.deepEqual(d.store(), BLANK, "schedules.json blank");
  assert.equal(d.runs(), false, "schedule-runs.jsonl gone");
  d.ok("--check");
  // A re-run, even once the copies are gone: the mode is sticky.
  rmSync(join(d.agent, "sessions", PROJECT, REAL_NAME));
  d.ok();
  assert.equal(d.linked(), false, "re-running does not re-create the link");
  // A schedule made in the hermetic server survives a restart of dev:hermetic...
  d.schedules(OWN, false);
  d.ok("--unlock-url");
  assert.deepEqual(d.store(), OWN);
  // ...until new copies arrive,
  d.session(REAL_TWO);
  d.ok();
  assert.deepEqual(d.store(), BLANK, "new copies blank it again");
  assert.equal(d.linked(), false);
  // or the real store is copied in again beside sessions already seen.
  d.schedules();
  assert.equal(d.run("--check").status, 1);
  d.ok();
  assert.deepEqual(d.store(), BLANK, "a real approval is never kept");
  assert.equal(d.runs(), false);
});

test("--copied-sessions sets the mode up before any copy arrives", () => {
  const d = setup([]);
  d.schedules();
  d.ok("--unlock-url", "--copied-sessions");
  assert.equal(d.linked(), false);
  assert.deepEqual(d.store(), BLANK);
  assert.equal(d.runs(), false);
  d.ok("--check");
  assert.equal(d.run("--bogus").status, 2);
});

test("load-experiment --prepare asks for the mode", () => {
  const src = readFileSync(resolve(import.meta.dirname, "perf", "load-experiment.mjs"), "utf8");
  assert.match(src, /hermetic-agent-dir\.mjs"\), "--unlock-url", "--copied-sessions"\]/);
  // And nothing else in scripts/ copies real sessions into a hermetic dir with the plain setup.
  const users = execFileSync("grep", ["-rl", "--include=*.mjs", "agent\", \"sessions\"", resolve(import.meta.dirname)], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  for (const f of users) if (/hermetic/.test(readFileSync(f, "utf8")) && !f.endsWith("hermetic-agent-dir.test.mjs") && !f.endsWith("hermetic-agent-dir.mjs")) assert.match(readFileSync(f, "utf8"), /--copied-sessions/, f);
});
