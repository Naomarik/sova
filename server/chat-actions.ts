// POST /api/chat/action?path=&wait= (§app/chat-actions): one in-chat action from a script (Stop,
// Compact, Rewind, Regenerate, Remove a queued message, Reload Now) with its outcome to wait for.
//
// The action takes a chat socket's own path (server/ws.ts recordFrame → handleChat), on a recording
// socket that hears what the chat sends it, so the chat handles it exactly as it handles the button
// and every open screen shows what another tab's press shows. The frame goes over once the chat's
// hello has arrived, at most once (§app.chat-actions/never-replay): past the wait, or when the chat
// restarts or reconnects first, the answer is 202 `unknown` and nothing sends it again. A chat that
// goes away or never opens before the frame went over answers 503 `not-sent`: known, nothing was sent.
//
// It never sends a prompt, a steer or a dialog's answer (that can approve a sandbox widening).
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Hono } from "hono";
import type { ChatClientMessage } from "../shared/protocol";
import { assertNotLive, BusyError, chatHandleTakenBack } from "./chat-handle";
import { sessionsChanged } from "./list-generation";
import { resolveSessionPath } from "./paths";
import { recordFrame } from "./ws";
import { ARCHIVED_REFUSAL, isArchived } from "./archived-sessions";
import { idOf } from "./sessions-index";

export const CHAT_ACTION_PATH = "/api/chat/action";
/** `wait` when the query leaves it out, and its ceiling (ms). */
export const WAIT_DEFAULT_MS = 30_000;
export const WAIT_MAX_MS = 300_000;
/** How long the chat may take to open (its hello, or its refusal), whatever `wait` says. */
export const OPEN_CAP_MS = 60_000;
const STRING_MAX = 64 * 1024;
const BODY_MAX = 1024 * 1024;
/** Unattributed errors an unknown answer reports, at most. */
const HEARD_MAX = 5;

/** One action a script may ask of a chat. */
export type ChatAction =
  | { type: "abort" }
  | { type: "compact"; instructions?: string }
  | { type: "rewind"; entryId: string }
  | { type: "regenerate"; entryId: string }
  | { type: "queue_remove"; itemId: string }
  | { type: "reload_code" };

/** The keys each action takes, `type` included. */
const KEYS: Record<ChatAction["type"], Record<string, "required" | "optional">> = {
  abort: { type: "required" },
  compact: { type: "required", instructions: "optional" },
  rewind: { type: "required", entryId: "required" },
  regenerate: { type: "required", entryId: "required" },
  queue_remove: { type: "required", itemId: "required" },
  reload_code: { type: "required" },
};
const TYPES = Object.keys(KEYS).join(", ");

/** The body as an action, or the sentence that refuses it. */
export function parseAction(body: unknown): ChatAction | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: `Expected a JSON object with a type: one of ${TYPES}` };
  const b = body as Record<string, unknown>;
  const type = b.type;
  if (typeof type !== "string" || !Object.hasOwn(KEYS, type)) return { error: `Unknown action type; expected one of ${TYPES}` };
  const keys = KEYS[type as ChatAction["type"]];
  for (const key of Object.keys(b)) if (!Object.hasOwn(keys, key)) return { error: `"${type}" takes no "${key}"` };
  for (const [key, need] of Object.entries(keys)) {
    if (key === "type") continue;
    const v = b[key];
    if (v === undefined && need === "optional") continue;
    if (typeof v !== "string") return { error: `"${key}" must be a string` };
    if (need === "required" && v.length === 0) return { error: `"${key}" must not be empty` };
    if (v.length > STRING_MAX) return { error: `"${key}" is longer than ${STRING_MAX} characters` };
  }
  return b as unknown as ChatAction;
}

/** `?wait=` in ms, or the sentence that refuses it. */
export function parseWait(raw: string | undefined): number | { error: string } {
  if (raw === undefined || raw === "") return WAIT_DEFAULT_MS;
  if (!/^\d{1,7}$/.test(raw) || Number(raw) > WAIT_MAX_MS) return { error: `wait must be a whole number of milliseconds from 0 to ${WAIT_MAX_MS}` };
  return Number(raw);
}

