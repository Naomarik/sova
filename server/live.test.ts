// Run: npx tsx --test server/live.test.ts
// A throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-live-test-"));
after(() => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const liveDir = join(agentDir, "sessions", "live");
mkdirSync(liveDir, { recursive: true });

const { addOwnPid, isOwnPid, readLiveRecords, readLive, readOwnLiveRecords } = await import("./live");

const record = (sessionFile: string, status: string, pid = process.ppid) => JSON.stringify({ session: { pid, sessionFile, status: "active" }, presence: { status }, heartbeat: Date.now() });

test("a record is parsed again whenever it changes, by rename or in place, and leaves with its file", () => {
  const a = join(agentDir, "sessions", "a.jsonl");
  writeFileSync(join(liveDir, "p1-a.json"), record(a, "idle"));
  assert.equal(readLive().get(a)?.status, "idle");
  assert.equal(readLive().get(a)?.status, "idle", "unchanged, the same answer");
  // A heartbeat: written to a dotfile, renamed over the record.
  writeFileSync(join(liveDir, ".p1-a.json.tmp"), record(a, "busy"));
  renameSync(join(liveDir, ".p1-a.json.tmp"), join(liveDir, "p1-a.json"));
  assert.equal(readLive().get(a)?.status, "busy", "a rename is seen at once");
  writeFileSync(join(liveDir, "p1-a.json"), record(a, "waiting-for-you"));
  assert.equal(readLive().get(a)?.status, "waiting-for-you", "an in-place rewrite is seen at once");
  rmSync(join(liveDir, "p1-a.json"));
  assert.equal(readLive().get(a), undefined, "a removed record is gone");
});

test("a malformed record is skipped until it changes; dead pids and our own pid are filtered on every call", () => {
  const b = join(agentDir, "sessions", "b.jsonl");
  writeFileSync(join(liveDir, "p2-b.json"), "{ half");
  assert.equal(readLiveRecords().length, 0);
  writeFileSync(join(liveDir, "p2-b.json"), record(b, "idle"));
  assert.equal(readLiveRecords().length, 1, "fixed, it is read");
  writeFileSync(join(liveDir, "p3-own.json"), record(b, "idle", process.pid));
  assert.equal(readLiveRecords().length, 1, "our own records are left out by default");
  assert.equal(readLiveRecords({ includeOwn: true }).length, 2);
  writeFileSync(join(liveDir, "p4-dead.json"), record(b, "idle", 2 ** 22 + 12345));
  assert.equal(readLiveRecords({ includeOwn: true }).length, 2, "a dead pid never counts");
  for (const f of ["p2-b.json", "p3-own.json", "p4-dead.json"]) rmSync(join(liveDir, f));
});

test("own records are those of every process hosting this server's chats, not only this one", () => {
  const c = join(agentDir, "sessions", "c.jsonl");
  // process.ppid stands in for a chat this server hosts in a process of its own: alive, not this pid.
  writeFileSync(join(liveDir, "p5-c.json"), record(c, "idle"));
  assert.equal(isOwnPid(process.pid), true, "this process always hosts");
  assert.equal(isOwnPid(process.ppid), false);
  assert.equal(readLive().get(c)?.status, "idle", "another process's record reads as another writer");
  assert.equal(readOwnLiveRecords().has(c), false);
  const remove = addOwnPid(process.ppid);
  assert.equal(readLive().get(c), undefined, "a hosted chat's process is never an outside writer");
  assert.equal(readOwnLiveRecords().get(c)?.pid, process.ppid, "its record is this server's own");
  remove();
  assert.equal(readLive().get(c)?.status, "idle", "gone from the set, it is a writer again");
  rmSync(join(liveDir, "p5-c.json"));
});
