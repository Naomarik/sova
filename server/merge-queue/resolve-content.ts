/**
 * merge.resolve with `contents` and merge.test: what the merge thread can't do itself under its sandbox (it writes
 * nowhere but its own temp folder), done by Sova in the entry's scratch copy (scratch.ts): a detached worktree beside the
 * project, at the target's head. A commit there moves no branch: the target, the main checkout and every branch stay
 * where they were; merge.resolve then pins the commit under its hidden ref.
 */
import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { MergeCopyTest } from "../../shared/merge-queue";
import { NO_BACKGROUND_CLEANUP } from "../git-no-background";
import { type Proc, runProc } from "./copy";
import type { Git } from "./guard";
import { scratchMarkOf } from "./scratch";
import { inheritedEnv } from "../project-services/env-allow";

/** How much merged text one resolution may carry, in all. */
export const CONTENTS_MAX_BYTES = 4 * 1024 * 1024;
/** How many files one resolution may write. */
export const CONTENTS_MAX_FILES = 200;

export class ResolveRefused extends Error {}

const IDENT = { GIT_AUTHOR_NAME: "Sova merge queue", GIT_AUTHOR_EMAIL: "merge-queue@sova.invalid", GIT_COMMITTER_NAME: "Sova merge queue", GIT_COMMITTER_EMAIL: "merge-queue@sova.invalid" };

async function must(git: Git, args: string[], cwd: string, what: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const r = await git(args, cwd, env ? { env } : undefined);
  if (r.code !== 0) throw new ResolveRefused(`${what} failed: ${(r.stderr || r.stdout).trim().split("\n")[0] || `exit ${r.code}`}`);
  return r.stdout.trim();
}

