import assert from "node:assert/strict";
import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BLANK_LOCK_GRACE_MS, pickSlot, takeOver, tryLock, type InstanceRecord, type Registry } from "./store";

/** Above any pid the kernel hands out (Linux's pid_max is at most 2^22): never a live process. */
const DEAD_PID = 2 ** 22 + 1;

const rec = (over: Partial<InstanceRecord>): InstanceRecord => ({
  id: "p-1",
  project: "/p",
  checkout: "/p",
  branch: null,
  slot: 0,
  generation: 0,
  createdBy: "operator",
  createdAt: "",
  cutWorktree: false,
  desired: {},
  prints: {},
  data: {},
  ports: {},
  ...over,
});

test("pickSlot takes the lowest slot whose ports nobody holds", () => {
  const r: Registry = { version: 1, instances: [rec({ slot: 0, ports: { web: { http: 4000 } } }), rec({ id: "p-2", checkout: "/p-a", slot: 1, ports: { web: { http: 4001 } } })], shared: [] };
  const ports = (slot: number) => [4000 + slot];
  assert.deepEqual(pickSlot(r, "/p", ports, [1, 2, 3], () => false), { slot: 2 });
  // Something listening on slot 2's port: skipped, never taken.
  assert.deepEqual(pickSlot(r, "/p", ports, [1, 2, 3], (p) => p === 4002), { slot: 3 });
  // Another project's instance holding slot 3's port counts too (ports are host-wide).
  r.instances.push(rec({ id: "q-1", project: "/q", checkout: "/q", slot: 0, ports: { api: { http: 4003 } } }));
  const none = pickSlot(r, "/p", ports, [1, 2, 3], (p) => p === 4002);
  assert.ok("refused" in none && /4003.*q-1/.test(none.refused), JSON.stringify(none));
  // An explicit slot is taken or refused, never moved.
  assert.deepEqual(pickSlot(r, "/p", ports, [1, 2, 3], () => false, 2), { slot: 2 });
  assert.ok("refused" in pickSlot(r, "/p", ports, [1, 2, 3], () => false, 1));
  // Another project's shared services claim their ports; this project's own do not block it.
  r.shared.push({ project: "/q", id: "q-shared", desired: {}, ports: { redis: { main: 4002 } } }, { project: "/p", id: "p-shared", desired: {}, ports: { redis: { main: 4005 } } });
  assert.ok("refused" in pickSlot(r, "/p", ports, [2], () => false));
  assert.deepEqual(pickSlot(r, "/p", ports, [5], () => false), { slot: 5 });
});

test("a lock is held against this process and taken over from a dead one", () => {
  const dir = mkdtempSync(join(tmpdir(), "sova-lock-"));
  const file = join(dir, "x.lock");
  const a = tryLock(file);
  assert.ok("release" in a);
  const b = tryLock(file);
  assert.ok("heldBy" in b && b.heldBy === process.pid, "a second caller in the same process is refused");
  a.release();
  const c = tryLock(file);
  assert.ok("release" in c, "released: free again");
  c.release();
  // A stale lock: its pid is gone. (Real writers in other processes: store.integration.test.ts.)
  writeFileSync(file, String(DEAD_PID));
  const d = tryLock(file);
  assert.ok("release" in d, "a dead holder's lock is taken over");
  d.release();
  rmSync(dir, { recursive: true, force: true });
});

test("a lock without a pid is held while young and stale debris once old", () => {
  const dir = mkdtempSync(join(tmpdir(), "sova-lock-"));
  const file = join(dir, "x.lock");
  // Created but not yet written (older code wrote the pid after creating the file): held, never stolen.
  writeFileSync(file, "");
  const a = tryLock(file);
  assert.ok("heldBy" in a, "a fresh empty lock is held");
  assert.equal(readFileSync(file, "utf8"), "", "and left as it was");
  writeFileSync(file, "not a pid");
  assert.ok("heldBy" in tryLock(file), "a fresh lock with no integer pid is held");
  // The same lock long after: a crash between create and write. It must not block for good.
  writeFileSync(file, "");
  const old = (Date.now() - 60_000) / 1000;
  utimesSync(file, old, old);
  assert.ok(60_000 > BLANK_LOCK_GRACE_MS);
  const b = tryLock(file);
  assert.ok("release" in b, "an old empty lock is taken over");
  assert.equal(readFileSync(file, "utf8"), String(process.pid));
  b.release();
  assert.deepEqual(readdirSync(dir), [], "no temp, stale or takeover file is left behind");
  rmSync(dir, { recursive: true, force: true });
});

test("creating a lock never overwrites one that exists, and a release removes only its own lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "sova-lock-"));
  const file = join(dir, "x.lock");
  // Another live holder (this process's parent stands in for one).
  writeFileSync(file, String(process.ppid));
  const a = tryLock(file);
  assert.ok("heldBy" in a && a.heldBy === process.ppid);
  assert.equal(readFileSync(file, "utf8"), String(process.ppid), "the holder's lock is untouched");
  // The primitive itself: a hard link onto an existing name fails rather than replacing it.
  writeFileSync(join(dir, "other"), "1");
  assert.throws(() => linkSync(join(dir, "other"), file), /EEXIST/);
  rmSync(join(dir, "other"));
  rmSync(file);
  // Our lock replaced by someone else's (a takeover): our release must leave theirs.
  const b = tryLock(file);
  assert.ok("release" in b);
  rmSync(file);
  writeFileSync(file, String(process.ppid));
  b.release();
  assert.equal(readFileSync(file, "utf8"), String(process.ppid), "release left the other caller's lock");
  rmSync(dir, { recursive: true, force: true });
});

test("a takeover judges the lock as it is now, never by its inode alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "sova-lock-"));
  const file = join(dir, "x.lock");
  // A live holder's lock (the test runner, our parent) now sits on the inode a taker saw as a dead
  // holder's: the old lock was removed and the new one reused its inode.
  writeFileSync(file, String(process.ppid));
  const st = statSync(file, { bigint: true });
  const seenEarlier = { pid: DEAD_PID, dev: st.dev, ino: st.ino, mtimeNs: st.mtimeNs, mtimeMs: Number(st.mtimeMs) };
  assert.equal(takeOver(file, seenEarlier), null);
  assert.ok(existsSync(file), "the live lock is still there");
  assert.equal(readFileSync(file, "utf8"), String(process.ppid));
  // Even a lock matching what was seen exactly is left while its pid is alive.
  assert.equal(takeOver(file, { ...seenEarlier, pid: process.ppid }), null);
  assert.equal(readFileSync(file, "utf8"), String(process.ppid));
  assert.deepEqual(readdirSync(dir), ["x.lock"], "no guard or moved file is left behind");
  rmSync(dir, { recursive: true, force: true });
});

test("a release leaves another caller's lock on the same inode", () => {
  const dir = mkdtempSync(join(tmpdir(), "sova-lock-"));
  const file = join(dir, "x.lock");
  const a = tryLock(file);
  assert.ok("release" in a);
  // Our lock taken over and a new holder's lock on the very same inode (written in place).
  writeFileSync(file, String(process.ppid));
  a.release();
  assert.equal(readFileSync(file, "utf8"), String(process.ppid), "release left the other caller's lock");
  rmSync(dir, { recursive: true, force: true });
});
