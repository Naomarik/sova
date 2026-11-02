import { join } from "node:path";
import { type MergeEntry, type MergeRun, newerWords } from "../../shared/merge-queue";

/**
 * The words of what the queue tells a branch's own chat (server/merge-queue/cards.ts: its card, its hidden line, the
 * wake of a hand-back): its landing, a hand-back (a failure that is the branch's, a conflict sent back, the user's
 * Send Back), or that its drafts changed since the approval.
 * Machine / setup / reviewer failures and master's own reds are never sent to a branch. No word about restarting or
 * anything "live": the landing's note (the merge thread's) says what matters after it.
 */

/** `approved`: Land or a typed "land it" put the branch in line (its chat's card appears). */
export type MergeNoticeKind = "approved" | "landed" | "needs-fix" | "sent-back" | "drafts-changed" | "explained";

const short = (sha: string | undefined) => (sha ?? "").slice(0, 7);

export function noticeText(kind: MergeNoticeKind, e: MergeEntry, extra: { run?: MergeRun; logDir?: string } = {}): string {
  switch (kind) {
    case "landed": {
      const lines = [`${e.branch} landed on ${e.target} at ${short(e.landed?.sha)} (the commit you approved, ${short(e.commit)}).`];
      const newer = newerWords(e.newerCommits);
      if (newer) lines.push(`${newer[0]!.toUpperCase()}${newer.slice(1)}: Land again to bring ${e.newerCommits === 1 ? "it" : "them"} in.`);
      const thread = e.notes.find((n) => n.kind === "thread" || n.kind === "operator");
      if (thread) lines.push(`Note: ${thread.text}`);
      for (const n of e.notes.filter((x) => x.kind !== "thread" && x.kind !== "operator")) lines.push(`${n.kind === "flaky" ? "Flaky" : n.kind === "master-red" ? `Red on ${e.target} too` : n.kind === "review" ? "Review" : n.kind === "resolved" ? "Resolved" : "Note"}: ${n.text}`);
      if (e.landed?.pushed === "not-pushed" && e.landed.pushWhy) lines.push(`Not pushed: ${e.landed.pushWhy}.`);
      return lines.join("\n");
    }
    case "needs-fix": {
      const run = extra.run;
      const failed = run?.steps.filter((s) => s.result === "failed") ?? [];
      const lines = [`${e.branch} didn't land: ${e.reason ?? "a check failed with your branch"}.`];
      if (failed.length) {
        for (const s of failed.slice(0, 4)) {
          const f = s.failures?.filter((x) => x.blame === "branch" || !x.blame).slice(0, 3) ?? [];
          lines.push(`- ${s.label}${s.detail ? `: ${s.detail}` : ""}${f.length ? ` (${f.map((x) => [x.file, x.name].filter(Boolean).join(" › ")).join("; ")})` : ""}${extra.logDir ? ` · log ${join(extra.logDir, s.log)}` : ""}`);
          for (const x of f) if (x.message) lines.push(`  ${x.message.split("\n")[0]!.slice(0, 240)}`);
        }
      }
      if (run && run.verdict === "conflict") lines.push(`Merge ${e.target} into ${e.branch}, resolve the conflicts, commit, and ask the user to land it again.`);
      else lines.push(`It passes on ${e.target} alone in the same copy, so it is this branch's to fix. Fix it, commit, and ask the user to land it again.`);
      return lines.join("\n");
    }
    case "sent-back": {
      const lines = [`The user sent ${e.branch} back: ${e.reason ?? "it needs another look"}.`];
      if (e.conflict) {
        lines.push(`${e.target}'s side: ${e.conflict.ours}`, `This branch's side: ${e.conflict.theirs}`, `Proposed: ${e.conflict.proposal}`);
        lines.push(`Merge ${e.target} into ${e.branch}, resolve it the way the user wants, commit, and ask them to land it again.`);
      } else if (e.review?.text) lines.push(`The review: ${e.review.text}`, "Address it, commit, and ask the user to land it again.");
      else lines.push("Look at it, commit, and ask the user to land it again.");
      return lines.join("\n");
    }
    case "explained": {
      const n = e.notes.find((x) => x.kind === "thread");
      return `The merge thread on why ${e.branch} didn't land: ${n?.text ?? e.reason ?? ""}`;
    }
    case "approved":
      return `${e.branch} at ${short(e.commit)} is in line to land on ${e.target}.`;
    case "drafts-changed":
      return `${e.branch}'s spec drafts changed since the user approved it at ${short(e.commit)}, so it waits: the user lands it again once the drafts are as they want them.`;
  }
}
