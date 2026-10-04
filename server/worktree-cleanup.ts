// Removing merged worktrees (§chat.worktrees/cleanup): one service that classifies every linked
// worktree in git's own list for a session's repository — merged (§chat.worktrees/merged-state
// against master, else main: ancestry, or content by a trial merge, after a commit of its own),
// empty (no commit of its own) or unmerged — and removes the merged and empty ones nothing still
// uses. Only when asked: the count and the dry run read, and a removal acts on the confirmed paths
// alone, each checked again right before it goes.
//
// Removal is git's own `git worktree remove -- <path>` from the main checkout, never --force, and
// `git branch -d` only for a branch in the main branch by ancestry. Each removal is appended to the
// ledger (server/removed-worktrees.ts) that readiness reads for a removed tree. Git by argv, never
// a shell; reads under --no-optional-locks (server/worktrees.ts execGit).
import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { SessionSummary, WorktreeCleanupKept, WorktreeCleanupPlan, WorktreeCleanupRemoved, WorktreeCleanupResult, WorktreesSummary } from "../shared/protocol";
import { runGit } from "../pi-config/extensions/worktrees/git.ts";
import { canonical, isWithin, WORKTREES_ENTRY_TYPE } from "../pi-config/extensions/worktrees/state.ts";
import { readStoredCwd } from "./git-summary";
import { worktreesRemoved } from "./merge-readiness";
import { appendLedger, mergedByContent, resetContentMerges, type RemovedWorktree } from "./removed-worktrees";
import { sandboxInfo } from "./sandbox-state";
import { parseTargetCwd } from "./targets";
import { worktreesOf } from "./worktrees-state";
import { execGit, type GitResult, type GitRunner } from "./worktrees";

/** How long a count stands while git's list of worktrees doesn't change. */
export const SUMMARY_TTL_MS = 30_000;
/** Removals running at once: each deletes a folder, often with a node_modules. */
const REMOVE_CONCURRENCY = 3;
const ZERO = /^0+$/;

export type TreeClass = "merged" | "empty" | "unmerged";

/** One linked worktree as git lists it, classified. */
export interface ClassifiedTree {
  path: string;
  branch?: string;
  head?: string;
  locked: boolean;
  /** Its folder is gone (git says prunable). */
  gone: boolean;
  class: TreeClass;
  merged?: "ancestor" | "content";
  /** The branch is an ancestor of the main branch: `git branch -d` may delete it. */
  ancestor: boolean;
  /** Why an unmerged tree stays. */
  why?: string;
}

/** A repository and its linked worktrees, classified. */
export interface RepoTrees {
  commonDir: string;
  /** The main checkout's folder: where removals run. */
  main: string;
  /** master, else main; absent when the repository has neither. */
  mainBranch?: string;
  trees: ClassifiedTree[];
}

/** What a session's tracking and state say about one tree. */
interface Tracker {
  name: string;
  live: boolean;
  running: boolean;
  sandbox: boolean;
}

/** Everything a refusal reads besides git, taken once per plan. */
export interface UseFacts {
  /** Every session's folder (header cwd, canonical), with a name to say. */
  sessionCwds: { cwd: string; name: string }[];
  /** Tree path → the sessions tracking it active. */
  trackers: Map<string, Tracker[]>;
}

/** A live process and the paths it holds (its cwd and open files). */
export interface ProcFacts {
  pid: number;
  command: string;
  paths: string[];
}

