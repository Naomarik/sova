/**
 * The merge queue's side of its chat queue (§chat.merge-queue/requests, §chat.merge-queue/decision): what the chat
 * queue tells the merge queue, and the one thing it asks it. The topics side (server/topics.ts, topic-delivery.ts) and
 * the user's socket (server/ws.ts) call these; the merge queue's wiring (wire.ts) sets the hooks once its queues
 * exist. Before that, or in a test with none set, every call does nothing.
 *
 * - `requestDelivered`: a request reached its chat (its batch entered the transcript), or took the fallback.
 * - `chatPaused`: Stop in the chat held a merge queue batch (true), or the user's next message let it through (false).
 * - `takeHeldNote`: the user is sending a message from this chat's message box: the held note of a decision waiting
 *   for their answer there, now answered, to go with that message in one turn; null when none waits.
 */

export type RequestDelivery = "queued" | "delivered" | "fallback-tab" | "fallback-line";

export interface HeldNote {
  request: string;
  branch?: string;
  text: string;
}

export interface ChannelHooks {
  /** `session`: the chat it reached (a worker's branch: the chat running the worker), the one that may answer it. */
  requestDelivered?(request: string, delivery: RequestDelivery, session?: string): void;
  chatPaused?(sessionId: string, paused: boolean): void;
  /** `decision`: the one the user answered (their composer said so); absent: the newest waiting in this chat. */
  takeHeldNote?(chat: { sessionId: string; path: string }, userText: string, decision?: string): Promise<HeldNote | null>;
  /** Cheap: whether any decision holds a note at all (no session read is made when none does). */
  anyHeld?(): boolean;
}

let hooks: ChannelHooks = {};
export function setChannelHooks(h: ChannelHooks): void {
  hooks = h;
}

const quietly = (what: string, fn: () => void): void => {
  try {
    fn();
  } catch (err) {
    console.warn(`[merge-queue] ${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
};

export function requestDelivered(request: string, delivery: RequestDelivery, session?: string): void {
  if (hooks.requestDelivered) quietly(`delivery of ${request} not recorded`, () => hooks.requestDelivered!(request, delivery, session));
}

export function chatPaused(sessionId: string, paused: boolean): void {
  if (hooks.chatPaused) quietly(`pause of ${sessionId} not recorded`, () => hooks.chatPaused!(sessionId, paused));
}

/** The held note to send with the user's message, answered; null when none. Never throws: a failure sends the
    user's message alone, and the decision keeps waiting. */
export async function takeHeldNote(chat: { sessionId: string; path: string }, userText: string, decision?: string): Promise<HeldNote | null> {
  if (!hooks.takeHeldNote || (hooks.anyHeld && !hooks.anyHeld())) return null;
  try {
    return await hooks.takeHeldNote(chat, userText, decision);
  } catch (err) {
    console.warn(`[merge-queue] held note for ${chat.sessionId} not taken: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Which waiting decision a user's message answers in chat `chatId` (§chat.merge-queue/decision): the one their
 * composer named (`decision`), else the newest waiting there (the card nearest the message box). Never another chat's,
 * and never an older one by queue order. Null: none.
 */
export function pickHeldDecision<T extends { e: { decision?: { id: string; at: string; answered?: unknown; heldNote?: unknown } | null } }>(
  waiting: readonly T[],
  chatId: string,
  decision: string | undefined,
  chatOf: (e: T["e"]) => string | undefined,
): T | null {
  const mine = waiting.filter((w) => w.e.decision && !w.e.decision.answered && w.e.decision.heldNote && chatOf(w.e) === chatId);
  if (decision) return mine.find((w) => w.e.decision!.id === decision) ?? null;
  return [...mine].sort((x, y) => y.e.decision!.at.localeCompare(x.e.decision!.at))[0] ?? null;
}
