import { execFile, execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostProcTable, procfsTable, unitMembers, type ProcTable } from "./proctable";
import { logsDir, procsDir } from "./store";

/**
 * Who runs a service's processes (§app.project-services/supervisor). Exactly one driver owns each
 * process: systemd transient user units, or a detached session of its own per unit (adapters.ts
 * picks one). Everything by argv, never a shell. Nothing here touches a unit or process it was not
 * asked about by name.
 */

export interface UnitSpec {
  unit: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export type UnitState = "active" | "activating" | "inactive" | "failed" | "missing";
export interface UnitStatus {
  state: UnitState;
  pid: number | null;
  /** The main process's exit status, when it ended. */
  exit?: number | null;
  detail?: string;
}

export interface RunOnceResult {
  code: number | null;
  timedOut: boolean;
  ms: number;
  /** Processes it left behind (killed with it). */
  leftover?: number;
  /** Its memory peak in bytes (systemd's summary, or the detached driver's sampled resident memory); null when unknown. */
  peakBytes?: number | null;
  /** It was stopped because the caller aborted. */
  aborted?: boolean;
}

/** A waited-for run: killed whole at `timeoutSec`, or when `signal` aborts. */
export type OnceSpec = UnitSpec & { timeoutSec: number; signal?: AbortSignal };

/** The supervisor adapters (adapters.ts): `launchd` is a reserved slot with no driver yet. */
export type DriverId = "systemd" | "detached" | "launchd";

export interface Driver {
  readonly id: DriverId | "none";
  available(): Promise<{ ok: boolean; detail: string }>;
  start(spec: UnitSpec): Promise<void>;
  stop(unit: string): Promise<void>;
  status(unit: string): Promise<UnitStatus>;
  signal(unit: string, sig: string): Promise<void>;
  /** Whether `pid` runs inside `unit`. */
  owns(unit: string, pid: number): boolean;
  /** Every live pid inside `unit`. */
  pids(unit: string): number[];
  /** The unit's last `lines` lines; with `sinceMs`, only those of runs since then (a waited-for run's output starts fresh with the detached driver). */
  logs(unit: string, lines: number, sinceMs?: number): Promise<{ t: string; text: string }[]>;
  /** Run to completion (a hook, setup, build step or test run), killed whole at `timeoutSec` or when `signal` aborts. */
  runOnce(spec: OnceSpec): Promise<RunOnceResult>;
  /** The units (running, or recorded) whose name starts with `prefix`. */
  units(prefix: string): Promise<string[]>;
  /** At a server start, after reconcile: take charge of the units already running (the detached driver's restart watch). */
  adopt?(): Promise<void>;
}

export class DriverError extends Error {}

// ---- helpers --------------------------------------------------------------------------------------

export interface Exec {
  (file: string, args: string[], opts?: { timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
}

export const realExec: Exec = (file, args, opts = {}) =>
  new Promise((done) => {
    execFile(file, args, { timeout: opts.timeoutMs ?? 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 127) : 0;
      done({ code, stdout: String(stdout), stderr: String(stderr || (err && !stdout && !stderr ? err.message : "")) });
    });
  });

// ---- systemd ------------------------------------------------------------------------------------

export const SLICE = "sova-services.slice";

/** The `systemd-run` argv that starts `spec` as a transient user service (pure, for tests). A waited-for run is
    not `--quiet`: its summary on exit carries the memory peak. */
export function systemdRunArgv(spec: UnitSpec, once?: { timeoutSec: number }): string[] {
  const a = ["--user", `--unit=${spec.unit}`, `--slice=${SLICE}`, "--collect", ...(once ? [] : ["--quiet"]), `--working-directory=${spec.cwd}`, "--property=StandardInput=null"];
  if (once) a.push("--wait", "--property=KillMode=control-group", `--property=RuntimeMaxSec=${once.timeoutSec}`);
  else a.push("--property=KillMode=mixed", "--property=TimeoutStopSec=15", "--property=Restart=on-failure", "--property=RestartSec=2");
  for (const k of Object.keys(spec.env).sort()) a.push(`--setenv=${k}=${spec.env[k]}`);
  a.push("--", ...spec.argv);
  return a;
}

/** `systemctl show`'s `Key=Value` lines → the unit's status (pure, for tests). */
export function parseShow(text: string): UnitStatus {
  const kv: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
  }
  if (kv.LoadState === "not-found" || (!kv.ActiveState && !kv.LoadState)) return { state: "missing", pid: null };
  const pid = Number(kv.MainPID) > 0 ? Number(kv.MainPID) : null;
  const exit = kv.ExecMainStatus !== undefined && kv.ExecMainStatus !== "" ? Number(kv.ExecMainStatus) : null;
  const active = kv.ActiveState;
  const state: UnitState = active === "active" ? "active" : active === "activating" || active === "reloading" ? "activating" : active === "failed" ? "failed" : "inactive";
  return { state, pid, exit, ...(kv.SubState ? { detail: `${active}/${kv.SubState}${kv.Result && kv.Result !== "success" ? ` (${kv.Result})` : ""}` } : {}) };
}

/** `systemd-run --wait`'s "Memory peak: 1.2G" in bytes (base 1024), or null (pure, for tests). */
export function parseMemoryPeak(text: string): number | null {
  const m = /Memory peak:\s*([\d.]+)\s*([BKMGTP]?)/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1024 ** "BKMGTP".indexOf(m[2] || "B"));
}

