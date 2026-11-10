// What became of a tracked worktree whose folder is gone (§chat.worktrees/readiness) and the ledger
// of Sova's own removals (§chat.worktrees/cleanup): `<state root>/removed-worktrees.json`,
// `{v: 1, entries: [...]}`, newest last, written by atomic rename. Merge readiness asks
// `goneTreeState` so an owner whose merged worktree was removed (by the cleanup button, another
// session's plain git, or by hand) reads merged, never in progress. Git by argv, read-only.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isWithin, type TrackedWorktree } from "../pi-config/extensions/worktrees/state.ts";
import { stateRoot } from "./state-root";
import { mergeTreeOid, trialMergeTree } from "./merge-tree-probe";
import { codeLeft, landingRecordsAt, queueTargetAt, trialNoOp } from "./nothing-left";
import { hasLiveGit } from "./worktree-remove";
import { execGit, type GitRunner } from "./worktrees";

/** One removal Sova's cleanup made. */
export interface RemovedWorktree {
  v: 1;
  path: string;
  branch: string;
  commonDir: string;
  tip: string;
  /** `leftover`: its only commits past the target were merges, or a folder left behind with its branch gone. */
  merged: "ancestor" | "content" | "leftover" | "empty";
  branchDeleted: boolean;
  at: number;
  /** The branch it landed on, when known: what a message would bring it back fresh from. */
  target?: string;
  /** Automatic retirement took it (§chat.worktrees/retirement): only such an entry brings a chat's folder back. Absent: removed by another way (archive, Remove Worktree, an older button). */
  retired?: true;
  /** One of the merge queue's own chats made it: on no list of yours (§app.merge-queue/resolve-copy). */
  queueMade?: true;
  /** Its last commit is pinned at refs/sova/retired/<tip>. */
  pinned?: true;
  /** Git forgot the tree but the folder stayed, and the proof didn't hold: the leftover pass looks at it again. */
  partial?: true;
  /** Restore put the branch and folder back at this time: it waits 7 days before it can retire again. */
  restoredAt?: number;
  /** A message brought the folder back at this time, fresh from the target. */
  backAt?: number;
  /** The project keeps branches (§chat.worktrees/retirement): the branch stayed, and nothing later deletes it. */
  branchKept?: true;
  /** Test chats moved to `<state root>/retired-test-chats/<folder>/` before it went. */
  keptChats?: number;
}

