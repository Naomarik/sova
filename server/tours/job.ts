import { chmodSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, constants } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isTourId, normalizeTourJob, type TourJob } from "../../shared/tour";

export const TOUR_TERMINAL_PHASES = new Set<TourJob["phase"]>(["ready", "failed", "cancelled", "interrupted"]);
export const tourJobTerminal = (job: TourJob): boolean => TOUR_TERMINAL_PHASES.has(job.phase);

/** Host-local state only; never put this directory in an organization backup. */
export function privateTourDirectory(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error("Unsafe tour state directory.");
  chmodSync(root, 0o700);
}

/** Atomic replacement, with no symlink following and private permissions even under a loose umask. */
export function writePrivateTourJson(root: string, file: string, value: unknown): void {
  if (!/^[a-z0-9][a-z0-9-]{0,159}\.json$/.test(file)) throw new Error("Invalid tour state filename.");
  privateTourDirectory(root);
  const tmp = join(root, `.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, JSON.stringify(value));
    closeSync(fd); fd = undefined;
    renameSync(tmp, join(root, file));
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(tmp, { force: true });
  }
}

export function readPrivateTourJson(root: string, file: string): unknown {
  if (!/^[a-z0-9][a-z0-9-]{0,159}\.json$/.test(file)) throw new Error("Invalid tour state filename.");
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error("Unsafe tour state directory.");
  const path = join(root, file);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("Invalid tour state file.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); }
}

/** Only the strict public job shape is persisted: no runner context, browser state or credentials. */
export class TourJobStore {
  constructor(readonly root: string) { privateTourDirectory(root); }
  save(job: TourJob): TourJob {
    const checked = normalizeTourJob(job);
    if (!checked) throw new Error("Invalid tour job.");
    writePrivateTourJson(this.root, `${checked.id}.json`, checked);
    return checked;
  }
  get(id: string): TourJob | null {
    if (!isTourId(id)) return null;
    try {
      const job = normalizeTourJob(readPrivateTourJson(this.root, `${id}.json`));
      return job?.id === id ? job : null;
    } catch { return null; }
  }
  list(): TourJob[] {
    return readdirSync(this.root).filter(f => f.endsWith(".json")).flatMap(f => {
      const job = this.get(f.slice(0, -5)); return job ? [job] : [];
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  /** Remove only this deleted chat's jobs, never another session or shared operator state. */
  removeSession(sessionId: string): void {
    const errors: unknown[] = [];
    for (const job of this.list()) if (job.sessionId === sessionId) {
      try { rmSync(join(this.root, `${job.id}.json`), { force: true }); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Some deleted chat job files could not be removed.");
  }
  /**
   * No automatic replay after restart, even for queued attempts. Checked editions are elsewhere. A
   * finished capture awaiting its explicit check ("checking") holds no browser: it stays checking,
   * and the check re-validates its private attempt from scratch. Everything else unfinished is
   * interrupted.
   */
  recover(now = new Date().toISOString()): TourJob[] {
    return this.list().map(job => tourJobTerminal(job) || job.phase === "checking" ? job : this.save({
      ...job, phase: "interrupted", queuePosition: undefined, requirements: undefined, updatedAt: now,
      failure: { message: "Recording was interrupted by a server restart.", guidance: "The previous checked edition is unchanged. Request Retry to start a fresh attempt." },
    }));
  }
}
