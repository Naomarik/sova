import type { ScheduleInfo, SessionSummary } from "../../shared/protocol";

/** One schedule's sub-group in the Automations region (§app.session-list/automations). */
export interface AutomationGroup {
  /** The schedule's `sN`. */
  id: string;
  label: string;
  projectName: string;
  /** It wakes one session (an automation file, or a header schedule whose fires wake). */
  longRunning: boolean;
  rows: SessionSummary[];
}

/**
 * The Automations region's sub-groups: each schedule with a session to show, its rows the
 * schedule's sessions (`ScheduleInfo.sessions`, newest first) that exist here and aren't archived.
 * Pure.
 */
export function automationGroups(schedules: readonly ScheduleInfo[], sessions: readonly SessionSummary[]): AutomationGroup[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const out: AutomationGroup[] = [];
  for (const sch of schedules) {
    const rows: SessionSummary[] = [];
    for (const id of sch.sessions ?? []) {
      const s = byId.get(id);
      if (s && !s.archived && !rows.includes(s)) rows.push(s);
    }
    if (!rows.length) continue;
    out.push({
      id: sch.id,
      label: sch.title,
      projectName: sch.projectName,
      longRunning: !!sch.automation || sch.fires.some((f) => f.kind === "wake"),
      rows,
    });
  }
  return out;
}

/** What the region re-reads on: its live session ids, so a start or an archive refreshes it, not every poll. */
export const liveKey = (sessions: readonly SessionSummary[] | undefined): string =>
  (sessions ?? [])
    .filter((s) => !s.archived)
    .map((s) => s.id)
    .sort()
    .join(",");
