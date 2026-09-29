// Resource monitor (§app/resource-monitor): a background sampler that charges the CPU and memory
// of every process this server started — workers, the Claude Code provider, tool children such
// as a JVM REPL, and what escaped the tree — to the session and worker that started it.
//
// Lightness (§app.resource-monitor/lightness-budget): each 5s tick reads /proc/<pid>/stat for the
// measured processes, a few cgroup/pressure/loadavg files, and VmSwap for about a sixth of the
// processes (each at most every 30s). stat/status reads are synchronous in small batches that
// yield between them (a sync /proc read costs ~14µs against ~35µs through fs/promises, measured),
// so the loop is never held for more than a batch. cmdline, environ and cwd take the target's
// mm lock and can hang on a stuck process: they are async, once per process. Never smaps/PSS.
//
// Parsers: resource-monitor-proc.ts. CPU fold, joins, sid memory: resource-monitor-attrib.ts.
// Ring, rollups, disk log: resource-monitor-history.ts.

import { closeSync, openSync, readdirSync, readFileSync, readSync as readFd } from "node:fs";
import { readFile, readlink } from "node:fs/promises";
import { availableParallelism, freemem, loadavg, platform, totalmem } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance, type IntervalHistogram } from "node:perf_hooks";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { claudeSessionId } from "../pi-config/extensions/claude-code/provider/session-records.ts";
import type {
  MonitorBucket, MonitorHistory, MonitorPointProc, MonitorProc, MonitorProcKind, MonitorResolution, MonitorScope,
  MonitorSession, MonitorSnapshot, MonitorWorker,
} from "../shared/protocol";
import {
  attribute, cpuKey, foldCpu, SidMemory, type AttribProc, type CpuPrev, type HostedInfo, type Owner, type WorkerInfo,
} from "./resource-monitor-attrib";
import { canonicalPath } from "./paths";
import { MonitorLog, MonitorRing, Rollup, type TickPoint } from "./resource-monitor-history";
import {
  classifyArgv, parseBootTime, parseCmdline, parseEnviron, parseKeyValues, parseLoadavg, parseMeminfo, parseSelfCgroup,
  parseStat, parseStatusRss, parseStatusSwap, pressureOf, type ArgvInfo, type ProcEnv, type ProcStat,
} from "./resource-monitor-proc";

// ── Hosted sessions, as their runtimes report them ───────────────────────────────────────────

interface HostedEntry {
  token: object;
  path: string;
  sessionId: string;
  cwd?: string;
  title?: string;
  workers: WorkerInfo[];
  providerIds: string[];
  toolsRunning: number;
  lastToolEnd: number;
}

/** Launch numbers tried for a hosted session's Claude Code provider (`claudeSessionId(id, n)`). */
const PROVIDER_LAUNCHES = 16;
const hosted = new Map<string, HostedEntry>();
const providerIdCache = new Map<string, string[]>();
/** `claudeSessionId(id, 0..PROVIDER_LAUNCHES-1)`, computed once per session id. */
function providerIdsOf(sessionId: string): string[] {
  let ids = providerIdCache.get(sessionId);
  if (!ids) {
    ids = Array.from({ length: PROVIDER_LAUNCHES }, (_, n) => claudeSessionId(sessionId, n));
    if (providerIdCache.size > 500) providerIdCache.clear();
    providerIdCache.set(sessionId, ids);
  }
  return ids;
}
/** Per hosted runtime: re-ask its subagents extension for its workers. */
const workerRequesters = new Map<string, { token: object; ask: () => void }>();

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const posInt = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined);

/** The subagents:workers-snapshot payload, read defensively (it is another extension's event). */
export function decodeWorkerEvent(data: unknown): WorkerInfo[] | null {
  const d = data as { version?: unknown; workers?: unknown } | null;
  if (!d || d.version !== 1 || !Array.isArray(d.workers)) return null;
  const out: WorkerInfo[] = [];
  for (const w of d.workers as Record<string, unknown>[]) {
    const id = str(w?.id);
    if (!id) continue;
    out.push({
      id, ...(str(w.name) ? { name: str(w.name) } : {}), ...(str(w.status) ? { status: str(w.status) } : {}),
      ...(str(w.backend) ? { backend: str(w.backend) } : {}), ...(posInt(w.pid) ? { pid: posInt(w.pid) } : {}),
      ...(str(w.sessionFile) ? { sessionFile: str(w.sessionFile) } : {}), ...(str(w.sessionId) ? { sessionId: str(w.sessionId) } : {}),
      ...(str(w.teamId) ? { teamId: str(w.teamId) } : {}), ...(posInt(w.lastActivity) ? { lastActivity: posInt(w.lastActivity) } : {}),
    });
  }
  return out;
}

/**
 * The inline extension every hosted runtime loads (server/chat-manager.ts servicesForCwd): it
 * tells the monitor which session the runtime hosts, its workers with their live pids (the
 * in-process `subagents:workers-snapshot` event; never on disk), and when its tools run.
 */
