// A closed edit/write tool card's "+n −m" (§chat.changes/tool-card-diff). Counted off the patch the
// result recorded, and nothing else: no line diff, no word diff, no highlighting runs for a card
// nobody opened. Without a recorded patch there is no count. This module imports only the patch
// parser's counters, never the line-diff engine.

import { isStructuredPatch, patchStats } from "./diff/parse";
import { isObj, str } from "./message";

/** +n −m of an edit or write result's recorded patch (pi `details.patch`, Claude Code
    `details.structuredPatch`), or null: another tool, or no patch. */
export function summaryStats(name: string, details: unknown): { added: number; removed: number } | null {
  if ((name !== "edit" && name !== "write") || !isObj(details)) return null;
  const patch = str(details.patch);
  if (patch) return patchStats(patch);
  if (isStructuredPatch(details.structuredPatch) && details.structuredPatch.length > 0) {
    let added = 0;
    let removed = 0;
    for (const h of details.structuredPatch) for (const l of h.lines) l[0] === "+" ? added++ : l[0] === "-" && removed++;
    return { added, removed };
  }
  return null;
}
