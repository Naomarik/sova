// What became of a tracked worktree whose folder is gone (§chat.worktrees/readiness) and the ledger
// of Sova's own removals (§chat.worktrees/cleanup): `<state root>/removed-worktrees.json`,
// `{v: 1, entries: [...]}`, newest last, written by atomic rename. Merge readiness asks
// `goneTreeState` so an owner whose merged worktree was removed (by the cleanup button, the Merge
// Captain's plain git, or by hand) reads merged, never in progress. Git by argv, read-only.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { TrackedWorktree } from "../pi-config/extensions/worktrees/state.ts";
import { stateRoot } from "./state-root";
import { execGit, type GitRunner } from "./worktrees";

/** One removal Sova's cleanup made. */
export interface RemovedWorktree {
  v: 1;
  path: string;
  branch: string;
  commonDir: string;
  tip: string;
  merged: "ancestor" | "content" | "empty";
  branchDeleted: boolean;
  at: number;
}

/** The newest this many entries are kept. */
export const LEDGER_MAX = 2000;

export const ledgerFile = (): string => join(stateRoot(), "removed-worktrees.json");

const isEntry = (e: unknown): e is RemovedWorktree => {
  const r = e as Partial<RemovedWorktree> | null;
  return !!r && r.v === 1 && typeof r.path === "string" && typeof r.branch === "string" && typeof r.commonDir === "string" && typeof r.tip === "string" &&
    (r.merged === "ancestor" || r.merged === "content" || r.merged === "empty") && typeof r.branchDeleted === "boolean" && typeof r.at === "number";
};

let cached: { file: string; mtimeMs: number; size: number; entries: RemovedWorktree[] } | null = null;

/** Every usable entry, oldest first; a missing or unreadable file is empty. Re-read when it changed. */
export function readLedger(file = ledgerFile()): RemovedWorktree[] {
  let st;
  try {
    st = statSync(file);
  } catch {
    return [];
  }
  if (cached && cached.file === file && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.entries;
  let entries: RemovedWorktree[] = [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; entries?: unknown };
    if (raw?.v === 1 && Array.isArray(raw.entries)) entries = raw.entries.filter(isEntry);
  } catch {
    entries = [];
  }
  cached = { file, mtimeMs: st.mtimeMs, size: st.size, entries };
  return entries;
}

