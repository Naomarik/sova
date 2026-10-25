// A worker chat's feed (al_3 stage 4, design §2.6): the pi events its parent's worker fold consumes,
// as the wire-1 frames its panes get (a message_end tagged with the entry it was written as), numbered
// per process and kept in a ring the server reads again after a dropped link (`feedSince`). Never a
// `message_update`: the fold used them only for liveness. It also says how the last run settled,
// under the key of the send that started it, so a parent that reattaches announces a settle once.
// A user message names the key of the send it came from (`sendKey`), and a keyed send whose message
// never ran is told as a `send_dropped` (§app.chat-processes/worker-instructions).
import { randomUUID } from "node:crypto";
import type { HarnessEvent } from "../../shared/harness";
import { WORKER_FEED_EVENTS, type WorkerCursor, type WorkerState } from "../../pi-config/extensions/subagents/worker-host.ts";

export const FEED_RING_MAX = 4000;
/** The ring's bound in bytes of JSON, oldest dropped first. */
export const FEED_RING_BYTES = 8 * 1024 * 1024;

const FED = new Set<string>(WORKER_FEED_EVENTS);

/** What the feed reads of the chat's harness: its events, and the entry a message was written as. */
export interface FeedSource {
  subscribe(fn: (event: HarnessEvent) => void): () => void;
  persistedId(handle: unknown): string | null;
}

/** Which keyed send a user message came from, and when the chat is done handing one over (server/send-keys.ts). */
export interface FeedKeys {
  keyOf(handle: unknown): string | undefined;
  onDone(fn: (key: string) => void): () => void;
}

/** The keys of delivered messages remembered, so a late `done` for one is never told as dropped. */
const SEEN_MAX = 1024;

export interface FeedFrame {
  cursor: WorkerCursor;
  event: unknown;
}

export class WorkerFeed {
  /** This process's start id: a cursor of another process is a gap. */
  readonly proc: string;
  private seq = 0;
  private readonly ring: { f: FeedFrame; bytes: number }[] = [];
  private bytes = 0;
  /** Frames waiting behind a message_end whose entry id is read one microtask later. */
  private held: (Record<string, unknown> | (() => void))[] | null = null;
  /** The entry id of the last assistant message (once read): a settle names its run's final one. */
  private lastAssistantEntry: string | null = null;
  /** Held message_ends whose entry ids are read with the hold's release. */
  private readonly unread: { event: Record<string, unknown>; handle: unknown; assistant: boolean }[] = [];
  /** The key of the last send delivered, and how many runs settled. */
  private lastKey: string | null = null;
  private settles = 0;
  private lastAssistant: { stopReason?: unknown; errorMessage?: unknown } | null = null;
  settled: WorkerState["lastSettled"] = null;
  /** Keys whose message was seen entering the context. */
  private readonly seen = new Set<string>();
  /** Keys given up on while a run was going: told before its settle, unless their message came meanwhile. */
  private readonly undelivered = new Set<string>();
  /** Between a run's start and its settle. */
  private running = false;

  constructor(
    private readonly send: (f: FeedFrame) => void,
    private readonly o: { max?: number; maxBytes?: number; proc?: string; onSettled?: () => void } = {},
  ) {
    this.proc = o.proc ?? randomUUID();
  }

  cursor(): WorkerCursor {
    return { proc: this.proc, seq: this.seq };
  }

  /** A send was delivered under `key` (a task, a steer, a follow-up): the next settle is its run's. */
  noteSend(key: string | undefined): void {
    if (key) this.lastKey = key;
  }

  /** Feed `session`'s events from now on; with `keys`, each user message names its send's key. */
  attach(session: FeedSource, keys?: FeedKeys): () => void {
    const off = session.subscribe((e) => this.onEvent(session, e, keys));
    const offDone = keys?.onDone((key) => this.done(key));
    return () => {
      off();
      offDone?.();
    };
  }

  /** Nothing more will hand `key`'s message over: unless it was seen, it never ran (told at once, or
      before the running run's settle, by which time it would have entered). */
  private done(key: string): void {
    if (this.seen.has(key)) return;
    if (this.running) this.undelivered.add(key);
    else this.out({ type: "send_dropped", sendKey: key });
  }

