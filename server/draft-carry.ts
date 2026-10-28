import { cpSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { type Git, runGit } from "../pi-config/extensions/worktrees/git.ts";

/**
 * A Build's conversation draft, carried into the worktree cut for it (§app.requirements/draft-approval).
 * The build registers before its act runs; the make-worktree effect copies the draft after the cut and
 * before the session starts; the build then reads back which branch got it. Only a copy that lands where
 * Git ignores it (the spec's local-only drafts folder) is made, so the carry never dirties the worktree.
 */
const pending = new Map<string, { root: string; draft: string; branch?: string }>();

/** A build session about to start: carry `draft` from the project `root` into its worktree when one is cut. */
export function expectCarry(sessionId: string, root: string, draft: string): void {
  pending.set(sessionId, { root, draft });
}

/** The session's start is over (made or not): forget it. Returns the branch the draft was carried onto, if it was. */
export function carriedBranch(sessionId: string): string | undefined {
  const e = pending.get(sessionId);
  pending.delete(sessionId);
  return e?.branch;
}

const draftsOf = (root: string): string => join(root, ".sova", "spec", "drafts");

/** Copy one of the root's conversation drafts whole into another checkout's drafts folder, never over a draft
    already there. False when there is nothing to copy or the target already has one. Node builtins only: the
    project layer (make-worktree) calls it, so it never reaches the org layer's spec writer. */
export function carryDraft(root: string, into: string, name: string): boolean {
  if (!/^conv-[a-z0-9-]+$/.test(name)) throw new Error(`not a conversation draft: ${name}`);
  const from = join(draftsOf(root), name);
  const to = join(draftsOf(into), name);
  if (!existsSync(join(from, "draft.json")) || existsSync(to)) return false;
  mkdirSync(draftsOf(into), { recursive: true });
  cpSync(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  return true;
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * Called by make-worktree right after the cut: when this session expects a carry, copy the draft into the
 * project's folder inside the new worktree (`top` the worktree, `repoTop` the repository's top, the project
 * root at or below it). Never throws: a draft that can't be carried is reported and the build goes on.
 */
export async function carryOnCut(sessionId: string, repoTop: string, top: string, branch: string, git: Git = runGit): Promise<void> {
  const e = pending.get(sessionId);
  if (!e) return;
  try {
    const inside = relative(real(repoTop), real(e.root));
    const into = inside && !inside.startsWith("..") ? join(top, inside) : top;
    const probe = join(".sova", "spec", "drafts", e.draft, "draft.json");
    if ((await git(["check-ignore", "-q", "--no-index", "--", probe], into)).code !== 0) {
      console.warn(`[build] ${sessionId}: ${e.draft} not carried: Git doesn't ignore .sova/spec/drafts/ in the worktree`);
      return;
    }
    if (carryDraft(e.root, into, e.draft)) e.branch = branch;
  } catch (err) {
    console.warn(`[build] ${sessionId}: ${e.draft} not carried: ${err instanceof Error ? err.message : String(err)}`);
  }
}