/** Append removals, keeping the newest LEDGER_MAX. */
export function appendLedger(add: readonly RemovedWorktree[], file = ledgerFile()): void {
  if (!add.length) return;
  const entries = [...readLedger(file), ...add].slice(-LEDGER_MAX);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ v: 1, entries }, null, 1)}\n`);
  renameSync(tmp, file);
  cached = null;
}

/** Merged by content: merging `tip` into `main` leaves main's tree as it is. Objects go to a throwaway directory. */
const contentCache = new Map<string, boolean>();
export async function mergedByContent(git: GitRunner, cwd: string, commonDir: string, main: string, tip: string): Promise<boolean> {
  const key = `${commonDir}\0${main}\0${tip}`;
  const hit = contentCache.get(key);
  if (hit !== undefined) return hit;
  let scratch: string | null = null;
  let value = false;
  try {
    scratch = await mkdtemp(join(tmpdir(), "sova-cleanup-merge-tree-"));
    const env = { GIT_OBJECT_DIRECTORY: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(commonDir, "objects") };
    const [merged, tree] = await Promise.all([git(["merge-tree", "--write-tree", "--no-messages", main, tip], { cwd, env }), git(["rev-parse", `${main}^{tree}`], { cwd })]);
    if (merged.code !== 0 && merged.code !== 1) return false; // can't tell: not merged (and not cached)
    value = merged.code === 0 && tree.code === 0 && (merged.stdout.split("\n", 1)[0] ?? "").trim() === tree.stdout.trim();
    contentCache.set(key, value);
    if (contentCache.size > 2000) contentCache.delete(contentCache.keys().next().value!);
  } catch {
    return false;
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
  return value;
}

export const resetContentMerges = (): void => contentCache.clear();

/** What a gone folder's work came to: merged, empty (no commit of its own), unmerged (git has its
    branch, with commits the main branch lacks), or unknown (null). */
export type GoneState = "merged" | "empty" | "unmerged" | null;

/** Folders beside a gone worktree that may be in its repository: the main checkout the `worktree`
    tool's layout names (`<parent>/.worktrees/<repo>-<name>` → `<parent>/<repo>`), then a few
    sibling folders (other worktrees of the same repository, as a rule). Checked by git, never trusted. */
export function besideGone(path: string, max = 4): string[] {
  const parent = dirname(path);
  const out: string[] = [];
  if (basename(parent) === ".worktrees") {
    const parts = basename(path).split("-");
    for (let i = parts.length - 1; i > 0; i--) out.push(join(dirname(parent), parts.slice(0, i).join("-")));
  }
  try {
    const siblings = readdirSync(parent, { withFileTypes: true }).filter((d) => d.isDirectory() && join(parent, d.name) !== path).map((d) => join(parent, d.name)).sort();
    out.push(...siblings.slice(0, max));
  } catch {
    // the parent is gone too
  }
  return out.filter((d) => existsSync(d));
}

/** Known answers barely move (a branch in master stays there); an unknown one is asked again sooner. */
const KNOWN_TTL_MS = 10 * 60_000;
const UNKNOWN_TTL_MS = 60_000;
const goneCache = new Map<string, { at: number; value: GoneState }>();

/**
 * A tracked worktree whose folder is gone: merged when git, read from one of `dirs` (the session's
 * folder, its other trees still there) or a folder beside it (`besideGone`), in the same repository (the recorded base is there and the
 * branch descends from it), finds the branch in the main branch (master, else main) after at
 * least one commit of its own; empty when the branch is still at its base. Else the ledger: Sova's
 * cleanup removed it (and perhaps deleted its branch). Else null: unknown.
 */
export async function goneTreeState(
  t: Pick<TrackedWorktree, "path" | "branch" | "base">,
  dirs: readonly string[],
  opts: { git?: GitRunner; now?: number; ledger?: () => readonly RemovedWorktree[] } = {},
): Promise<GoneState> {
  const git = opts.git ?? execGit;
  const now = opts.now ?? Date.now();
  const key = `${t.path}\0${t.branch}\0${t.base}\0${dirs.join("\0")}`;
  const hit = goneCache.get(key);
  if (hit && now - hit.at < (hit.value ? KNOWN_TTL_MS : UNKNOWN_TTL_MS)) return hit.value;
  let value: GoneState = null;
  for (const cwd of [...new Set([...dirs, ...besideGone(t.path)])]) {
    if (!cwd || !existsSync(cwd)) continue;
    const base = await git(["cat-file", "-e", `${t.base}^{commit}`], { cwd });
    if (base.code !== 0) continue; // another repository, or not one
    const tip = await git(["rev-parse", "--verify", "-q", `refs/heads/${t.branch}^{commit}`], { cwd });
    if (tip.code !== 0) break; // its branch is gone here: only the ledger can tell
    const sha = tip.stdout.trim();
    if (sha === t.base) {
      value = "empty";
      break;
    }
    let main = "";
    for (const b of ["master", "main"]) {
      const r = await git(["rev-parse", "--verify", "-q", `refs/heads/${b}^{commit}`], { cwd });
      if (r.code === 0) {
        main = r.stdout.trim();
        break;
      }
    }
    if (!main) break;
    const lineage = await git(["merge-base", "--is-ancestor", t.base, sha], { cwd });
    if (lineage.code !== 0) continue; // not this branch's history: another repository's same name
    const inMain = await git(["merge-base", "--is-ancestor", sha, main], { cwd });
    if (inMain.code === 0) value = "merged";
    else if (inMain.code === 1) {
      const cd = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
      value = cd.code === 0 && (await mergedByContent(git, cwd, cd.stdout.trim(), main, sha)) ? "merged" : "unmerged";
    }
    break;
  }
  if (value === null) {
    const removed = [...(opts.ledger ?? readLedger)()].reverse().find((e) => e.path === t.path && e.branch === t.branch);
    if (removed) value = removed.merged === "empty" ? "empty" : "merged";
  }
  goneCache.set(key, { at: now, value });
  if (goneCache.size > 500) goneCache.delete(goneCache.keys().next().value!);
  return value;
}

/** Tests: forget cached answers. */
export function resetRemovedWorktrees(): void {
  goneCache.clear();
  cached = null;
}
