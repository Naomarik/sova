// Open/closed state for the sidebar's folder sections (spec/02-session-list.md §2 "Anatomy").
// A folder head is a <summary>, so every one of them can be collapsed; unlike the Archive and its
// date sections it is OPEN by default, because a folder is where the rows actually are.
//
// Pure on purpose: the rule is what a unit test can hold, and the component keeps the storage.

/** One key per region + folder. The region prefix is what keeps `~/webapps/pi-web` under Live &
    web separate from the same folder inside a group or an Archive date section. */
export const folderOpenKey = (idPrefix: string, cwd: string) => `pi-web:folder-open-${idPrefix}-${cwd}`;

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