export interface CleanupDeps {
  /** Reads (no optional locks, short timeout). */
  git: GitRunner;
  /** `git worktree remove` and `git branch -d` (longer timeout). */
  gitWrite: GitRunner;
  /** One session's row (server/sessions-index.ts getSessionSummary), asked only for a session a
      refusal could name: its folder is inside a candidate, or it tracks one. */
  summary: (path: string) => Promise<SessionSummary | null>;
  /** Every session file, listed or not (a new session with no message yet isn't listed). */
  sessionFiles: () => Promise<string[]>;
  /** A session file's active branch entries (read only for a changed file that holds a `worktrees` entry). */
  readBranch: (path: string) => Promise<readonly unknown[]>;
  /** A session file's bytes, read only when it changed since the last check (useFacts' cache). */
  readFile: (path: string) => Promise<Buffer>;
  /** The live processes and what they hold; read once per check. */
  processes: () => Promise<ProcFacts[]>;
  /** Whether a pid is a live process. */
  alive: (pid: number) => boolean;
  ledger: (entries: RemovedWorktree[]) => void;
  /** Ends the cached readiness of every session tracking a removed tree (server/merge-readiness.ts). */
  removed: (paths: readonly string[]) => Promise<void>;
  now: () => number;
}

const writeGit: GitRunner = async (args, opts) => runGit([...args], opts.cwd);

/** /proc/<pid>/cwd and /proc/<pid>/fd/* of every process this user can read. */
export async function scanProcesses(): Promise<ProcFacts[]> {
  let pids: string[];
  try {
    pids = (await readdir("/proc")).filter((d) => /^\d+$/.test(d));
  } catch {
    return [];
  }
  const out: ProcFacts[] = [];
  await Promise.all(
    pids.map(async (p) => {
      const pid = Number(p);
      if (pid === process.pid) return;
      const paths: string[] = [];
      const cwd = await readlink(`/proc/${p}/cwd`).catch(() => null);
      if (cwd) paths.push(cwd);
      const fds = await readdir(`/proc/${p}/fd`).catch(() => [] as string[]);
      for (const fd of fds) {
        const target = await readlink(`/proc/${p}/fd/${fd}`).catch(() => null);
        if (target?.startsWith("/")) paths.push(target.replace(/ \(deleted\)$/, ""));
      }
      if (!paths.length) return;
      const command = (await readFile(`/proc/${p}/comm`, "utf8").catch(() => "")).trim() || "process";
      out.push({ pid, command, paths });
    }),
  );
  return out;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

let deps: CleanupDeps | null = null;
/** index.ts wires the session list and the branch reader; tests swap anything. */
export function configureCleanup(d: Partial<CleanupDeps> & Pick<CleanupDeps, "summary" | "sessionFiles" | "readBranch">): void {
  deps = { git: execGit, gitWrite: writeGit, processes: scanProcesses, alive: pidAlive, ledger: (e) => appendLedger(e), removed: worktreesRemoved, now: Date.now, readFile: (p) => readFile(p), ...d };
}
const need = (): CleanupDeps => {
  if (!deps) throw new Error("worktree cleanup is not configured");
  return deps;
};

const firstLine = (r: GitResult): string => (r.stderr || r.stdout).trim().split("\n")[0]?.trim() || `exit ${r.code}`;

/** `git worktree list --porcelain` blocks. */
export function parseWorktreeList(stdout: string): { path: string; head?: string; branch?: string; bare: boolean; locked: boolean; prunable: boolean }[] {
  const out: ReturnType<typeof parseWorktreeList> = [];
  for (const block of stdout.split(/\n\n+/)) {
    const w = { path: "", bare: false, locked: false, prunable: false } as ReturnType<typeof parseWorktreeList>[number];
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) w.path = line.slice(9);
      else if (line.startsWith("HEAD ")) w.head = line.slice(5);
      else if (line.startsWith("branch refs/heads/")) w.branch = line.slice(18);
      else if (line === "bare") w.bare = true;
      else if (line === "locked" || line.startsWith("locked ")) w.locked = true;
      else if (line === "prunable" || line.startsWith("prunable ")) w.prunable = true;
    }
    if (w.path) out.push(w);
  }
  return out;
}

/** The commit git's reflog says the branch was created at; undefined when the log doesn't reach back to it. */
export function createdAt(commonDir: string, branch: string): string | undefined {
  try {
    const first = readFileSync(join(commonDir, "logs", "refs", "heads", branch), "utf8").split("\n", 1)[0] ?? "";
    const [old, created] = first.split(" ");
    return old && created && ZERO.test(old) && /^[0-9a-f]{40,64}$/.test(created) ? created : undefined;
  } catch {
    return undefined;
  }
}

