/**
 * The run-status row's right end (§app.overseer/confirm, §chat.alignment/chip): one cluster, in a
 * fixed order, with the Inputs trigger (or the box held for it) last. Only the cluster's first
 * part takes the auto margin, so the row has exactly two ends and nothing floats between them,
 * whichever parts are present.
 */
export type RunStatusEndPart = "running" | "cards" | "align" | "inputs" | "inputs-held";

export interface RunStatusEndItem {
  part: RunStatusEndPart;
  /** The cluster's first part: it alone pushes the cluster to the row's right end. */
  lead: boolean;
}

export function runStatusEnd(has: { running?: boolean; cards?: boolean; align?: boolean; inputs?: boolean; inputsHeld?: boolean }): RunStatusEndItem[] {
  const order: [RunStatusEndPart, boolean | undefined][] = [
    ["running", has.running],
    ["cards", has.cards],
    ["align", has.align],
    ["inputs", has.inputs],
    ["inputs-held", !has.inputs && has.inputsHeld],
  ];
  return order.filter(([, on]) => on).map(([part], i) => ({ part, lead: i === 0 }));
}
