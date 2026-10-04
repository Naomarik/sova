// The session list's write generation (§app.session-list/listing-reuse). listSessions shares one
// build between callers and reuses a finished one for a second; anything this process does that a
// row reads (a store write, a mutating request, a chat socket's message) bumps the generation, and
// a list built under an older generation is never joined or reused again. Imports nothing, so
// every store can bump it without an import cycle through sessions-index.ts.

let generation = 0;

/** Something a listing reads changed in this process: the next listing is built afresh. */
export function sessionsChanged(): void {
  generation++;
}

export function listGeneration(): number {
  return generation;
}