/** The repository `dir` is in, and its linked worktrees classified; null when it isn't in one with a main checkout. */
export async function classifyRepo(dir: string, git: GitRunner = need().git): Promise<RepoTrees | null> {
  if (!dir || !existsSync(dir)) return null;
  const cd = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir });
  if (cd.code !== 0 || !cd.stdout.trim()) return null;
  const commonDir = canonical(cd.stdout.trim());
  const list = await git(["worktree", "list", "--porcelain"], { cwd: dir });
  if (list.code !== 0) return null;
  const [first, ...linked] = parseWorktreeList(list.stdout);
  if (!first || first.bare) return null;
  const main = first.path;
  let mainBranch: string | undefined;
  let mainSha = "";
  for (const b of ["master", "main"]) {
    const r = await git(["rev-parse", "--verify", "-q", `refs/heads/${b}^{commit}`], { cwd: main });
    if (r.code === 0) {
      mainBranch = b;
      mainSha = r.stdout.trim();
      break;
    }
  }
  const ancestors = new Set<string>();
  if (mainSha) {
    const r = await git(["for-each-ref", `--merged=${mainSha}`, "--format=%(refname)", "refs/heads"], { cwd: main });
    if (r.code === 0) for (const ref of r.stdout.split("\n")) if (ref.startsWith("refs/heads/")) ancestors.add(ref.slice(11));
  }
  const trees: ClassifiedTree[] = [];
  for (const w of linked) {
    const base: ClassifiedTree = { path: w.path, ...(w.branch ? { branch: w.branch } : {}), ...(w.head ? { head: w.head } : {}), locked: w.locked, gone: w.prunable || !existsSync(w.path), class: "unmerged", ancestor: false };
    if (!w.branch || !w.head) {
      trees.push({ ...base, why: "Not on a branch." });
      continue;
    }
    if (!mainBranch) {
      trees.push({ ...base, why: "No master or main branch to merge into." });
      continue;
    }
    const ancestor = ancestors.has(w.branch);
    const created = createdAt(commonDir, w.branch);
    if (created === w.head) trees.push({ ...base, class: "empty", ancestor });
    else if (ancestor) trees.push({ ...base, class: "merged", merged: "ancestor", ancestor });
    else if (await mergedByContent(git, main, commonDir, mainSha, w.head)) trees.push({ ...base, class: "merged", merged: "content", ancestor });
    else trees.push({ ...base, why: `Not merged into ${mainBranch}.` });
  }
  return { commonDir, main, ...(mainBranch ? { mainBranch } : {}), trees };
}

// --- the count ---------------------------------------------------------------------------------

const summaries = new Map<string, { at: number; token: string; value: WorktreesSummary }>();
const listToken = (commonDir: string): string => {
  try {
    const st = statSync(join(commonDir, "worktrees"));
    return `${st.mtimeMs}:${st.ino}`;
  } catch {
    return "none";
  }
};

/** A session's folder (its header's cwd, as the setup card reads it), when it is a local one that
    exists; null for a remote placeholder, a gone folder or no header. */
async function folderOf(sessionPath: string): Promise<string | null> {
  const cwd = await readStoredCwd(sessionPath).catch(() => null);
  if (!cwd || !isAbsolute(cwd) || parseTargetCwd(cwd) || !existsSync(cwd)) return null;
  return cwd;
}

const countOf = (r: RepoTrees): WorktreesSummary => ({
  state: "ok",
  repo: r.main,
  ...(r.mainBranch ? { mainBranch: r.mainBranch } : {}),
  total: r.trees.length,
  merged: r.trees.filter((t) => t.class === "merged").length,
  empty: r.trees.filter((t) => t.class === "empty").length,
  unmerged: r.trees.filter((t) => t.class === "unmerged").length,
});

