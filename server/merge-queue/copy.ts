/**
 * The merge copy: one git worktree per project, beside it at `<parent>/.worktrees/<repo>-merge`, detached at whatever
 * the run checks. Never under Sova's state root or `~/.pi` (the Oct 29 failure: a copy there inherited the state
 * root's settings and its tests read the live server's files). Reset at the start of every run: any merge in progress
 * aborted, the tree forced to the target's head, untracked files removed (ignored ones, the setup's outputs such as
 * node_modules, kept for its cache), the spec drafts folder emptied.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { NO_BACKGROUND_CLEANUP } from "../git-no-background";
import { stateRoot } from "../state-root";

/** The merge copy's folder for the project whose main checkout is `root`. */
export const mergeCopyPath = (root: string): string => join(dirname(root), ".worktrees", `${basename(root)}-merge`);

export class CopyRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopyRefused";
  }
}

/** `p` resolved through every symlink of its longest existing ancestor (a path not made yet still resolves). */
function real(p: string): string {
  let head = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...rest.reverse());
    } catch {
      const up = dirname(head);
      if (up === head) return join(head, ...rest.reverse());
      rest.push(basename(head));
      head = up;
    }
  }
}
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * Throws CopyRefused when `path` is under Sova's state root or `~/.pi` (each through its symlinks), or is the main
 * checkout itself. Every place that cuts or reuses a copy calls it first, before any git command.
 */
export function assertCopyOutsideState(path: string, opts: { root?: string; state?: string; home?: string } = {}): void {
  const p = real(path);
  const state = real(opts.state ?? stateRoot());
  const pi = real(join(opts.home ?? homedir(), ".pi"));
  if (inside(p, state)) throw new CopyRefused(`the merge copy ${path} would be under Sova's state root (${state}); copies live beside the project, never there`);
  if (inside(p, pi)) throw new CopyRefused(`the merge copy ${path} would be under ${pi}; copies live beside the project, never there`);
  if (opts.root && real(opts.root) === p) throw new CopyRefused(`the merge copy can't be the project's main checkout (${opts.root})`);
}

// ---- processes ------------------------------------------------------------------------------------

export interface Proc {
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
  ms: number;
  /** stdout + stderr, capped. */
  out: string;
}

const OUT_CAP = 256 * 1024;

/**
 * Run argv in its own process group, appending everything it prints to `log` (when given) as it comes, under a
 * timeout and the run's abort signal (each kills the whole group). Never throws: a program that can't start is
 * code 127 with the reason in `out`.
 */
export function runProc(
  argv: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs?: number; signal?: AbortSignal; log?: (chunk: string) => void; graceMs?: number },
): Promise<Proc> {
  const started = Date.now();
  return new Promise((done) => {
    let out = "";
    const take = (d: Buffer | string) => {
      const s = String(d);
      if (out.length < OUT_CAP) out += s.slice(0, OUT_CAP - out.length);
      opts.log?.(s);
    };
    if (opts.signal?.aborted) return done({ code: null, timedOut: false, aborted: true, ms: 0, out: "" });
    let child;
    try {
      child = spawn(argv[0]!, argv.slice(1), { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (err) {
      const why = `could not start ${argv[0]}: ${err instanceof Error ? err.message : String(err)}\n`;
      take(why);
      return done({ code: 127, timedOut: false, aborted: false, ms: Date.now() - started, out });
    }
    let timedOut = false;
    let aborted = false;
    // With graceMs, the group gets SIGTERM first and SIGKILL only if it is still there after it:
    // git removes its temp files (.merge_file_*, index locks) on SIGTERM, never on SIGKILL.
    let hard: ReturnType<typeof setTimeout> | null = null;
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, sig);
      } catch {
        /* gone */
      }
    };
    const kill = () => {
      if (!opts.graceMs) return signalGroup("SIGKILL");
      if (hard) return;
      signalGroup("SIGTERM");
      hard = setTimeout(() => signalGroup("SIGKILL"), opts.graceMs);
    };
    const timer = opts.timeoutMs ? setTimeout(() => ((timedOut = true), kill()), opts.timeoutMs) : null;
    const onAbort = () => ((aborted = true), kill());
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout!.on("data", take);
    child.stderr!.on("data", take);
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hard) clearTimeout(hard);
      opts.signal?.removeEventListener("abort", onAbort);
      done({ code, timedOut, aborted, ms: Date.now() - started, out });
    };
    child.on("error", (err) => {
      take(`could not start ${argv[0]}: ${err.message}\n`);
      finish(127);
    });
    child.on("close", (code, sig) => finish(code ?? (sig ? 128 : 1)));
  });
}

