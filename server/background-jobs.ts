import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { sessionTmpBase } from "../pi-config/extensions/sandbox/session-policy.ts";
import { dirname, join } from "node:path";
import {
  JOB_TIME_LIMIT_MS,
  JOBS_DIR_ENV,
  JOBS_DIR_NAME,
  JOBS_WAKE_SOURCE,
  pendingCards,
  readAllJobs,
  readJob,
  readSessionJobs,
  runningJobs,
  sessionJobsDir,
  writeJob,
  type JobCard,
  type JobEndHow,
  type JobRecord,
} from "../pi-config/extensions/subagents/job-store.ts";
import { publishWakes } from "../pi-config/extensions/subagents/wake-store.ts";
import { cgroupProcs, JOBS_UNIT_PREFIX_ENV, realProc } from "./background-jobs-capture";
import { stateHash } from "./project-services/store";
import { stateRoot } from "./state-root";
import { wakeDir, wakesOn } from "./wake-keeper";

/**
 * Background jobs, the server's half (§app/background-jobs): the records a chat writes when it keeps a
 * job (server/background-jobs-capture.ts), the keeper that notices a job's end and asks for its card,
 * and Stop. A job's end card is delivered by its own chat (pi-config/extensions/wake-nudge.ts), which
 * the wake keeper brings back for it as for a nudge: the end publishes a `jobs` wake item.
 */

export const jobsDir = () => join(stateRoot(), JOBS_DIR_NAME);
export const jobsUnitPrefix = (hash = stateHash()) => `sova-job-${hash}-`;

/** A chat process's job variables: only under the systemd driver, and only where wakes are on. */
export function jobsEnv(driver: "systemd" | "detached" | undefined): Record<string, string> {
  if (driver !== "systemd" || !wakesOn()) return {};
  return { [JOBS_DIR_ENV]: jobsDir(), [JOBS_UNIT_PREFIX_ENV]: jobsUnitPrefix() };
}

/**
 * Set (`only`) in a worker's, team member's or hidden chat's process when it keeps jobs but its own
 * extensions don't name wake-nudge.ts: the chat loads that file anyway, only to deliver its jobs' end
 * cards (no `wake_nudge` tool), so a worker's job wakes the worker (§app.background-jobs/end-card).
 */
export const JOB_CARDS_ENV = "SOVA_JOB_CARDS";
export const WAKE_NUDGE_FILE = "wake-nudge.ts";
export function jobCardsEnv(spec: { builtins: string[] | null; extensions: readonly string[] } | undefined, jobs: Record<string, string>): Record<string, string> {
  if (!spec || !jobs[JOBS_DIR_ENV]) return {};
  if (spec.builtins && !spec.builtins.includes("bash")) return {};
  if (spec.extensions.some((e) => e === WAKE_NUDGE_FILE || e.endsWith(`/${WAKE_NUDGE_FILE}`))) return {};
  return { [JOB_CARDS_ENV]: "only" };
}

