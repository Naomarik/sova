// Time Spent's file replay, pure: a session's attention file (<state root>/attention/<session>.jsonl)
// read into the runs it counts. Shared by the server's store (server/time-spent.ts) and the usage
// helper's reader (server/usage-helper/attention.ts), so both sum the same seconds. No imports beyond
// the wire's row list: the helper child loads it.

import { TIME_SPENT_ROWS, type TimeSpentRow } from "../shared/time-spent";

const ROWS = new Set<string>(TIME_SPENT_ROWS);

/** Counted seconds [s, e) on this computer's clock, and what they were spent on. */
export interface TimeSpentRun {
  s: number;
  e: number;
  r: TimeSpentRow;
}

/** One run line of a session's file: a run, and the alignment documents on screen during it. */
export interface TimeSpentLine extends TimeSpentRun {
  d?: readonly string[];
}

/** The file's text replayed: its runs after every take-back, and each document's first moment on screen (ms).
    A line that can't be read (a torn write) counts for nothing. */
export function replayAttention(text: string): { runs: TimeSpentLine[]; firstShown: Map<string, number> } {
  const runs: TimeSpentLine[] = [];
  const firstShown = new Map<string, number>();
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    let l: any;
    try {
      l = JSON.parse(raw);
    } catch {
      continue;
    }
    if (Array.isArray(l?.x)) {
      takeBack(runs, l.x[0], l.x[1]);
      continue;
    }
    if (!ROWS.has(l?.r) || !Number.isInteger(l.s) || !Number.isInteger(l.e) || l.e <= l.s) continue;
    runs.push(l);
    // A moment later lost to another page was still on screen: first shown stays.
    for (const d of l.d ?? []) if (!firstShown.has(d)) firstShown.set(d, l.s * 1000);
  }
  return { runs, firstShown };
}

/** Cuts [from, to) out of the runs so far. */
export function takeBack(runs: TimeSpentLine[], from: unknown, to: unknown): void {
  if (typeof from !== "number" || typeof to !== "number") return;
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i]!;
    if (r.e <= from || r.s >= to) continue;
    const pieces: TimeSpentLine[] = [];
    if (r.s < from) pieces.push({ ...r, e: from });
    if (r.e > to) pieces.push({ ...r, s: to });
    runs.splice(i, 1, ...pieces);
  }
}
