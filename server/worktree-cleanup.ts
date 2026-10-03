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
import { readdir, readFile, readlink } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { SessionSummary, WorktreeCleanupKept, WorktreeCleanupPlan, WorktreeCleanupRemoved, WorktreeCleanupResult, WorktreesSummary } from "../shared/protocol";
import { runGit } from "../pi-config/extensions/worktrees/git.ts";
import { canonical, isWithin, WORKTREES_ENTRY_TYPE } from "../pi-config/extensions/worktrees/state.ts";
import { readStoredCwd } from "./git-summary";
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
  sessions: () => Promise<SessionSummary[]>;
  /** Every session file, listed or not (a new session with no message yet isn't listed). */
  sessionFiles: () => Promise<string[]>;
  /** A session file's active branch entries. */
  readBranch: (path: string) => Promise<readonly unknown[]>;
  /** The live processes and what they hold; read once per check. */
  processes: () => Promise<ProcFacts[]>;
  /** Whether a pid is a live process. */
  alive: (pid: number) => boolean;
  ledger: (entries: RemovedWorktree[]) => void;
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
export function configureCleanup(d: Partial<CleanupDeps> & Pick<CleanupDeps, "sessions" | "sessionFiles" | "readBranch">): void {
  deps = { git: execGit, gitWrite: writeGit, processes: scanProcesses, alive: pidAlive, ledger: (e) => appendLedger(e), now: Date.now, ...d };
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
const nameOf = (s: SessionSummary): string => (s.title?.trim() ? `“${s.title.trim().slice(0, 60)}”` : s.id.slice(0, 8));
const runningNow = (s: SessionSummary): boolean => s.busy || s.activity?.state === "working" || (s.workers?.working ?? s.live?.workers?.working ?? 0) > 0;

/** Every session's folder, and who tracks each of `paths` active (read only from files that name one). */
export async function useFacts(paths: readonly string[], exclude?: string): Promise<UseFacts> {
  const d = need();
  const [sessions, files] = await Promise.all([d.sessions(), d.sessionFiles().catch(() => [] as string[])]);
  const listed = new Map(sessions.map((s) => [s.path, s]));
  // Every file's folder: a session with no message yet isn't listed, and its folder counts too.
  const rows = await Promise.all(
    [...new Set([...listed.keys(), ...files])].map(async (path) => {
      const s = listed.get(path);
      const cwd = s?.cwd ?? (await readStoredCwd(path).catch(() => null));
      return { path, s, cwd, name: s ? nameOf(s) : (/([0-9a-f]{8})[0-9a-f-]*\.jsonl$/.exec(path)?.[1] ?? "unnamed") };
    }),
  ).then((all) => all.filter((r) => r.path !== exclude));
  const sessionCwds = rows.filter((r) => r.cwd && isAbsolute(r.cwd) && !parseTargetCwd(r.cwd)).map((r) => ({ cwd: canonical(r.cwd!), name: r.name }));
  const trackers = new Map<string, Tracker[]>();
  if (!paths.length) return { sessionCwds, trackers };
  const wanted = paths.map((p) => ({ path: p, needle: JSON.stringify(p).slice(1, -1) }));
  for (const { path, s, name } of rows) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    if (!text.includes(MARKER)) continue;
    const named = wanted.filter((w) => text.includes(w.needle));
    if (!named.length) continue;
    const branch = await d.readBranch(path).catch(() => [] as unknown[]);
    const set = worktreesOf(branch);
    if (!set) continue;
    const sandbox = sandboxInfo(branch as Parameters<typeof sandboxInfo>[0]).on;
    for (const w of named) {
      const tracked = set.trees.some((t) => t.status === "active" && canonical(t.path) === canonical(w.path));
      if (!tracked) continue;
      const list = trackers.get(w.path) ?? [];
      list.push({ name, live: !!s?.live, running: !!s && runningNow(s), sandbox });
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
  for (const t of repo.trees) {
    const why = await refusal(t, use, procs);
    if (why === null) remove.push(removedRow(t));
    else keep.push({ path: t.path, ...(t.branch ? { branch: t.branch } : {}), reason: why });
  }
  return { repo: repo.main, ...(repo.mainBranch ? { mainBranch: repo.mainBranch } : {}), home: homedir(), remove, keep };
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
  resetContentMerges();
  inFlight.clear();
}
