// Resource monitor: CPU accounting and attribution (§app.resource-monitor/attribution). Pure:
// server/resource-monitor.ts reads /proc and hands the samples in.

import type { MonitorVia } from "../shared/protocol";
import type { ArgvInfo, ProcEnv, ProcStat } from "./resource-monitor-proc";

// ── CPU: per-process deltas that count reaped children once ─────────────────────────────────

/** What the fold keeps per process between ticks. Keyed `${pid}:${starttime}`. */
export interface CpuPrev {
  pid: number;
  ppid: number;
  /** utime + stime. */
  us: number;
  /** cutime + cstime. */
  c: number;
  /** Deductions owed while the process was not re-read (see CpuSample.stale). */
  pending?: number;
}

export interface CpuSample {
  key: string;
  stat: ProcStat;
  /** First sighting of a process that started after sampling began: its whole lifetime counts.
      A first sighting of an older process is a baseline (0), never a spike. */
  fresh: boolean;
  /** Not re-read this tick (an idle process read less often): `stat` is the last one read. It
      is charged nothing now; what it spent, and what its reaped children owe, lands at its next
      read, so totals stay exact and only the timing of an idle process waking up is coarser. */
  stale?: boolean;
}

export interface CpuFold {
  /** Clock ticks spent this tick, per process: its own time, plus the time of children reaped
      since the last tick that the last tick did not already count. */
  own: Map<string, number>;
  kids: Map<string, number>;
  next: Map<string, CpuPrev>;
}

export const cpuKey = (s: Pick<ProcStat, "pid" | "starttime">) => `${s.pid}:${s.starttime}`;

/**
 * One tick of the subtree CPU fold. A process's delta is Δ(utime+stime) plus Δ(cutime+cstime)
 * less what its vanished descendants had already been charged when last seen: a reaped child's
 * whole lifetime lands in its parent's cutime, and the part of it earlier ticks counted must
 * not count again. Every term is clamped at 0 (a child reaped by the subreaper after escaping
 * never reaches the parent, so its deduction can overshoot).
 */
export function foldCpu(prev: ReadonlyMap<string, CpuPrev>, samples: readonly CpuSample[]): CpuFold {
  const own = new Map<string, number>();
  const kids = new Map<string, number>();
  const next = new Map<string, CpuPrev>();
  const liveByPid = new Map<number, string>();
  for (const s of samples) liveByPid.set(s.stat.pid, s.key);
  // Deductions: each vanished process's last-seen total goes to its nearest live ancestor.
  const prevByPid = new Map<number, CpuPrev>();
  for (const [k, p] of prev) if (!liveByPid.has(p.pid) || liveByPid.get(p.pid) !== k) prevByPid.set(p.pid, p);
  const deduct = new Map<string, number>();
  for (const [k, p] of prev) {
    if (liveByPid.get(p.pid) === k) continue;
    let ppid = p.ppid;
    for (let depth = 0; depth < 64 && ppid > 1; depth++) {
      const live = liveByPid.get(ppid);
      if (live) {
        deduct.set(live, (deduct.get(live) ?? 0) + p.us + p.c + (p.pending ?? 0));
        break;
      }
      const up = prevByPid.get(ppid);
      if (!up) break;
      ppid = up.ppid;
    }
  }
  for (const s of samples) {
    const p = prev.get(s.key);
    if (s.stale && p) {
      own.set(s.key, 0);
      kids.set(s.key, 0);
      const owed = (p.pending ?? 0) + (deduct.get(s.key) ?? 0);
      next.set(s.key, { ...p, ...(owed ? { pending: owed } : {}) });
      continue;
    }
    const us = s.stat.utime + s.stat.stime;
    const c = s.stat.cutime + s.stat.cstime;
    const dUs = p ? us - p.us : s.fresh ? us : 0;
    const dC = p ? c - p.c : s.fresh ? c : 0;
    own.set(s.key, Math.max(0, dUs));
    kids.set(s.key, Math.max(0, dC - (deduct.get(s.key) ?? 0) - (p?.pending ?? 0)));
    next.set(s.key, { pid: s.stat.pid, ppid: s.stat.ppid, us, c });
  }
  return { own, kids, next };
}

