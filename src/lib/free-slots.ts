import type { CodingWorktree } from "../../shared/project-overseer";
import type { SessionSummary } from "../../shared/protocol";
import type { CopyView } from "../../shared/services-view";
import { relativeTime } from "./format";

/**
 * Running Copies' two groups and Free Up Slots: which copies can go (their branch landed, or the merge
 * queue left them stopped), and why, in a few words. Pure: the tab reads the copies, the page hands it
 * what it knows landed.
 */

/** What the page knows landed, by worktree path (any session's) and by branch (this project's coding sessions). Value: when, if known. */
export interface LandedCopies {
  paths: ReadonlyMap<string, string | null>;
  branches: ReadonlyMap<string, string | null>;
}

export const NO_LANDED: LandedCopies = { paths: new Map(), branches: new Map() };

/**
 * What landed, from the project's coding worktrees (git's reading: merged now, with no commits since) and the
 * sidebar's sessions (a recorded merge, or git and the merge queue agreeing it landed). A branch with no
 * commit of its own reads as merged to git, so a coding worktree counts only once it has commits or a merge.
 */
export function landedCopies(worktrees: { sessions: readonly CodingWorktree[] } | undefined, sessions: readonly SessionSummary[] | undefined): LandedCopies {
  const paths = new Map<string, string | null>();
  const branches = new Map<string, string | null>();
  /** Paths git read for this project: their reading wins over a session row's. */
  const read = new Set<string>();
  for (const w of worktrees?.sessions ?? []) {
    if (w.worktree) read.add(w.worktree);
    if (!w.merged || w.newSinceMerge || !(w.ahead > 0 || w.mergedAt)) continue;
    const at = w.mergedAt ?? null;
    if (w.worktree) paths.set(w.worktree, at);
    if (w.branch) branches.set(w.branch, at);
  }
  for (const s of sessions ?? [])
    for (const b of s.branches ?? []) {
      if (read.has(b.path) || paths.has(b.path)) continue;
      if (b.status === "merged" || (b.mergedInto && b.queue?.state === "landed")) paths.set(b.path, null);
    }
  return { paths, branches };
}

/** The merge queue's own copy of a project: `<parent>/.worktrees/<repo>-merge` (server/merge-queue/copy.ts mergeCopyPath). */
export function mergeCopyPath(root: string): string {
  const trimmed = root.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return `${trimmed.slice(0, cut)}/.worktrees/${trimmed.slice(cut + 1)}-merge`;
}

export type GoReason = { kind: "landed"; at: string | null } | { kind: "queue" };

type CopyFacts = Pick<CopyView, "slot" | "state" | "branch" | "checkout" | "adopted">;

/**
 * Why a copy can go, or null while it is in use. Never the main checkout or an adopted one. The merge queue's
 * copy only while stopped (running, a check uses it). A landed branch's copy, running or not.
 */
export function canGo(c: CopyFacts, root: string, landed: LandedCopies): GoReason | null {
  if (c.slot === 0 || c.adopted) return null;
  if (c.checkout === mergeCopyPath(root)) return c.state === "stopped" || c.state === "absent" ? { kind: "queue" } : null;
  if (landed.paths.has(c.checkout)) return { kind: "landed", at: landed.paths.get(c.checkout) ?? null };
  if (c.branch && landed.branches.has(c.branch)) return { kind: "landed", at: landed.branches.get(c.branch) ?? null };
  return null;
}

/** "landed 4d ago", "landed", "left by the merge queue". */
export function goWord(r: GoReason, now = Date.now()): string {
  if (r.kind === "queue") return "left by the merge queue";
  return r.at ? `landed ${relativeTime(r.at, now)}` : "landed";
}

/** The copies split into In use and Can go, each in the order given. */
export function copyGroups<C extends CopyFacts>(copies: readonly C[], root: string, landed: LandedCopies): { inUse: C[]; canGo: { copy: C; why: GoReason }[] } {
  const inUse: C[] = [];
  const go: { copy: C; why: GoReason }[] = [];
  for (const c of copies) {
    const why = canGo(c, root, landed);
    if (why) go.push({ copy: c, why });
    else inUse.push(c);
  }
  return { inUse, canGo: go };
}

const running = (s: CopyView["state"]) => s === "running" || s === "degraded";

/** In use's count: "2 running · 1 stopped". */
export function inUseCount(copies: readonly Pick<CopyView, "state">[]): string {
  const r = copies.filter((c) => running(c.state)).length;
  return `${r} running · ${copies.length - r} stopped`;
}

/** Can go's count: "3 copies · 3 slots back", or "nothing to free". */
export function canGoCount(n: number): string {
  return n ? `${n === 1 ? "1 copy" : `${n} copies`} · ${n === 1 ? "1 slot" : `${n} slots`} back` : "nothing to free";
}

/** The dialog's title and button, and the toast once done. */
export const freeTitle = (n: number) => (n === 1 ? "Free up 1 slot" : `Free up ${n} slots`);
export const freeButton = (n: number) => (n === 1 ? "Remove 1 Copy" : `Remove ${n} Copies`);
export function freedLine(slots: readonly number[]): string {
  const n = slots.length;
  return `Removed ${n === 1 ? "1 copy" : `${n} copies`}. ${n === 1 ? `Slot ${slots[0]} is` : `Slots ${slots.join(", ")} are`} free.`;
}
