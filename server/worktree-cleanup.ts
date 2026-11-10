// What the worktree services read (§chat.worktrees/cleanup): every linked worktree in git's own list for a
// repository, classified by the shared answer (§chat.worktrees/nothing-left) as finished, empty (no commit of
// its own) or has work; the repository's count; who uses a tree; and which processes hold it. Reads only:
// the one removal step is server/worktree-remove.ts, and only server/worktree-retire.ts decides to call it.
// Git by argv, never a shell; reads under --no-optional-locks (server/worktrees.ts execGit).
import { execFile } from "node:child_process";
import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { SessionSummary, WorktreesSummary } from "../shared/protocol";
import { canonical, isWithin, WORKTREES_ENTRY_TYPE } from "../pi-config/extensions/worktrees/state.ts";
import { readStoredCwd } from "./git-summary";
import { lineHeader, lineNeedle } from "./harness/pi/reader";
import { scratchCopiesIn } from "./merge-queue/scratch";
import { branchLeft, type BranchLeft } from "./nothing-left";
import { resetContentMerges } from "./removed-worktrees";
import { sandboxInfo } from "./sandbox-state";
import { parseTargetCwd } from "./targets";
import { worktreesOf } from "./worktrees-state";
import { retirementAllowed } from "./worktree-retire-gate";
import { retirementCounts } from "./worktree-retire-view";
import { execGit, type GitRunner } from "./worktrees";

/** How long a count stands while git's list of worktrees doesn't change. */
export const SUMMARY_TTL_MS = 30_000;
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
  /** How a finished tree has nothing left: `leftover`, its only commits past the target are merges or it is the landed commit. */
  merged?: "ancestor" | "content" | "leftover";
  /** The branch is an ancestor of the main branch: `git branch -d` may delete it. */
  ancestor: boolean;
  /** Why a tree with work stays. */
  why?: string;
  /** The spec drafts in its folder not proved landed (§chat.worktrees/nothing-left). A tree with no code left but these has class "unmerged" and this list. */
  drafts?: string[];
  /** Git couldn't answer the shared question: a doubt, so it stays. */
  unknown?: boolean;
  /** One of the merge queue's own chats made it: it retires by the same rule, on no list of yours. */
  queueMade?: true;
  /** Other worktrees (or the main checkout) whose folders are inside this one: removing it would take them too. */
  nested?: string[];
}

/** A repository and its linked worktrees, classified. */
export interface RepoTrees {
  commonDir: string;
  /** The main checkout's folder: where removals run. */
  main: string;
  /** master, else main; absent when the repository has neither. */
  mainBranch?: string;
  /** The branch this repository lands on: the project's declared target, else mainBranch. */
  target?: { name: string; oid: string };
  trees: ClassifiedTree[];
}

/** One chat that uses a worktree: its folder is inside it, or it tracks it as active. */
export interface ChatUse {
  /** The session file. */
  path: string;
  id?: string;
  /** Its title in quotes, else a short id: how a reason names it. */
  name: string;
  /** Its folder (header cwd, canonical); null: a remote placeholder or none. */
  cwd: string | null;
  /** The asked paths its folder is inside. */
  inside: string[];
  /** The asked paths it tracks as active. */
  tracks: string[];
  archived: boolean;
  running: boolean;
  /** Open in a TUI. */
  tui: boolean;
  /** Workers it holds, idle ones too. */
  workers: number;
  sandbox: boolean;
  /** Its summary couldn't be read: nobody can say it's quiet. */
  unknown?: true;
  /** Its session file's last write, ms. */
  lastActiveAt: number;
}

/** What a read of the chats found: `unreadable` names a session file that could not be read, so who uses what isn't known. */
export interface ChatFacts {
  uses: ChatUse[];
  unreadable: string[];
}

/** One tree a chat's worktree records name, any status. */
export interface TreeRecord {
  path: string;
  branch: string;
  base: string;
  session: string;
}

/** A live process and the paths it holds (its cwd and open files). */
export interface ProcFacts {
  pid: number;
  command: string;
  paths: string[];
  /** Set when the processes could not be read at all: every tree is kept, with this as its reason. */
  unreadable?: string;
}

