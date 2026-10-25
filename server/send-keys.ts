import { AsyncLocalStorage } from "node:async_hooks";
import { type UserMessageSource, userMessageText } from "./user-turns";

/**
 * Which keyed send each user message came from (§app.chat-processes/worker-instructions): the key a
 * send carries (a worker's task, steer or follow-up) stays with the message the SDK builds from it,
 * by identity, never by text. Same mechanism as UserTurns: the chat hands the message to the SDK
 * inside `run(key, …)`, and the first user-role message that call makes reach the Agent (after every
 * `input` transform, template expansion and image note) is the key's (quirk P7 user-turns-wrap).
 * The SDK later emits that very object in `message_start`/`message_end`, so `keyOf(handle)` names
 * the key there.
 *
 * Carried by the async context of the send, so a prompt the SDK defers past the settle window
 * (quirk P5) would run outside it and stay unkeyed: keyed sends never go in that window (the chat
 * queues them, server/queue.ts holds them past it).
 *
 * `done(key)`: nothing more will hand the key's message to the model (it left the queue undelivered,
 * or the turn it started ended): told to listeners (a worker's feed), which decide from what they saw
 * whether it ran.
 */
export class SendKeys {
  private readonly sending = new AsyncLocalStorage<{ key: string; open: boolean }>();
  private readonly keys = new WeakMap<object, string>();
  private readonly watched = new WeakSet<object>();
  private readonly listeners = new Set<(key: string) => void>();

  /** Run the SDK call that hands the message sent under `key` to the runtime (no key: as is). */
  run<T>(key: string | undefined, send: () => T): T {
    return key === undefined ? send() : this.sending.run({ key, open: true }, send);
  }

  /** Mark, from now on, the user message each `run` produces as it reaches this session's agent. */
  watch(session: UserMessageSource): void {
    if (this.watched.has(session)) return;
    this.watched.add(session);
    session.onUserMessage((input) => this.claim(input));
  }

  private claim(input: unknown): void {
    const ctx = this.sending.getStore();
    if (!ctx?.open) return;
    const message = (Array.isArray(input) ? input : [input]).find((m) => userMessageText(m) !== null);
    if (!message) return;
    ctx.open = false;
    this.keys.set(message as object, ctx.key);
  }

  /** The key of the send this message came from, or undefined. */
  keyOf(handle: unknown): string | undefined {
    return handle && typeof handle === "object" ? this.keys.get(handle) : undefined;
  }

  /** Nothing more will hand `key`'s message to the model: it ran, or it never will. */
  done(key: string | undefined): void {
    if (key === undefined) return;
    for (const fn of [...this.listeners]) fn(key);
  }

  onDone(fn: (key: string) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
}
