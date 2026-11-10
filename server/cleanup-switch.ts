// The kill switch for automatic worktree cleanup (§chat.worktrees/retirement): off by default for now, until the
// service is reworked. `SOVA_RETIRE=on` opts in; the retirement gate's own rules (only the real server) still apply.
// Off, no pass is scheduled, and the screens read only the small ledger (what retired, for Restore), never the saved
// list (`retire-pending.json`) the service writes. Nothing on disk is changed or removed.
import type { RetirementView, WorktreesSummary } from "../shared/protocol";
import { type Gate, retirementAllowed } from "./worktree-retire-gate";
import type { PendingFile } from "./worktree-retire-view";

export const CLEANUP_SWITCHED_OFF = "Automatic cleanup is switched off for now.";

/** Whether automatic cleanup may run at all: only when `SOVA_RETIRE=on`. */
export function cleanupSwitchedOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SOVA_RETIRE?.trim().toLowerCase() === "on";
}

/** An empty saved list: handed to the retirement view while off, so it never reads the file. A fresh one each call. */
export const noPending = (): PendingFile => ({ v: 1, repos: {} });

/** The read options the retirement view takes: none while on, an empty saved list while off. */
export const pendingWhileOff = (on = cleanupSwitchedOn()): { pending?: PendingFile } => (on ? {} : { pending: noPending() });

/**
 * A retirement view as the screens show it while off: nothing held or waiting, and the switch's own line unless the
 * view already says why it's off (a test copy, an install of its own: more specific, and true either way).
 */
export function viewWhileOff(v: RetirementView, on = cleanupSwitchedOn()): RetirementView {
  if (on) return v;
  const { waitingWhy: _w, lockTaken: _l, ...rest } = v;
  return { ...rest, held: [], waiting: 0, ...(v.off ? {} : { off: CLEANUP_SWITCHED_OFF, offFor: "setting" as const }) };
}

/** A new session's worktrees line while off: no held count (what retired stays, from the ledger). */
export function summaryWhileOff(s: WorktreesSummary, on = cleanupSwitchedOn()): WorktreesSummary {
  if (on || s.state !== "ok" || s.held === undefined) return s;
  const { held: _h, ...rest } = s;
  return rest;
}

/**
 * The gate a worktree row's Remove reads (and POST /api/worktrees/remove passes on): while switched off, the real
 * server is as an install where cleanup is off, so a worktree with nothing left offers Remove and the server takes it
 * through the same rule. A test copy, or one that can't tell, stays as it is.
 */
export function removeGate(gate: Gate = retirementAllowed(), on = cleanupSwitchedOn()): Gate {
  return !on && gate.on ? { on: false, offFor: "install", why: CLEANUP_SWITCHED_OFF } : gate;
}

/** POST /api/worktrees/cleanup's answer: it removes nothing either way. */
export const cleanupAnswer = (on = cleanupSwitchedOn()): string =>
  on ? "Sova retires finished worktrees on its own now. Nothing was removed." : `${CLEANUP_SWITCHED_OFF} Nothing was removed.`;