/**
 * A git this server started itself and is waiting on: its direct child, and the program is git. The server reads the trees it
 * is about to judge all the time (a chat's summary starts a readiness read, in that chat's folder, while a pass asks what is
 * running there), and those reads end by themselves. Neither fact alone is proof: a git a chat, a terminal or anything else
 * started has another parent, and any other child of this server is another program.
 */
export const ownGitChild = (command: string, parent: number, self: number = process.pid): boolean => command === "git" && parent === self;

/** The parent pid in a /proc/<pid>/stat line; the command before it may hold spaces and parentheses. NaN: it can't be read, so nothing is proved. */
export function statParent(stat: string): number {
  const after = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
  return Number(after[1]);
}

export interface CleanupDeps {
  /** Reads (no optional locks, short timeout). */
  git: GitRunner;
  /** One session's row (server/sessions-index.ts getSessionSummary), asked only for a session whose folder is inside a tree asked about, or which tracks one. */
  summary: (path: string) => Promise<SessionSummary | null>;
  /** Every session file, listed or not (a new session with no message yet isn't listed). */
  sessionFiles: () => Promise<string[]>;
  /** A session file's active branch entries (read only for a changed file that holds a `worktrees` entry). */
  readBranch: (path: string) => Promise<readonly unknown[]>;
  /** The active branch entries of a session file's text already read (the scan's bytes): the same answer as
      readBranch with no second read of the file. Absent: readBranch reads it again. */
  parseBranch?: (text: string) => readonly unknown[];
  /** A session file's bytes, read only when it changed since the last check (the scan's cache). */
  readFile: (path: string) => Promise<Buffer>;
  /** Which worktrees one of the merge queue's own chats made (merge-queue/wire.ts worktreeQueueMadeNow), asked once per
      list and then of each row: hidden from every count and list, though they retire like any other. Absent: none is. */
  queueMade?: () => Promise<(path: string) => boolean>;
  /** The branch a repository lands on, when its project declares one. Absent or null: master, else main. */
  targetOf?: (main: string) => Promise<string | null>;
  now: () => number;
}

/** The reads of /proc a scan makes; tests stand in for them to stop a process at an exact point. */
export interface ProcReads {
  readdir(path: string): Promise<string[]>;
  readlink(path: string): Promise<string>;
  readFile(path: string): Promise<string>;
}
const realProc: ProcReads = { readdir: (p) => readdir(p), readlink: (p) => readlink(p), readFile: (p) => readFile(p, "utf8") };

/**
 * The live processes and the paths they hold: /proc/<pid>/cwd and /proc/<pid>/fd/* of every process
 * this user can read on Linux; elsewhere (macOS) `lsof` of this user's processes. This server and its
 * own git children (`ownGitChild`) are left out. When `lsof` can't answer, one `unreadable` entry: a
 * tree is kept, never assumed free.
 */
export async function scanProcesses(platform: NodeJS.Platform = process.platform, lsof: () => Promise<{ code: number; stdout: string; stderr: string }> = runLsof, proc: ProcReads = realProc): Promise<ProcFacts[]> {
  if (platform !== "linux") {
    const r = await lsof();
    if (r.code !== 0) return [{ pid: 0, command: "lsof", paths: [], unreadable: `Its processes couldn't be read (lsof: ${r.stderr.trim().split("\n")[0] || `exit ${r.code}`}), so it is kept.` }];
    return parseLsof(r.stdout, process.pid);
  }
  let pids: string[];
  try {
    pids = (await proc.readdir("/proc")).filter((d) => /^\d+$/.test(d));
  } catch (err) {
    return [{ pid: 0, command: "proc", paths: [], unreadable: `Its processes couldn't be read (/proc: ${(err as NodeJS.ErrnoException).code ?? "error"}), so it is kept.` }];
  }
  const out: ProcFacts[] = [];
  await Promise.all(
    pids.map(async (p) => {
      const pid = Number(p);
      if (pid === process.pid) return;
      const paths: string[] = [];
      const cwd = await proc.readlink(`/proc/${p}/cwd`).catch(() => null);
      if (cwd) paths.push(cwd);
      const fds = await proc.readdir(`/proc/${p}/fd`).catch(() => [] as string[]);
      for (const fd of fds) {
        const target = await proc.readlink(`/proc/${p}/fd/${fd}`).catch(() => null);
        if (target?.startsWith("/")) paths.push(target.replace(/ \(deleted\)$/, ""));
      }
      if (!paths.length) return;
      // Null: it exited while being read, so nothing is running. Any other failure leaves "" and a process that still holds.
      const read = (name: string): Promise<string | null> => proc.readFile(`/proc/${p}/${name}`).catch((err: NodeJS.ErrnoException) => (err.code === "ENOENT" || err.code === "ESRCH" ? null : ""));
      const [comm, stat] = [await read("comm"), await read("stat")];
      if (comm === null || stat === null) return;
      const command = comm.trim() || "process";
      const parent = statParent(stat);
      if (ownGitChild(command, parent)) return;
      out.push({ pid, command, paths });
    }),
  );
  return out;
}

