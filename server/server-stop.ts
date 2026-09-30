import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROCESS_START_MS } from "./merge-readiness";
import { stateRoot } from "./state-root";

/**
 * Workers the server's own restart ended (§app.overseer/attention-digest). Inline workers are this
 * server's children, so a restart kills them on the same signal that stops the server; the parent
 * extension records each as ended in an error ("Claude exited before expected closure (SIGTERM)",
 * "pi exited with code 143"), and the next server restores them with that ending. They are not
 * errors to bring back to the user.
 *
 * The signal is structural, never the error text: a worker row restored by this server, in its own
 * runtime, whose recorded ending is an error between the previous server's stop and this server's
 * start. The previous server writes when it began stopping to `<stateRoot>/server-stop.json`
 * (`{v: 1, pid, at}`) before anything else; this one reads it at start and deletes it, so a mark
 * never outlives the start that follows it. Without one (a crash, or a stop by a server that
 * predates the mark) the stop is taken as NO_MARK_MS before this start.
 */

/** The workers die on the stop's own signal, a moment before the mark is written. */
export const STOP_SLACK_MS = 5_000;
/** How long before this start the stop is taken to be when there is no mark. */
export const NO_MARK_MS = 30_000;

export const serverStopFile = () => join(stateRoot(), "server-stop.json");

/** The span a restart-ended worker's `endedAt` falls in (ms epoch, inclusive). */
export interface RestartWindow {
  from: number;
  to: number;
}

/** Writes this server's stop mark (index.ts shutdown, first). Best-effort: never throws. */
export function markServerStop(now = Date.now(), file = serverStopFile()): void {
  try {
    writeFileSync(file, `${JSON.stringify({ v: 1, pid: process.pid, at: now })}\n`);
  } catch (err) {
    console.warn(`[server] stop mark not written: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Reads the previous server's stop mark and deletes it: the window between its stop and `start`. */
export function takeRestartWindow(start = PROCESS_START_MS, file = serverStopFile()): RestartWindow {
  let at: number | undefined;
  try {
    const d = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; pid?: unknown; at?: unknown };
    if (d.v === 1 && d.pid !== process.pid && typeof d.at === "number" && Number.isFinite(d.at) && d.at <= start) at = d.at;
  } catch {
    // No mark, or not one we can read: the fallback below.
  }
  try {
    rmSync(file, { force: true });
  } catch (err) {
    console.warn(`[server] stop mark not deleted: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { from: at === undefined ? start - NO_MARK_MS : at - STOP_SLACK_MS, to: start };
}

let window: RestartWindow | undefined;
/** Takes the previous stop's window once, at server start (index.ts). */
export function initRestartWindow(): void {
  window = takeRestartWindow();
}
/** This server's restart window; before initRestartWindow, the no-mark fallback. */
export const restartWindow = (): RestartWindow => (window ??= { from: PROCESS_START_MS - NO_MARK_MS, to: PROCESS_START_MS });

/** Whether a live record's worker row is one the restart ended: restored, and ended in an error inside `w`. */
export function endedByRestart(row: unknown, w: RestartWindow): boolean {
  if (!row || typeof row !== "object") return false;
  const r = row as { restored?: unknown; status?: unknown; endedAt?: unknown };
  return r.restored === true && r.status === "error" && typeof r.endedAt === "number" && r.endedAt >= w.from && r.endedAt <= w.to;
}
