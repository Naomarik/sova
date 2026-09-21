// The composer's Inputs trigger (§4 ".run-status"): how many user messages this chat's active
// branch holds, and what the row calls them. The pane's Inputs tab lists exactly these rows
// (src/lib/inputs.ts `inputRows`), so the count drops after a rewind — which is the point.

import type { TranscriptItem } from "../../shared/protocol";

/** User messages on the active branch: the rows the Inputs tab lists. */
export const inputCount = (items: readonly TranscriptItem[]): number =>
  items.reduce((n, it) => (it.kind === "user" ? n + 1 : n), 0);

/** "7 inputs" / "1 input": the trigger's visible text. */
export const inputsText = (n: number): string => `${n} ${n === 1 ? "input" : "inputs"}`;

/** The trigger's accessible name; singular throughout at one: "1 input in this chat — show input". */
export const showInputsLabel = (n: number): string =>
  `${inputsText(n)} in this chat — show ${n === 1 ? "input" : "inputs"}`;