// ── Attribution ──────────────────────────────────────────────────────────────────────────────

/** A worker as the subagents runtime published it (in-process event; `pid` only while alive). */
export interface WorkerInfo {
  id: string;
  name?: string;
  status?: string;
  backend?: string;
  pid?: number;
  sessionFile?: string;
  sessionId?: string;
  teamId?: string;
  lastActivity?: number;
}

/** A session hosted in this server's process. */
export interface HostedInfo {
  path: string;
  sessionId: string;
  cwd?: string;
  title?: string;
  workers: WorkerInfo[];
  /** The Claude Code provider's `--session-id`s for this session (claudeSessionId(id, n)). */
  providerIds: readonly string[];
  /** A tool was running during the tick's window (for `exited-tools`). */
  toolInWindow: boolean;
}

/** Who a process is charged to. `session` absent with `worker` set: a worker no join tied to a
    session (`unowned:<pid>`). */
export interface Owner {
  session?: string;
  worker?: string;
  via: MonitorVia;
}

export interface AttribProc {
  stat: ProcStat;
  argv: ArgvInfo;
  env: ProcEnv;
  /** Read lazily; undefined = not read. */
  cwd?: string;
}

export interface AttribInput {
  procs: ReadonlyMap<number, AttribProc>;
  serverPid: number;
  /** The server's own environment's entries, if it inherited any (a dev server started from a pi
      or Claude Code tool): every child inherits them too, so they say nothing. */
  serverEnv?: ProcEnv;
  hosted: readonly HostedInfo[];
  /** pi worker pid → its own session file, from the live records (`p<pid>-*.json`). */
  liveRecordPids: ReadonlyMap<number, string>;
  sids: SidMemory;
}

export interface Attribution {
  owners: Map<number, Owner>;
  /** pids under the server (the server excluded). */
  inTree: Set<number>;
}

const HEURISTIC: ReadonlySet<MonitorVia> = new Set(["cwd", "exited-tools"]);
export const isHeuristic = (via: MonitorVia | undefined) => !!via && HEURISTIC.has(via);

/** Index the hosted sessions once per tick for the joins. */
function indexHosted(hosted: readonly HostedInfo[]) {
  const byPid = new Map<number, Owner>();
  const byClaude = new Map<string, Owner>();
  const byFile = new Map<string, Owner>();
  const byWorkerId = new Map<string, Owner[]>();
  for (const h of hosted) {
    byFile.set(h.path, { session: h.path, via: "env" });
    for (const id of h.providerIds) byClaude.set(id, { session: h.path, via: "session-id" });
    for (const w of h.workers) {
      if (w.pid) byPid.set(w.pid, { session: h.path, worker: w.id, via: "worker-pid" });
      if (w.sessionId) byClaude.set(w.sessionId.toLowerCase(), { session: h.path, worker: w.id, via: "session-id" });
      if (w.sessionFile) byFile.set(w.sessionFile, { session: h.path, worker: w.id, via: "env" });
      const list = byWorkerId.get(w.id) ?? [];
      list.push({ session: h.path, worker: w.id, via: "team-env" });
      byWorkerId.set(w.id, list);
    }
  }
  return { byPid, byClaude, byFile, byWorkerId };
}

/**
 * Charge every measured process to a session and worker, strongest evidence first: the
 * runtime's worker pid, a claude session uuid, a pi worker's live record, a team member's env,
 * the PI_SESSION_FILE pi's bash tool sets, then the nearest charged ancestor, then sid memory,
 * then (heuristic) cwd. A direct child of the server that looks like a worker and matched
 * nothing becomes an unowned worker, and its subtree goes with it.
 */
