// Run: npx tsx --test server/archive-subagent-guard.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
//
// Archiving closes a session's runtime and its subagents die with it, so the server refuses while
// any are working — read from the live records at the moment of the request, never from the
// browser's list. A record written with THIS process's pid is how a Sova-hosted runtime looks (the
// sessions extension runs inside it); a sleeper's pid stands in for another live process.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-archive-guard-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-archive-guard--");
const liveDir = join(agentDir, "sessions", "live");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(liveDir, { recursive: true });

const { archiveSession, cleanupSessions, SUBAGENTS_WORKING } = await import("./sessions-index");
const { isArchived, setArchived } = await import("./archived-sessions");
const { addWebSession } = await import("./web-sessions");
const { canonicalPath } = await import("./paths");
const { readLiveRecords, workingSubagents, WORKING_FRESH_MS } = await import("./live");

const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
after(() => {
  sleeper.kill();
  rmSync(agentDir, { recursive: true, force: true });
});
afterEach(() => {
  for (const name of ["own.json", "other.json"]) rmSync(join(liveDir, name), { force: true });
});

/** A web-spawned session with a user message, aged past the just-written window. */
function session(id: string): string {
  const path = join(sessionsDir, `2026-09-24T00-00-00-000Z_${id}.jsonl`);
  const lines = [
    JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-24T00:00:00.000Z", cwd: "/tmp" }),
    JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-09-24T00:00:01.000Z", message: { role: "user", content: "hi" } }),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
  const old = new Date(Date.now() - 40 * 86_400_000);
  utimesSync(path, old, old);
  addWebSession(id);
  return canonicalPath(path);
}

function live(name: string, pid: number, sessionFile: string, working: number, heartbeat = Date.now()): void {
  writeFileSync(
    join(liveDir, name),
    JSON.stringify({ heartbeat, session: { pid, sessionFile, mode: "rpc" }, presence: { status: "Idle", workerCounts: { working, total: working + 1 } } }),
  );
}

test("refused with subagents working in this server's own runtime; nothing is marked", async () => {
  const path = session("guard-own");
  live("own.json", process.pid, path, 2);
  const r = await archiveSession(path, true);
  assert.deepEqual(r, { ok: false, status: 409, error: SUBAGENTS_WORKING });
  assert.equal(isArchived("guard-own"), false);
});

test("read at the request, not cached: the same session archives once its subagents finish", async () => {
  const path = session("guard-fresh");
  live("own.json", process.pid, path, 1);
  assert.equal((await archiveSession(path, true)).ok, false);
  live("own.json", process.pid, path, 0); // the record the extension rewrites when the last one ends
  const r = await archiveSession(path, true);
  assert.ok(r.ok);
  assert.equal(isArchived("guard-fresh"), true);
});

test("allowed with no live record at all", async () => {
  const path = session("guard-none");
  const r = await archiveSession(path, true);
  assert.ok(r.ok && r.summary.archived);
});

test("a stale heartbeat is ignored, a fresh one just inside the window is not", async () => {
  const path = session("guard-stale");
  live("own.json", process.pid, path, 3, Date.now() - WORKING_FRESH_MS - 5_000);
  assert.equal(workingSubagents(path), 0);
  live("own.json", process.pid, path, 3, Date.now() - WORKING_FRESH_MS + 5_000);
  assert.equal(workingSubagents(path), 3);
  live("own.json", process.pid, path, 3, Date.now() - WORKING_FRESH_MS - 5_000);
  const r = await archiveSession(path, true);
  assert.ok(r.ok, "a runtime that died without deleting its record must not block forever");
});

test("a dead pid's record is ignored", async () => {
  const path = session("guard-dead");
  const gone = spawn("true", { stdio: "ignore" });
  await new Promise((res) => gone.on("exit", res));
  live("other.json", gone.pid!, path, 4);
  assert.equal(workingSubagents(path), 0);
  const r = await archiveSession(path, true);
  assert.ok(r.ok);
});

test("a heartbeat far in the future is garbage, not fresh", () => {
  const path = canonicalPath(join(sessionsDir, "future.jsonl"));
  const at = Date.now();
  const rec = (heartbeat: number) => [{ sessionFile: path, pid: 1, rec: { heartbeat, presence: { workerCounts: { working: 1, total: 1 } } } }];
  assert.equal(workingSubagents(path, rec(at + 10 * 60_000), at), 0);
  assert.equal(workingSubagents(path, rec(at + 1_000), at), 1);
});

test("another live process hosting the session counts too, and only for its own file", async () => {
  const path = session("guard-other");
  const neighbour = session("guard-neighbour");
  live("other.json", sleeper.pid!, path, 2);
  assert.equal(workingSubagents(path), 2);
  assert.equal(workingSubagents(neighbour), 0);
  // Archive itself is refused already (a foreign live record reads as open in a TUI): refused, whichever reason.
  const r = await archiveSession(path, true);
  assert.ok(!r.ok && r.status === 409);
  assert.equal(isArchived("guard-other"), false);
  // Two claims on one file: the larger count wins, so a zero from one never hides the other's work.
  live("own.json", process.pid, path, 0);
  assert.equal(workingSubagents(path, readLiveRecords({ includeOwn: true })), 2);
});

test("unarchive is never blocked by working subagents", async () => {
  const path = session("guard-unarchive");
  setArchived("guard-unarchive", true);
  live("own.json", process.pid, path, 5);
  const r = await archiveSession(path, false);
  assert.ok(r.ok);
  assert.equal(r.summary.archived, false);
  assert.equal(isArchived("guard-unarchive"), false);
});

test("archive cleanup skips a session with subagents working, as busy, and deletes nothing", async () => {
  const path = session("guard-cleanup");
  setArchived("guard-cleanup", true);
  live("own.json", process.pid, path, 1);
  const r = await cleanupSessions({ mode: "paths", paths: [path], dryRun: false });
  assert.equal(r.deletedCount, 0);
  assert.equal(r.skipped.busy, 1);
  assert.ok(existsSync(path));
});
