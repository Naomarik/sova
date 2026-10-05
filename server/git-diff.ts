// Git diffs for the changes viewer and merge cards (GET /api/diff/summary|patch,
// shared/protocol.ts DiffScope / DiffSummary / DiffFilePatch).
//
// Three comparisons, all chosen here, never a ref from the client:
//  - worktree: the worktree's committed HEAD against its merge-base with its base branch (the
//    tracked worktree's `baseBranch` when that branch exists, else server/worktrees.ts pickBase:
//    master, main, origin/HEAD's target). Once the branch is merged that merge-base is HEAD
//    itself; then, for a branch with commits beyond its tracked base, HEAD against what its merge
//    brought in (pi-config/extensions/worktrees/git.ts mergedReviewBase: the merge-base with the
//    first parent of the base branch's first-parent commit that landed it, labelled "master before
//    <sha>"; after a fast-forward the tracked base commit, when it is an ancestor);
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
// Read-only, with server/worktrees.ts's discipline: plumbing only (diff-tree, diff-index,
// ls-files, cat-file, rev-parse, for-each-ref, merge-base, rev-list), `--no-ext-diff --no-textconv`,
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
import { isAbsolute, join, normalize } from "node:path";
import type { DiffFilePatch, DiffFileStatus, DiffFileSummary, DiffScope, DiffSide, DiffSummary } from "../shared/protocol";
import { mergedReviewBase } from "../pi-config/extensions/worktrees/git.ts";
import { canonical, isWithin, normalizeMergeDetails, type TrackedWorktree, type WorktreeMergeDetails, WORKTREE_MERGE_MESSAGE } from "../pi-config/extensions/worktrees/state.ts";
import { lineEntry } from "./harness/pi/reader";
import { WORKTREES } from "./harness/state-kinds";
import { stateView } from "./harness/state-view";
import { resolveSessionPath } from "./paths";
import { parseTargetCwd } from "./targets";
import { candidatesOf, pickBase } from "./worktrees";

const GIT_TIMEOUT_MS = 5_000;
const MAX_CONCURRENT = 4;
/** Most files one summary lists; `totals` still counts the rest. */
export const MAX_DIFF_FILES = 3_000;
/** --raw / --numstat / ls-files output. */
const LIST_CAP = 8 * 1024 * 1024;
/** One file's patch; past it the file is `tooLarge`. */
export const PATCH_CAP = 1024 * 1024;
/** A file's old side, sent whole for expanding folded context; past it the side is not sent. */
export const BLOB_CAP = 8 * 1024 * 1024;
/** An untracked file past this is not diffed (`tooLarge`), and is counted only this far. */
export const MAX_UNTRACKED_READ = PATCH_CAP;
/** Untracked bytes one summary reads in all; the files after it are `tooLarge` and uncounted. */
export const UNTRACKED_BUDGET = 16 * 1024 * 1024;
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

/** The scope from query parameters (`diffScopeQuery`); shape only, nothing trusted yet. */
export function scopeFromQuery(q: (name: string) => string | undefined): DiffScope {
  const kind = q("kind");
  const sessionPath = q("session");
  const path = q("path");
  if (!sessionPath) throw new DiffError("Missing ?session= (a session path)");
  if (!path) throw new DiffError("Missing ?path=");
  if (kind === "worktree") return { kind, sessionPath, worktreePath: path };
  if (kind === "dirty") return { kind, sessionPath, cwd: path };
  if (kind === "commit" || kind === "merge") {
    const sha = q("sha");
    if (!sha || !HEX.test(sha) || sha.length < 4 || sha.length > 64) throw new DiffError("Invalid ?sha= (hex, 4 to 64 characters)");
    return { kind, sessionPath, repoPath: path, sha: sha.toLowerCase() };
  }
  throw new DiffError("Invalid ?kind= (worktree, commit, merge or dirty)");
}

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

/** The folders a session's file names. Lines are pre-filtered by substring; only the header and
    worktree/worker lines are parsed. */
export function knownFoldersOf(text: string): Known {
  const { cwd, workerCwds } = candidatesOf(text);
  const roots: string[] = [];
  const trees: TrackedWorktree[] = [];
  const merges: WorktreeMergeDetails[] = [];
  const add = (p: unknown) => {
    if (typeof p === "string" && isAbsolute(p) && !parseTargetCwd(p)) roots.push(normalize(p).replace(/\/+$/, "") || "/");
  };
  add(cwd);
  workerCwds.forEach(add);
  for (const line of text.split("\n")) {
    if (!line.includes("worktree")) continue;
    const h = lineEntry(line);
    if (h?.kind === "state") {
      const set = stateView([h]).latest(WORKTREES)?.data;
      for (const t of set?.trees ?? []) {
        trees.push(t);
        add(t.path);
      }
    } else if (h?.kind === "note" && !h.inMessage && h.noteType === WORKTREE_MERGE_MESSAGE) {
      const m = normalizeMergeDetails(h.details);
      if (m) merges.push(m);
      add(m?.path);
    }
  }
  return { roots: [...new Set(roots)], trees, merges };
}