export function attribute(input: AttribInput): Attribution {
  const { procs, serverPid } = input;
  const idx = indexHosted(input.hosted);
  const direct = (p: AttribProc): Owner | undefined => {
    const s = p.stat;
    const byPid = idx.byPid.get(s.pid);
    if (byPid) return byPid;
    if (p.argv.claudeSession) {
      const o = idx.byClaude.get(p.argv.claudeSession);
      if (o) return o;
    }
    if (p.argv.kind === "pi-worker") {
      const file = input.liveRecordPids.get(s.pid);
      const o = file ? idx.byFile.get(file) : undefined;
      if (o?.worker) return { ...o, via: "live-record" };
    }
    if (p.env.team) {
      const list = (idx.byWorkerId.get(p.env.team.workerId) ?? []).filter((o) => {
        const h = input.hosted.find((x) => x.path === o.session);
        const w = h?.workers.find((x) => x.id === o.worker);
        return !w?.teamId || w.teamId === p.env.team!.teamId;
      });
      if (list.length === 1) return list[0];
    }
    // Claude Code's tool children name their claude process and session; they are nearer than
    // PI_SESSION_FILE, which a claude started from a pi tool would pass down too.
    const own = input.serverEnv ?? {};
    if (p.env.claudePid && p.env.claudePid !== own.claudePid) {
      const o = idx.byPid.get(p.env.claudePid);
      if (o) return { ...o, via: "env" };
    }
    if (p.env.claudeSession && p.env.claudeSession !== own.claudeSession) {
      const o = idx.byClaude.get(p.env.claudeSession);
      if (o) return { ...o, via: "env" };
    }
    if (p.env.sessionFile && p.env.sessionFile !== own.sessionFile) {
      const o = idx.byFile.get(p.env.sessionFile);
      if (o) return o;
    }
    return undefined;
  };

  const owners = new Map<number, Owner>();
  const inTree = new Set<number>();
  const state = new Map<number, 0 | 1>(); // 0 = resolving (cycle guard), 1 = done
  const resolve = (pid: number): Owner | undefined => {
    if (state.get(pid) === 1) return owners.get(pid);
    if (state.get(pid) === 0) return undefined;
    state.set(pid, 0);
    const p = procs.get(pid)!;
    const ppid = p.stat.ppid;
    let owner = direct(p);
    const parent = procs.get(ppid);
    if (ppid === serverPid) inTree.add(pid);
    else if (parent && parent.stat.pid !== serverPid) {
      const up = resolve(ppid);
      if (inTree.has(ppid)) inTree.add(pid);
      if (!owner && up) owner = up.session === undefined && up.worker?.startsWith("unowned:") ? up : { ...up, via: "descendant" };
    }
    // A worker-looking child of the server that matched nothing is its own (unowned) group.
    if (!owner && ppid === serverPid && (p.argv.kind === "pi-worker" || p.argv.kind === "claude-worker"))
      owner = { worker: `unowned:${pid}`, via: "descendant" };
    if (owner) owners.set(pid, owner);
    state.set(pid, 1);
    return owner;
  };
  for (const pid of procs.keys()) if (pid !== serverPid) resolve(pid);

  // Orphans: sid memory, then cwd within exactly one hosted session's cwd (heuristic).
  const cwds = input.hosted.filter((h) => h.cwd && h.cwd !== "/").map((h) => ({ cwd: h.cwd!, path: h.path }));
  for (const [pid, p] of procs) {
    if (pid === serverPid || owners.has(pid)) continue;
    const bySid = input.sids.lookup(p.stat, procs);
    if (bySid) {
      owners.set(pid, { ...bySid, via: "sid" });
      continue;
    }
    if (p.cwd) {
      const hits = cwds.filter((c) => p.cwd === c.cwd || p.cwd!.startsWith(c.cwd.endsWith("/") ? c.cwd : c.cwd + "/"));
      // The longest cwd wins only when no other session shares it.
      const longest = Math.max(...hits.map((h) => h.cwd.length));
      const top = hits.filter((h) => h.cwd.length === longest);
      if (top.length === 1) owners.set(pid, { session: top[0]!.path, via: "cwd" });
    }
  }
  // Orphans of an orphan inherit what the sid/cwd pass found for their parent.
  for (const [pid, p] of procs) {
    if (owners.has(pid) || pid === serverPid) continue;
    let ppid = p.stat.ppid;
    for (let depth = 0; depth < 64; depth++) {
      const o = owners.get(ppid);
      if (o) {
        owners.set(pid, o.via === "cwd" ? o : { ...o, via: "descendant" });
        break;
      }
      const up = procs.get(ppid);
      if (!up || ppid === serverPid) break;
      ppid = up.stat.ppid;
    }
  }
  return { owners, inTree };
}