/** git with no fsmonitor and no pager, in `cwd`; the same contract as runProc, except that a time limit or an abort
    ends git with SIGTERM (SIGKILL 5 s later), so git cleans up its temp files in the work tree first. */
export const gitProc = (cwd: string, args: string[], opts: { env?: Record<string, string>; log?: (chunk: string) => void; signal?: AbortSignal; timeoutMs?: number } = {}) =>
  runProc(["git", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", ...args], { cwd, env: { ...gitEnv(), ...opts.env }, timeoutMs: opts.timeoutMs ?? 300_000, graceMs: 5_000, ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.log ? { log: opts.log } : {}) });

/** The server's environment minus whatever points git at another repository. */
export function gitEnv(): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|PREFIX)$/.test(k)) e[k] = v;
  e.GIT_TERMINAL_PROMPT = "0";
  // LFS files are never fetched as a side effect of a checkout or merge in the copy: the run's own LFS step fetches
  // them and checks they arrived (fillLfs), so a missing one fails there, saying which, never midway through a merge.
  e.GIT_LFS_SKIP_SMUDGE = "1";
  return e;
}

/** stdout of a git command that must succeed; throws its stderr's first line otherwise. */
export async function gitOut(cwd: string, args: string[], opts: { signal?: AbortSignal } = {}): Promise<string> {
  const r = await gitProc(cwd, args, opts);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed in ${cwd}: ${r.out.trim().split("\n")[0] || `exit ${r.code}`}`);
  return r.out.trim();
}

// ---- the copy -------------------------------------------------------------------------------------

/** The mark the queue leaves in its copy's own git dir: a worktree without it is never reset. */
async function markerFile(path: string): Promise<string> {
  return join(await gitOut(path, ["rev-parse", "--path-format=absolute", "--git-dir"]), "sova-merge-copy");
}
async function isOurCopy(path: string): Promise<boolean> {
  try {
    return existsSync(await markerFile(path));
  } catch {
    return false;
  }
}

/**
 * Make the copy exist and stand at `base`, clean: cut it (a detached worktree of `root`, marked as the queue's) when
 * missing, else check it is still the queue's own worktree of `root` and reset it. A folder there that is no worktree
 * of `root` is moved aside, never written into; one of the project's own worktrees there (a branch named "merge") is
 * refused, never reset. Every git command
 * and its output goes to `log`. Throws CopyRefused for a path under the state root, Error for git failing.
 */
export async function prepareCopy(o: { root: string; path: string; base: string; log: (s: string) => void; signal?: AbortSignal; state?: string; home?: string }): Promise<void> {
  assertCopyOutsideState(o.path, { root: o.root, ...(o.state ? { state: o.state } : {}), ...(o.home ? { home: o.home } : {}) });
  const step = async (cwd: string, args: string[]) => {
    o.log(`$ git ${args.join(" ")}\n`);
    const r = await gitProc(cwd, args, { log: o.log, ...(o.signal ? { signal: o.signal } : {}) });
    if (r.aborted) throw new Error("aborted");
    return r;
  };
  if (existsSync(o.path)) {
    const common = await gitProc(o.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const mine = await gitProc(o.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const top = await gitProc(o.path, ["rev-parse", "--show-toplevel"]);
    const worktree = common.code === 0 && mine.code === 0 && top.code === 0 && real(common.out.trim()) === real(mine.out.trim()) && real(top.out.trim()) === real(o.path);
    if (!worktree) {
      const aside = `${o.path}.not-a-copy-${Date.now()}`;
      o.log(`${o.path} isn't a worktree of ${o.root}: moved aside to ${aside}\n`);
      renameSync(o.path, aside);
    } else if (!(await isOurCopy(o.path))) {
      // One of the project's own worktrees (a branch named "merge" is cut at this very path): never reset it. A
      // DETACHED one is the queue's own cut that a stop left before its mark: marked now, and used.
      const branch = (await gitProc(o.path, ["symbolic-ref", "--quiet", "--short", "HEAD"])).out.trim();
      if (branch) throw new CopyRefused(`${o.path} is a worktree the queue didn't make (branch ${branch}); the queue never resets it. Move that worktree, then resume the queue`);
      o.log(`${o.path} is a detached worktree with no mark (a cut a stop interrupted): marking it as the queue's\n`);
      writeFileSync(await markerFile(o.path), `${o.root}\n`);
    }
  }
  if (!existsSync(o.path)) {
    mkdirSync(dirname(o.path), { recursive: true });
    // The cut runs to its end whatever the run's signal says: a cut stopped halfway leaves a locked half-worktree.
    const cut = () => gitProc(o.root, ["worktree", "add", "--detach", "--force", "--force", o.path, o.base], { log: o.log });
    o.log(`$ git worktree add --detach --force --force ${o.path} ${o.base}\n`);
    let r = await cut();
    if (r.code !== 0) {
      // A cut an earlier stop left registered (locked, folder missing or half made): drop exactly that record, then once more.
      o.log(`the cut failed; removing what an interrupted cut left at ${o.path} and trying once more\n`);
      await gitProc(o.root, ["worktree", "unlock", o.path], { log: o.log });
      await gitProc(o.root, ["worktree", "remove", "--force", "--force", "--", o.path], { log: o.log });
      rmSync(o.path, { recursive: true, force: true });
      r = await cut();
    }
    if (r.code !== 0) throw new Error(`cutting the merge copy at ${o.path} failed: ${r.out.trim().split("\n").pop() || `exit ${r.code}`}`);
    writeFileSync(await markerFile(o.path), `${o.root}\n`);
    if (o.signal?.aborted) throw new Error("aborted");
    return;
  }
  // A merge (or cherry-pick, rebase) a stopped run left in progress goes first; failure means none was.
  await step(o.path, ["merge", "--abort"]);
  const co = await step(o.path, ["checkout", "--detach", "--force", o.base]);
  if (co.code !== 0) throw new Error(`resetting the merge copy to ${o.base.slice(0, 12)} failed: ${co.out.trim().split("\n").pop() || `exit ${co.code}`}`);
  const reset = await step(o.path, ["reset", "--hard", o.base]);
  if (reset.code !== 0) throw new Error(`git reset --hard failed in the merge copy: ${reset.out.trim().split("\n").pop()}`);
  const clean = await step(o.path, ["clean", "-ffd"]);
  if (clean.code !== 0) throw new Error(`git clean failed in the merge copy: ${clean.out.trim().split("\n").pop()}`);
  // A previous run's spec drafts are never this one's: whatever isn't tracked there goes (ignored ones too); tracked
  // drafts (a project that commits them) stay as the target has them.
  if (existsSync(join(o.path, ".sova", "spec", "drafts"))) {
    const d = await step(o.path, ["clean", "-ffdx", "--", ".sova/spec/drafts"]);
    if (d.code !== 0) throw new Error(`git clean of the spec drafts failed in the merge copy: ${d.out.trim().split("\n").pop()}`);
  }
}

