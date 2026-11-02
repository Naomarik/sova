// The merge queue's hidden lines (server/merge-queue/cards.ts), given with the chat's card note: every ordinary
// chat asks for that note at each turn, so chats started before the queue's cards existed hear them too. Its own
// module, importing nothing, so the note's ask never loads the queue.

let source: ((session: string, since: string | null) => string | null) | null = null;

/** wire.ts at start (null at stop): where the lines come from. */
export function setMergeCardNoteSource(fn: ((session: string, since: string | null) => string | null) | null): void {
  source = fn;
}

/** The transcript cards' note with the merge queue's lines after it; null when neither has anything. */
export function withMergeCardNote(cards: string | null, session: string, since: string | null): string | null {
  let mq: string | null = null;
  try {
    mq = session && source ? source(session, since) : null;
  } catch {
    mq = null;
  }
  if (!mq) return cards;
  const block = `Merge queue:\n${mq}`;
  return cards ? `${cards}\n${block}` : block;
}
