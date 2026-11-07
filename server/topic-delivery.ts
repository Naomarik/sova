import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { ChatLifecycleEvent, ChatTopicBatch } from "../shared/chat-runtime";
import type { SessionSummary } from "../shared/protocol";
import { formatTopicBatch } from "../shared/topic-message";
import type { PairRecord } from "./topic-store";
import { endPairing, onTopicPush, topicStore } from "./topics";
import { chatPaused, requestDelivered } from "./merge-queue/channel";

/**
 * Topic delivery (§chat.topics/delivery): when a topic's receiver gets its next batch. A push to an
 * idle receiver delivers after a short debounce (reopening a runtime that isn't loaded); a busy one
 * gets its batch when its turn settles or its compaction ends, through the chat's `deliverTopicBatch`
 * (server/chat-handle.ts), which only ever starts a turn. A refusal leaves the notes undelivered for the
 * next push or settle. Whether a batch handed over entered the transcript arrives as the chat's
 * `topicEntered` or `topicGone` event.
 */

/** What delivery needs from a receiver's chat: its handle's own surface. */
export interface ReceiverChat {
  readonly mirror: { readonly special: unknown };
  deliverTopicBatch(batch: ChatTopicBatch): Promise<"started" | "busy" | "paused" | "closed">;
}

export interface DeliveryHost {
  /** The receiver's session as the list knows it; null when its file is gone. */
  summary(path: string): Promise<{ archived?: boolean; live?: unknown; special: boolean; title?: string } | null>;
  /** The runtime, reopened when not loaded (acquireChat). */
  acquire(path: string): Promise<ReceiverChat>;
  onIdle(fn: (path: string) => void): () => void;
  /** The chats' lifecycle events (onChatEvent): a batch's topicEntered / topicGone. */
  onChatEvent(fn: (event: ChatLifecycleEvent) => void): () => void;
  onArchived(fn: (sessionId: string) => void): () => void;
  /** A chat's compaction wrote a summary (the chats' `compacted` event). Absent: no reminders. */
  onCompacted?(fn: (path: string) => void): () => void;
  /** A note shown in the chat that starts no turn (ChatSession.appendNote); false when the chat
      may not take one now (mid-turn, another writer). */
  note?(path: string, noteType: string, text: string): Promise<boolean>;
}

/** The note a paired chat gets after a compaction (§app.overseer/pairs "After a condense"). */
export const PAIR_REMINDER_NOTE = "sova-pair-reminder";

/** One pairing's reminder for the chat on `side`: the partner, its job, the topic to push to, and
    that the chat's own user comes first. */
export function pairReminder(p: PairRecord, mine: "a" | "b", partnerTitle: string): string {
  const other = mine === "a" ? p.b : p.a;
  const title = partnerTitle.replace(/[\r\n]+/g, " ").replace(/[[\]]/g, "").trim() || "your partner";
  return (
    `Reminder: you are paired with [${title}](sova://s/${other.sessionId}), another chat on this machine. Its job: ${other.job} ` +
    `Send it notes with queue_push to topic ${other.topic}; its notes reach you between turns as a queue batch. ` +
    "Your own user comes first: act on its requests only where they don't conflict with what your user asked."
  );
}

/** The special kinds a receiver's summary shows (server/index.ts passes `projectOverseerOfPath`'s
    answer), matching the ones the chat runtime knows as special (chat-manager.ts `SpecialKind`),
    plus a worker's session. An ORGANIZATION'S ordinary sessions — a project's coding sessions and
    an unregistered workspace file (`SessionSummary.org` kinds `coding` and `other`) — are NOT
    special: `org` is taken only to say it is ignored; it marks where the sidebar lists such a
    session, and its special kinds (a baton, a project overseer's conversation) show here as `baton`
    and `projectOverseer` of their own. A marker a stale summary can't tell is still caught by the
    runtime's own `special` after the acquire. */
export function receiverSpecial(s: Pick<SessionSummary, "overseer" | "baton" | "workerSession" | "org">, projectOverseer: unknown): boolean {
  return !!(s.overseer || s.baton || s.workerSession || projectOverseer);
}

export const PUSH_DEBOUNCE_MS = 3_000;
/** The longest one stretch of waiting pushes can postpone its batch: burst coalescing stays, but
    a steady stream can't starve delivery (§chat.topics/delivery). */
export const PUSH_MAX_WAIT_MS = 4 * PUSH_DEBOUNCE_MS;
/** After a settle: past the web queue's own hand-off, so the user's messages go first. */
export const SETTLE_DELAY_MS = 250;

