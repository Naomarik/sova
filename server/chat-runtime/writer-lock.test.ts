// Run: pnpm test -- server/chat-runtime/writer-lock.test.ts. One writer per session file: the lock is
// held against everyone (this process too), a dead or reused holder's lock is taken over, and a
// release never removes a lock taken over since.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { lockFileOf, procStart, readLock, releaseLockOf, takeWriterLock, WriterLockHeld } from "./writer-lock";

const dir = mkdtempSync(join(tmpdir(), "wlock-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const DEAD_PID = 0x3ffffff; // above any pid_max: never a live process

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

test("a dead holder's lock is taken over", () => {
  writeFileSync(lockFileOf("/s/c.jsonl", dir), JSON.stringify({ pid: DEAD_PID, start: 1, at: 1, unit: null, path: "/s/c.jsonl" }));
  const lock = takeWriterLock("/s/c.jsonl", { dir });
  assert.equal(readLock("/s/c.jsonl", dir)?.pid, process.pid);
  lock.release();
});

test("a reused pid is not the holder (its start time differs)", { skip: procStart(process.pid) === null ? "no /proc" : false }, () => {
  const start = procStart(process.pid)!;
  writeFileSync(lockFileOf("/s/d.jsonl", dir), JSON.stringify({ pid: process.pid, start: start + 1, at: 1, unit: null, path: "/s/d.jsonl" }));
  const lock = takeWriterLock("/s/d.jsonl", { dir });
  assert.equal(readLock("/s/d.jsonl", dir)?.start, start);
  lock.release();
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