const runLsof = () =>
  new Promise<{ code: number; stdout: string; stderr: string }>((done) =>
    execFile("lsof", ["-nP", "-w", "-u", String(process.getuid?.() ?? ""), "-FpRcn"], { timeout: 30_000, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }, (err, stdout, stderr) =>
      done({ code: err ? (typeof err.code === "number" ? err.code : 127) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (err && typeof err.code !== "number" ? err.message : "") }),
    ),
  );

/** `lsof -FpRcn` output (`p<pid>`, `R<parent>`, `c<command>`, `f<fd>`, `n<name>` lines) → each process's cwd and open files, `self` and its own git children left out (pure, for tests). */
export function parseLsof(text: string, self: number): ProcFacts[] {
  const out: ProcFacts[] = [];
  const parents = new Map<ProcFacts, number>();
  let cur: ProcFacts | null = null;
  for (const line of text.split("\n")) {
    const v = line.slice(1);
    if (line[0] === "p") {
      cur = { pid: Number(v), command: "process", paths: [] };
      if (cur.pid !== self) out.push(cur);
    } else if (cur && line[0] === "R") parents.set(cur, Number(v));
    else if (cur && line[0] === "c") cur.command = v || "process";
    else if (cur && line[0] === "n" && v.startsWith("/")) cur.paths.push(v.replace(/ \(deleted\)$/, ""));
  }
  return out.filter((p) => p.paths.length && !ownGitChild(p.command, parents.get(p) ?? NaN, self));
}

export function pidAlive(pid: number): boolean {
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
  deps = { git: execGit, now: Date.now, readFile: (p) => readFile(p), ...d };
}
const need = (): CleanupDeps => {
  if (!deps) throw new Error("worktree cleanup is not configured");
  return deps;
};

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

export interface ClassifyOpts {
  git?: GitRunner;
  /** Keep the worktrees one of the queue's own chats made: retirement takes those; every count and list hides them. */
  withQueueMade?: boolean;
  /** Only these paths: the recheck right before a removal. */
  only?: readonly string[];
  /** The shared answer; tests swap it. */
  left?: (o: Parameters<typeof branchLeft>[0]) => Promise<BranchLeft>;
  /** Who made which, for this call: the configured seam otherwise. */
  queueMade?: () => Promise<(path: string) => boolean>;
}

const LEFTOVER_KINDS = new Set(["catch-up", "landed", "past-landing"]);

