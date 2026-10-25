/**
 * Git's scheduled maintenance for every project's repository.
 *
 * Nothing Sova starts begins git's background cleanup any longer (server/git-no-background.ts),
 * so the cleanup has to run somewhere: git's own scheduler (systemd user timers, launchd), started
 * by the server and never inside a chat or the sandbox, so nothing cuts it off.
 *
 * - Each project root that is a git checkout is registered (`git maintenance register` in its main
 *   checkout) with these keys in the repository's own config: maintenance.auto=false,
 *   maintenance.strategy=incremental, maintenance.prefetch.enabled=false,
 *   maintenance.worktree-prune.enabled=false, gc.worktreePruneExpire=never, and a weekly full gc
 *   (maintenance.gc.enabled=true, maintenance.gc.schedule=weekly; no expiry shortened). A key added
 *   since a repository was registered is set at the next sweep.
 * - Each sweep removes cleanup locks a killed run left (older than an hour), only when no git process
 *   works in that repository (recoverStaleLocks): otherwise every later run skips and exits 0.
 * - What Sova did is recorded in <state root>/git-maintenance.json: whether it added the
 *   registration (a repository already in the user's maintenance.repo is left as it was) and each
 *   key's earlier value. A repository no project holds any longer is unregistered only when Sova
 *   registered it, and each key Sova set that still holds Sova's value is put back.
 * - `git maintenance start --scheduler=auto` once per machine, recorded; again only when the record
 *   is missing or the last start failed.
 *
 * It writes the user's global git config and timers, so it is off under SOVA_GIT_MAINTENANCE=off,
 * which the test runner and the hermetic dev server set. Tests drive `syncGitMaintenance` with
 * their own deps (a throwaway HOME / GIT_CONFIG_GLOBAL, a stand-in scheduler).
 */
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CLEANUP_LOCKS, STUCK_LOCK_MS } from "./git-folder";
import { NO_BACKGROUND_CLEANUP } from "./git-no-background";
import { stateRoot } from "./state-root";

/** The keys Sova sets in a registered repository's own config, and their values. */
export const MAINTENANCE_KEYS: readonly (readonly [string, string])[] = [
  ["maintenance.auto", "false"],
  ["maintenance.strategy", "incremental"],
  ["maintenance.prefetch.enabled", "false"],
  ["maintenance.worktree-prune.enabled", "false"],
  ["gc.worktreePruneExpire", "never"],
  // A full gc weekly: the incremental strategy alone never prunes, so a repository only grows. No
  // expiry is shortened: git's defaults keep unreachable objects 2 weeks and reflogs 90/30 days.
  ["maintenance.gc.enabled", "true"],
  ["maintenance.gc.schedule", "weekly"],
];

export type GitRun = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface MaintenanceDeps {
  /** Runs git (default: the real one with the server's env). */
  git: GitRun;
  /** The record (default <state root>/git-maintenance.json). */
  recordPath: string;
  log: (line: string) => void;
  /** Where the process table is read (default /proc); tests point it elsewhere. */
  procRoot?: string;
  now?: () => number;
}

interface RepoRecord {
  /** Sova ran `git maintenance register`: it was not in the user's maintenance.repo before. */
  registered: boolean;
  /** Each key's value before Sova set it; null: it was unset. */
  before: Record<string, string | null>;
}
interface MaintenanceRecord {
  version: 1;
  repos: Record<string, RepoRecord>;
  /** `git maintenance start` succeeded (once per machine). */
  started?: { at: string };
}

const realGit: GitRun = (args, cwd) =>
  new Promise((done) => {
    execFile("git", args, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) => {
      done({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0, stdout: String(stdout), stderr: String(stderr || (err && !stderr ? err.message : "")) });
    });
  });

export const defaultMaintenanceDeps = (): MaintenanceDeps => ({
  git: realGit,
  recordPath: join(stateRoot(), "git-maintenance.json"),
  log: (line) => console.warn(`[git-maintenance] ${line}`),
});

function readRecord(path: string): MaintenanceRecord {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as MaintenanceRecord;
    if (v && v.version === 1 && v.repos && typeof v.repos === "object") return v;
  } catch {}
  return { version: 1, repos: {} };
}

