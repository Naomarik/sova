// A project's coding-worktree row menu (§app.project-overseer/coding-worktrees "The project page
// lists them"), as one declaration (lib/menu-place): its ⋯ and a right-click on the row both draw
// it, each row with its reason before the press. Merge Branch, or Land once the project's merge
// queue is set up; then Remove Worktree…, whose whole question stays inside the menu.

import type { CodingWorktreeHold } from "../../shared/protocol";
import type { WorktreeQueueInfo } from "../../shared/merge-queue";
import type { CodingRow, Gate } from "./coding-worktrees";
import { entryLandBlock } from "./merge-queue";
import type { MenuDecl, MenuItem, MenuScreen } from "./menu-place";
import { projectHostOf } from "./mesh";
import { quoted } from "./session-groups";

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
  /** The removal screen's live dry run and the exact-listing step. */
  removal: {
    /** The row's folder as the question displays it. */
    folder: string;
    home: string | null;
    hold: CodingWorktreeHold | undefined;
    loading: boolean;
    listing: boolean;
  };
  /** A gesture on one of the page's rows is in flight. */
  working: boolean;
}

/** What the rows do, on the row as it reads when one is chosen; `send` is the row's command. */
export interface WorktreeMenuActs {
  merge(send: () => Promise<unknown>): void;
  /** Queue the branch to land at the head this page read. */
  land(send: () => Promise<unknown>): void;
  /** Remove Worktree, after its ordinary question. */
  remove(send: () => Promise<unknown>): void;
  /** Delete and Remove Worktree, against the exact confirmed listing's digest. */
  removeAnyway(digest: string): void;
  /** The screen's dry run and its local listing step. */
  loadRemove(): void;
  unloadRemove(): void;
  showRemoveListing(show: boolean): void;
}

/** The ordinary removal question, before the dry run answers. */
export function worktreeRemovalNote(row: Pick<CodingRow, "branch" | "merged">, folder: string): string {
  return row.merged
    ? `The folder ${folder} and the merged branch ${row.branch} go away. The session and its transcript stay.`
    : `The folder ${folder} goes away. The branch ${row.branch} keeps its commits, and the session and its transcript stay.`;
}

type RemoveScreen = Extract<MenuScreen, { kind: "worktree-remove" }>;

/** The removal flow, replacing the rows in the same panel. */
function removeScreen(f: WorktreeMenuFacts, acts: WorktreeMenuActs): RemoveScreen {
  // Solid keeps the last resource value while a new dry run loads. It is not the current answer:
  // hide its reason, Remove Anyway and exact listing until this run has answered.
  const hold = f.removal.loading ? undefined : f.removal.hold;
  const listed = !f.removal.loading && f.removal.listing ? hold?.removeAnyway : undefined;
  const remove = { command: "project.worktree.remove", params: { pid: f.project, "session-id": f.row.sessionId }, via: (send: () => Promise<unknown>) => acts.remove(send) } as const;
  let confirm: RemoveScreen["confirm"];
  if (listed) confirm = { label: "Delete and Remove Worktree", disabled: f.working, act: { local: () => acts.removeAnyway(listed.digest) } };
  else if (hold?.reason) {
    if (hold.removeAnyway) confirm = { label: "Remove Anyway", show: () => acts.showRemoveListing(true) };
  } else confirm = { label: "Remove Worktree", disabled: f.working || f.removal.loading, act: remove };
  return {
    kind: "worktree-remove",
    note: hold?.reason ?? worktreeRemovalNote(f.row, f.removal.folder),
    listing: listed ? { data: listed, home: f.removal.home } : undefined,
    confirm,
    back: listed ? () => acts.showRemoveListing(false) : undefined,
    load: acts.loadRemove,
    unload: acts.unloadRemove,
  };
}

/** The row has a menu at all: neither gesture offered, no ⋯ and no right-click menu. */
export const worktreeMenuOffered = (g: WorktreeMenuFacts["gestures"]) => g.merge !== false || g.remove !== false;

/** A menu place, for a row of this host's project that has a branch. */
export const WORKTREE_MENU: MenuDecl<{ facts: WorktreeMenuFacts; acts: WorktreeMenuActs }> = {
  label: ({ facts }) => `Actions · ${facts.title}`,
  extensions: {
    place: "worktree",
    payload: ({ facts: f }) => (projectHostOf(f.project) === null && f.row.branch ? { project: f.project, branch: f.row.branch, session: f.row.sessionId } : null),
    name: ({ facts }) => quoted(facts.title),
  },
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
    // Its dry run, reason and confirmed listing stay in this menu, not under the row.
    if (g.remove !== false)
      rows.push({ label: "Remove Worktree…", aria: `Remove Worktree: ${f.title}`, disabled: (g.remove || undefined) ?? (working ? "Working" : undefined), act: { screen: removeScreen(f, acts) } });
    return [{ rows }];
  },
};
