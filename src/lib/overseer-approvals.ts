import { type Permit, permitsChipText } from "../../shared/overseer-grants";
import type { ScheduleInfo } from "../../shared/protocol";
import { canApprove } from "./schedules";

/**
 * The words of the Overseer's Approvals & Schedules (§app.overseer/approvals): the ⋯ row's note,
 * the attention dot's predicate and the triggers' spoken names. One reading of the autonomy
 * poll feeds all of them, so the dot and the note can't disagree.
 */

/** "1 approval · 2 schedules": the permits' own words, then every schedule Sova knows of. */
export function permitsAndSchedulesText(permits: readonly Permit[], schedules: readonly ScheduleInfo[]): string {
  const parts = [permitsChipText(permits)].filter(Boolean);
  if (schedules.length) parts.push(`${schedules.length} schedule${schedules.length === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** Schedules waiting for the user's approval: the ones that offer Approve Schedule (needs approval,
    or paused until approved again). A schedule that is not valid offers none, so it never counts;
    approvals and rules never do. */
export const waitingSchedules = (schedules: readonly ScheduleInfo[] | undefined): number => (schedules ?? []).filter(canApprove).length;

/** The ⋯ row's note: the most urgent thing first. "1 needs approval", else the counts, else "None". */
export function approvalsNote(permits: readonly Permit[], schedules: readonly ScheduleInfo[]): string {
  const waiting = waitingSchedules(schedules);
  if (waiting) return `${waiting} ${waiting === 1 ? "needs" : "need"} approval`;
  return permitsAndSchedulesText(permits, schedules) || "None";
}

/** ", 1 schedule needs approval" / ", 2 schedules need approval" / "": what the dot says aloud. */
export const waitingSuffix = (waiting: number): string =>
  waiting ? `, ${waiting} ${waiting === 1 ? "schedule needs" : "schedules need"} approval` : "";

/** ⋯'s accessible name: "Overseer actions, 1 schedule needs approval". */
export const overseerActionsLabel = (waiting: number): string => `Overseer actions${waitingSuffix(waiting)}`;

/** The wide head's Schedules ▾: "Approvals and schedules, 1 schedule needs approval". */
export const schedulesMenuLabel = (waiting: number): string => `Approvals and schedules${waitingSuffix(waiting)}`;
