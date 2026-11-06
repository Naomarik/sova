// A project's coding-worktree row menu (§app.project-overseer/coding-worktrees "The project page
// lists them"), as one declaration (lib/menu-place): its ⋯ and a right-click or Shift+F10 on the row
// both draw it, each row with its reason before the press. Merge Branch, or Land once the
// project's merge queue is set up; then Remove Worktree…, whose confirmation opens under the row.

import type { WorktreeQueueInfo } from "../../shared/merge-queue";
import type { CodingRow, Gate } from "./coding-worktrees";
import { entryLandBlock } from "./merge-queue";
import type { MenuDecl, MenuItem } from "./menu-place";

/** What the row's menu reads: the row, its gestures (lib/coding-worktrees `rowGestures`), the queue. */
export interface WorktreeMenuFacts {
  /** The project's id. */
  project: string;
  row: CodingRow;
  /** The row's title as it shows (an untitled one's placeholder included). */
  title: string;
  gestures: { merge: Gate | false; remove: Gate | false };
  /** The project's merge queue is set up: Land replaces Merge Branch. */
  queued: boolean;
  /** The branch's own queue entry, if any. */
  queue: WorktreeQueueInfo | undefined;
  /** A gesture on one of the page's rows is in flight. */
  working: boolean;
}

/** What the rows do, on the row as it reads when one is chosen; `send` is the row's command. */
export interface WorktreeMenuActs {
  merge(send: () => Promise<unknown>): void;
  /** Queue the branch to land at the head this page read. */
  land(send: () => Promise<unknown>): void;
  /** Ask Remove Worktree's question under the row. */
  remove(): void;
}

/** The row has a menu at all: neither gesture offered, no ⋯ and no right-click menu. */
export const worktreeMenuOffered = (g: WorktreeMenuFacts["gestures"]) => g.merge !== false || g.remove !== false;

export const WORKTREE_MENU: MenuDecl<{ facts: WorktreeMenuFacts; acts: WorktreeMenuActs }> = {
  label: ({ facts }) => `Actions · ${facts.title}`,
  table: ({ facts: f, acts }) => {
    const { row, gestures: g, working } = f;
    const rows: MenuItem[] = [];
    // The head this page read (CodingWorktree.head): the queue pins it, never a newer one.
    const land = { command: "project.verb.merge.add", params: { checkout: row.worktree, commit: row.head }, via: acts.land };
    if (g.merge !== false) {
      if (!f.queued)
        rows.push({
          label: "Merge Branch",
          aria: `Merge Branch: ${row.branch} into ${row.target}`,
          icon: "branch",
          description: `${row.branch} into ${row.target}`,
          disabled: (g.merge || undefined) ?? (working ? "Working" : undefined),
          act: { command: "project.worktree.merge", params: { pid: f.project, "session-id": row.sessionId }, via: acts.merge },
        });
      else
        rows.push({
          label: "Land",
          aria: `Land ${row.branch} on ${row.target}`,
          icon: "branch",
          description: `Queues ${row.branch}: checked on ${row.target} first, then ${row.target} moves to it.`,
          disabled: (g.merge || undefined) ?? (working ? "Working" : !row.worktree ? "Its folder is gone: land it from its chat." : entryLandBlock(f.queue)),
          act: land,
        });
    }
    // Its question opens under the row, whose button sends project.worktree.remove.
    if (g.remove !== false)
      rows.push({ label: "Remove Worktree…", aria: `Remove Worktree: ${f.title}`, disabled: (g.remove || undefined) ?? (working ? "Working" : undefined), act: { local: acts.remove } });
    return [{ rows }];
  },
};
