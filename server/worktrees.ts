// The git worktrees a session touches (GET /api/insights/worktrees?paths=…, shared/protocol.ts
// WorktreesInsight): for each requested session, the linked worktree it runs in and the worktrees
// its workers ran in, each compared with its repository's base branch — merged or not, ahead and
// behind, lines added and removed, dirty.
//
// Tree source (a stopgap until sessions record their trees): the session header's cwd when it is a
// LINKED worktree (git-dir differs from git-common-dir), then every distinct worker cwd in the
// session's worker manifests, resolved to its top level, when that is a linked worktree too (a
// main checkout is never a feature tree, whoever ran in it). Deduped by
// top level. A path that no longer exists comes back exists:false; an existing folder that is not
// a git worktree, a remote placeholder or a relative path is not listed.
//
// Read-only, like server/git-summary.ts: `--no-optional-locks` (and GIT_OPTIONAL_LOCKS=0) so
// status never takes index.lock; line counts from plumbing `diff-tree` against the merge-base,
// never porcelain `git diff`; `--no-textconv --no-ext-diff`; `core.fsmonitor=false`. The one git
// that writes objects, `merge-tree --write-tree`, writes them into a throwaway object directory
// (the repository's objects as its alternate), removed afterwards.
//
// Bounds: every git is execFile (no shell) under a 5 s timeout, at most MAX_CONCURRENT at once.
// Cost: per tree and request, a few rev-parse/for-each-ref calls resolve the HEAD and base oids;
// the comparison is recomputed only when either oid changes, dirty at most every DIRTY_TTL_MS.
// Git failures become the tree's `error`, never a throw.

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { LEGACY_REGISTRY_ENTRY_TYPE, readWorkerManifests, WORKER_MANIFEST_ENTRY_TYPE } from "../pi-config/extensions/subagents/worker-transcript.ts";
import type { SessionWorktrees, WorktreeStatus, WorktreesInsight } from "../shared/protocol";
import { resolveSessionPath } from "./paths";
import { parseTargetCwd } from "./targets";

const GIT_TIMEOUT_MS = 5_000;
const MAX_CONCURRENT = 4;
/** How long a dirty reading stands. */
export const DIRTY_TTL_MS = 10_000;
/** A comparison not asked for in this long is dropped. */
const UNSEEN_MS = 60 * 60 * 1000;
/** Most comparisons (and session readings) kept, oldest-seen dropped first. */
const MAX_CACHED = 512;
/** numstat of a very large branch; past this the counts are an error, not a guess. */
const MAX_BUFFER = 16 * 1024 * 1024;

export interface GitResult {
  /** Exit code; null when killed (timeout) or not started. */
  code: number | null;
  stdout: string;
  stderr: string;
}
/** Run git with `args` in `cwd`. Never throws. */
export type GitRunner = (args: readonly string[], opts: { cwd: string; env?: Record<string, string> }) => Promise<GitResult>;

/** Every git starts with these: no optional locks, no fsmonitor daemon. */
const GIT_PREFIX = ["-c", "core.fsmonitor=false", "--no-optional-locks"];

function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  // A server started from inside a git hook would otherwise read that repository instead.
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR"]) delete env[k];
  return { ...env, ...extra };
}

export const execGit: GitRunner = (args, opts) =>
  new Promise((done) => {
    execFile(
      "git",
      [...GIT_PREFIX, ...args],
      { cwd: opts.cwd, env: gitEnv(opts.env), timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: MAX_BUFFER, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (!err) return done({ code: 0, stdout, stderr });
        const e = err as NodeJS.ErrnoException & { code?: unknown; killed?: boolean };
        const code = typeof e.code === "number" && !e.killed ? e.code : null;
        const why = e.killed ? "git timed out" : typeof e.code === "string" ? `${e.code}: ${e.message}` : "";
        done({ code, stdout: stdout ?? "", stderr: stderr || why });
      },
    );
  });

/** The first line of git's complaint, for `error`. */
/** How many paths `git status --porcelain` lists, and the first three (a rename's new name). */
export function porcelainFiles(stdout: string): { count: number; first: string[] } {
  const paths = stdout
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const p = l.slice(3);
      const arrow = p.indexOf(" -> ");
      const name = arrow >= 0 ? p.slice(arrow + 4) : p;
      return name.startsWith('"') && name.endsWith('"') ? name.slice(1, -1) : name;
    });
  return { count: paths.length, first: paths.slice(0, 3) };
}

