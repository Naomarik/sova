import { BATON_WRAPUP_ENTRY } from "../shared/baton";
import type { HEntry } from "../shared/harness";
import { allBatons, batonById, sessionPathOf, setBudgetUsed } from "./baton";
import { readBranch } from "./harness/pi/reader";
import { onOrgAttached } from "./orgs";

/**
 * Messages a crash or kill lost stop counting (§app.baton/hand-off, "What can still lose a waiting
 * message"). A message counts against the limit when the runtime accepts it, before it reaches the
 * file; a kill loses the queued ones but not their count. At startup, and for an org attached
 * later (a clone taken after a kill), each open session's count becomes the messages its
 * transcript holds before the wrap-up marker, when that is fewer. It never raises a count, and a
 * session whose file isn't on this host is left alone. A graceful stop keeps its queue, so it
 * refunds nothing real.
 */

/** The user messages of a branch before the wrap-up's marker: what the budget counts. */
export function countedMessages(branch: readonly HEntry[]): number {
  let n = 0;
  for (const h of branch) {
    if (h.kind === "state" && h.key === BATON_WRAPUP_ENTRY) break;
    if (h.kind === "user") n++;
  }
  return n;
}

/** Recount every open session (of one workspace dir, or all). Returns the sessions it lowered. */
export async function recountBudgets(dir?: string): Promise<string[]> {
  const out: string[] = [];
  for (const row of allBatons()) {
    if (row.state !== "open" && row.state !== "needs-you") continue;
    const hit = batonById(row.sessionId);
    if (!hit || (dir !== undefined && hit.dir !== dir)) continue;
    const seen = hit.row.budget.messagesUsed;
    let branch: HEntry[];
    try {
      branch = await readBranch(sessionPathOf(hit.dir, hit.row));
    } catch {
      continue;
    }
    const rows = countedMessages(branch);
    if (rows >= seen) continue;
    try {
      // Only if nothing was counted meanwhile: a message accepted during the read isn't in `rows`.
      if (setBudgetUsed(row.sessionId, rows, seen)) {
        console.log(`[baton] ${row.sessionId.slice(0, 8)}: ${seen - rows} message(s) lost before a restart no longer count`);
        out.push(row.sessionId);
      }
    } catch (err) {
      console.warn(`[baton] recount of ${row.sessionId.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/** At startup, and for each org attached after it. */
export function startBudgetRecount(): void {
  const run = (dir?: string) => void recountBudgets(dir).catch((err) => console.warn(`[baton] recount failed: ${err instanceof Error ? err.message : String(err)}`));
  run();
  onOrgAttached((_orgId, dir) => run(dir));
}
