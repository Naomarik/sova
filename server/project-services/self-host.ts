import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { activityOf, readLiveRecords, WORKING_FRESH_MS, workerCountsOf } from "../live";

/**
 * Sova hosting itself (§app.project-services/self-host): the checkout this server's code was loaded
 * from, and whether any session it hosts is busy (CLAUDE.md "Live server restart": a fresh live
 * record of this server's pid with a working subagent or a turn in flight).
 */

let checkout: string | null | undefined;

/** The git checkout the running server was loaded from, or null outside one. */
export function serverCheckout(): string | null {
  if (checkout !== undefined) return checkout;
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    checkout = top ? realpathSync(top) : null;
  } catch {
    checkout = null;
  }
  return checkout;
}

/** Why this server's hosted sessions are busy ("2 sessions busy: 1 with working subagents, 1 turn in flight"), or null when none is. */
export function hostedBusy(now = Date.now()): string | null {
  let workers = 0;
  let turns = 0;
  for (const r of readLiveRecords({ includeOwn: true })) {
    if (r.pid !== process.pid) continue;
    const beat = typeof r.rec?.heartbeat === "number" ? r.rec.heartbeat : 0;
    if (now - beat > WORKING_FRESH_MS) continue;
    if ((workerCountsOf(r.rec)?.working ?? 0) > 0) workers++;
    else if (activityOf(r.rec)?.state === "working") turns++;
  }
  if (!workers && !turns) return null;
  const parts = [...(workers ? [`${workers} with working subagents`] : []), ...(turns ? [`${turns} with a turn in flight`] : [])];
  return `${workers + turns} hosted session${workers + turns === 1 ? "" : "s"} busy: ${parts.join(", ")}`;
}
