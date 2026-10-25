// The thread's error feed (§chat.transcript/states): the banners a chat view draws as the last item of
// its thread, and the pane's turn-error state beside them. Never saved: a fresh load starts with an
// empty feed and rebuilds the thread from the transcript, where a failed turn keeps its own error in
// its row. So the live feed keeps a failure only while it is the latest word: a newer turn supersedes
// a turn's failure, and the thread then ends as a fresh load's does. Pure, for the unit tier;
// ChatView keeps the feed in a signal and does what each step says.
//
// A start that fails (an `error` before this connection's hello) is not a turn's failure: no turn
// ran. The server has already tried that start once more before saying so (server/ws.ts, the one
// quiet retry), so the view shows it at once, as one "This chat didn't start." banner however often
// the tab's reconnects fail again, and says nothing else for the messages it refused back.

/** `turn`: a turn's failure the server reported; `start`: the chat didn't start (before the
    connection's hello); `note`: anything else drawn in that place (a transcript reload that
    failed, a model turned off), which no turn supersedes. */
export type FeedKind = "turn" | "start" | "note";

export interface FeedEntry {
  kind: FeedKind;
  message: string;
  /** The failed turn's own model's provider, when the server said it (live error event only). */
  provider?: string;
  /** A start failure: how many messages went back to the composer with it. */
  back?: number;
  /** A newer turn started since: no banner, only a usage limit's row may still follow it. */
  superseded?: true;
}

export interface ErrorFeed {
  entries: readonly FeedEntry[];
  /** The pane's turn-error state (the workspace roll-up, and "replied." held back): the last turn
      ended in an error (or the chat didn't start) and no newer turn has started. */
  turnError: string | null;
  /** Messages a refusal put back before this connection's hello: the start failure that follows
      says them (lib/chat-wait: before the hello, a refusal is the chat failing to open). */
  heldBack?: number;
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

const shown = (e: FeedEntry) => !e.superseded;

/** A connection opened (before its hello): nothing it refuses back is counted yet. */
export const feedOnOpen = (feed: ErrorFeed): ErrorFeed => (feed.heldBack ? { ...feed, heldBack: 0 } : feed);

/** This connection's chat said its hello: it started. A start failure that gave nothing back has
    nothing more to say and goes; one that gave a message back stays, saying where it went, until
    a newer turn starts. */
export function feedOnHello(feed: ErrorFeed): ErrorFeed {
  const gone = feed.entries.filter((e) => e.kind === "start" && shown(e) && !e.back);
  if (!gone.length && !feed.heldBack) return feed;
  const entries = feed.entries.filter((e) => !gone.includes(e));
  return { entries, turnError: gone.some((e) => e.message === feed.turnError) ? null : feed.turnError, heldBack: 0 };
}

/** A newer turn started (agent_start): it supersedes the last turn's failure and a failed start,
    whose banners go (a failed turn keeps its own error in its row). Notes stay. */
export function feedOnTurnStart(feed: ErrorFeed): ErrorFeed {
  const stale = feed.entries.some((e) => e.kind !== "note" && shown(e));
  if (!stale && feed.turnError === null) return feed;
  return {
    ...feed,
    entries: feed.entries.map((e) => (e.kind !== "note" && shown(e) ? { ...e, superseded: true as const } : e)),
    turnError: null,
  };
}

/** A rewind or regenerate: the failures belonged to the turns just abandoned. */
export const feedOnReset = (): ErrorFeed => EMPTY_FEED;

/** A notice drawn where the errors are (`dedupe`: not again right after itself). */
export function feedOnNote(feed: ErrorFeed, message: string, dedupe = false): ErrorFeed {
  if (dedupe && feed.entries[feed.entries.length - 1]?.message === message) return feed;
  return { ...feed, entries: [...feed.entries, { kind: "note", message }] };
}

/**
 * The server's `error` that is a failure (not busy, config, reloaded or a refusal). `beforeHello`:
 * it came before this connection's hello, so the chat didn't start; `back`: how many messages the
 * view just put back into the composer for it.
 */
export function feedOnFailure(feed: ErrorFeed, f: { message: string; provider?: string; beforeHello: boolean; back: number }): FeedStep {
  if (f.beforeHello) {
    const back = (feed.heldBack ?? 0) + f.back;
    const at = feed.entries.findIndex((e) => e.kind === "start" && shown(e));
    // Failing again (the tab's reconnects): the one banner takes the newest reason, said once.
    if (at >= 0) {
      const old = feed.entries[at]!;
      const entries = feed.entries.map((e, i) => (i === at ? { ...old, message: f.message, back: (old.back ?? 0) + back } : e));
      return { feed: { entries, turnError: feed.turnError === old.message ? f.message : feed.turnError, heldBack: 0 }, says: [] };
    }
    return {
      feed: { entries: [...feed.entries, { kind: "start", message: f.message, back }], turnError: f.message, heldBack: 0 },
      says: [{ say: "startFailed", back }],
    };
  }
  const says: FeedSay[] = f.back > 0 ? [{ say: "unsent" }] : [];
  const last = feed.entries.filter(shown).at(-1);
  // The same failure re-reported (a reconnect loop) says nothing new: keep one row, and say nothing,
  // because an announcement per retry would read as N new errors.
  if (last?.message === f.message) return { feed, says };
  return {
    feed: { ...feed, entries: [...feed.entries, { kind: "turn", message: f.message, ...(f.provider ? { provider: f.provider } : {}) }], turnError: f.message },
    says: [...says, { say: "turnStopped" }],
  };
}

/** A `refused` error naming a send, whose text (`back`, 1 by default) is already back in the
    composer. Before the connection's hello it is the chat failing to open: it says nothing of its
    own, and the start failure that follows says it. After it, the refusal's own words. */
export function feedOnRefused(feed: ErrorFeed, r: { message: string; beforeHello: boolean; back?: number }): FeedStep {
  if (r.beforeHello) return { feed: { ...feed, heldBack: (feed.heldBack ?? 0) + (r.back ?? 1) }, says: [] };
  return { feed, says: [{ say: "refused", message: r.message }] };
}

/** Where a start failure's messages went, as its banner and announcement say it ("" for none). */
export const backWords = (back: number, lead = ""): string => (back <= 0 ? "" : `${lead}${back > 1 ? "Your messages are" : "Your message is"} back in the composer.`);

/** The banner an entry draws: none once superseded. */
export const feedBanner = (entry: FeedEntry): "turn" | "start" | null => (entry.superseded ? null : entry.kind === "start" ? "start" : "turn");

/** What the thread draws for an entry: its banner (none once superseded), and a usage limit's row
    after it where the failure has no thread row of its own (ChatView). */
export interface FeedRow {
  entry: FeedEntry;
  banner: "turn" | "start" | null;
}

export const feedRows = (feed: ErrorFeed): FeedRow[] =>
  feed.entries.map((entry) => ({ entry, banner: feedBanner(entry) }));