function writeRecord(path: string, rec: MaintenanceRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`);
  renameSync(tmp, path);
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const firstLine = (s: string) => s.trim().split("\n")[0] || "failed";

/** The main checkout of the repository holding `root` (a linked worktree's main one), or null when it isn't a non-bare checkout. */
export async function mainCheckoutOf(git: GitRun, root: string): Promise<string | null> {
  if (!existsSync(root)) return null;
  const r = await git(["rev-parse", "--path-format=absolute", "--git-common-dir", "--is-bare-repository"], root);
  if (r.code !== 0) return null;
  const [common, bare] = r.stdout.trim().split("\n");
  if (!common || bare === "true" || basename(common) !== ".git") return null;
  return real(dirname(common));
}

/** The user's maintenance.repo entries, as real paths. */
async function registeredRepos(git: GitRun, cwd: string): Promise<Set<string>> {
  const r = await git(["config", "--global", "--get-all", "maintenance.repo"], cwd);
  return new Set(r.code === 0 ? r.stdout.split("\n").filter(Boolean).map(real) : []);
}

async function localValue(git: GitRun, repo: string, key: string): Promise<string | null> {
  const r = await git(["config", "--local", "--get", key], repo);
  return r.code === 0 ? r.stdout.replace(/\n$/, "") : null;
}

async function register(deps: MaintenanceDeps, repo: string, already: boolean): Promise<RepoRecord | null> {
  const before: Record<string, string | null> = {};
  for (const [k] of MAINTENANCE_KEYS) before[k] = await localValue(deps.git, repo, k);
  if (!already) {
    const r = await deps.git([...NO_BACKGROUND_CLEANUP, "maintenance", "register"], repo);
    if (r.code !== 0) {
      deps.log(`${repo}: git maintenance register failed: ${firstLine(r.stderr || r.stdout)}`);
      return null;
    }
  }
  for (const [k, v] of MAINTENANCE_KEYS) {
    const r = await deps.git(["config", "--local", k, v], repo);
    if (r.code !== 0) deps.log(`${repo}: couldn't set ${k}: ${firstLine(r.stderr || r.stdout)}`);
  }
  return { registered: !already, before };
}

async function unregister(deps: MaintenanceDeps, repo: string, rec: RepoRecord): Promise<void> {
  if (rec.registered) {
    // The repository's own command when it is still there; else the same edit of the user's config.
    const r = existsSync(repo)
      ? await deps.git(["maintenance", "unregister", "--force"], repo)
      : await deps.git(["config", "--global", "--fixed-value", "--unset-all", "maintenance.repo", repo], dirname(repo));
    if (r.code !== 0 && r.code !== 5) deps.log(`${repo}: git maintenance unregister failed: ${firstLine(r.stderr || r.stdout)}`);
  }
  if (!existsSync(repo)) return;
  for (const [k, v] of MAINTENANCE_KEYS) {
    if (!(k in rec.before) || (await localValue(deps.git, repo, k)) !== v) continue; // changed since: theirs now
    const prev = rec.before[k];
    await deps.git(prev === null || prev === undefined ? ["config", "--local", "--unset", k] : ["config", "--local", k, prev], repo);
  }
}

/** Set each key a repository registered earlier doesn't have yet (one added since), recording its earlier value. */
async function addMissingKeys(deps: MaintenanceDeps, repo: string, r: RepoRecord): Promise<boolean> {
  let changed = false;
  for (const [k, v] of MAINTENANCE_KEYS) {
    if (k in r.before) continue;
    r.before[k] = await localValue(deps.git, repo, k);
    const set = await deps.git(["config", "--local", k, v], repo);
    if (set.code !== 0) deps.log(`${repo}: couldn't set ${k}: ${firstLine(set.stderr || set.stdout)}`);
    changed = true;
  }
  return changed;
}

/** A running git process: where it works, and the git folders its environment names. */
export interface GitProcess {
  pid: number;
  cwd: string;
  gitDirs: string[];
}

const GIT_PROGRAM = /^git(-[a-z0-9-]+)?$/;

/**
 * Every git process this host's process table shows, or null when it can't be read whole: no
 * `procRoot` (macOS), or a git process whose folder or environment can't be read (another user's).
 * A process that ends while being read is left out.
 */
export function gitProcesses(procRoot = "/proc"): GitProcess[] | null {
  let pids: string[];
  try {
    pids = readdirSync(procRoot).filter((d) => /^\d+$/.test(d));
  } catch {
    return null;
  }
  const out: GitProcess[] = [];
  for (const pid of pids) {
    const dir = join(procRoot, pid);
    let argv0: string;
    try {
      argv0 = readFileSync(join(dir, "cmdline"), "utf8").split("\0")[0] ?? "";
    } catch {
      continue; // gone, or nothing to read
    }
    if (!GIT_PROGRAM.test(basename(argv0))) continue;
    try {
      const cwd = readlinkSync(join(dir, "cwd"));
      const env = readFileSync(join(dir, "environ"), "utf8").split("\0");
      const gitDirs = env.filter((e) => /^(GIT_DIR|GIT_COMMON_DIR|GIT_WORK_TREE)=/.test(e)).map((e) => resolve(cwd, e.slice(e.indexOf("=") + 1)));
      out.push({ pid: Number(pid), cwd, gitDirs });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // it ended meanwhile
      return null; // a git we can't see into: unsure
    }
  }
  return out;
}

const within = (p: string, root: string) => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);

/**
 * Remove the cleanup locks (git-folder.ts CLEANUP_LOCKS: maintenance.lock, gc.pid, the
 * multi-pack-index and commit-graph locks) older than STUCK_LOCK_MS in `repo`'s git folder, which a
 * killed run left: while maintenance.lock or gc.pid stays, every scheduled run skips and exits 0.
 * Only when the process table says no git works in the repository, its git folder or one of its
 * worktrees; when it can't say, nothing. Never index.lock or a ref's lock. Returns what it removed.
 */
