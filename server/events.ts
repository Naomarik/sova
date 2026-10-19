// Sova's own event stream (§app/events): the hub behind /ws/events (server/events-ws.ts).
//
// One hub per server. It numbers what it records (`seq`), keeps the newest entries in a ring (at most
// RING_MAX of them and RING_BYTES of their JSON) and hands each new one to every subscriber. Its
// sources:
//   - the chats this server runs (`onChatEvent`: `started` → turn.started, `settled` → turn.ended,
//     source "hosted"; server/chat-handle-remote.ts re-emits each relayed event once);
//   - the session feed's own list reads (server/session-feed.ts), through `seeList`, which index.ts
//     puts around the feed's list function: the hub never reads the list itself;
//   - the attention digest's memo drops (server/attention-memo.ts) → attention.changed, coalesced.
//
// Nothing runs while no one listens: asleep, the hub has no listener, no feed client and no timer.
// The first subscriber wakes it; LINGER_MS after the last one leaves it sleeps again. A wake
// records a one-seq `gap unobserved` marker in the ring, at its own position, so a cursor from before
// the sleep resumes in seq order and learns where it may have missed something.
import { randomBytes } from "node:crypto";
import { diffSessions, indexSessions, type WatchedSession } from "../shared/commands-watch";
import { STREAM_ID_RE, type CommandFrame, type EventsServerFrame, type GapFrame, type StreamEvent, type StreamEventBody } from "../shared/events";

export const RING_MAX = 1000;
export const RING_BYTES = 1024 * 1024;
export const LINGER_MS = 30_000;
export const ATTENTION_MS = 250;

/** One recorded entry: an event, or a wake's unobserved marker. Serialized once. */
export interface Entry {
  seq: number;
  json: string;
  bytes: number;
  /** A command frame (announce): seq 0, never kept; a socket's queue drops these first. */
  command?: true;
}

/** What a list row gives the observed diff (structural: SessionSummary fits). */
export interface ListedRow {
  id: string;
  path: string;
  title: string;
  archived: boolean;
  tags?: WatchedSession["tags"];
  activity?: { state: string };
}

export interface EventSources {
  /** The chats' lifecycle events (chat-handle onChatEvent). */
  onChatEvent(fn: (e: { chatId: string; type: string }) => void): () => void;
  /** The attention digest's memo drops (attention-memo onAttentionNotified). */
  onAttention(fn: () => void): () => void;
  /** Hold the session feed's loop running as one client does; null when there is no feed. */
  holdFeed(): (() => void) | null;
  /** Does this server hold the session's chat (its turns are hosted events)? */
  isHosted(path: string): boolean;
  idOf(path: string): string;
}

export interface HubOptions {
  now?: () => number;
  lingerMs?: number;
  attentionMs?: number;
  ringMax?: number;
  ringBytes?: number;
  log?: (line: string) => void;
}

export interface Subscriber {
  /** A new entry, in seq order. Must not throw (the hub guards it anyway). */
  deliver(entry: Entry): void;
  /** It asked for command frames (`?with=command.ran`, §app.command-audit/record). */
  commands?: true;
}

/** A resume cursor, as a socket's query gives it. */
export interface Cursor {
  stream: string;
  since: number;
}

/** `?stream=&since=`: none, a cursor, or why it is refused. Shape only; the hub checks the rest. */
export function cursorOf(search: URLSearchParams): { cursor: Cursor | null } | { error: string } {
  const stream = search.get("stream");
  const since = search.get("since");
  if (stream === null && since === null) return { cursor: null };
  if (stream === null || since === null) return { error: "A resume names both stream and since." };
  if (!STREAM_ID_RE.test(stream)) return { error: "stream is not a stream id." };
  if (!/^(0|[1-9][0-9]{0,15})$/.test(since) || !Number.isSafeInteger(Number(since))) return { error: "since is not a whole number." };
  return { cursor: { stream, since: Number(since) } };
}

const RUNNING = new Set(["working", "needs-input"]);

