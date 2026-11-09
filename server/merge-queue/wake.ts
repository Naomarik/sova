import { randomBytes } from "node:crypto";
import { MERGE_QUEUE_SENT_PREFIX } from "../../shared/merge-queue";
import { MERGE_REQUEST_ID_RE } from "../../shared/topic-message";
import type { SessionSummary } from "../../shared/protocol";
import { MERGE_QUEUE_SESSION } from "../../shared/senders";
import { ARCHIVED_REFUSAL } from "../archived-sessions";

/**
 * The one way the merge queue (and readiness's ready-to-land notes) reaches a chat (§chat.merge-queue/requests): a
 * request, pushed onto the merge queue's chat queue Sova opens in that chat (server/topics.ts pushMergeRequest), from
 * the reserved sender "Merge queue". It arrives as one batch between turns, framed as requests the chat may act on
 * with its own user first, never a message typed by the user: the batch's "[topic " start and its delivered marker
 * keep the worktree tool's `land` from ever reading it as the user's word. Each request has an id (`rq_…`), returned
 * here, that the chat's answer names. Throws when the chat can't take notes (a terminal holds it, it is archived, an
 * Overseer's, a project overseer's, a baton's, one of the queue's own): the caller keeps today's fallback instead.
 *
 * A subagent's own session never takes a message: a wake for one goes to the chat that runs it (up through workers of
 * workers to the top chat), once, its text naming the worker. No running chat known, or one that can't take it: it
 * throws like any other refusal, so the line stays hidden instead and nothing is sent twice.
 */
export const MERGE_QUEUE_SENDER = { sessionId: MERGE_QUEUE_SESSION, title: "Merge queue", hop: 0 } as const;

/** What a request says about itself beyond its words (§chat.merge-queue/requests). */
export interface MergeRequestInfo {
  /** The request's id (`rq_…`); one is made when absent. */
  id?: string;
  /** What kind of request: needs-fix, sent-back, blocked, drafts, ask, trial, … (free words, kept on the note). */
  kind?: string;
  /** The branch it is about; absent for a question about no branch. */
  branch?: string;
  /** The words of that branch's place (§chat.worktrees/place). */
  place?: string;
  /** The queue entry it is about (Remove from Queue drops its undelivered requests). */
  entry?: string;
}

export interface WakeDeps {
  summary: (path: string) => Promise<SessionSummary | null>;
  /** The session that runs worker `path` (a live record listing it, or a completion naming it); null: none known. */
  parentOf: (path: string) => Promise<string | null>;
  /** Push the request to the chat at `path` (session `sessionId`); returns its id. */
  send: (path: string, text: string, req: MergeRequestInfo & { sessionId: string }) => Promise<string | void>;
}

/** Workers of workers this deep at most: past it the chain is taken as broken. */
const MAX_HOPS = 8;

async function defaultDeps(): Promise<WakeDeps> {
  const { getSessionSummary, workerParentOf } = await import("../sessions-index");
  return {
    summary: (p) => getSessionSummary(p),
    parentOf: (p) => workerParentOf(p),
    send: async (p, text, req) => {
      const { pushMergeRequest } = await import("../topics");
      return pushMergeRequest({ sessionId: req.sessionId, path: p }, { ...req, text }).id;
    },
  };
}

/** The request's words as its note keeps them: without the old `[merge-queue]` prefix (the batch says whose it is). */
export const requestBody = (text: string): string => (text.trimStart().startsWith(MERGE_QUEUE_SENT_PREFIX) ? text.trimStart().slice(MERGE_QUEUE_SENT_PREFIX.length) : text).trim();


/** A wake's text addressed to the chat running `worker`: still the queue's, naming the worker first. */
export function forWorkerText(text: string, worker: Pick<SessionSummary, "id" | "title">): string {
  const body = text.startsWith(MERGE_QUEUE_SENT_PREFIX) ? text.slice(MERGE_QUEUE_SENT_PREFIX.length).trimStart() : text;
  const name = worker.title?.trim() || `session ${worker.id.slice(0, 8)}`;
  return `${MERGE_QUEUE_SENT_PREFIX} For your worker "${name}" (its branch is the queue's to tell it about, but a worker takes no message): ${body}`;
}

/** A request to the chat that owns `sessionPath`'s branch (§chat.merge-queue/requests): its id. */
export async function sendMergeRequest(sessionPath: string, req: MergeRequestInfo & { text: string }, deps?: WakeDeps): Promise<string> {
  const { text, ...info } = req;
  return sendQueueWake(sessionPath, text, deps, info);
}

export async function sendQueueWake(sessionPath: string, text: string, deps?: WakeDeps, info: MergeRequestInfo = {}): Promise<string> {
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
  if (s.overseer || s.baton || s.queueChat || (await isProjectOverseer(s.path, !!deps))) throw new Error("That chat takes no merge queue message.");
  const id = info.id && MERGE_REQUEST_ID_RE.test(info.id) ? info.id : `rq_${randomBytes(6).toString("hex")}`;
  const said = await d.send(s.path, requestBody(worker ? forWorkerText(text, worker) : text), { ...info, id, sessionId: s.id });
  return typeof said === "string" ? said : id;
}

async function isProjectOverseer(path: string, injected: boolean): Promise<boolean> {
  if (injected) return false;
  const { projectOverseerOfPath } = await import("../project-overseer-store");
  return !!projectOverseerOfPath(path);
}
