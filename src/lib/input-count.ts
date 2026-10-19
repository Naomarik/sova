// The composer's Inputs trigger: how many messages the user typed on this chat's active
// branch, and what the row calls them. The Timeline's "Inputs Only" view lists exactly
// these rows (src/lib/inputs.ts `inputRows`), so the count drops after a rewind — which is the point.

import type { TranscriptItem } from "../../shared/protocol";
import { isOwnInput, sendersOf } from "../../shared/senders";

/** The messages the user typed on the active branch: the rows that view lists. Never a fired wake
    nudge, a link message, nor a message another session, the Overseer or a teammate sent
    (shared/senders.ts `isOwnInput`, by the sender markers among `items`). */
export const inputCount = (items: readonly TranscriptItem[]): number => {
  const senders = sendersOf(items);
  return items.reduce((n, it) => (isOwnInput(it, senders) ? n + 1 : n), 0);
};

/** "7 inputs" / "1 input": the trigger's visible text. */
export const inputsText = (n: number): string => `${n} ${n === 1 ? "input" : "inputs"}`;