/** GET /api/worktrees/summary: the repository's counts, cached per repository. */
export async function worktreesSummary(sessionPath: string): Promise<WorktreesSummary> {
  const cwd = await folderOf(sessionPath);
  if (!cwd) return { state: "none" };
  const d = need();
  const cd = await d.git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
  if (cd.code !== 0) return { state: "none" };
  const commonDir = canonical(cd.stdout.trim());
  const token = listToken(commonDir);
  const hit = summaries.get(commonDir);
  if (hit && hit.token === token && d.now() - hit.at < SUMMARY_TTL_MS) return hit.value;
  const repo = await classifyRepo(cwd, d.git);
  if (!repo) return { state: "none" };
  const value = countOf(repo);
  summaries.set(commonDir, { at: d.now(), token, value });
  return value;
}

// --- refusals ----------------------------------------------------------------------------------

const MARKER = `"customType":"${WORKTREES_ENTRY_TYPE}"`;
/** A session as a refusal names it: its title, else (none, or a new session's "Untitled") its short id. */
const nameOf = (s: SessionSummary | null, path: string): string => {
  const title = s?.title?.trim();
  if (title && title !== "Untitled") return `“${title.slice(0, 60)}”`;
  return s?.id?.slice(0, 8) || (/([0-9a-f]{8})[0-9a-f-]*\.jsonl$/.exec(path)?.[1] ?? "unnamed");
};
const runningNow = (s: SessionSummary): boolean => s.busy || s.activity?.state === "working" || (s.workers?.working ?? s.live?.workers?.working ?? 0) > 0;

/** What one session file says, as of one version of it: its header's folder, and, when it holds a
    `worktrees` entry, the active trees of its active branch (canonical) and whether its sandbox is on. */
interface FileScan {
  version: string;
  cwd: string | null;
  tracks?: { active: Set<string>; sandbox: boolean };
}
const scans = new Map<string, FileScan>();
const MARKER_BYTES = Buffer.from(MARKER);
/** Changed files read at once: a cold scan of hundreds of MB never sits in memory whole. */
const READ_CONCURRENCY = 4;

/** The header's folder, read as git-summary's `readStoredCwd` reads it (the first line of the first 64 KB). */
function headerCwd(buf: Buffer): string | null {
  try {
    const first = buf.subarray(0, 64 * 1024).toString("utf8").split("\n", 1)[0] ?? "";
    const header = JSON.parse(first) as { type?: unknown; cwd?: unknown };
    return header?.type === "session" && typeof header.cwd === "string" && header.cwd !== "" ? header.cwd : null;
  } catch {
    return null;
  }
}

/** One file's scan: from the cache while its (inode, size, mtime) hold; else read once, as bytes. Null: unreadable. */
async function scanFile(path: string, d: CleanupDeps): Promise<FileScan | null> {
  let st;
  try {
    st = await stat(path);
  } catch {
    scans.delete(path);
    return null;
  }
  const version = `${st.ino}:${st.size}:${st.mtimeMs}`;
  const hit = scans.get(path);
  if (hit?.version === version) return hit;
  let buf: Buffer;
  try {
    buf = await d.readFile(path);
  } catch {
    scans.delete(path);
    return null;
  }
  const scan: FileScan = { version, cwd: headerCwd(buf) };
  // Only a file that ever wrote a `worktrees` entry is parsed: the marker is searched in the raw bytes.
  if (buf.includes(MARKER_BYTES)) {
    const branch = await d.readBranch(path).catch(() => [] as unknown[]);
    const set = worktreesOf(branch);
    if (set) {
      scan.tracks = {
        active: new Set(set.trees.filter((t) => t.status === "active").map((t) => canonical(t.path))),
        sandbox: sandboxInfo(branch as Parameters<typeof sandboxInfo>[0]).on,
      };
    }
  }
  scans.set(path, scan);
  if (scans.size > 5000) scans.delete(scans.keys().next().value!);
  return scan;
}