export function monitorExtension(pi: ExtensionAPI): void {
  const token = {};
  let entry: HostedEntry | null = null;
  let workers: WorkerInfo[] = [];
  let toolsRunning = 0;
  let lastToolEnd = 0;
  const ask = () => pi.events?.emit("subagents:workers-request", { version: 1 });
  const drop = () => {
    if (entry && hosted.get(entry.path)?.token === token) hosted.delete(entry.path);
    if (entry && workerRequesters.get(entry.path)?.token === token) workerRequesters.delete(entry.path);
    entry = null;
  };
  pi.events?.on("subagents:workers-snapshot", (data: unknown) => {
    const ws = decodeWorkerEvent(data);
    if (!ws) return;
    workers = ws;
    if (entry) entry.workers = ws;
  });
  pi.on("session_start", (_event, ctx) => {
    const file = ctx.sessionManager.getSessionFile();
    const path = file ? canonicalPath(file) : undefined;
    if (entry?.path !== path) drop();
    if (!path) return;
    const sessionId = ctx.sessionManager.getSessionId();
    entry = {
      token, path, sessionId, cwd: ctx.cwd, title: ctx.sessionManager.getSessionName(), workers, toolsRunning, lastToolEnd,
      providerIds: providerIdsOf(sessionId),
    };
    hosted.set(path, entry);
    workerRequesters.set(path, { token, ask });
    ask();
  });
  pi.on("session_info_changed", (_event, ctx) => {
    if (entry) entry.title = ctx.sessionManager.getSessionName();
  });
  pi.on("tool_execution_start", () => {
    toolsRunning++;
    if (entry) entry.toolsRunning = toolsRunning;
  });
  pi.on("tool_execution_end", () => {
    toolsRunning = Math.max(0, toolsRunning - 1);
    lastToolEnd = Date.now();
    if (entry) Object.assign(entry, { toolsRunning, lastToolEnd });
  });
  pi.on("session_shutdown", drop);
}

/** Ask every hosted runtime to republish its workers (a new worker's pid arrives this way). */
function requestWorkers(): void {
  for (const r of workerRequesters.values()) r.ask();
}

// ── The sampler ──────────────────────────────────────────────────────────────────────────────

export interface MonitorOptions {
  /** /proc (tests: a fixture tree). */
  procRoot?: string;
  /** cgroup v2 mount (tests: a fixture tree). */
  cgroupRoot?: string;
  /** Where the 30s log goes (<stateRoot>/monitor). */
  logDir: string;
  /** Live records dir (pi worker pid → its session file). */
  liveDir?: string;
  intervalMs?: number;
  serverPid?: number;
  clkTck?: number;
  now?: () => number;
  /** Hosted sessions (tests inject; default: what the runtimes' extension registered, plus `held`). */
  hosted?: () => HostedInfo[];
  /** Every session this server holds open, for those whose runtime has no monitor listener (a
      special loadout): enough to find their Claude Code provider by its --session-id. */
  held?: () => { path: string; sessionId: string; cwd?: string }[];
  platform?: string;
  /** Ticks between re-reads of an idle process (default IDLE_EVERY). */
  idleEvery?: number;
  /** Start the event-loop delay histogram (off in tests that drive ticks by hand). */
  eventLoop?: boolean;
  /** Sova's display title for a session (asked at most once a minute per session, off the tick). */
  titleOf?: (path: string) => Promise<string | undefined>;
}

interface ProcState {
  key: string;
  startedAt: number;
  /** From stat's comm until `learned`. */
  argv: ArgvInfo;
  env: ProcEnv;
  learned: boolean;
  /** Ticks this process has been seen in. */
  seen: number;
  /** Consecutive reads that found it spent nothing. */
  quiet: number;
  cwd?: string;
  cwdRead: boolean;
  swapBytes?: number;
  swapAt: number;
  stat: ProcStat;
  liveRecordChecked?: boolean;
  /** From its live record: the pi worker's own session file. */
  liveFile?: string;
}