  private onEvent(session: FeedSource, e: HarnessEvent, keys: FeedKeys | undefined): void {
    let event = (e.frame() as { event?: unknown }).event as Record<string, unknown> & { type?: string; message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown } };
    if (!event?.type || !FED.has(event.type)) return;
    if (event.type === "agent_start") this.running = true;
    if ((event.type === "message_start" || event.type === "message_end") && event.message?.role === "user") {
      const key = keys?.keyOf((e as { handle?: unknown }).handle);
      if (key !== undefined) {
        // A copy: the frame's event can be pi's own object, which every other listener reads too.
        event = { ...event, sendKey: key };
        this.undelivered.delete(key);
        this.seen.delete(key);
        this.seen.add(key);
        if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value!);
      }
    }
    const assistant = event.type === "message_end" && event.message?.role === "assistant";
    if (assistant) {
      this.lastAssistant = event.message!;
      this.lastAssistantEntry = null;
    }
    if (event.type === "agent_settled") {
      this.running = false;
      // After the final message's entry id is read: the settle names it. Keyed sends that never ran go first.
      return this.out(() => {
        for (const key of [...this.undelivered]) this.emit({ type: "send_dropped", sendKey: key });
        this.undelivered.clear();
        this.settle();
        // The parent's record keeps this key with the settle's announcement (picked back up, it announces a settle once).
        this.emit({ ...event, settleKey: this.settled!.key, ...(this.settled!.entryId ? { settleEntryId: this.settled!.entryId } : {}) });
      });
    }
    if (event.type !== "message_end" || !("handle" in e)) return this.out(event);
    this.unread.push({ event, handle: (e as { handle?: unknown }).handle, assistant });
    if (this.held) return void this.held.push(event);
    this.held = [event];
    queueMicrotask(() => {
      for (const u of this.unread.splice(0)) {
        try {
          const id = session.persistedId(u.handle);
          if (id !== null) {
            u.event.entryId = id;
            if (u.assistant) this.lastAssistantEntry = id;
          }
        } catch {
          // untagged: the parent's fold drops nothing on reattach
        }
      }
      const out = this.held ?? [];
      this.held = null;
      for (const f of out) typeof f === "function" ? f() : this.emit(f);
    });
  }

  private out(event: Record<string, unknown> | (() => void)): void {
    if (this.held) this.held.push(event);
    else if (typeof event === "function") event();
    else this.emit(event);
  }

  private settle(): void {
    const a = this.lastAssistant;
    const outcome = a?.stopReason === "aborted" ? "aborted" : a?.errorMessage || a?.stopReason === "error" ? "error" : "success";
    this.settles++;
    this.settled = {
      key: `${this.lastKey ?? this.proc}#${this.settles}`,
      outcome,
      ...(this.lastAssistantEntry ? { entryId: this.lastAssistantEntry } : {}),
      ...(outcome === "error" ? { error: String(a?.errorMessage ?? "assistant turn failed (stopReason: error)") } : {}),
    };
    this.lastAssistant = null;
    this.o.onSettled?.();
  }

  private emit(event: unknown): void {
    const f: FeedFrame = { cursor: { proc: this.proc, seq: ++this.seq }, event };
    const bytes = JSON.stringify(f).length;
    this.ring.push({ f, bytes });
    this.bytes += bytes;
    const max = this.o.max ?? FEED_RING_MAX;
    const maxBytes = this.o.maxBytes ?? FEED_RING_BYTES;
    while (this.ring.length > max || (this.bytes > maxBytes && this.ring.length > 1)) this.bytes -= this.ring.shift()!.bytes;
    this.send(f);
  }

  /** The frames after `seq` of process `proc`, or a gap (another process, or fallen out of the ring). */
  since(proc: string, seq: number): { frames: FeedFrame[] } | { gap: true } {
    if (proc !== this.proc) return { gap: true };
    if (seq >= this.seq) return { frames: [] };
    const oldest = this.ring[0]?.f.cursor.seq ?? this.seq + 1;
    if (seq + 1 < oldest) return { gap: true };
    return { frames: this.ring.filter((r) => r.f.cursor.seq > seq).map((r) => r.f) };
  }
}
