import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync, gzip } from "node:zlib";
import { RUN_LOG_CLEANED_LINE, RUN_LOGS_KEEP_NEWEST, RUN_LOGS_PACK_AFTER_MS, type RunLogsCleaned, type RunLogsInfo } from "../../shared/merge-run-logs";
import { ENTRY_FINAL, type MergeRun } from "../../shared/merge-queue";
import { trulyFinal } from "./history";
import type { QueueFile, QueueStore } from "./store";

/**
 * The merge queue's run folders over time, like logrotate: a finished run's logs are packed (gzip) a day after it
 * ended, never deleted on their own; Clean Logs (the user's click in the merge thread's chat) takes the logs of old
 * finished runs, keeping every run's record.
 *
 *   <runDir>/logs/<step>.log            → <step>.log.gz        (each step log, and its `.out.json` counts file)
 *   run.json, changed.txt, docs-landed.json stay as they are (small, and read after the run).
 *
 * The spec drafts copy a run carries (`<runDir>/drafts/`, ~97% of a run folder's size) is read only while the run
 * runs: the queue deletes it as the run ends (dropRunDrafts), and a sweep deletes any left on disk (a stop mid-run, a
 * folder from before) with the `drafts.tar.gz` older sweeps packed it into, whatever the run's age, once the run has
 * ended and isn't checking, even when an open entry names it. A later run of the same entry copies the drafts afresh
 * into its own folder.
 *
 * A run in use (the queue's current run, one an entry in `checking` names, one an open entry or a sent-back entry
 * still waiting for its fix names (history.ts trulyFinal), or one whose record says `running` or has no end) is never touched. Each pack writes its result beside the original and renames it in
 * before the original goes, so a stop between the two leaves both, and the next sweep packs it again.
 */

/** What a sweep or a clean reads of a project's queue. */
export interface RunLogsQueue {
  readonly id: string;
  readonly store: QueueStore;
  entries(): RunLogsEntry[];
  currentRun(): Pick<MergeRun, "id"> | null;
  /** Sent-back entries git last said need no fix any more (merged, gone), by entry id; absent or empty: none known. */
  settled?(): ReadonlyMap<string, "merged" | "gone">;
  /** Read those facts afresh (a sweep calls it first). */
  refreshSettled?(): Promise<void>;
}
export type RunLogsEntry = QueueFile["entries"][number];

/** Written into a run folder once Clean Logs took its logs: its steps read RUN_LOG_CLEANED_LINE. */
export const CLEANED_MARK = "logs-cleaned";
/** The spec drafts copy a run carries while it runs (queue.ts startRun). */
export const RUN_DRAFTS = "drafts";
/** What sweeps before drafts were deleted packed that copy into: nothing reads it. */
const DRAFTS_ARCHIVE = "drafts.tar.gz";
/** What Clean Logs leaves of a run: its record and the small files read after it. */
const KEPT_ON_CLEAN = new Set(["run.json", "changed.txt", "docs-landed.json", CLEANED_MARK]);

const run$ = /^mr_[0-9a-z]+$/;
const gzipAsync = promisify(gzip);

// ---- reading ------------------------------------------------------------------------------------

/**
 * A step log's text, packed or not; null when it isn't there. A cleaned run's log reads RUN_LOG_CLEANED_LINE.
 * `log` is the step's path inside the run folder (`logs/01-copy.log`).
 */
export function readRunLogText(runDir: string, log: string): string | null {
  if (log.includes("..") || log.startsWith("/")) return null;
  const file = join(runDir, log);
  try {
    return readFileSync(file, "utf8");
  } catch {}
  try {
    return gunzipSync(readFileSync(`${file}.gz`)).toString("utf8");
  } catch {}
  return existsSync(join(runDir, CLEANED_MARK)) ? `${RUN_LOG_CLEANED_LINE}\n` : null;
}

// ---- sizes --------------------------------------------------------------------------------------

/** Bytes a path takes on disk (allocated blocks when the platform reports them, else its size). */
function diskBytes(path: string): number {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 0;
  }
  const own = typeof st.blocks === "number" && st.blocks > 0 ? st.blocks * 512 : st.size;
  if (!st.isDirectory()) return st.isFile() ? own : 0;
  let sum = 0;
  let names: string[] = [];
  try {
    names = readdirSync(path);
  } catch {}
  for (const n of names) sum += diskBytes(join(path, n));
  return sum;
}

const isPacked = (runDir: string): boolean => !needsPack(runDir);

/** A run folder with anything left to pack: a step log not yet gzipped, or a drafts copy (or its old archive) to delete. */
function needsPack(runDir: string): boolean {
  if (hasDrafts(runDir)) return true;
  try {
    return readdirSync(join(runDir, "logs")).some((n) => !n.endsWith(".gz") && !n.endsWith(".tmp"));
  } catch {
    return false;
  }
}

