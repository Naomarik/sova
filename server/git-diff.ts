// Git diffs for the changes viewer and merge cards (GET /api/diff/summary|patch,
// shared/protocol.ts DiffScope / DiffSummary / DiffFilePatch).
//
// Four comparisons, all chosen here; the only refs a client names are a pinned card's two oids:
//  - worktree: the worktree's committed HEAD against the base pi-config/extensions/worktrees/git.ts
//    reviewBase picks, the one rule the show_changes tool shares: the merge-base with the tracked
//    worktree's `baseBranch`, else master, else main, else origin/HEAD's target (each skipped when
//    it is the branch itself or shares no history); once merged, what its merge brought in
//    (mergedReviewBase, "master before <sha>"); else the tracked base commit it was created from,
//    "<sha> (created from)". A checkout on its own base branch is the empty HEAD..HEAD; a detached
//    HEAD or a branch with no base is refused. With `pin` (a show_changes card's saved base and
//    head, full oids, each checked to be a commit in that repository) it is that head against that
//    base, labelled with the card's own words, which never reach git;
//  - commit: one commit (hex sha, resolved to a commit) against its first parent, a root commit
//    against the empty tree;
//  - merge: what a merge card's merge brought in. The folder and full sha must be a merge card
//    this session recorded. A merge commit against its first parent, labelled "<target> before
//    <sha>"; a fast-forward (its sha is the branch tip) against the tracked worktree's base when
//    that is an ancestor of the tip and not the tip (mergedReviewBase's fallback), labelled
//    "<base> (created from)", else against its first parent;
//  - dirty: the working tree (index included) against HEAD, untracked files as added.
//
// Which folders. Every folder must be one the named session already knows: its header cwd, the
// cwds of its workers, every worktree its `worktrees` entries ever tracked and every merge card's
// path. A folder inside one of those passes; the diff then runs at its repository's top level.
// Anything else is a DiffError(400), before any git runs in it. A commit or merge scope whose folder is
// gone (a merged worktree, removed) reads from the first existing known folder whose repository
// has that commit, the session's own folder first.
//
// Any comparison may carry `paths` (checked as the tool checks its own, at most its limit): files
// are kept by their new path when it is one of them or under one, after the unrestricted listing
// (so rename detection is the tool's) and before the MAX_DIFF_FILES cut.
//
// A patch read may ask for its commits (`origins`, §chat.changes/steps): blame over base..head for
// the hunks' added lines (boundary lines count for none), a reverse blame and the ancestry path for
// a hunk that only removes lines, and `log base..head -- path oldPath` for a whole-file unit
// (binary, too large, no hunks) or a deleted file. A commit scope names its one commit; the dirty
// scope has none. All of it within ORIGINS_DEADLINE_MS; past that, or on a failed read, the patch
// still comes, marked `originsUnknown`.
//
// Read-only, with server/worktrees.ts's discipline: plumbing (diff-tree, diff-index, ls-files,
// cat-file, rev-parse, for-each-ref, merge-base, rev-list, symbolic-ref) plus the read-only
// porcelain blame and log for origins, `--no-ext-diff --no-textconv`,
// `-c core.fsmonitor=false --no-optional-locks` (and GIT_OPTIONAL_LOCKS=0), literal pathspecs,
// execFile (no shell). diff-index against the working tree does not refresh the index, so a file
// whose stat changed but whose content did not is listed by --raw with no numstat line: it is
// dropped. The empty tree's oid comes from `hash-object -t tree /dev/null` (no -w: nothing written).
//
// Bounds: every git under a 5 s timeout, at most MAX_CONCURRENT at once, every output under a
// byte cap (a cut listing is `truncated`; a cut patch is `tooLarge`; an old side past BLOB_CAP is
// not sent). Untracked files are read by this process: at most MAX_UNTRACKED_READ bytes of each,
// at most UNTRACKED_BUDGET bytes and MAX_DIFF_FILES files per summary; a file past either is
// `tooLarge`, counted only as far as it was read. Nothing is cached but a session's known folders
// (by file mtime and size).
//
// Contents leave only as a file's own patch, and, for expanding folded context, the old side of a
// file in the diff, read by the blob oid in that same patch's `index` line: never a path or an oid
// from the client, never the working tree beyond what the patch already holds.

import { spawn } from "node:child_process";
import { lstat, open, readFile, readlink, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { DiffCommit, DiffFilePatch, DiffFileStatus, DiffFileSummary, DiffPin, DiffScope, DiffSide, DiffSummary } from "../shared/protocol";
import { isRepoPath, isSha, SHOW_CHANGES_LIMITS } from "../pi-config/extensions/show-changes/details.ts";
import { folderKnown, knownRoots } from "../pi-config/extensions/show-changes/folders.ts";
import { mergedReviewBase, REVIEW_LIMITS, reviewBase } from "../pi-config/extensions/worktrees/git.ts";
import { canonical, normalizeMergeDetails, type TrackedWorktree, type WorktreeMergeDetails, WORKTREE_MERGE_MESSAGE } from "../pi-config/extensions/worktrees/state.ts";
import { lineEntry } from "./harness/pi/reader";
import { WORKTREES } from "./harness/state-kinds";
import { stateView } from "./harness/state-view";
import { resolveSessionPath } from "./paths";
import { agentRoot } from "./state-root";
import { candidatesOf } from "./worktrees";

// The limits the show_changes tool shares (pi-config/extensions/worktrees/git.ts REVIEW_LIMITS).
const GIT_TIMEOUT_MS = REVIEW_LIMITS.gitTimeoutMs;
const MAX_CONCURRENT = 4;
/** Most files one summary lists; `totals` still counts the rest. */
export const MAX_DIFF_FILES = REVIEW_LIMITS.maxFiles;
/** --raw / --numstat / ls-files output. */
const LIST_CAP = 8 * 1024 * 1024;
/** One file's patch; past it the file is `tooLarge`. */
export const PATCH_CAP = REVIEW_LIMITS.patchCap;
/** A file's old side, sent whole for expanding folded context; past it the side is not sent. */
export const BLOB_CAP = 8 * 1024 * 1024;
/** An untracked file past this is not diffed (`tooLarge`), and is counted only this far. */
export const MAX_UNTRACKED_READ = REVIEW_LIMITS.untrackedRead;
/** Untracked bytes one summary reads in all; the files after it are `tooLarge` and uncounted. */
export const UNTRACKED_BUDGET = REVIEW_LIMITS.untrackedBudget;
/** All of one patch's origins reads together (each git is bounded by GIT_TIMEOUT_MS as well). */
const ORIGINS_DEADLINE_MS = GIT_TIMEOUT_MS;
/** A pinned card's labels: display text, at most this long. */
const MAX_LABEL = 200;
/** Session files whose known folders are remembered. */
const MAX_SESSIONS = 64;

/** A refusal with its HTTP status: 400 a bad or unknown scope, 404 not in this diff, 413 too big. */
export class DiffError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 413 | 500 = 400,
  ) {
    super(message);
  }
}

