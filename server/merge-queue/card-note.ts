// The merge queue's hidden lines (server/merge-queue/cards.ts) and the landing lines (served.ts LandingNotes),
// given with the chat's card note: every ordinary chat asks for that note at each turn, so chats started before
// the queue's cards existed hear them too. Its own module, importing nothing, so the note's ask never loads the
// queue.

/** The lead-in of the merge queue's lines in the note: a model must never read them as the user's own words. */
export const MERGE_QUEUE_NOTE_LEAD = "From Sova's merge queue (not the user's words; nothing to answer):";

/** The lead-in of the landing lines (served.ts LANDING_NOTE_LEAD, repeated here so this module imports nothing). */
export const LANDING_LINES_LEAD = "From Sova (not the user's words; nothing to answer):";

let source: ((session: string, since: string | null) => string | null) | null = null;
let landing: ((session: string) => Promise<string | null>) | null = null;

/** wire.ts at start (null at stop): where the lines come from. */
export function setMergeCardNoteSource(fn: ((session: string, since: string | null) => string | null) | null): void {
  source = fn;
}

/** wire.ts at start (null at stop): each chat's landing lines (which of its repos land through the queue). */
export function setLandingNoteSource(fn: ((session: string) => Promise<string | null>) | null): void {
  landing = fn;
}

/** The transcript cards' note with the landing lines and the merge queue's lines after it; null when none has
 *  anything. */
export async function withMergeCardNote(cards: string | null, session: string, since: string | null): Promise<string | null> {
  let mq: string | null = null;
  try {
    mq = session && source ? source(session, since) : null;
  } catch {
    mq = null;
  }
  let lines: string | null = null;
  try {
    lines = session && landing ? await landing(session) : null;
  } catch {
    lines = null;
  }
  const blocks = [cards, lines ? `${LANDING_LINES_LEAD}\n${lines}` : null, mq ? `${MERGE_QUEUE_NOTE_LEAD}\n${mq}` : null].filter((b): b is string => !!b);
  return blocks.length ? blocks.join("\n") : null;
}