/** Distinct files in `merge-tree --write-tree`'s conflicted-file lines (after the tree's oid). */
export function conflictedFiles(stdout: string): number {
  const files = new Set<string>();
  for (const line of stdout.split("\n").slice(1)) {
    if (line.trim() === "") break;
    const tab = line.indexOf("\t");
    files.add(tab >= 0 ? line.slice(tab + 1) : line);
  }
  return files.size;
}

function gitError(what: string, r: GitResult): string {
  const line = r.stderr.split("\n").map((s) => s.trim()).find(Boolean);
  return `${what}: ${line ?? (r.code === null ? "git did not finish" : `exit ${r.code}`)}`;
}

/** Candidate folders one session names, from its file (cached by mtime and size). */
interface SessionCandidates { cwd: string | null; workerCwds: string[] }

interface Comparison {
  base: string;
  merged: "ancestor" | "content" | "no";
  /** merged "no": files the trial merge conflicts on. */
  conflicts?: number;
  ahead?: number;
  behind?: number;
  added?: number;
  removed?: number;
  error?: string;
}

interface Layout { top: string; linked: boolean; commonDir: string }

export interface WorktreeDeps {
  run?: GitRunner;
  now?: () => number;
}

export class WorktreeInsights {
  /** Full comparisons computed (cache misses); tests read it. */
  computeCount = 0;
  private readonly run: GitRunner;
  private readonly now: () => number;
  private readonly compared = new Map<string, { key: string; value: Comparison; seenAt: number }>();
  private readonly dirty = new Map<string, { at: number; dirty: boolean | null; files?: { count: number; first: string[] }; error?: string }>();
  private readonly sessions = new Map<string, { mtimeMs: number; size: number; value: SessionCandidates; seenAt: number }>();
  private mergeTreeOk: Promise<boolean> | null = null;
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(deps: WorktreeDeps = {}) {
    this.run = deps.run ?? execGit;
    this.now = deps.now ?? Date.now;
  }

  /** git, at most MAX_CONCURRENT at once. */
  private async git(cwd: string, args: readonly string[], env?: Record<string, string>): Promise<GitResult> {
    if (this.running >= MAX_CONCURRENT) await new Promise<void>((go) => this.waiting.push(go));
    this.running++;
    try {
      return await this.run(args, { cwd, env });
    } catch (err) {
      return { code: null, stdout: "", stderr: (err as Error).message || "git failed" };
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  /** `merge-tree --write-tree` arrived in git 2.38; older gits skip content detection. */
  private supportsMergeTree(): Promise<boolean> {
    this.mergeTreeOk ??= this.git(tmpdir(), ["version"]).then((r) => {
      const m = /(\d+)\.(\d+)/.exec(r.stdout);
      return !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 38));
    });
    return this.mergeTreeOk;
  }

  async get(sessionPaths: readonly string[]): Promise<WorktreesInsight> {
    const unique = [...new Set(sessionPaths)];
    const sessions = await Promise.all(unique.map((p) => this.forSession(p)));
    this.prune();
    return { sessions, generatedAt: this.now() };
  }

  /**
   * One linked worktree's reading by folder, for merge readiness (server/merge-readiness.ts): the
   * same comparison and caches as `get`, plus its HEAD and, while it is unmerged and ahead, the
   * subjects of its commits past the base (newest first, at most 50). null when the folder is gone
   * or is not a linked worktree.
   */
  async treeStatus(dir: string): Promise<(WorktreeStatus & { head?: string; headAt?: number; subjects?: string[] }) | null> {
    const layout = await this.layout(dir);
    if (!layout || layout === "gone" || !layout.linked) return null;
    const st = await this.status({ path: layout.top, source: "session", exists: true }, layout);
    this.prune();
    // HEAD and its committer time (ms) in one call: the time says whether a check ran after the newest commit.
    const head = await this.git(layout.top, ["log", "-1", "--format=%H %ct", "HEAD"]);
    const [sha, ct] = head.code === 0 ? head.stdout.trim().split(" ") : [];
    const at = Number(ct) * 1000;
    const out: WorktreeStatus & { head?: string; headAt?: number; subjects?: string[] } = { ...st, ...(sha ? { head: sha } : {}), ...(sha && at > 0 ? { headAt: at } : {}) };
    if (st.base && st.merged === "no" && (st.ahead ?? 0) > 0) {
      const log = await this.git(layout.top, ["log", "--format=%s", "-n", "50", `${st.base}..HEAD`]);
      if (log.code === 0) out.subjects = log.stdout.split("\n").filter(Boolean);
    }
    return out;
  }