/** The frame the chat gets: the request id as its `id` (actions that have one) and its `clientId`
    (every action: a refusal that comes as a plain error echoes it, chat-manager handleNow `fail`). */
export function frameOf(action: ChatAction, requestId: string): ChatClientMessage {
  const id = action.type === "compact" || action.type === "rewind" || action.type === "regenerate" || action.type === "queue_remove" ? { id: requestId } : {};
  return { ...action, ...id, clientId: requestId } as unknown as ChatClientMessage;
}

/** An answer: the HTTP status and its JSON. */
export interface ActionAnswer {
  status: 200 | 202 | 404 | 409 | 500 | 503;
  body: Record<string, unknown>;
}

/** What the matcher says after a frame: keep waiting, hand the frame over now, or answer. */
export type MatchStep = { kind: "wait" } | { kind: "emit" } | { kind: "answer"; answer: ActionAnswer };

const REPLIES: Partial<Record<ChatAction["type"], [done: string, refused: string]>> = {
  compact: ["compacted", "compact_refused"],
  rewind: ["rewound", "rewind_refused"],
  regenerate: ["regenerated", "regenerate_refused"],
  queue_remove: ["queue_removed", "queue_remove_refused"],
};

/**
 * Reads what the chat sends the recording socket, in order, and decides (pure: no timers, no I/O).
 * Before the hello, an error is the chat refusing to open. The hello says "emit" (Stop with nothing
 * running answers at once, with no frame). After it, only a frame naming this request answers, by
 * its `id` or `clientId`; Stop's run end and Reload Now's `code` are this socket's own (it sent
 * nothing else). A `reloaded` error or `closed` means the chat went away, and so does a second hello
 * for Stop and Reload Now: unknown.
 */
