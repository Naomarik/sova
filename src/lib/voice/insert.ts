// Where dictated text goes (§chat.voice/insertion): at the caret, with a space on each side where
// the neighbouring character isn't whitespace. Pure, so the spacing rules are tests; the composer
// applies the result with execCommand("insertText") when focused, else setRangeText.

export interface Range {
  start: number;
  end: number;
}

/** What recording saw when it started: the selection, and whether the box had focus. */
export interface SavedCaret extends Range {
  focused: boolean;
  /** The box's text then: a saved range only means something over the same text. */
  value: string;
}

/**
 * The range the text replaces. Focused now: the live selection. Else the one saved at record
 * start, if the box had focus then and its text hasn't changed since. Else the end.
 */
export function targetRange(value: string, live: Range & { focused: boolean }, saved: SavedCaret | null): Range {
  if (live.focused) return clamp(live, value.length);
  if (saved?.focused && saved.value === value) return clamp(saved, value.length);
  return { start: value.length, end: value.length };
}

const clamp = (r: Range, n: number): Range => {
  const start = Math.max(0, Math.min(r.start, n));
  return { start, end: Math.max(start, Math.min(r.end, n)) };
};

/** The string to insert over `range` of `value`: the transcript, trimmed, spaced from its neighbours. */
export function spacedInsert(value: string, range: Range, transcript: string): string {
  const text = transcript.trim();
  if (!text) return "";
  const before = value.slice(0, range.start);
  const after = value.slice(range.end);
  const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trail = after.length > 0 && !/^\s/.test(after) ? " " : "";
  return `${lead}${text}${trail}`;
}

/** The box after the insert, and where the caret lands (after the inserted text). */
export function splice(value: string, range: Range, inserted: string): { value: string; caret: number } {
  return { value: value.slice(0, range.start) + inserted + value.slice(range.end), caret: range.start + inserted.length };
}

export const wordCount = (text: string): number => (text.trim() ? text.trim().split(/\s+/).length : 0);