  private async forSession(raw: string): Promise<SessionWorktrees> {
    const path = resolveSessionPath(raw);
    if (!path) return { sessionPath: raw, trees: [] };
    const found = await this.candidates(path);
    if (!found) return { sessionPath: raw, trees: [] };
    return { sessionPath: raw, trees: await this.treesOf(found) };
  }

  /** The session's header cwd and its workers' cwds, re-read only when the file changed. */
  private async candidates(path: string): Promise<SessionCandidates | null> {
    let st;
    try {
      st = await stat(path);
    } catch {
      return null;
    }
    const hit = this.sessions.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      hit.seenAt = this.now();
      return hit.value;
    }
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return null;
    }
    const value = candidatesOf(text);
    this.sessions.delete(path);
    this.sessions.set(path, { mtimeMs: st.mtimeMs, size: st.size, value, seenAt: this.now() });
    return value;
  }

  private async treesOf(found: SessionCandidates): Promise<WorktreeStatus[]> {
    const wanted: { dir: string; source: "session" | "worker" }[] = [];
    const seenDirs = new Set<string>();
    for (const [dir, source] of [[found.cwd, "session"] as const, ...found.workerCwds.map((d) => [d, "worker"] as const)]) {
      if (!dir || !isAbsolute(dir) || parseTargetCwd(dir)) continue;
      const n = normalize(dir).replace(/\/+$/, "") || "/";
      if (seenDirs.has(`${source}\n${n}`)) continue;
      seenDirs.add(`${source}\n${n}`);
      wanted.push({ dir: n, source });
    }
    // Resolve every folder to its worktree first (in parallel), then keep order and dedupe.
    const resolved = await Promise.all(wanted.map(async (w) => ({ ...w, layout: await this.layout(w.dir) })));
    const out: { status: WorktreeStatus; layout?: Layout }[] = [];
    const listed = new Set<string>();
    const gone: string[] = [];
    for (const r of resolved) {
      if (r.layout === "gone") {
        // A deleted folder can't be resolved to a top level: list it once, and not its subfolders.
        if (listed.has(r.dir) || gone.some((g) => r.dir.startsWith(g + sep))) continue;
        listed.add(r.dir);
        gone.push(r.dir);
        out.push({ status: { path: r.dir, source: r.source, exists: false } });
        continue;
      }
      if (!r.layout) continue; // exists, not a git worktree
      if (!r.layout.linked) continue; // the main checkout isn't a feature tree, whoever ran in it
      if (listed.has(r.layout.top)) continue;
      listed.add(r.layout.top);
      out.push({ status: { path: r.layout.top, source: r.source, exists: true }, layout: r.layout });
    }
    return Promise.all(out.map(async (t) => (t.layout ? this.status(t.status, t.layout) : t.status)));
  }

  /** The worktree a folder is in, "gone" when the folder doesn't exist, null when it isn't in one. */
  private async layout(dir: string): Promise<Layout | "gone" | null> {
    try {
      if (!statSync(dir).isDirectory()) return null;
    } catch {
      return existsSync(dir) ? null : "gone";
    }
    const r = await this.git(dir, ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"]);
    if (r.code !== 0) return null;
    const [top, gitDir, commonDir] = r.stdout.split("\n");
    if (!top || !gitDir || !commonDir) return null; // a bare repository or a .git dir: no work tree
    const absGit = resolve(dir, gitDir);
    const absCommon = resolve(dir, commonDir);
    return { top, linked: absGit !== absCommon, commonDir: absCommon };
  }

  private async status(tree: WorktreeStatus, layout: Layout): Promise<WorktreeStatus> {
    const cwd = layout.top;
    const [head, refs, dirty] = await Promise.all([
      this.git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]).then(async (oid) =>
        oid.code === 0 ? { oid: oid.stdout.trim(), ref: (await this.git(cwd, ["symbolic-ref", "-q", "HEAD"])).stdout.trim() } : null,
      ),
      this.git(cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)", "refs/heads/master", "refs/heads/main", "refs/remotes/origin/HEAD"]),
      this.dirtyOf(cwd),
    ]);
    const out: WorktreeStatus = { ...tree };
    const errors: string[] = [];
    if (dirty.dirty !== null) out.dirty = dirty.dirty;
    if (dirty.dirty && dirty.files) Object.assign(out, { dirtyCount: dirty.files.count, dirtyFiles: dirty.files.first });
    if (dirty.error) errors.push(dirty.error);
    if (head?.ref.startsWith("refs/heads/")) out.branch = head.ref.slice("refs/heads/".length);
    const base = refs.code === 0 ? pickBase(refs.stdout) : null;
    if (refs.code !== 0) errors.push(gitError("reading the base branch", refs));
    if (!head) errors.push("no commits on HEAD");
    else if (base) {
      const key = `${head.oid}\n${base.name}\n${base.oid}`;
      const hit = this.compared.get(cwd);
      let value: Comparison;
      if (hit && hit.key === key) {
        hit.seenAt = this.now();
        value = hit.value;
      } else {
        value = await this.compare(cwd, layout, base, head.oid);
        this.compared.delete(cwd);
        // A failed comparison is not cached: the next request tries again.
        if (!value.error) this.compared.set(cwd, { key, value, seenAt: this.now() });
      }
      const { error, ...fields } = value;
      Object.assign(out, fields);
      if (error) errors.push(error);
    }
    if (errors.length > 0) out.error = errors.join("; ");
    return out;
  }

  private async dirtyOf(cwd: string): Promise<{ dirty: boolean | null; files?: { count: number; first: string[] }; error?: string }> {
    const hit = this.dirty.get(cwd);
    if (hit && this.now() - hit.at < DIRTY_TTL_MS) return hit;
    const r = await this.git(cwd, ["status", "--porcelain"]);
    const value = r.code === 0 ? { at: this.now(), dirty: r.stdout.trim() !== "", files: porcelainFiles(r.stdout) } : { at: this.now(), dirty: null, error: gitError("git status", r) };
    this.dirty.delete(cwd);
    if (value.dirty !== null) this.dirty.set(cwd, value);
    return value;
  }

  private async compare(cwd: string, layout: Layout, base: { name: string; oid: string }, head: string): Promise<Comparison> {
    this.computeCount++;
    const out: Comparison = { base: base.name, merged: "no" };
    const errors: string[] = [];
    const anc = await this.git(cwd, ["merge-base", "--is-ancestor", head, base.oid]);
    if (anc.code === 0) out.merged = "ancestor";
    else if (anc.code !== 1) errors.push(gitError("merge-base --is-ancestor", anc));
    else if (await this.supportsMergeTree()) {
      const content = await this.mergesToBase(cwd, layout, base.oid, head);
      if (content === true) out.merged = "content";
      else if (typeof content === "string") errors.push(content);
      else if (typeof content === "object") out.conflicts = content.conflicts;
    }
    const [counts, mb] = await Promise.all([
      this.git(cwd, ["rev-list", "--left-right", "--count", `${base.oid}...${head}`]),
      this.git(cwd, ["merge-base", base.oid, head]),
    ]);
    if (counts.code === 0) {
      const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number);
      if (Number.isFinite(behind) && Number.isFinite(ahead)) Object.assign(out, { ahead, behind });
    } else errors.push(gitError("rev-list --count", counts));
    if (mb.code === 0) {
      const d = await this.git(cwd, ["diff-tree", "-r", "-M", "--numstat", "--no-textconv", "--no-ext-diff", mb.stdout.trim(), head]);
      if (d.code === 0) Object.assign(out, sumNumstat(d.stdout));
      else errors.push(gitError("diff-tree --numstat", d));
    } else errors.push(mb.code === 1 ? "no common history with the base" : gitError("merge-base", mb));
    if (errors.length > 0) out.error = errors.join("; ");
    return out;
  }

  /** Whether merging HEAD into the base would leave the base's tree unchanged (a squash or rebase
      merge already landed it). true / false, `{conflicts}` when the merge conflicts (how many
      files), or why it couldn't tell. The merge's new objects go to a temporary object directory,
      so the repository is not written. */
  private async mergesToBase(cwd: string, layout: Layout, base: string, head: string): Promise<boolean | { conflicts: number } | string> {
    let scratch: string | null = null;
    try {
      scratch = await mkdtemp(join(tmpdir(), "sova-merge-tree-"));
      const env = { GIT_OBJECT_DIRECTORY: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(layout.commonDir, "objects") };
      const [merged, baseTree] = await Promise.all([
        this.git(cwd, ["merge-tree", "--write-tree", "--no-messages", base, head], env),
        this.git(cwd, ["rev-parse", `${base}^{tree}`]),
      ]);
      if (merged.code === 1) return { conflicts: conflictedFiles(merged.stdout) }; // conflicts: not in the base
      if (merged.code !== 0) return gitError("merge-tree", merged);
      if (baseTree.code !== 0) return gitError("rev-parse base^{tree}", baseTree);
      return (merged.stdout.split("\n", 1)[0] ?? "").trim() === baseTree.stdout.trim();
    } catch (err) {
      return `merge-tree: ${(err as Error).message}`;
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Drop what hasn't been asked for in an hour, then the oldest past MAX_CACHED. */
  private prune(): void {
    const cutoff = this.now() - UNSEEN_MS;
    for (const m of [this.compared, this.sessions] as Map<string, { seenAt: number }>[]) {
      for (const [k, v] of m) if (v.seenAt < cutoff) m.delete(k);
      while (m.size > MAX_CACHED) {
        const oldest = m.keys().next().value;
        if (oldest === undefined) break;
        m.delete(oldest);
      }
    }
    for (const [k, v] of this.dirty) if (this.now() - v.at >= DIRTY_TTL_MS) this.dirty.delete(k);
  }
}

/** master, else main, else origin/HEAD's target, from for-each-ref's `refname\0oid\0symref` lines. */
export function pickBase(stdout: string): { name: string; oid: string } | null {
  const refs = new Map<string, { oid: string; symref: string }>();
  for (const line of stdout.split("\n")) {
    const [ref, oid, symref] = line.split("\0");
    if (ref && oid) refs.set(ref, { oid, symref: symref ?? "" });
  }
  for (const name of ["master", "main"]) {
    const r = refs.get(`refs/heads/${name}`);
    if (r) return { name, oid: r.oid };
  }
  const origin = refs.get("refs/remotes/origin/HEAD");
  if (origin?.symref.startsWith("refs/remotes/")) return { name: origin.symref.slice("refs/remotes/".length), oid: origin.oid };
  return null;
}

/** Sum numstat's first two columns; a binary file ("-") counts 0. */
export function sumNumstat(stdout: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of stdout.split("\n")) {
    const [a, r] = line.split("\t");
    if (a === undefined || r === undefined) continue;
    if (/^\d+$/.test(a)) added += Number(a);
    if (/^\d+$/.test(r)) removed += Number(r);
  }
  return { added, removed };
}

/** The header's cwd and the worker cwds, in manifest order. Only the header and worker-record
    lines are parsed: a long session is mostly messages this never needs. */
export function candidatesOf(text: string): SessionCandidates {
  let cwd: string | null = null;
  const records: unknown[] = [];
  let first = true;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const isHeader = first;
    first = false;
    if (!isHeader && !line.includes(WORKER_MANIFEST_ENTRY_TYPE) && !line.includes(LEGACY_REGISTRY_ENTRY_TYPE)) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    const e = v as { type?: unknown; cwd?: unknown } | null;
    if (isHeader && e?.type === "session") {
      if (typeof e.cwd === "string" && e.cwd !== "") cwd = e.cwd;
      continue;
    }
    records.push(v);
  }
  const workerCwds: string[] = [];
  try {
    for (const m of readWorkerManifests(records).manifests.values()) {
      const c = m.spec?.cwd;
      if (c && !workerCwds.includes(c)) workerCwds.push(c);
    }
  } catch {
    // an unreadable record set: the session's own cwd still stands
  }
  return { cwd, workerCwds };
}

/** The server's one instance. */
export const worktreeInsights = new WorktreeInsights();
