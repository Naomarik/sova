import { readdir, readFile, readlink } from "node:fs/promises";
import { listeningInodes } from "../port-owner";

/**
 * Who serves a project tour's port, found once and then re-verified at every contact without
 * scanning the host: the listening socket's inodes for that one port (/proc/net/tcp{,6}), and the
 * unit process holding one of them, pinned by its pid and start time. Every read is asynchronous,
 * so a recording's burst of contacts never holds the server's event loop (its in-process proxy
 * included). Linux only: callers keep the platform's own lookup elsewhere.
 */

/** The process state couldn't be read, so this copy's identity can't be verified: never a pass. */
export class TourTargetUnverifiable extends Error {
  readonly guidance = "Retry in a moment. Recording never continues against a copy it can't verify.";
  /** What couldn't be read (for logs; the message is the same for every cause). */
  readonly detail: string;
  constructor(detail: string) {
    super("Sova couldn't verify this running copy: this host's process information can't be read.");
    this.detail = detail;
  }
}

/** The asynchronous /proc reads this check makes; each rejects with the error's code (ENOENT, EACCES, …). */
export interface AsyncProcFs {
  read(path: string): Promise<string>;
  list(path: string): Promise<string[]>;
  link(path: string): Promise<string>;
}

export const realAsyncProcFs: AsyncProcFs = {
  read: (p) => readFile(p, "utf8"),
  list: (p) => readdir(p),
  link: (p) => readlink(p),
};

export interface HeldListener {
  pid: number;
  /** /proc/<pid>/stat starttime: with the pid, tells this process from a later one reusing its pid. */
  start: string;
  /** Every socket inode listening on the port (loopback or any address) when it was found. */
  inodes: string[];
}

/** What a read failure means: a vanished entry is a change (null); anything else is unverifiable. */
const gone = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT" || (error as NodeJS.ErrnoException)?.code === "ESRCH";

async function inodesOf(fs: AsyncProcFs, port: number): Promise<Set<string>> {
  const tables: string[] = [];
  let failure: unknown;
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try { tables.push(await fs.read(path)); } catch (error) { failure ??= error; }
  }
  // tcp6 may be absent on a host without IPv6; with neither table nothing can be told.
  if (!tables.length) throw new TourTargetUnverifiable(`The host's socket tables can't be read (${(failure as Error)?.message ?? "unknown"}).`);
  return listeningInodes(tables, port);
}

/** The start time of `pid`, or null when it no longer exists. */
async function startOf(fs: AsyncProcFs, pid: number): Promise<string | null> {
  let stat: string;
  try { stat = await fs.read(`/proc/${pid}/stat`); } catch (error) {
    if (gone(error)) return null;
    throw new TourTargetUnverifiable(`This copy's process ${pid} can't be read.`);
  }
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
}

/** Whether `pid` holds one of `inodes` among its open files; false when it no longer exists. */
async function holds(fs: AsyncProcFs, pid: number, inodes: Set<string>): Promise<boolean> {
  const wanted = new Set([...inodes].map((i) => `socket:[${i}]`));
  let fds: string[];
  try { fds = await fs.list(`/proc/${pid}/fd`); } catch (error) {
    if (gone(error)) return false;
    throw new TourTargetUnverifiable(`This copy's process ${pid}'s open files can't be read.`);
  }
  for (const fd of fds) {
    let target: string;
    try { target = await fs.link(`/proc/${pid}/fd/${fd}`); } catch (error) {
      if (gone(error)) continue; // closed while listed
      throw new TourTargetUnverifiable(`This copy's process ${pid}'s open files can't be read.`);
    }
    if (wanted.has(target)) return true;
  }
  return false;
}

/** `root`'s descendants, from each process's parent in /proc/<pid>/stat (read asynchronously). */
async function descendants(fs: AsyncProcFs, root: number): Promise<number[]> {
  let dirs: string[];
  try { dirs = (await fs.list("/proc")).filter((d) => /^\d+$/.test(d)); } catch { throw new TourTargetUnverifiable("The host's process list can't be read."); }
  const parent = new Map<number, number>();
  for (const d of dirs) {
    try {
      const stat = await fs.read(`/proc/${d}/stat`);
      parent.set(Number(d), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
    } catch { /* exited while listed, or another user's: not a candidate */ }
  }
  const out: number[] = [];
  const frontier = [root];
  while (frontier.length) {
    const p = frontier.pop()!;
    for (const [pid, pp] of parent) if (pp === p && !out.includes(pid)) { out.push(pid); frontier.push(pid); }
  }
  return out;
}

export type FindListener = { held: HeldListener } | { refused: "none" | "foreign" };

/**
 * Find the unit's process listening on `port`: its main pid first, then its descendants, each also
 * accepted by `inUnit`. "none": nothing listens there; "foreign": something does, but no unit process
 * holds it.
 */
export async function findUnitListener(port: number, mainPid: number, inUnit: (pid: number) => boolean, fs: AsyncProcFs = realAsyncProcFs): Promise<FindListener> {
  const inodes = await inodesOf(fs, port);
  if (!inodes.size) return { refused: "none" };
  const check = async (pid: number): Promise<HeldListener | null> => {
    if (!inUnit(pid)) return null;
    const start = await startOf(fs, pid);
    if (start === null || !(await holds(fs, pid, inodes))) return null;
    // The start is read again after the fds: a pid reused between the two reads isn't taken for the unit's.
    if ((await startOf(fs, pid)) !== start) return null;
    return { pid, start, inodes: [...inodes].sort() };
  };
  const main = await check(mainPid);
  if (main) return { held: main };
  for (const pid of await descendants(fs, mainPid)) {
    const held = await check(pid);
    if (held) return { held };
  }
  return { refused: "foreign" };
}

/**
 * Whether `held` still serves `port`, read live: the port's listening inodes are exactly those found,
 * its process has the same start time, still holds one of them, and is still the unit's.
 * Unreadable state throws TourTargetUnverifiable; a change returns a reason.
 */
export async function verifyUnitListener(port: number, held: HeldListener, inUnit: (pid: number) => boolean, fs: AsyncProcFs = realAsyncProcFs): Promise<null | "listeners" | "process" | "socket" | "unit"> {
  const now = [...(await inodesOf(fs, port))].sort();
  if (now.length !== held.inodes.length || now.some((i, n) => i !== held.inodes[n])) return "listeners";
  if ((await startOf(fs, held.pid)) !== held.start) return "process";
  if (!(await holds(fs, held.pid, new Set(held.inodes)))) return "socket";
  if (!inUnit(held.pid)) return "unit";
  if ((await startOf(fs, held.pid)) !== held.start) return "process";
  return null;
}
