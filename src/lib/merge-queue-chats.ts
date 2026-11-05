// The words of the Merge Queue tab's own-chat surfaces (§app.merge-queue/view): the Merge thread card, the head's
// running-review button, the History rows and the reviewer links on runs. Pure, so they run under tsx --test.
import type { MergeQueueChat, MergeQueueView, MergeThreadInfo } from "../../shared/merge-queue";
import { MEMORY_TYPE_INFO } from "../../shared/memory";

/** The memory type's display name ("UniiChat"), or "No memory". */
export function memoryWords(type: string | undefined): string {
  if (!type) return "No memory";
  return MEMORY_TYPE_INFO.find((m) => m.id === type)?.label ?? type;
}

/** The card's state chip. */
export function threadStateChip(t: Pick<MergeThreadInfo, "state">): { label: string; tone: "neutral" | "info" | "warn"; live?: boolean } {
  if (t.state === "asking") return { label: "Asking you", tone: "warn" };
  if (t.state === "working") return { label: "Working", tone: "info", live: true };
  return { label: "Idle", tone: "neutral" };
}

const EVENT_WORDS: Record<string, string> = { queued: "Read a queued branch", conflict: "Judged a conflict", failed: "Explained a failure", paused: "Told of a pause", names: "Asked for private names", answer: "Took your answer", idle: "Told the queue is idle" };

/** The last event, in words: "Read a queued branch · feat/x". */
export function lastEventWords(e: MergeThreadInfo["lastEvent"]): string | null {
  if (!e) return null;
  return `${EVENT_WORDS[e.kind] ?? e.kind}${e.branch ? ` · ${e.branch}` : ""}`;
}

/** The head's running-review button: "Review running · feat/x · Open" (a retry names its attempt). */
export function reviewingWords(r: NonNullable<MergeQueueView["reviewing"]>): string {
  return `Review running · ${r.branch}${r.attempt > 1 ? ` (attempt ${r.attempt})` : ""} · Open`;
}

export type HistoryFilter = "all" | "threads" | "reviews";

/** The History's rows for a filter, in the view's order (newest first). */
export function historyRows(chats: readonly MergeQueueChat[] | undefined, filter: HistoryFilter): MergeQueueChat[] {
  const all = chats ?? [];
  return filter === "all" ? [...all] : all.filter((c) => (filter === "threads" ? c.kind === "thread" : c.kind === "reviewer"));
}

/** Rows Clear All would delete: never the current thread, a running reviewer or one already cleared. */
export const clearableRows = (chats: readonly MergeQueueChat[] | undefined): MergeQueueChat[] => (chats ?? []).filter((c) => !c.current && !c.running && !c.cleared);

const VERDICT: Record<string, string> = { ok: "ok", notes: "notes", blocking: "blocking", failed: "no verdict" };

/** A History row's title and facts. */
export function historyWords(c: MergeQueueChat): { title: string; facts: string } {
  if (c.kind === "thread") {
    const title = c.current ? "Merge thread (current)" : "Merge thread";
    const facts = [memoryWords(c.memory), c.endedAt ? `ended: ${c.why ?? "replaced"}` : null, c.cleared ? "chat cleared" : null].filter(Boolean).join(" · ");
    return { title, facts };
  }
  const title = `Review · ${c.branch ?? "a branch"}${c.attempt && c.attempt > 1 ? ` · attempt ${c.attempt}` : ""}`;
  const facts = [c.running ? "running" : `Review: ${VERDICT[c.verdict ?? "failed"]}`, c.run ?? null, c.cleared ? "Reviewer chat cleared" : null].filter(Boolean).join(" · ");
  return { title, facts };
}

/** A run's reviewer chats, oldest attempt first (the run rows' and the run page's links). */
export function reviewersOfRun(chats: readonly MergeQueueChat[] | undefined, run: string | undefined): MergeQueueChat[] {
  if (!run) return [];
  return (chats ?? []).filter((c) => c.kind === "reviewer" && c.run === run).sort((a, b) => (a.attempt ?? 1) - (b.attempt ?? 1));
}

/** One reviewer link's words: "Review: ok · Open Reviewer Chat", "Review running · Open Reviewer Chat"; a cleared one has no link. */
export function reviewerLinkWords(c: MergeQueueChat, many: boolean): { lead: string; link: string | null } {
  const attempt = many ? ` (attempt ${c.attempt ?? 1})` : "";
  const lead = c.running ? `Review running${attempt}` : `Review${attempt}: ${VERDICT[c.verdict ?? "failed"]}`;
  return c.cleared ? { lead: `${lead} · Reviewer chat cleared`, link: null } : { lead, link: "Open Reviewer Chat" };
}
