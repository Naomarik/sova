/**
 * The merge thread's scratch copies: when a landing conflicts, the queue makes one detached worktree beside the project
 * (`<parent>/.worktrees/<repo>-conflict-<entry>`, like the merge copy, never under Sova's state root or `~/.pi`), at
 * the target's commit the run merged onto, and tells the thread where it is. The thread merges the approved commit
 * there and commits its resolution; merge.resolve pins that commit under a hidden ref, `refs/sova-mq/resolve/<entry>`
 * (no branch: nothing that lists branches ever sees it), so it stays reachable until the run uses it.
 *
 * A copy is the queue's by its creation record, never by its name: a mark the queue writes in the copy's own git admin
 * dir (`<common>/worktrees/<id>/sova-scratch-copy`, holding the project root and the entry). Nothing else ever writes
 * that file, and it goes with the worktree's record when the copy is removed.
 *
 * When the entry's attempt ends (landed, sent back, cancelled or superseded) the queue removes the copy and the ref; a
 * sweep at the queue's start removes any whose entry is final or no longer in the queue file (pruned entries are
 * final), never one an open entry still needs.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { assertCopyOutsideState } from "./copy";
import type { Git } from "./guard";

/** The mark's file name in a worktree's admin dir. */
export const SCRATCH_MARK = "sova-scratch-copy";
/** Where pinned resolutions live: one ref per entry. */
export const RESOLVE_REFS = "refs/sova-mq/resolve/";

/** An entry id as the queue makes them (store.ts newId): the only names a copy or ref is ever made for. */
const ENTRY_ID = /^mq_[0-9a-z]+$/;

/** The scratch copy's folder for an entry of the project whose main checkout is `root`. */
export const scratchCopyPath = (root: string, entry: string): string => join(dirname(root), ".worktrees", `${basename(root)}-conflict-${entry}`);
/** The hidden ref that keeps an entry's resolution reachable. */
export const resolveRef = (entry: string): string => `${RESOLVE_REFS}${entry}`;

export interface ScratchMark {
  root: string;
  entry: string;
}

function parseMark(text: string): ScratchMark | null {
  try {
    const v = JSON.parse(text) as Partial<ScratchMark>;
    return typeof v.root === "string" && typeof v.entry === "string" && ENTRY_ID.test(v.entry) ? { root: v.root, entry: v.entry } : null;
  } catch {
    return null;
  }
}

/** The admin dir git keeps for the linked worktree at `path` (its `.git` file's gitdir), or null. */
function adminDirOf(path: string): string | null {
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(join(path, ".git"), "utf8"));
    if (!m) return null;
    return isAbsolute(m[1]!) ? m[1]! : resolve(path, m[1]!);
  } catch {
    return null;
  }
}

/** The mark of the worktree at `path`, when the queue made it as a scratch copy; null for any other folder. */
export function scratchMarkOf(path: string): ScratchMark | null {
  const admin = adminDirOf(path);
  if (!admin) return null;
  try {
    return parseMark(readFileSync(join(admin, SCRATCH_MARK), "utf8"));
  } catch {
    return null;
  }
}

/** Whether the worktree at `path` is one of the queue's scratch copies (by its creation record). */
export const isScratchCopy = (path: string): boolean => scratchMarkOf(path) !== null;

/**
 * Every scratch copy git still records for the repository whose common dir is `commonDir`: its path (as git recorded it
 * in the admin dir's `gitdir`, the folder may be gone) and its mark. Read from the admin dirs alone: no git command.
 */
export function scratchCopiesIn(commonDir: string): { path: string; mark: ScratchMark }[] {
  const dir = join(commonDir, "worktrees");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: { path: string; mark: ScratchMark }[] = [];
  for (const n of names) {
    let mark: ScratchMark | null = null;
    try {
      mark = parseMark(readFileSync(join(dir, n, SCRATCH_MARK), "utf8"));
    } catch {
      continue;
    }
    if (!mark) continue;
    try {
      const gitFile = readFileSync(join(dir, n, "gitdir"), "utf8").trim();
      out.push({ path: dirname(gitFile), mark });
    } catch {
      /* no gitdir record: git can't name its folder either */
    }
  }
  return out;
}

async function commonDirOf(git: Git, root: string): Promise<string | null> {
  const r = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], root);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/**
 * Make the entry's scratch copy at `base` (a detached worktree of `root`, marked as the queue's), replacing one the
 * queue made before for the same entry. A folder there that the queue didn't make is never touched: refused. Throws
 * with a plain reason when the copy can't be made.
 */