export interface RawGitResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  /** stdout reached the cap and git was stopped. */
  cut: boolean;
}
export type RawGitRunner = (args: readonly string[], opts: { cwd: string; cap: number }) => Promise<RawGitResult>;

const GIT_PREFIX = ["-c", "core.fsmonitor=false", "-c", "core.quotePath=false", "--no-optional-locks", "--literal-pathspecs"];

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS"]) delete env[k];
  return env;
}

/** git with a byte cap on stdout: past `cap` bytes git is killed and the result is `cut`. Never throws. */
export const execGitRaw: RawGitRunner = (args, { cwd, cap }) =>
  new Promise((done) => {
    let child;
    try {
      child = spawn("git", [...GIT_PREFIX, ...args], { cwd, env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      done({ code: null, stdout: Buffer.alloc(0), stderr: (err as Error).message, cut: false });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let cut = false;
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (b: Buffer) => {
      if (cut) return;
      if (size + b.length > cap) {
        chunks.push(b.subarray(0, cap - size));
        size = cap;
        cut = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(b);
      size += b.length;
    });
    child.stderr.on("data", (b: Buffer) => {
      if (stderr.length < 4096) stderr += b.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ code: null, stdout: Buffer.concat(chunks), stderr: err.message, cut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code: cut || timedOut ? null : code, stdout: Buffer.concat(chunks), stderr: timedOut ? "git timed out" : stderr, cut });
    });
  });

function gitError(what: string, r: RawGitResult): string {
  const line = r.stderr.split("\n").map((s) => s.trim()).find(Boolean);
  return `${what}: ${line ?? (r.code === null ? "git did not finish" : `exit ${r.code}`)}`;
}

const HEX = /^[0-9a-f]+$/i;
const isOid = (s: string) => HEX.test(s) && (s.length === 40 || s.length === 64);
const isZero = (s: string) => /^0+$/.test(s);

/** A repository-relative path from the client: no absolute path, no `..`, no NUL, `/`-separated. */
export function checkRelPath(p: unknown): string {
  if (typeof p !== "string" || p === "" || p.length > 4096 || p.includes("\0")) throw new DiffError("Invalid file path");
  if (p.startsWith("/") || p.split("/").some((seg) => seg === ".." || seg === "." || seg === "")) throw new DiffError("Invalid file path");
  return p;
}

/** The scope from query parameters (`diffScopeQuery`); shape only, nothing trusted yet. `all`
    reads a repeatable parameter (`paths`). */
export function scopeFromQuery(q: (name: string) => string | undefined, all: (name: string) => string[] | undefined = () => undefined): DiffScope {
  const kind = q("kind");
  const sessionPath = q("session");
  const path = q("path");
  if (!sessionPath) throw new DiffError("Missing ?session= (a session path)");
  if (!path) throw new DiffError("Missing ?path=");
  const paths = pathsFromQuery(all("paths"));
  const narrowed = paths ? { paths } : {};
  if (kind === "worktree") {
    const pin = pinFromQuery(q);
    return { kind, sessionPath, worktreePath: path, ...(pin ? { pin } : {}), ...narrowed };
  }
  if (kind === "dirty") return { kind, sessionPath, cwd: path, ...narrowed };
  if (kind === "commit" || kind === "merge") {
    const sha = q("sha");
    if (!sha || !HEX.test(sha) || sha.length < 4 || sha.length > 64) throw new DiffError("Invalid ?sha= (hex, 4 to 64 characters)");
    return { kind, sessionPath, repoPath: path, sha: sha.toLowerCase(), ...narrowed };
  }
  throw new DiffError("Invalid ?kind= (worktree, commit, merge or dirty)");
}

/** `&paths=`: each a repository-relative file or folder as the show_changes tool checks them, at
    most its limit; repeats dropped; none is no narrowing. */
function pathsFromQuery(raw: string[] | undefined): string[] | undefined {
  if (!raw?.length) return undefined;
  if (raw.length > SHOW_CHANGES_LIMITS.paths) throw new DiffError(`Too many ?paths= (at most ${SHOW_CHANGES_LIMITS.paths})`);
  for (const p of raw) if (!isRepoPath(p)) throw new DiffError("Invalid ?paths= (a repository-relative file or folder)");
  return [...new Set(raw)];
}

/** A pinned worktree card's `base` and `head` (both full oids, or neither) and its labels. */
function pinFromQuery(q: (name: string) => string | undefined): DiffPin | undefined {
  const base = q("base")?.toLowerCase();
  const head = q("head")?.toLowerCase();
  if (base === undefined && head === undefined) return undefined;
  if (!isSha(base) || !isSha(head)) throw new DiffError("Invalid ?base=/?head= (both full commit ids)");
  const pin: DiffPin = { base, head };
  for (const k of ["baseRef", "branch"] as const) {
    const v = q(k);
    if (v === undefined || v === "") continue;
    if (v.length > MAX_LABEL || /[\x00-\x1f\x7f]/.test(v)) throw new DiffError(`Invalid ?${k}= (display text, at most ${MAX_LABEL} characters)`);
    pin[k] = v;
  }
  return pin;
}

/** The show_changes tool's path filter: the file is one of `paths` or under one of them. */
export const inPaths = (file: string, paths: readonly string[] | undefined): boolean =>
  !paths?.length || paths.some((p) => file === p || file.startsWith(p.endsWith("/") ? p : `${p}/`));

/** A resolved comparison: where to run git and the two sides. `base` is always a tree-ish oid. */
interface Resolved {
  scope: DiffScope;
  top: string;
  base: DiffSide & { treeish: string };
  /** A commit oid, or null for the working tree. */
  head: DiffSide & { treeish: string | null };
}

/** What a session file names: folders it knows, its tracked worktrees (for baseBranch) and its
    merge cards (the only merges a merge scope may name). */
interface Known {
  roots: string[];
  trees: TrackedWorktree[];
  merges: WorktreeMergeDetails[];
}

/** The folders a session's file names, by the rule the show_changes tool applies too
    (pi-config/extensions/show-changes/folders.ts `knownRoots`). Lines are pre-filtered by substring;
    only the header and worktree/worker lines are parsed. */
export function knownFoldersOf(text: string): Known {
  const { cwd, workerCwds } = candidatesOf(text);
  const candidates: unknown[] = [cwd, ...workerCwds];
  const trees: TrackedWorktree[] = [];
  const merges: WorktreeMergeDetails[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("worktree")) continue;
    const h = lineEntry(line);
    if (h?.kind === "state") {
      const set = stateView([h]).latest(WORKTREES)?.data;
      for (const t of set?.trees ?? []) {
        trees.push(t);
        candidates.push(t.path);
      }
    } else if (h?.kind === "note" && !h.inMessage && h.noteType === WORKTREE_MERGE_MESSAGE) {
      const m = normalizeMergeDetails(h.details);
      if (m) {
        merges.push(m);
        candidates.push(m.path);
      }
    }
  }
  return { roots: knownRoots(candidates, agentRoot()), trees, merges };
}

