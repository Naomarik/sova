// The composer's Inputs trigger: how many user messages this chat's active
// branch holds, and what the row calls them. The Timeline's "Inputs Only" view lists exactly
// these rows (src/lib/inputs.ts `inputRows`), so the count drops after a rewind — which is the point.

import type { TranscriptItem } from "../../shared/protocol";
import { isInput } from "./turn";

/** User messages on the active branch: the rows that view lists. A fired wake nudge counts too
    (isInput) — it is a real user message under the hood, just rendered differently. A link message
    is not: a partner's words, never the user's input. */
export const inputCount = (items: readonly TranscriptItem[]): number =>
  items.reduce((n, it) => (isInput(it) ? n + 1 : n), 0);

/** "7 inputs" / "1 input": the trigger's visible text. */
export const inputsText = (n: number): string => `${n} ${n === 1 ? "input" : "inputs"}`;