type Exec = (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
const realExec: Exec = (file, args) =>
  new Promise((ok) => execFile(file, args, { timeout: 30_000 }, (err, stdout, stderr) => ok({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })));

/** Is the job still running: its cgroup holds a process (systemd), else its unit is active. */
export async function jobAlive(j: JobRecord, exec: Exec = realExec): Promise<boolean> {
  if (j.cgroup) return cgroupProcs(j.cgroup).length > 0;
  const r = await exec("systemctl", ["--user", "is-active", j.unit]);
  return r.stdout.trim() === "active" || r.stdout.trim() === "activating" || r.stdout.trim() === "deactivating";
}

function exitOf(j: JobRecord): number | null {
  if (!j.exitFile) return null;
  try {
    const n = Number(readFileSync(j.exitFile, "utf8").trim());
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/** How a job that is gone ended, and what its chat gets (§app.background-jobs/end-card). */
export function endOf(j: JobRecord, at: number, bootId: string, exit: number | null): { how: JobEndHow; card: JobCard; exit?: number | null } {
  if (j.bootId && bootId && j.bootId !== bootId) return { how: "restart", card: "wake" };
  if (j.stop?.why === "stop") return { how: "stopped", card: "note" };
  if (j.stop?.why === "archive" || j.stop?.why === "teardown") return { how: "archived", card: "none" };
  if (j.stop?.why === "worker") return { how: "worker-stopped", card: "none" };
  if (at - j.startedAt >= JOB_TIME_LIMIT_MS - 60_000) return { how: "time-limit", card: "wake" };
  // Every job that exits wakes its chat, however soon: its kept line promised that.
  if (j.kind === "requested") return { how: "exited", card: "wake", exit };
  return { how: "exited", card: "wake" };
}

export interface JobKeeperDeps {
  dir: string;
  wakeDir: string | null;
  now(): number;
  bootId(): string;
  alive(j: JobRecord): Promise<boolean>;
  exit(j: JobRecord): number | null;
  /** Ask the service manager to stop a job's unit (its own grace, then SIGKILL). */
  stopUnit(j: JobRecord): Promise<void>;
  /** Where the keeper keeps the time of its last sweep, for a late end. */
  stateFile: string;
  log(line: string): void;
}

/** Publish a chat's pending end cards as `jobs` wake items, so the wake keeper brings it back. */
export function publishJobWakes(dir: string, wakes: string | null, sessionId: string, path: string, now = Date.now()): void {
  if (!wakes) return;
  const items = pendingCards(dir, sessionId)
    .filter((j) => j.ended!.card === "wake")
    .map((j) => ({ id: j.id, at: j.ended!.at }));
  publishWakes({ dir: wakes, sessionId, path }, JOBS_WAKE_SOURCE, items, now);
}

/** What a requested job leaves once it ended: its env file, and its own sandbox tmp. */
export function cleanUpAfter(dir: string, j: JobRecord): void {
  try {
    rmSync(join(sessionJobsDir(dir, j.sessionId), `${j.id}.env`), { force: true });
    if (j.scratch && j.scratch.startsWith(`${sessionTmpBase()}/`)) rmSync(j.scratch, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

export class JobKeeper {
  private sweeping = false;
  private lastSweep: number;
  private first = true;
  constructor(private readonly d: JobKeeperDeps) {
    this.lastSweep = this.readLast();
  }
  private readLast(): number {
    try {
      const n = Number(readFileSync(this.d.stateFile, "utf8").trim());
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }
  private saveLast(at: number): void {
    try {
      mkdirSync(dirname(this.d.stateFile), { recursive: true, mode: 0o700 });
      writeFileSync(`${this.d.stateFile}.tmp`, `${at}\n`, { mode: 0o600 });
      renameSync(`${this.d.stateFile}.tmp`, this.d.stateFile);
    } catch {
      /* the next sweep writes again */
    }
  }

  async tick(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.sweep();
    } finally {
      this.sweeping = false;
    }
  }

  private async sweep(): Promise<void> {
    const d = this.d;
    const now = d.now();
    const boot = d.bootId();
    // A job that ended while no server ran ended some time after the last sweep of the one before.
    const since = this.first ? this.lastSweep : 0;
    this.first = false;
    for (const j of runningJobs(readAllJobs(d.dir))) {
      const restarted = !!j.bootId && !!boot && j.bootId !== boot;
      if (!restarted && (await d.alive(j))) {
        if (now - j.startedAt >= JOB_TIME_LIMIT_MS && !j.stop) {
          // The scope's own limit stops it; this covers a unit that has none.
          d.log(`${j.sessionId} ${j.id}: over the time limit, stopping it`);
          await d.stopUnit(j).catch(() => {});
        }
        continue;
      }
      const fresh = readJob(d.dir, j.sessionId, j.id) ?? j;
      if (fresh.ended) continue;
      const endAt = since && since > fresh.startedAt && since < now - 60_000 ? since : now;
      const end = endOf(fresh, endAt, boot, d.exit(fresh));
      const late = endAt < now - 60_000 ? now - endAt : undefined;
      fresh.ended = { at: endAt, how: end.how, card: end.card, ...("exit" in end ? { exit: end.exit } : {}), ...(late ? { late } : {}) };
      writeJob(d.dir, fresh);
      cleanUpAfter(d.dir, fresh);
      d.log(`${fresh.sessionId} ${fresh.id}: ended (${end.how}; card: ${end.card})`);
      if (end.card === "wake") {
        try {
          publishJobWakes(d.dir, d.wakeDir, fresh.sessionId, fresh.path, now);
        } catch (err) {
          d.log(`${fresh.sessionId}: wake not published: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    this.saveLast(now);
  }

  start(tickMs: number): void {
    setInterval(() => void this.tick().catch((err) => this.d.log(`tick failed: ${err instanceof Error ? err.message : String(err)}`)), tickMs).unref();
  }
}

export const stopUnitReal = async (j: JobRecord, exec: Exec = realExec): Promise<void> => {
  await exec("systemctl", ["--user", "stop", "--no-block", j.unit]);
};

let keeper: JobKeeper | null = null;

/** Start the real keeper (`SOVA_JOBS_TICK_MS` shortens its tick for a test server). */
export function startJobKeeper(env: NodeJS.ProcessEnv = process.env): JobKeeper | null {
  if (process.platform !== "linux") return null;
  const n = Number(env.SOVA_JOBS_TICK_MS);
  keeper = new JobKeeper({
    dir: jobsDir(),
    wakeDir: wakesOn() ? wakeDir() : null,
    now: Date.now,
    bootId: () => realProc.bootId(),
    alive: (j) => jobAlive(j),
    exit: exitOf,
    stopUnit: (j) => stopUnitReal(j),
    stateFile: join(jobsDir(), ".keeper"),
    log: (line) => console.log(`[background-jobs] ${line}`),
  });
  void keeper.tick();
  keeper.start(n > 0 ? n : 5_000);
  return keeper;
}

/** Sweep now (after a stop, so its end shows at once). */
export const sweepJobs = () => keeper?.tick() ?? Promise.resolve();

/** Ask one job to stop (§app.background-jobs/stopping): its record says why, then its unit stops. */
export async function stopJob(sessionId: string, id: string, why: NonNullable<JobRecord["stop"]>["why"], o: { dir?: string; stopUnit?: (j: JobRecord) => Promise<void>; now?: number } = {}): Promise<JobRecord | null> {
  const dir = o.dir ?? jobsDir();
  const j = readJob(dir, sessionId, id);
  if (!j || j.ended) return j;
  if (!j.stop) {
    j.stop = { at: o.now ?? Date.now(), why };
    writeJob(dir, j);
  }
  await (o.stopUnit ?? stopUnitReal)(j);
  return j;
}

/** Stop every running job of these chats. */
export async function stopJobsOf(sessionIds: string[], why: NonNullable<JobRecord["stop"]>["why"], o: { dir?: string; stopUnit?: (j: JobRecord) => Promise<void> } = {}): Promise<number> {
  const dir = o.dir ?? jobsDir();
  let n = 0;
  for (const sid of sessionIds) {
    for (const j of runningJobs(readSessionJobs(dir, sid))) {
      await stopJob(sid, j.id, why, o).catch(() => {});
      n++;
    }
  }
  return n;
}

/**
 * Stop every running job of this state root (`bun scripts/stop-chats.ts`, Sova stopped for good): no
 * card. The units' stop is the service manager's; the next keeper, if any, records the ends.
 */
export async function stopAllJobs(o: { dir?: string; stopUnit?: (j: JobRecord) => Promise<void> } = {}): Promise<JobRecord[]> {
  const dir = o.dir ?? jobsDir();
  const out: JobRecord[] = [];
  for (const j of runningJobs(readAllJobs(dir))) {
    const r = await stopJob(j.sessionId, j.id, "teardown", o).catch(() => null);
    if (r) out.push(r);
  }
  return out;
}

/** A job as the pane and the catalogue show it. */
export interface JobView {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  kind: "kept" | "requested";
  startedAt: number;
  output: string | null;
  noOutput: boolean;
  worker: string | null;
  stopping: boolean;
}

export const jobView = (j: JobRecord, worker: string | null = j.worker ?? null): JobView => ({
  id: j.id,
  sessionId: j.sessionId,
  command: j.command,
  cwd: j.cwd,
  kind: j.kind,
  startedAt: j.startedAt,
  output: j.output ?? null,
  noOutput: !!j.noOutput,
  worker,
  stopping: !!j.stop,
});

/** A chat's running jobs and its workers' (`workers`: worker session id → worker id). */
export function chatJobs(sessionId: string, workers: Map<string, string>, dir = jobsDir()): JobView[] {
  const out = runningJobs(readSessionJobs(dir, sessionId)).map((j) => jobView(j, null));
  for (const [sid, wid] of workers) out.push(...runningJobs(readSessionJobs(dir, sid)).map((j) => jobView(j, wid)));
  return out;
}

/** How many running jobs a chat has (no worker's): the session list's marker. */
export const runningJobCount = (sessionId: string, dir = jobsDir()): number => (existsSync(dir) ? runningJobs(readSessionJobs(dir, sessionId)).length : 0);

/** The running jobs as the resource monitor charges them: each
    with its unit's cgroup, to the chat that left it; a worker's to its parent session as that worker
    (`ownerOf`: a worker chat's session id → its parent's session file and worker id). A job with no
    cgroup (no systemd) is not measured. */
export function monitorJobs(
  ownerOf: (sessionId: string) => { parentPath: string; workerId: string } | undefined,
  dir = jobsDir(),
): { cgroup: string; session: string; worker?: string }[] {
  if (!existsSync(dir)) return [];
  const out: { cgroup: string; session: string; worker?: string }[] = [];
  for (const j of runningJobs(readAllJobs(dir))) {
    if (!j.cgroup) continue;
    const w = ownerOf(j.sessionId);
    out.push(w ? { cgroup: j.cgroup, session: w.parentPath, worker: w.workerId } : { cgroup: j.cgroup, session: j.path });
  }
  return out;
}