export async function makeScratchCopy(git: Git, o: { root: string; entry: string; base: string; state?: string; home?: string }): Promise<string> {
  if (!ENTRY_ID.test(o.entry)) throw new Error(`not an entry id: ${o.entry}`);
  const path = scratchCopyPath(o.root, o.entry);
  assertCopyOutsideState(path, { root: o.root, ...(o.state ? { state: o.state } : {}), ...(o.home ? { home: o.home } : {}) });
  if (existsSync(path)) {
    const mark = scratchMarkOf(path);
    if (!mark || mark.entry !== o.entry) throw new Error(`${path} is there already and isn't a scratch copy Sova made: it was left as it is`);
    await removeWorktree(git, o.root, path);
  }
  mkdirSync(dirname(path), { recursive: true });
  // A record an interrupted cut left (folder gone): pruned, so the cut can reuse the name.
  await git(["worktree", "prune"], o.root);
  const r = await git(["worktree", "add", "--detach", "--force", path, o.base], o.root);
  if (r.code !== 0) {
    rmSync(path, { recursive: true, force: true });
    throw new Error(`git worktree add failed: ${(r.stderr || r.stdout).trim().split("\n").pop() || `exit ${r.code}`}`);
  }
  const admin = adminDirOf(path);
  if (!admin) {
    await removeWorktree(git, o.root, path);
    throw new Error(`git made ${path} but it has no worktree record`);
  }
  writeFileSync(join(admin, SCRATCH_MARK), `${JSON.stringify({ root: o.root, entry: o.entry })}\n`);
  return path;
}

async function removeWorktree(git: Git, root: string, path: string): Promise<void> {
  await git(["worktree", "remove", "--force", "--force", "--", path], root);
  rmSync(path, { recursive: true, force: true });
  await git(["worktree", "prune"], root);
}

/** Pin an entry's resolution commit under its hidden ref. */
export async function pinResolution(git: Git, root: string, entry: string, commit: string): Promise<void> {
  if (!ENTRY_ID.test(entry)) throw new Error(`not an entry id: ${entry}`);
  const r = await git(["update-ref", resolveRef(entry), commit], root);
  if (r.code !== 0) throw new Error(`git update-ref failed: ${(r.stderr || r.stdout).trim().split("\n")[0] || `exit ${r.code}`}`);
}

/**
 * Remove the entry's scratch copy (only one the queue marked for this entry) and its hidden ref. What isn't there is
 * skipped; never throws. Returns what went.
 */
export async function dropScratch(git: Git, root: string, entry: string): Promise<{ copy: boolean; ref: boolean }> {
  const out = { copy: false, ref: false };
  if (!ENTRY_ID.test(entry)) return out;
  try {
    const common = await commonDirOf(git, root);
    const copies = common ? scratchCopiesIn(common).filter((c) => c.mark.entry === entry) : [];
    const path = scratchCopyPath(root, entry);
    if (!copies.some((c) => resolve(c.path) === resolve(path)) && existsSync(path) && scratchMarkOf(path)?.entry === entry) copies.push({ path, mark: { root, entry } });
    for (const c of copies) {
      await removeWorktree(git, root, c.path);
      out.copy = true;
    }
    const ref = resolveRef(entry);
    if ((await git(["rev-parse", "--verify", "--quiet", ref], root)).code === 0) {
      out.ref = (await git(["update-ref", "-d", ref], root)).code === 0;
    }
  } catch {
    /* best effort: the next start's sweep tries again */
  }
  return out;
}

/** The entries that have a scratch copy or a pinned resolution in `root`'s repository. */
export async function scratchEntries(git: Git, root: string): Promise<Set<string>> {
  const out = new Set<string>();
  const common = await commonDirOf(git, root);
  if (common) for (const c of scratchCopiesIn(common)) out.add(c.mark.entry);
  const refs = await git(["for-each-ref", "--format=%(refname)", RESOLVE_REFS], root);
  if (refs.code === 0)
    for (const line of refs.stdout.split("\n")) {
      const id = line.trim().slice(RESOLVE_REFS.length);
      if (line.trim().startsWith(RESOLVE_REFS) && ENTRY_ID.test(id)) out.add(id);
    }
  return out;
}

/**
 * The start's sweep: drop the copy and ref of every entry `keep` doesn't name (final, or gone from the queue file).
 * Returns the entries swept.
 */
export async function sweepScratch(git: Git, root: string, keep: (entry: string) => boolean): Promise<string[]> {
  const swept: string[] = [];
  for (const id of await scratchEntries(git, root)) {
    if (keep(id)) continue;
    const r = await dropScratch(git, root, id);
    if (r.copy || r.ref) swept.push(id);
  }
  return swept;
}
