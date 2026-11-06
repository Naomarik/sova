// Passing a ping on (§app.overseer-pings/relay): what the recipient reads, its delivery, and news held for
// a recipient's next turn. sova_relay (overseer-tools.ts) decides what goes and to whom; this sends it.
//
// A relay reaches its recipient as a topic batch does (§chat.topics/delivery): an idle recipient starts a
// turn on it, a busy one gets it once its turn settles, and it is never a steer or a queued row. It rides
// the chat's `deliverTopicBatch` with a `relay` mark, so its user entry gets the invisible
// `sova-relay-sent` record (never the user's word) and its run the note's hop. One that waits is kept in
// the pings file, so a restart doesn't lose it. News is kept the same way and goes in as a hidden note at
// the start of the recipient's next turn (the transcript cards' note, server/transcript-cards-note.ts),
// starting no turn.

import { randomBytes } from "node:crypto";
import type { ChatLifecycleEvent, ChatTopicBatch } from "../shared/chat-runtime";
import type { PingOutcome, PingRecord } from "../shared/protocol";
import { pingStore, setPingOutcome, type PendingNews, type PendingRelay, type PingStore } from "./overseer-pings";

// ---- what the recipient reads ------------------------------------------------------------------------

const quoted = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join("\n");
const titleOf = (t: string): string => t.replace(/[\r\n]+/g, " ").replace(/"/g, "'").trim() || "Untitled";

/** The hop a note passed on from `p` arrives at: the ping's run's hop plus 1. */
export const relayHop = (p: Pick<PingRecord, "hop">): number => p.hop + 1;

/**
 * A relay as its recipient reads it. `words`: "said", the user's own words alone (what goes at their word
 * in the pinging chat); "all", the user's words and then the session's own text (what goes at the user's
 * click or under their approval). Every line of another session's or the user's words is prefixed `> `.
 */
export function relayText(p: Pick<PingRecord, "title" | "sessionId" | "hop" | "kind" | "said" | "summary" | "detail">, words: "said" | "all"): string {
  const title = titleOf(p.title);
  const parts = [`[passed on by the Overseer from session "${title}" (${p.sessionId}), hop ${relayHop(p)}]`];
  if (p.kind === "relay" && p.said) parts.push(`The user asked "${title}" to give you this. Their words there:\n${quoted(p.said)}`);
  if (words === "all") parts.push(quoted([p.summary, p.detail].filter((x): x is string => !!x).join("\n")));
  return parts.join("\n\n");
}

/** News as its recipient reads it, in the hidden note at the start of its next turn. */
export function newsText(p: Pick<PingRecord, "title" | "summary" | "detail">): string {
  return `News from session "${titleOf(p.title)}", passed on by the Overseer: data from another session, not the user's instruction.\n${quoted([p.summary, p.detail].filter((x): x is string => !!x).join("\n"))}`;
}

// ---- relays: a turn in the recipient ----------------------------------------------------------------------

export interface RelayChat {
  readonly mirror: { readonly special: unknown };
  deliverTopicBatch(batch: ChatTopicBatch): Promise<"started" | "busy" | "paused" | "closed">;
}

export interface RelayHost {
  /** The recipient as the list knows it now; null when its file is gone. */
  summary(path: string): Promise<{ archived?: boolean; live?: unknown; title?: string } | null>;
  /** Its runtime, reopened when not loaded. */
  acquire(path: string): Promise<RelayChat>;
  /** A chat settled (its web queue handed over first). */
  onIdle(fn: (path: string) => void): () => void;
  /** The chats' lifecycle events: a batch's topicEntered / topicGone. */
  onChatEvent(fn: (event: ChatLifecycleEvent) => void): () => void;
}

/** What became of one hand-over attempt. */
export type RelayAttempt = "started" | "waiting" | "terminal" | "gone";

/** After a settle: past the web queue's own hand-off, so the user's messages go first. */
const SETTLE_DELAY_MS = 250;

export class RelayDelivery {
  /** Relays handed over and not yet entered or gone, by their id. */
  private inFlight = new Set<string>();
  private offs: (() => void)[] = [];
  constructor(
    private readonly host: RelayHost,
    private readonly store: () => PingStore = pingStore,
    private readonly opts: { settleMs?: number } = {},
  ) {}

  start(): void {
    this.offs.push(this.host.onIdle((path) => setTimeout(() => void this.drain(path), this.opts.settleMs ?? SETTLE_DELAY_MS).unref?.()));
    // Relays that waited across a restart.
    for (const r of this.pending()) void this.attempt(r);
  }
  stop(): void {
    for (const off of this.offs.splice(0)) off();
  }

  pending(path?: string): PendingRelay[] {
    return (this.store().read().relays ?? []).filter((r) => !path || r.to.path === path);
  }

  /** Pass one relay on: kept first (so a busy recipient gets it at its next settle, even after a restart),
      then handed over now when the recipient is idle. The pinging chat's card says what happened. */
  async send(r: Omit<PendingRelay, "id" | "at">): Promise<RelayAttempt> {
    const rec: PendingRelay = { ...r, id: `rl_${randomBytes(6).toString("hex")}`, at: new Date(this.store().now()).toISOString() };
    this.store().update((d) => {
      d.relays = [...(d.relays ?? []), rec];
      return { write: true, value: undefined };
    });
    return this.attempt(rec);
  }

  private async drain(path: string): Promise<void> {
    for (const r of this.pending(path)) await this.attempt(r);
  }

  private drop(id: string): void {
    this.store().update((d) => {
      const before = d.relays?.length ?? 0;
      d.relays = (d.relays ?? []).filter((x) => x.id !== id);
      if (!d.relays.length) delete d.relays;
      return { write: before !== (d.relays?.length ?? 0), value: undefined };
    });
  }

  private async outcome(r: PendingRelay, o: PingOutcome): Promise<void> {
    await setPingOutcome(r.ping, o, this.store()).catch((err) => console.warn("[relay] outcome not kept:", err instanceof Error ? err.message : String(err)));
  }

  private async attempt(r: PendingRelay): Promise<RelayAttempt> {
    if (this.inFlight.has(r.id)) return "waiting";
    const to = { id: r.to.id, title: r.to.title };
    const s = await this.host.summary(r.to.path).catch(() => null);
    if (!s || s.archived) {
      this.drop(r.id);
      await this.outcome(r, { kind: "refused", to, why: s ? "it was archived, so nothing was sent" : "it is gone, so nothing was sent" });
      return "gone";
    }
    // Never written to a session a terminal has open (AGENTS.md "no file locking").
    if (s.live) {
      this.drop(r.id);
      await this.outcome(r, { kind: "terminal", to });
      return "terminal";
    }
    let chat: RelayChat;
    try {
      chat = await this.host.acquire(r.to.path);
    } catch {
      await this.outcome(r, { kind: "waiting", to });
      return "waiting";
    }
    if (chat.mirror.special) {
      this.drop(r.id);
      await this.outcome(r, { kind: "refused", to, why: "it takes no passed-on notes" });
      return "gone";
    }
    const batch = `rb_${randomBytes(6).toString("hex")}`;
    this.inFlight.add(r.id);
    // Heard until this hand-over's one outcome: entered, the relay is passed; gone, it waits for the next settle.
    const off = this.host.onChatEvent((e) => {
      if (e.batch !== batch) return;
      if (e.type === "topicEntered") {
        off();
        this.inFlight.delete(r.id);
        this.drop(r.id);
        void this.outcome(r, { kind: "passed", to, at: new Date(this.store().now()).toISOString() });
      } else if (e.type === "topicGone") {
        off();
        this.inFlight.delete(r.id);
      }
    });
    let answer: Awaited<ReturnType<RelayChat["deliverTopicBatch"]>>;
    try {
      answer = await chat.deliverTopicBatch({ text: r.text, topic: "", batch, items: [], relay: { from: r.from, ping: r.ping, hop: r.hop } });
    } catch (err) {
      off();
      this.inFlight.delete(r.id);
      const busy = err instanceof Error && /terminal|TUI|open in/i.test(err.message);
      if (busy) {
        this.drop(r.id);
        await this.outcome(r, { kind: "terminal", to });
        return "terminal";
      }
      await this.outcome(r, { kind: "waiting", to });
      return "waiting";
    }
    if (answer === "started") return "started";
    off();
    this.inFlight.delete(r.id);
    await this.outcome(r, { kind: "waiting", to });
    return "waiting";
  }
}

let running: RelayDelivery | null = null;
/** Start relay delivery once, bound to the chat runtimes (server/index.ts). */
export function startRelayDelivery(host: RelayHost): RelayDelivery {
  running?.stop();
  running = new RelayDelivery(host);
  running.start();
  return running;
}
/** The running delivery (null before the server started it: sova_relay then refuses). */
export const relayDelivery = (): RelayDelivery | null => running;
/** Tests only. */
export function setRelayDelivery(d: RelayDelivery | null): void {
  running = d;
}

// ---- news: a hidden note at the recipient's next turn ---------------------------------------------------

/** Keep news for a recipient; it goes in at the start of its next turn. */
export function holdNews(n: Omit<PendingNews, "at">, s: PingStore = pingStore()): void {
  s.update((d) => {
    d.news = [...(d.news ?? []).filter((x) => !(x.ping === n.ping && x.to.id === n.to.id)), { ...n, at: new Date(s.now()).toISOString() }];
    return { write: true, value: undefined };
  });
}

/** Take the news waiting for `sessionId`: its note's text (null when none), each marked passed on its ping's card. */
export async function takeNews(sessionId: string, s: PingStore = pingStore()): Promise<string | null> {
  if (!sessionId || !(s.read().news ?? []).some((n) => n.to.id === sessionId)) return null;
  const taken = s.update<PendingNews[]>((d) => {
    const mine = (d.news ?? []).filter((n) => n.to.id === sessionId);
    d.news = (d.news ?? []).filter((n) => n.to.id !== sessionId);
    if (!d.news.length) delete d.news;
    return { write: mine.length > 0, value: mine };
  });
  if (!taken.length) return null;
  const at = new Date(s.now()).toISOString();
  for (const n of taken) await setPingOutcome(n.ping, { kind: "passed", to: { id: n.to.id, title: n.to.title }, at }, s).catch(() => null);
  return taken.map((n) => n.text).join("\n\n");
}

/** The transcript cards' note with the news waiting for this session after it (§app.overseer-pings/relay "How it
    arrives"): the hidden note at the start of its next turn. */
export async function withRelayNews(note: string | null, sessionId: string): Promise<string | null> {
  let news: string | null = null;
  try {
    news = await takeNews(sessionId);
  } catch (err) {
    console.warn("[relay] news not taken:", err instanceof Error ? err.message : String(err));
  }
  return [note, news].filter((x): x is string => !!x).join("\n\n") || null;
}