/** Really absent: a folder that can't be read may well be there. */
const folderGone = (p: string): boolean => {
  try {
    lstatSync(p);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
};

const newestCovering = (entries: readonly RemovedWorktree[], at: string): RemovedWorktree | null => {
  for (let i = entries.length - 1; i >= 0; i--) if (at === entries[i]!.path || isWithin(at, entries[i]!.path)) return entries[i]!;
  return null;
};

/**
 * The retirement a message would bring `at` (canonical) back from: the newest entry for its worktree, retired, with
 * nothing having brought it back. A partial delete counts only once its folder is gone, however it went.
 */
export function retiredEntryCovering(entries: readonly RemovedWorktree[], at: string): RemovedWorktree | null {
  const e = newestCovering(entries, at);
  return e?.retired && (!e.partial || folderGone(e.path)) && !e.backAt && !e.restoredAt && e.branch ? e : null;
}

/**
 * The partial delete `at` (canonical) is in, still held: git forgot it, files stayed, and nothing has proved them safe
 * yet. No chat runs there (§chat.worktrees/retirement). A folder with a live `.git` again isn't this any more.
 */
export function heldPartialEntry(entries: readonly RemovedWorktree[], at: string): RemovedWorktree | null {
  const e = newestCovering(entries, at);
  return e?.retired && e.partial && !e.backAt && !e.restoredAt && !folderGone(e.path) && !hasLiveGit(e.path) ? e : null;
}

/** The newest this many entries are kept. */
export const LEDGER_MAX = 2000;

export const ledgerFile = (): string => join(stateRoot(), "removed-worktrees.json");

const isEntry = (e: unknown): e is RemovedWorktree => {
  const r = e as Partial<RemovedWorktree> | null;
  return !!r && r.v === 1 && typeof r.path === "string" && typeof r.branch === "string" && typeof r.commonDir === "string" && typeof r.tip === "string" &&
    (r.merged === "ancestor" || r.merged === "content" || r.merged === "leftover" || r.merged === "empty") && typeof r.branchDeleted === "boolean" && typeof r.at === "number";
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

/** Rewrites the newest entry `match` finds, adding `patch`: the mark a restore or a return leaves. False: none matched. */
export function markLedger(match: (e: RemovedWorktree) => boolean, patch: Partial<Pick<RemovedWorktree, "restoredAt" | "backAt" | "branchDeleted">>, file = ledgerFile()): boolean {
  const entries = [...readLedger(file)];
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!match(entries[i]!)) continue;
    entries[i] = { ...entries[i]!, ...patch };
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ v: 1, entries }, null, 1)}\n`);
    renameSync(tmp, file);
    cached = null;
    return true;
  }
  return false;
}

/** Merged by content: merging `tip` into `main` leaves main's tree as it is. Objects go to a throwaway directory, and
    git runs outside the checkout `cwd` (merge-tree-probe.ts). */
const contentCache = new Map<string, boolean>();
export async function mergedByContent(git: GitRunner, cwd: string, commonDir: string, main: string, tip: string): Promise<boolean> {
  const key = `${commonDir}\0${main}\0${tip}`;
  const hit = contentCache.get(key);
  if (hit !== undefined) return hit;
  let value = false;
  try {
    // Outside the checkout (merge-tree-probe.ts): a driver's temp files can never be left in it.
    const [merged, tree] = await Promise.all([
      trialMergeTree(git, { top: cwd, gitDir: commonDir, commonDir, base: main, head: tip }),
      git(["rev-parse", `${main}^{tree}`], { cwd }),
    ]);
    if (merged.code !== 0 && merged.code !== 1) return false; // can't tell: not merged (and not cached)
    value = merged.code === 0 && tree.code === 0 && mergeTreeOid(merged.stdout) === tree.stdout.trim();
    contentCache.set(key, value);
    if (contentCache.size > 2000) contentCache.delete(contentCache.keys().next().value!);
  } catch {
    return false;
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
/** Reads under way: a reader that comes while one runs takes its answer, which is the one it would keep. */
const goneFlights = new Map<string, Promise<GoneState>>();

/**
 * A tracked worktree whose folder is gone: merged when git, read from one of `dirs` (the session's
 * folder, its other trees still there) or a folder beside it (`besideGone`), in the same repository (the recorded base is there and the
 * branch descends from it), finds the branch in the branch the project's queue lands on, else master, else main, after at
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
  const flying = goneFlights.get(key);
  if (flying) return flying;
  const flight = readGoneState(t, dirs, git, opts.ledger ?? readLedger).then((value) => {
    goneCache.set(key, { at: now, value });
    if (goneCache.size > 500) goneCache.delete(goneCache.keys().next().value!);
    return value;
  }).finally(() => goneFlights.delete(key));
  goneFlights.set(key, flight);
  return flight;
}

async function readGoneState(t: Pick<TrackedWorktree, "path" | "branch" | "base">, dirs: readonly string[], git: GitRunner, ledger: () => readonly RemovedWorktree[]): Promise<GoneState> {
  let value: GoneState = null;
  for (const cwd of [...new Set([...dirs, ...besideGone(t.path)])]) {
    if (!cwd || !existsSync(cwd)) continue;
    const base = await git(["cat-file", "-e", `${t.base}^{commit}`], { cwd });
    if (base.code !== 0) continue; // another repository, or not one
    const tip = await git(["rev-parse", "--verify", "-q", `refs/heads/${t.branch}^{commit}`], { cwd });
    if (tip.code !== 0) break; // its branch is gone here: only the ledger can tell
    const sha = tip.stdout.trim();
    // The branch the setting kept, still where it retired: what its landing said stands, however the target has moved.
    const kept = [...ledger()].reverse().find((e) => e.path === t.path && e.branch === t.branch);
    if (kept?.branchKept && kept.tip === sha && !kept.backAt && !kept.restoredAt) {
      value = kept.merged === "empty" ? "empty" : "merged";
      break;
    }
    if (sha === t.base) {
      value = "empty";
      break;
    }
    const cd = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
    const commonDir = cd.code === 0 ? cd.stdout.trim() : null;
    // The branch it lands on, as a live row reads it; with no queue loaded, master, else main.
    const landsOn = commonDir ? queueTargetAt(commonDir) : null;
    let main = "";
    let mainName = "";
    for (const b of [...(landsOn ? [landsOn] : []), "master", "main"]) {
      const r = await git(["rev-parse", "--verify", "-q", `refs/heads/${b}^{commit}`], { cwd });
      if (r.code === 0) {
        main = r.stdout.trim();
        mainName = b;
        break;
      }
    }
    if (!main) break;
    const lineage = await git(["merge-base", "--is-ancestor", t.base, sha], { cwd });
    if (lineage.code !== 0) continue; // not this branch's history: another repository's same name
    const inMain = await git(["merge-base", "--is-ancestor", sha, main], { cwd });
    if (inMain.code === 0) value = "merged";
    else if (inMain.code === 1) {
      // The one answer (§chat.worktrees/nothing-left): a gone folder's branch reads as a live one's would.
      const answer = await codeLeft({ git, cwd, head: sha, target: { name: mainName, oid: main }, landings: commonDir ? landingRecordsAt(commonDir, t.branch) : undefined, trial: commonDir ? () => trialNoOp(git, { top: cwd, gitDir: commonDir, commonDir, target: main, head: sha }) : undefined });
      // Can't tell is no reading, never "unmerged" (§chat.worktrees/nothing-left).
      value = answer.kind === "unknown" ? null : answer.left ? "unmerged" : "merged";
    }
    break;
  }
  if (value === null) {
    const removed = [...ledger()].reverse().find((e) => e.path === t.path && e.branch === t.branch);
    if (removed) value = removed.merged === "empty" ? "empty" : "merged";
  }
  return value;
}

/** Tests: forget cached answers. */
export function resetRemovedWorktrees(): void {
  goneCache.clear();
  goneFlights.clear();
  cached = null;
}
