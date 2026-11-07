import type { PiExtensionAPI } from "./harness/pi/extension-types";
import type { ToolCtx, ToolSpec } from "../shared/harness";
import { queueChatRole } from "../shared/merge-queue";
import { PROFILE } from "./harness/state-kinds";
import { toPiTool } from "./harness/pi/tools";
import { existsSync } from "node:fs";
import { isArchived } from "./archived-sessions";
import { Refusal, text } from "./session-guards";
import { pairPaused, type PairRecord, TOPIC_TEXT_MAX, TopicStore } from "./topic-store";

/**
 * Topic queues' tools (§chat.topics/open, §chat.topics/push). `queue_push` is in every ordinary
 * hosted runtime, from the hidden inline extension below; `queue_open` is a session power, added to
 * `sova-session-powers` beside `session_send`. Both run in this process, so the sender and the
 * receiver are the runtime's own session, never a parameter. Delivery is server/topic-delivery.ts,
 * told of each push through `onTopicPush`.
 */

let store: TopicStore | null = null;
export function topicStore(): TopicStore {
  return (store ??= new TopicStore());
}
/** Tests only. */
export function setTopicStore(s: TopicStore | null): void {
  store = s;
  pushTimes.clear();
}

const pushListeners = new Set<(topic: string) => void>();
/** Delivery's hook: a note was kept on `topic`. */
export function onTopicPush(fn: (topic: string) => void): () => void {
  pushListeners.add(fn);
  return () => pushListeners.delete(fn);
}

/** End a pairing (§app.overseer/pairs): both topics close, their waiting notes drop, each close is
    audited. Neither chat is told. Null when it wasn't in force. */
export function endPairing(id: string, why: NonNullable<PairRecord["endedWhy"]>): PairRecord | null {
  const s = topicStore();
  const ended = s.endPair(id, why);
  if (!ended) return null;
  for (const side of ["a", "b"] as const)
    s.audit({ sessionId: ended.pair[side].sessionId, tool: "queue_open", topic: ended.pair[side].topic, outcome: "closed", dropped: ended.dropped[side], pairing: id });
  return ended.pair;
}

/** A push to a pairing's topic once the pairing ended, from the partner it was opened for. */
export const PAIRING_ENDED = "This pairing has ended.";
/** A push past one direction's ceiling (§app.overseer/pairs). */
export const PAIRING_PAUSED = "This pairing is paused: note limit reached.";

export const PUSH_WINDOW_MS = 10 * 60_000;
export const PUSHES_PER_WINDOW = 5;
/** Pushes per sender → topic in the last window. Process-local BY CHOICE: a restart forgets the
    count, so a sender could push a fresh 5 right after one. Persisting it (the topic store's own
    files) isn't worth the machinery: the pending cap (200 notes) bounds what a restarted flood can
    pile up, the debounce coalesces it into batches, and the audit keeps every accepted push. */
const pushTimes = new Map<string, number[]>();

export const QUEUE_PUSH_TOOL = "queue_push";
export const QUEUE_OPEN_TOOL = "queue_open";
/** Fixed for the runtime's life and across releases: a claude-code CLI restarts when it changes. */
export const QUEUE_PUSH_DESCRIPTION = "Push a short note to a topic. Use only when told which topic; never guess one.";
export const QUEUE_OPEN_DESCRIPTION =
  "Open a topic other sessions can answer you on with queue_push, and get its name to tell them. Notes arrive here as one batch when you are idle or your turn ends. Opening the same name again returns the topic you already have open.";

const obj = (properties: Record<string, unknown>, required: string[]): any => ({ type: "object", properties, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });

export interface PusherContext {
  sessionId(): string;
  title(): string;
  now?: () => number;
}

/** A pusher whose title may need a read first (a chat in a process of its own: its display title). */
export interface PushingSession extends Omit<PusherContext, "title"> {
  title(): string | Promise<string>;
}

/**
 * The invitations a `session_send` makes: each of the sender's own open topics
 * its text names as a whole word invites the target there, once the send is accepted. They are
 * recorded BEFORE the hand-off, since the target's turn may push before the send returns; the
 * caller then says `accepted()` (each new one is audited) or `refused()` (the new ones are taken
 * back, so a refused send invites no one; an invitation the target already had stays). A pairing's
 * topic never invites anyone this way: its partner is its one sender (§chat.topics/open).
 */