export function createMatcher(action: ChatAction, requestId: string) {
  let hello = false;
  let emitted = false;
  let compacting = false;
  let greetingSkipped = false;
  let cleared: { steering: string[]; followUp: string[] } | undefined;
  const heard: string[] = [];
  const unknownBody = (waitedMs: number): ActionAnswer => ({ status: 202, body: { outcome: "unknown", requestId, waitedMs, heard: [...heard] } });
  const answer = (status: ActionAnswer["status"], body: Record<string, unknown>): MatchStep => ({ kind: "answer", answer: { status, body: { ...body, requestId } } });
  const gone: MatchStep = { kind: "answer", answer: { status: 202, body: {} } }; // filled by the caller (waitedMs)

  return {
    get hello() {
      return hello;
    },
    get emitted() {
      return emitted;
    },
    /** Called by the driver once the frame went over. */
    sent(): void {
      emitted = true;
    },
    /** The unknown answer as of now. */
    unknown: unknownBody,
    frame(msg: Record<string, unknown>): MatchStep {
      const type = msg.type;
      if (!hello) {
        if (type === "error") {
          const code = msg.code;
          const error = String(msg.message ?? "The chat could not open");
          if (code === "busy" || code === "recent" || code === "config") return answer(409, { error, outcome: "refused", code });
          return answer(500, { error, outcome: "refused", code: code ?? "internal" });
        }
        // An archived chat opens for nothing (§chat.transcript/instant-open, "An archived chat").
        if (type === "closed" && msg.reason === "archived") return answer(409, { error: ARCHIVED_REFUSAL, outcome: "refused", code: "archived" });
        if (type === "closed") return gone;
        if (type !== "hello") return { kind: "wait" };
        hello = true;
        if (action.type === "abort") {
          compacting = msg.isCompacting === true;
          if (msg.isStreaming !== true && !compacting) return answer(200, { outcome: "stopped", wasRunning: false });
        }
        return { kind: "emit" };
      }
      if (type === "closed") return gone;
      // A second hello. After a rewind, regenerate or compaction the chat sends every client a fresh
      // one before the requester's own reply (chat-manager afterBranchMove): those wait for their id.
      // Stop and Reload Now cause none, so one there is the chat reconnecting or reattaching, which
      // may have dropped the frame: unknown, never a stop that didn't happen.
      if (type === "hello") return action.type === "abort" || action.type === "reload_code" ? gone : { kind: "wait" };
      if (type === "error") {
        if (msg.code === "reloaded") return gone;
        if (emitted && msg.clientId === requestId) {
          return answer(409, { error: String(msg.message ?? ""), outcome: "refused", code: msg.code ?? "internal" });
        }
        if (emitted && heard.length < HEARD_MAX && typeof msg.message === "string") heard.push(msg.message);
        return { kind: "wait" };
      }
      // reload_code: a chat process greets a new client with its non-current code state right after
      // the hello (chat-runtime/host.ts `greeted`), before it takes the frame: skipped, once, whether
      // it arrives before or after the frame went over.
      if (action.type === "reload_code" && type === "code" && msg.state !== "current" && !greetingSkipped) {
        greetingSkipped = true;
        return { kind: "wait" };
      }
      if (!emitted) return { kind: "wait" };
      const replies = REPLIES[action.type];
      if (replies) {
        if (msg.id !== requestId) return { kind: "wait" };
        if (type === replies[0]) return answer(200, { outcome: "done", reply: msg });
        if (type === replies[1]) return answer(409, { error: String(msg.message ?? ""), outcome: "refused", reason: msg.reason, reply: msg });
        return { kind: "wait" };
      }
      if (action.type === "abort") {
        if (type === "queue_cleared") {
          cleared = { steering: (msg.steering as string[]) ?? [], followUp: (msg.followUp as string[]) ?? [] };
          return { kind: "wait" };
        }
        if (type !== "event") return { kind: "wait" };
        const event = msg.event as { type?: string; what?: string; phase?: string } | undefined;
        const ended = event?.type === "run.settled" || (compacting && event?.type === "activity" && event.what === "compaction" && event.phase === "end");
        return ended ? answer(200, { outcome: "stopped", wasRunning: true, ...(cleared ? { cleared } : {}) }) : { kind: "wait" };
      }
      // reload_code: the reply, past the greeting (above).
      if (type !== "code") return { kind: "wait" };
      const state = msg.state;
      const detail = typeof msg.detail === "string" ? { detail: msg.detail } : {};
      if (state === "current") return answer(200, { outcome: "current" });
      if (state === "reloading") return answer(200, { outcome: "reloading", ...detail });
      if (state === "failed") return answer(200, { outcome: "failed", ...detail });
      if (state === "older" && msg.pending === true) return answer(200, { outcome: "pending", ...detail });
      return { kind: "wait" };
    },
  };
}

/** The driver's hooks, so a test can run it on a fake clock. */
export interface ActionDeps {
  record: typeof recordFrame;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  now(): number;
}

const realDeps: ActionDeps = {
  record: recordFrame,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
  now: () => Date.now(),
};

/** The chat never took the frame (it didn't open in time, or went away first): nothing was sent. */
export const NOT_SENT = "The chat did not open; nothing was sent.";

/**
 * Run one action on a chat that is already open or will be: the frame over once the hello is in,
 * at most once; the answer by request id; `unknown` past the wait or when the chat goes away after
 * the frame went over, and 503 `not-sent` when it goes away or never opens before. Every end closes
 * the recording socket and clears its timers.
 */