// ── sid memory ───────────────────────────────────────────────────────────────────────────────

interface SidEntry {
  /** Starttime of the session leader (pid == sid) when seen, else the earliest member's. */
  leaderStart: number;
  session?: string;
  worker?: string;
  /** Members were seen charged to two different owners: never used. */
  conflicted: boolean;
  lastSeen: number;
}

/**
 * `(sid, leader starttime) → owner`, learned from processes charged by exact evidence, so a
 * process that was backgrounded, nohup'd or reparented out of the tree while keeping its session
 * id is still charged. The server's own sid (and 0/1) is never learned: everything it spawned
 * without setsid shares it.
 */
export class SidMemory {
  private map = new Map<number, SidEntry>();
  constructor(private readonly excluded: ReadonlySet<number> = new Set(), private readonly ttlMs = 6 * 3600_000, private readonly cap = 5000) {}

  get size() {
    return this.map.size;
  }

  learn(procs: ReadonlyMap<number, AttribProc>, owners: ReadonlyMap<number, Owner>, now: number): void {
    for (const [pid, p] of procs) {
      const o = owners.get(pid);
      const sid = p.stat.sid;
      if (!o || sid <= 1 || this.excluded.has(sid) || o.via === "sid" || isHeuristic(o.via) || o.session === undefined) continue;
      const leader = procs.get(sid);
      const leaderStart = leader ? leader.stat.starttime : p.stat.starttime;
      const e = this.map.get(sid);
      if (!e || (leader && e.leaderStart !== leader.stat.starttime)) {
        // New, or the sid number was reused by a new leader.
        this.map.set(sid, { leaderStart, session: o.session, ...(o.worker ? { worker: o.worker } : {}), conflicted: false, lastSeen: now });
        continue;
      }
      if (!leader && leaderStart < e.leaderStart) e.leaderStart = leaderStart;
      if (e.session !== o.session || e.worker !== o.worker) e.conflicted = true;
      e.lastSeen = now;
    }
    // Refresh entries whose members are still alive (even uncharged), then expire the rest.
    for (const p of procs.values()) {
      const e = this.map.get(p.stat.sid);
      if (e) e.lastSeen = Math.max(e.lastSeen, now);
    }
    for (const [sid, e] of this.map) if (now - e.lastSeen > this.ttlMs) this.map.delete(sid);
    if (this.map.size > this.cap) {
      const oldest = [...this.map].sort((a, b) => a[1].lastSeen - b[1].lastSeen).slice(0, this.map.size - this.cap);
      for (const [sid] of oldest) this.map.delete(sid);
    }
  }

  lookup(stat: ProcStat, procs: ReadonlyMap<number, AttribProc>): Omit<Owner, "via"> | undefined {
    const e = this.map.get(stat.sid);
    if (!e || e.conflicted || e.session === undefined) return undefined;
    // Older than the session it claims to be in: the sid number was reused.
    if (stat.starttime < e.leaderStart) return undefined;
    const leader = procs.get(stat.sid);
    if (leader && leader.stat.starttime !== e.leaderStart) return undefined;
    return { session: e.session, ...(e.worker ? { worker: e.worker } : {}) };
  }
}
