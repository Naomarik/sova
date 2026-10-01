import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { portOwner as procPortOwner, type PortOwner } from "../port-owner";

/**
 * The host's process table, as the detached driver needs it (§app.project-services/supervisor):
 * from /proc on Linux, else from `ps`, so the driver runs on macOS and the other Unixes too. Both
 * answer the same questions; /proc answers them more precisely (a clock-tick start time, and the
 * session of every process), and `ps` falls back where a platform's `ps` lacks a column.
 */

export interface ProcEntry {
  pid: number;
  ppid: number;
  pgid: number;
  /** The session id, when this table can read it (`null`: it can't). */
  sid: number | null;
  zombie: boolean;
}

export interface ProcTable {
  readonly kind: "procfs" | "ps";
  /** Whether `sid` is a real session id (else a unit is its leader's process tree and groups). */
  readonly sessions: boolean;
  list(): ProcEntry[];
  get(pid: number): ProcEntry | null;
  /** An opaque start time: with the pid, it tells a process from a later one that reused its pid. */
  startOf(pid: number): string | null;
}

/** Run a program to completion by argv, synchronously (tests fake it). */
export type SyncExec = (file: string, args: string[]) => { code: number; stdout: string };

export const realSyncExec: SyncExec = (file, args) => {
  try {
    const stdout = execFileSync(file, args, { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string };
    return { code: typeof e.status === "number" ? e.status : 127, stdout: typeof e.stdout === "string" ? e.stdout : "" };
  }
};

// ---- /proc --------------------------------------------------------------------------------------

/** `/proc/<pid>/stat` fields after the command name: [state, ppid, pgrp, session, …]; index 19 is starttime. */
function statFields(pid: number): string[] | null {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    return s.slice(s.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}
const entryOfStat = (pid: number, f: string[]): ProcEntry => ({ pid, ppid: Number(f[1]), pgid: Number(f[2]), sid: Number(f[3]), zombie: f[0] === "Z" });

export const procfsTable: ProcTable = {
  kind: "procfs",
  sessions: true,
  list() {
    let dirs: string[] = [];
    try {
      dirs = readdirSync("/proc").filter((d) => /^\d+$/.test(d));
    } catch {
      return [];
    }
    const out: ProcEntry[] = [];
    for (const d of dirs) {
      const f = statFields(Number(d));
      if (f) out.push(entryOfStat(Number(d), f));
    }
    return out;
  },
  get(pid) {
    const f = statFields(pid);
    return f ? entryOfStat(pid, f) : null;
  },
  startOf: (pid) => statFields(pid)?.[19] ?? null,
};

// ---- ps -----------------------------------------------------------------------------------------

/** `ps -o pid=,ppid=,pgid=,stat=[,sid=]` lines → entries (pure, for tests). */
export function parsePs(text: string, withSid: boolean): ProcEntry[] {
  const out: ProcEntry[] = [];
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < (withSid ? 5 : 4)) continue;
    const [pid, ppid, pgid] = f.slice(0, 3).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid)) continue;
    out.push({ pid: pid!, ppid: ppid!, pgid: pgid!, sid: withSid ? Number(f[4]) : null, zombie: (f[3] ?? "").startsWith("Z") });
  }
  return out;
}

/**
 * The table from `ps` (POSIX columns, plus `sid` where the platform's ps has it: Linux and FreeBSD
 * do, macOS does not). Every call runs `ps`; nothing is cached but whether `sid` exists.
 */
export function psTable(exec: SyncExec = realSyncExec): ProcTable {
  let withSid: boolean | null = null;
  const sid = () => (withSid ??= (() => {
    const r = exec("ps", ["-o", "sid=", "-p", String(process.pid)]);
    return r.code === 0 && /^\s*\d+\s*$/.test(r.stdout);
  })());
  const cols = () => `pid=,ppid=,pgid=,stat=${sid() ? ",sid=" : ""}`;
  return {
    kind: "ps",
    get sessions() {
      return sid();
    },
    list() {
      const r = exec("ps", ["-A", "-o", cols()]);
      return r.code === 0 ? parsePs(r.stdout, sid()) : [];
    },
    get(pid) {
      const r = exec("ps", ["-o", cols(), "-p", String(pid)]);
      return r.code === 0 ? (parsePs(r.stdout, sid()).find((e) => e.pid === pid) ?? null) : null;
    },
    startOf(pid) {
      const r = exec("ps", ["-o", "lstart=", "-p", String(pid)]);
      const t = r.stdout.trim().replace(/\s+/g, " ");
      return r.code === 0 && t ? t : null;
    },
  };
}

/** This host's table: /proc where it is readable, else `ps`. */
export function hostProcTable(platform: NodeJS.Platform = process.platform, exec: SyncExec = realSyncExec): ProcTable {
  return platform === "linux" && procfsTable.get(process.pid) ? procfsTable : psTable(exec);
}

/**
 * The live processes of the unit whose leader (a session leader, so also its group's) is `leader`
 * (pure). With real session ids, every process of its session, process groups inside it included.
 * Without them, the leader's process tree, and every process in a group a member created (so a
 * grandchild whose parent died still counts). A process that starts a session of its own escapes
 * both; without session ids, so does an orphan in a group of its own.
 */
export function unitMembers(entries: ProcEntry[], leader: number, sessions: boolean): number[] {
  if (sessions) return entries.filter((e) => e.sid === leader && !e.zombie).map((e) => e.pid);
  const set = new Set<number>(entries.filter((e) => e.pid === leader || e.pgid === leader).map((e) => e.pid));
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of entries)
      if (!set.has(e.pid) && (set.has(e.ppid) || set.has(e.pgid))) {
        set.add(e.pid);
        grew = true;
      }
  }
  return entries.filter((e) => set.has(e.pid) && !e.zombie).map((e) => e.pid);
}

// ---- who listens on a port ----------------------------------------------------------------------

/** `lsof -F pn` output → the first listener on loopback or any address (pure, for tests). */
export function parseLsofListen(text: string): number | null {
  let pid: number | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) {
      const host = line.slice(1).replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
      if (host === "*" || host === "::" || host === "0.0.0.0" || host === "::1" || host.startsWith("127.") || host === "localhost") return pid;
    }
  }
  return null;
}

/**
 * The listener on `port` and its cwd, from `lsof` (macOS and the BSDs ship it). Like /proc it sees
 * only this user's processes; with no `lsof` the answer is `unknown`.
 */
export function lsofPortOwner(port: number, exec: SyncExec = realSyncExec): PortOwner {
  const r = exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"]);
  if (r.code !== 0 && r.code !== 1) return "unknown";
  const pid = parseLsofListen(r.stdout);
  // Nothing listens, or only on an address a loopback start doesn't collide with (as /proc's reading).
  if (pid === null) return "none";
  const c = exec("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  const cwd = c.stdout.split("\n").find((l) => l.startsWith("n"))?.slice(1);
  return cwd ? { pid, cwd } : "unknown";
}

/** Who listens on `port` on this host: from /proc on Linux, else from `lsof`. */
export function hostPortOwner(port: number, platform: NodeJS.Platform = process.platform, exec: SyncExec = realSyncExec): PortOwner {
  return platform === "linux" ? procPortOwner(port) : lsofPortOwner(port, exec);
}
