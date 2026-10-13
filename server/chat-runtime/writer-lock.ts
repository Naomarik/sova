// One writer per session file (al_3 stage 2): whichever process hosts a chat (a chat process, or the
// server for a chat in its own process) holds a lock file for it while the chat is open, so a chat
// is never hosted twice: a spawn for a path the server holds fails safe, and so does the reverse.
// The lock is `<state root>/chats/locks/<sha256(path)[0..16]>.lock`, published whole by a hard link
// (EEXIST: held), holding
// `{pid, start, at, unit, path}`; `start` is the process's start time (field 22 of /proc/<pid>/stat
// on Linux, `ps -o lstart=` elsewhere: the clock the detached driver records), so a reused pid never
// reads as the holder. A lock whose process is gone is
// stale: it is taken over.
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { psTable, realSyncExec, type SyncExec } from "../project-services/proctable";
import { chatStateRoot } from "../state-root";

export interface WriterLockInfo {
  pid: number;
  /** The holder's start time: clock ticks since boot (Linux), `ps`'s lstart text (macOS); null when unknown. */
  start: number | string | null;
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

/** A process's start time (clock ticks since boot on Linux, `ps`'s lstart elsewhere), or null: no such process. */
export function procStart(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  exec: SyncExec = realSyncExec,
  readStat: (pid: number) => string = (p) => readFileSync(`/proc/${p}/stat`, "utf8"),
): number | string | null {
  if (platform !== "linux") return psTable(exec).startOf(pid);
  try {
    const s = readStat(pid);
    const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
    const v = Number(f[19]);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

let startOf: (pid: number) => number | string | null = (pid) => procStart(pid);
/** Tests: where start times come from (unit tests spawn no `ps`); null: the platform's own. */
export function setProcStartForTest(fn: ((pid: number) => number | string | null) | null): void {
  startOf = fn ?? ((pid) => procStart(pid));
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
export function holderAlive(info: Pick<WriterLockInfo, "pid" | "start">, start: (pid: number) => number | string | null = startOf): boolean {
  if (!alive(info.pid)) return false;
  if (info.start === null) return true;
  const now = start(info.pid);
  return now === null || now === info.start;
}

/** The lock on `path` as its file says, or null (none, or unreadable). */
export function readLock(path: string, dir = locksDir()): WriterLockInfo | null {
  try {
    const v = JSON.parse(readFileSync(lockFileOf(path, dir), "utf8")) as Partial<WriterLockInfo>;
    if (typeof v.pid !== "number") return null;
    return { pid: v.pid, start: typeof v.start === "number" || typeof v.start === "string" ? v.start : null, at: Number(v.at) || 0, unit: typeof v.unit === "string" ? v.unit : null, path: typeof v.path === "string" ? v.path : path };
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

/** An unreadable lock this old is a crash's leftover (an older process died between creating it and
    writing it); younger, it may be a holder mid-write: held. */
const UNREADABLE_STALE_MS = 10_000;

function unreadableAndOld(file: string): boolean {
  try {
    return Date.now() - statSync(file).mtimeMs >= UNREADABLE_STALE_MS;
  } catch {
    return false;
  }
}

export interface WriterLock {
  readonly info: WriterLockInfo;
  /** Let go of it (once; a lock taken over since is left alone). */
  release(): void;
}

/**
 * Take the lock on session file `path` for this process. Throws WriterLockHeld when another live
 * process holds it (this process too: one hold per path). A stale lock is taken over once; one let go
 * of between our refused link and the read of its holder is taken. `raced` (a test seam) runs there.
 */
export function takeWriterLock(path: string, opts: { unit?: string | null; dir?: string; raced?: () => void } = {}): WriterLock {
  const dir = opts.dir ?? locksDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = lockFileOf(path, dir);
  const info: WriterLockInfo = { pid: process.pid, start: startOf(process.pid), at: Date.now(), unit: opts.unit ?? null, path };
  // Published whole: written to a file of this process's own, then linked into place (EEXIST if held).
  // A leftover of that name (a crash after its link) may be another lock's other name: unlinked, never written through.
  const tmp = `${file}.${process.pid}.tmp`;
  const dropTmp = () => {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // not a file: the write below fails and says so
    }
  };
  for (let attempt = 0; ; attempt++) {
    dropTmp();
    try {
      writeFileSync(tmp, JSON.stringify(info), { mode: 0o600, flag: "wx" });
      linkSync(tmp, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      opts.raced?.();
      const held = readLock(path, dir);
      // Released between our link and this read: free now, so taken.
      if (!held && !existsSync(file) && attempt < 2) continue;
      // Unreadable and fresh: an older process mid-write (it created the file before writing): held.
      if ((held ? !holderAlive(held) : unreadableAndOld(file)) && attempt === 0) {
        rmSync(file, { force: true });
        continue;
      }
      throw new WriterLockHeld(held ?? { pid: 0, start: null, at: 0, unit: null, path });
    } finally {
      dropTmp();
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