/** A repository path the resolution may write: relative, inside the copy, never git's own. → its absolute path. */
export function contentPath(copy: string, path: string): string {
  if (!path || path.includes("\0") || isAbsolute(path) || path.split(/[\\/]/).some((p) => p === ".." || p === ".git")) throw new ResolveRefused(`"${path}" isn't a path inside the repository`);
  const abs = resolve(copy, path);
  const rel = relative(copy, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new ResolveRefused(`"${path}" leaves the scratch copy`);
  // A folder on the way that is a symlink could lead out of the copy.
  for (let dir = dirname(abs); dir.length > copy.length && dir.startsWith(copy); dir = dirname(dir)) {
    let link = false;
    try {
      link = lstatSync(dir).isSymbolicLink();
    } catch {
      /* not there yet: made below */
    }
    if (link) throw new ResolveRefused(`"${path}" goes through a symlink`);
  }
  let fileLink = false;
  try {
    fileLink = lstatSync(abs).isSymbolicLink();
  } catch {
    /* a new file */
  }
  if (fileLink) throw new ResolveRefused(`"${path}" is a symlink`);
  const real = realpathSync(copy);
  if (!resolve(real, rel).startsWith(real + sep)) throw new ResolveRefused(`"${path}" leaves the scratch copy`);
  return abs;
}

/** Write `text` at `path` inside `copy`, never through a symlink: the path is checked as it is now, each missing
 *  folder is made inside the copy's real path, and the file is opened with O_NOFOLLOW. */
export function writeInside(copy: string, path: string, text: string): void {
  const abs = contentPath(copy, path);
  const real = realpathSync(copy);
  const rel = relative(copy, abs);
  const parts = rel.split(sep);
  let dir = real;
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part);
    let st: ReturnType<typeof lstatSync> | null = null;
    try {
      st = lstatSync(dir);
    } catch {
      mkdirSync(dir);
      st = lstatSync(dir);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new ResolveRefused(`"${path}" goes through ${st.isSymbolicLink() ? "a symlink" : "a file"}`);
    if (!realpathSync(dir).startsWith(real + sep)) throw new ResolveRefused(`"${path}" leaves the scratch copy`);
  }
  const fd = openSync(join(dir, parts.at(-1)!), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/**
 * Merge `commit` (the approved one) onto `base` (the target's head the copy was made at) in the entry's scratch copy,
 * write `contents` there, and commit the merge. Refuses a folder that isn't the entry's scratch copy, a copy on a
 * branch, a path that leaves the copy, and any conflicted file left without content. Returns the commit.
 */
export async function commitResolution(git: Git, o: { copy: string; entry: string; base: string; commit: string; target: string; branch: string; contents: Record<string, string> }): Promise<string> {
  if (scratchMarkOf(o.copy)?.entry !== o.entry) throw new ResolveRefused(`there is no scratch copy of ${o.entry} at ${o.copy}`);
  const names = Object.keys(o.contents);
  if (!names.length) throw new ResolveRefused("contents names no file");
  if (names.length > CONTENTS_MAX_FILES) throw new ResolveRefused(`contents names ${names.length} files; at most ${CONTENTS_MAX_FILES}`);
  const bytes = names.reduce((n, k) => n + Buffer.byteLength(o.contents[k] ?? ""), 0);
  if (bytes > CONTENTS_MAX_BYTES) throw new ResolveRefused(`contents carries ${bytes} bytes; at most ${CONTENTS_MAX_BYTES}`);
  // The paths' shape now; every check on the folder runs again at each write, after the merge made the tree.
  for (const n of names) contentPath(o.copy, n);
  // The copy has no branch: a commit here moves none.
  if ((await git(["symbolic-ref", "-q", "HEAD"], o.copy)).code === 0) throw new ResolveRefused(`${o.copy} is on a branch; a scratch copy has none`);
  // From the target's head again, whatever was tried here before.
  await git(["merge", "--abort"], o.copy);
  await must(git, ["reset", "--quiet", "--hard", o.base], o.copy, "resetting the scratch copy");
  const merged = await git([...NO_BACKGROUND_CLEANUP, "merge", "--no-ff", "--no-commit", o.commit], o.copy, { env: { ...process.env, ...IDENT, GIT_TERMINAL_PROMPT: "0" } });
  if (merged.code !== 0 && !/conflict/i.test(merged.stdout + merged.stderr)) throw new ResolveRefused(`git merge failed: ${(merged.stderr || merged.stdout).trim().split("\n")[0]}`);
  // After the merge: the branch may have made a symlink on a path's way (a tracked link to a folder outside the copy),
  // so each path is checked again here, its folder made one level at a time, and the file opened without following one.
  for (const name of names) {
    try {
      writeInside(o.copy, name, o.contents[name]!);
    } catch (err) {
      await git(["merge", "--abort"], o.copy);
      throw err;
    }
  }
  await must(git, ["add", "--", ...names], o.copy, "git add");
  const left = (await must(git, ["diff", "--name-only", "--diff-filter=U"], o.copy, "listing conflicts")).split("\n").filter(Boolean);
  if (left.length) {
    await git(["merge", "--abort"], o.copy);
    throw new ResolveRefused(`still conflicted, with no content given: ${left.join(", ")}`);
  }
  const marker = (await must(git, ["diff", "--cached", "--name-only", "-G", "^(<<<<<<<|>>>>>>>) ", "--", ...names], o.copy, "checking for conflict markers")).split("\n").filter(Boolean);
  if (marker.length) {
    await git(["merge", "--abort"], o.copy);
    throw new ResolveRefused(`conflict markers are still in: ${marker.join(", ")}`);
  }
  await must(git, [...NO_BACKGROUND_CLEANUP, "commit", "--no-verify", "--quiet", "-m", `Merge ${o.branch} (${o.commit.slice(0, 7)}) into ${o.target}: the merge thread's resolution`], o.copy, "git commit", { ...process.env, ...IDENT, GIT_TERMINAL_PROMPT: "0" });
  return must(git, ["rev-parse", "HEAD"], o.copy, "reading the resolution");
}

/** merge.test: the project's merge install (when declared), then its test command with `select`, in the scratch copy. */
export async function testInCopy(o: {
  copy: string;
  entry: string;
  install?: string[] | null;
  test: string[];
  select?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  run?: (argv: string[], cwd: string, env: Record<string, string>, timeoutMs: number) => Promise<Proc>;
}): Promise<MergeCopyTest> {
  if (scratchMarkOf(o.copy)?.entry !== o.entry) throw new ResolveRefused(`there is no scratch copy of ${o.entry} at ${o.copy}`);
  const run = o.run ?? ((argv, cwd, env, timeoutMs) => runProc(argv, { cwd, env, timeoutMs }));
  // The queue's checks' environment (checks.ts envOf: the scrubbed inherited set plus the copy's own facts), never
  // the server's whole one.
  const env = { ...(o.env ?? inheritedEnv(process.env, [])), CI: "1" };
  const timeout = o.timeoutMs ?? 20 * 60_000;
  const tail = (out: string) => out.split("\n").filter((l) => l.trim()).slice(-40).join("\n");
  const started = Date.now();
  if (o.install?.length) {
    const i = await run(o.install, o.copy, env, 15 * 60_000);
    if (i.code !== 0) return { pass: false, step: "install", exit: i.code, ...(i.timedOut ? { timedOut: true } : {}), ms: Date.now() - started, copy: o.copy, tail: tail(i.out) };
  }
  const t = await run([...o.test, ...(o.select ?? [])], o.copy, env, timeout);
  return { pass: t.code === 0, step: "test", exit: t.code, ...(t.timedOut ? { timedOut: true } : {}), ms: Date.now() - started, copy: o.copy, tail: tail(t.out) };
}