export interface DiffDeps {
  run?: RawGitRunner;
  /** The session file's contents by resolved path (default: resolveSessionPath + readFile, cached). */
  sessionKnown?: (sessionPath: string) => Promise<Known | null>;
  now?: () => number;
  /** UNTRACKED_BUDGET, smaller for tests. */
  untrackedBudget?: number;
}

export class GitDiffs {
  private readonly run: RawGitRunner;
  private readonly now: () => number;
  private readonly untrackedBudget: number;
  private readonly sessionKnownFn: (sessionPath: string) => Promise<Known | null>;
  private readonly sessions = new Map<string, { mtimeMs: number; size: number; value: Known }>();
  private readonly emptyTrees = new Map<string, string>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(deps: DiffDeps = {}) {
    this.run = deps.run ?? execGitRaw;
    this.now = deps.now ?? Date.now;
    this.untrackedBudget = deps.untrackedBudget ?? UNTRACKED_BUDGET;
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
    if (!known.roots.some((r) => isWithin(dir, canonical(r)))) throw new DiffError("That folder is not one this session knows");
    let card: WorktreeMergeDetails | undefined;
    if (scope.kind === "merge") {
      const sha = scope.sha.toLowerCase();
      card = known.merges.filter((m) => m.sha.toLowerCase() === sha && canonical(m.path) === dir).at(-1);
      if (!card) throw new DiffError("That commit is not a merge this session recorded");
    }
    if (!(await isDir(dir))) {
      // A merged worktree is often removed after the merge, but its commit lives on in the
      // repository: read it from another folder the session knows that has it.
      if (scope.kind === "commit" || scope.kind === "merge") {
        const top = await this.topHolding(known, scope.sha);
        if (top) return { top, known, card };
      }
      throw new DiffError("That folder does not exist", 404);
    }
    const top = await this.topOf(dir);
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
    const head = await this.headOid(top);
    if (!head) throw new DiffError("No commits on HEAD", 404);
    const symbolic = (await this.git(top, ["symbolic-ref", "-q", "HEAD"])).stdout.toString("utf8").trim();
    const branch = symbolic.startsWith("refs/heads/") ? symbolic.slice("refs/heads/".length) : null;
    const tracked = known.trees.filter((t) => canonical(t.path) === canonical(top)).at(-1);
    const wanted = tracked?.baseBranch && /^[\w./-]+$/.test(tracked.baseBranch) && !tracked.baseBranch.startsWith("-") ? `refs/heads/${tracked.baseBranch}` : null;
    const refsOut = await this.gitText(
      top,
      ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)", ...(wanted ? [wanted] : []), "refs/heads/master", "refs/heads/main", "refs/remotes/origin/HEAD"],
      "reading the base branch",
    );
    let base: { name: string; oid: string } | null = null;
    if (wanted) {
      const line = refsOut.split("\n").find((l) => l.split("\0")[0] === wanted);
      const oid = line?.split("\0")[1];
      if (oid) base = { name: tracked!.baseBranch!, oid };
    }
    base ??= pickBase(refsOut);
    if (!base) throw new DiffError("No base branch (master, main or origin/HEAD) in that repository", 404);
    const mb = await this.git(top, ["merge-base", base.oid, head]);
    const mbOid = mb.stdout.toString("utf8").trim();
    if (mb.code !== 0 || !isOid(mbOid)) throw new DiffError(mb.code === 1 ? "No common history with the base branch" : gitError("merge-base", mb), mb.code === 1 ? 404 : 500);
    // Already merged: what the merge brought in, not the empty HEAD..HEAD.
    const merged = await mergedReviewBase(this.gitLines, top, head, base.oid, mbOid, tracked?.base);
    const baseSide =
      merged && isOid(merged.base)
        ? { label: merged.landing ? `${base.name} before ${merged.landing.slice(0, 7)}` : `${merged.base.slice(0, 7)} (created from)`, oid: merged.base }
        : { label: `${base.name} (merge-base)`, oid: mbOid };
    return {
      scope,
      top,
      base: { ...baseSide, treeish: baseSide.oid },
      head: { label: branch ?? head.slice(0, 7), oid: head, treeish: head },
    };
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
    for (const e of parseRawZ(raw.stdout.toString("utf8"))) {
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
      const budget = { bytes: this.untrackedBudget, files: MAX_DIFF_FILES };
      for (const path of untracked.paths) if (!listed.has(path)) files.push(await this.untrackedSummary(r.top, path, budget));
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
      files: files.slice(0, MAX_DIFF_FILES),
      totals,
      generatedAt: this.now(),
    };
    if (cut || files.length > MAX_DIFF_FILES) out.truncated = true;
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
      blob oid this patch names, so folded unchanged lines can open. */
  async patch(scope: DiffScope, file: string, oldFile?: string, opts: { context?: boolean } = {}): Promise<DiffFilePatch> {
    const path = checkRelPath(file);
    const oldPath = oldFile === undefined || oldFile === "" || oldFile === path ? undefined : checkRelPath(oldFile);
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
      return { path, ...(s.oldPath ? { oldPath: s.oldPath } : {}), status: s.status === "B" ? "M" : s.status, tooLarge: { bytes: res.stdout.length, cap: PATCH_CAP }, ...oids(s), ...sides };
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
