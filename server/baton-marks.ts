import { BATON_SENT_ENTRY, BATON_WRAPUP_ENTRY, type BatonSentData, type BatonSession } from "../shared/baton";
import { allBatons, batonById, sessionPathOf, setBatonMarks, wroteForIt } from "./baton";
import { readConflicts, readDecisionStore } from "./decisions";
import { onOrgAttached } from "./orgs";
import { readActiveBranch } from "./transcript";

/**
 * Rows from before the registry kept `wroteAt` and `conflict` (§app.organizations/workspace-repo)
 * get them at startup, and for an org attached later: `wroteAt` from the transcript's first message
 * by someone the session was sent to (its sent marker, before the wrap-up), `conflict` from the
 * conflict of its project that names the session. Only what a row lacks is set; a session whose
 * file isn't on this host keeps what it has.
 */

type Entry = { type?: string; customType?: string; timestamp?: string; data?: unknown };

/** When someone it was sent to first wrote, per the branch's sent markers; null when nobody has. */
export function firstWrote(row: Pick<BatonSession, "handoffs">, branch: readonly Entry[]): string | null {
  for (const e of branch) {
    if (e.type !== "custom") continue;
    if (e.customType === BATON_WRAPUP_ENTRY) break;
    if (e.customType !== BATON_SENT_ENTRY) continue;
    const by = (e.data as BatonSentData | undefined)?.by;
    if (typeof by === "string" && wroteForIt(row, by)) return e.timestamp ?? null;
  }
  return null;
}

/** Each project's conflicts by settle session id, with the area as its decisions name it. */
function conflictsByBaton(rows: readonly BatonSession[]): Map<string, { id: string; area: string }> {
  const out = new Map<string, { id: string; area: string }>();
  const seen = new Set<string>();
  for (const r of rows) {
    const k = `${r.orgId}\0${r.projectId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    try {
      const conflicts = readConflicts(r.orgId, r.projectId);
      if (!conflicts.length) continue;
      const areas = new Map(readDecisionStore(r.orgId, r.projectId).decisions.map((d) => [d.id, d.area]));
      for (const c of conflicts) if (c.batonSessionId) out.set(c.batonSessionId, { id: c.id, area: areas.get(c.a) ?? c.areaKey });
    } catch {
      // a project gone from projects.json, or an unreadable store: nothing to learn
    }
  }
  return out;
}

/** Fill in the marks every row of one workspace dir (or every row) lacks. Returns the sessions it changed. */
export async function backfillBatonMarks(dir?: string): Promise<string[]> {
  const rows = allBatons().filter((r) => (!r.wroteAt || !r.conflict) && (dir === undefined || batonById(r.sessionId)?.dir === dir));
  const conflicts = conflictsByBaton(rows.filter((r) => !r.conflict));
  const out: string[] = [];
  for (const row of rows) {
    const hit = batonById(row.sessionId);
    if (!hit) continue;
    let wroteAt: string | undefined;
    if (!row.wroteAt) {
      try {
        wroteAt = firstWrote(row, (await readActiveBranch(sessionPathOf(hit.dir, hit.row))) as Entry[]) ?? undefined;
      } catch {
        // not on this host
      }
    }
    const conflict = row.conflict ? undefined : conflicts.get(row.sessionId);
    if (!wroteAt && !conflict) continue;
    try {
      if (setBatonMarks(row.sessionId, { ...(wroteAt ? { wroteAt } : {}), ...(conflict ? { conflict } : {}) })) out.push(row.sessionId);
    } catch (err) {
      console.warn(`[baton] marks of ${row.sessionId.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/** At startup, and for each org attached after it. */
export function startBatonMarksBackfill(): void {
  const run = (dir?: string) => void backfillBatonMarks(dir).catch((err) => console.warn(`[baton] marks backfill failed: ${err instanceof Error ? err.message : String(err)}`));
  run();
  onOrgAttached((_orgId, dir) => run(dir));
}
