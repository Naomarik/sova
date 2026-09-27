import type { BatonSession } from "../shared/baton";
import { allBatons, setWrapup } from "./baton";
import { emitBatonEvent } from "./baton-events";
import { wrapupActive } from "./baton-wrapup";
import { BATON_RUN_WALL_MS } from "./stream-guard";

/**
 * Stale wrap-up rows (§app.organizations/wrap-up). A row says `running` only while a wrap-up turn
 * runs, but the row is on disk and the run is in memory: a server that stopped mid-run leaves the
 * row `running` for good, and the strip says "Wrap-up running" forever. This records such a row
 * `failed`, at startup and every minute after, when either
 * - it was started before this process (an earlier process owned it, and no process runs it now:
 *   one server per state dir), and this process isn't running it; or
 * - it is older than any run can be: the stream guard stops a baton run at BATON_RUN_WALL_MS.
 * Never retried on its own; the operator's Retry Wrap-Up (server/wrapup-routes.ts) runs it again.
 */

export const PROCESS_START = Date.now();

let stopping = false;
/** The server is shutting down (index.ts, before it aborts the turns): a turn that stops now was
    cut off by the shutdown, not stopped for a reason of its own. */
export function markShutdown(): void {
  stopping = true;
}
export const shuttingDown = (): boolean => stopping;
export function clearShutdownForTest(): void {
  stopping = false;
}
/** Past the guard's wall clock, with room for the turn's own start and end. */
export const STALE_AFTER_MS = BATON_RUN_WALL_MS + 60_000;

export function staleReason(row: Pick<BatonSession, "sessionId" | "wrapup">, now: number, processStart = PROCESS_START): string | null {
  const w = row.wrapup;
  if (w?.state !== "running") return null;
  const at = Date.parse(w.at);
  if (!Number.isFinite(at)) return wrapupActive(row.sessionId) ? null : "Its start time couldn't be read.";
  if (now - at > STALE_AFTER_MS) return `It ran past ${Math.round(BATON_RUN_WALL_MS / 60_000)} minutes without finishing.`;
  if (at < processStart && !wrapupActive(row.sessionId)) return "The server shut down during the wrap-up.";
  return null;
}

/** Record every stale `running` wrap-up `failed`. Returns the session ids it changed. */
export function sweepStaleWrapups(now = Date.now(), processStart = PROCESS_START): string[] {
  const out: string[] = [];
  for (const row of allBatons()) {
    const error = staleReason(row, now, processStart);
    if (!error) continue;
    try {
      setWrapup(row.sessionId, { ...row.wrapup!, state: "failed", error });
      emitBatonEvent({ type: "wrapup", orgId: row.orgId, projectId: row.projectId, sessionId: row.sessionId });
      console.warn(`[baton] wrap-up of ${row.sessionId.slice(0, 8)} recorded failed: ${error}`);
      out.push(row.sessionId);
    } catch (err) {
      console.warn(`[baton] stale wrap-up of ${row.sessionId.slice(0, 8)} not recorded: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/** Sweep now and every minute. Returns the stop. */
export function startWrapupRecovery(everyMs = 60_000): () => void {
  const sweep = () => {
    try {
      sweepStaleWrapups();
    } catch (err) {
      console.warn(`[baton] wrap-up sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  sweep();
  const t = setInterval(sweep, everyMs);
  t.unref();
  return () => clearInterval(t);
}
