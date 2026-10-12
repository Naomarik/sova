// One writer per session file (al_3 stage 2): whichever process hosts a chat (a chat process, or the
// server for a chat in its own process) holds a lock file for it while the chat is open, so a chat
// is never hosted twice: a spawn for a path the server holds fails safe, and so does the reverse.
// The lock is `<state root>/chats/locks/<sha256(path)[0..16]>.lock`, created O_EXCL, holding
// `{pid, start, at, unit, path}`; `start` is the process's start time (field 22 of /proc/<pid>/stat)
// where there is a /proc, so a reused pid never reads as the holder. A lock whose process is gone is
// stale: it is taken over.
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { chatStateRoot } from "../state-root";

export interface WriterLockInfo {
  pid: number;
  /** The holder's start time in clock ticks since boot; null where there is no /proc. */
  start: number | null;
  at: number;
  unit: string | null;
  path: string;
}

/** The lock is another live process's. */
export class WriterLockHeld extends Error {
  constructor(readonly holder: WriterLockInfo) {
    super(`This chat is already open in another Sova process (pid ${holder.pid})`);
  }
}

export const locksDir = () => join(chatStateRoot(), "chats", "locks");
export const lockFileOf = (path: string, dir = locksDir()) => join(dir, `${createHash("sha256").update(path).digest("hex").slice(0, 16)}.lock`);

/** A process's start time (clock ticks since boot), or null: no /proc, or no such process. */
export function procStart(pid: number): number | null {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
    const v = Number(f[19]);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether the process a lock names still runs (the same process, not a reused pid). */
export function holderAlive(info: Pick<WriterLockInfo, "pid" | "start">): boolean {
  if (!alive(info.pid)) return false;
  if (info.start === null) return true;
  const now = procStart(info.pid);
  return now === null || now === info.start;
}

/** The lock on `path` as its file says, or null (none, or unreadable). */
export function readLock(path: string, dir = locksDir()): WriterLockInfo | null {
  try {
    const v = JSON.parse(readFileSync(lockFileOf(path, dir), "utf8")) as Partial<WriterLockInfo>;
    if (typeof v.pid !== "number") return null;
    return { pid: v.pid, start: typeof v.start === "number" ? v.start : null, at: Number(v.at) || 0, unit: typeof v.unit === "string" ? v.unit : null, path: typeof v.path === "string" ? v.path : path };
  } catch {
    return null;
  }
}

/** Remove the lock on `path` if it still names `holder` (a stale lock the server cleans up after a
    death); true when it did. */
export function releaseLockOf(path: string, holder: Pick<WriterLockInfo, "pid" | "start">, dir = locksDir()): boolean {
  const now = readLock(path, dir);
  if (!now || now.pid !== holder.pid || now.start !== holder.start) return false;
  rmSync(lockFileOf(path, dir), { force: true });
  return true;
}

export interface WriterLock {
  readonly info: WriterLockInfo;
  /** Let go of it (once; a lock taken over since is left alone). */
  release(): void;
}

/**
 * Take the lock on session file `path` for this process. Throws WriterLockHeld when another live
 * process holds it (this process too: one hold per path). A stale lock is taken over once.
 */
export function takeWriterLock(path: string, opts: { unit?: string | null; dir?: string } = {}): WriterLock {
  const dir = opts.dir ?? locksDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = lockFileOf(path, dir);
  const info: WriterLockInfo = { pid: process.pid, start: procStart(process.pid), at: Date.now(), unit: opts.unit ?? null, path };
  for (let attempt = 0; ; attempt++) {
    let fd: number;
    try {
      fd = openSync(file, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const held = readLock(path, dir);
      // Unreadable: a holder mid-write. Its own process is alive (it just created it): held.
      if (held && !holderAlive(held) && attempt === 0) {
        rmSync(file, { force: true });
        continue;
      }
      throw new WriterLockHeld(held ?? { pid: 0, start: null, at: 0, unit: null, path });
    }
    try {
      writeSync(fd, JSON.stringify(info));
    } finally {
      closeSync(fd);
    }
    let released = false;
    return {
      info,
      release() {
        if (released) return;
        released = true;
        releaseLockOf(path, info, dir);
      },
    };
  }
}
