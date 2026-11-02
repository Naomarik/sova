/**
 * The merge copy: one git worktree per project, beside it at `<parent>/.worktrees/<repo>-merge`, detached at whatever
 * the run checks. Never under Sova's state root or `~/.pi` (the Oct 29 failure: a copy there inherited the state
 * root's settings and its tests read the live server's files). Reset at the start of every run: any merge in progress
 * aborted, the tree forced to the target's head, untracked files removed (ignored ones, the setup's outputs such as
 * node_modules, kept for its cache), the spec drafts folder emptied.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
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
  opts: { cwd: string; env: Record<string, string>; timeoutMs?: number; signal?: AbortSignal; log?: (chunk: string) => void },
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
    const kill = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* gone */
      }
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

/** git with no fsmonitor and no pager, in `cwd`; the same contract as runProc. */
export const gitProc = (cwd: string, args: string[], opts: { env?: Record<string, string>; log?: (chunk: string) => void; signal?: AbortSignal; timeoutMs?: number } = {}) =>
  runProc(["git", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", ...args], { cwd, env: { ...gitEnv(), ...opts.env }, timeoutMs: opts.timeoutMs ?? 300_000, ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.log ? { log: opts.log } : {}) });

/** The server's environment minus whatever points git at another repository. */
export function gitEnv(): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|PREFIX)$/.test(k)) e[k] = v;
  e.GIT_TERMINAL_PROMPT = "0";
  return e;
}

/** stdout of a git command that must succeed; throws its stderr's first line otherwise. */
export async function gitOut(cwd: string, args: string[], opts: { signal?: AbortSignal } = {}): Promise<string> {
  const r = await gitProc(cwd, args, opts);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed in ${cwd}: ${r.out.trim().split("\n")[0] || `exit ${r.code}`}`);
  return r.out.trim();
}

// ---- the copy -------------------------------------------------------------------------------------

/**
 * Make the copy exist and stand at `base`, clean: cut it (a detached worktree of `root`) when missing, else check it is
 * still one of `root`'s worktrees (one that isn't is moved aside, never written into) and reset it. Every git command
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
    const ok = common.code === 0 && mine.code === 0 && top.code === 0 && real(common.out.trim()) === real(mine.out.trim()) && real(top.out.trim()) === real(o.path);
    if (!ok) {
      const aside = `${o.path}.not-a-copy-${Date.now()}`;
      o.log(`${o.path} isn't a worktree of ${o.root}: moved aside to ${aside}\n`);
      renameSync(o.path, aside);
    }
  }
  if (!existsSync(o.path)) {
    mkdirSync(dirname(o.path), { recursive: true });
    const r = await step(o.root, ["worktree", "add", "--detach", "--force", o.path, o.base]);
    if (r.code !== 0) throw new Error(`cutting the merge copy at ${o.path} failed: ${r.out.trim().split("\n").pop() || `exit ${r.code}`}`);
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
  // Spec drafts are ignored files: a previous run's are never this one's.
  const drafts = join(o.path, ".sova", "spec", "drafts");
  if (existsSync(drafts)) {
    o.log(`removing ${drafts}\n`);
    rmSync(drafts, { recursive: true, force: true });
  }
}

/** Put the copy at `commit` (attribution: the target alone, or back to the tip), keeping ignored files. */
export async function moveCopy(o: { path: string; commit: string; log: (s: string) => void; signal?: AbortSignal }): Promise<void> {
  for (const args of [["checkout", "--detach", "--force", o.commit], ["clean", "-ffd"]]) {
    o.log(`$ git ${args.join(" ")}\n`);
    const r = await gitProc(o.path, args, { log: o.log, ...(o.signal ? { signal: o.signal } : {}) });
    if (r.aborted) throw new Error("aborted");
    if (r.code !== 0) throw new Error(`git ${args[0]} failed in the merge copy: ${r.out.trim().split("\n").pop()}`);
  }
}

/** Remove the copy (its worktree record too). For a project leaving the queue; never for a run. */
export async function dropCopy(root: string, path: string): Promise<void> {
  assertCopyOutsideState(path, { root });
  if (basename(path) !== `${basename(root)}-merge`) return;
  await gitProc(root, ["worktree", "remove", "--force", "--force", "--", path]);
  rmSync(path, { recursive: true, force: true });
  // Whatever git couldn't remove is gone now: drop this one's record, never another worktree's.
  await gitProc(root, ["worktree", "remove", "--force", "--force", "--", path]);
}
