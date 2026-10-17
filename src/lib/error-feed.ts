// The thread's error feed (§chat.transcript/states): the banners a chat view draws as the last item of
// its thread, and the pane's turn-error state beside them. Never saved: a fresh load starts with an
// empty feed and rebuilds the thread from the transcript, where a failed turn keeps its own error in
// its row. Pure, for the unit tier; ChatView keeps the feed in a signal and does what each step says.

/** `turn`: a turn's failure the server reported (`error`, not a refusal); `note`: anything else drawn
    in that place (a transcript reload that failed, a model turned off). */
export type FeedKind = "turn" | "note";

export interface FeedEntry {
  kind: FeedKind;
  message: string;
  /** The failed turn's own model's provider, when the server said it (live error event only). */
  provider?: string;
}

export interface ErrorFeed {
  entries: readonly FeedEntry[];
  /** The pane's turn-error state (the workspace roll-up, and "replied." held back): the last turn
      ended in an error and no newer turn has started. */
  turnError: string | null;
}

/** What the view says for a step: announcements and toasts, worded by the view. */
export type FeedSay =
  | { say: "turnStopped" }
  /** The chat didn't start; `back` messages went back to the composer with it. */
  | { say: "startFailed"; back: number }
  /** Messages went back to the composer ("That message couldn't be sent…"). */
  | { say: "unsent" }
  /** A refusal's own words, as a toast and an announcement. */
  | { say: "refused"; message: string };

export interface FeedStep {
  feed: ErrorFeed;
  says: FeedSay[];
}

export const EMPTY_FEED: ErrorFeed = { entries: [], turnError: null };

/** A connection opened (before its hello). */
export const feedOnOpen = (feed: ErrorFeed): ErrorFeed => feed;

/** This connection's chat said its hello. */
export const feedOnHello = (feed: ErrorFeed): ErrorFeed => feed;

/** A newer turn started (agent_start): it supersedes the last one's failure. */
export const feedOnTurnStart = (feed: ErrorFeed): ErrorFeed => (feed.turnError === null ? feed : { ...feed, turnError: null });

/** A rewind or regenerate: the failures belonged to the turns just abandoned. */
export const feedOnReset = (): ErrorFeed => EMPTY_FEED;

/** A notice drawn where the errors are (`dedupe`: not again right after itself). */
export function feedOnNote(feed: ErrorFeed, message: string, dedupe = false): ErrorFeed {
  if (dedupe && feed.entries[feed.entries.length - 1]?.message === message) return feed;
  return { ...feed, entries: [...feed.entries, { kind: "note", message }] };
}

/**
 * The server's `error` that is a failure (not busy, config, reloaded or a refusal). `beforeHello`:
 * it came before this connection's hello (the chat didn't open); `back`: how many messages the view
 * just put back into the composer for it.
 */
export function feedOnFailure(feed: ErrorFeed, f: { message: string; provider?: string; beforeHello: boolean; back: number }): FeedStep {
  const says: FeedSay[] = f.back > 0 ? [{ say: "unsent" }] : [];
  const last = feed.entries[feed.entries.length - 1];
  // The same failure re-reported (a reconnect loop) says nothing new: keep one row, and say nothing,
  // because an announcement per retry would read as N new errors.
  if (last?.message === f.message) return { feed, says };
  return {
    feed: { entries: [...feed.entries, { kind: "turn", message: f.message, ...(f.provider ? { provider: f.provider } : {}) }], turnError: f.message },
    says: [...says, { say: "turnStopped" }],
  };
}

/** A `refused` error naming a send (its text already back in the composer). */
export function feedOnRefused(feed: ErrorFeed, r: { message: string; beforeHello: boolean }): FeedStep {
  return { feed, says: [{ say: "refused", message: r.message }] };
}

/** What the thread draws for an entry: its banner, and whether a usage limit's row may follow it. */
export interface FeedRow {
  entry: FeedEntry;
  banner: "turn" | "start" | null;
}

export const feedRows = (feed: ErrorFeed): FeedRow[] => feed.entries.map((entry) => ({ entry, banner: "turn" }));
