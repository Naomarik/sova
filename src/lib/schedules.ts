import type { PlaybookSchedule } from "../../shared/protocol";
import { stampTime } from "./format";

/**
 * A playbook schedule's one line, as the Playbooks dialog's row and the permits panel show it
 * (§chat.schedules/where-shown): the schedule in words, then its state.
 */

/** The state alone: "Needs approval", "Next 9:30 AM", "Paused: Changed since you approved it". */
export function scheduleStateText(s: PlaybookSchedule, now = Date.now()): string {
  switch (s.state) {
    case "needs-approval":
      return "Needs approval";
    case "active":
      return s.next ? `Next ${stampTime(s.next, now)}` : "Approved";
    case "paused":
      return `Paused: ${s.reason ?? "Not running"}`;
    case "invalid":
      return `Schedule not valid: ${s.reason ?? s.when}`;
    case "not-project":
      return s.reason ?? "Schedules run only from a project's playbooks.";
  }
}

/** The whole line: "Every 30 min · When a Claude limit resets · Needs approval". */
export function scheduleLine(s: PlaybookSchedule, now = Date.now()): string {
  if (s.state === "invalid" || s.state === "not-project" || !s.text) return scheduleStateText(s, now);
  return `${s.text} · ${scheduleStateText(s, now)}`;
}

/** Whether Approve Schedule applies (not approved yet, or paused and waiting for a new approval). */
export const canApprove = (s: PlaybookSchedule): boolean => !!s.pin && (s.state === "needs-approval" || (s.state === "paused" && !!s.id));

/** Whether Revoke Schedule applies: approved, running or paused. */
export const canRevoke = (s: PlaybookSchedule): boolean => !!s.id && (s.state === "active" || s.state === "paused");

/** "Merge captain" with its zone when the header names one. */
export const runsAsText = (s: PlaybookSchedule): string => `Runs as ${s.profileLabel ?? s.profile ?? "its profile"}${s.tz ? ` · ${s.tz} time` : ""}`;
