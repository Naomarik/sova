import { AsyncLocalStorage } from "node:async_hooks";
import { CARDS_NOTE_MESSAGE } from "../shared/overseer-card";
import { OVERSEER_BRIEF_PREFIX } from "../shared/protocol";
import { parseWakeNudge } from "../shared/wake";
import { ID_NOTE_MESSAGE } from "./overseer-id-check";
import { watchUserMessages } from "./harness/pi/turns";

// ---- who started the turn ----------------------------------------------------------------------

/** The part of the SDK's `Agent` every user-role message passes through on its way into the
    context: a turn started with messages, a steer, a follow-up. */
export interface UserMessageSink {
  prompt(...args: never[]): Promise<void>;
  steer(message: never): void;
  followUp(message: never): void;
}

/** The text of a user-role message as the SDK holds it (a string, or text and image parts); null
    for any other role. */
export function userMessageText(message: unknown): string | null {
  const m = message as { role?: unknown; content?: unknown } | undefined;
  if (m?.role !== "user") return null;
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return m.content
    .filter((c): c is { type: "text"; text: string } => (c as { type?: unknown })?.type === "text" && typeof (c as { text?: unknown }).text === "string")
    .map((c) => c.text)
    .join("\n");
}

/** The session events `UserTurns.observe` reads: the AgentSession's own stream (`session.subscribe`),
    which carries every message entering the context, including the context-only custom messages
    the SDK appends between turns without telling extensions. */
export interface TurnEvent {
  type: string;
  message?: unknown;
  willRetry?: boolean;
}

/** Roles that bring nothing from outside into the context: the model's own output, tool results,
    the SDK's loadout declarations and summaries. Every other role (a user message, an extension's
    custom message, anything new) is input, and input decides who the run belongs to. */
const NEUTRAL_ROLES = new Set(["assistant", "toolResult", "system", "compactionSummary", "branchSummary", "bashExecution"]);
/** Custom messages only the server writes: the hidden open-cards note (with the run note) and the
    id check's note (§app.overseer/id-check). */
const STATE_NOTES = new Set<unknown>([CARDS_NOTE_MESSAGE, ID_NOTE_MESSAGE]);
const isCardsNote = (m: unknown): boolean => (m as { role?: unknown; customType?: unknown } | undefined)?.role === "custom" && STATE_NOTES.has((m as { customType?: unknown }).customType);

/**
 * Whether the Overseer is answering the user: the one source of truth for both the per-turn caps
 * (a user message renews them) and the read-only rule for runs the user did not start (a brief,
 * a wake-up, an extension's message such as an /explain result or a worker's report: every acting
 * tool refuses).
 *
 * Per run. Every run starts unattended (`agent_start`), whatever the run before it was, and only a
 * message the user sent from the UI makes it attended. Which messages those are is decided by
 * identity, not by text: the chat runtime hands each one (a typed message, a quick action, a
 * confirm-card click, a steer, a regenerate) to the SDK inside `send`, and the first user-role
 * message the SDK builds from that call, after every extension `input` transform, template
 * expansion and image note, is marked when it reaches the Agent (`watch`). When it enters the
 * context the run becomes the user's. Nothing else is ever marked, so a wake-up, a brief or an
 * extension's message is never attended, whatever its text. Fails closed: anything unmarked (an
 * unknown sender, a fresh runtime after a restart) is unattended.
 *
 * Within a run, input the user did not send ends the user's part of it: once the model has replied
 * to the user's message, any other input entering the context (a wake-up or worker report queued
 * into the run, a context-only custom message appended after a turn) makes the rest of the run
 * read-only, so foreign input never acts on the user's authority, not even for the rest of the run
 * it joined. Custom messages that ride in with the user's own message, before the model's first
 * reply to it (an extension's `before_agent_start` context), are part of that message. A user
 * message queued into a run makes the rest of it the user's.
 *
 * One exception keeps the user's run whole: when the SDK re-runs a request that just failed (an
 * automatic retry, the compact-and-retry of a context overflow), the new run continues the old
 * one's attendance, but only if the model's reply is the first thing in it. Any input that arrives
 * first decides the run instead.
 *
 * The mark is carried by the async context of the `send` call, so it reaches the Agent across the
 * SDK's awaits (an `input` handler describing an image) and no other caller's message can take it.
 * Each `send` marks at most one message: the run that message starts inherits the spent context,
 * so a message queued later from inside that run (a wake-up's timer, an extension's follow-up) is
 * not marked. A user message the SDK defers to after the previous run settles runs outside its
 * `send` and is unattended: that turn is read-only, never the reverse.
 */