export function inviteFromSend(senderId: string, targetId: string, sent: string): { accepted(): string[]; refused(): void } {
  const s = topicStore();
  const made: string[] = [];
  for (const [name, t] of s.openTopics()) if (t.receiver.sessionId === senderId && !t.pairing && namesTopic(sent, name) && s.invite(name, targetId)) made.push(name);
  return {
    accepted: () => {
      for (const name of made) s.audit({ sessionId: senderId, tool: "session_send", topic: name, outcome: "invited", target: targetId });
      return made;
    },
    refused: () => {
      for (const name of made) s.uninvite(name, targetId);
    },
  };
}

/** `text` holds `name` as a whole word: not inside a longer name (names are [a-z0-9-]). */
export function namesTopic(text: string, name: string): boolean {
  for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) {
    const before = text[i - 1];
    const after = text[i + name.length];
    if ((before === undefined || !/[a-z0-9-]/.test(before)) && (after === undefined || !/[a-z0-9-]/.test(after))) return true;
  }
  return false;
}

/** The receiver can no longer take a batch: its file is gone, or it is archived. */
const receiverGone = (r: { sessionId: string; path: string }): boolean => !existsSync(r.path) || isArchived(r.sessionId);

/**
 * One push (§chat.topics/push): checks, keeps the note, audits, tells delivery. Returns the
 * one-sentence result; throws a Refusal with the sentence otherwise. An uninvited sender and a
 * receiver found gone get the same sentence as a name that isn't open, so nothing tells them apart
 * but the audit's `reason`.
 */
export function pushNote(ctx: PusherContext, params: { topic?: unknown; text?: unknown }): string {
  const s = topicStore();
  const sessionId = ctx.sessionId();
  const topic = typeof params?.topic === "string" ? params.topic.trim() : "";
  const refuse = (error: string, reason?: "not-open" | "not-invited" | "receiver-gone" | "pairing-ended" | "pairing-paused"): never => {
    s.audit({ sessionId, tool: "queue_push", ...(topic ? { topic: topic.slice(0, 64) } : {}), outcome: "refused", error, ...(reason ? { reason } : {}) });
    throw new Refusal(error);
  };
  const notOpen = `No open topic "${topic.slice(0, 64)}".`;
  // A pairing's topic closed because its pairing ended (§app.overseer/pairs): the partner it was
  // opened for hears that plainly; anyone else still gets "No open topic".
  const endedFor = (): boolean => {
    const of = s.pairOfTopic(topic);
    if (!of?.pair.endedAt) return false;
    return (of.dir === "toA" ? of.pair.b.sessionId : of.pair.a.sessionId) === sessionId;
  };
  const rec = s.topic(topic);
  if (!rec) {
    if (endedFor()) refuse(PAIRING_ENDED, "pairing-ended");
    refuse(notOpen, "not-open");
  }
  if (receiverGone(rec!.receiver)) {
    // A paired chat gone or archived ends its pairing: both topics close together.
    const ended = rec!.pairing ? endPairing(rec!.pairing, isArchived(rec!.receiver.sessionId) ? "archived" : "gone") : null;
    if (ended) {
      if (endedFor()) refuse(PAIRING_ENDED, "pairing-ended");
    } else {
      const dropped = s.close(topic);
      s.audit({ sessionId: rec!.receiver.sessionId, tool: "queue_open", topic, outcome: "closed", dropped });
    }
    refuse(notOpen, "receiver-gone");
  }
  if (rec!.receiver.sessionId === sessionId) refuse(`This session is "${topic}"'s receiver; a topic is for other sessions.`);
  if (!s.invited(topic, sessionId)) refuse(notOpen, "not-invited");
  const body = typeof params?.text === "string" ? params.text.trim() : "";
  if (!body) refuse("text must not be blank.");
  if (body.length > TOPIC_TEXT_MAX) refuse(`Too long: at most ${TOPIC_TEXT_MAX} characters.`);
  // The pairing's ceiling: once a direction has taken its notes, it pauses until resumed.
  const paired = rec!.pairing ? s.pairOfTopic(topic) : null;
  if (paired && pairPaused(paired.pair, paired.dir)) refuse(PAIRING_PAUSED, "pairing-paused");
  const now = (ctx.now ?? Date.now)();
  const key = `${sessionId}\u0000${topic}`;
  const recent = (pushTimes.get(key) ?? []).filter((t) => now - t < PUSH_WINDOW_MS);
  if (recent.length >= PUSHES_PER_WINDOW) refuse(`Limit: at most ${PUSHES_PER_WINDOW} pushes to one topic in 10 minutes.`);
  const r = s.push(topic, { sessionId, title: ctx.title().trim() || "Untitled" }, body);
  if (!r.ok) refuse(r.error);
  recent.push(now);
  pushTimes.set(key, recent);
  if (paired) s.countPairNote(paired.pair.id, paired.dir);
  s.audit({ sessionId, tool: "queue_push", topic, outcome: "ok", item: (r as { id: string }).id });
  for (const fn of pushListeners) {
    try {
      fn(topic);
    } catch (err) {
      console.error("[topics] push listener failed", err);
    }
  }
  return `Queued on "${topic}".`;
}

