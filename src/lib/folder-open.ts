// Open/closed state for the sidebar's folder sections (spec/02-session-list.md §2 "Anatomy").
// A folder head is a <summary>, so every one of them can be collapsed; unlike the Archive and its
// date sections it is OPEN by default, because a folder is where the rows actually are.
//
// Pure on purpose: the rule is what a unit test can hold, and the component keeps the storage.

import { dualGet, dualSet } from "./storage-keys";

/** One key per region + folder. The region prefix is what keeps the same folder under Live & web
    separate from it inside a group or an Archive date section. */
export const folderOpenKey = (idPrefix: string, cwd: string) => `sova:folder-open-${idPrefix}-${cwd}`;
/** The pre-rebrand spelling of the same key, read and mirrored while the rename bridge is open. */
export const legacyFolderOpenKey = (idPrefix: string, cwd: string) => `pi-web:folder-open-${idPrefix}-${cwd}`;

/** The stored open/closed string for a folder section (either spelling, new preferred). */
export const readFolderOpenRaw = (idPrefix: string, cwd: string): string | null =>
  dualGet(sessionStorage, folderOpenKey(idPrefix, cwd), legacyFolderOpenKey(idPrefix, cwd));

/** Remembers open/closed under BOTH spellings (storage-keys.ts: a rollback build stays current). */
export const writeFolderOpenRaw = (idPrefix: string, cwd: string, open: boolean): void =>
  dualSet(sessionStorage, folderOpenKey(idPrefix, cwd), legacyFolderOpenKey(idPrefix, cwd), open ? "1" : "0");

/** The stored choice, in the Archive's own `"1"`/`"0"` spelling. Anything else — including nothing
    stored at all — means the user has never chosen, which is not the same as having chosen open. */
export const storedFolderOpen = (raw: string | null | undefined): boolean | undefined =>
  raw === "1" ? true : raw === "0" ? false : undefined;

/**
 * Whether a folder section is open right now. It is forced open, WITHOUT changing the stored
 * choice, while a search is on (every hit has to be visible) or while it holds the selected
 * session (its `aria-current` row must not be hidden under the user) — the Archive date rule,
 * with the default flipped.
 */
export function folderOpen(input: { stored?: boolean | undefined; searching: boolean; holdsSelected: boolean }): boolean {
  return input.searching || input.holdsSelected || (input.stored ?? true);
}