const BATCH = 48;
const LOOP_RESOLUTION_MS = 200;
/** An idle process (two reads that found no CPU spent) is re-read every this many ticks. */
const IDLE_EVERY = 6;
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));
// One reused buffer and no fstat: half the cost of readFileSync for small /proc files (measured).
let buf = Buffer.allocUnsafe(16384);
const readSync = (p: string): string | null => {
  let fd: number | undefined;
  try {
    fd = openSync(p, "r");
    let n = 0;
    for (;;) {
      const got = readFd(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
      if (n === buf.length) {
        const bigger = Buffer.allocUnsafe(buf.length * 2);
        buf.copy(bigger);
        buf = bigger;
      }
    }
    return buf.toString("latin1", 0, n);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};
const readAsync = (p: string, enc: BufferEncoding = "latin1") => readFile(p, enc).catch(() => null);
const round1 = (n: number) => Math.round(n * 10) / 10;

export class ResourceMonitor {
  readonly procRoot: string;
  readonly cgroupRoot: string;
  readonly intervalMs: number;
  readonly serverPid: number;
  readonly clkTck: number;
  private readonly now: () => number;
  private readonly log: MonitorLog;
  private readonly liveDir?: string;
  private readonly hostedOf: () => HostedInfo[];
  private readonly plat: string;
  readonly ring = new MonitorRing(720);
  private rollup = new Rollup();

  scope: MonitorScope = "none";
  private cgroupDir?: string;
  private unitName?: string;
  private bootMs = 0;
  private pageSize = 4096;
  private serverEnv: ProcEnv = {};
  private serverSid = 0;
  private firstTickAt = 0;
  private prevAt = 0;
  private prevCpu = new Map<string, CpuPrev>();
  private procs = new Map<string, ProcState>();
  /** pids listed in the previous tick. */
  private listed = new Set<number>();
  private sids!: SidMemory;
  private prevUnitUsec?: number;
  private loop: IntervalHistogram | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private tickCount = 0;
  private skipped = 0;
  private tickMs: number[] = [];
  private startedAt = 0;
  private lastRotate = 0;
  private liveNames = new Map<number, string>();
  private liveNamesAt = 0;
  private treeDeepAt = 0;
  private lastPiWorkerMiss = 0;
  private snap: MonitorSnapshot | null = null;
  private readonly idleEvery: number;
  private readonly titleOf?: (path: string) => Promise<string | undefined>;
  private titles = new Map<string, { title?: string; at: number }>();
  /** The last tick's busy ms per phase, with its process and new-process counts (diagnostics). */
  lastPhases: Record<string, number> = {};

  constructor(opts: MonitorOptions) {
    this.procRoot = opts.procRoot ?? "/proc";
    this.cgroupRoot = opts.cgroupRoot ?? "/sys/fs/cgroup";
    this.intervalMs = opts.intervalMs ?? 5000;
    this.serverPid = opts.serverPid ?? process.pid;
    this.clkTck = opts.clkTck ?? 100;
    this.now = opts.now ?? Date.now;
    this.log = new MonitorLog(opts.logDir);
    this.liveDir = opts.liveDir;
    this.plat = opts.platform ?? platform();
    this.titleOf = opts.titleOf;
    this.idleEvery = Math.max(1, Math.round(opts.idleEvery ?? IDLE_EVERY));
    const held = opts.held;
    this.hostedOf = opts.hosted ?? (() => {
      const out: HostedInfo[] = [...hosted.values()].map((h) => ({
        path: h.path, sessionId: h.sessionId, ...(h.cwd ? { cwd: h.cwd } : {}), ...(h.title ? { title: h.title } : {}),
        workers: h.workers, providerIds: h.providerIds,
        toolInWindow: h.toolsRunning > 0 || h.lastToolEnd >= this.prevAt,
      }));
      for (const c of held?.() ?? []) {
        if (hosted.has(c.path)) continue;
        out.push({ path: c.path, sessionId: c.sessionId, ...(c.cwd ? { cwd: c.cwd } : {}), workers: [], providerIds: providerIdsOf(c.sessionId), toolInWindow: false });
      }
      return out;
    });
    if (opts.eventLoop !== false) {
      // 200ms: 5 wakeups a second (20ms cost ~0.12% of a core alone). A stall still shows in
      // `max`, which is exact; each sample includes the resolution, subtracted when reported.
      this.loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
      this.loop.enable();
    }
    this.init();
  }

  /** Learn the scope, boot time and page size once. */
  private init(): void {
    const self = readSync(join(this.procRoot, String(this.serverPid), "stat"));
    if (this.plat !== "linux" || !self) {
      this.scope = "none";
      this.sids = new SidMemory();
      return;
    }
    const st = parseStat(self);
    this.serverSid = st?.sid ?? 0;
    this.sids = new SidMemory(new Set([this.serverSid, this.serverPid]));
    this.bootMs = (parseBootTime(readSync(join(this.procRoot, "stat")) ?? "") ?? 0) * 1000;
    const cg = parseSelfCgroup(readSync(join(this.procRoot, String(this.serverPid), "cgroup")) ?? "");
    const dir = cg ? join(this.cgroupRoot, cg.path) : undefined;
    // Only the unit's own main process may speak for the unit: a dev server started from a shell
    // inside the unit (an agent's tool) inherits its cgroup, and must not claim its processes.
    // systemd puts SYSTEMD_EXEC_PID=<main pid> in the unit's exec environment and children inherit
    // it, so only the main process finds its own pid there; a backgrounded server reparented to the
    // manager passes the parent check below but not this one.
    const selfEnv = readSync(join(this.procRoot, String(this.serverPid), "environ")) ?? "";
    const isMain = selfEnv.split("\0").includes(`SYSTEMD_EXEC_PID=${this.serverPid}`);
    const parentComm = st ? readSync(join(this.procRoot, String(st.ppid), "comm"))?.trim() : undefined;
    if (cg?.unit && dir && isMain && parentComm === "systemd" && readSync(join(dir, "cgroup.procs")) !== null) {
      this.scope = "unit";
      this.cgroupDir = dir;
      this.unitName = cg.unit;
    } else this.scope = "tree";
    // Page size: VmRSS (kB) against stat's rss (pages), rounded to a power of two.
    const rssBytes = parseStatusRss(readSync(join(this.procRoot, String(this.serverPid), "status")) ?? "");
    if (st && st.rss > 0 && rssBytes > 0) this.pageSize = 2 ** Math.round(Math.log2(rssBytes / st.rss));
    const env = readSync(join(this.procRoot, String(this.serverPid), "environ"));
    this.serverEnv = env ? parseEnviron(env) : {};
  }

  start(): void {
    if (this.timer) return;
    this.startedAt = this.now();
    void this.log.rotate(this.now()).catch(() => {});
    this.lastRotate = this.now();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  /** Stop sampling; the 30s window in progress goes to disk now, so a restart loses none of it. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.loop?.disable();
    const line = this.rollup.flush();
    if (line) {
      try {
        this.log.appendSync(line);
      } catch (err) {
        console.warn(`[monitor] final log append failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Sova's title for each session row: cached, refreshed at most once a minute, never awaited. */
  private refreshTitles(paths: string[], at: number): void {
    if (!this.titleOf) return;
    let asked = 0;
    for (const path of paths) {
      const t = this.titles.get(path);
      if ((t && at - t.at < 60_000) || asked >= 5) continue;
      asked++;
      this.titles.set(path, { ...(t?.title ? { title: t.title } : {}), at });
      this.titleOf(path).then((title) => this.titles.set(path, { ...(title ? { title } : {}), at }), () => {});
    }
    if (this.titles.size > 500) for (const [k, v] of this.titles) if (at - v.at > 3_600_000) this.titles.delete(k);
  }

  snapshot(): MonitorSnapshot | null {
    return this.snap;
  }

  async history(since: number, res: MonitorResolution): Promise<MonitorHistory> {
    return res === "30s" ? this.log.history(since, this.now()) : this.ring.history(since);
  }

  // ── reading ────────────────────────────────────────────────────────────────────────────────

  private pidDir(pid: number) {
    return this.procRoot + "/" + pid;
  }

  /** The processes to measure this tick: the unit's cgroup, else the server's tree. */
  private async listPids(): Promise<number[]> {
    if (this.scope === "unit") {
      const text = readSync(join(this.cgroupDir!, "cgroup.procs"));
      if (text !== null) return text.split("\n").filter(Boolean).map(Number).filter((n) => n > 0);
    }
    // Tree: each process's main-thread children every tick; every 30s every thread's (a JVM or
    // a browser forks from other threads), so a missed child is found within 30s.
    const deep = this.now() - this.treeDeepAt >= 30_000;
    if (deep) this.treeDeepAt = this.now();
    const out: number[] = [this.serverPid];
    const seen = new Set(out);
    for (let i = 0; i < out.length; i++) {
      const pid = out[i]!;
      const tids = deep ? this.threads(pid) : [pid];
      for (const tid of tids) {
        const text = readSync(this.pidDir(pid) + "/task/" + tid + "/children");
        if (!text) continue;
        for (const c of text.trim().split(/\s+/)) {
          const n = Number(c);
          if (n > 0 && !seen.has(n)) {
            seen.add(n);
            out.push(n);
          }
        }
      }
      if (i % BATCH === BATCH - 1) await yieldLoop();
    }
    // Keep known descendants whose parent forked them off-thread since the last deep walk.
    if (!deep) for (const p of this.procs.values()) if (!seen.has(p.stat.pid) && seen.has(p.stat.ppid)) out.push(p.stat.pid);
    return out;
  }

  private threads(pid: number): number[] {
    try {
      return readdirSync(join(this.pidDir(pid), "task")).map(Number).filter((n) => n > 0);
    } catch {
      return [pid];
    }
  }

  /** argv and environ, once per process, async. */
  private async learn(p: ProcState): Promise<void> {
    p.learned = true;
    const dir = this.pidDir(p.stat.pid);
    const [cmd, env] = await Promise.all([readAsync(dir + "/cmdline"), readAsync(dir + "/environ", "utf8")]);
    p.argv = classifyArgv(cmd ? parseCmdline(cmd) : [], p.stat.comm);
    p.env = env ? parseEnviron(env) : {};
  }

  // ── the tick ───────────────────────────────────────────────────────────────────────────────

  async tick(): Promise<void> {
    if (this.running) {
      this.skipped++;
      return;
    }
    this.running = true;
    let busy = 0;
    let mark = tickClock();
    const phases: Record<string, number> = {};
    let phaseAt = 0;
    const phase = (name: string) => {
      const t = busy + tickClock() - mark;
      phases[name] = round1000(t - phaseAt);
      phaseAt = t;
    };
    const pause = async (p: Promise<unknown>) => {
      busy += tickClock() - mark;
      await p;
      mark = tickClock();
    };
    try {
      const at = this.now();
      if (!this.firstTickAt) this.firstTickAt = at;
      const elapsedSec = this.prevAt ? Math.max(0.001, (at - this.prevAt) / 1000) : this.intervalMs / 1000;
      const pct = (ticks: number) => (ticks / this.clkTck / elapsedSec) * 100;

      // 1. Who to measure, and their stat lines. A pid first listed this tick waits one tick:
      // if it exits before then, its CPU reaches its parent's cutime and is charged there; if it
      // lives, its first read counts its whole life. Only its name in the top lists is lost, for
      // processes that lived under one tick, and each such process costs nothing.
      const stats = new Map<number, ProcStat>();
      const stale = new Set<string>();
      let deferred = 0;
      if (this.scope !== "none") {
        let pids: number[] = [];
        await pause(this.listPids().then((p) => { pids = p; }));
        const before = this.listed;
        this.listed = new Set(pids);
        const lastByPid = new Map<number, ProcState>();
        for (const p of this.procs.values()) lastByPid.set(p.stat.pid, p);
        for (let i = 0; i < pids.length; i++) {
          const pid = pids[i]!;
          if (this.prevAt > 0 && !before.has(pid) && pid !== this.serverPid) {
            deferred++;
            continue;
          }
          // Idle for two reads or more: re-read every `idleEvery`-th tick (staggered by pid).
          const last = lastByPid.get(pid);
          if (last && last.quiet >= 2 && (this.tickCount + pid) % this.idleEvery !== 0) {
            stale.add(last.key);
            stats.set(pid, last.stat);
            continue;
          }
          const text = readSync(this.pidDir(pid) + "/stat");
          const st = text ? parseStat(text) : null;
          if (st) stats.set(st.pid, st);
          if (i % BATCH === BATCH - 1) await pause(yieldLoop());
        }
      }

      phase("stat");
      // 2. Keep what is known per process; gone ones are forgotten.
      const live = new Map<string, ProcState>();
      let fresh = 0;
      for (const st of stats.values()) {
        const key = cpuKey(st);
        const known = this.procs.get(key);
        if (known) {
          known.stat = st;
          known.seen++;
          live.set(key, known);
        } else {
          fresh++;
          live.set(key, {
            key, startedAt: this.bootMs + (st.starttime * 1000) / this.clkTck, argv: classifyArgv([], st.comm), env: {},
            learned: false, seen: 1, quiet: 0, cwdRead: false, swapAt: 0, stat: st,
          });
        }
      }
      this.procs = live;

      // 3. CPU: per-process deltas, reaped children counted once.
      const fold = foldCpu(this.prevCpu, [...live.values()].map((p) => ({
        key: p.key, stat: p.stat, fresh: !this.prevCpu.has(p.key) && this.prevAt > 0 && p.startedAt >= this.firstTickAt,
        ...(stale.has(p.key) ? { stale: true } : {}),
      })));
      this.prevCpu = fold.next;
      for (const p of live.values())
        if (!stale.has(p.key) && p.seen > 1) p.quiet = (fold.own.get(p.key) ?? 0) + (fold.kids.get(p.key) ?? 0) === 0 ? p.quiet + 1 : 0;
      phase("fold");

      // 4. argv and env, once per process, async. Most new processes are short-lived children of
      // a process already charged (git, grep, a test step): they are charged through their
      // ancestors and never read. Read now: the server's direct children (workers, hosted tools),
      // processes whose parent is not measured (escaped), and this tick's top CPU users; every
      // other process on its second sighting.
      const byPidState = new Map<number, ProcState>();
      for (const p of live.values()) byPidState.set(p.stat.pid, p);
      const cpuOf = (p: ProcState) => (fold.own.get(p.key) ?? 0) + (fold.kids.get(p.key) ?? 0);
      const unlearned = [...live.values()].filter((p) => !p.learned && p.stat.pid !== this.serverPid);
      const topCpu = new Set(unlearned.filter((p) => cpuOf(p) > 0).sort((a, b) => cpuOf(b) - cpuOf(a)).slice(0, 10));
      const toLearn = unlearned.filter((p) => p.seen > 1 || p.stat.ppid === this.serverPid || !byPidState.has(p.stat.ppid) || topCpu.has(p));
      if (toLearn.length) await pause(Promise.all(toLearn.map((p) => this.learn(p))));
      phase("learn");

      // 5. VmSwap, only while the host has swap in use: each process on its second sighting, then
      // at most every 30s (staggered by pid).
      const host = this.hostNumbers();
      const swapInUse = host.swapTotalBytes - host.swapFreeBytes > 0;
      let n = 0;
      for (const p of live.values()) {
        if (!swapInUse) {
          p.swapBytes = 0;
          continue;
        }
        const due = p.seen > 1 && (p.swapAt === 0 || at - p.swapAt >= 30_000 + (p.stat.pid % 6) * 1000);
        if (!due) continue;
        const text = readSync(this.pidDir(p.stat.pid) + "/status");
        p.swapBytes = text ? parseStatusSwap(text) : 0;
        p.swapAt = at;
        if (++n % BATCH === 0) await pause(yieldLoop());
      }
      phase("swap");
      // 5. Attribution.
      const hostedNow = this.hostedOf();
      const byPid = new Map<number, AttribProc>();
      for (const p of live.values()) byPid.set(p.stat.pid, { stat: p.stat, argv: p.argv, env: p.env, ...(p.cwd ? { cwd: p.cwd } : {}) });
      const liveRecordPids = this.liveRecordPids(live, hostedNow, at);
      const { owners, inTree } = attribute({
        procs: byPid, serverPid: this.serverPid, hosted: hostedNow, liveRecordPids, sids: this.sids,
        serverEnv: this.serverEnv,
      });
      this.sids.learn(byPid, owners, at);
      // Unowned worker-looking children: a pid the runtime has not published yet; ask again
      // (at most every 30s), so the next tick has it.
      const miss = [...owners.values()].some((o) => o.session === undefined && o.worker?.startsWith("unowned:"));
      if (miss && at - this.lastPiWorkerMiss >= 30_000) {
        this.lastPiWorkerMiss = at;
        requestWorkers();
      }
      // cwd, once per process that outlived a tick and nothing exact matched: next tick's heuristic.
      const cwdReads: Promise<void>[] = [];
      for (const p of live.values()) {
        if (p.cwdRead || p.seen < 2 || p.stat.pid === this.serverPid || owners.has(p.stat.pid)) continue;
        p.cwdRead = true;
        cwdReads.push(readlink(this.pidDir(p.stat.pid) + "/cwd").then((c) => { p.cwd = c; }, () => {}));
      }
      if (cwdReads.length) await pause(Promise.all(cwdReads));

      phase("attribute");
      // 6. Unit and server numbers.
      const unit = this.unitNumbers(elapsedSec);
      const mem = process.memoryUsage();
      const lag = (ns: number) => (Number.isFinite(ns) ? Math.max(0, ns / 1e6 - LOOP_RESOLUTION_MS) : 0);
      const loopMs = this.loop
        ? { p50: lag(this.loop.percentile(50)), p99: lag(this.loop.percentile(99)), max: lag(this.loop.max) }
        : { p50: 0, p99: 0, max: 0 };
      this.loop?.reset();

      phase("counters");
      // 7. Assemble.
      const snap = this.assemble({ at, live, fold, owners, inTree, hostedNow, pct, host, unit, mem, loopMs });
      phase("assemble");
      this.lastPhases = { ...phases, deferred, stale: stale.size, fresh, learned: toLearn.length, procs: live.size };
      this.prevAt = at;
      this.tickCount++;
      busy += tickClock() - mark;
      mark = tickClock();
      this.tickMs.push(busy);
      if (this.tickMs.length > 720) this.tickMs.shift();
      snap.sampler = {
        intervalMs: this.intervalMs, lastTickMs: round1000(busy), avgTickMs: round1000(this.tickMs.reduce((s, v) => s + v, 0) / this.tickMs.length),
        skipped: this.skipped, ticks: this.tickCount, startedAt: this.startedAt,
      };
      this.snap = snap;

      // 8. Every 30s, one line to disk; once a day, rotation.
      if (this.rollup.size >= Math.max(1, Math.round(30_000 / this.intervalMs))) {
        const line = this.rollup.flush();
        if (line) void this.log.append(line).catch((err) => console.warn(`[monitor] log append failed: ${err instanceof Error ? err.message : String(err)}`));
        if (at - this.lastRotate >= 86_400_000) {
          this.lastRotate = at;
          void this.log.rotate(at).catch(() => {});
        }
      }
    } catch (err) {
      console.warn(`[monitor] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }

  /** pi worker pid → its session file, from the live records' names (`p<pid>-*.json`), read
      only for pi processes nothing else matched, once per process. */
  private liveRecordPids(live: ReadonlyMap<string, ProcState>, hostedNow: readonly HostedInfo[], at: number): Map<number, string> {
    const out = new Map<number, string>();
    if (!this.liveDir) return out;
    const known = new Set(hostedNow.flatMap((h) => h.workers.map((w) => w.pid)).filter(Boolean));
    const wanted = [...live.values()].filter((p) => p.argv.kind === "pi-worker" && !known.has(p.stat.pid));
    if (!wanted.length) return out;
    if (at - this.liveNamesAt >= 30_000) {
      this.liveNamesAt = at;
      this.liveNames.clear();
      try {
        for (const name of readdirSync(this.liveDir)) {
          const m = /^p(\d+)-.*\.json$/.exec(name);
          if (m) this.liveNames.set(Number(m[1]), name);
        }
      } catch { /* no live dir */ }
    }
    for (const p of wanted) {
      const cached = p.liveFile;
      if (cached) {
        out.set(p.stat.pid, cached);
        continue;
      }
      if (p.liveRecordChecked) continue;
      const name = this.liveNames.get(p.stat.pid);
      if (!name) continue;
      p.liveRecordChecked = true;
      try {
        const rec = JSON.parse(readFileSync(join(this.liveDir, name), "utf8")) as { session?: { sessionFile?: unknown; pid?: unknown } };
        if (rec.session?.pid === p.stat.pid && typeof rec.session.sessionFile === "string") {
          const file = canonicalPath(rec.session.sessionFile);
          p.liveFile = file;
          out.set(p.stat.pid, file);
        }
      } catch { /* mid-write or malformed */ }
    }
    return out;
  }

  private hostNumbers(): MonitorSnapshot["host"] {
    const proc = this.scope !== "none";
    const mi = proc ? parseMeminfo(readSync(join(this.procRoot, "meminfo")) ?? "") : new Map<string, number>();
    const la = proc ? readSync(join(this.procRoot, "loadavg")) : null;
    const pressure = proc
      ? pressureOf(readSync(join(this.procRoot, "pressure", "cpu")), readSync(join(this.procRoot, "pressure", "memory")), readSync(join(this.procRoot, "pressure", "io")))
      : undefined;
    return {
      loadavg: la ? parseLoadavg(la) : (loadavg() as [number, number, number]),
      memTotalBytes: mi.get("MemTotal") ?? totalmem(),
      memAvailableBytes: mi.get("MemAvailable") ?? freemem(),
      swapTotalBytes: mi.get("SwapTotal") ?? 0,
      swapFreeBytes: mi.get("SwapFree") ?? 0,
      ...(pressure ? { pressure } : {}),
    };
  }

  private unitNumbers(elapsedSec: number): MonitorSnapshot["unit"] | undefined {
    if (this.scope !== "unit") return undefined;
    const f = (name: string) => readSync(join(this.cgroupDir!, name));
    const num = (name: string) => {
      const t = f(name);
      const v = t === null ? NaN : Number(t.trim());
      return Number.isFinite(v) ? v : undefined;
    };
    const cpu = parseKeyValues(f("cpu.stat") ?? "");
    const usec = cpu.get("usage_usec");
    const cpuPct = usec !== undefined && this.prevUnitUsec !== undefined ? Math.max(0, ((usec - this.prevUnitUsec) / 1e6 / elapsedSec) * 100) : 0;
    this.prevUnitUsec = usec;
    const ms = parseKeyValues(f("memory.stat") ?? "");
    const ev = parseKeyValues(f("memory.events") ?? "");
    const peak = num("memory.peak");
    const swapPeak = num("memory.swap.peak");
    const pressure = pressureOf(f("cpu.pressure"), f("memory.pressure"), f("io.pressure"));
    return {
      cpuPct: round1(cpuPct),
      memory: { current: num("memory.current") ?? 0, anon: ms.get("anon") ?? 0, file: ms.get("file") ?? 0, shmem: ms.get("shmem") ?? 0,
        ...(peak !== undefined ? { peak } : {}) },
      swap: { current: num("memory.swap.current") ?? 0, ...(swapPeak !== undefined ? { peak: swapPeak } : {}) },
      oomKills: ev.get("oom_kill") ?? 0,
      ...(pressure ? { pressure } : {}),
    };
  }

  private assemble(t: {
    at: number;
    live: Map<string, ProcState>;
    fold: ReturnType<typeof foldCpu>;
    owners: Map<number, Owner>;
    inTree: Set<number>;
    hostedNow: HostedInfo[];
    pct: (ticks: number) => number;
    host: MonitorSnapshot["host"];
    unit: MonitorSnapshot["unit"] | undefined;
    mem: NodeJS.MemoryUsage;
    loopMs: { p50: number; p99: number; max: number };
  }): MonitorSnapshot {
    const { at, live, fold, owners, inTree, hostedNow, pct } = t;
    const hostedBy = new Map(hostedNow.map((h) => [h.path, h]));
    const procs: MonitorProc[] = [];
    let server: ProcState | undefined;
    let serverKidsPct = 0;
    for (const p of live.values()) {
      const cpu = (fold.own.get(p.key) ?? 0) + (fold.kids.get(p.key) ?? 0);
      if (p.stat.pid === this.serverPid) {
        server = p;
        serverKidsPct = pct(fold.kids.get(p.key) ?? 0);
        continue;
      }
      const o = owners.get(p.stat.pid);
      const kind: MonitorProcKind = p.argv.kind === "claude-worker" && o?.session && !o.worker ? "claude-provider" : p.argv.kind;
      procs.push({
        pid: p.stat.pid, ppid: p.stat.ppid, kind, cmd: p.argv.cmd, cpuPct: round1(pct(cpu)), rssBytes: p.stat.rss * this.pageSize,
        ...(p.swapBytes !== undefined ? { swapBytes: p.swapBytes } : {}), startedAt: Math.round(p.startedAt),
        ...(o?.session ? { sessionPath: o.session } : {}), ...(o?.worker ? { workerId: o.worker } : {}), ...(o ? { via: o.via } : {}),
        ...(!o && p.cwd ? { cwd: p.cwd } : {}),
      });
    }
    const heavy = (a: MonitorProc, b: MonitorProc) => b.cpuPct - a.cpuPct || b.rssBytes - a.rssBytes;
    procs.sort(heavy);
    const sum = (ps: MonitorProc[]) => ({
      cpuPct: round1(ps.reduce((s, p) => s + p.cpuPct, 0)), rssBytes: ps.reduce((s, p) => s + p.rssBytes, 0),
      swapBytes: ps.reduce((s, p) => s + (p.swapBytes ?? 0), 0), procCount: ps.length,
    });

    // Sessions and workers. A worker's own process is its row; everything else charged to it is
    // its subtree (`top`).
    type Acc = { own: MonitorProc[]; workers: Map<string, MonitorProc[]> };
    const sessions = new Map<string, Acc>();
    const accOf = (path: string): Acc => {
      let s = sessions.get(path);
      if (!s) sessions.set(path, (s = { own: [], workers: new Map() }));
      return s;
    };
    const unowned = new Map<string, MonitorProc[]>();
    const escaped: MonitorProc[] = [];
    const unattributed: MonitorProc[] = [];
    for (const p of procs) {
      const isEscaped = this.scope === "unit" && !inTree.has(p.pid);
      if (isEscaped) escaped.push(p);
      if (p.sessionPath) {
        const s = accOf(p.sessionPath);
        if (p.workerId) s.workers.set(p.workerId, [...(s.workers.get(p.workerId) ?? []), p]);
        else s.own.push(p);
      } else if (p.workerId) unowned.set(p.workerId, [...(unowned.get(p.workerId) ?? []), p]);
      else if (!isEscaped) unattributed.push(p);
    }
    // Server children that exited between ticks (only the server's cutime saw them): the one
    // hosted session running a tool then, else unattributed. A heuristic, and labelled one.
    const exitedPct = round1(serverKidsPct);
    const toolSessions = hostedNow.filter((h) => h.toolInWindow);
    if (exitedPct > 0) {
      const synthetic: MonitorProc = { pid: 0, ppid: this.serverPid, kind: "other", cmd: "(exited tool children)", cpuPct: exitedPct, rssBytes: 0, startedAt: at };
      if (toolSessions.length === 1) {
        const path = toolSessions[0]!.path;
        accOf(path).own.push({ ...synthetic, sessionPath: path, via: "exited-tools" });
      } else unattributed.push({ ...synthetic, cmd: "(exited server children)" });
    }

    const workerRow = (id: string, ps: MonitorProc[], info: WorkerInfo | undefined): MonitorWorker => {
      const self = ps.find((p) => (info?.pid ? p.pid === info.pid : p.via !== "descendant" && p.via !== "sid")) ?? ps.find((p) => p.ppid === this.serverPid);
      const s = sum(ps);
      return {
        id, ...(info?.name ? { name: info.name } : {}), ...(info?.backend ? { backend: info.backend } : {}),
        ...(info?.status ? { status: info.status } : {}),
        ...(info?.status && info.status !== "running" && info.status !== "starting" && info.lastActivity ? { idleSince: info.lastActivity } : {}),
        ...(self ? { pid: self.pid } : {}), via: self?.via ?? ps[0]?.via ?? "descendant",
        ...s, top: ps.filter((p) => p !== self).slice(0, 5),
      };
    };
    const sessionRows: MonitorSession[] = [];
    for (const [path, s] of sessions) {
      const h = hostedBy.get(path);
      const workers = [...s.workers].map(([id, ps]) => workerRow(id, ps, h?.workers.find((w) => w.id === id)))
        .sort((a, b) => b.cpuPct - a.cpuPct || b.rssBytes - a.rssBytes);
      const all = [...s.own, ...[...s.workers.values()].flat()];
      const own = sum(s.own);
      sessionRows.push({
        sessionPath: path, ...((h?.title ?? this.titles.get(path)?.title) ? { title: h?.title ?? this.titles.get(path)!.title! } : {}), ...(h?.cwd ? { cwd: h.cwd } : {}), hosted: !!h,
        ...sum(all), own: s.own.slice(0, 5), ownCpuPct: own.cpuPct, ownRssBytes: own.rssBytes, workers,
      });
    }
    sessionRows.sort((a, b) => b.cpuPct - a.cpuPct || b.rssBytes - a.rssBytes);
    this.refreshTitles(sessionRows.map((r) => r.sessionPath!), at);
    const unownedWorkers = [...unowned].map(([id, ps]) => workerRow(id, ps, undefined));

    const bucket = (ps: MonitorProc[]): MonitorBucket => ({ ...sum(ps), procs: ps.slice(0, 20) });
    // Escaped: the totals are the uncharged ones (a charged one is counted in its session), the
    // list shows all of them, charged ones with their session.
    const escapedUncharged = escaped.filter((p) => !p.sessionPath && !p.workerId);
    const serverRss = server ? server.stat.rss * this.pageSize : t.mem.rss;
    const serverCpu = server ? round1(pct(fold.own.get(server.key) ?? 0)) : 0;
    const everything = sum(procs);
    const totals = {
      cpuPct: round1(everything.cpuPct + serverCpu + exitedPct), rssBytes: everything.rssBytes + serverRss,
      swapBytes: everything.swapBytes + (server?.swapBytes ?? 0), procCount: procs.length + (server ? 1 : 0),
    };

    const notes: string[] = [];
    if (this.scope === "none") notes.push("Process details need Linux (/proc); only this server's own numbers are shown.");
    if (this.scope === "tree") notes.push("Not running in a dedicated systemd unit: the numbers cover this server's process tree only.");
    notes.push("Memory is RSS per process; pages shared between processes are counted in each.");

    // History: the groups partition the total (escaped only when charged to nobody).
    const groups = new Map<string, [number, number]>();
    const labels: TickPoint["labels"] = new Map();
    const addG = (k: string, cpu: number, rss: number) => {
      const g = groups.get(k) ?? [0, 0];
      g[0] = round1(g[0] + cpu);
      g[1] += rss;
      groups.set(k, g);
    };
    addG("server", serverCpu, serverRss);
    labels.set("server", { label: "Sova server" });
    const workersH = new Map<string, Map<string, [number, number]>>();
    const workerLabels: TickPoint["workerLabels"] = new Map();
    for (const s of sessionRows) {
      addG(s.sessionPath!, s.cpuPct, s.rssBytes);
      labels.set(s.sessionPath!, { label: s.title ?? s.sessionPath!.split("/").pop()!, sessionPath: s.sessionPath! });
      if (s.workers.length) {
        workersH.set(s.sessionPath!, new Map(s.workers.map((w) => [w.id, [w.cpuPct, w.rssBytes] as [number, number]])));
        const names = new Map(s.workers.filter((w) => w.name).map((w) => [w.id, w.name!]));
        if (names.size) workerLabels.set(s.sessionPath!, names);
      }
    }
    if (escapedUncharged.length) {
      const e = sum(escapedUncharged);
      addG("escaped", e.cpuPct, e.rssBytes);
      labels.set("escaped", { label: "Escaped" });
    }
    const una = [...unattributed, ...[...unowned.values()].flat()];
    if (una.length) {
      addG("unattributed", sum(una).cpuPct, sum(una).rssBytes);
      labels.set("unattributed", { label: "Unattributed" });
    }
    const groupOf = (p: MonitorProc) => (p.sessionPath ?? (p.workerId ? "unattributed" : p.pid === 0 ? undefined : escaped.includes(p) ? "escaped" : "unattributed"));
    const top: MonitorPointProc[] = procs.slice(0, 5).map((p) => ({
      pid: p.pid, cmd: p.cmd, kind: p.kind, cpuPct: p.cpuPct, rssBytes: p.rssBytes,
      ...(groupOf(p) ? { group: groupOf(p)! } : {}), ...(p.workerId && p.sessionPath ? { workerId: p.workerId } : {}),
    }));
    const point: TickPoint = {
      at, cpuPct: totals.cpuPct, rssBytes: totals.rssBytes, swapBytes: totals.swapBytes,
      ...(t.unit ? { anonBytes: t.unit.memory.anon } : {}), load1: t.host.loadavg[0], loopMaxMs: t.loopMs.max,
      groups, workers: workersH, top, labels, workerLabels,
    };
    this.ring.push(point);
    this.rollup.add(point);

    return {
      at, platform: this.plat, scope: this.scope, ...(this.unitName ? { unitName: this.unitName } : {}),
      cores: CORES, host: t.host, ...(t.unit ? { unit: t.unit } : {}),
      server: {
        pid: this.serverPid, cpuPct: serverCpu, rssBytes: serverRss, heapUsedBytes: t.mem.heapUsed, heapTotalBytes: t.mem.heapTotal,
        eventLoop: { p50: round1000(t.loopMs.p50), p99: round1000(t.loopMs.p99), max: round1000(t.loopMs.max) },
        uptimeSec: Math.round(process.uptime()),
      },
      totals, sessions: sessionRows, unownedWorkers, escaped: { ...sum(escapedUncharged), procs: escaped.slice(0, 20) }, unattributed: bucket(unattributed),
      topProcs: procs.slice(0, 10), sampler: { intervalMs: this.intervalMs, lastTickMs: 0, avgTickMs: 0, skipped: 0, ticks: 0, startedAt: 0 },
      notes,
    };
  }
}

const round1000 = (n: number) => Math.round(n * 1000) / 1000;
/** The tick's own cost, in ms: this thread's CPU time (Node ≥ 23.9), so a loaded machine's
    preemption is not billed to the sampler; wall time on older Node. Waits are excluded either way. */
const threadCpu = (process as { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage;
const tickClock: () => number = threadCpu
  ? () => {
      const u = threadCpu.call(process);
      return (u.user + u.system) / 1000;
    }
  : () => performance.now();
/** os.cpus() reads every core's /proc entries (~1ms); the count is read once. */
const CORES = availableParallelism();

// ── The server's instance ────────────────────────────────────────────────────────────────────

let instance: ResourceMonitor | null = null;

export function startResourceMonitor(opts: MonitorOptions): ResourceMonitor {
  instance ??= new ResourceMonitor(opts);
  instance.start();
  return instance;
}

export const resourceMonitor = () => instance;

export function stopResourceMonitor(): void {
  instance?.stop();
}
