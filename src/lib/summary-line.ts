// Whether session rows show their summary line (§12 "General"). This browser's, not the machine's:
// the outline is still written, still in the row's data, and still in the session's own Outline —
// only the sidebar stops drawing line 2 (and the topic count that rides on it).

import { createSignal } from "solid-js";
import { dualGet, dualSet } from "./storage-keys";

export const SHOW_SUMMARIES_KEY = "sova:show-summaries";
/** The pre-rebrand spelling, mirrored while the rename bridge is open (storage-keys.ts). */
export const LEGACY_SHOW_SUMMARIES_KEY = "pi-web:show-summaries";

/** On unless this browser stored exactly "false": anything else — missing, junk — is the default. */
export const parseShowSummaries = (stored: string | null): boolean => stored !== "false";

function readStored(): boolean {
  try {
    return parseShowSummaries(dualGet(localStorage, SHOW_SUMMARIES_KEY, LEGACY_SHOW_SUMMARIES_KEY));
  } catch {
    // No localStorage (a test, a locked-down browser): the default, never a broken boot.
    return true;
  }
}

const [showSummaries, setShow] = createSignal(readStored());
/** Read by the sidebar's rows; written only from §12's General tab. */
export { showSummaries };

export function setShowSummaries(on: boolean): void {
  setShow(on);
  try {
    dualSet(localStorage, SHOW_SUMMARIES_KEY, LEGACY_SHOW_SUMMARIES_KEY, String(on));
  } catch {
    // Persistence is a convenience; the choice still holds for this page.
  }
}
