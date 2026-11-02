import { ARCHIVED_REFUSAL } from "../archived-sessions";

/**
 * The one way the merge queue (and readiness's ready-to-land wakes) starts a turn in a chat: a normal message, queued
 * after a turn in flight, whose text starts with MERGE_QUEUE_SENT_PREFIX (the page draws it as the merge queue's) and
 * which carries the chat's "another session" sender marker, titled "Merge queue". The marker is what keeps it from
 * ever being read as the user's own word, in every chat, including chats started before the prefix was known: the
 * worktree tool's `land` refuses a marked message whatever it says. Throws when the chat can't take it (a terminal
 * holds it, it is archived, an Overseer's, a baton's): the caller keeps it as the chat's hidden line instead.
 */
export const MERGE_QUEUE_SENDER = { sessionId: "merge-queue", title: "Merge queue", hop: 0 } as const;

export async function sendQueueWake(sessionPath: string, text: string): Promise<void> {
  const [{ getSessionSummary }, { acquireChatHandle }, { projectOverseerOfPath }] = await Promise.all([import("../sessions-index"), import("../chat-handle"), import("../project-overseer-store")]);
  const s = await getSessionSummary(sessionPath);
  if (!s) throw new Error("Session file not found");
  if (s.live) throw new Error(`It is open in a terminal (pid ${s.live.pid}), so this server must not write to it.`);
  if (s.archived) throw new Error(ARCHIVED_REFUSAL);
  if (s.overseer || s.baton || projectOverseerOfPath(sessionPath)) throw new Error("That chat takes no merge queue message.");
  const chat = await acquireChatHandle(sessionPath);
  await chat.send({ text, origin: "server", checkModel: true, delivery: "followUp", sentBySession: { ...MERGE_QUEUE_SENDER } });
}
