// The saved-sessions branch's git plumbing (§chat.saved-sessions): one fixed orphan branch beside the
// code, written and read WITHOUT a checkout. Nothing here touches HEAD, the user's index or working
// tree: writes build a commit on a temporary index file (GIT_INDEX_FILE) with hash-object /
// update-index / write-tree / commit-tree, then move only refs/heads/<SAVED_BRANCH> with update-ref
// guarded by its old value; reads are ls-tree / cat-file on a commit. The only network verbs are a
// fetch of exactly that one ref and a fast-forward push of it with an explicit refspec (never --force).
//
// Every git runs through a `GitRun` (an argument list, optional stdin), so the same code drives a
// local repository (`localGit`) or one on a remote target (the caller's runner over runOnTarget).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { SAVED_SESSIONS_BRANCH, SAVED_SESSIONS_REF } from "../../shared/session-bundle";

const SAVED_BRANCH = SAVED_SESSIONS_BRANCH;
const SAVED_REF = SAVED_SESSIONS_REF;
/** How many attempts a push gets in all (3 retries on a newer remote tip) before giving up. */
export const PUSH_ATTEMPTS = 4;
/** How many times a save is planned again when another save in the same repository moved the branch first. */
const LOCAL_ATTEMPTS = 8;

export interface GitOut {
  code: number;
  stdout: string;
  stderr: string;
}
/** Run git with `args` (never a shell), optional stdin and extra environment. Never throws. `rm` deletes
    a scratch file this module made inside the repository's git dir (the temporary index), on the same
    machine git runs on. */
export type GitRun = ((args: string[], opts?: { input?: string; env?: Record<string, string> }) => Promise<GitOut>) & {
  rm?: (path: string) => Promise<void>;
};

