import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import {
  jobStoreOf,
  maxJobs,
  nextJobId,
  NO_OUTPUT_LINE,
  overLimitLine,
  readSessionJobs,
  runningJobs,
  writeJob,
  type JobRecord,
} from "../pi-config/extensions/subagents/job-store.ts";

/**
 * Keeping what a command left running (§app.background-jobs/keeping), in the chat's own process.
 *
 * Each `bash` call carries a mark of its own (`SOVA_JOB_CALL`, set at the call's start), inherited by
 * everything the call starts, `setsid` and `nohup` included. When the call returns, however it
 * returns, whatever is still in the chat's cgroup with that call's mark is what it left behind: it is
 * moved, as one job, into a scope of its own in `sova-jobs.slice`, so the chat unit's stop
 * (`KillMode=mixed`) no longer reaches it. A call still running carries another mark and is never
 * touched. Only a chat its host runs in a systemd unit keeps jobs (`SOVA_JOBS_UNIT_PREFIX`).
 */

export const JOB_CALL_ENV = "SOVA_JOB_CALL";
export const JOBS_UNIT_PREFIX_ENV = "SOVA_JOBS_UNIT_PREFIX";
export const JOBS_SLICE_ENV = "SOVA_JOBS_SLICE";
export const JOBS_SLICE = "sova-jobs.slice";
/** A scope's stop grace (§app.background-jobs/stopping) and its time limit, in µs. */
const STOP_USEC = 15_000_000;
const RUNTIME_MAX_USEC = 24 * 3600 * 1_000_000;

export interface ProcView {
  /** The pids in the chat's own cgroup. */
  pids(): number[];
  /** One process's environment, or null when it can't be read (gone, or not ours). */
  environ(pid: number): string[] | null;
  /** Its argv as one string (NUL-joined), or null when it can't be read. */
  cmdline(pid: number): string | null;
  /** Where its fd points (`/tmp/x.log`, `pipe:[123]`, `/dev/null`), or null. */
  fd(pid: number, n: number): string | null;
  /** Its cgroup path (`/user.slice/…`), or null. */
  cgroup(pid: number): string | null;
  /** Its state letter (`R`, `S`, `Z`…, /proc/<pid>/stat), or null when it is gone. */
  state(pid: number): string | null;
  bootId(): string;
  self: number;
}

const procCgroup = (pid: number | "self"): string | null => {
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n").find((l) => l.startsWith("0::"));
    return line ? line.slice(3).trim() : null;
  } catch {
    return null;
  }
};

export const realProc: ProcView = {
  pids() {
    const cg = procCgroup("self");
    if (!cg) return [];
    try {
      return readFileSync(`/sys/fs/cgroup${cg}/cgroup.procs`, "utf8").split("\n").filter(Boolean).map(Number);
    } catch {
      return [];
    }
  },
  environ(pid) {
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    } catch {
      return null;
    }
  },
  cmdline(pid) {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      return null;
    }
  },
  fd(pid, n) {
    try {
      return readlinkSync(`/proc/${pid}/fd/${n}`);
    } catch {
      return null;
    }
  },
  cgroup: (pid) => procCgroup(pid),
  state(pid) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) || null;
    } catch {
      return null;
    }
  },
  bootId() {
    try {
      return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {
      return "";
    }
  },
  self: process.pid,
};

/**
 * The pids in the chat's cgroup that carry this call's mark: in their environment (everything the
 * call's shell started after its first statement exported it), or in their command line (the call's
 * shell's own forked subshells, `( a; b ) &`, whose command line is the call's own command, mark
 * included, and whose environment is the one the shell started with). An unreadable process is not ours.
 */
export function markedPids(mark: string, proc: ProcView): number[] {
  return scanMarks(mark, proc).marked;
}

/**
 * One look at the chat's cgroup: the pids that carry the mark, and the pids that can't say yet.
 *
 * A forked child of the call's shell shows the mark in its command line until it execs, and in its
 * environment after; inside the `execve` its new image's arguments and environment aren't in place yet
 * and read empty (the arguments first, then the environment). Under load that lasts long enough for a
 * call's `cmd & false` to return while `cmd` is in it. So the command line is read first, the
 * environment second (a read straddling the exec then sees the mark or an empty environment, never the
 * old environment and the new arguments), and a live process whose environment reads empty is
 * unsettled: a later look decides it. A zombie reads empty too, and is no one's job.
 */