/** `fn` over `items`, at most `limit` at once, results in order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!);
    }),
  );
  return out;
}

/** Every session's folder that lies inside one of `paths`, and who tracks each of `paths` active.
    Each session file is read only when it changed since the last call (per file by inode, size and
    mtime) and parsed only when it holds a `worktrees` entry; only the few sessions a refusal could
    name are looked up (their title, TUI, running state): a warm call costs a `stat` per file. */
export async function useFacts(paths: readonly string[], exclude?: string): Promise<UseFacts> {
  const d = need();
  const all = [...new Set(await d.sessionFiles().catch(() => [] as string[]))].filter((p) => p !== exclude);
  const scanned = await mapLimit(all, READ_CONCURRENCY, (path) => scanFile(path, d));
  const wanted = paths.map((p) => ({ path: p, canon: canonical(p) }));
  const sessionCwds: UseFacts["sessionCwds"] = [];
  const trackers = new Map<string, Tracker[]>();
  if (!wanted.length) return { sessionCwds, trackers };
  // Only sessions a refusal could name: a folder inside a candidate (the header's, as the row's), or tracking one.
  const relevant = all
    .map((path, i) => {
      const scan = scanned[i];
      const cwd = scan?.cwd && isAbsolute(scan.cwd) && !parseTargetCwd(scan.cwd) ? canonical(scan.cwd) : null;
      const inside = !!cwd && wanted.some((w) => isWithin(cwd, w.canon));
      const tracks = scan?.tracks ? wanted.filter((w) => scan.tracks!.active.has(w.canon)) : [];
      return { path, scan, cwd, inside, tracks };
    })
    .filter((r) => r.inside || r.tracks.length);
  const rows = await mapLimit(relevant, READ_CONCURRENCY, async (r) => ({ ...r, s: await d.summary(r.path).catch(() => null) }));
  for (const r of rows) {
    const name = nameOf(r.s, r.path);
    if (r.inside && r.cwd) sessionCwds.push({ cwd: r.cwd, name });
    for (const w of r.tracks) {
      const list = trackers.get(w.path) ?? [];
      list.push({ name, live: !!r.s?.live, running: !!r.s && runningNow(r.s), sandbox: r.scan!.tracks!.sandbox });
      trackers.set(w.path, list);
    }
  }
  return { sessionCwds, trackers };
}

/** Uncommitted and untracked files (ignored ones don't count, as with git's own remove). */
async function dirtyFiles(git: GitRunner, dir: string): Promise<string[] | string> {
  const r = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: dir });
  if (r.code !== 0) return `Git couldn't read it: ${firstLine(r)}`;
  const out: string[] = [];
  const parts = r.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e || e.length < 4) continue;
    out.push(e.slice(3));
    if (e[0] === "R" || e[0] === "C") i++;
  }
  return out;
}

const filesWords = (files: string[]): string => {
  const n = files.length;
  const first = files[0]!;
  return n === 1 ? `1 uncommitted file: ${first}` : `${n} uncommitted files: ${first} and ${n - 1} more`;
};

/** A live record under the tree's own `.agent/sessions/live` naming a process still alive. */
function liveRecordPid(tree: string, alive: (pid: number) => boolean): number | null {
  const dir = join(tree, ".agent", "sessions", "live");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(dir, n), "utf8")) as { session?: { pid?: unknown }; pid?: unknown };
      const pid = typeof rec.session?.pid === "number" ? rec.session.pid : typeof rec.pid === "number" ? rec.pid : Number(/^p(\d+)-/.exec(n)?.[1]);
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) return pid;
    } catch {
      // a half-written record: not a live one
    }
  }
  return null;
}

