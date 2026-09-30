/**
 * Whether the server is shutting down (§app.organizations/wrap-up): a wrap-up turn that stops now was
 * cut off by the shutdown, not stopped for a reason of its own. A wrap-up left running by an earlier
 * process, or past its time, is the baton chart's to record failed (`sova/resumed` at open, its own
 * overdue timer): no sweeper.
 */

export const PROCESS_START = Date.now();

let stopping = false;
/** The server is shutting down (index.ts, before it aborts the turns). */
export function markShutdown(): void {
  stopping = true;
}
export const shuttingDown = (): boolean => stopping;
export function clearShutdownForTest(): void {
  stopping = false;
}
