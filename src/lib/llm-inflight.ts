// What the sidebar reads off the session feed's `llm_inflight` frame: no longer the calls in
// flight (the sidebar's figure is the working count, src/lib/work-now.ts), but the token ring
// that rides it — the output-token load average (§app.insights/token-velocity).
// Pure presentation: the foot's Agents row, the phone bar and the spine tally all read
// `tokenVelocityView`, so the three can't disagree. No Solid here, so the tests run it bare.

import type { LlmInflight, LlmTokens } from "../../shared/protocol";

/** The windows, in minutes, newest first: the row prints their means in this order. */
export const VELOCITY_WINDOWS = [5, 15, 30] as const;
const LONGEST = 30;

export type TokenVelocityState = "complete" | "partial" | "unknown";

export interface TokenVelocityView {
  state: TokenVelocityState;
  /** Output tokens a minute over each window, in `VELOCITY_WINDOWS`' order; null while unknown. */
  perMinute: number[] | null;
  /** What the row and the phone bar print: `48k 31k 12k`, the numbers bare whatever the state;
      `–` while unknown. */
  figures: string;
  /** The title/aria-label sentence, ending in a full stop. */
  sentence: string;
  /** The ring holds a token in its last 30 minutes by `now`: only then does the sidebar tick. */
  active: boolean;
}

/**
 * A count in as few characters as it can say honestly: under 1,000 the whole number (`840`),
 * 1,000–9,999 one decimal (`8.4k`), 10,000 up no decimal (`48k`), a million up one decimal
 * (`1.2M`). Rounded to the whole token first; a figure that rounds up into the next tier is
 * printed in that tier (`9,999` → `10k`, `999,999` → `1.0M`).
 */
export function denseCount(n: number): string {
  const r = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
  if (r < 1000) return `${r}`;
  if (Math.round(r / 100) < 100) return `${(Math.round(r / 100) / 10).toFixed(1)}k`;
  if (Math.round(r / 1000) < 1000) return `${Math.round(r / 1000)}k`;
  return `${(Math.round(r / 100_000) / 10).toFixed(1)}M`;
}

/** The ring's slot `s`, 0 outside it (after its newest: nothing landed yet; before its oldest: gone). */
function slot(t: LlmTokens, s: number): number {
  const i = t.out.length - 1 - (t.end - s);
  if (i < 0 || i >= t.out.length) return 0;
  const v = t.out[i];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** A ring the view can read: anything else is unknown, never a guessed 0. */
const usable = (t: LlmTokens | undefined): t is LlmTokens =>
  !!t && Number.isFinite(t.bucketMs) && t.bucketMs > 0 && Number.isFinite(t.end) && Array.isArray(t.out);

/** The output-token means at `now` (epoch ms): for W minutes, the slots in (cur − W·60s/slot, cur]
    summed and divided by W, `cur` being the slot `now` falls in. */
export function tokenVelocityView(inflight: LlmInflight | null, now: number): TokenVelocityView {
  const t = inflight?.tokens;
  if (!usable(t)) {
    return { state: "unknown", perMinute: null, figures: "–", sentence: "Output tokens a minute: not known yet.", active: false };
  }
  const cur = Math.floor(now / t.bucketMs);
  const perSlotMin = 60_000 / t.bucketMs;
  const sumBack = (slots: number) => {
    let sum = 0;
    for (let s = cur - slots + 1; s <= cur; s++) sum += slot(t, s);
    return sum;
  };
  const perMinute = VELOCITY_WINDOWS.map((w) => sumBack(Math.round(w * perSlotMin)) / w);
  const active = sumBack(Math.round(LONGEST * perSlotMin)) > 0;
  const [a, b, c] = perMinute.map(denseCount);
  // The ring says its own coverage: the calls count's gaps are about calls, not tokens.
  const floor = t.partial === true;
  const sentence =
    `Output tokens a minute: ${floor ? "at least " : ""}${a} over the last ${VELOCITY_WINDOWS[0]} minutes, ${b} over ${VELOCITY_WINDOWS[1]}, ${c} over ${VELOCITY_WINDOWS[2]}.` +
    `${floor ? " Some calls' tokens can't be seen." : ""} Replies still being written aren't counted yet.`;
  return { state: floor ? "partial" : "complete", perMinute, figures: `${a} ${b} ${c}`, sentence, active };
}

/** Whether two pushed frames read the same, so an unchanged frame doesn't wake the sidebar. */
export function sameInflight(a: LlmInflight | null, b: LlmInflight | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.count === b.count &&
    a.approximate === b.approximate &&
    a.partial === b.partial &&
    JSON.stringify(a.gaps) === JSON.stringify(b.gaps) &&
    JSON.stringify(a.tokens ?? null) === JSON.stringify(b.tokens ?? null)
  );
}