export function scanMarks(mark: string, proc: ProcView): { marked: number[]; unsettled: number[] } {
  const want = `${JOB_CALL_ENV}=${mark}`;
  const marked: number[] = [];
  const unsettled: number[] = [];
  for (const pid of proc.pids()) {
    if (pid === proc.self) continue;
    const cmd = proc.cmdline(pid);
    if (cmd?.includes(`export ${want};`)) {
      marked.push(pid);
      continue;
    }
    const env = proc.environ(pid);
    if (env?.includes(want)) marked.push(pid);
    else if (env && env.every((e) => e === "") && cmd !== null) {
      const s = proc.state(pid);
      if (s && s !== "Z" && s !== "X") unsettled.push(pid);
    }
  }
  return { marked, unsettled };
}

/** How long a capture waits, at most, for the chat's processes to finish an exec, and how often it looks. */
export const SETTLE_MS = 2_000;
const SETTLE_STEP_MS = 25;

/** A pipe, or the socket pair a JS runtime's spawn uses for "pipe" stdio. */
const isPipe = (t: string | null) => !!t && (t.startsWith("pipe:") || t.startsWith("socket:"));
const isFile = (t: string | null) => !!t && t.startsWith("/") && t !== "/dev/null" && !t.startsWith("/dev/pts") && !t.startsWith("/dev/tty") && !t.endsWith(" (deleted)");

/**
 * Where a job's output goes (§app.background-jobs/output). A pipe on stdout or stderr that no process
 * of the job reads (on its stdin) is the command's own output, closed now that the command returned:
 * its first write kills the writer. The job's output is the first file its stdout or stderr names.
 */
export function outputOf(pids: number[], proc: ProcView): { output?: string; noOutput?: true } {
  const readers = new Set(pids.map((p) => proc.fd(p, 0)).filter(isPipe));
  let output: string | undefined;
  let dead = false;
  for (const p of pids) {
    for (const n of [1, 2]) {
      const t = proc.fd(p, n);
      if (!output && isFile(t)) output = t!;
      if (isPipe(t) && !readers.has(t!)) dead = true;
    }
  }
  if (output) return { output };
  return dead ? { noOutput: true } : {};
}

