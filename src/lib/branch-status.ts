// A session row's branch status in the sessions pane: the very headline its chat's composer status row says
// (WorktreesControl: needs you > needs a fix > ready > checking > queued > "N worktrees"), from the same rule
// (merge-queue.ts rowKeyOf, queueRow, headline) over the same rows. Pure: no Solid, no DOM.
import type { SessionBranchRow, SessionSummary } from "../../shared/protocol";
import { headline, queueRow, type HeadlineKind, type QueueRow, type QueueRowInput } from "./merge-queue";
import { afterMergeLines, branchStatusLine } from "./readiness";

/** A row's branches as its chat's rows: each with its readiness, joined by path as the chat joins it (an inherited
    tree has none, in the chat too). The server leaves dropped ones out, as the chat's control does. */
export function chatRowsOf(s: Pick<SessionSummary, "branches" | "readiness">): QueueRowInput[] {
  return (s.branches ?? []).map((b: SessionBranchRow) => {
    const readiness = s.readiness?.trees.find((t) => t.path === b.path);
    return { ...b, ...(readiness ? { readiness } : {}) };
  });
}

/** How each fact is marked: a symbol of its own (colour is never the only signal) and a tone. */
export const STATUS_MARK: Record<HeadlineKind, { icon: "alert-triangle" | "alert-circle" | "check-circle" | "progress" | "clock" | "branch"; tone: "error" | "warn" | "success" | "accent" | "info" | "muted" }> = {
  fix: { icon: "alert-triangle", tone: "error" },
  you: { icon: "alert-circle", tone: "warn" },
  ready: { icon: "check-circle", tone: "success" },
  checking: { icon: "progress", tone: "accent" },
  queued: { icon: "clock", tone: "info" },
  worktrees: { icon: "branch", tone: "muted" },
};

export interface RowBranchStatus {
  kind: HeadlineKind;
  /** The number the row shows. */
  n: number;
  /** The chat's words: "1 needs a fix". */
  text: string;
  icon: (typeof STATUS_MARK)[HeadlineKind]["icon"];
  tone: (typeof STATUS_MARK)[HeadlineKind]["tone"];
  /** The chat's words, then a line per branch in the Worktrees window's words, then what follows a merge. */
  lines: string[];
}

/** One branch in the Worktrees window's words: "feat/login: Needs a fix · <reason>". */
export const branchLine = (branch: string, r: Pick<QueueRow, "label" | "reason">): string => {
  const reason = r.reason?.replace(/\s*\n\s*/g, " · ").trim();
  return `${branch}: ${r.label}${reason ? ` · ${reason}` : ""}`;
};

/** The row's status, or null when the session tracks no branch (the row shows nothing). */
export function rowBranchStatus(s: Pick<SessionSummary, "branches" | "readiness">): RowBranchStatus | null {
  const inputs = chatRowsOf(s);
  const rows = inputs.map((w) => queueRow(w));
  const h = headline(rows);
  if (!h) return null;
  const status = branchStatusLine(s.readiness?.status);
  const lines = [h.text, ...inputs.map((w, i) => branchLine(w.branch, rows[i]!)), ...(status ? [status] : []), ...afterMergeLines(s.readiness)];
  return { kind: h.kind, n: h.n, text: h.text, ...STATUS_MARK[h.kind], lines };
}
