/**
 * The branch's chat's answers to the merge queue's requests (§chat.merge-queue/answers) that no queue entry holds:
 * the ones Sova makes of a finished branch before any Land (its spec drafts that don't fit, what blocks it;
 * §chat.worktrees/ready-to-land), kept in the ready-to-land store. Requests an entry holds are the queue's
 * (queue.ts respond). Nothing here parses a chat's reply: the chat answers with merge.respond.
 */
import type { MergeChatRequest } from "../../shared/merge-queue";
import { fileLandingStore, type LandingStore } from "../ready-to-land";
import { MergeFailure } from "./queue";

/** A before-Land request reached the chat `to` (a worker's: the chat running the worker): it may answer too. */
export function looseDelivered(id: string, to: string, store: LandingStore = fileLandingStore()): boolean {
  if (!store.ask(id)) return false;
  store.delivered(id, to);
  return true;
}

/** Whether `id` is a before-Land request. */
export const isLooseRequest = (id: string, store: LandingStore = fileLandingStore()): boolean => !!store.ask(id);

/**
 * merge.respond on a before-Land request: only the chat it went to, once. Fixed needs nothing more (readiness reads the
 * drafts and the branch again by itself); Can't is shown on the Landing specs chip; Needs you is recorded (with no
 * Land there is no card: the chat asks its user itself).
 */
export function answerLoose(id: string, from: string | null, a: { answer: string; text?: string }, store: LandingStore = fileLandingStore(), now: () => number = Date.now): MergeChatRequest {
  const r = store.ask(id);
  if (!r) throw new MergeFailure("not-found", `no merge queue request ${id}`);
  if (!from || (from !== r.session && from !== r.to)) throw new MergeFailure("forbidden", "only the chat the request was sent to answers it");
  if (r.answer) throw new MergeFailure("invalid-request", `request ${id} is answered already (${r.answer.kind})`);
  if (a.answer !== "fixed" && a.answer !== "needs-you" && a.answer !== "cant") throw new MergeFailure("invalid-request", 'answer is "fixed", "needs-you" or "cant"');
  const text = a.text?.trim() ?? "";
  if (text.length > 2000) throw new MergeFailure("invalid-request", "keep the answer under 2000 characters");
  if ((a.answer === "cant" || a.answer === "needs-you") && !text) throw new MergeFailure("invalid-request", a.answer === "cant" ? "say why you can't (text)" : "say the question for your user (text)");
  const at = now();
  store.answer(id, { kind: a.answer, text: text || "fixed", at });
  const iso = new Date(at).toISOString();
  return {
    id,
    kind: r.kind,
    entry: "",
    branch: "",
    session: r.session,
    ...(r.to ? { to: r.to } : {}),
    text: "",
    at: new Date(r.at).toISOString(),
    answer: a.answer === "fixed" ? { kind: "fixed", changed: r.kind === "drafts" ? "drafts" : "commit", summary: text || "fixed", at: iso } : a.answer === "cant" ? { kind: "cant", why: text, at: iso } : { kind: "needs-you", question: text, options: [], at: iso },
  };
}

/** The answer line a batch of merge queue requests carries (one source: shared/topic-message.ts). */
export { MERGE_QUEUE_ANSWER_LINE as MERGE_ANSWER_LINE } from "../../shared/topic-message";