export interface DiffDeps {
  run?: RawGitRunner;
  /** The session file's contents by resolved path (default: resolveSessionPath + readFile, cached). */
  sessionKnown?: (sessionPath: string) => Promise<Known | null>;
  now?: () => number;
  /** UNTRACKED_BUDGET, smaller for tests. */
  untrackedBudget?: number;
  /** MAX_DIFF_FILES, smaller for tests. */
  maxFiles?: number;
  /** ORIGINS_DEADLINE_MS, smaller for tests. */
  originsDeadlineMs?: number;
}

export class GitDiffs {
  private readonly run: RawGitRunner;
  private readonly now: () => number;
  private readonly untrackedBudget: number;
  private readonly maxFiles: number;
  private readonly originsDeadlineMs: number;
  private readonly sessionKnownFn: (sessionPath: string) => Promise<Known | null>;
  private readonly sessions = new Map<string, { mtimeMs: number; size: number; value: Known }>();
  private readonly emptyTrees = new Map<string, string>();
  /** Commit oids are immutable, so a comparison's topological order never changes. */
  private readonly topoCache = new Map<string, Map<string, number>>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(deps: DiffDeps = {}) {
    this.run = deps.run ?? execGitRaw;
    this.now = deps.now ?? Date.now;
    this.untrackedBudget = deps.untrackedBudget ?? UNTRACKED_BUDGET;
    this.maxFiles = deps.maxFiles ?? MAX_DIFF_FILES;
    this.originsDeadlineMs = deps.originsDeadlineMs ?? ORIGINS_DEADLINE_MS;
    this.sessionKnownFn = deps.sessionKnown ?? ((p) => this.readKnown(p));
  }