export class UserTurns {
  private readonly sending = new AsyncLocalStorage<{ open: boolean; confirm?: string }>();
  private readonly fromUser = new WeakSet<object>();
  /** A marked message that is a click on a card: that card's id (`c_N`). */
  private readonly confirmOf = new WeakMap<object, string>();
  /** The card whose click opened the user's part of this run, while it lasts. */
  private card: string | null = null;
  private retryCard: string | null = null;
  private rerunCard: string | null = null;
  private readonly watched = new WeakSet<object>();
  private now = false;
  /** The user's message entered and the model has not replied to it yet: other input now is part of it. */
  private batch = false;
  /** A failed request is about to be re-run: the attendance it failed with. */
  private retry: boolean | null = null;
  /** The run started as a re-run, and nothing has entered it yet. */
  private rerun: boolean | null = null;
  /** Run the SDK call that hands a message the user sent to the runtime. `confirm`: the message is a
      click on the card with that id, `c_N` (the chat runtime says so; typed text never is). */
  send<T>(send: () => T, confirm?: string): T {
    return this.sending.run({ open: true, ...(confirm ? { confirm } : {}) }, send);
  }
  /** Mark, from now on, the user message each `send` produces as it reaches this Agent. */
  watch(agent: UserMessageSink): void {
    if (this.watched.has(agent)) return;
    this.watched.add(agent);
    watchUserMessages(agent, (input) => this.claim(input));
  }
  private claim(input: unknown): void {
    const ctx = this.sending.getStore();
    if (!ctx?.open) return;
    const message = (Array.isArray(input) ? input : [input]).find((m) => userMessageText(m) !== null);
    if (!message) return;
    ctx.open = false;
    this.fromUser.add(message as object);
    if (ctx.confirm) this.confirmOf.set(message as object, ctx.confirm);
  }
  /** One event from the Overseer session's stream; returns true when a message the user sent
      entered the context (the per-turn caps renew). */
  observe(event: TurnEvent): boolean {
    switch (event.type) {
      case "agent_start":
        this.now = false;
        this.batch = false;
        this.rerun = this.retry;
        this.rerunCard = this.retryCard;
        this.retry = null;
        this.retryCard = null;
        this.card = null;
        return false;
      case "auto_retry_start":
        this.retry = this.now;
        this.retryCard = this.card;
        return false;
      case "compaction_end":
        if (event.willRetry) {
          this.retry = this.now;
          this.retryCard = this.card;
        }
        return false;
      case "auto_retry_end":
      case "agent_settled":
        this.retry = null;
        this.retryCard = null;
        return false;
      case "message_start":
        return this.entered(event.message);
      default:
        return false;
    }
  }
  private entered(message: unknown): boolean {
    const role = (message as { role?: unknown } | undefined)?.role;
    const rerun = this.rerun;
    const rerunCard = this.rerunCard;
    this.rerun = null;
    this.rerunCard = null;
    if (role === "assistant") {
      // A re-run the model answers straight away is the failed request again.
      if (rerun !== null) {
        this.now = rerun;
        this.card = rerun ? rerunCard : null;
      }
      this.batch = false;
      return false;
    }
    // The Overseer's own open-cards note is state, not input (§app.overseer/confirm), and so is the
    // id check's note (§app.overseer/id-check): neither changes who the run belongs to, wherever it lands.
    if ((typeof role === "string" && NEUTRAL_ROLES.has(role)) || isCardsNote(message)) {
      this.rerun = rerun;
      this.rerunCard = rerunCard;
      return false;
    }
    const text = userMessageText(message)?.trim();
    if (text === undefined) {
      // Input no one marked (an extension's custom message). With the user's own message it is
      // context for that message; anywhere else it ends the user's part of the run.
      if (!this.batch) {
        this.now = false;
        this.card = null;
      }
      return false;
    }
    const mine = this.fromUser.delete(message as object);
    const card = this.confirmOf.get(message as object) ?? null;
    this.confirmOf.delete(message as object);
    this.now = mine && !parseWakeNudge(text) && !text.startsWith(OVERSEER_BRIEF_PREFIX);
    // Only the click itself opens a confirmed run: a later message, typed or not, is a new run of its own.
    this.card = this.now ? card : null;
    this.batch = this.now;
    return this.now;
  }
  attended(): boolean {
    return this.now;
  }
  /** The confirm card whose click opened the user's part of this run, or null (§app.overseer/org-people-facing). */
  confirmedCard(): string | null {
    return this.now ? this.card : null;
  }
  /** /clear: nothing carries over. */
  reset(): void {
    this.now = false;
    this.batch = false;
    this.retry = null;
    this.rerun = null;
    this.card = null;
    this.retryCard = null;
    this.rerunCard = null;
  }
}