/** Why a merged or empty tree must stay, or null when it may go. */
export async function refusal(t: ClassifiedTree, use: UseFacts, procs: readonly ProcFacts[]): Promise<string | null> {
  const d = need();
  if (t.class === "unmerged") return t.why ?? "Not merged.";
  if (t.locked) return "Locked.";
  const root = canonical(t.path);
  for (const s of use.sessionCwds) if (isWithin(s.cwd, root)) return `Session ${s.name}'s folder is inside it.`;
  for (const tr of use.trackers.get(t.path) ?? []) {
    if (tr.live) return `Session ${tr.name} tracks it and is open in a TUI.`;
    if (tr.running) return `Session ${tr.name} tracks it and is running.`;
    if (tr.sandbox) return `Session ${tr.name} tracks it and has its sandbox on.`;
  }
  if (t.gone) return null;
  const files = await dirtyFiles(d.git, t.path);
  if (typeof files === "string") return files;
  if (files.length) return `${filesWords(files)}.`;
  for (const p of procs) if (p.paths.some((x) => isWithin(x, root))) return `A running process is inside it: ${p.command} (${p.pid}).`;
  const pid = liveRecordPid(t.path, d.alive);
  if (pid) return `A live session under its .agent: ${pid}.`;
  return null;
}

// --- dry run and removal -----------------------------------------------------------------------

const removedRow = (t: ClassifiedTree): WorktreeCleanupRemoved => ({ path: t.path, ...(t.branch ? { branch: t.branch } : {}), kind: t.class === "empty" ? "empty" : t.merged ?? "ancestor", branchDeleted: t.ancestor });

const inFlight = new Set<string>();

/** POST /api/worktrees/cleanup {dryRun: true}: what would go and what stays, with reasons. */
export async function cleanupPlan(sessionPath: string): Promise<WorktreeCleanupPlan | null> {
  const cwd = await folderOf(sessionPath);
  if (!cwd) return null;
  const d = need();
  const repo = await classifyRepo(cwd, d.git);
  if (!repo) return null;
  const candidates = repo.trees.filter((t) => t.class !== "unmerged");
  const [use, procs] = await Promise.all([useFacts(candidates.map((t) => t.path)), candidates.length ? d.processes() : Promise.resolve([])]);
  const remove: WorktreeCleanupRemoved[] = [];
  const keep: WorktreeCleanupKept[] = [];
  // Each tree's checks (a git status for a candidate) a few at a time; the answer keeps git's order.
  const whys = await mapLimit(repo.trees, READ_CONCURRENCY, (t) => refusal(t, use, procs));
  repo.trees.forEach((t, i) => {
    const why = whys[i]!;
    if (why === null) remove.push(removedRow(t));
    else keep.push({ path: t.path, ...(t.branch ? { branch: t.branch } : {}), reason: why });
  });
  return { repo: repo.main, ...(repo.mainBranch ? { mainBranch: repo.mainBranch } : {}), home: homedir(), remove, keep };
}

/**
 * The same checks without removing anything: for each of `paths`, why it would stay, or null when it
 * may go. `ignoreProcesses` leaves live processes out, for a caller about to stop its own (archive
 * tears a worktree's running copy down first); `removeTrees` checks them again. Null: `dir` isn't in
 * a repository with a main checkout.
 */
export async function checkTrees(dir: string, paths: readonly string[], opts: { exclude?: string; ignoreProcesses?: boolean } = {}): Promise<Map<string, string | null> | null> {
  const d = need();
  const repo = await classifyRepo(dir, d.git);
  if (!repo) return null;
  const byPath = new Map(repo.trees.map((t) => [t.path, t]));
  const use = await useFacts(paths.filter((p) => byPath.get(p)?.class !== "unmerged" && byPath.has(p)), opts.exclude);
  const procs = opts.ignoreProcesses ? [] : await d.processes();
  const out = new Map<string, string | null>();
  for (const p of paths) {
    const t = byPath.get(p);
    out.set(p, t ? await refusal(t, use, procs) : "No longer in git's worktree list.");
  }
  return out;
}