/** Put the copy at `commit` (attribution: the target alone, or back to the tip), keeping ignored files; its submodules
 *  and LFS files follow (fillModules). */
export async function moveCopy(o: { path: string; commit: string; log: (s: string) => void; signal?: AbortSignal }): Promise<void> {
  for (const args of [["checkout", "--detach", "--force", o.commit], ["clean", "-ffd"]]) {
    o.log(`$ git ${args.join(" ")}\n`);
    const r = await gitProc(o.path, args, { log: o.log, ...(o.signal ? { signal: o.signal } : {}) });
    if (r.aborted) throw new Error("aborted");
    if (r.code !== 0) throw new Error(`git ${args[0]} failed in the merge copy: ${r.out.trim().split("\n").pop()}`);
  }
  const has = await modulesOf(o.path, "HEAD");
  if (has.submodules) await fillSubmodules({ path: o.path, log: o.log, ...(o.signal ? { signal: o.signal } : {}) });
  if (has.lfs) await fillLfs({ path: o.path, log: o.log, ...(o.signal ? { signal: o.signal } : {}) });
}

// ---- submodules and LFS ---------------------------------------------------------------------------

/** What a tree needs beyond its own files: submodules (a `.gitmodules`) and Git LFS files (a `filter=lfs` line in a
 *  `.gitattributes`, the root's or a folder's). Read from git at `rev` in `repo` (no checkout needed). */
