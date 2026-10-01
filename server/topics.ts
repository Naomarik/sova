import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Refusal, text } from "./session-guards";
import { TOPIC_TEXT_MAX, TopicStore } from "./topic-store";

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

/** Who receives a topic, found by name: the store's open record (§chat.topics/open). The one
    binding from a topic to its receiver. */
export function topicReceiver(name: string): { sessionId: string; path: string } | null {
  return topicStore().topic(name)?.receiver ?? null;
}

const pushListeners = new Set<(topic: string) => void>();
/** Delivery's hook: a note was kept on `topic`. */
export function onTopicPush(fn: (topic: string) => void): () => void {
  pushListeners.add(fn);
  return () => pushListeners.delete(fn);
}

export const PUSH_WINDOW_MS = 10 * 60_000;
export const PUSHES_PER_WINDOW = 5;
/** Pushes per sender → topic in the last window, for this process's life. */
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

/**
 * One push (§chat.topics/push): checks, keeps the note, audits, tells delivery. Returns the
 * one-sentence result; throws a Refusal with the sentence otherwise.
 */
export function pushNote(ctx: PusherContext, params: { topic?: unknown; text?: unknown }): string {
  const s = topicStore();
  const sessionId = ctx.sessionId();
  const topic = typeof params?.topic === "string" ? params.topic.trim() : "";
  const refuse = (error: string): never => {
    s.audit({ sessionId, tool: "queue_push", ...(topic ? { topic: topic.slice(0, 64) } : {}), outcome: "refused", error });
    throw new Refusal(error);
  };
  const rec = s.topic(topic);
  if (!rec) refuse(`No open topic "${topic.slice(0, 64)}".`);
  const body = typeof params?.text === "string" ? params.text.trim() : "";
  if (!body) refuse("text must not be blank.");
  if (body.length > TOPIC_TEXT_MAX) refuse(`Too long: at most ${TOPIC_TEXT_MAX} characters.`);
  if (rec!.receiver.sessionId === sessionId) refuse(`This session is "${topic}"'s receiver; a topic is for other sessions.`);
  const now = (ctx.now ?? Date.now)();
  const key = `${sessionId}\u0000${topic}`;
  const recent = (pushTimes.get(key) ?? []).filter((t) => now - t < PUSH_WINDOW_MS);
  if (recent.length >= PUSHES_PER_WINDOW) refuse(`Limit: at most ${PUSHES_PER_WINDOW} pushes to one topic in 10 minutes.`);
  const r = s.push(topic, { sessionId, title: ctx.title() }, body);
  if (!r.ok) refuse(r.error);
  recent.push(now);
  pushTimes.set(key, recent);
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

type Tool = ToolDefinition<any, any>;

export function queuePushTool(ctx: PusherContext): Tool {
  return {
    name: QUEUE_PUSH_TOOL,
    label: "Queue push",
    description: QUEUE_PUSH_DESCRIPTION,
    parameters: obj({ topic: str("The topic you were told to use."), text: str("The note. One line is best.") }, ["topic", "text"]),
    execute: async (_id: string, p: any) => {
      const said = pushNote(ctx, p ?? {});
      return { content: text(said), details: { v: 1, topic: String(p?.topic ?? "").trim() } };
    },
  } as Tool;
}

/** The hidden inline extension every ordinary runtime gets (server/chat-manager.ts). */
export function queuePushExtension(ctx: PusherContext) {
  return {
    name: "sova-topics",
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.registerTool(queuePushTool(ctx));
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