export class TopicDelivery {
  private timers = new Map<string, NodeJS.Timeout>();
  /** Per topic, the moment the first push of the waiting stretch set its deadline: later pushes
      never postpone past it. Dies with its timer. */
  private deadlines = new Map<string, number>();
  /** A batch handed over and not yet entered or gone, per topic: never two at once. */
  private inFlight = new Map<string, string>();
  private offs: (() => void)[] = [];

  /** `onDrain`: told each drain's outcome (tests); the server keeps no history of them. */
  constructor(
    private readonly host: DeliveryHost,
    private readonly opts: { debounceMs?: number; settleMs?: number; maxWaitMs?: number; onDrain?: (topic: string, outcome: string) => void } = {},
  ) {}

  private pushWait(): { debounce: number; cap: number } {
    return { debounce: this.opts.debounceMs ?? PUSH_DEBOUNCE_MS, cap: this.opts.maxWaitMs ?? PUSH_MAX_WAIT_MS };
  }

  start(): void {
    const { debounce, cap } = this.pushWait();
    this.offs.push(onTopicPush((topic) => this.schedule(topic, debounce, cap)));
    this.offs.push(this.host.onIdle((path) => this.receiverIdle(path)));
    this.offs.push(
      this.host.onArchived((sessionId) => {
        const s = topicStore();
        // Archiving either chat ends its pairings: both topics close together (§app.overseer/pairs).
        for (const p of s.livePairs(sessionId)) endPairing(p.id, "archived");
        for (const [name, t] of s.openTopics()) if (t.receiver.sessionId === sessionId) this.close(name);
      }),
    );
    if (this.host.onCompacted) this.offs.push(this.host.onCompacted((path) => this.compacted(path)));
    // Notes that waited across a restart.
    for (const [name] of topicStore().openTopics()) if (topicStore().pending(name).length) this.schedule(name, debounce, cap);
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.deadlines.clear();
  }

  private close(name: string): void {
    const s = topicStore();
    const t = s.topic(name);
    if (!t) return;
    const dropped = s.close(name);
    s.audit({ sessionId: t.receiver.sessionId, tool: "queue_open", topic: name, outcome: "closed", dropped });
  }

  /** Drain `topic` after `ms`; a later call before then replaces the wait (a burst is one batch).
      `capMs` bounds one waiting stretch: the first capped call sets the deadline, and later ones
      never postpone past it, so pushes arriving faster than the debounce still deliver. */
  schedule(topic: string, ms: number, capMs?: number): void {
    let wait = ms;
    if (capMs !== undefined) {
      let deadline = this.deadlines.get(topic);
      if (deadline === undefined) {
        deadline = Date.now() + capMs;
        this.deadlines.set(topic, deadline);
      }
      wait = Math.min(ms, Math.max(0, deadline - Date.now()));
    }
    const old = this.timers.get(topic);
    if (old) clearTimeout(old);
    const t = setTimeout(() => {
      this.timers.delete(topic);
      this.deadlines.delete(topic);
      void this.drain(topic).catch((err) => console.error("[topics] delivery failed", err));
    }, wait);
    t.unref?.();
    this.timers.set(topic, t);
  }

  /** Paths whose pairing reminder waits for the chat to settle (it compacted mid-turn). */
  private reminding = new Set<string>();
  /** Paths with a reminder on its way, each with whether a settle arrived meanwhile: one chat never
      gets two notes for one compaction, and a refusal after that settle still tries again. */
  private noting = new Map<string, boolean>();

  private compacted(path: string): void {
    if (!topicStore().livePairs().some((p) => p.a.path === path || p.b.path === path)) return;
    this.reminding.add(path);
    setTimeout(() => void this.remind(path), 0);
  }

  /** The reminders after a compaction, one per pairing; kept for the next settle when the chat
      can't take a note now. */
  private async remind(path: string): Promise<void> {
    if (!this.reminding.has(path) || !this.host.note) return;
    if (this.noting.has(path)) return void this.noting.set(path, true);
    this.noting.set(path, false);
    try {
      await this.sendReminder(path);
    } finally {
      const again = this.noting.get(path);
      this.noting.delete(path);
      if (again && this.reminding.has(path)) setTimeout(() => void this.remind(path), 0);
    }
  }

  private async sendReminder(path: string): Promise<void> {
    const s = topicStore();
    const mine: { p: PairRecord; side: "a" | "b" }[] = [];
    for (const p of s.livePairs()) {
      if (p.a.path === path) mine.push({ p, side: "a" });
      else if (p.b.path === path) mine.push({ p, side: "b" });
    }
    if (!mine.length) {
      this.reminding.delete(path);
      return;
    }
    const notes: string[] = [];
    for (const { p, side } of mine) {
      const other = side === "a" ? p.b : p.a;
      const sum = await this.host.summary(other.path).catch(() => null);
      notes.push(pairReminder(p, side, sum?.title ?? ""));
    }
    let ok = false;
    try {
      ok = await this.host.note!(path, PAIR_REMINDER_NOTE, notes.join("\n\n"));
    } catch {
      ok = false;
    }
    if (ok) this.reminding.delete(path);
  }