export function runAction(path: string, action: ChatAction, waitMs: number, deps: ActionDeps = realDeps, requestId = `act-${randomUUID()}`): Promise<ActionAnswer> {
  return new Promise((resolve) => {
    const m = createMatcher(action, requestId);
    let done = false;
    let openTimer: unknown = null;
    let waitTimer: unknown = null;
    let sentAt: number | null = null;
    const waited = () => (sentAt === null ? 0 : deps.now() - sentAt);
    let rec: ReturnType<typeof recordFrame> | null = null;
    const finish = (a: ActionAnswer) => {
      if (done) return;
      done = true;
      if (openTimer !== null) deps.clearTimer(openTimer);
      if (waitTimer !== null) deps.clearTimer(waitTimer);
      rec?.close();
      resolve(a);
    };
    /** Nothing reached the chat: a known outcome, never exit 5 (§app.chat-actions/never-replay). */
    const notSent = () => finish({ status: 503, body: { error: NOT_SENT, outcome: "not-sent", requestId } });
    // Unknown only once a frame went over; before that the outcome is known: nothing was sent.
    const unknown = () => (m.emitted ? finish(m.unknown(waited())) : notSent());
    const step = (s: MatchStep) => {
      if (done) return;
      if (s.kind === "wait") return;
      if (s.kind === "answer") {
        // A chat that went away (second hello, closed, reloaded): unknown when the frame went over;
        // before it did, nothing was sent (unknown() says which).
        if (s.answer.status === 202) return unknown();
        return finish(s.answer);
      }
      // emit: the hello is in. Handed over after the frame that said so is done (a chat in this
      // process sends its hello from inside attach, which must not take a message midway).
      if (openTimer !== null) deps.clearTimer(openTimer);
      openTimer = null;
      queueMicrotask(() => {
        if (done) return;
        // The socket closed before the frame could go over: nothing was sent.
        if (!rec?.emit(() => (m.sent(), (sentAt = deps.now())))) return notSent();
        if (done) return;
        if (waitMs === 0) return unknown();
        waitTimer = deps.setTimer(unknown, waitMs);
      });
    };
    // Past the open cap with no hello: the socket closes before any frame (emit never runs after).
    openTimer = deps.setTimer(() => {
      if (!m.hello) unknown();
    }, OPEN_CAP_MS);
    rec = deps.record(path, frameOf(action, requestId), (msg) => step(m.frame(msg)), () => {
      if (done) return;
      // The chat closed this client. An error before it already answered; anything else is unknown.
      unknown();
    });
  });
}

/**
 * The answers given before any chat is asked. A session a terminal holds is refused with the
 * sentence a chat's own start gives it (chat-host startChat runs the same assertNotLive first), and
 * nothing starts (§app.chat-actions/terminal-open). Stop and Reload Now on a chat that isn't open
 * start nothing either (§app.chat-actions/cold). A chat still starting counts as not open; one a
 * restarted server is still taking back does not: that is waited for, so a chat whose reply ran on
 * through the restart is stopped, never answered "nothing was running".
 */
export async function beforeChat(path: string, action: ChatAction): Promise<ActionAnswer | null> {
  try {
    assertNotLive(path);
  } catch (err) {
    if (err instanceof BusyError) return { status: 409, body: { error: err.message, outcome: "refused", code: err.code } };
    throw err;
  }
  const cold = action.type === "abort" || action.type === "reload_code";
  // An archived chat starts for nothing a script asks (§chat.transcript/instant-open, "An archived chat");
  // Stop and Reload Now answer as for any chat that isn't open.
  if (!cold && isArchived(idOf(path))) return { status: 409, body: { error: ARCHIVED_REFUSAL, outcome: "refused", code: "archived" } };
  if (!cold) return null;
  if (await chatHandleTakenBack(path)) return null;
  return { status: 200, body: action.type === "abort" ? { outcome: "stopped", wasRunning: false } : { outcome: "not-running" } };
}

/** Mount the route (server/app.ts). */
export function mountChatActions(app: Hono, deps: ActionDeps = realDeps): void {
  app.post(CHAT_ACTION_PATH, async (c) => {
    const path = resolveSessionPath(c.req.query("path"));
    if (!path) return c.json({ error: "Invalid or missing ?path= (must be a .jsonl under the pi sessions dir)" }, 400);
    if (!existsSync(path)) return c.json({ error: "Session file not found" }, 404);
    const text = await c.req.text().catch(() => "");
    if (text.length > BODY_MAX) return c.json({ error: `The body is larger than ${BODY_MAX} bytes` }, 400);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: `Expected a JSON object with a type: one of ${TYPES}` }, 400);
    }
    const action = parseAction(body);
    if ("error" in action) return c.json({ error: action.error }, 400);
    const wait = parseWait(c.req.query("wait"));
    if (typeof wait !== "number") return c.json({ error: wait.error }, 400);
    const early = await beforeChat(path, action);
    if (early) return c.json(early.body, early.status);
    sessionsChanged();
    const answer = await runAction(path, action, wait, deps);
    return c.json(answer.body, answer.status);
  });
}