export class EventHub {
  readonly stream: string;
  private seq = 0;
  private readonly ring: Entry[] = [];
  private ringBytes = 0;
  private readonly subs = new Set<Subscriber>();
  private awake = false;
  private offs: (() => void)[] = [];
  private baseline: Map<string, WatchedSession> | null = null;
  private linger: ReturnType<typeof setTimeout> | null = null;
  private attention: ReturnType<typeof setTimeout> | null = null;
  private lastErrorLog = 0;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(
    private readonly sources: EventSources,
    private readonly o: HubOptions = {},
  ) {
    this.stream = randomBytes(8).toString("hex");
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((l) => console.warn(`[events] ${l}`));
  }

  get running(): boolean {
    return this.awake;
  }

  get subscribers(): number {
    return this.subs.size;
  }

  /** How many subscribers asked for command frames (none: announce() has nothing to do). */
  get commandListeners(): number {
    if (!this.awake) return 0;
    let n = 0;
    for (const s of this.subs) if (s.commands) n++;
    return n;
  }

  /** The newest seq given out, and the oldest kept. */
  hello(): EventsServerFrame & { type: "hello" } {
    return { type: "hello", stream: this.stream, seq: this.seq, oldest: this.ring[0]?.seq ?? this.seq + 1 };
  }

  /**
   * A new subscriber: wakes the hub if asleep, then returns its hello and the frames a resume
   * replays (in seq order), or the reason its cursor is refused. Entries recorded from here on reach
   * `sub.deliver`.
   */
  subscribe(sub: Subscriber, cursor: Cursor | null): { hello: string; replay: Entry[]; leave: () => void } | { error: string } {
    if (cursor && cursor.stream === this.stream && cursor.since > this.seq) return { error: "since is ahead of this stream." };
    if (this.linger) {
      clearTimeout(this.linger);
      this.linger = null;
    }
    if (!this.awake) this.wake();
    const replay: Entry[] = [];
    if (cursor) {
      if (cursor.stream !== this.stream) {
        replay.push(entryOf(0, { type: "gap", reason: "restarted" }));
        replay.push(...this.ring);
      } else {
        const oldest = this.ring[0]?.seq ?? this.seq + 1;
        if (cursor.since < oldest - 1) replay.push(entryOf(oldest - 1, { type: "gap", reason: "evicted", from: cursor.since + 1, to: oldest - 1 } satisfies GapFrame));
        for (const e of this.ring) if (e.seq > cursor.since) replay.push(e);
      }
    }
    this.subs.add(sub);
    let left = false;
    return {
      hello: JSON.stringify(this.hello()),
      replay,
      leave: () => {
        if (left) return;
        left = true;
        this.subs.delete(sub);
        if (this.subs.size === 0) this.lingerThenSleep();
      },
    };
  }

