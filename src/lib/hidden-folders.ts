// Which folders the New Session dialog offers, and the one browser preference that widens it.
// A folder is hidden when ANY component of its path starts with "." — `~/webapps/.worktrees/sova-x`
// is hidden though its own name is not, and that is exactly the accident this exists to prevent.
// Kept free of the api module so it's testable, and modelled on summary-line.ts: the stored string
// is the whole state, so anything but "true" is the default.

import { createSignal } from "solid-js";
import { readKey, writeKey } from "./storage-keys";

export const SHOW_HIDDEN_FOLDERS_KEY = "sova:show-hidden-folders";

/** True when any component of a POSIX path starts with "." — never "." or ".." itself. Purely
    textual, so it works on a remote path the same way (a target's `$HOME` isn't ours to stat). */
export function hiddenFolder(path: string): boolean {
  return path.split("/").some((seg) => seg.startsWith(".") && seg !== "." && seg !== "..");
}

/** Off unless this browser stored exactly "true": anything else — missing, junk — is the default. */
export const parseShowHiddenFolders = (stored: string | null): boolean => stored === "true";

function readStored(): boolean {
  try {
    return parseShowHiddenFolders(readKey(localStorage, SHOW_HIDDEN_FOLDERS_KEY));
  } catch {
    // No localStorage (a test, a locked-down browser): the default, never a broken boot.
    return false;
  }
}

const [showHiddenFolders, setShow] = createSignal(readStored());
/** Read by the dialog's recent lists, the picker's listing and the picker's Recent view; written
    by any of their checkboxes, which are all this one preference. */
export { showHiddenFolders };

export function setShowHiddenFolders(on: boolean): void {
  setShow(on);
  try {
    writeKey(localStorage, SHOW_HIDDEN_FOLDERS_KEY, String(on));
  } catch {
    // Persistence is a convenience; the choice still holds for this page.
  }
}