/**
 * The one check-and-remove (§chat.worktrees/cleanup), for the Clean Up Merged button and for
 * `sova_archive {worktrees: "remove"}` (server/archive-worktrees.ts): exactly `paths` of the
 * repository `dir` is in, each checked again right before it goes, never --force; a branch in
 * the main branch by ancestry is deleted with `git branch -d`; each removal goes into the ledger.
 * `exclude` is a session file left out of the session checks (the session archiving its own
 * trees); `changedSince` words a refusal as a change since the dry run. "busy": a removal in the
 * same repository is running; null: `dir` isn't in a repository with a main checkout.
 */
export async function removeTrees(dir: string, paths: readonly string[], opts: { exclude?: string; changedSince?: boolean } = {}): Promise<WorktreeCleanupResult | "busy" | null> {
  const d = need();
  const repo = await classifyRepo(dir, d.git);
  if (!repo) return null;
  if (inFlight.has(repo.commonDir)) return "busy";
  inFlight.add(repo.commonDir);
  try {
    const byPath = new Map(repo.trees.map((t) => [t.path, t]));
    const asked = [...new Set(paths)];
    const use = await useFacts(asked.filter((p) => byPath.get(p)?.class !== "unmerged" && byPath.has(p)), opts.exclude);
    const removed: WorktreeCleanupRemoved[] = [];
    const kept: WorktreeCleanupKept[] = [];
    const ledger: RemovedWorktree[] = [];
    const queue = [...asked];
    const one = async (path: string): Promise<void> => {
      const t = byPath.get(path);
      if (!t) {
        kept.push({ path, reason: "No longer in git's worktree list." });
        return;
      }
      const why = await refusal(t, use, t.gone ? [] : await d.processes());
      if (why !== null) {
        kept.push({ path, ...(t.branch ? { branch: t.branch } : {}), reason: opts.changedSince ? `Changed since the preview: ${why}` : why });
        return;
      }
      const r = await d.gitWrite(["worktree", "remove", "--", t.path], { cwd: repo.main });
      if (r.code !== 0) {
        kept.push({ path, ...(t.branch ? { branch: t.branch } : {}), reason: `Git refused: ${firstLine(r)}` });
        return;
      }
      removed.push({ ...removedRow(t), branchDeleted: false });
    };
    await Promise.all(
      Array.from({ length: Math.min(REMOVE_CONCURRENCY, queue.length) }, async () => {
        for (let p = queue.shift(); p !== undefined; p = queue.shift()) await one(p);
      }),
    );
    // Branches one at a time: ref updates share packed-refs' lock.
    for (const row of removed) {
      const t = byPath.get(row.path)!;
      if (t.ancestor && t.branch) {
        const del = await d.gitWrite(["branch", "-d", "--", t.branch], { cwd: repo.main });
        row.branchDeleted = del.code === 0;
      }
      ledger.push({ v: 1, path: t.path, branch: t.branch ?? "", commonDir: repo.commonDir, tip: t.head ?? "", merged: t.class === "empty" ? "empty" : t.merged ?? "ancestor", branchDeleted: row.branchDeleted, at: d.now() });
    }
    if (ledger.length) d.ledger(ledger);
    summaries.delete(repo.commonDir);
    // After the ledger: the re-read finds a deleted branch's merge there.
    if (removed.length) await d.removed(removed.map((r) => r.path)).catch((err) => console.warn(`[cleanup] readiness: ${(err as Error).message}`));
    return { removed, kept };
  } finally {
    inFlight.delete(repo.commonDir);
  }
}

/**
 * POST /api/worktrees/cleanup {expect}: remove exactly the expected paths that are still
 * removable now; every other tree is left alone.
 */
export async function cleanupRemove(sessionPath: string, expect: readonly string[]): Promise<WorktreeCleanupResult | "busy" | null> {
  const cwd = await folderOf(sessionPath);
  return cwd ? removeTrees(cwd, expect, { changedSince: true }) : null;
}

/** Tests: start over. */
export function resetCleanup(): void {
  summaries.clear();
  scans.clear();
  resetContentMerges();
  inFlight.clear();
}
