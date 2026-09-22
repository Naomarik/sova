// The sidebar's Recent region (spec/02-session-list.md §2 "Recent") and the one preference behind
// it: how many rows it shows.
//
// Recent is a SHORTCUT, not a region in the pane rule's sense. It is additive the way a group is:
// every session it lists is still in Live & web or the Archive underneath, so nothing here decides
// where a session lives — only which few rows get said twice, at the top, because they are the
// ones the user is most likely to want back.
//
// The pure part (the rule, the order, the count validation) runs under tsx --test; the signal at
// the bottom is this tab's copy of the preference, shared by the sidebar and the Settings dialog.

import { createSignal } from "solid-js";
import type { SessionSummary } from "../../shared/protocol";
import { dualGet, dualSet } from "./storage-keys";

/** §12 "General": the count lives in localStorage, like the theme. It is this browser's, not the
    machine's — there is no server endpoint for it, and the server list is unchanged by it. */
export const RECENT_COUNT_KEY = "sova:recent-count";
/** The pre-rebrand spelling, read and mirrored while the rename bridge is open (storage-keys.ts). */
export const LEGACY_RECENT_COUNT_KEY = "pi-web:recent-count";

/** Enough rows to be worth a region, few enough that Groups and Live & web stay above the fold. */
export const DEFAULT_RECENT_COUNT = 5;
/**
 * Below 3 the region stops being a list and starts being a single row with neighbours, which the
 * open session alone can fill — so 3 is the floor, enforced here rather than by the input's `min`
 * (a typed value, a pasted one and a hand-edited localStorage all arrive past the spinner).
 */
export const MIN_RECENT_COUNT = 3;
/** The ceiling is practical, not principled: past this the shortcut is just the list again. */
export const MAX_RECENT_COUNT = 20;

/**
 * The whole number a stored or typed value states, or null when it states none.
 *
 * ONE parse, shared by the rule, the validator and the field's error copy, because they disagreed
 * the moment there were two: an empty field is `Number("") === 0`, so the panel's own copy called
 * a blank box "fewer than 3" and offered the floor as the fix for a box with nothing in it.
 * "Says no number" and "says a number we won't take" are different answers, and only a parse that
 * returns null for the first can tell them apart.
 */
export function parseRecentCount(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isInteger(n) ? n : null;
}

/**
 * The count a stored or typed value means. Anything that isn't a whole number is not a smaller
 * mistake than a missing value — `"4.7"`, `"abc"`, `null` and a hand-edited `{"n":5}` all mean
 * "no usable choice", which is `DEFAULT_RECENT_COUNT`. A value that IS a whole number but out of
 * range is clamped instead: the user meant "more" or "fewer" and said so badly.
 */
export function normalizeRecentCount(raw: unknown): number {
  const n = parseRecentCount(raw);
  if (n === null) return DEFAULT_RECENT_COUNT;
  return Math.min(MAX_RECENT_COUNT, Math.max(MIN_RECENT_COUNT, n));
}

/**
 * Whether a count the user is typing is one we'd accept as typed — i.e. `normalizeRecentCount`
 * would hand it straight back. The field uses this to say what's wrong BEFORE clamping, so
 * "2" gets an answer ("3 is the fewest") rather than silently becoming 3 under the caret.
 */
export const recentCountValid = (raw: unknown): boolean => {
  const n = parseRecentCount(raw);
  return n !== null && n >= MIN_RECENT_COUNT && n <= MAX_RECENT_COUNT;
};

/**
 * Whether a session may appear in Recent: it must not be archived. Deliberately NOT
 * `isTopSession` — a session you ran in a TUI last week and closed is exactly what this region is
 * for, and the pane rule would file it under the Archive and hide it from here. Archiving is the
 * user saying "done with this", and Recent is the one region that has to honour that: an archived
 * session that keeps reappearing at the top is the archive gesture not working.
 *
 * A server that predates `archived` sends none, which counts as not archived (protocol.ts).
 */
export const recentEligible = (s: Pick<SessionSummary, "archived">): boolean => s.archived !== true;

/**
 * Recent's order: most recently ACTIVE first.
 *
 * `lastActiveAt` is the session file's mtime — the only activity signal the list carries. It moves
 * when anything writes to the session (a reply, a tool result, an outline snapshot), which is what
 * "recently active" should mean, but it is not a record of when the USER was last here: a
 * background subagent turn moves it too, and so does a `touch`. That limitation is the honest
 * ceiling of this region and it is deliberately not worked around here.
 *
 * Ties are broken by `createdAt` (newer first), then by `id` (ascending), so two sessions written
 * in the same millisecond have ONE order and it is the same on every poll and in every tab.
 */
export function byRecentActivity(a: SessionSummary, b: SessionSummary): number {
  return b.lastActiveAt.localeCompare(a.lastActiveAt) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
}

/**
 * The rows the Recent region shows: the eligible sessions of `sessions`, most recently active
 * first, capped at `count`.
 *
 * `sessions` is the caller's already-filtered list — the sidebar passes its search hits, so Recent
 * narrows with everything else and can never show a row the search has ruled out. The count is
 * normalized here too: this function is the region, and a caller holding a bad number must not be
 * able to produce a 0-row or 500-row Recent.
 */
export function recentSessions(sessions: readonly SessionSummary[], count: unknown): SessionSummary[] {
  return sessions.filter(recentEligible).sort(byRecentActivity).slice(0, normalizeRecentCount(count));
}

// ---------------------------------------------------------------------------
// This tab's copy of the preference
// ---------------------------------------------------------------------------

function readStoredCount(): number {
  try {
    return normalizeRecentCount(dualGet(localStorage, RECENT_COUNT_KEY, LEGACY_RECENT_COUNT_KEY));
  } catch {
    // A blocked or full localStorage means the default, never a broken boot.
    return DEFAULT_RECENT_COUNT;
  }
}

const [recentCount, setCount] = createSignal(readStoredCount());
/** How many rows Recent shows right now. Read by the sidebar; written only from §12's General tab. */
export { recentCount };

/** Stores the count and moves the region in the same tick. Out-of-range input is clamped, so this
    never stores a value `recentSessions` would have to repair on every render. */
export function setRecentCount(value: unknown): number {
  const n = normalizeRecentCount(value);
  setCount(n);
  try {
    dualSet(localStorage, RECENT_COUNT_KEY, LEGACY_RECENT_COUNT_KEY, String(n));
  } catch {
    // Persistence is a convenience; the choice still holds for this page.
  }
  return n;
}
