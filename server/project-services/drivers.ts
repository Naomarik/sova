import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logsDir, procsDir } from "./store";

/**
 * Who runs a service's processes (§app.project-services/supervisor). Exactly one driver owns each
 * process: systemd transient user units by default, or, only when the server was started with
 * SOVA_PROJECT_DRIVER=detached, a process group of its own per unit. Everything by argv, never a
 * shell. Nothing here touches a unit or process it was not asked about by name.
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
}

export interface Driver {
  readonly id: "systemd" | "detached";
  available(): Promise<{ ok: boolean; detail: string }>;
  start(spec: UnitSpec): Promise<void>;
  stop(unit: string): Promise<void>;
  status(unit: string): Promise<UnitStatus>;
  signal(unit: string, sig: string): Promise<void>;
  /** Whether `pid` runs inside `unit`. */
  owns(unit: string, pid: number): boolean;
  /** Every live pid inside `unit`. */
  pids(unit: string): number[];
  logs(unit: string, lines: number): Promise<{ t: string; text: string }[]>;
  /** Run to completion (a hook, setup or build step), killed whole at `timeoutSec`. */
  runOnce(spec: UnitSpec & { timeoutSec: number }): Promise<RunOnceResult>;
  /** The units (running, or recorded) whose name starts with `prefix`. */
  units(prefix: string): Promise<string[]>;
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

