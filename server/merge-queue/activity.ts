import type { MergeChatRequest, MergeEntry, MergeEventInput, MergeRun, PauseInfo, RestartCause, RunStep } from "../../shared/merge-queue";
import type { MergeNoticeKind } from "./notices";

/**
 * The words of the event memory (§app.merge-queue/activity): which recorded change each queue act is, in one plain
 * sentence. Pure: the queue (queue.ts record) persists them through events.ts.
 */

const short = (sha: string | undefined): string => (sha ?? "").slice(0, 7);
const firstLine = (t: string | undefined, n = 200): string => {
  const l = (t ?? "").split("\n")[0]!.trim();
  return l.length > n ? `${l.slice(0, n - 1).trimEnd()}…` : l;
};
const byWords: Record<MergeEntry["approval"]["by"], string> = { "land-button": "Land", typed: "“land it” typed in its chat", release: "the release" };
const ref = (e: Pick<MergeEntry, "id" | "branch">) => ({ entry: e.id, branch: e.branch });

/** The event a notice to the branch's chat stands for (the notify wrapper records it), or null: not one of its own. */
export function noticeEvent(kind: MergeNoticeKind, e: MergeEntry, extra: { run?: MergeRun; request?: MergeChatRequest; press?: string }): MergeEventInput | null {
  const run = extra.run?.id ?? e.run;
  switch (kind) {
    case "approved": {
      // A Land press (or typed word) carries its time; a re-queue by itself is a checked fix moving the approval on.
      const via = extra.press ? e.approval.by : "fix";
      return { kind: "approved", by: via === "fix" ? "queue" : via === "release" ? "release" : "user", ...ref(e), commit: e.commit, via, why: via === "fix" ? `Back in line at ${short(e.commit)}: the merge thread checked the fix, and the user's Land stands.` : `Approved at ${short(e.commit)} by ${byWords[via]}.` };
    }
    case "landed":
      return { kind: "landed", by: "queue", ...ref(e), ...(run ? { run, step: "land" } : {}), sha: e.landed?.sha ?? "", from: e.landed?.from ?? "", why: e.landed?.via === "host" ? `The host merged it into ${e.target} as ${short(e.landed?.sha)}.` : `Landed on ${e.target} as ${short(e.landed?.sha)}.` };
    case "removed":
      return { kind: "cancelled", by: "user", ...ref(e), why: `Removed from the queue at ${short(e.commit)}.` };
    case "nothing-to-land":
      return { kind: "cancelled", by: "queue", ...ref(e), ...(run ? { run } : {}), why: firstLine(e.reason) || `Nothing to land: everything on ${e.branch} is already on ${e.target}.` };
    case "decision":
      return e.decision ? { kind: "decision", by: e.decision.raisedBy === "merge-thread" ? "thread" : e.decision.raisedBy === "chat" ? "chat" : "queue", ...ref(e), ...(e.decision.run ? { run: e.decision.run } : {}), decision: e.decision.id, decisionKind: e.decision.kind, why: `Waits for the user: ${firstLine(e.decision.question)}` } : null;
    case "needs-fix": {
      const r = extra.request;
      const cause = r?.cause ?? e.sentBackFor ?? "checks";
      const tries = r?.try ? ` (try ${r.try} of ${e.tries?.max ?? 3})` : "";
      return { kind: "sent-back", by: "queue", ...ref(e), ...(run ? { run } : {}), cause, ...(r ? { request: r.id } : {}), ...(r?.try ? { try: r.try, of: e.tries?.max ?? 3 } : {}), why: `Sent back to its chat${tries}: ${firstLine(e.reason) || cause}.` };
    }
    case "request": {
      const r = extra.request;
      return r ? { kind: "note", by: "queue", ...ref(e), note: `request:${r.kind}`, why: `Asked its chat: ${firstLine(r.text)}` } : null;
    }
    case "drafts-changed":
      return { kind: "note", by: "queue", ...ref(e), note: "drafts-changed", why: "Its spec drafts changed since the user approved it: it waits for a new Land." };
    case "requested":
      return { kind: "pushed", by: "queue", ...ref(e), ...(run ? { run } : {}), sha: e.request?.publishedHead ?? "", why: `Its request is open on the host${e.request?.number ? ` (#${e.request.number})` : ""}.` };
    case "pushed":
      return { kind: "pushed", by: "queue", ...ref(e), ...(run ? { run, step: "push" } : {}), sha: e.request?.publishedHead ?? "", why: `The branch was pushed at ${short(e.request?.publishedHead)}; its request is the user's to open.` };
    case "closed":
      return { kind: "note", by: "queue", ...ref(e), note: "closed", why: "Its request was closed on the host without merging." };
    default:
      return null;
  }
}

/** The restart cause of a run the queue voided (`voidWhy`), or of a run that answered void itself (`why`). */
export function restartCauseOf(voidWhy: string | null, why?: string): RestartCause {
  switch (voidWhy) {
    case "master-moved":
      return "target-moved";
    case "stopping":
      return "server-stopped";
    case "release":
      return "release";
    case "superseded":
      return "superseded";
  }
  return /timed out|time limit/i.test(why ?? "") ? "timed-out" : "aborted";
}

const causeWords: Record<RestartCause, string> = {
  "target-moved": "the target moved outside the queue",
  "server-stopped": "Sova stopped",
  "timed-out": "a step ran past its time limit",
  "machine-retry": "a machine failure, tried once more",
  release: "a release started",
  superseded: "it was approved again at a newer commit",
  "clean-run": "a Clean Run started it again",
  aborted: "the run was stopped",
};

/** Count one restart on the entry (persisted with it) and answer its event. */
export function countRestart(e: MergeEntry, cause: RestartCause, run: string | undefined, why?: string): MergeEventInput {
  const restarts = { ...(e.restarts ?? {}) };
  restarts[cause] = (restarts[cause] ?? 0) + 1;
  e.restarts = restarts;
  const n = restarts[cause]!;
  return { kind: "run-restarted", by: "queue", ...ref(e), ...(run ? { run } : {}), cause, count: n, why: `Run restarted: ${why ? firstLine(why) : causeWords[cause]}${n > 1 ? ` (${n}× for this reason)` : ""}.` };
}

/** A pause's event: the operator's, or the queue pausing itself. */
export function pauseEvent(p: PauseInfo): MergeEventInput {
  return { kind: "paused", by: p.self ? "queue" : "user", ...(p.run ? { run: p.run } : {}), pause: p.kind, self: !!p.self, why: `${p.self ? "The queue paused itself" : "Paused"}: ${firstLine(p.why, 260)}` };
}

const verdictWords: Record<string, string> = {
  passed: "passed",
  failed: "failed",
  conflict: "conflicted",
  waiting: "waits for a decision",
  machine: "couldn't run (the machine, not the branch)",
  void: "was voided",
  cancelled: "was cancelled",
};

export function runEndedEvent(e: Pick<MergeEntry, "id" | "branch">, run: MergeRun): MergeEventInput {
  return { kind: "run-ended", by: "queue", ...ref(e), run: run.id, verdict: run.verdict, ...(run.blame ? { blame: run.blame } : {}), why: `Run ${verdictWords[run.verdict] ?? run.verdict}${run.why ? `: ${firstLine(run.why)}` : "."}` };
}

/** A step that just reached its end (passed, failed or skipped): its event, naming the plan step it carries out. */
export function stepEvent(e: Pick<MergeEntry, "id" | "branch">, run: string, s: RunStep): MergeEventInput {
  const word = s.result === "passed" ? "passed" : s.result === "failed" ? "failed" : "skipped";
  return { kind: "step-ended", by: "queue", ...ref(e), run, step: s.plan ?? s.id, runStep: s.id, result: s.result, ms: s.ms, why: `${s.label} ${word}${s.detail ? `: ${firstLine(s.detail)}` : "."}` };
}

/** Is this a step's first arrival at an end (the step hook sends every change, its end once)? */
export const stepEnded = (before: RunStep | undefined, now: RunStep): boolean => (now.result === "passed" || now.result === "failed" || now.result === "skipped") && (!before || before.result !== now.result);
