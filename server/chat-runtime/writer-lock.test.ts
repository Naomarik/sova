// Run: pnpm test -- server/chat-runtime/writer-lock.test.ts. One writer per session file: the lock is
// held against everyone (this process too), a dead or reused holder's lock is taken over, and a
// release never removes a lock taken over since.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { holderAlive, lockFileOf, procStart, readLock, releaseLockOf, setProcStartForTest, takeWriterLock, WriterLockHeld } from "./writer-lock";

const dir = mkdtempSync(join(tmpdir(), "wlock-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const DEAD_PID = 0x3ffffff; // above any pid_max: never a live process
// Start times from a fake table: a unit test spawns no `ps` (macOS reads it there). This process
// started at "S1"; the platform's own reads are tested below, injected.
let selfStart = "S1";
setProcStartForTest((pid) => (pid === process.pid ? selfStart : null));
after(() => setProcStartForTest(null));

test("held while taken, by anyone; free once released", () => {
  const lock = takeWriterLock("/s/a.jsonl", { dir, unit: "sova-chat-x-a" });
  assert.equal(statSync(lockFileOf("/s/a.jsonl", dir)).mode & 0o777, 0o600);
  assert.deepEqual(readLock("/s/a.jsonl", dir), lock.info);
  assert.equal(lock.info.pid, process.pid);
  assert.equal(lock.info.unit, "sova-chat-x-a");
  assert.throws(() => takeWriterLock("/s/a.jsonl", { dir }), (e) => e instanceof WriterLockHeld && e.holder.pid === process.pid && /already open in another Sova process \(pid \d+\)/.test(e.message));
  // Another path is its own lock.
  takeWriterLock("/s/b.jsonl", { dir }).release();
  lock.release();
  lock.release(); // once
  assert.equal(readLock("/s/a.jsonl", dir), null);
  takeWriterLock("/s/a.jsonl", { dir }).release();
});

test("a lock its holder lets go of between our refused link and the read is taken, never refused as held (pid 0)", () => {
  const holder = takeWriterLock("/s/race.jsonl", { dir });
  const lock = takeWriterLock("/s/race.jsonl", { dir, raced: () => holder.release() });
  assert.equal(readLock("/s/race.jsonl", dir)?.pid, process.pid);
  assert.deepEqual(readLock("/s/race.jsonl", dir), lock.info);
  lock.release();
});

test("a dead holder's lock is taken over", () => {
  writeFileSync(lockFileOf("/s/c.jsonl", dir), JSON.stringify({ pid: DEAD_PID, start: 1, at: 1, unit: null, path: "/s/c.jsonl" }));
  const lock = takeWriterLock("/s/c.jsonl", { dir });
  assert.equal(readLock("/s/c.jsonl", dir)?.pid, process.pid);
  lock.release();
});

test("a reused pid is not the holder (its start time differs)", () => {
  writeFileSync(lockFileOf("/s/d.jsonl", dir), JSON.stringify({ pid: process.pid, start: "S0", at: 1, unit: null, path: "/s/d.jsonl" }));
  const lock = takeWriterLock("/s/d.jsonl", { dir });
  assert.equal(readLock("/s/d.jsonl", dir)?.start, selfStart);
  lock.release();
  selfStart = "S1";
});

test("on Linux a process's start time is /proc's clock ticks", () => {
  // stat's 22nd field, counted after the command's closing parenthesis (a command may hold ") " itself).
  const stat = `4242 (a) b) S ${Array.from({ length: 18 }, (_, i) => i + 1).join(" ")} 987654 0 0\n`;
  assert.equal(procStart(4242, "linux", undefined, () => stat), 987654);
  assert.equal(procStart(4242, "linux", undefined, () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }), null, "no such process");
  assert.equal(procStart(DEAD_PID, "linux"), null);
});

test("a release leaves a lock someone else holds now", () => {
  const lock = takeWriterLock("/s/e.jsonl", { dir });
  // Taken over behind its back (it was thought dead).
  writeFileSync(lockFileOf("/s/e.jsonl", dir), JSON.stringify({ pid: process.pid, start: null, at: 2, unit: "other", path: "/s/e.jsonl" }));
  lock.release();
  assert.equal(readLock("/s/e.jsonl", dir)?.unit, "other");
  assert.equal(releaseLockOf("/s/e.jsonl", { pid: DEAD_PID, start: null }, dir), false, "not the holder: kept");
  assert.equal(releaseLockOf("/s/e.jsonl", { pid: process.pid, start: null }, dir), true);
  assert.equal(existsSync(lockFileOf("/s/e.jsonl", dir)), false);
});

test("on macOS a process's start time is ps's lstart (the detached driver's clock), so a reused pid is never the holder there either", () => {
  const calls: string[][] = [];
  const exec = (file: string, args: string[]) => (calls.push([file, ...args]), { code: 0, stdout: "Mon Oct 13 02:00:01 2026\n" });
  assert.equal(procStart(4242, "darwin", exec), "Mon Oct 13 02:00:01 2026");
  assert.deepEqual(calls[0], ["ps", "-o", "lstart=", "-p", "4242"]);
  assert.equal(procStart(4242, "darwin", () => ({ code: 1, stdout: "" })), null, "no such process");
  // The holder's recorded start against the one now: the same process, or a later one on its pid.
  assert.equal(holderAlive({ pid: process.pid, start: "Mon Oct 13 02:00:01 2026" }, () => "Mon Oct 13 02:00:01 2026"), true);
  assert.equal(holderAlive({ pid: process.pid, start: "Mon Oct 13 02:00:01 2026" }, () => "Tue Oct 14 09:00:00 2026"), false);
  // A lock file written so is read back as it was.
  writeFileSync(lockFileOf("/s/f.jsonl", dir), JSON.stringify({ pid: DEAD_PID, start: "Mon Oct 13 02:00:01 2026", at: 1, unit: null, path: "/s/f.jsonl" }));
  assert.equal(readLock("/s/f.jsonl", dir)?.start, "Mon Oct 13 02:00:01 2026");
});

test("a lock is published whole: a failed write publishes none; one left unreadable by a crash is taken over once 10 s old, refused before", () => {
  // The write fails (here: something in the way of its temporary file): no lock, and the next take works.
  const blocker = `${lockFileOf("/s/g.jsonl", dir)}.${process.pid}.tmp`;
  mkdirSync(blocker);
  assert.throws(() => takeWriterLock("/s/g.jsonl", { dir }));
  assert.equal(existsSync(lockFileOf("/s/g.jsonl", dir)), false, "nothing published");
  rmSync(blocker, { recursive: true });
  takeWriterLock("/s/g.jsonl", { dir }).release();
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "no temporary file left");
  // Empty, as an older process's crash between create and write leaves it: held while fresh, taken over once old.
  const file = lockFileOf("/s/h.jsonl", dir);
  writeFileSync(file, "");
  assert.throws(() => takeWriterLock("/s/h.jsonl", { dir }), (e) => e instanceof WriterLockHeld && e.holder.pid === 0);
  const old = (Date.now() - 11_000) / 1000;
  utimesSync(file, old, old);
  const lock = takeWriterLock("/s/h.jsonl", { dir });
  assert.equal(readLock("/s/h.jsonl", dir)?.pid, process.pid);
  lock.release();
});