/**
 * An entry whose runs the queue is done with: one in a final state, except a sent-back one still waiting for its
 * chat's fix. That one is done once history's truly-final rule says so (superseded by a newer entry of its branch, or
 * git says its commit is in the target; once filed so in the history it stays so) or git says its branch or worktree
 * is gone.
 */
function doneWith(q: RunLogsQueue, entries: readonly RunLogsEntry[], e: RunLogsEntry, settled: ReadonlySet<string> | undefined): boolean {
  if (!ENTRY_FINAL.includes(e.state)) return false;
  if (e.state !== "needs-fix") return true;
  let recorded: string | undefined;
  try {
    recorded = q.store.history.recordedState(e.id);
  } catch {}
  return trulyFinal(entries, e, settled, recorded);
}

const hasDrafts = (runDir: string): boolean => existsSync(join(runDir, RUN_DRAFTS)) || existsSync(join(runDir, DRAFTS_ARCHIVE));

/** The runs the queue still uses: the one checking now, and every run an open entry, or one sent back to fix and still
 *  waiting for it (its chat reads the failure), names. A sent-back entry done for good (superseded, merged, gone) doesn't. */
function inUse(q: RunLogsQueue): { checking: Set<string>; open: Set<string> } {
  const checking = new Set<string>();
  const open = new Set<string>();
  const cur = q.currentRun()?.id;
  if (cur) checking.add(cur);
  const entries = q.entries();
  const settled = q.settled?.();
  const settledIds = settled?.size ? new Set(settled.keys()) : undefined;
  for (const e of entries) {
    if (e.state === "checking" && e.run) checking.add(e.run);
    if (!doneWith(q, entries, e, settledIds)) for (const r of [e.run, ...(e.runs ?? [])]) if (r) open.add(r);
  }
  return { checking, open };
}

/** A run whose record says it ended, and when (epoch ms); null while it runs or without a record. */
function endedAt(store: QueueStore, id: string): number | null {
  const run = store.readRun(id);
  if (!run || run.verdict === "running" || !run.endedAt) return null;
  const t = Date.parse(run.endedAt);
  return Number.isFinite(t) ? t : null;
}

/** The finished runs Clean Logs would take: past the newest RUN_LOGS_KEEP_NEWEST, not checking, no open entry's. */
function cleanableRuns(q: RunLogsQueue): string[] {
  const ids = q.store.runIds();
  const { checking, open } = inUse(q);
  const old = ids.slice(0, Math.max(0, ids.length - RUN_LOGS_KEEP_NEWEST));
  return old.filter((id) => !checking.has(id) && !open.has(id) && endedAt(q.store, id) !== null && !existsSync(join(q.store.runDir(id), CLEANED_MARK)));
}

/** What the merge thread's Run Logs chip shows. */
export function runLogsInfo(q: RunLogsQueue): RunLogsInfo {
  const ids = q.store.runIds();
  let bytes = 0;
  let packed = 0;
  for (const id of ids) {
    const d = q.store.runDir(id);
    bytes += diskBytes(d);
    if (isPacked(d)) packed++;
  }
  const clean = cleanableRuns(q);
  const cleanBytes = clean.reduce((n, id) => n + removableBytes(q.store.runDir(id)), 0);
  return { project: q.id, bytes, runs: ids.length, packed, cleanable: { runs: clean.length, bytes: cleanBytes } };
}

function removableBytes(runDir: string): number {
  let names: string[] = [];
  try {
    names = readdirSync(runDir);
  } catch {}
  return names.filter((n) => !KEPT_ON_CLEAN.has(n)).reduce((s, n) => s + diskBytes(join(runDir, n)), 0);
}

// ---- packing ------------------------------------------------------------------------------------

/** Gzip one file in place: `<f>.gz` written and renamed in, then `<f>` removed. */
async function gzipFile(file: string): Promise<void> {
  const tmp = `${file}.gz.${process.pid}.tmp`;
  writeFileSync(tmp, await gzipAsync(readFileSync(file)), { mode: 0o600 });
  renameSync(tmp, `${file}.gz`);
  unlinkSync(file);
}

/**
 * A run's drafts copy deleted, with the archive older sweeps packed it into and any half-written one. Never throws:
 * what it can't delete the next sweep does. Answers whether anything went.
 */
export function dropRunDrafts(runDir: string): boolean {
  let changed = false;
  let names: string[] = [];
  try {
    names = readdirSync(runDir);
  } catch {
    return false;
  }
  for (const n of names) {
    if (n !== RUN_DRAFTS && n !== DRAFTS_ARCHIVE && !(n.startsWith(`${DRAFTS_ARCHIVE}.`) && n.endsWith(".tmp"))) continue;
    try {
      rmSync(join(runDir, n), { recursive: true, force: true });
      changed = true;
    } catch {}
  }
  return changed;
}

