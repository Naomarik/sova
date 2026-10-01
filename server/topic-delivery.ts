import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { formatTopicBatch } from "../shared/topic-message";
import type { TopicBatchMark } from "./chat-manager";
import { onTopicPush, topicStore } from "./topics";

/**
 * Topic delivery (§chat.topics/delivery): when a topic's receiver gets its next batch. A push to an
 * idle receiver delivers after a short debounce (reopening a runtime that isn't loaded); a busy one
 * gets its batch when its turn settles or its compaction ends, through `ChatSession.deliverTopicBatch`,
 * which only ever starts a turn. A refusal leaves the notes undelivered for the next push or settle.
 */

/** What delivery needs from a receiver's runtime: ChatSession's own surface. */
export interface ReceiverChat {
  special: unknown;
  deliverTopicBatch(mark: TopicBatchMark): "started" | "busy" | "paused" | "closed";
}

export interface DeliveryHost {
  /** The receiver's session as the list knows it; null when its file is gone. */
  summary(path: string): Promise<{ archived?: boolean; live?: unknown; special: boolean } | null>;
  /** The runtime, reopened when not loaded (acquireChat). */
  acquire(path: string): Promise<ReceiverChat>;
  onIdle(fn: (path: string) => void): () => void;
  onArchived(fn: (sessionId: string) => void): () => void;
}

export const PUSH_DEBOUNCE_MS = 3_000;
/** After a settle: past the web queue's own hand-off, so the user's messages go first. */
export const SETTLE_DELAY_MS = 250;

export class TopicDelivery {
  private timers = new Map<string, NodeJS.Timeout>();
  /** A batch handed over and not yet entered or gone, per topic: never two at once. */
  private inFlight = new Map<string, string>();
  private offs: (() => void)[] = [];
  /** Tests: the outcome of each drain, for assertions. */
  readonly log: { topic: string; outcome: string }[] = [];

  constructor(
    private readonly host: DeliveryHost,
    private readonly opts: { debounceMs?: number; settleMs?: number } = {},
  ) {}

  start(): void {
    this.offs.push(onTopicPush((topic) => this.schedule(topic, this.opts.debounceMs ?? PUSH_DEBOUNCE_MS)));
    this.offs.push(this.host.onIdle((path) => this.receiverIdle(path)));
    this.offs.push(
      this.host.onArchived((sessionId) => {
        const s = topicStore();
        for (const [name, t] of s.openTopics()) if (t.receiver.sessionId === sessionId) this.close(name);
      }),
    );
    // Notes that waited across a restart.
    for (const [name] of topicStore().openTopics()) if (topicStore().pending(name).length) this.schedule(name, this.opts.debounceMs ?? PUSH_DEBOUNCE_MS);
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private close(name: string): void {
    const s = topicStore();
    const t = s.topic(name);
    if (!t) return;
    const dropped = s.close(name);
    s.audit({ sessionId: t.receiver.sessionId, tool: "queue_open", topic: name, outcome: "closed", dropped });
  }

  /** Drain `topic` after `ms`; a later call before then replaces the wait (a burst is one batch). */
  schedule(topic: string, ms: number): void {
    const old = this.timers.get(topic);
    if (old) clearTimeout(old);
    const t = setTimeout(() => {
      this.timers.delete(topic);
      void this.drain(topic).catch((err) => console.error("[topics] delivery failed", err));
    }, ms);
    t.unref?.();
    this.timers.set(topic, t);
  }

  private receiverIdle(path: string): void {
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
    this.log.push({ topic, outcome });
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
    if (chat.special) return "special";
    // Re-read after the await: a settle or another drain may have taken these meanwhile.
    const now = s.batch(topic);
    if (!now.length || this.inFlight.has(topic)) return "empty";
    const batch = `tb_${randomBytes(6).toString("hex")}`;
    const text = formatTopicBatch({ topic, batch, notes: now });
    const ids = now.map((it) => it.id);
    const mark: TopicBatchMark = {
      text,
      topic,
      batch,
      items: now.map((it) => ({ id: it.id, from: it.from, at: it.at })),
      entered: () => {
        if (this.inFlight.get(topic) === batch) this.inFlight.delete(topic);
        s.ack(topic, ids, batch, rec.receiver.sessionId);
        // The rest of a backlog over one batch's size goes at the next settle (receiverIdle).
      },
      gone: () => {
        if (this.inFlight.get(topic) === batch) this.inFlight.delete(topic);
      },
    };
    this.inFlight.set(topic, batch);
    let r: string;
    try {
      r = chat.deliverTopicBatch(mark);
    } catch (err) {
      this.inFlight.delete(topic);
      return `refused: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (r !== "started") this.inFlight.delete(topic);
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
