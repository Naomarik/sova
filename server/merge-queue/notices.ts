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
/** `request`: a request of the branch's chat other than a fix (extra.request: blocked, the thread's other approach or
 *  its diagnosis), whose text is the request's own. `decision`: a decision waits for the user (entry.decision): its card moves down. */
export type MergeNoticeKind = "approved" | "landed" | "needs-fix" | "sent-back" | "drafts-changed" | "explained" | "requested" | "pushed" | "closed" | "removed" | "request" | "decision" | "nothing-to-land";

const short = (sha: string | undefined) => (sha ?? "").slice(0, 7);

/** Land, typed words, `merge.add` and a run that finds it so all say this (§app.merge-queue/approve). */
export const nothingToLandWords = (target: string): string => `Nothing to land: everything on this branch is already on ${target}.`;

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
      // A standing Land (al_3) is never asked for again: its fix goes back in line by itself. Only an entry with no
      // standing approval (a release's hand-back, or one approved before al_3) needs the user's next Land.
      const again = e.approval.standing ? "the user's Land stands: once the merge thread checks your fix, it goes back in line by itself" : "it needs the user's Land again once your fix is committed and finished";
      if (e.sentBackFor === "drafts") lines.push(`Fix them in your drafts on ${e.branch}: that needs no commit. ${again[0]!.toUpperCase()}${again.slice(1)}.`);
      else if (run && run.verdict === "conflict") lines.push(`Merge ${e.target} into ${e.branch}, resolve the conflicts and commit: ${again}.`);
      else lines.push(`It passes on ${e.target} alone in the same copy, so it is this branch's to fix. Fix it and commit: ${again}.`);
      return lines.join("\n");
    }
    case "sent-back": {
      // Send Back is retired (al_3): only an entry sent back before it can still read this, and it has no standing Land.
      const lines = [`The user sent ${e.branch} back: ${e.reason ?? "it needs another look"}.`];
      if (e.conflict) {
        lines.push(`${e.target}'s side: ${e.conflict.ours}`, `This branch's side: ${e.conflict.theirs}`, `Proposed: ${e.conflict.proposal}`);
        lines.push(`Merge ${e.target} into ${e.branch}, resolve it the way the user wants, and commit: it needs the user's Land again once your fix is committed and finished.`);
      } else if (e.review?.text) lines.push(`The review: ${e.review.text}`, "Address it and commit: it needs the user's Land again once your fix is committed and finished.");
      else lines.push("Look at it and commit: it needs the user's Land again once your fix is committed and finished.");
      return lines.join("\n");
    }
    case "explained": {
      const n = e.notes.find((x) => x.kind === "thread");
      return `The merge thread on why ${e.branch} didn't land: ${n?.text ?? e.reason ?? ""}`;
    }
    case "approved":
      return `${e.branch} at ${short(e.commit)} is in line to land on ${e.target}. Leave it alone until it lands: don't merge ${e.target} into it. The queue handles any conflict and asks for any fix it needs. Real new commits are fine: they stay on the branch as new work for a later Land.`;
    case "nothing-to-land":
      return e.reason ?? nothingToLandWords(e.target);
    case "requested":
      return `${e.branch} passed Sova's checks and its request is open on the host${e.request?.url ? ` (${e.request.url})` : ""}; it lands when the host merges it.`;
    case "pushed":
      return `${e.branch} passed Sova's checks and was pushed to origin at ${short(e.request?.publishedHead)}; open its request on the host.`;
    case "closed":
      return `${e.branch}'s request was closed on the host without merging; land it again to open or update it.`;
    case "drafts-changed":
      return `${e.branch}'s spec drafts changed since the user approved it at ${short(e.commit)}, so it waits: the user lands it again once the drafts are as they want them.`;
    case "request":
      return e.requests?.[e.requests.length - 1]?.text ?? `${e.branch} is approved, but something still keeps it out of line: ${e.reason ?? "see its card"}.`;
    case "decision":
      return `${e.branch} waits for the user's decision: ${e.decision?.question ?? e.reason ?? "see its card"}`;
    case "removed":
      return `The user removed ${e.branch} from the merge queue at ${short(e.commit)}; nothing of the branch was deleted.`;
  }
}
