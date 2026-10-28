import { existsSync } from "node:fs";
import type { Context, Hono } from "hono";
import type { CardRaiser, SessionCardsAnswer } from "../shared/transcript-cards";
import { extensionCaller, showsToken, TOKEN_HEADER } from "./auth";
import { callerKeys, CALLER_HEADER } from "./caller-keys";
import { resolveSessionPath } from "./paths";
import { answerCard, CardRefusal, raiseCard, sessionCardsAt, setCardsTrusted } from "./transcript-cards";

/**
 * Transcript cards' routes (§chat/transcript-cards). A session's cards (session.card.get), raising
 * one from outside the chat (session.card.post, §chat.transcript-cards/raise-command), answering
 * one (session.card.answer, the card's own presses too), and trusting a project's cards, a trust
 * grant the page alone makes (§chat.transcript-cards/trust). Every answer is no-store.
 */

const NO_STORE = { "Cache-Control": "no-store" };

const handle =
  (fn: (c: Context) => Promise<Response>) =>
  async (c: Context): Promise<Response> => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof CardRefusal) return c.json({ error: err.message, ...(err.needsTrust ? { needsTrust: err.needsTrust } : {}) }, err.status, NO_STORE);
      if (err instanceof Error && (err as { code?: unknown }).code === "tui-live") return c.json({ error: err.message, code: "tui-live" }, 409, NO_STORE);
      throw err;
    }
  };

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    throw new CardRefusal("Expected a JSON body.", 400);
  }
}

function sessionPath(raw: unknown): string {
  const path = resolveSessionPath(typeof raw === "string" ? raw : null);
  if (!path) throw new CardRefusal("Invalid or missing path (must be a .jsonl under the pi sessions dir)", 400);
  if (!existsSync(path)) throw new CardRefusal("Session file not found", 404);
  return path;
}

/** A session a terminal holds takes no card and no answer, in the catalogue's own words (§app.chat-actions/terminal-open). */
async function notInTerminal(path: string): Promise<void> {
  const { assertNotLive, BusyError } = await import("./chat-handle");
  try {
    assertNotLive(path);
  } catch (err) {
    if (err instanceof BusyError) throw new CardRefusal(err.message, 409);
    throw err;
  }
}

/** Who calls: a chat by its key, an extension by its own key, else a script; the page (no token shown) is "you". */
async function callerOf(c: Context): Promise<{ raiser: CardRaiser; name: string; page: boolean }> {
  const token = c.req.header(TOKEN_HEADER);
  if (token === undefined) return { raiser: { kind: "script" }, name: "you", page: true };
  const ext = showsToken(token) ? null : extensionCaller(token);
  if (ext) return { raiser: { kind: "extension", title: ext }, name: ext, page: false };
  const caller = callerKeys.callerOf(c.req.header(CALLER_HEADER));
  if (caller.startsWith("chat:")) {
    const chat = caller.slice("chat:".length);
    const title = await (await import("./sessions-index"))
      .getSessionSummary(chat)
      .then((s) => s?.title?.trim() || "another chat")
      .catch(() => "another chat");
    return { raiser: { kind: "chat", title }, name: title, page: false };
  }
  return { raiser: { kind: "script" }, name: "a script", page: false };
}

export function registerTranscriptCardRoutes(app: Hono<any>): void {
  app.get(
    "/api/session-cards",
    handle(async (c) => c.json((await sessionCardsAt(sessionPath(c.req.query("path")))) satisfies SessionCardsAnswer, 200, NO_STORE)),
  );
  // Raise a card, give an open one a new revision of its data, or mark it done (§chat.transcript-cards/raise-command).
  app.post(
    "/api/session-cards/post",
    handle(async (c) => {
      const b = await body(c);
      const path = sessionPath(b.path);
      for (const k of ["type", "key", "card"] as const) if (b[k] !== undefined && typeof b[k] !== "string") throw new CardRefusal(`${k} must be a string`, 400);
      if (b.done !== undefined && typeof b.done !== "boolean") throw new CardRefusal("done must be true or false", 400);
      await notInTerminal(path);
      const who = await callerOf(c);
      const card = await raiseCard({
        path,
        type: b.type,
        data: b.data,
        ...(b.key !== undefined ? { key: b.key } : {}),
        ...(b.card !== undefined ? { card: b.card } : {}),
        ...(b.done !== undefined ? { done: b.done } : {}),
        by: who.raiser,
      });
      return c.json({ card }, 200, NO_STORE);
    }),
  );
  // An answer, as a press on the card would give it (§chat.transcript-cards/answering); `sent`: a gathered
  // pick recorded once the message carrying it went out.
  app.post(
    "/api/session-cards/answer",
    handle(async (c) => {
      const b = await body(c);
      const path = sessionPath(b.path);
      await notInTerminal(path);
      if (b.sent !== undefined && typeof b.sent !== "boolean") throw new CardRefusal("sent is true or false", 400);
      if (typeof b.card !== "string") throw new CardRefusal("card must be a string naming a card of the session (cd_N)", 400);
      const who = await callerOf(c);
      const card = await answerCard({ path, card: b.card, answer: b.answer, by: who.name, via: b.sent === true ? "send" : "at-once" });
      return c.json({ card }, 200, NO_STORE);
    }),
  );
  // Trust a project's cards to act, or stop: a trust grant, never a catalogue command (§chat.transcript-cards/trust).
  app.post(
    "/api/session-cards/trust",
    handle(async (c) => {
      const b = await body(c);
      if (c.req.header(TOKEN_HEADER) !== undefined) throw new CardRefusal("Only the user trusts cards, in the page.", 403);
      if (typeof b.owner !== "string" || typeof b.on !== "boolean") throw new CardRefusal("owner names whose cards, and on is true or false", 400);
      setCardsTrusted(b.owner, b.on);
      return c.json({ owner: b.owner, trusted: b.on }, 200, NO_STORE);
    }),
  );
}
