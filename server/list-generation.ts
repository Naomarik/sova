// The session list's write generation (§app.session-list/listing-reuse). listSessions shares one
// build between callers for a second; anything this process does that a row reads (a store write,
// a mutating request, a chat socket's message) bumps the generation, and a list built under an
// older generation is never joined or shared again. Most bumps also move the stores generation,
// which a kept listing compares; a session file this server wrote and one row's own change move
// only the generation, and the kept listing tells those by the file's stat and by the row's change
// number. Imports nothing, so every store can bump it without an import cycle through sessions-index.ts.

let generation = 0;
/** Moves with every bump but sessionFileWritten's: what a kept listing compares (sessions-index.ts). */
let stores = 0;
const listeners = new Set<() => void>();

/** Something a listing reads changed in this process: the next listing is built afresh, and the
    session feed compares soon (server/session-feed.ts). */
export function sessionsChanged(): void {
  stores++;
  bump();
}

/** This server wrote a session file: the same bump, except that a listing which compares every
    session file's own stat (sessions-index's kept listing) tells the write by that stat, so it
    doesn't count against keeping the rows every other file gives. */
export function sessionFileWritten(): void {
  bump();
}

/** Something a row reads moved that tells the session feed its own way (an org statechart step, a
    mark nudge), not by a bump: no listing within its second
    is built afresh for it, as before, but no row is kept past it. */
export function listInputsMoved(): void {
  stores++;
}

/** The generation every bump but a session file write or one row's change moves. */
export function storesGeneration(): number {
  return stores;
}

/** One more per sessionRowChanged; each path's newest number. */
let rowSeq = 0;
const rowChanges = new Map<string, number>();

/** Something only the row of the session file `path` reads changed in this process (its merge
    readiness answer): the same bump, except that a listing which keeps rows (sessions-index.ts)
    builds only this one again. */
export function sessionRowChanged(path: string): void {
  rowChanges.set(path, ++rowSeq);
  bump();
}

/** The number of the last row change: a later one names a row changed since. */
export function rowChangeSeq(): number {
  return rowSeq;
}

/** Whether the row of `path` changed after `seq` (a rowChangeSeq taken earlier). */
export function rowChangedSince(path: string, seq: number): boolean {
  return (rowChanges.get(path) ?? 0) > seq;
}

function bump(): void {
  generation++;
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.error("[list-generation] listener failed", err);
    }
  }
}

/** Hear every bump (the session feed). Listeners must be cheap: a bump can come per frame. */
export function onSessionsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function listGeneration(): number {
  return generation;
}