/** `/proc/<pid>/stat` fields after the command name: [state, ppid, pgrp, session, …]; index 19 is starttime. */
function statFields(pid: number): string[] | null {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    return s.slice(s.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}
const pgrpOf = (pid: number) => {
  const f = statFields(pid);
  return f && f[0] !== "Z" ? Number(f[2]) : null;
};
const startOf = (pid: number) => statFields(pid)?.[19] ?? null;
const allPids = () => {
  try {
    return readdirSync("/proc").filter((d) => /^\d+$/.test(d)).map(Number);
  } catch {
    return [];
  }
};

// ---- systemd ------------------------------------------------------------------------------------

export const SLICE = "sova-services.slice";

/** The `systemd-run` argv that starts `spec` as a transient user service (pure, for tests). */
export function systemdRunArgv(spec: UnitSpec, once?: { timeoutSec: number }): string[] {
  const a = ["--user", `--unit=${spec.unit}`, `--slice=${SLICE}`, "--collect", "--quiet", `--working-directory=${spec.cwd}`, "--property=StandardInput=null"];
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
    return allPids().filter((p) => this.owns(unit, p));
  }
  async logs(unit: string, lines: number) {
    const r = await this.exec("journalctl", ["--user", "-u", `${unit}.service`, "-n", String(lines), "-o", "json", "--no-pager"]);
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
  async runOnce(spec: UnitSpec & { timeoutSec: number }) {
    const t0 = Date.now();
    await this.exec("systemctl", ["--user", "reset-failed", `${spec.unit}.service`]);
    const r = await this.exec("systemd-run", systemdRunArgv(spec, { timeoutSec: spec.timeoutSec }), { timeoutMs: (spec.timeoutSec + 30) * 1000 });
    const ms = Date.now() - t0;
    const timedOut = ms >= spec.timeoutSec * 1000;
    if (timedOut) await this.stop(spec.unit);
    return { code: r.code, timedOut, ms };
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
  argv: string[];
  cwd: string;
  at: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Each unit is a process started in its own session and process group, its output appended to
 * `<state root>/project-services/logs/<unit>.log` and its pid and start time recorded in
 * `procs/<unit>.json`. It is not the server's to wait for, so it outlives a server restart. Stop
 * signals the whole group: TERM, then KILL after 15 s. A process that left the group escapes.
 */
export class DetachedDriver implements Driver {
  readonly id = "detached" as const;
  private exits = new Map<string, number | null>();
  constructor(private readonly stopGraceMs = 15_000) {}
  private recFile = (unit: string) => join(procsDir(), `${unit}.json`);
  private logFile = (unit: string) => join(logsDir(), `${unit}.log`);
  private rec(unit: string): ProcRecord | null {
    try {
      return JSON.parse(readFileSync(this.recFile(unit), "utf8")) as ProcRecord;
    } catch {
      return null;
    }
  }
  private live(r: ProcRecord | null): boolean {
    return !!r && startOf(r.pid) === r.start && pgrpOf(r.pid) === r.pid;
  }
  async available() {
    return process.platform === "linux" ? { ok: true, detail: "detached process groups (SOVA_PROJECT_DRIVER=detached)" } : { ok: false, detail: "the detached driver reads /proc: Linux only" };
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
        const rec: ProcRecord = { pid, start: startOf(pid) ?? "", argv: spec.argv, cwd: spec.cwd, at: new Date().toISOString() };
        this.exits.delete(spec.unit);
        child.once("exit", (code, sig) => this.exits.set(spec.unit, code ?? (sig ? 128 : null)));
        child.unref();
        ok(rec);
      });
    });
  }
  async start(spec: UnitSpec) {
    const old = this.rec(spec.unit);
    if (old && this.live(old)) return;
    const rec = await this.spawnUnit(spec);
    writeFileSync(this.recFile(spec.unit), `${JSON.stringify(rec)}\n`);
  }
  private groupPids(pgid: number): number[] {
    return allPids().filter((p) => pgrpOf(p) === pgid);
  }
  private async killGroup(pgid: number): Promise<void> {
    const send = (sig: NodeJS.Signals) => {
      try {
        process.kill(-pgid, sig);
      } catch {
        // gone
      }
    };
    send("SIGTERM");
    const until = Date.now() + this.stopGraceMs;
    while (Date.now() < until) {
      if (!this.groupPids(pgid).length) return;
      await sleep(100);
    }
    send("SIGKILL");
    for (let i = 0; i < 50 && this.groupPids(pgid).length; i++) await sleep(100);
  }
  async stop(unit: string) {
    const r = this.rec(unit);
    if (r && startOf(r.pid) === r.start) await this.killGroup(r.pid);
    else if (r && this.groupPids(r.pid).length) await this.killGroup(r.pid);
    rmSync(this.recFile(unit), { force: true });
  }
  async status(unit: string): Promise<UnitStatus> {
    const r = this.rec(unit);
    if (!r) return { state: "missing", pid: null };
    if (this.live(r)) return { state: "active", pid: r.pid };
    const exit = this.exits.get(unit);
    return { state: exit === 0 ? "inactive" : "failed", pid: null, ...(exit !== undefined ? { exit } : {}), detail: exit === undefined ? "exited" : `exited with ${exit}` };
  }
  async signal(unit: string, sig: string) {
    const r = this.rec(unit);
    if (!r || !this.live(r)) throw new DriverError(`${unit} is not running`);
    process.kill(r.pid, `SIG${sig}` as NodeJS.Signals);
  }
  owns(unit: string, pid: number) {
    const r = this.rec(unit);
    return !!r && pgrpOf(pid) === r.pid;
  }
  pids(unit: string) {
    const r = this.rec(unit);
    return r ? this.groupPids(r.pid) : [];
  }
  async logs(unit: string, lines: number) {
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
  async runOnce(spec: UnitSpec & { timeoutSec: number }) {
    const t0 = Date.now();
    mkdirSync(logsDir(), { recursive: true });
    const fd = openSync(this.logFile(spec.unit), "a");
    return await new Promise<RunOnceResult>((done) => {
      let child;
      try {
        child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, detached: true, stdio: ["ignore", fd, fd] });
      } catch {
        closeSync(fd);
        return done({ code: 127, timedOut: false, ms: Date.now() - t0 });
      }
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) void this.killGroup(child.pid);
      }, spec.timeoutSec * 1000);
      child.once("error", () => {
        clearTimeout(timer);
        closeSync(fd);
        done({ code: 127, timedOut: false, ms: Date.now() - t0 });
      });
      child.once("exit", (code, sig) => {
        clearTimeout(timer);
        closeSync(fd);
        // A hook leaves nothing behind (§app.project-services/supervisor): its group goes with it.
        const pid = child.pid;
        const leftover = pid ? this.groupPids(pid).length : 0;
        const finish = () => done({ code: code ?? (sig ? 128 : null), timedOut, ms: Date.now() - t0, ...(leftover ? { leftover } : {}) });
        if (pid && leftover) void this.killGroup(pid).then(finish);
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

/** The driver the server uses: systemd, unless SOVA_PROJECT_DRIVER=detached. */
export function driverFromEnv(env: NodeJS.ProcessEnv = process.env): Driver {
  return env.SOVA_PROJECT_DRIVER === "detached" ? new DetachedDriver() : new SystemdDriver();
}