/** The resident memory of `pids` now, in bytes: /proc on Linux, else `ps`; null when none could be read. */
export function rssOf(pids: number[]): number | null {
  if (!pids.length) return null;
  let total = 0;
  let read = false;
  if (process.platform === "linux") {
    for (const pid of pids) {
      try {
        const m = /VmRSS:\s*(\d+)\s*kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
        if (m) {
          total += Number(m[1]) * 1024;
          read = true;
        }
      } catch {
        // gone
      }
    }
    return read ? total : null;
  }
  try {
    const out = execFileSync("ps", ["-o", "rss=", "-p", pids.join(",")], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.split("\n"))
      if (line.trim()) {
        total += Number(line.trim()) * 1024;
        read = true;
      }
  } catch {
    // ps failed
  }
  return read ? total : null;
}

export class SystemdDriver implements Driver {
  readonly id = "systemd" as const;
  constructor(private readonly exec: Exec = realExec) {}
  async available() {
    const r = await this.exec("systemctl", ["--user", "show", "--property=Version"], { timeoutMs: 5_000 });
    return r.code === 0 ? { ok: true, detail: `systemd user manager (${r.stdout.trim()})` } : { ok: false, detail: `no systemd user manager reachable: ${r.stderr.trim() || `exit ${r.code}`}` };
  }
  async start(spec: UnitSpec) {
    await this.exec("systemctl", ["--user", "reset-failed", `${spec.unit}.service`]);
    const r = await this.exec("systemd-run", systemdRunArgv(spec));
    if (r.code !== 0) throw new DriverError(`systemd-run failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  }
  async stop(unit: string) {
    await this.exec("systemctl", ["--user", "stop", `${unit}.service`], { timeoutMs: 60_000 });
    await this.exec("systemctl", ["--user", "reset-failed", `${unit}.service`]);
  }
  async status(unit: string) {
    const r = await this.exec("systemctl", ["--user", "show", `${unit}.service`, "--property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus,Result"]);
    return r.code === 0 ? parseShow(r.stdout) : { state: "missing" as const, pid: null };
  }
  async signal(unit: string, sig: string) {
    const r = await this.exec("systemctl", ["--user", "kill", `--signal=SIG${sig}`, "--kill-whom=main", `${unit}.service`]);
    if (r.code !== 0) throw new DriverError(`signalling ${unit} failed: ${r.stderr.trim()}`);
  }
  owns(unit: string, pid: number) {
    try {
      return readFileSync(`/proc/${pid}/cgroup`, "utf8").includes(`/${unit}.service`);
    } catch {
      return false;
    }
  }
  pids(unit: string) {
    return procfsTable
      .list()
      .map((e) => e.pid)
      .filter((p) => this.owns(unit, p));
  }
  async logs(unit: string, lines: number, sinceMs?: number) {
    const since = sinceMs !== undefined ? [`--since=@${Math.floor(sinceMs / 1000)}`] : [];
    const r = await this.exec("journalctl", ["--user", "-u", `${unit}.service`, ...since, "-n", String(lines), "-o", "json", "--no-pager"]);
    const out: { t: string; text: string }[] = [];
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { __REALTIME_TIMESTAMP?: string; MESSAGE?: unknown };
        const msg = typeof e.MESSAGE === "string" ? e.MESSAGE : Array.isArray(e.MESSAGE) ? Buffer.from(e.MESSAGE as number[]).toString("utf8") : "";
        const t = e.__REALTIME_TIMESTAMP ? new Date(Number(BigInt(e.__REALTIME_TIMESTAMP) / 1000n)).toISOString() : "";
        out.push({ t, text: msg });
      } catch {
        // not a journal line
      }
    }
    return out;
  }
  async runOnce(spec: OnceSpec) {
    const t0 = Date.now();
    await this.exec("systemctl", ["--user", "reset-failed", `${spec.unit}.service`]);
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      void this.stop(spec.unit);
    };
    if (spec.signal?.aborted) onAbort();
    else spec.signal?.addEventListener("abort", onAbort, { once: true });
    const r = await this.exec("systemd-run", systemdRunArgv(spec, { timeoutSec: spec.timeoutSec }), { timeoutMs: (spec.timeoutSec + 30) * 1000 });
    spec.signal?.removeEventListener("abort", onAbort);
    const ms = Date.now() - t0;
    const timedOut = !aborted && ms >= spec.timeoutSec * 1000;
    if (timedOut) await this.stop(spec.unit);
    return { code: r.code, timedOut, ms, peakBytes: parseMemoryPeak(`${r.stderr}\n${r.stdout}`), ...(aborted ? { aborted } : {}) };
  }
  async units(prefix: string) {
    const r = await this.exec("systemctl", ["--user", "list-units", "--all", "--plain", "--no-legend", `${prefix}*`]);
    return r.stdout
      .split("\n")
      .map((l) => l.trim().split(/\s+/)[0] ?? "")
      .filter((u) => u.startsWith(prefix))
      .map((u) => u.replace(/\.service$/, ""));
  }
}

// ---- detached ----------------------------------------------------------------------------------

interface ProcRecord {
  pid: number;
  start: string;
  /** Which process table read `start` (a record from another table is matched by pid alone). */
  clock?: "procfs" | "ps";
  argv: string[];
  cwd: string;
  /** To start it again after a crash, as the engine started it. */
  env?: Record<string, string>;
  at: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface DetachedOptions {
  /** How the driver reads processes (default: /proc on Linux, else `ps`). */
  table?: ProcTable;
  /** Start a unit again when it ends with a failure while this server runs (the server's driver: on). */
  restart?: boolean;
  /** The delay before such a start, and the watch's tick. */
  restartMs?: number;
}

/** At most this many starts of one unit in RESTART_WINDOW_MS, then it stays failed (systemd's default burst). */
const RESTART_BURST = 5;
const RESTART_WINDOW_MS = 10_000;

/**
 * Each unit is a process started in its own session (`detached`, so setsid), its output appended to
 * `<state root>/project-services/logs/<unit>.log` and its pid and start time recorded in
 * `procs/<unit>.json`. It is not the server's to wait for, so it outlives a server restart. The unit
 * is its whole session (a tool like `pnpm exec` puts its child in a new process group, but the
 * group stays in the session): stop signals every process in it, TERM, then KILL after 15 s. Where
 * the process table has no session ids (macOS's `ps`), the unit is its leader's process tree and
 * the groups its members created. A process that starts a session of its own escapes. With
 * `restart`, a unit that ends with a failure is started again after 2 s, at most 5 times in 10 s.
 */
export class DetachedDriver implements Driver {
  readonly id = "detached" as const;
  private exits = new Map<string, number | null>();
  private readonly table: ProcTable;
  private readonly restartMs: number;
  private watch: NodeJS.Timeout | null = null;
  private ticking = false;
  /** Units being stopped: never started again under the stop. */
  private stopping = new Set<string>();
  /** Per unit: when it first looked dead, and its recent starts. */
  private down = new Map<string, number>();
  private starts = new Map<string, number[]>();
  private gaveUp = new Set<string>();
  constructor(
    private readonly stopGraceMs = 15_000,
    private readonly opts: DetachedOptions = {},
  ) {
    this.table = opts.table ?? hostProcTable();
    this.restartMs = opts.restartMs ?? 2_000;
  }
  private recFile = (unit: string) => join(procsDir(), `${unit}.json`);
  private logFile = (unit: string) => join(logsDir(), `${unit}.log`);
  private rec(unit: string): ProcRecord | null {
    try {
      return JSON.parse(readFileSync(this.recFile(unit), "utf8")) as ProcRecord;
    } catch {
      return null;
    }
  }
  /** The recorded process is alive, is the one recorded (not a reuse of its pid), and still leads its unit. */
  private live(r: ProcRecord | null): boolean {
    if (!r) return false;
    const e = this.table.get(r.pid);
    if (!e || e.zombie) return false;
    if ((r.clock ?? "procfs") === this.table.kind && this.table.startOf(r.pid) !== r.start) return false;
    return this.table.sessions ? e.sid === r.pid : e.pgid === r.pid;
  }
  private members(leader: number): number[] {
    return unitMembers(this.table.list(), leader, this.table.sessions);
  }
  async available() {
    if (process.platform === "win32") return { ok: false, detail: "detached sessions need a Unix host" };
    return { ok: true, detail: `detached sessions, processes read from ${this.table.kind === "procfs" ? "/proc" : `ps${this.table.sessions ? "" : " (no session ids: process trees and groups)"}`}` };
  }
  private spawnUnit(spec: UnitSpec): Promise<ProcRecord> {
    mkdirSync(procsDir(), { recursive: true });
    mkdirSync(logsDir(), { recursive: true });
    const fd = openSync(this.logFile(spec.unit), "a");
    return new Promise((ok, fail) => {
      let child;
      try {
        child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, detached: true, stdio: ["ignore", fd, fd] });
      } catch (err) {
        closeSync(fd);
        return fail(new DriverError(`cannot start ${spec.argv[0]}: ${(err as Error).message}`));
      }
      child.once("error", (err) => {
        closeSync(fd);
        fail(new DriverError(`cannot start ${spec.argv[0]}: ${err.message}`));
      });
      child.once("spawn", () => {
        closeSync(fd);
        const pid = child.pid!;
        const rec: ProcRecord = { pid, start: this.table.startOf(pid) ?? "", clock: this.table.kind, argv: spec.argv, cwd: spec.cwd, env: spec.env, at: new Date().toISOString() };
        this.exits.delete(spec.unit);
        child.once("exit", (code, sig) => this.exits.set(spec.unit, code ?? (sig ? 128 : null)));
        child.unref();
        ok(rec);
      });
    });
  }
  private async spawnRecorded(spec: UnitSpec): Promise<void> {
    const rec = await this.spawnUnit(spec);
    // The record holds the unit's env: only its owner reads it.
    writeFileSync(this.recFile(spec.unit), `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    const now = Date.now();
    this.starts.set(spec.unit, [...(this.starts.get(spec.unit) ?? []).filter((t) => now - t < RESTART_WINDOW_MS), now]);
    this.down.delete(spec.unit);
  }
  async start(spec: UnitSpec) {
    const old = this.rec(spec.unit);
    if (old && this.live(old)) return;
    this.gaveUp.delete(spec.unit);
    this.starts.delete(spec.unit);
    await this.spawnRecorded(spec);
    this.watchUnits();
  }
  /** With `restart`: every tick, start again each recorded unit that ended with a failure. */
  private watchUnits(): void {
    if (!this.opts.restart || this.watch) return;
    this.watch = setInterval(() => void this.tick(), Math.max(100, Math.min(this.restartMs, 1_000)));
    this.watch.unref();
  }
  /** One pass of the restart watch (public for tests). */
  async tick(): Promise<string[]> {
    if (this.ticking) return [];
    this.ticking = true;
    try {
      return await this.restartFailed();
    } finally {
      this.ticking = false;
    }
  }
  private async restartFailed(): Promise<string[]> {
    const did: string[] = [];
    for (const unit of await this.units("")) {
      if (this.stopping.has(unit) || this.gaveUp.has(unit)) continue;
      const r = this.rec(unit);
      if (!r || this.live(r)) {
        this.down.delete(unit);
        continue;
      }
      // A clean exit of its own is not a failure (systemd's on-failure); an unknown one is. A record
      // from before env was recorded can't be started the same way: reconcile starts it at the next server start.
      if (this.exits.get(unit) === 0 || !r.env) continue;
      const since = this.down.get(unit) ?? Date.now();
      this.down.set(unit, since);
      if (Date.now() - since < this.restartMs) continue;
      const recent = (this.starts.get(unit) ?? []).filter((t) => Date.now() - t < RESTART_WINDOW_MS);
      if (recent.length >= RESTART_BURST) {
        this.gaveUp.add(unit);
        did.push(`${unit}: start limit hit`);
        continue;
      }
      // What is left of its session goes first, as systemd's restart stops the whole unit.
      if (this.members(r.pid).length) await this.killSession(r.pid);
      try {
        await this.spawnRecorded({ unit, argv: r.argv, cwd: r.cwd, env: r.env ?? {} });
        did.push(`${unit}: started again`);
      } catch (err) {
        did.push(`${unit}: ${(err as Error).message}`);
      }
    }
    return did;
  }
  /** Adopt the recorded units at a server start: the watch covers them too. */
  async adopt(): Promise<void> {
    if ((await this.units("")).length) this.watchUnits();
  }
  /** TERM to every process of the unit, then KILL to what is left after the grace. */
  private async killSession(leader: number): Promise<void> {
    const send = (sig: NodeJS.Signals) => {
      for (const pid of this.members(leader))
        try {
          process.kill(pid, sig);
        } catch {
          // gone
        }
    };
    send("SIGTERM");
    const until = Date.now() + this.stopGraceMs;
    while (Date.now() < until) {
      if (!this.members(leader).length) return;
      await sleep(100);
    }
    send("SIGKILL");
    for (let i = 0; i < 50 && this.members(leader).length; i++) await sleep(100);
  }
  async stop(unit: string) {
    this.stopping.add(unit);
    try {
      const r = this.rec(unit);
      if (r && this.members(r.pid).length) await this.killSession(r.pid);
      rmSync(this.recFile(unit), { force: true });
      this.down.delete(unit);
      this.starts.delete(unit);
      this.gaveUp.delete(unit);
    } finally {
      this.stopping.delete(unit);
    }
  }
  async status(unit: string): Promise<UnitStatus> {
    const r = this.rec(unit);
    if (!r) return { state: "missing", pid: null };
    if (this.live(r)) return { state: "active", pid: r.pid };
    const exit = this.exits.get(unit);
    // Waiting to be started again, as systemd's auto-restart.
    if (this.opts.restart && this.watch && r.env && exit !== 0 && !this.gaveUp.has(unit)) return { state: "activating", pid: null, ...(exit !== undefined ? { exit } : {}), detail: "auto-restart" };
    return {
      state: exit === 0 ? "inactive" : "failed",
      pid: null,
      ...(exit !== undefined ? { exit } : {}),
      detail: this.gaveUp.has(unit) ? "start limit hit" : exit === undefined ? "exited" : `exited with ${exit}`,
    };
  }
  async signal(unit: string, sig: string) {
    const r = this.rec(unit);
    if (!r || !this.live(r)) throw new DriverError(`${unit} is not running`);
    process.kill(r.pid, `SIG${sig}` as NodeJS.Signals);
  }
  owns(unit: string, pid: number) {
    const r = this.rec(unit);
    if (!r) return false;
    if (this.table.sessions) {
      const e = this.table.get(pid);
      return !!e && !e.zombie && e.sid === r.pid;
    }
    return this.members(r.pid).includes(pid);
  }
  pids(unit: string) {
    const r = this.rec(unit);
    return r ? this.members(r.pid) : [];
  }
  async logs(unit: string, lines: number, _sinceMs?: number) {
    try {
      const f = this.logFile(unit);
      const size = statSync(f).size;
      const fd = openSync(f, "r");
      const want = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(want);
      readSync(fd, buf, 0, want, size - want);
      closeSync(fd);
      const all = buf.toString("utf8").split("\n");
      if (all.at(-1) === "") all.pop();
      if (want < size) all.shift(); // a cut first line
      return all.slice(-lines).map((text) => ({ t: "", text }));
    } catch {
      return [];
    }
  }
  async runOnce(spec: OnceSpec) {
    const t0 = Date.now();
    mkdirSync(logsDir(), { recursive: true });
    // Each waited-for run's output starts fresh: its log is that run's alone.
    const fd = openSync(this.logFile(spec.unit), "w");
    return await new Promise<RunOnceResult>((done) => {
      let child;
      try {
        child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, detached: true, stdio: ["ignore", fd, fd] });
      } catch {
        closeSync(fd);
        return done({ code: 127, timedOut: false, ms: Date.now() - t0 });
      }
      let timedOut = false;
      let aborted = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) void this.killSession(child.pid);
      }, spec.timeoutSec * 1000);
      const onAbort = () => {
        aborted = true;
        if (child.pid) void this.killSession(child.pid);
      };
      if (spec.signal?.aborted) onAbort();
      else spec.signal?.addEventListener("abort", onAbort, { once: true });
      // The run's memory: the largest resident total of its session's processes, sampled.
      let peak: number | null = null;
      const sample = () => {
        if (!child.pid) return;
        const now = rssOf(this.members(child.pid));
        if (now !== null) peak = Math.max(peak ?? 0, now);
      };
      const sampler = setInterval(sample, 200);
      sampler.unref();
      setImmediate(sample);
      const stopWatching = () => {
        clearTimeout(timer);
        clearInterval(sampler);
        spec.signal?.removeEventListener("abort", onAbort);
      };
      child.once("error", () => {
        stopWatching();
        closeSync(fd);
        done({ code: 127, timedOut: false, ms: Date.now() - t0 });
      });
      child.once("exit", (code, sig) => {
        stopWatching();
        closeSync(fd);
        // A hook leaves nothing behind (§app.project-services/supervisor): its session goes with it.
        const pid = child.pid;
        const leftover = pid ? this.members(pid).length : 0;
        const finish = () => done({ code: code ?? (sig ? 128 : null), timedOut, ms: Date.now() - t0, peakBytes: peak, ...(leftover ? { leftover } : {}), ...(aborted ? { aborted } : {}) });
        if (pid && leftover) void this.killSession(pid).then(finish);
        else finish();
      });
    });
  }
  async units(prefix: string) {
    try {
      return readdirSync(procsDir())
        .filter((f) => f.endsWith(".json") && f.startsWith(prefix))
        .map((f) => f.slice(0, -5));
    } catch {
      return [];
    }
  }
  /** Tests only: remove a unit's log. */
  clearLog(unit: string) {
    if (existsSync(this.logFile(unit))) rmSync(this.logFile(unit));
  }
}