export type Exec = (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
const realExec: Exec = (file, args) =>
  new Promise((ok) => execFile(file, args, { timeout: 10_000 }, (err, stdout, stderr) => ok({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })));

const BUS = ["--user", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager"];

/** The busctl argv that starts a scope for `pids` in the jobs slice (pure, for tests). */
export function startScopeArgv(unit: string, pids: number[], slice: string, description: string): string[] {
  return [
    ...BUS,
    "StartTransientUnit",
    "ssa(sv)a(sa(sv))",
    unit,
    "fail",
    "5",
    "PIDs",
    "au",
    String(pids.length),
    ...pids.map(String),
    "Slice",
    "s",
    slice,
    "Description",
    "s",
    description,
    "TimeoutStopUSec",
    "t",
    String(STOP_USEC),
    "RuntimeMaxUSec",
    "t",
    String(RUNTIME_MAX_USEC),
    "0",
  ];
}

export const attachArgv = (unit: string, pids: number[]) => [...BUS, "AttachProcessesToUnit", "ssau", unit, "", String(pids.length), ...pids.map(String)];

export interface CaptureDeps {
  proc: ProcView;
  exec: Exec;
  now(): number;
  sleep(ms: number): Promise<void>;
  env: NodeJS.ProcessEnv;
}

export const realCaptureDeps = (): CaptureDeps => ({ proc: realProc, exec: realExec, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), env: process.env });

export interface CaptureCall {
  mark: string;
  command: string;
  cwd: string;
  sessionId: string | undefined;
  sessionFile: string | undefined;
  /** The worker this chat is, when it is one. */
  worker?: string;
}

/** What a call's result gets told; none when it left nothing running. */
export interface CaptureOutcome {
  job?: JobRecord;
  overLimit?: true;
  error?: string;
  line: string;
}

/** Whether this chat keeps jobs at all: a chat its host runs in a systemd unit, with a store. */
export function capturing(env: NodeJS.ProcessEnv, sessionId: string | undefined, sessionFile: string | undefined): boolean {
  return !!env[JOBS_UNIT_PREFIX_ENV] && !!jobStoreOf(sessionId, sessionFile, env);
}

export const newMark = () => randomBytes(8).toString("hex");

/**
 * The call's command with its mark (§app.background-jobs/keeping): one statement in front, on the
 * command's own first line, run by the very shell pi starts, after pi's shell prefix. So the command
 * runs exactly as it would unmarked: same shell, same prefix setup (functions, aliases, options and
 * variables it defined), same cwd, environment and line numbers; it only gains one exported variable.
 */
export const markedCommand = (command: string, mark: string) => `export ${JOB_CALL_ENV}=${mark}; ${command}`;

/** The result's text with the mark's statement taken out (the same object when it has none). */
export function unmarkedContent<C extends { type: string; text?: string }>(content: C[], mark: string): C[] {
  const stmt = `export ${JOB_CALL_ENV}=${mark}; `;
  if (!content.some((c) => c.type === "text" && c.text?.includes(stmt))) return content;
  return content.map((c) => (c.type === "text" && c.text?.includes(stmt) ? { ...c, text: c.text.split(stmt).join("") } : c));
}

const unitPart = (s: string) => s.replace(/[^A-Za-z0-9]/g, "").slice(-12);

/** The line a call's result ends with when it left a job. */
export function keptLine(j: JobRecord): string {
  return [`[Sova] This command left something running; it is kept as background job ${j.id} and outlives this chat's shutdown, reload or crash. Its end will wake you unless this chat has reached its limit of 30 wakes without the user.`, j.noOutput ? NO_OUTPUT_LINE : j.output ? `Its output: ${j.output}` : ""].filter(Boolean).join(" ");
}

/**
 * After one call returned: keep what it left running. Two passes, a short beat apart, catch a fork
 * that was under way at the first; while a process of the chat is mid-exec (unmarked for now, maybe
 * the call's) it keeps looking, up to SETTLE_MS; a straggler after the move joins the scope.
 */
export async function captureCall(call: CaptureCall, d: CaptureDeps): Promise<CaptureOutcome | null> {
  if (!capturing(d.env, call.sessionId, call.sessionFile)) return null;
  const store = jobStoreOf(call.sessionId, call.sessionFile, d.env)!;
  const found = new Set<number>();
  const look = () => {
    const s = scanMarks(call.mark, d.proc);
    for (const p of s.marked) found.add(p);
    return s.unsettled.filter((p) => !found.has(p)).length;
  };
  const open = look();
  if (!open && !found.size) return null;
  await d.sleep(50);
  for (let waited = 50, open = look(); open && waited < SETTLE_MS; waited += SETTLE_STEP_MS) {
    await d.sleep(SETTLE_STEP_MS);
    open = look();
  }
  let pids = [...found].filter((p) => d.proc.cmdline(p) !== null);
  if (!pids.length) return null;
  const max = maxJobs(d.env);
  // An ended job doesn't count, even before the host has noticed its end.
  const running = runningJobs(readSessionJobs(store.dir, store.sessionId)).filter((j) => !j.cgroup || cgroupProcs(j.cgroup).length > 0 || !j.cgroup.startsWith("/sys/fs/cgroup/"));
  if (running.length >= max) return { overLimit: true, line: overLimitLine(max) };
  const out = outputOf(pids, d.proc);
  const id = nextJobId(store.dir, store.sessionId);
  const unit = `${d.env[JOBS_UNIT_PREFIX_ENV]}${unitPart(store.sessionId)}-${id}.scope`;
  const r = await d.exec("busctl", startScopeArgv(unit, pids, d.env[JOBS_SLICE_ENV] || JOBS_SLICE, `Sova background job ${id}: ${call.command.slice(0, 120)}`));
  if (r.code !== 0) return { error: r.stderr.trim() || `busctl exited ${r.code}`, line: `[Sova] This command left something running, but it couldn't be kept as a background job (${r.stderr.trim() || "the service manager refused"}). It will end at this chat's next shutdown or reload.` };
  // Stragglers forked between the scan and the move.
  const late = markedPids(call.mark, d.proc);
  if (late.length) await d.exec("busctl", attachArgv(unit, late));
  const cgroup = pids.map((p) => d.proc.cgroup(p)).find((c) => c?.endsWith(`/${unit}`));
  const job: JobRecord = {
    v: 1,
    id,
    sessionId: store.sessionId,
    path: store.path,
    kind: "kept",
    command: call.command,
    cwd: call.cwd,
    unit,
    driver: "systemd",
    ...(cgroup ? { cgroup: `/sys/fs/cgroup${cgroup}` } : {}),
    startedAt: d.now(),
    bootId: d.proc.bootId(),
    ...out,
    ...(call.worker ? { worker: call.worker } : {}),
  };
  writeJob(store.dir, job);
  return { job, line: keptLine(job) };
}

/** Every pid in a cgroup directory (none when it is gone). */
export function cgroupProcs(dir: string): number[] {
  try {
    return readFileSync(`${dir}/cgroup.procs`, "utf8").split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/** A chat's cgroup's children, for tests. */
export const listDir = (dir: string) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