export async function recoverStaleLocks(repo: string, deps: MaintenanceDeps): Promise<string[]> {
  const gitDir = join(repo, ".git");
  const now = (deps.now ?? Date.now)();
  const stale = CLEANUP_LOCKS.map((rel) => join(gitDir, rel)).filter((p) => {
    try {
      return now - lstatSync(p).mtimeMs > STUCK_LOCK_MS;
    } catch {
      return false;
    }
  });
  if (!stale.length) return [];
  const list = await deps.git(["worktree", "list", "--porcelain"], repo);
  if (list.code !== 0) return [];
  const places = [repo, gitDir, ...list.stdout.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9))].map(real);
  const procs = gitProcesses(deps.procRoot);
  if (!procs) {
    deps.log(`${repo}: left ${stale.length} stale lock(s): can't tell whether a git is working there`);
    return [];
  }
  const busy = procs.find((p) => [p.cwd, ...p.gitDirs].some((d) => places.some((pl) => within(real(d), pl))));
  if (busy) return [];
  const removed: string[] = [];
  for (const p of stale) {
    try {
      rmSync(p);
      removed.push(p);
      deps.log(`${repo}: removed the stale lock ${p} (more than an hour old, no git working there)`);
    } catch (err) {
      deps.log(`${repo}: couldn't remove ${p}: ${(err as Error).message}`);
    }
  }
  return removed;
}

/**
 * Bring git's registrations in line with `roots` (every project root on this host): register each
 * main checkout not yet recorded, unregister each recorded one no root holds, then start git's
 * scheduler once. Idempotent; a failure is logged and the next sweep tries again.
 */
export async function syncGitMaintenance(roots: readonly string[], deps: MaintenanceDeps = defaultMaintenanceDeps()): Promise<void> {
  const rec = readRecord(deps.recordPath);
  const wanted = new Set<string>();
  for (const root of roots) {
    const repo = await mainCheckoutOf(deps.git, root);
    if (repo) wanted.add(repo);
  }
  const anyCwd = [...wanted][0] ?? dirname(deps.recordPath);
  let current: Set<string> | null = null;
  for (const repo of wanted) {
    if (rec.repos[repo]) {
      if (await addMissingKeys(deps, repo, rec.repos[repo]!)) writeRecord(deps.recordPath, rec);
      continue;
    }
    current ??= await registeredRepos(deps.git, anyCwd);
    const done = await register(deps, repo, current.has(repo));
    if (done) {
      rec.repos[repo] = done;
      writeRecord(deps.recordPath, rec);
    }
  }
  for (const [repo, r] of Object.entries(rec.repos)) {
    if (wanted.has(repo)) continue;
    await unregister(deps, repo, r);
    delete rec.repos[repo];
    writeRecord(deps.recordPath, rec);
  }
  for (const repo of Object.keys(rec.repos)) if (existsSync(repo)) await recoverStaleLocks(repo, deps);
  const first = Object.keys(rec.repos).find((r) => existsSync(r));
  if (first && !rec.started) {
    const s = await deps.git(["maintenance", "start", "--scheduler=auto"], first);
    if (s.code === 0) {
      rec.started = { at: new Date().toISOString() };
      writeRecord(deps.recordPath, rec);
    } else deps.log(`git maintenance start failed: ${firstLine(s.stderr || s.stdout)}`);
  }
}

// ---- the server's sweeps ----------------------------------------------------------------------------

export const GIT_MAINTENANCE_SWEEP_MS = 6 * 60 * 60_000;
let rootsOf: (() => string[]) | null = null;
let chain: Promise<void> = Promise.resolve();
let pending = false;

/** Off under SOVA_GIT_MAINTENANCE=off (the test runner, the hermetic dev server). */
export const gitMaintenanceOn = (env: NodeJS.ProcessEnv = process.env): boolean => env.SOVA_GIT_MAINTENANCE?.trim().toLowerCase() !== "off";

/** A sweep soon (a project added or re-rooted); one at a time, and one queued at most. A no-op before start or when off. */
export function requestGitMaintenanceSync(): void {
  if (!rootsOf || pending) return;
  pending = true;
  const roots = rootsOf;
  chain = chain
    .then(async () => {
      pending = false;
      await syncGitMaintenance(roots());
    })
    .catch((err) => console.warn(`[git-maintenance] sweep failed: ${err instanceof Error ? err.message : String(err)}`));
}

/** The server's start: a sweep now and every 6 hours over `roots` (every project on this host). */
export function startGitMaintenance(roots: () => string[]): void {
  if (!gitMaintenanceOn()) {
    console.log("[git-maintenance] off (SOVA_GIT_MAINTENANCE=off)");
    return;
  }
  rootsOf = roots;
  requestGitMaintenanceSync();
  setInterval(requestGitMaintenanceSync, GIT_MAINTENANCE_SWEEP_MS).unref();
}
