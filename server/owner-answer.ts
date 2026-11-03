import { noteMessage, sessionPathOf, undoNote } from "./baton";
import { acquireChatHandle } from "./chat-handle";
import { OrgError } from "./orgs";
import { answerRefusal, shownConversation } from "./owner-page";
import { refreshShare } from "./share/hub";

/**
 * The owner answers on their page (§app.owner-page/content, Answering on the page; §app.baton/links): a message into
 * a conversation shown to them while it waits on them, taken exactly as a hand-off link's message is taken
 * (server/share/routes.ts, POST /api/h/<token>/message), the owner in the link's place. Text only. The baton's own
 * lock (noteMessage) decides, so the holder, the offer's lease and the message limit are the statechart's, not a
 * copy of them; this module checks first only to give the page the same refusal a link gets.
 */

/** The longest message (a hand-off page's, §app.baton/share-listener). */
export const ANSWER_TEXT_MAX = 4000;

const REFUSED: Record<NonNullable<ReturnType<typeof answerRefusal>>, string> = {
  closed: "This conversation has ended.",
  budget: "This conversation has reached its message limit. The operator has been told.",
  taken: "Someone else is answering right now.",
  "not-holder": "It's not your turn in this conversation right now.",
};

/** The owner's message on their page: their feature request chat's own route, or an answer to a conversation that
    waits on them. Refusals are OrgErrors (404 `missing`, 400 `bad-request`/`too-long`, 409 with the refusal's code,
    `busy` when the chat can't take it now), which the share route maps as the feature route does. */
export async function sendOwnerPageMessage(orgId: string, personId: string, handle: string, raw: unknown): Promise<void> {
  const f = await import("./feature-chats");
  let feature = false;
  try {
    f.ownersChatByHandle(orgId, personId, handle);
    feature = true;
  } catch {
    feature = false;
  }
  if (feature) return f.sendOwnerFeatureMessage(orgId, personId, handle, raw);
  return sendOwnerAnswer(orgId, personId, handle, raw);
}

/** An answer to a conversation that waits on the owner (not their feature request chat). */
export async function sendOwnerAnswer(orgId: string, personId: string, handle: string, raw: unknown): Promise<void> {
  const { row, dir, ownerId } = shownConversation(orgId, handle);
  // The link's person is the org's owner now (ownerAccess checked it); a stale caller is refused as unknown.
  if (ownerId !== personId) throw new OrgError("Not found", 404, "missing");
  const text = typeof raw === "string" ? raw.replace(/\r\n?/g, "\n").trim() : "";
  if (!text) throw new OrgError("Write something first.", 400, "bad-request");
  if (text.length > ANSWER_TEXT_MAX) throw new OrgError(`Messages are limited to ${ANSWER_TEXT_MAX} characters.`, 400, "too-long");
  if (text.startsWith("/")) throw new OrgError("Messages can't start with /.", 400, "bad-request");
  const refused = answerRefusal(row, personId);
  if (refused) throw new OrgError(REFUSED[refused], 409, refused);
  // Nothing is counted or claimed until the runtime is open and would take the message (as the link's route).
  let chat;
  try {
    chat = await acquireChatHandle(sessionPathOf(dir, row));
    await chat.assertModelAllowed();
  } catch (err) {
    throw new OrgError(`The conversation can't take a message right now. Try again in a moment. (${err instanceof Error ? err.message : String(err)})`, 409, "busy");
  }
  // One synchronous stretch from the lock to the hand-over (§app.baton/offers-and-leases): noteMessage decides whether
  // this message may enter, and on an open offer that the owner now holds it; a runtime refusal undoes exactly that.
  try {
    noteMessage(row.sessionId, personId);
  } catch (err) {
    if (err instanceof OrgError && err.code === "workspace") throw new OrgError("The conversation can't take a message right now. Try again in a moment.", 409, "busy");
    if (err instanceof OrgError) {
      const now = shownConversation(orgId, handle);
      const code = answerRefusal(now.row, personId) ?? (err.code === "budget" ? "budget" : "not-holder");
      throw new OrgError(REFUSED[code], 409, code);
    }
    throw err;
  }
  try {
    await chat.send({ text, origin: "server", sentByBaton: { by: personId } });
  } catch (err) {
    undoNote(row.sessionId);
    throw new OrgError(`The conversation can't take a message right now. Try again in a moment. (${err instanceof Error ? err.message : String(err)})`, 409, "busy");
  }
  refreshShare(row.sessionId);
}