export async function modulesOf(repo: string, rev: string): Promise<{ submodules: boolean; lfs: boolean }> {
  const submodules = (await gitProc(repo, ["cat-file", "-e", `${rev}:.gitmodules`])).code === 0;
  const attrs = (await gitProc(repo, ["ls-tree", "-r", "-z", "--name-only", rev])).out.split("\0").filter((f) => f === ".gitattributes" || f.endsWith("/.gitattributes")).slice(0, 50);
  let lfs = false;
  for (const f of attrs) {
    const r = await gitProc(repo, ["cat-file", "blob", `${rev}:${f}`]);
    if (r.code === 0 && /\bfilter=lfs\b/.test(r.out)) {
      lfs = true;
      break;
    }
  }
  return { submodules, lfs };
}

let lfsInstalled: { at: number; ok: boolean } | null = null;
/**
 * What the merge queue's setup warns about (Settings → Merge Queue): the target's tree has submodules or LFS files
 * (each run checks them out from their own remotes), and whether git-lfs is missing here (asked at most every 10
 * minutes).
 */
export async function copyShapeOf(repo: string, rev: string): Promise<{ submodules: boolean; lfs: boolean; lfsMissing?: true }> {
  const has = await modulesOf(repo, rev);
  if (!has.lfs) return has;
  if (!lfsInstalled || Date.now() - lfsInstalled.at > 600_000) lfsInstalled = { at: Date.now(), ok: (await gitProc(repo, ["lfs", "version"], { timeoutMs: 30_000 })).code === 0 };
  return lfsInstalled.ok ? has : { ...has, lfsMissing: true };
}

/** Why a step that fills the copy failed: the machine's (a remote unreachable, a tool missing), never the branch's. */
export class ModulesFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModulesFailed";
  }
}

const lastLine = (s: string) => s.trim().split("\n").filter(Boolean).pop() ?? "";

/**
 * Every submodule checked out at the commit the copy's tree records, recursively, from its own remote: synced (a URL
 * the branch changed is followed), initialised, updated with --force (a submodule a previous run left elsewhere goes
 * back). Then no submodule may be uninitialised or at another commit. Throws ModulesFailed saying which.
 */