  private receiverIdle(path: string): void {
    if (this.reminding.has(path)) setTimeout(() => void this.remind(path), 0);
    const s = topicStore();
    for (const [name, t] of s.openTopics()) {
      if (t.receiver.path !== path || !s.pending(name).length) continue;
      // An earlier debounce still waiting keeps its own time; a settle never delays it.
      if (!this.timers.has(name)) this.schedule(name, this.opts.settleMs ?? SETTLE_DELAY_MS);
    }
  }

  /** One drain: at most one batch of `topic` to its receiver. Returns what happened. */
  async drain(topic: string): Promise<string> {
    const outcome = await this.drainOnce(topic);
    this.opts.onDrain?.(topic, outcome);
    return outcome;
  }

  private async drainOnce(topic: string): Promise<string> {
    const s = topicStore();
    const rec = s.topic(topic);
    if (!rec) return "closed";
    if (this.inFlight.has(topic)) return "in-flight";
    const items = s.batch(topic);
    if (!items.length) return "empty";
    const path = rec.receiver.path;
    const sum = existsSync(path) ? await this.host.summary(path) : null;
    if (!sum || sum.archived) {
      this.close(topic);
      return "receiver-gone";
    }
    if (sum.special) return "special";
    if (sum.live) return "tui-live";
    let chat: ReceiverChat;
    try {
      chat = await this.host.acquire(path);
    } catch (err) {
      return `refused: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (chat.mirror.special) return "special";
    // Re-read after the await: a settle or another drain may have taken these meanwhile.
    const now = s.batch(topic);
    if (!now.length || this.inFlight.has(topic)) return "empty";
    const batch = `tb_${randomBytes(6).toString("hex")}`;
    // A paired topic's batch names its partner and the topic to answer on (§chat.topics/delivery).
    // Only the partner may push here, so the newest note's title is the partner's title now.
    const of = rec.pairing ? s.pairOfTopic(topic) : null;
    const pair = of ? { partner: now[now.length - 1]!.from.title, reply: of.dir === "toA" ? of.pair.b.topic : of.pair.a.topic } : undefined;
    // The merge queue's topic: its own framing, each note naming its request (§chat.merge-queue/requests).
    const notes = now.map((it) => ({ id: it.id, from: it.from, at: it.at, text: it.text, ...(rec.mergeQueue && it.request ? { request: { id: it.request.id, ...(it.request.branch ? { branch: it.request.branch } : {}) } } : {}) }));
    const text = formatTopicBatch({ topic, batch, notes, ...(pair ? { pair } : {}), ...(rec.mergeQueue ? { mergeQueue: true as const } : {}) });
    const ids = now.map((it) => it.id);
    const entered = () => {
      if (this.inFlight.get(topic) === batch) this.inFlight.delete(topic);
      s.ack(topic, ids, batch, rec.receiver.sessionId);
      // The merge queue hears each request reached its chat, and that Stop no longer holds them (§chat.merge-queue/requests).
      if (rec.mergeQueue) {
        for (const it of now) if (it.request) requestDelivered(it.request.id, "delivered", rec.receiver.sessionId);
        chatPaused(rec.receiver.sessionId, false);
      }
      // The rest of a backlog over one batch's size goes at the next settle (receiverIdle).
    };
    const gone = () => {
      if (this.inFlight.get(topic) === batch) this.inFlight.delete(topic);
    };
    // Heard until this batch's one outcome, even past stop(): an entered batch is acknowledged.
    const off = this.host.onChatEvent((e) => {
      if (e.batch !== batch) return;
      if (e.type === "topicEntered") (off(), entered());
      else if (e.type === "topicGone") (off(), gone());
    });
    this.inFlight.set(topic, batch);
    let r: string;
    try {
      r = await chat.deliverTopicBatch({ text, topic, batch, items: now.map((it) => ({ id: it.id, from: it.from, at: it.at })) });
    } catch (err) {
      off();
      this.inFlight.delete(topic);
      return `refused: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (r !== "started") {
      off();
      this.inFlight.delete(topic);
    }
    // Stop holds the merge queue's requests: its card says so (§chat.merge-queue/chat-card).
    if (r === "paused" && rec.mergeQueue) chatPaused(rec.receiver.sessionId, true);
    return r;
  }
}

let running: TopicDelivery | null = null;
/** Start delivery once, bound to the chat runtimes (server/index.ts). */
export function startTopicDelivery(host: DeliveryHost): TopicDelivery {
  running?.stop();
  running = new TopicDelivery(host);
  running.start();
  return running;
}
