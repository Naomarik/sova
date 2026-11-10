// The session list's write generation (§app.session-list/listing-reuse). listSessions shares one
// build between callers for a second; anything this process does that a row reads (a store write,
// a mutating request, a chat socket's message) bumps the generation, and a list built under an
// older generation is never joined, shared or kept again. A build may still keep a row of the last
// one (sessions-index.ts): most bumps also move the stores generation, which keeps none; a session
// file this server wrote and one row's own change move only the generation, and the build tells
// those by the file's stat and by the row's change number. Imports nothing, so every store can bump
// it without an import cycle through sessions-index.ts.

let generation = 0;
/** Moves with every bump but sessionFileWritten's and sessionRowChanged's: a build keeps no row past it. */
let stores = 0;
const listeners = new Set<() => void>();

/** Something a listing reads changed in this process: the next listing is built afresh, and the
    session feed compares soon (server/session-feed.ts). */
export function sessionsChanged(): void {
  stores++;
  bump();
}

/** This server wrote a session file: the same bump (no list is kept past it), except that a build
    tells the write by the file's own stat, so it still keeps the rows every other file gives. */
export function sessionFileWritten(): void {
  bump();
}

/** Something a row reads moved that tells the session feed its own way (an org statechart step, a
    mark nudge, the feed's safety net, a new feed connection), not by a bump: no row is kept past it. */
export function listInputsMoved(): void {
  stores++;
}

/** One more each time the session feed is told to compare (any of its triggers, its safety net and
    a new connection included): a kept list is dropped on each (sessions-index.ts). */
let heard = 0;
export function feedHeard(): void {
  heard++;
}
export function heardGeneration(): number {
  return heard;
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