/** Pack one finished run's folder: its step logs gzipped, its drafts copy deleted. Answers whether it changed. */
export async function packRun(runDir: string): Promise<boolean> {
  let changed = false;
  const logs = join(runDir, "logs");
  let names: string[] = [];
  try {
    names = readdirSync(logs);
  } catch {}
  for (const n of names) {
    if (n.endsWith(".gz")) continue;
    const f = join(logs, n);
    // A pack a stop cut short: its leftover is redone from the original.
    if (n.endsWith(".tmp")) {
      rmSync(f, { force: true });
      continue;
    }
    if (!lstatSync(f).isFile()) continue;
    await gzipFile(f);
    changed = true;
  }
  if (dropRunDrafts(runDir)) changed = true;
  return changed;
}

/**
 * Pack every finished run of the queue that ended at least `afterMs` ago (default a day), and delete the drafts copy
 * of every finished run, whatever its age or whoever names it. Never the logs of a run in use (checking, or named by
 * an entry still open or sent back and still waiting for its fix), nor anything of a run checking or not ended. Answers the runs changed; a run whose pack fails is reported and left for the next sweep.
 */
export async function sweepRunLogs(q: RunLogsQueue, o: { now?: number; afterMs?: number; log?: (s: string) => void } = {}): Promise<string[]> {
  const now = o.now ?? Date.now();
  const after = o.afterMs ?? RUN_LOGS_PACK_AFTER_MS;
  const done: string[] = [];
  await q.refreshSettled?.().catch(() => {});
  for (const id of q.store.runIds()) {
    if (!run$.test(id)) continue;
    // Read fresh before each run: one may have started meanwhile.
    const { checking, open } = inUse(q);
    if (checking.has(id)) continue;
    const ended = endedAt(q.store, id);
    if (ended === null) continue;
    const d = q.store.runDir(id);
    // An ended run's drafts copy is read by nothing, whoever names the run (one a stop cut short keeps it).
    const dropped = hasDrafts(d) && dropRunDrafts(d);
    // A run an open or sent-back entry names keeps its logs as they are: its chat was handed the plain log's path
    // (notices.ts).
    if (open.has(id) || now - ended < after || !needsPack(d)) {
      if (dropped) done.push(id);
      continue;
    }
    try {
      if ((await packRun(d)) || dropped) done.push(id);
    } catch (err) {
      if (dropped) done.push(id);
      o.log?.(`run ${id}: its logs weren't packed (${err instanceof Error ? err.message : String(err)}); the next sweep tries again`);
    }
  }
  return done;
}

// ---- cleaning -----------------------------------------------------------------------------------

/** Clean Logs: the logs and other files of every cleanable run go; each run keeps its record. */
export function cleanRunLogs(q: RunLogsQueue): RunLogsCleaned {
  let freed = 0;
  const runs = cleanableRuns(q);
  for (const id of runs) {
    const d = q.store.runDir(id);
    freed += removableBytes(d);
    writeFileSync(join(d, CLEANED_MARK), `${new Date().toISOString()}\n`, { mode: 0o600 });
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {}
    for (const n of names) if (!KEPT_ON_CLEAN.has(n)) rmSync(join(d, n), { recursive: true, force: true });
  }
  return { runs: runs.length, freed, info: runLogsInfo(q) };
}

// ---- the server's sweep -------------------------------------------------------------------------

/** Sweep every loaded queue now and every `everyMs` (default an hour) after; one sweep at a time. */
export function startRunLogSweep(o: { queues: () => Promise<RunLogsQueue[]>; everyMs?: number; log?: (s: string) => void; firstAfterMs?: number }): { stop(): void; now(): Promise<void> } {
  let running: Promise<void> | null = null;
  let stopped = false;
  const log = o.log ?? ((s: string) => console.log(`[merge-queue] ${s}`));
  const once = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      for (const q of await o.queues().catch(() => [] as RunLogsQueue[])) {
        if (stopped) return;
        const done = await sweepRunLogs(q, { log: (s) => log(`${q.id}: ${s}`) }).catch(() => [] as string[]);
        if (done.length) log(`${q.id}: packed the logs of ${done.length} finished run${done.length === 1 ? "" : "s"}`);
      }
    })().finally(() => {
      running = null;
    });
    return running;
  };
  const first = setTimeout(() => void once(), o.firstAfterMs ?? 60_000);
  const timer = setInterval(() => void once(), o.everyMs ?? 60 * 60 * 1000);
  first.unref?.();
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
    },
    now: once,
  };
}
