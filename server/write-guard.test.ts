// Run: npx tsx --test server/write-guard.test.ts
// The recent-write guard across a server restart: the stat a runtime verified as its own is
// persisted, so the next process opens the file it was just writing; any other change still
// refuses; a TUI-live session refuses whatever was recorded.
// Throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-write-guard-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-write-guard--");
const liveDir = join(agentDir, "sessions", "live");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(liveDir, { recursive: true });

const { ForeignWriteGuard, markOwnedStat, recentForeignWriteAgeSec } = await import("./write-guard");
const { canonicalPath } = await import("./paths");
const { acquireChat, BusyError } = await import("./chat-manager");

after(() => rmSync(agentDir, { recursive: true, force: true }));

const line = (id: string) => `${JSON.stringify({ type: "message", id, parentId: null, message: { role: "user", content: "x" } })}\n`;
let n = 0;
function session(): string {
  const path = canonicalPath(join(sessionsDir, `2026-09-24T00-00-0${n}-000Z_s${n++}.jsonl`));
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: `s${n}`, timestamp: new Date().toISOString(), cwd: "/tmp" })}\n`);
  return path;
}

/** One runtime's view: the guard over the file, knowing the ids its SessionManager wrote. */
function runtime(path: string) {
  const ours = new Set<string>();
  const guard = new ForeignWriteGuard(path, (id) => ours.has(id));
  return {
    write(id: string) {
      ours.add(id);
      appendFileSync(path, line(id));
    },
    /** What ChatSession does on each guard tick and at dispose. */
    record(): string | null {
      const reason = guard.check();
      const v = guard.verified();
      if (!reason && v) markOwnedStat(path, v);
      return reason;
    },
    guard,
  };
}

test("a file our previous process verified and left unchanged opens after a restart", () => {
  const path = session();
  const r = runtime(path);
  r.write("a1");
  r.write("a2");
  assert.notEqual(recentForeignWriteAgeSec(path), null, "unrecorded: read as a recent foreign write, as before");
  assert.equal(r.record(), null);
  // The record is on disk, not in this process: a restarted server reads the same file.
  const owned = JSON.parse(readFileSync(join(agentDir, "sova", "owned-writes.json"), "utf8"));
  assert.ok(owned[path], "persisted under the state root");
  assert.equal(recentForeignWriteAgeSec(path), null, "ours and unchanged: no refusal");
});

test("an append after our last verified write refuses, whoever made it", () => {
  const path = session();
  const r = runtime(path);
  r.write("b1");
  r.record();
  assert.equal(recentForeignWriteAgeSec(path), null);
  appendFileSync(path, line("foreign-1")); // another process, after the stat we recorded
  const age = recentForeignWriteAgeSec(path);
  assert.equal(typeof age, "number", "size and mtime moved: refused");
});

test("a foreign line the guard catches records nothing, so it can't be laundered into ours", () => {
  const path = session();
  const r = runtime(path);
  r.write("c1");
  appendFileSync(path, line("foreign-2"));
  assert.match(r.record() ?? "", /another process/);
  assert.notEqual(recentForeignWriteAgeSec(path), null);
});

test("a line still mid-write is not verified: nothing is recorded until it completes", () => {
  const path = session();
  const r = runtime(path);
  r.write("d1");
  appendFileSync(path, '{"type":"message","id":"d2"'); // no newline yet
  assert.equal(r.guard.check(), null, "not judged while incomplete");
  assert.equal(r.guard.verified(), null);
  assert.notEqual(recentForeignWriteAgeSec(path), null);
});

test("a TUI-live session is refused even when its file is recorded as ours", async () => {
  const path = session();
  const r = runtime(path);
  r.write("e1");
  r.record();
  assert.equal(recentForeignWriteAgeSec(path), null);
  // process.ppid: an alive pid that isn't this process, so the live registry counts it.
  writeFileSync(join(liveDir, `p${process.ppid}-tui.json`), JSON.stringify({
    heartbeat: Date.now(), session: { sessionFile: path, pid: process.ppid, mode: "tui", status: "idle" }, presence: { status: "idle" },
  }));
  await assert.rejects(acquireChat(path), (err: unknown) => err instanceof BusyError && /open in another pi process/.test(String((err as Error).message)));
  await assert.rejects(acquireChat(path, true), BusyError, "force never helps against a TUI");
});
