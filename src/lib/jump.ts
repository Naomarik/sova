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

/**
 * The transcript element of each session on screen, by session path. One pane per path, so this
 * is where a jump finds the right transcript in a workspace; the single-session view registers
 * here too, and anything that doesn't know a path falls back to the bare `#transcript`.
 */
const transcripts = new Map<string, HTMLElement>();

/** Called by the transcript itself: `el` on mount, null on cleanup. */
export function registerTranscript(path: string, el: HTMLElement | null): void {
  if (el) transcripts.set(path, el);
  else transcripts.delete(path);
}

/** The transcript to search: the pane for `path` when there is one, else the one on the page. */
export function transcriptRoot(path?: string | null): ParentNode | null {
  const el = path ? transcripts.get(path) : undefined;
  if (el?.isConnected) return el;
  return document.getElementById("transcript");
}

/** The rendered row for an entry id, or null when the transcript doesn't show it (compacted
    away, or a different session on screen). */
export function findEntryRow(entryId: string, root: ParentNode | null = transcriptRoot()): HTMLElement | null {
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
 * than scrolling nowhere. `path` picks the pane in a workspace; without it, the page's transcript.
 */
export function jumpToEntry(entryId: string, path?: string | null): boolean {
  const row = findEntryRow(entryId, transcriptRoot(path));
  if (!row) return false;
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  row.classList.add(JUMP_CLASS);
  setTimeout(() => row.classList.remove(JUMP_CLASS), JUMP_HIGHLIGHT_MS);
  return true;
}
