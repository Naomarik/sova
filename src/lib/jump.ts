// Jumping to a session entry in the transcript on screen. The thread renders each entry as
// `<div class="entry" data-entry="<id>">`, and an assistant entry's blocks as `<id>:<i>`, so an
// id resolves either to its own row or to the first row of the entry it belongs to. The outline
// strip, the Skills tab and the Timeline's input rows all land here.

/** How long the row we landed on stays tinted. */
export const JUMP_HIGHLIGHT_MS = 1500;
/** The tint's class, on the landed-on row. */
export const JUMP_CLASS = "entry-jumped";

const escape = (id: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&"));

/**
 * The selectors to try, in order: the entry's own rows, then — for a block id like `<id>:2` —
 * the rows of the entry it came from. A transcript that shows the entry but not that block
 * still answers the jump.
 */
export function entrySelectors(entryId: string): string[] {
  const one = (id: string) => `[data-entry="${escape(id)}"], [data-entry^="${escape(id)}:"]`;
  const i = entryId.indexOf(":");
  return i < 0 ? [one(entryId)] : [one(entryId), one(entryId.slice(0, i))];
}

/** The rendered row for an entry id, or null when the transcript doesn't show it (compacted
    away, or a different session on screen). */
export function findEntryRow(entryId: string, root: ParentNode | null = document.getElementById("transcript")): HTMLElement | null {
  if (!root) return null;
  for (const selector of entrySelectors(entryId)) {
    const wrap = root.querySelector<HTMLElement>(selector);
    const row = wrap?.firstElementChild as HTMLElement | null;
    if (row) return row;
  }
  return null;
}

/**
 * Scroll the entry's row into the middle of the transcript and tint it briefly, so the eye can
 * find where it landed. Returns false when the transcript has no such row: callers say so rather
 * than scrolling nowhere.
 */
export function jumpToEntry(entryId: string): boolean {
  const row = findEntryRow(entryId);
  if (!row) return false;
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  row.classList.add(JUMP_CLASS);
  setTimeout(() => row.classList.remove(JUMP_CLASS), JUMP_HIGHLIGHT_MS);
  return true;
}
