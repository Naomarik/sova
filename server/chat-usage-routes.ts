// GET /api/chats/:id/usage (§app.extensions/chat-usage): what one top-level chat has cost and how long it took,
// split by its conversations, cut from this computer's own stores each time it is asked and never kept. The
// server names the conversations (its worker records) and reads the chat's waiting from its transcript; the
// usage helper adds the spend and the time from its stores, and its answer goes out as it came.
import type { Context, Hono } from "hono";
import { MEMBER_ENV, decodeMemberContext } from "../pi-config/extensions/subagents/mailbox.ts";
import type { ChatUsageAsk } from "../shared/usage/wire";
import { wakeOwnerOf, workerMembersOf } from "./chat-host";
import { pathOfId } from "./session-prompt";
import { waitingMs } from "./time-spent-figures";
import { rowsOf } from "./transcript-rows";
import { askUsage } from "./usage-helper/client";

const CHAT_ID = /^[\w-]{1,100}$/;

/** The conversations under a chat, as the server's worker records name them. */
export function membersOf(sid: string): ChatUsageAsk["members"] {
  return workerMembersOf(sid).map((w) => {
    const member = decodeMemberContext(w.env[MEMBER_ENV]);
    return member ? { sid: w.sid, role: "member", name: member.role, parent: w.parent } : { sid: w.sid, role: w.kind, name: w.workerId, parent: w.parent };
  });
}

async function answer(c: Context): Promise<Response> {
  const id = c.req.param("id") ?? "";
  if (!CHAT_ID.test(id)) return c.json({ error: "Not a chat id." }, 400);
  const owner = wakeOwnerOf(id);
  if (owner) return c.json({ error: `That is a helper's conversation, not a chat: ask for its chat, ${owner.parentSessionId}.`, chat: owner.parentSessionId }, 400);
  const path = await pathOfId(id);
  if (!path) return c.json({ error: "No chat with that id." }, 404);
  let waiting = 0;
  try {
    waiting = waitingMs((await rowsOf(path)).branch) / 1000;
  } catch {
    // a file that can't be read now: no waiting figure, the rest still answers
  }
  const a = await askUsage("chat", { sid: id, members: membersOf(id), waiting });
  return new Response(new Uint8Array(a.body), { status: a.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

export function registerChatUsageRoutes(app: Hono<any>): void {
  app.get("/api/chats/:id/usage", answer);
}
