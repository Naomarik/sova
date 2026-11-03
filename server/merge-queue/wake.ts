import { MERGE_QUEUE_SENT_PREFIX } from "../../shared/merge-queue";
import type { SessionSummary } from "../../shared/protocol";
import { MERGE_QUEUE_SESSION } from "../../shared/senders";
import { ARCHIVED_REFUSAL } from "../archived-sessions";

/**
 * The one way the merge queue (and readiness's ready-to-land wakes) starts a turn in a chat: a normal message, queued
 * after a turn in flight, whose text starts with MERGE_QUEUE_SENT_PREFIX (the page draws it as the merge queue's) and
 * which carries the chat's "another session" sender marker, titled "Merge queue". The marker is what keeps it from
 * ever being read as the user's own word, in every chat, including chats started before the prefix was known: the
 * worktree tool's `land` refuses a marked message whatever it says. Throws when the chat can't take it (a terminal
 * holds it, it is archived, an Overseer's, a baton's): the caller keeps it as the chat's hidden line instead.
 *
 * A subagent's own session never takes a message: a wake for one goes to the chat that runs it (up through workers of
 * workers to the top chat), once, its text naming the worker. No running chat known, or one that can't take it: it
 * throws like any other refusal, so the line stays hidden instead and nothing is sent twice.
 */
export const MERGE_QUEUE_SENDER = { sessionId: MERGE_QUEUE_SESSION, title: "Merge queue", hop: 0 } as const;

export interface WakeDeps {
  summary: (path: string) => Promise<SessionSummary | null>;
  /** The session that runs worker `path` (a live record listing it, or a completion naming it); null: none known. */
  parentOf: (path: string) => Promise<string | null>;
  send: (path: string, text: string) => Promise<void>;
}

/** Workers of workers this deep at most: past it the chain is taken as broken. */
const MAX_HOPS = 8;

async function defaultDeps(): Promise<WakeDeps> {
  const [{ getSessionSummary, workerParentOf }, { acquireChatHandle }] = await Promise.all([import("../sessions-index"), import("../chat-handle")]);
  return {
    summary: (p) => getSessionSummary(p),
    parentOf: (p) => workerParentOf(p),
    send: async (p, text) => {
      const chat = await acquireChatHandle(p);
      await chat.send({ text, origin: "server", checkModel: true, delivery: "followUp", sentBySession: { ...MERGE_QUEUE_SENDER } });
    },
  };
}

/** A wake's text addressed to the chat running `worker`: still the queue's, naming the worker first. */
export function forWorkerText(text: string, worker: Pick<SessionSummary, "id" | "title">): string {
  const body = text.startsWith(MERGE_QUEUE_SENT_PREFIX) ? text.slice(MERGE_QUEUE_SENT_PREFIX.length).trimStart() : text;
  const name = worker.title?.trim() || `session ${worker.id.slice(0, 8)}`;
  return `${MERGE_QUEUE_SENT_PREFIX} For your worker "${name}" (its branch is the queue's to tell it about, but a worker takes no message): ${body}`;
}

export async function sendQueueWake(sessionPath: string, text: string, deps?: WakeDeps): Promise<void> {
  const d = deps ?? (await defaultDeps());
  const own = await d.summary(sessionPath);
  if (!own) throw new Error("Session file not found");
  const worker = own.workerSession ? own : null;
  let s: SessionSummary = own;
  for (let hops = 0; s.workerSession; hops++) {
    const parent: string | null = hops < MAX_HOPS ? await d.parentOf(s.path) : null;
    const up: SessionSummary | null = parent ? await d.summary(parent) : null;
    if (!up) throw new Error(`"${s.title}" is a subagent's own session and no session that runs it is known.`);
    s = up;
  }
  if (s.live) throw new Error(`It is open in a terminal (pid ${s.live.pid}), so this server must not write to it.`);
  if (s.archived) throw new Error(ARCHIVED_REFUSAL);
  if (s.overseer || s.baton || (await isProjectOverseer(s.path, !!deps))) throw new Error("That chat takes no merge queue message.");
  await d.send(s.path, worker ? forWorkerText(text, worker) : text);
}

async function isProjectOverseer(path: string, injected: boolean): Promise<boolean> {
  if (injected) return false;
  const { projectOverseerOfPath } = await import("../project-overseer-store");
  return !!projectOverseerOfPath(path);
}