export async function fillSubmodules(o: { path: string; log: (s: string) => void; signal?: AbortSignal }): Promise<void> {
  const step = async (args: string[], timeoutMs = 600_000) => {
    o.log(`$ git ${args.join(" ")}\n`);
    const r = await gitProc(o.path, [...NO_BACKGROUND_CLEANUP, ...args], { log: o.log, timeoutMs, ...(o.signal ? { signal: o.signal } : {}) });
    if (r.aborted) throw new Error("aborted");
    return r;
  };
  const sync = await step(["submodule", "sync", "--recursive"]);
  if (sync.code !== 0) throw new ModulesFailed(`the submodules' remotes couldn't be read from .gitmodules: ${lastLine(sync.out)}`);
  const up = await step(["submodule", "update", "--init", "--recursive", "--force"]);
  if (up.code !== 0) throw new ModulesFailed(`the submodules couldn't be checked out${up.timedOut ? " (timed out)" : ""}: ${lastLine(up.out)}`);
  // What a previous run left inside a submodule (untracked files; ignored ones stay, as in the copy itself).
  const clean = await step(["submodule", "foreach", "--recursive", "--quiet", "git clean -ffd"], 120_000);
  if (clean.code !== 0) throw new ModulesFailed(`the submodules couldn't be cleaned: ${lastLine(clean.out)}`);
  const st = await step(["submodule", "status", "--recursive"], 120_000);
  const off = st.out.split("\n").filter((l) => /^[-+U]/.test(l)).map((l) => l.slice(1).trim().split(/\s+/)[1] ?? l.trim());
  if (st.code !== 0 || off.length) throw new ModulesFailed(`submodules not at the merged tree's commits: ${off.slice(0, 5).join(", ") || lastLine(st.out)}`);
  o.log(`submodules: ${st.out.split("\n").filter(Boolean).length} at the tree's commits\n`);
}

/**
 * The tree's Git LFS files fetched and checked out (`git lfs pull`), then checked: every LFS file must be there in
 * full, none left a pointer. Throws ModulesFailed when git-lfs isn't installed, the fetch fails, or a file is still a
 * pointer (naming it).
 */
export async function fillLfs(o: { path: string; log: (s: string) => void; signal?: AbortSignal }): Promise<void> {
  const step = async (args: string[], timeoutMs = 900_000) => {
    o.log(`$ git ${args.join(" ")}\n`);
    const r = await gitProc(o.path, [...NO_BACKGROUND_CLEANUP, ...args], { log: o.log, timeoutMs, ...(o.signal ? { signal: o.signal } : {}) });
    if (r.aborted) throw new Error("aborted");
    return r;
  };
  const v = await step(["lfs", "version"], 30_000);
  if (v.code !== 0) throw new ModulesFailed("this project uses Git LFS and git-lfs isn't installed on this computer: install it, then resume");
  // `git lfs pull` writes the files itself (fetch, then checkout), whatever the smudge setting.
  const pull = await step(["lfs", "pull"]);
  if (pull.code !== 0) throw new ModulesFailed(`the LFS files couldn't be fetched${pull.timedOut ? " (timed out)" : ""}: ${lastLine(pull.out)}`);
  const ls = await step(["lfs", "ls-files"], 120_000);
  if (ls.code !== 0) throw new ModulesFailed(`the LFS files couldn't be listed: ${lastLine(ls.out)}`);
  // "<oid> * <path>": in full; "<oid> - <path>": still a pointer.
  const lines = ls.out.split("\n").filter((l) => /^[0-9a-f]{6,}\s+[*-]\s/.test(l));
  const pointers = lines.filter((l) => /^[0-9a-f]{6,}\s+-\s/.test(l)).map((l) => l.replace(/^[0-9a-f]{6,}\s+-\s+/, ""));
  if (pointers.length) throw new ModulesFailed(`${pointers.length} LFS file${pointers.length === 1 ? " is" : "s are"} still a pointer after the fetch: ${pointers.slice(0, 5).join(", ")}${pointers.length > 5 ? ", …" : ""}`);
  o.log(`LFS: ${lines.length} file${lines.length === 1 ? "" : "s"} in full\n`);
}

/** Remove the copy (its worktree record too). For a project leaving the queue; never for a run. */
export async function dropCopy(root: string, path: string): Promise<void> {
  assertCopyOutsideState(path, { root });
  if (basename(path) !== `${basename(root)}-merge` || !(await isOurCopy(path))) return;
  await gitProc(root, ["worktree", "remove", "--force", "--force", "--", path]);
  rmSync(path, { recursive: true, force: true });
  // Whatever git couldn't remove is gone now: drop this one's record, never another worktree's.
  await gitProc(root, ["worktree", "remove", "--force", "--force", "--", path]);
}