  /**
   * The feed's list read, seen: diffed against the last when awake. Always returns `list` unchanged
   * and never throws, so nothing here can stop the browser's feed.
   */
  seeList = <T extends readonly ListedRow[]>(list: T): T => {
    if (!this.awake) return list;
    try {
      this.observe(list);
    } catch (err) {
      this.warn(`list diff failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return list;
  };

  /** Record an event: numbered, kept, handed to every subscriber. */
  record(body: StreamEventBody): void {
    const seq = ++this.seq;
    this.keep(entryOf(seq, { type: "event", seq, at: this.now(), ...body } as StreamEvent));
  }

  /**
   * A command frame, to the subscribers that asked for them only: not numbered, not kept, never
   * replayed, so every other subscriber, the ring and the seqs are as if it never happened. Asleep,
   * nothing.
   */
  announce(frame: CommandFrame): void {
    if (!this.awake) return;
    let entry: Entry | null = null;
    for (const s of this.subs) {
      if (!s.commands) continue;
      entry ??= { ...entryOf(0, frame), command: true };
      try {
        s.deliver(entry);
      } catch (err) {
        this.warn(`a subscriber failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Stop for good (tests, shutdown). */
  close(): void {
    for (const s of [...this.subs]) this.subs.delete(s);
    if (this.linger) clearTimeout(this.linger);
    this.linger = null;
    this.sleep();
  }

  private keep(entry: Entry): void {
    this.ring.push(entry);
    this.ringBytes += entry.bytes;
    const max = this.o.ringMax ?? RING_MAX;
    const maxBytes = this.o.ringBytes ?? RING_BYTES;
    while (this.ring.length > max || (this.ringBytes > maxBytes && this.ring.length)) this.ringBytes -= this.ring.shift()!.bytes;
    for (const s of this.subs) {
      try {
        s.deliver(entry);
      } catch (err) {
        this.warn(`a subscriber failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private wake(): void {
    this.awake = true;
    const seq = ++this.seq;
    this.keep(entryOf(seq, { type: "gap", reason: "unobserved", from: seq, to: seq } satisfies GapFrame));
    const guard =
      <A extends unknown[]>(what: string, fn: (...a: A) => void) =>
      (...a: A) => {
        try {
          fn(...a);
        } catch (err) {
          this.warn(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
    this.offs.push(
      this.sources.onChatEvent(
        guard("a chat event", (e) => {
          if (e.type !== "started" && e.type !== "settled") return;
          this.record({ name: e.type === "started" ? "turn.started" : "turn.ended", source: "hosted", id: this.sources.idOf(e.chatId), path: e.chatId });
        }),
      ),
    );
    this.offs.push(this.sources.onAttention(guard("an attention note", () => this.attentionSoon())));
    const release = this.sources.holdFeed();
    if (release) this.offs.push(release);
  }

  private sleep(): void {
    this.awake = false;
    for (const off of this.offs.splice(0)) off();
    this.baseline = null;
    if (this.attention) clearTimeout(this.attention);
    this.attention = null;
  }

  private lingerThenSleep(): void {
    if (this.linger || !this.awake) return;
    this.linger = setTimeout(() => {
      this.linger = null;
      if (this.subs.size === 0) this.sleep();
    }, this.o.lingerMs ?? LINGER_MS);
    this.linger.unref?.();
  }

  private attentionSoon(): void {
    if (this.attention) return;
    this.attention = setTimeout(() => {
      this.attention = null;
      if (this.awake) this.record({ name: "attention.changed" });
    }, this.o.attentionMs ?? ATTENTION_MS);
    this.attention.unref?.();
  }

  private observe(list: readonly ListedRow[]): void {
    // `busy` here means "a turn the list sees and no hosted event covers": a terminal session's live
    // record says it is working or waiting on a dialog, and this server doesn't hold its chat.
    const rows: WatchedSession[] = list.map((s) => ({
      id: s.id,
      path: s.path,
      title: s.title,
      archived: s.archived,
      busy: RUNNING.has(s.activity?.state ?? "") && !this.sources.isHosted(s.path),
      ...(s.tags ? { tags: s.tags } : {}),
    }));
    const before = this.baseline;
    this.baseline = indexSessions(rows);
    if (!before) return;
    for (const w of diffSessions(before, rows)) {
      const at = { id: w.id, path: w.path, source: "observed" as const };
      if (w.event === "created") this.record({ name: "session.created", ...at, title: w.title ?? "" });
      else if (w.event === "removed") this.record({ name: "session.removed", ...at });
      else if (w.event === "renamed") this.record({ name: "session.renamed", ...at, from: w.from ?? "", title: w.title ?? "" });
      else if (w.event === "tagged") this.record({ name: "session.tagged", ...at, tags: w.tags ?? null });
      else if (w.event === "archived") this.record({ name: "session.archived", ...at, archived: w.archived ?? false });
      else this.record({ name: w.event, ...at });
    }
  }

  private warn(line: string): void {
    const t = this.now();
    if (t - this.lastErrorLog < 60_000) return;
    this.lastErrorLog = t;
    this.log(line);
  }
}

function entryOf(seq: number, frame: EventsServerFrame): Entry {
  const json = JSON.stringify(frame);
  return { seq, json, bytes: Buffer.byteLength(json) };
}

let shared: EventHub | null = null;

/** The server's one hub, made at startup (index.ts) with the real sources. */
export function startEvents(sources: EventSources, o?: HubOptions): EventHub {
  shared?.close();
  shared = new EventHub(sources, o);
  return shared;
}

export const eventHub = (): EventHub | null => shared;