/** A GitRun for the repository at `cwd` on this machine. */
export function localGit(cwd: string, timeoutMs = 120_000): GitRun {
  const run: GitRun = (args, opts = {}) =>
    new Promise((done) => {
      let child;
      try {
        child = spawn("git", args, {
          cwd,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no", ...opts.env },
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        done({ code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", (b: Buffer) => out.push(b));
      child.stderr.on("data", (b: Buffer) => err.push(b));
      child.on("error", (e) => {
        clearTimeout(timer);
        done({ code: 127, stdout: "", stderr: e.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input ?? "");
    });
  run.rm = async (path) => {
    rmSync(path, { force: true });
  };
  return run;
}

export class SavedGitError extends Error {}

async function must(git: GitRun, args: string[], opts?: Parameters<GitRun>[1]): Promise<string> {
  const r = await git(args, opts);
  if (r.code !== 0) throw new SavedGitError(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ") || `exit ${r.code}`}`);
  return r.stdout;
}

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
export const isOid = (s: string): boolean => OID.test(s);

/** The commit `ref` names, or null when it doesn't exist. */
export async function refSha(git: GitRun, ref: string): Promise<string | null> {
  const r = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && isOid(sha) ? sha : null;
}

/** The remote the saved branch goes to: the one its local branch tracks, else origin, else the only remote. */
export async function savedRemote(git: GitRun): Promise<string | null> {
  const tracked = await git(["config", "--get", `branch.${SAVED_BRANCH}.remote`]);
  if (tracked.code === 0 && tracked.stdout.trim()) return tracked.stdout.trim();
  const remotes = (await git(["remote"])).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (remotes.includes("origin")) return "origin";
  return remotes.length === 1 ? remotes[0]! : null;
}

/** The remote's URL (for the "may be public" warning, asked once per remote). */
export async function remoteUrl(git: GitRun, remote: string): Promise<string | null> {
  const r = await git(["remote", "get-url", "--", remote]);
  return r.code === 0 ? r.stdout.trim() || null : null;
}

export const trackingRef = (remote: string): string => `refs/remotes/${remote}/${SAVED_BRANCH}`;

export interface SavedTip {
  /** The commit read: the newer of the local branch and its remote-tracking ref. */
  sha: string;
  from: "local" | "remote";
  local: string | null;
  remote: string | null;
}

/**
 * Which copy of the saved branch to read: the remote-tracking ref when it is ahead of (or the only
 * one besides) the local branch, else the local branch. Diverged copies read the local one (it holds
 * this computer's own unpushed saves). Null when neither exists.
 */
export async function savedTip(git: GitRun, remote?: string | null): Promise<SavedTip | null> {
  const local = await refSha(git, SAVED_REF);
  const rname = remote === undefined ? await savedRemote(git) : remote;
  const far = rname ? await refSha(git, trackingRef(rname)) : null;
  if (!local && !far) return null;
  if (!local) return { sha: far!, from: "remote", local, remote: far };
  if (!far || far === local) return { sha: local, from: "local", local, remote: far };
  const localBehind = (await git(["merge-base", "--is-ancestor", local, far])).code === 0;
  return localBehind ? { sha: far, from: "remote", local, remote: far } : { sha: local, from: "local", local, remote: far };
}

/** One tree entry (ls-tree -r). */
export interface TreeFile {
  mode: string;
  type: string;
  oid: string;
  size: number;
  path: string;
}

/** Every file in `commit`'s tree, with sizes. */
export async function listTree(git: GitRun, commit: string): Promise<TreeFile[]> {
  const out = await must(git, ["ls-tree", "-r", "-l", "-z", "--full-tree", commit]);
  const files: TreeFile[] = [];
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    const [mode, type, oid, size] = rec.slice(0, tab).split(/\s+/);
    files.push({ mode: mode!, type: type!, oid: oid!, size: Number(size) || 0, path: rec.slice(tab + 1) });
  }
  return files;
}

/** The contents of several blobs at once (cat-file --batch), by oid; a missing blob is absent. */
export async function readBlobs(git: GitRun, oids: string[]): Promise<Map<string, string>> {
  const want = [...new Set(oids.filter(isOid))];
  const got = new Map<string, string>();
  if (!want.length) return got;
  const r = await git(["cat-file", "--batch"], { input: want.join("\n") + "\n" });
  if (r.code !== 0) return got;
  // The batch output is bytes; sizes are byte counts, so walk a Buffer.
  const buf = Buffer.from(r.stdout, "utf8");
  let at = 0;
  for (const oid of want) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) break;
    const head = buf.subarray(at, nl).toString("utf8").split(" ");
    at = nl + 1;
    if (head[1] === "missing") continue;
    const size = Number(head[2]);
    got.set(oid, buf.subarray(at, at + size).toString("utf8"));
    at += size + 1;
  }
  return got;
}

/** One blob as text, or null. */
export async function readPath(git: GitRun, commit: string, path: string): Promise<string | null> {
  const r = await git(["cat-file", "blob", `${commit}:${path}`]);
  return r.code === 0 ? r.stdout : null;
}

/** A change to the saved branch's tree: files to write (by path) and folders to delete. */
export interface TreeChange {
  write?: Record<string, string>;
  removeFolders?: string[];
}

/** The identity for commit-tree: the repository's own when it has one, else Sova's. */
async function identityEnv(git: GitRun): Promise<Record<string, string>> {
  const name = (await git(["config", "user.name"])).stdout.trim();
  const email = (await git(["config", "user.email"])).stdout.trim();
  const env: Record<string, string> = {};
  if (!name) Object.assign(env, { GIT_AUTHOR_NAME: "Sova", GIT_COMMITTER_NAME: "Sova" });
  if (!email) Object.assign(env, { GIT_AUTHOR_EMAIL: "sova@localhost", GIT_COMMITTER_EMAIL: "sova@localhost" });
  return env;
}

/** The repository's user.name (who saved it), or null. */
export async function userName(git: GitRun): Promise<string | null> {
  return (await git(["config", "user.name"])).stdout.trim() || null;
}

/**
 * Build a commit whose tree is `parent`'s (empty when null) with `change` applied, on a temporary
 * index file; returns the new commit's sha. No ref moves, and the user's index is never read.
 */
export async function commitChange(git: GitRun, parent: string | null, change: TreeChange, message: string): Promise<string> {
  // The scratch index lives in the repository's own git dir: on the machine git runs on, never in the
  // user's index, and gone when this returns.
  const gitDir = (await must(git, ["rev-parse", "--absolute-git-dir"])).trim();
  const index = `${gitDir}/sova-saved-index-${randomBytes(6).toString("hex")}`;
  const env = { GIT_INDEX_FILE: index };
  try {
    if (parent) await must(git, ["read-tree", parent], { env });
    else await must(git, ["read-tree", "--empty"], { env });
    for (const folder of change.removeFolders ?? []) {
      const clean = folder.replace(/\/+$/, "");
      if (!clean || clean.startsWith("/") || clean.split("/").includes("..")) throw new SavedGitError(`Not a folder in the saved branch: ${folder}`);
      await must(git, ["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", `${clean}/`], { env });
    }
    const writes = Object.entries(change.write ?? {});
    if (writes.length) {
      const lines: string[] = [];
      for (const [path, content] of writes) {
        if (!path || path.startsWith("/") || path.split("/").includes("..") || path.includes("\n")) throw new SavedGitError(`Not a path in the saved branch: ${path}`);
        const oid = (await must(git, ["hash-object", "-w", "--stdin"], { input: content })).trim();
        lines.push(`100644 ${oid}\t${path}`);
      }
      await must(git, ["update-index", "--add", "--index-info"], { env, input: lines.join("\n") + "\n" });
    }
    const tree = (await must(git, ["write-tree"], { env })).trim();
    const args = ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message];
    return (await must(git, args, { env: await identityEnv(git) })).trim();
  } finally {
    await git.rm?.(index);
    await git.rm?.(`${index}.lock`);
  }
}

/** Move the local saved branch from `old` (null: it must not exist yet) to `sha`. Refused when it moved meanwhile. */
export async function moveSavedRef(git: GitRun, sha: string, old: string | null, reason: string): Promise<void> {
  await must(git, ["update-ref", "-m", reason, SAVED_REF, sha, old ?? ""]);
}

/**
 * Fetch exactly the saved branch from `remote` into its remote-tracking ref. Returns that ref's sha,
 * or null when the remote has no saved branch yet. Throws on a failed fetch (offline, auth).
 */
export async function fetchSaved(git: GitRun, remote: string): Promise<string | null> {
  const r = await git(["fetch", "--no-tags", "--no-write-fetch-head", "--", remote, `+${SAVED_REF}:${trackingRef(remote)}`]);
  if (r.code !== 0) {
    const text = (r.stderr || r.stdout).trim();
    if (/couldn't find remote ref|no such ref/i.test(text)) {
      // The remote has none (or deleted it): our tracking copy says nothing about it anymore.
      await git(["update-ref", "-d", trackingRef(remote)]);
      return null;
    }
    throw new SavedGitError(`Couldn't get saved sessions from ${remote}: ${text.split("\n").slice(-2).join(" ") || `exit ${r.code}`}`);
  }
  return refSha(git, trackingRef(remote));
}

export type PushOutcome = { ok: true } | { ok: false; rejected: boolean; message: string };

/** Push `sha` to the remote's saved branch as a fast-forward (never forced). */
export async function pushSaved(git: GitRun, remote: string, sha: string): Promise<PushOutcome> {
  const r = await git(["push", "--porcelain", "--", remote, `${sha}:${SAVED_REF}`]);
  if (r.code === 0) {
    // Our remote-tracking copy is what the remote now holds.
    await git(["update-ref", trackingRef(remote), sha]);
    return { ok: true };
  }
  const text = `${r.stdout}\n${r.stderr}`;
  // Someone else's push won the race: a plain rejection, or (both creating the branch, or both updating it at
  // once) the remote's ref lock.
  const rejected = /\[rejected\]|non-fast-forward|fetch first|stale info|cannot lock ref|reference already exists|but expected|failed to update ref/i.test(text);
  return { ok: false, rejected, message: text.trim().split("\n").filter((l) => l && !l.startsWith("To ") && l !== "Done").slice(-2).join(" ") };
}

/** Whether the local saved branch is no longer at `old` (someone else's write landed in between). */
async function refMovedFrom(git: GitRun, old: string | null): Promise<boolean> {
  return (await refSha(git, SAVED_REF)) !== old;
}

async function isAncestor(git: GitRun, a: string, b: string): Promise<boolean> {
  return (await git(["merge-base", "--is-ancestor", a, b])).code === 0;
}

/** A merge commit of two diverged tips of the saved branch, built with merge-tree (no checkout, no index);
    null when they conflict. */
export async function joinTips(git: GitRun, local: string, far: string, remote: string): Promise<string | null> {
  // Two first saves made apart are two root commits: unrelated histories, still disjoint folders.
  const r = await git(["merge-tree", "--write-tree", "--no-messages", "--allow-unrelated-histories", local, far]);
  const tree = r.stdout.trim().split("\n")[0] ?? "";
  if (r.code !== 0 || !isOid(tree)) return null;
  return (await must(git, ["commit-tree", tree, "-p", local, "-p", far, "-m", `Merge saved sessions from ${remote}`], { env: await identityEnv(git) })).trim();
}

/** What a save sees of the tip it builds on: its sha (null: no branch yet) and a reader for it. */
export interface TipView {
  sha: string | null;
  read(path: string): Promise<string | null>;
}

/**
 * Apply one change to the saved branch and (optionally) push it, bounded and never forced.
 *
 * `plan(tip)` decides the change on the tip it is given; it may throw to stop (a rev conflict found on the
 * fetched tip). With `push`, the remote's ref is fetched first and the change is built on the newer of it and
 * the local branch; on a non-fast-forward rejection the remote is fetched again and the change re-planned on
 * its new tip, up to PUSH_ATTEMPTS attempts in all (3 retries). Without `push`, the change is built on the
 * newest copy this computer holds, and only the local branch moves. A fetch or push that fails leaves the
 * local commit in place and says why (`pushError`); only a failure to write locally throws.
 */
export async function applySaved<T>(
  git: GitRun,
  opts: { push: boolean; remote?: string | null; message: string; plan: (tip: TipView) => Promise<{ change: TreeChange; result: T; message?: string }> },
): Promise<{ sha: string | null; result: T; pushed: boolean; pushError?: string; remote: string | null }> {
  const remote = opts.remote === undefined ? await savedRemote(git) : opts.remote;
  let pushError: string | undefined = opts.push && !remote ? "This repository has no remote to push to." : undefined;
  let push = opts.push && !!remote;
  let pushes = 0;
  for (let attempt = 1; ; attempt++) {
    if (push) {
      try {
        await fetchSaved(git, remote!);
      } catch (err) {
        pushError = err instanceof Error ? err.message : String(err);
        push = false;
      }
    }
    const tip = await savedTip(git, remote);
    let base = tip?.sha ?? null;
    // This computer's unpushed saves and someone else's pushed ones: join the two tips first (folders are
    // disjoint per saved session, so the merge is clean unless both changed the same one).
    if (push && tip?.local && tip.remote && tip.local !== tip.remote && !(await isAncestor(git, tip.remote, tip.local)) && !(await isAncestor(git, tip.local, tip.remote))) {
      const joined = await joinTips(git, tip.local, tip.remote, remote!);
      if (!joined) {
        pushError = `Saved on this computer, but this computer's saved sessions and ${remote}'s changed the same saved session, so nothing was pushed.`;
        push = false;
        base = tip.local;
      } else base = joined;
    }
    const view: TipView = { sha: base, read: (p) => (base ? readPath(git, base, p) : Promise.resolve(null)) };
    const planned = await opts.plan(view);
    const { change, result } = planned;
    const message = planned.message ?? opts.message;
    // Nothing to change: no commit, nothing pushed.
    if (!Object.keys(change.write ?? {}).length && !(change.removeFolders ?? []).length) return { sha: null, result, pushed: false, remote, ...(pushError ? { pushError } : {}) };
    const sha = await commitChange(git, base, change, message);
    // The local branch follows from its own old value, so a concurrent local write (another save in this
    // repository at the same moment) is refused, not lost: then it is planned again on the new tip.
    // Building on the remote tip when the local branch is behind it is a fast-forward of the local branch too.
    try {
      await moveSavedRef(git, sha, tip?.local ?? null, message);
    } catch (err) {
      if (attempt >= LOCAL_ATTEMPTS || !(await refMovedFrom(git, tip?.local ?? null))) throw err;
      continue;
    }
    if (!push) return { sha, result, pushed: false, remote, ...(pushError ? { pushError } : {}) };
    const pushed = await pushSaved(git, remote!, sha);
    pushes++;
    if (pushed.ok) return { sha, result, pushed: true, remote };
    if (!pushed.rejected || pushes >= PUSH_ATTEMPTS)
      return { sha, result, pushed: false, remote, pushError: `Saved on this computer, but the push failed: ${pushed.message || "rejected"}` };
    // Someone pushed in between: put the local branch back where it was and rebuild on their tip.
    if (tip?.local) await moveSavedRef(git, tip.local, sha, "saved sessions: rebuild after a rejected push");
    else await git(["update-ref", "-d", SAVED_REF, sha]);
  }
}