type Tool = ToolSpec;

/** What queue_push answers a merge reviewer (§app.merge-queue/review). */
export const REVIEWER_PUSH_REFUSAL = "Refused: a merge reviewer only reads and answers its run with merge.review; it pushes nothing to a topic.";

export function queuePushTool(ctx: PushingSession): Tool {
  return {
    name: QUEUE_PUSH_TOOL,
    label: "Queue push",
    description: QUEUE_PUSH_DESCRIPTION,
    parameters: obj({ topic: str("The topic you were told to use."), text: str("The note. One line is best.") }, ["topic", "text"]),
    execute: async (_id: string, p: any, _signal?: AbortSignal, _onUpdate?: unknown, tctx?: ToolCtx) => {
      // A merge reviewer only reads and answers its run: it never posts into another chat's queue.
      if (queueChatRole(tctx?.state().latest(PROFILE)?.data?.profile) === "reviewer") return { content: text(REVIEWER_PUSH_REFUSAL), details: { v: 1, topic: String(p?.topic ?? "").trim(), refused: true } };
      const title = await ctx.title();
      const said = pushNote({ sessionId: ctx.sessionId, title: () => title, ...(ctx.now ? { now: ctx.now } : {}) }, p ?? {});
      return { content: text(said), details: { v: 1, topic: String(p?.topic ?? "").trim() } };
    },
  } as Tool;
}

/** The hidden inline extension every ordinary runtime gets (server/chat-manager.ts). */
export function queuePushExtension(ctx: PusherContext) {
  return {
    name: "sova-topics",
    hidden: true,
    factory: (pi: PiExtensionAPI) => {
      pi.registerTool(toPiTool(queuePushTool(ctx)));
    },
  };
}

export interface OpenerContext {
  sessionId: string;
  /** The receiver's session file now (a reopened runtime may have another path). */
  path(): string;
  /** Its project root, kept on the record only. */
  project?(): Promise<string | null>;
}

/** One `queue_open` (§chat.topics/open): the topic's name, or a Refusal. */
export async function openTopic(ctx: OpenerContext, params: { name?: unknown }): Promise<{ name: string; reused: boolean }> {
  const s = topicStore();
  const name = typeof params?.name === "string" ? params.name : "";
  if (!name.trim()) {
    s.audit({ sessionId: ctx.sessionId, tool: "queue_open", outcome: "refused", error: "blank name" });
    throw new Refusal("name must not be blank.");
  }
  // Recorded only (§chat.topics/open): a project that can't be read never refuses the topic.
  let project: string | null = null;
  try {
    project = (await ctx.project?.()) ?? null;
  } catch {
    project = null;
  }
  try {
    const r = s.open({ sessionId: ctx.sessionId, path: ctx.path() }, name, project);
    s.audit({ sessionId: ctx.sessionId, tool: "queue_open", topic: r.name, outcome: "ok" });
    return r;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    s.audit({ sessionId: ctx.sessionId, tool: "queue_open", outcome: "refused", error });
    throw new Refusal(error);
  }
}

export function queueOpenTool(ctx: OpenerContext): Tool {
  return {
    name: QUEUE_OPEN_TOOL,
    label: "Open topic",
    description: QUEUE_OPEN_DESCRIPTION,
    parameters: obj({ name: str("A short base name, like merge. The topic's full name is made from it.") }, ["name"]),
    execute: async (_id: string, p: any) => {
      const r = await openTopic(ctx, p ?? {});
      const said = r.reused
        ? `Your topic "${r.name}" is still open. Tell sessions to answer with queue_push, topic "${r.name}".`
        : `Opened "${r.name}". Tell sessions to answer with queue_push, topic "${r.name}".`;
      return { content: text(said), details: { v: 1, topic: r.name, reused: r.reused } };
    },
  } as Tool;
}
