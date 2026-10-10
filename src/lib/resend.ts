import type { UsageResend, UsageResendReason } from "../../shared/usage/wire";
import { usd } from "./costs";
import { tokens } from "./project-overseer-view";

/**
 * The re-sent line beside a conversation's spend (§app.insights/usage-resend-display): what
 * re-sending its history to a new Claude process cost, and why. Words only; ResendLine draws them.
 */

/** Why a Claude process started (usage-record.ts LAUNCH_WHYS), in plain words. */
const WHY: Record<string, string> = {
  new: "New chat",
  "process-start": "Server restarted or chat reopened",
  reaped: "Set aside while idle (too many idle Claude chats)",
  ended: "Claude's process ended",
  model: "Model changed",
  effort: "Effort changed",
  "system-prompt": "Instructions changed",
  tools: "Tools changed",
  cwd: "Working folder changed",
  diverged: "History rewound, branched, or compacted",
  desynced: "Fell out of step with Claude",
  aborted: "A stopped turn hadn't settled",
  "tool-results": "Tool results didn't line up",
  "nothing-new": "Nothing new to send",
  "login-leaving": "Claude login changed (it was leaving)",
  "login-picked": "Claude login changed (you picked another)",
  "login-failover": "Claude login changed (limit or sign-in)",
  fork: "Forked from another chat",
  oneshot: "One-off call",
};

/** Why Claude's saved copy wasn't picked up (LAUNCH_FALLBACKS). */
const FALLBACK: Record<string, string> = {
  "login-moved": "login moved",
  "not-continuation": "the history changed since",
  "settings-changed": "settings changed",
  "memory-view": "memory mode rebuilds its history",
  "resume-failed": "picking up failed",
};

/** A reason in plain words; one the browser doesn't know shows as written. */
export function resendReasonWords(r: Pick<UsageResendReason, "why" | "fallback">): string {
  const why = WHY[r.why] ?? r.why;
  return r.fallback ? `${why}; couldn't pick up its saved copy: ${FALLBACK[r.fallback] ?? r.fallback}` : why;
}

/** Whether there is anything to show: at least one launch re-sent the history. */
export function resentAnything(r: UsageResend | undefined): r is UsageResend {
  return !!r && r.launches > 0;
}

/** The re-sends' share of the spend they sit in (0..1), or null when either has no price. */
export function resendShare(r: UsageResend, spendUsd: number): number | null {
  if (!(r.usd > 0) || !(spendUsd > 0)) return null;
  return Math.min(1, r.usd / spendUsd);
}

/** "25%", "under 1%". */
export function shareWords(share: number): string {
  const pct = Math.round(share * 100);
  return pct < 1 ? "under 1%" : `${pct}%`;
}

/** A quarter of the spend or more: the line stands out. */
export const RESEND_HIGH = 0.25;

/**
 * The collapsed line: "Re-sent history 3× · $3.12 · 25% of its spend". With no price the tokens
 * stand in for the dollars and the share is left out. `of` names the spend: "its spend", "the main thread".
 */
export function resendSummary(r: UsageResend, spendUsd: number, of: string): { text: string; high: boolean } {
  const share = resendShare(r, spendUsd);
  const amount = r.usd > 0 ? usd(r.usd) : `${tokens(r.tokens)} tokens`;
  const parts = [`Re-sent history ${r.launches}×`, amount];
  if (share !== null) parts.push(`${shareWords(share)} of ${of}`);
  return { text: parts.join(" · "), high: share !== null && share >= RESEND_HIGH };
}

/** The reasons, costliest first (dollars, then tokens). */
export function resendReasons(r: UsageResend): UsageResendReason[] {
  return [...r.reasons].sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);
}

/** One reason's row: "Instructions changed · 2× · $2.40". */
export function resendReasonLine(r: UsageResendReason): string {
  return [resendReasonWords(r), `${r.launches}×`, r.usd > 0 ? usd(r.usd) : `${tokens(r.tokens)} tokens`].join(" · ");
}

/** The last line, when some launches picked up the saved copy instead; null when none did. */
export function resumedWords(r: UsageResend): string | null {
  return r.resumed > 0 ? `Picked up Claude's saved copy instead ${r.resumed}×.` : null;
}

export const RESEND_EXPLAIN = "Each time, a new Claude process was sent the whole conversation again.";