  private async git(cwd: string, args: readonly string[], cap = LIST_CAP): Promise<RawGitResult> {
    if (this.running >= MAX_CONCURRENT) await new Promise<void>((go) => this.waiting.push(go));
    this.running++;
    try {
      return await this.run(args, { cwd, cap });
    } catch (err) {
      return { code: null, stdout: Buffer.alloc(0), stderr: (err as Error).message || "git failed", cut: false };
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  private async gitText(cwd: string, args: readonly string[], what: string): Promise<string> {
    const r = await this.git(cwd, args);
    if (r.code !== 0) throw new DiffError(gitError(what, r), 500);
    return r.stdout.toString("utf8");
  }

  private async readKnown(raw: string): Promise<Known | null> {
    const path = resolveSessionPath(raw);
    if (!path) return null;
    let st;
    try {
      st = await stat(path);
    } catch {
      return null;
    }
    const hit = this.sessions.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
    const value = knownFoldersOf(await readFile(path, "utf8"));
    this.sessions.delete(path);
    this.sessions.set(path, { mtimeMs: st.mtimeMs, size: st.size, value });
    while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
    return value;
  }

  /** The repository top level of a client-named folder the session knows, or a DiffError. */
  private async trustedTop(scope: DiffScope): Promise<{ top: string; known: Known; card?: WorktreeMergeDetails }> {
    const known = await this.sessionKnownFn(scope.sessionPath);
    if (!known) throw new DiffError("Unknown session");
    const raw = scope.kind === "worktree" ? scope.worktreePath : scope.kind === "commit" || scope.kind === "merge" ? scope.repoPath : scope.cwd;
    if (typeof raw !== "string" || !isAbsolute(raw) || raw.includes("\0")) throw new DiffError("Invalid ?path= (an absolute folder)");
    const dir = canonical(raw);
    if (!folderKnown(dir, known.roots)) throw new DiffError("That folder is not one this session knows");
    let card: WorktreeMergeDetails | undefined;
    if (scope.kind === "merge") {
      const sha = scope.sha.toLowerCase();
      card = known.merges.filter((m) => m.sha.toLowerCase() === sha && canonical(m.path) === dir).at(-1);
      if (!card) throw new DiffError("That commit is not a merge this session recorded");
    }
    // A merged worktree is often removed after the merge (its folder gone, or left behind with
    // stray files and no `.git`), but its commit lives on in the repository: read it from another
    // folder the session knows that has it. So is a pinned card's saved head.
    const elsewhere = async (): Promise<string | null> => {
      const sha = scope.kind === "commit" || scope.kind === "merge" ? scope.sha : scope.kind === "worktree" ? scope.pin?.head : undefined;
      return sha ? this.topHolding(known, sha) : null;
    };
    if (!(await isDir(dir))) {
      const top = await elsewhere();
      if (top) return { top, known, card };
      throw new DiffError("That folder does not exist", 404);
    }
    const top = (await this.topOf(dir)) ?? (await elsewhere());
    if (!top) throw new DiffError("That folder is not in a git work tree");
    return { top, known, card };
  }

  /** git as pi-config/extensions/worktrees/git.ts's `Git` runner, for mergedReviewBase. */
  private readonly gitLines = async (args: string[], cwd: string) => {
    const r = await this.git(cwd, args);
    return { code: r.code ?? 1, stdout: r.stdout.toString("utf8"), stderr: r.stderr };
  };

  private async topOf(dir: string): Promise<string | null> {
    const r = await this.git(dir, ["rev-parse", "--show-toplevel"]);
    const top = r.stdout.toString("utf8").trim();
    return r.code === 0 && top ? top : null;
  }

  /** The top level of the first existing known folder (header cwd first) whose repository has the commit. */
  private async topHolding(known: Known, sha: string): Promise<string | null> {
    for (const root of known.roots) {
      const dir = canonical(root);
      if (!(await isDir(dir))) continue;
      const top = await this.topOf(dir);
      if (!top) continue;
      const r = await this.git(top, ["rev-parse", "--verify", "-q", `${sha}^{commit}`]);
      if (r.code === 0) return top;
    }
    return null;
  }

  private async emptyTree(top: string): Promise<string> {
    const hit = this.emptyTrees.get(top);
    if (hit) return hit;
    const oid = (await this.gitText(top, ["hash-object", "-t", "tree", "/dev/null"], "hash-object")).trim();
    if (!isOid(oid)) throw new DiffError("could not name the empty tree", 500);
    this.emptyTrees.set(top, oid);
    return oid;
  }

  private async headOid(top: string): Promise<string | null> {
    const r = await this.git(top, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
    const oid = r.stdout.toString("utf8").trim();
    return r.code === 0 && isOid(oid) ? oid : null;
  }

  /** Resolve every ref of the scope, server-side. */
  async resolve(scope: DiffScope): Promise<Resolved> {
    const { top, known, card } = await this.trustedTop(scope);
    if (scope.kind === "dirty") {
      const head = await this.headOid(top);
      return {
        scope,
        top,
        base: head ? { label: "HEAD", oid: head, treeish: head } : { label: "Empty tree", treeish: await this.emptyTree(top) },
        head: { label: "Working tree", treeish: null },
      };
    }
    if (scope.kind === "commit") {
      const r = await this.git(top, ["rev-parse", "--verify", "-q", `${scope.sha}^{commit}`]);
      const oid = r.stdout.toString("utf8").trim();
      if (r.code !== 0 || !isOid(oid)) throw new DiffError("No such commit in that repository", 404);
      const p = await this.git(top, ["rev-parse", "--verify", "-q", `${oid}^1`]);
      const parent = p.stdout.toString("utf8").trim();
      const short = oid.slice(0, 7);
      return {
        scope,
        top,
        base: p.code === 0 && isOid(parent) ? { label: `${short}^1`, oid: parent, treeish: parent } : { label: "Empty tree", treeish: await this.emptyTree(top) },
        head: { label: short, oid, treeish: oid },
      };
    }
    if (scope.kind === "merge" && card) {
      const r = await this.git(top, ["rev-parse", "--verify", "-q", `${card.sha}^{commit}`]);
      const oid = r.stdout.toString("utf8").trim();
      if (r.code !== 0 || !isOid(oid)) throw new DiffError("No such commit in that repository", 404);
      const short = oid.slice(0, 7);
      const head = { label: card.branch, oid, treeish: oid };
      if (card.fastForward) {
        // The card's sha is the branch tip. With the tip as its own target and merge-base there is
        // no landing commit to find, so only mergedReviewBase's tracked-base rule applies: the
        // tracked base when it is an ancestor of the tip and not the tip itself.
        const tracked = known.trees.filter((t) => canonical(t.path) === canonical(card.path)).at(-1);
        const from = await mergedReviewBase(this.gitLines, top, oid, oid, oid, tracked?.base);
        if (from && isOid(from.base)) return { scope, top, base: { label: `${from.base.slice(0, 7)} (created from)`, oid: from.base, treeish: from.base }, head };
      }
      const p = await this.git(top, ["rev-parse", "--verify", "-q", `${oid}^1`]);
      const parent = p.stdout.toString("utf8").trim();
      return {
        scope,
        top,
        base:
          p.code === 0 && isOid(parent)
            ? { label: card.fastForward ? `${short}^1` : `${card.target} before ${short}`, oid: parent, treeish: parent }
            : { label: "Empty tree", treeish: await this.emptyTree(top) },
        head,
      };
    }
    if (scope.kind === "worktree" && scope.pin) {
      // A card's saved comparison: both must be commits here before anything else reads them.
      const { pin } = scope;
      const commit = async (oid: string) => {
        if (!isOid(oid)) return null;
        const r = await this.git(top, ["rev-parse", "--verify", "-q", "--end-of-options", `${oid}^{commit}`]);
        const out = r.stdout.toString("utf8").trim();
        return r.code === 0 && out === oid ? out : null;
      };
      const [base, head] = await Promise.all([commit(pin.base), commit(pin.head)]);
      if (!base || !head) throw new DiffError("No such commit in that repository", 404);
      return {
        scope,
        top,
        base: { label: pin.baseRef ?? base.slice(0, 7), oid: base, treeish: base },
        head: { label: pin.branch ?? head.slice(0, 7), oid: head, treeish: head },
      };
    }
    const head = await this.headOid(top);
    if (!head) throw new DiffError("No commits on HEAD", 404);
    const symbolic = (await this.git(top, ["symbolic-ref", "-q", "HEAD"])).stdout.toString("utf8").trim();
    const branch = symbolic.startsWith("refs/heads/") ? symbolic.slice("refs/heads/".length) : null;
    const tracked = known.trees.filter((t) => canonical(t.path) === canonical(top)).at(-1);
    // The one rule the show_changes tool shares; once merged, what the merge brought in.
    const rb = await reviewBase(this.gitLines, top, { head, branch, tracked: tracked ? { baseBranch: tracked.baseBranch, base: tracked.base } : undefined });
    const headSide = { label: branch ?? head.slice(0, 7), oid: head, treeish: head };
    if (!rb.ok) {
      if (rb.refusal === "on-base-branch" && branch) return { scope, top, base: { label: `${branch} (merge-base)`, oid: head, treeish: head }, head: headSide };
      throw new DiffError(
        rb.refusal === "detached"
          ? "HEAD is not on a branch: no base to compare it against"
          : rb.refusal === "no-history"
            ? "No common history with the base branch, and no commit it was created from"
            : "No base branch (master, main or origin/HEAD) in that repository, and no commit it was created from",
        404,
      );
    }
    if (!isOid(rb.base)) throw new DiffError("could not resolve the base", 500);
    const label = rb.how === "merge-base" ? `${rb.ref ?? rb.label} (merge-base)` : rb.label;
    return { scope, top, base: { label, oid: rb.base, treeish: rb.base }, head: headSide };
  }

  /** The diff command's leading args for this comparison (before options and pathspecs). */
  private diffCmd(r: Resolved): string[] {
    return r.head.treeish ? ["diff-tree", "-r"] : ["diff-index"];
  }
  private diffRefs(r: Resolved): string[] {
    return r.head.treeish ? [r.base.treeish, r.head.treeish] : [r.base.treeish];
  }

  async summary(scope: DiffScope): Promise<DiffSummary> {
    const r = await this.resolve(scope);
    const common = ["-M", "-z", "--no-ext-diff", "--no-textconv"];
    const [raw, num] = await Promise.all([
      this.git(r.top, [...this.diffCmd(r), "--raw", "--no-abbrev", ...common, ...this.diffRefs(r), "--"]),
      this.git(r.top, [...this.diffCmd(r), "--numstat", ...common, ...this.diffRefs(r), "--"]),
    ]);
    if (raw.code !== 0 && !raw.cut) throw new DiffError(gitError("diff --raw", raw), 500);
    if (num.code !== 0 && !num.cut) throw new DiffError(gitError("diff --numstat", num), 500);
    const counts = parseNumstatZ(num.stdout.toString("utf8"));
    const files: DiffFileSummary[] = [];
    const paths = scope.paths;
    for (const e of parseRawZ(raw.stdout.toString("utf8"))) {
      if (!inPaths(e.path, paths)) continue;
      const n = counts.get(e.path);
      if (!n) {
        // Listed by --raw with no numstat line: a stat-only change in the working tree (content equal).
        if (!num.cut) continue;
      }
      files.push(fileOf(e, n));
    }
    let cut = raw.cut || num.cut;
    if (!r.head.treeish) {
      const untracked = await this.untracked(r.top);
      cut ||= untracked.cut;
      const listed = new Set(files.map((f) => f.path));
      const budget = { bytes: this.untrackedBudget, files: this.maxFiles };
      for (const path of untracked.paths) if (!listed.has(path) && inPaths(path, paths)) files.push(await this.untrackedSummary(r.top, path, budget));
      files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    }
    const totals = { files: files.length, added: 0, removed: 0 };
    for (const f of files) {
      totals.added += f.added;
      totals.removed += f.removed;
    }
    const out: DiffSummary = {
      scope,
      repo: r.top,
      base: side(r.base),
      head: side(r.head),
      files: files.slice(0, this.maxFiles),
      totals,
      generatedAt: this.now(),
    };
    if (cut || files.length > this.maxFiles) out.truncated = true;
    return out;
  }

  private async untracked(top: string, file?: string): Promise<{ paths: string[]; cut: boolean }> {
    const r = await this.git(top, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...(file ? [file] : [])]);
    if (r.code !== 0 && !r.cut) throw new DiffError(gitError("ls-files --others", r), 500);
    const parts = r.stdout.toString("utf8").split("\0");
    if (r.cut) parts.pop(); // the last name may be cut short
    return { paths: parts.filter(Boolean), cut: r.cut };
  }

  /** One untracked file's row, read within what is left of the summary's `budget` (spent here). */
  private async untrackedSummary(top: string, path: string, budget: { bytes: number; files: number }): Promise<DiffFileSummary> {
    if (budget.files <= 0) return { path, status: "A", added: 0, removed: 0, untracked: true, tooLarge: true };
    budget.files--;
    const read = await readUntracked(join(top, path), Math.min(MAX_UNTRACKED_READ, budget.bytes));
    budget.bytes -= read.read;
    const f: DiffFileSummary = { path, status: read.binary ? "B" : "A", added: read.binary ? 0 : read.lines, removed: 0, untracked: true };
    if (read.tooLarge && !read.binary) f.tooLarge = true;
    return f;
  }

  /** One file's patch. With `context`, also its old side's whole text (`oldText`), read by the
      blob oid this patch names, so folded unchanged lines can open. With `origins`, the commits
      each of its units came from (`hunkCommits`, `commits`), or `originsUnknown`. */
  async patch(scope: DiffScope, file: string, oldFile?: string, opts: { context?: boolean; origins?: boolean } = {}): Promise<DiffFilePatch> {
    const path = checkRelPath(file);
    const oldPath = oldFile === undefined || oldFile === "" || oldFile === path ? undefined : checkRelPath(oldFile);
    if (!inPaths(path, scope.paths)) throw new DiffError("That file is not in this diff", 404);
    const r = await this.resolve(scope);
    const specs = oldPath ? [oldPath, path] : [path];
    const res = await this.git(
      r.top,
      [...this.diffCmd(r), "-p", "--histogram", "-M", "--full-index", "--no-color", "--no-ext-diff", "--no-textconv", ...this.diffRefs(r), "--", ...specs],
      PATCH_CAP,
    );
    if (res.code !== 0 && !res.cut) throw new DiffError(gitError("diff -p", res), 500);
    const sides = { base: side(r.base), head: side(r.head) };
    if (res.cut) {
      // Too big to send: name the file from the raw listing instead.
      const raw = await this.git(r.top, [...this.diffCmd(r), "--raw", "--no-abbrev", "-M", "-z", ...this.diffRefs(r), "--", ...specs]);
      const e = parseRawZ(raw.stdout.toString("utf8")).find((x) => x.path === path);
      if (!e) throw new DiffError("That file is not in this diff", 404);
      const s = fileOf(e, undefined);
      const big: DiffFilePatch = { path, ...(s.oldPath ? { oldPath: s.oldPath } : {}), status: s.status === "B" ? "M" : s.status, tooLarge: { bytes: res.stdout.length, cap: PATCH_CAP }, ...oids(s), ...sides };
      return opts.origins ? { ...big, ...(await this.origins(r, big, s.status === "D")) } : big;
    }
    const sections = splitPatch(res.stdout.toString("utf8")).filter((s) => s.path === path && (!oldPath || s.oldPath === oldPath || s.oldPath === path));
    if (sections.length === 0) {
      if (!r.head.treeish && !oldPath) {
        const u = await this.untracked(r.top, path);
        if (u.paths.includes(path)) return { ...(await this.untrackedPatch(r.top, path)), ...sides };
      }
      throw new DiffError("That file is not in this diff", 404);
    }
    // A type change (file ↔ symlink) is two sections for one path: a delete, then an add.
    const first = sections[0]!;
    const last = sections[sections.length - 1]!;
    const binary = sections.some((s) => s.binary);
    const status: DiffFileStatus = binary ? "B" : sections.length > 1 ? "T" : first.status;
    const out: DiffFilePatch = { path, status, ...sides };
    if (first.oldPath !== path) out.oldPath = first.oldPath;
    if (first.oldOid) out.oldOid = first.oldOid;
    // Against the working tree, -p hashes the file for its index line without storing it: that
    // oid names no object, so it is not passed on.
    if (last.newOid && r.head.treeish) out.newOid = last.newOid;
    if (binary) out.binary = true;
    else out.patch = sections.map((s) => s.text).join("");
    // Only a single-section patch has hunks against one old side (a type change is two).
    if (opts.context && out.patch && sections.length === 1 && first.oldOid) {
      const text = await this.oldSide(r.top, first.oldOid);
      if (text !== null) out.oldText = text;
    }
    return opts.origins ? { ...out, ...(await this.origins(r, out, sections.some((x) => x.status === "D") && sections.length === 1)) } : out;
  }

  /** The commits each unit of `p` came from (§chat.changes/steps): none for the working tree, the
      one commit for a commit scope, else from history within ORIGINS_DEADLINE_MS. */
  private async origins(r: Resolved, p: DiffFilePatch, deleted: boolean): Promise<Pick<DiffFilePatch, "hunkCommits" | "commits" | "originsUnknown">> {
    const head = r.head.treeish ? r.head.oid : undefined;
    if (!head) return {};
    const hunks = p.patch ? patchHunks(p.patch) : [];
    const units = Math.max(1, hunks.length);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((done) => (timer = setTimeout(() => done(null), this.originsDeadlineMs)));
    try {
      const work =
        r.scope.kind === "commit"
          ? Promise.resolve(Array.from({ length: units }, () => [head]))
          : this.unitCommits(r.top, r.base.oid, head, p, hunks, deleted || !p.patch || hunks.length === 0);
      const shasPerUnit = await Promise.race([work.catch(() => null), late]);
      if (!shasPerUnit) return { originsUnknown: true };
      const all = [...new Set(shasPerUnit.flat())];
      const info = all.length ? await Promise.race([this.commitInfo(r.top, all).catch(() => null), late]) : [];
      if (!info || info.length !== all.length) return { originsUnknown: true };
      // Ancestors first (`rev-list --topo-order --reverse`), so commits made in the same second
      // keep parent before child; by author time where that order can't be read.
      // `order` is the commit's place in the whole comparison, the same in every file's read.
      const topo =
        r.scope.kind === "commit" ? new Map([[head, 0]]) : info.length ? await Promise.race([this.topoOrder(r.top, r.base.oid, head).catch(() => null), late]) : null;
      for (const c of info) {
        const n = topo?.get(c.sha);
        if (n !== undefined) c.order = n;
      }
      const rank = (c: DiffCommit) => c.order ?? Number.MAX_SAFE_INTEGER;
      info.sort((a, b) => rank(a) - rank(b) || a.authorTime - b.authorTime || (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0));
      const at = new Map(info.map((c, i) => [c.sha, i]));
      return { commits: info, hunkCommits: shasPerUnit.map((u) => [...new Set(u)].map((sha) => at.get(sha)!).sort((a, b) => a - b)) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Per unit, the shas it came from in `base..head` (just `head`'s history without a base). Throws
      on a failed read. */
  private async unitCommits(top: string, base: string | undefined, head: string, p: DiffFilePatch, hunks: PatchHunk[], whole: boolean): Promise<string[][]> {
    const range = base ? `${base}..${head}` : head;
    const specs = p.oldPath ? [p.path, p.oldPath] : [p.path];
    const read = async (args: string[]) => {
      const res = await this.git(top, args);
      if (res.code !== 0) throw new Error(gitError(args[0]!, res));
      return res.stdout.toString("utf8");
    };
    const touching = async () => (await read(["log", "--format=%H", range, "--", ...specs])).split("\n").filter(isOid);
    if (whole) {
      const all = await touching();
      return Array.from({ length: Math.max(1, hunks.length) }, () => all);
    }
    const out: string[][] = hunks.map(() => []);
    // Added lines: who last wrote them within the range (a boundary line, older than base, counts for none).
    const adding = hunks.filter((h) => h.added.length > 0);
    if (adding.length > 0) {
      const ls = adding.flatMap((h) => ["-L", `${h.newStart},${h.newStart + Math.max(1, h.newLines) - 1}`]);
      const lines = parseBlame(await read(["blame", "--porcelain", "--incremental", ...ls, range, "--", p.path]), false);
      hunks.forEach((h, i) => {
        for (const n of h.added) {
          const sha = lines.get(n);
          if (sha) out[i]!.push(sha);
        }
      });
    }
    // A hunk that only removes lines: the commit that removed them, the first on the ancestry path
    // from the last commit that still held each line (a reverse blame) that touched the file.
    const removing = hunks.map((h, i) => ({ h, i })).filter(({ h }) => h.added.length === 0 && h.removed.length > 0);
    if (removing.length > 0) {
      try {
        if (!base) throw new Error("no base to walk from");
        const ls = removing.flatMap(({ h }) => ["-L", `${h.oldStart},${h.oldStart + Math.max(1, h.oldLines) - 1}`]);
        const last = parseBlame(await read(["blame", "--reverse", "--porcelain", "--incremental", ...ls, range, "--", p.oldPath ?? p.path]), true);
        const removedBy = new Map<string, string | undefined>();
        for (const { h, i } of removing) {
          for (const n of h.removed) {
            const holder = last.get(n);
            if (!holder) continue;
            if (!removedBy.has(holder)) {
              const next = (await read(["rev-list", "--ancestry-path", "--topo-order", "--reverse", `${holder}..${head}`, "--", ...specs])).split("\n").find(isOid);
              removedBy.set(holder, next);
            }
            const sha = removedBy.get(holder);
            if (sha) out[i]!.push(sha);
          }
        }
      } catch {
        const all = await touching();
        for (const { i } of removing) out[i] = all;
      }
    }
    return out;
  }

  /** Each commit of `base..head` (all of `head`'s history without a base) → its place, oldest first. */
  private async topoOrder(top: string, base: string | undefined, head: string): Promise<Map<string, number>> {
    // Every patch read of one comparison asks for the same order: kept for the last few.
    const key = `${top}\0${base ?? ""}\0${head}`;
    const hit = this.topoCache.get(key);
    if (hit) return hit;
    const res = await this.git(top, ["rev-list", "--topo-order", "--reverse", base ? `${base}..${head}` : head, "--"]);
    if (res.code !== 0) throw new Error(gitError("rev-list", res));
    const order = new Map(res.stdout.toString("utf8").split("\n").filter(isOid).map((sha, i) => [sha, i]));
    this.topoCache.set(key, order);
    while (this.topoCache.size > 16) this.topoCache.delete(this.topoCache.keys().next().value!);
    return order;
  }

  /** Each commit's subject and author time, in no particular order. */
  private async commitInfo(top: string, shas: string[]): Promise<DiffCommit[]> {
    const res = await this.git(top, ["log", "--no-walk=unsorted", "--format=%H%x00%at%x00%s", ...shas, "--"]);
    if (res.code !== 0) throw new Error(gitError("log", res));
    const out: DiffCommit[] = [];
    for (const line of res.stdout.toString("utf8").split("\n")) {
      const [sha, at, subject] = line.split("\0");
      if (sha && isOid(sha) && at && /^\d+$/.test(at)) out.push({ sha, subject: subject ?? "", authorTime: Number(at) * 1000 });
    }
    return out;
  }

  /** The text of a blob this diff named, or null: not a blob (a submodule), past BLOB_CAP, binary. */
  private async oldSide(top: string, oid: string): Promise<string | null> {
    if (!isOid(oid)) return null;
    const b = await this.git(top, ["cat-file", "blob", oid], BLOB_CAP);
    if (b.cut || b.code !== 0 || looksBinary(b.stdout)) return null;
    return b.stdout.toString("utf8");
  }

  private async untrackedPatch(top: string, path: string): Promise<Omit<DiffFilePatch, "base" | "head">> {
    const read = await readUntracked(join(top, path), MAX_UNTRACKED_READ, true);
    if (read.binary) return { path, status: "B", binary: true };
    if (read.tooLarge) return { path, status: "A", tooLarge: { bytes: read.size, cap: MAX_UNTRACKED_READ } };
    const text = read.text ?? "";
    const lines = text === "" ? [] : text.split("\n");
    const noEol = lines.length > 0 && lines[lines.length - 1] !== "";
    if (!noEol) lines.pop();
    const q = (p: string) => quotePath(p);
    let patch = `diff --git ${q(`a/${path}`)} ${q(`b/${path}`)}\nnew file mode ${read.mode}\n`;
    if (lines.length > 0) {
      patch += `--- /dev/null\n+++ ${q(`b/${path}`)}\n@@ -0,0 +1${lines.length === 1 ? "" : `,${lines.length}`} @@\n`;
      patch += lines.map((l) => `+${l}\n`).join("");
      if (noEol) patch += "\\ No newline at end of file\n";
    }
    return { path, status: "A", patch };
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function side(s: DiffSide): DiffSide {
  return s.oid ? { label: s.label, oid: s.oid } : { label: s.label };
}

function oids(s: DiffFileSummary): Pick<DiffFileSummary, "oldOid" | "newOid"> {
  return { ...(s.oldOid ? { oldOid: s.oldOid } : {}), ...(s.newOid ? { newOid: s.newOid } : {}) };
}

interface RawEntry {
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
  /** Letter: M A D R C T U X. */
  status: string;
  path: string;
  oldPath?: string;
}

/** `--raw -z`: `:oldmode newmode oldoid newoid STATUS\0path\0[newpath\0]`. */
export function parseRawZ(out: string): RawEntry[] {
  const parts = out.split("\0");
  const entries: RawEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const head = parts[i]!;
    if (!head.startsWith(":")) continue;
    const [oldMode, newMode, oldOid, newOid, st] = head.slice(1).split(" ");
    if (!oldMode || !newMode || !oldOid || !newOid || !st) continue;
    const letter = st[0]!;
    if (letter === "R" || letter === "C") {
      const from = parts[i + 1];
      const to = parts[i + 2];
      i += 2;
      if (from === undefined || to === undefined) break;
      entries.push({ oldMode, newMode, oldOid, newOid, status: letter, path: to, oldPath: from });
    } else {
      const p = parts[i + 1];
      i += 1;
      if (p === undefined) break;
      entries.push({ oldMode, newMode, oldOid, newOid, status: letter, path: p });
    }
  }
  return entries;
}

/** `--numstat -z`: `a\tr\tpath\0`, or for a rename `a\tr\t\0old\0new\0`; binary is `-\t-`. Keyed by (new) path. */
export function parseNumstatZ(out: string): Map<string, { added: number; removed: number; binary: boolean }> {
  const parts = out.split("\0");
  const map = new Map<string, { added: number; removed: number; binary: boolean }>();
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]!);
    if (!m) continue;
    let path = m[3]!;
    if (path === "") {
      path = parts[i + 2] ?? "";
      i += 2;
    }
    if (!path) continue;
    const binary = m[1] === "-" || m[2] === "-";
    map.set(path, { added: binary ? 0 : Number(m[1]), removed: binary ? 0 : Number(m[2]), binary });
  }
  return map;
}

function fileOf(e: RawEntry, n: { added: number; removed: number; binary: boolean } | undefined): DiffFileSummary {
  const status: DiffFileStatus = n?.binary ? "B" : e.status === "A" || e.status === "D" || e.status === "R" || e.status === "T" ? e.status : e.status === "C" ? "A" : "M";
  const f: DiffFileSummary = { path: e.path, status, added: n?.added ?? 0, removed: n?.removed ?? 0 };
  if (e.oldPath && e.status === "R") f.oldPath = e.oldPath;
  if (!isZero(e.oldOid)) f.oldOid = e.oldOid;
  if (!isZero(e.newOid)) f.newOid = e.newOid;
  return f;
}

/** Git's C-style quoting of a path (core.quotePath=false: bytes ≥ 0x80 are left as they are). */
export function quotePath(p: string): string {
  if (!/["\\\x00-\x1f\x7f]/.test(p)) return p;
  const esc: Record<string, string> = { "\x07": "\\a", "\b": "\\b", "\t": "\\t", "\n": "\\n", "\v": "\\v", "\f": "\\f", "\r": "\\r", '"': '\\"', "\\": "\\\\" };
  return `"${p.replace(/["\\\x00-\x1f\x7f]/g, (c) => esc[c] ?? `\\${c.charCodeAt(0).toString(8).padStart(3, "0")}`)}"`;
}

function unquotePath(s: string): string {
  if (!s.startsWith('"')) return s;
  const body = s.slice(1, -1);
  const bytes: number[] = [];
  const map: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const n = body[i + 1]!;
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(map[n] ?? n.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

interface PatchSection {
  text: string;
  path: string;
  oldPath: string;
  status: DiffFileStatus;
  binary: boolean;
  oldOid?: string;
  newOid?: string;
}

/** Split `diff -p` output into per-file sections, naming each from its extended header lines
    (`---`/`+++`, `rename from/to`), which, unlike the `diff --git` line, are unambiguous. */
export function splitPatch(text: string): PatchSection[] {
  const out: PatchSection[] = [];
  const starts: number[] = [];
  const re = /^diff --git /gm;
  for (let m = re.exec(text); m; m = re.exec(text)) starts.push(m.index);
  starts.forEach((at, i) => {
    const body = text.slice(at, starts[i + 1] ?? text.length);
    const lines = body.split("\n");
    let oldPath: string | undefined;
    let newPath: string | undefined;
    let status: DiffFileStatus = "M";
    let binary = false;
    let oldOid: string | undefined;
    let newOid: string | undefined;
    for (const l of lines.slice(1)) {
      if (l.startsWith("@@")) break;
      if (l.startsWith("rename from ")) oldPath = unquotePath(l.slice(12));
      else if (l.startsWith("rename to ")) newPath = unquotePath(l.slice(10));
      // git ends a ---/+++ name that contains a space with a tab.
      else if (l.startsWith("--- ")) oldPath ??= l === "--- /dev/null" ? undefined : unquotePath(l.slice(4).replace(/\t$/, "")).replace(/^a\//, "");
      else if (l.startsWith("+++ ")) newPath ??= l === "+++ /dev/null" ? undefined : unquotePath(l.slice(4).replace(/\t$/, "")).replace(/^b\//, "");
      else if (l.startsWith("new file mode")) status = "A";
      else if (l.startsWith("deleted file mode")) status = "D";
      else if (l.startsWith("similarity index")) status = "R";
      else if (l.startsWith("Binary files ")) binary = true;
      else if (l.startsWith("index ")) {
        const m = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/.exec(l);
        if (m) {
          if (!isZero(m[1]!)) oldOid = m[1];
          if (!isZero(m[2]!)) newOid = m[2];
        }
      }
    }
    if (oldPath === undefined || newPath === undefined) {
      // No ---/+++ (binary, mode-only, empty file): fall back to the `diff --git a/X b/Y` line,
      // exact when both halves are the same path (the only case without rename lines).
      const g = headerPaths(lines[0]!);
      oldPath ??= g?.old;
      newPath ??= g?.new;
      if (status === "D") newPath = oldPath;
      if (status === "A") oldPath = newPath;
    }
    if (status === "D" && oldPath) newPath = oldPath;
    if (status === "A" && newPath) oldPath = newPath;
    if (!newPath || !oldPath) return;
    out.push({ text: body, path: newPath, oldPath, status, binary, oldOid, newOid });
  });
  return out;
}

/** `diff --git a/X b/Y` → X, Y; for an unquoted header without renames X = Y, so split in the middle. */
function headerPaths(line: string): { old: string; new: string } | null {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*") (.*)$/.exec(rest);
    if (!m) return null;
    return { old: unquotePath(m[1]!).replace(/^a\//, ""), new: unquotePath(m[2]!).replace(/^b\//, "") };
  }
  if (rest.endsWith('"')) {
    const i = rest.indexOf(' "');
    return { old: rest.slice(0, i).replace(/^a\//, ""), new: unquotePath(rest.slice(i + 1)).replace(/^b\//, "") };
  }
  // "a/P b/P": length is 2 + 2·|P| + 3.
  const n = (rest.length - 5) / 2;
  if (!Number.isInteger(n) || n < 1) return null;
  const a = rest.slice(2, 2 + n);
  const b = rest.slice(n + 5);
  return a === b ? { old: a, new: b } : null;
}

interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** New-side line numbers of its `+` lines; old-side ones of its `-` lines. */
  added: number[];
  removed: number[];
}

/** The hunks of a patch (every section), in order, with the lines each adds and removes. */
export function patchHunks(patch: string): PatchHunk[] {
  const out: PatchHunk[] = [];
  let h: PatchHunk | undefined;
  let o = 0;
  let n = 0;
  for (const line of patch.split("\n")) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      h = { oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]), added: [], removed: [] };
      out.push(h);
      o = h.oldStart;
      n = h.newStart;
      continue;
    }
    if (!h) continue;
    if (line.startsWith("diff --git ")) h = undefined;
    else if (line.startsWith("+")) h.added.push(n++);
    else if (line.startsWith("-")) h.removed.push(o++);
    else if (line.startsWith(" ")) {
      o++;
      n++;
    }
  }
  return out;
}

/** `blame --porcelain --incremental`: final line number → commit. Without `reverse`, a line of a
    boundary commit (older than the range) is left out. */
function parseBlame(text: string, reverse: boolean): Map<number, string> {
  const groups: { sha: string; final: number; count: number }[] = [];
  const boundary = new Set<string>();
  let sha: string | undefined;
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ (\d+) (\d+)$/.exec(line);
    if (m) {
      sha = m[1]!;
      groups.push({ sha, final: Number(m[2]), count: Number(m[3]) });
    } else if (line === "boundary" && sha) boundary.add(sha);
  }
  const out = new Map<number, string>();
  for (const g of groups) {
    if (!reverse && boundary.has(g.sha)) continue;
    for (let i = 0; i < g.count; i++) out.set(g.final + i, g.sha);
  }
  return out;
}

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

/** An untracked file's line count (and text, when asked and whole): at most `limit` bytes are read,
    and a file past them is `tooLarge`, its lines counted only that far. `read` is the bytes read.
    Symlinks: the link as git stores it. */
async function readUntracked(
  abs: string,
  limit: number,
  wantText = false,
): Promise<{ binary: boolean; lines: number; size: number; read: number; mode: string; text?: string; tooLarge?: boolean }> {
  let st;
  try {
    st = await lstat(abs);
  } catch {
    return { binary: false, lines: 0, size: 0, read: 0, mode: "100644" };
  }
  if (st.isSymbolicLink()) {
    const target = await readlink(abs).catch(() => "");
    return { binary: false, lines: 1, size: target.length, read: 0, mode: "120000", text: target };
  }
  const mode = st.mode & 0o111 ? "100755" : "100644";
  if (!st.isFile()) return { binary: false, lines: 0, size: 0, read: 0, mode };
  const buf = await readHead(abs, Math.max(0, Math.min(st.size, limit)));
  const tooLarge = st.size > buf.length ? { tooLarge: true } : {};
  if (looksBinary(buf)) return { binary: true, lines: 0, size: st.size, read: buf.length, mode, ...tooLarge };
  const text = buf.toString("utf8");
  return { binary: false, lines: countLines(text), size: st.size, read: buf.length, mode, ...tooLarge, ...(wantText && !tooLarge.tooLarge ? { text } : {}) };
}

/** At most the first `n` bytes of a file (fewer if it is shorter now); nothing on an error. */
async function readHead(abs: string, n: number): Promise<Buffer> {
  if (n === 0) return Buffer.alloc(0);
  let fh;
  try {
    fh = await open(abs, "r");
    const buf = Buffer.alloc(n);
    let got = 0;
    while (got < n) {
      const { bytesRead } = await fh.read(buf, got, n - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return buf.subarray(0, got);
  } catch {
    return Buffer.alloc(0);
  } finally {
    await fh?.close().catch(() => {});
  }
}

function countLines(text: string): number {
  if (text === "") return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith("\n") ? n : n + 1;
}

/** The server's one instance. */
export const gitDiffs = new GitDiffs();