/** The repository `dir` is in, and its linked worktrees classified; null when it isn't in one with a main checkout. */
export async function classifyRepo(dir: string, opts: GitRunner | ClassifyOpts = {}): Promise<RepoTrees | null> {
  const o: ClassifyOpts = typeof opts === "function" ? { git: opts } : opts;
  const git = o.git ?? need().git;
  const leftOf = o.left ?? branchLeft;
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
  let target: { name: string; oid: string } | undefined = mainBranch ? { name: mainBranch, oid: mainSha } : undefined;
  const declared = await deps?.targetOf?.(main).catch(() => null);
  if (declared && declared !== mainBranch) {
    const r = await git(["rev-parse", "--verify", "-q", `refs/heads/${declared}^{commit}`], { cwd: main });
    // A declared target that can't be read is a doubt: no target, so every tree stays.
    target = r.code === 0 ? { name: declared, oid: r.stdout.trim() } : undefined;
  }
  const ancestors = new Set<string>();
  if (mainSha) {
    const r = await git(["for-each-ref", `--merged=${mainSha}`, "--format=%(refname)", "refs/heads"], { cwd: main });
    if (r.code === 0) for (const ref of r.stdout.split("\n")) if (ref.startsWith("refs/heads/")) ancestors.add(ref.slice(11));
  }
  const trees: ClassifiedTree[] = [];
  // The merge queue's scratch copies (by the mark it leaves in each one's admin dir) are its own, removed when their
  // landing attempt ends: never listed, held or removed here. The ones a merge queue chat created itself leave every
  // count and list, and retire by the same rule (withQueueMade).
  const scratch = new Set(scratchCopiesIn(commonDir).map((c) => canonical(c.path)));
  const queueMadeNow = o.queueMade ?? deps?.queueMade;
  // One look for the whole list: each row is then a lookup. Can't be read: none is the queue's.
  const queueMade = queueMadeNow ? await queueMadeNow().catch(() => null) : null;
  const only = o.only ? new Set(o.only) : null;
  for (const w of linked) {
    if (only && !only.has(w.path)) continue;
    if (scratch.has(canonical(w.path))) continue;
    const madeByQueue = !!queueMade?.(w.path);
    if (madeByQueue && !o.withQueueMade) continue;
    const nested = [first, ...linked].filter((x) => x.path !== w.path && isWithin(canonical(x.path), canonical(w.path))).map((x) => x.path);
    const base: ClassifiedTree = { path: w.path, ...(w.branch ? { branch: w.branch } : {}), ...(w.head ? { head: w.head } : {}), locked: w.locked, gone: w.prunable || !existsSync(w.path), class: "unmerged", ancestor: false, ...(nested.length ? { nested } : {}), ...(madeByQueue ? { queueMade: true as const } : {}) };
    if (!w.branch || !w.head) {
      trees.push({ ...base, why: "Not on a branch." });
      continue;
    }
    if (!target) {
      trees.push({ ...base, why: "No master or main branch to merge into." });
      continue;
    }
    const ancestor = ancestors.has(w.branch);
    const left = await leftOf({ root: main, ...(base.gone ? {} : { folder: w.path }), branch: w.branch, head: w.head, target }).catch(() => null);
    if (!left || left.code.kind === "unknown") {
      trees.push({ ...base, ancestor, unknown: true, why: `Sova can't read what this branch has left${left?.code.error ? `: ${left.code.error}` : "."}` });
      continue;
    }
    const drafts = left.drafts.length ? { drafts: left.drafts } : {};
    if (left.code.left) {
      trees.push({ ...base, ancestor, ...drafts, why: `Not merged into ${target.name}.` });
      continue;
    }
    if (left.drafts.length) {
      trees.push({ ...base, ancestor, ...drafts, why: "Its spec drafts aren't proved landed." });
      continue;
    }
    if (createdAt(commonDir, w.branch) === w.head) trees.push({ ...base, class: "empty", ancestor });
    else trees.push({ ...base, class: "merged", merged: left.code.kind === "ancestor" ? "ancestor" : LEFTOVER_KINDS.has(left.code.kind) ? "leftover" : "content", ancestor });
  }
  return { commonDir, main, ...(mainBranch ? { mainBranch } : {}), ...(target ? { target } : {}), trees };
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

const offForNow = (): { offFor?: Exclude<ReturnType<typeof retirementAllowed>, { on: true }>["offFor"] } => {
  const gate = retirementAllowed();
  return gate.on ? {} : { offFor: gate.offFor };
};

const countOf = (r: RepoTrees): WorktreesSummary => ({
  state: "ok",
  repo: r.main,
  ...(r.mainBranch ? { mainBranch: r.mainBranch } : {}),
  total: r.trees.length,
  merged: r.trees.filter((t) => t.class === "merged").length,
  empty: r.trees.filter((t) => t.class === "empty").length,
  unmerged: r.trees.filter((t) => t.class === "unmerged").length,
  ...retirementCounts(r.commonDir, Date.now()),
  ...offForNow(),
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

// --- who uses a tree ---------------------------------------------------------------------------

/** A session as a reason names it: its title, else (none, or a new session's "Untitled") its short id. */
const nameOf = (s: SessionSummary | null, path: string): string => {
  const title = s?.title?.trim();
  if (title && title !== "Untitled") return `“${title.slice(0, 60)}”`;
  return s?.id?.slice(0, 8) || (/([0-9a-f]{8})[0-9a-f-]*\.jsonl$/.exec(path)?.[1] ?? "unnamed");
};
/** Working, or waiting on an answer the chat asked for: not quiet either way. */
const runningNow = (s: SessionSummary): boolean => s.busy || s.activity?.state === "working" || s.activity?.state === "needs-input" || (s.workers?.working ?? s.live?.workers?.working ?? 0) > 0;

/** What one session file says, as of one version of it: its header's folder, and, when it holds a
    `worktrees` entry, the active trees of its active branch (canonical) and whether its sandbox is on. */
interface FileScan {
  version: string;
  mtime: number;
  cwd: string | null;
  tracks?: { active: Set<string>; sandbox: boolean; records: { path: string; branch: string; base: string }[]; created: string[] };
  /** Its sandbox, read once for a session that holds no `worktrees` entry but whose folder is in a tree asked about. */
  sandbox?: boolean;
}
const scans = new Map<string, FileScan>();
const MARKER_BYTES = lineNeedle({ state: WORKTREES_ENTRY_TYPE });
/** Changed files read at once: a cold scan of hundreds of MB never sits in memory whole. */
const READ_CONCURRENCY = 4;

/** The header's folder, read as git-summary's `readStoredCwd` reads it (the first line of the first 64 KB). */
function headerCwd(buf: Buffer): string | null {
  try {
    const first = buf.subarray(0, 64 * 1024).toString("utf8").split("\n", 1)[0] ?? "";
    const cwd = lineHeader(first)?.cwd;
    return typeof cwd === "string" && cwd !== "" ? cwd : null;
  } catch {
    return null;
  }
}

/** One file's scan: from the cache while its (inode, size, mtime) hold; else read once, as bytes. Null: unreadable. */
async function scanFile(path: string, d: CleanupDeps, failed?: string[]): Promise<FileScan | null> {
  let st;
  try {
    st = await stat(path);
  } catch (err) {
    scans.delete(path);
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") failed?.push(path);
    return null;
  }
  const version = `${st.ino}:${st.size}:${st.mtimeMs}`;
  const hit = scans.get(path);
  if (hit?.version === version) return hit;
  let buf: Buffer;
  try {
    buf = await d.readFile(path);
  } catch (err) {
    scans.delete(path);
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") failed?.push(path);
    return null;
  }
  const scan: FileScan = { version, mtime: st.mtimeMs, cwd: headerCwd(buf) };
  // Only a file that ever wrote a `worktrees` entry is parsed: the marker is searched in the raw bytes.
  if (buf.includes(MARKER_BYTES)) {
    // Its marker is there: a branch that can't be read says nothing about what it tracks, so the file counts as unreadable.
    let branch: readonly unknown[];
    try {
      branch = d.parseBranch ? d.parseBranch(buf.toString("utf8")) : await d.readBranch(path);
    } catch {
      failed?.push(path);
      return null;
    }
    const set = worktreesOf(branch);
    if (set) {
      scan.tracks = {
        active: new Set(set.trees.filter((t) => t.status === "active").map((t) => canonical(t.path))),
        sandbox: sandboxInfo(branch as Parameters<typeof sandboxInfo>[0]).on,
        records: set.trees.map((t) => ({ path: t.path, branch: t.branch, base: t.base })),
        // The ones this chat made itself and still keeps: what a merge queue chat made is the queue's own (createdByChats).
        created: set.trees.filter((t) => t.how === "created" && t.status !== "dropped").map((t) => t.path),
      };
    }
  }
  scans.set(path, scan);
  return scan;
}

/** After a sweep of every session file: forget the ones it didn't list, so the record holds what is there, however many. */
function keepOnly(listed: ReadonlySet<string>): void {
  for (const path of scans.keys()) if (!listed.has(path)) scans.delete(path);
}

/** How many session files the record holds (tests). */
export const scannedFiles = (): number => scans.size;

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

/**
 * Which chats use `paths`: a folder inside one, or tracking one as active. Each session file is read only
 * when it changed since the last call (per file by inode, size and mtime) and parsed only when it holds a
 * `worktrees` entry; only those few sessions are looked up (their title, TUI, running state): a warm call
 * costs a `stat` per file. Fails closed: a session list that can't be read throws, and a session file that
 * can't be read is named in `unreadable`, since it might be a chat using any of them.
 */
export async function chatUses(paths: readonly string[], exclude?: string): Promise<ChatFacts> {
  const d = need();
  const listed = new Set(await d.sessionFiles());
  const all = [...listed].filter((p) => p !== exclude);
  const unreadable: string[] = [];
  const scanned = await mapLimit(all, READ_CONCURRENCY, (path) => scanFile(path, d, unreadable));
  keepOnly(listed);
  const wanted = paths.map((p) => ({ path: p, canon: canonical(p) }));
  const rows = all
    .map((path, i) => {
      const scan = scanned[i];
      const cwd = scan?.cwd && isAbsolute(scan.cwd) && !parseTargetCwd(scan.cwd) ? canonical(scan.cwd) : null;
      return { path, scan, cwd, inside: cwd ? wanted.filter((w) => isWithin(cwd, w.canon)) : [], tracks: scan?.tracks ? wanted.filter((w) => scan.tracks!.active.has(w.canon)) : [] };
    })
    .filter((r) => r.inside.length || r.tracks.length);
  const uses = await mapLimit(rows, READ_CONCURRENCY, async (r): Promise<ChatUse> => {
    const s = await d.summary(r.path);
    let sandbox = r.scan!.tracks?.sandbox ?? r.scan!.sandbox;
    if (sandbox === undefined) {
      try {
        sandbox = sandboxInfo((await d.readBranch(r.path)) as Parameters<typeof sandboxInfo>[0]).on;
        r.scan!.sandbox = sandbox;
      } catch {
        // Can't tell: a doubt counts as on, so it holds.
        sandbox = true;
      }
    }
    return {
      path: r.path,
      ...(s?.id ? { id: s.id } : {}),
      name: nameOf(s, r.path),
      cwd: r.cwd,
      inside: r.inside.map((w) => w.path),
      tracks: r.tracks.map((w) => w.path),
      archived: !!s?.archived,
      running: !!s && runningNow(s),
      // No summary: a doubt isn't quiet.
      ...(s ? {} : { unknown: true as const }),
      tui: !!s?.live,
      workers: s?.workers?.total ?? s?.live?.workers?.total ?? 0,
      sandbox,
      lastActiveAt: r.scan!.mtime,
    };
  });
  return { uses, unreadable };
}

/** Every tree any chat's worktree records name, any status: the only way a leftover folder is found, with the ledger. Fails closed as chatUses does. */
export async function treeRecords(): Promise<{ records: TreeRecord[]; unreadable: string[] }> {
  const d = need();
  const all = [...new Set(await d.sessionFiles())];
  const unreadable: string[] = [];
  const scanned = await mapLimit(all, READ_CONCURRENCY, (path) => scanFile(path, d, unreadable));
  keepOnly(new Set(all));
  const records: TreeRecord[] = [];
  scanned.forEach((scan, i) => {
    for (const r of scan?.tracks?.records ?? []) records.push({ ...r, session: all[i]! });
  });
  return { records, unreadable };
}

/**
 * The worktrees `sessionPaths` made themselves and still keep (their own `worktrees` records), from the same per-file
 * record: a file is read only when it changed since it was last read (inode, size, mtime), so asking again with
 * nothing changed costs a `stat` per file. `key` moves whenever any of them changed. A file that can't be read
 * names none: these are the merge queue's own chats, and a doubt leaves a worktree on the lists.
 */
export async function createdByChats(sessionPaths: readonly string[]): Promise<{ key: string; trees: string[] }> {
  const d = need();
  const scanned = await mapLimit(sessionPaths, READ_CONCURRENCY, (path) => scanFile(path, d));
  const trees = new Set<string>();
  for (const scan of scanned) for (const p of scan?.tracks?.created ?? []) trees.add(p);
  return { key: sessionPaths.map((p, i) => `${p}@${scanned[i]?.version ?? "-"}`).join("\0"), trees: [...trees] };
}

/** A removal changed git's list: the next count reads again. */
export const forgetSummary = (commonDir: string): void => {
  summaries.delete(commonDir);
};

/** Tests: start over. */
export function resetCleanup(): void {
  summaries.clear();
  scans.clear();
  resetContentMerges();
}
