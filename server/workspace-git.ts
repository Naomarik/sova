import { execFile } from "node:child_process";
import { existsSync, lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OrgGitStatus } from "../shared/orgs";
import type { TourBackupFile, TourBackupInventory, TourBackupReader } from "./tours/bindings";
import { containedPath } from "./tours/assets";

/**
 * Git for an organization's workspace repo (§app.organizations/workspace-repo): init, commit (the
 * hourly committer in server/workspace-commits.ts, Commit Now, shutdown), push to the repo's own
 * `origin` when one is set. Every call is argv (no shell), bounded, non-interactive, and serialized
 * per repo, so two commits never race on the index. A failure is recorded as the repo's last error
 * and never thrown at the caller.
 */

const TIMEOUT_MS = 30_000;
/** Read by the workspace repo's own .gitignore: temp files of the atomic writers, nothing else. */
const GITIGNORE = "# Written by Sova. Link tokens, credentials and Sova's settings never live in this repo.\n*.tmp\n*.lock\n";

/** Automated commits must never block on a signing prompt or a hook asking for input. */
const NON_INTERACTIVE = ["-c", "commit.gpgsign=false", "-c", "core.editor=true"];

function git(dir: string, args: string[], extraEnv: Record<string, string> = {}, timeout = TIMEOUT_MS, maxBuffer = 4 * 1024 * 1024): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...NON_INTERACTIVE, "-C", dir, ...args],
      { timeout, maxBuffer, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...extraEnv } },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stderr ? err.message : "")) });
      },
    );
  });
}

const queues = new Map<string, Promise<unknown>>();
const lastErrors = new Map<string, string | null>();

/** Run `job` after every earlier job of the same repo. */
function serial<T>(dir: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(dir) ?? Promise.resolve();
  const next = prev.then(job, job);
  queues.set(
    dir,
    next.catch(() => {}),
  );
  return next;
}

/** A new repo with Sova's .gitignore (kept when the dir already has one). */
export async function initRepo(dir: string): Promise<void> {
  const r = await git(dir, ["init", "-q", "-b", "main"]);
  if (r.code !== 0) throw new Error(`git init failed: ${r.stderr.trim()}`);
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, GITIGNORE);
}

export const isRepo = async (dir: string): Promise<boolean> => (await git(dir, ["rev-parse", "--is-inside-work-tree"])).stdout.trim() === "true";

/** The repo's `origin` URL, or null. */
export async function remoteOf(dir: string): Promise<string | null> {
  const r = await git(dir, ["remote", "get-url", "origin"]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** Set (or with "" remove) the repo's `origin`. */
/**
 * A file as the repo's `origin` has it on the checked-out branch, fetched now (within `timeoutMs`);
 * null with no remote, an unreachable one, or no such file there.
 */
export async function remoteFileText(dir: string, file: string, timeoutMs: number): Promise<string | null> {
  if (!(await remoteOf(dir))) return null;
  const branch = await git(dir, ["symbolic-ref", "-q", "--short", "HEAD"]);
  if (branch.code !== 0 || !branch.stdout.trim()) return null;
  const fetched = await git(dir, ["fetch", "-q", "origin"], {}, timeoutMs);
  if (fetched.code !== 0) return null;
  const shown = await git(dir, ["show", `refs/remotes/origin/${branch.stdout.trim()}:${file}`]);
  return shown.code === 0 ? shown.stdout : null;
}

export function setRemote(dir: string, url: string): Promise<void> {
  return serial(dir, async () => {
    const had = await remoteOf(dir);
    if (!url) {
      if (had) await git(dir, ["remote", "remove", "origin"]);
      return;
    }
    const r = await git(dir, had ? ["remote", "set-url", "origin", url] : ["remote", "add", "origin", url]);
    if (r.code !== 0) throw new Error(`git remote failed: ${r.stderr.trim()}`);
    // Another remote: what the old one had says nothing about it, so Commit Now pushes everything.
    if (had && had !== url) {
      const refs = await git(dir, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin/"]);
      for (const ref of refs.stdout.split("\n").filter(Boolean)) await git(dir, ["update-ref", "-d", ref]);
    }
  });
}

/** Every commit Sova makes here is Sova's: the host's own git identity (an operator's name and
    email) never travels with the org's backup. Author and committer both. */
const SOVA_IDENTITY: Record<string, string> = { GIT_AUTHOR_NAME: "Sova", GIT_AUTHOR_EMAIL: "sova@localhost", GIT_COMMITTER_NAME: "Sova", GIT_COMMITTER_EMAIL: "sova@localhost" };

export interface CommitOutcome {
  committed: boolean;
  sha?: string;
  pushed?: boolean;
  error?: string;
}

/**
 * Stage everything and commit with `message` when anything changed, then push to `origin` if set.
 * Nothing to commit is not an error. Never throws: the outcome says what happened.
 */
export function commitAll(dir: string, message: string, dependencies: { readTourConversation?: TourBackupReader } = {}): Promise<CommitOutcome> {
  return serial(dir, async () => {
    const out: CommitOutcome = { committed: false };
    try {
      const { tourBackupInventory, TOUR_BACKUP_WARNING } = await import("./tours/bindings");
      let tours: TourBackupInventory;
      try { tours = await tourBackupInventory(dir, dependencies.readTourConversation); }
      catch { throw new Error(TOUR_BACKUP_WARNING); }
      const allowed = new Set([...tours.files.map(file => file.path), ...tours.detached]);
      const trackedTours = await git(dir, ["ls-files", "-z", "--", "tours"]);
      if (trackedTours.code !== 0) throw new Error(TOUR_BACKUP_WARNING);
      const unknown = trackedTours.stdout.split("\0").filter(path => path && !allowed.has(path));
      if (unknown.length) {
        let removed: { paths: string[]; conversations: string[] };
        try { removed = await removedTourInventory(dir, unknown, dependencies.readTourConversation); }
        catch { throw new Error(TOUR_BACKUP_WARNING); }
        tours.detached = [...new Set([...tours.detached, ...removed.paths])];
        tours.removedConversations = removed.conversations;
        if (unknown.some(path => !removed.paths.includes(path))) throw new Error(TOUR_BACKUP_WARNING);
      }
      // No `tours` pathspec here, not even an exclude one: git refuses a pathspec naming an ignored
      // path, so an operator's ignore rule for tours/ would fail every backup.
      const add = await git(dir, ["add", "-A"]);
      if (add.code !== 0) throw new Error(`git add failed: ${add.stderr.trim()}`);
      // Generated tour artifacts are reserved: only validated current conversation inventory travels.
      // Anything under tours/ that add just picked up (an unbound/private sibling whose ignore rule was
      // removed) leaves the index again, by exact file path, never by directory.
      const tracked = new Set(trackedTours.stdout.split("\0").filter(Boolean)), current = new Set(tours.files.map(file => file.path));
      const indexed = await git(dir, ["ls-files", "-z", "--", "tours"]);
      if (indexed.code !== 0) throw new Error(TOUR_BACKUP_WARNING);
      const picked = indexed.stdout.split("\0").filter(path => path && !tracked.has(path) && !current.has(path));
      const unstage = [...new Set([...tours.detached, ...picked])];
      for (let offset = 0; offset < unstage.length; offset += 100) {
        const remove = await git(dir, ["rm", "--cached", "--force", "--ignore-unmatch", "--", ...unstage.slice(offset, offset + 100).map(path => `:(literal)${path}`)]);
        if (remove.code !== 0) throw new Error(TOUR_BACKUP_WARNING);
      }
      // Exact argv paths, never a directory or glob. The rest of the index is left alone.
      for (let offset = 0; offset < tours.files.length; offset += 100) {
        const forced = await git(dir, ["add", "--force", "--", ...tours.files.slice(offset, offset + 100).map(file => `:(literal)${file.path}`)]);
        if (forced.code !== 0) throw new Error(TOUR_BACKUP_WARNING);
      }
      // The reserved namespace now holds exactly the validated inventory: nothing more, nothing less.
      const reserved = await git(dir, ["ls-files", "-z", "--", "tours"]), stagedTours = reserved.stdout.split("\0").filter(Boolean);
      if (reserved.code !== 0 || stagedTours.length !== current.size || stagedTours.some(path => !current.has(path))) throw new Error(TOUR_BACKUP_WARNING);
      const format = (await git(dir, ["rev-parse", "--show-object-format"])).stdout.trim();
      if (format !== "sha1" && format !== "sha256") throw new Error(TOUR_BACKUP_WARNING);
      // Detect a transcript edited while inventory was being read/staged before making a backup.
      if (!(await verifyTourBackup(dir, tours, format, true))) throw new Error(TOUR_BACKUP_WARNING);
      const staged = await git(dir, ["diff", "--cached", "--quiet"]);
      if (staged.code === 0) {
        // Nothing new, but the remote may lack commits (one just set, or commits made without it):
        // push them. Only Commit Now gets here; the committer calls this only with changes.
        if ((await remoteOf(dir)) && (await unpushed(dir))) {
          const push = await git(dir, ["push", "-q", "origin", "HEAD"]);
          if (push.code !== 0) throw new Error(`git push failed: ${push.stderr.trim()}`);
          out.pushed = true;
        }
        if (!(await verifyTourBackup(dir, tours, format, false))) throw new Error(TOUR_BACKUP_WARNING);
        lastErrors.set(dir, null);
        return out;
      }
      const commit = await git(dir, ["commit", "-q", "--no-verify", "-m", message], SOVA_IDENTITY);
      if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr.trim()}`);
      out.committed = true;
      out.sha = (await git(dir, ["rev-parse", "--short", "HEAD"])).stdout.trim();
      if (!(await verifyTourBackup(dir, tours, format, false))) throw new Error(TOUR_BACKUP_WARNING);
      if (await remoteOf(dir)) {
        const push = await git(dir, ["push", "-q", "origin", "HEAD"]);
        if (push.code !== 0) throw new Error(`git push failed: ${push.stderr.trim()}`);
        out.pushed = true;
      }
      lastErrors.set(dir, null);
    } catch (err) {
      out.error = err instanceof Error ? err.message : String(err);
      lastErrors.set(dir, out.error);
      console.warn(`[workspace] ${out.error}`);
    }
    return out;
  });
}

/** Recover only exact committed attachment inventories whose working conversation is confirmed gone.
 * Unknown files, unsafe paths and existing conversations never authorize pruning. */
async function removedTourInventory(dir: string, unknown: readonly string[], reader?: TourBackupReader): Promise<{ paths: string[]; conversations: string[] }> {
  const { TOUR_BACKUP_WARNING, tourAttachmentPaths } = await import("./tours/bindings");
  const { isTourSession } = await import("./tours/store");
  const { readStoredConversation } = await import("./share/hub");
  const ids = new Set(unknown.map(path => path.split("/")[1]).filter((id): id is string => !!id && isTourSession(id)));
  const paths = new Set<string>(), conversations = new Set<string>();
  const tree = await git(dir, ["ls-tree", "-r", "-z", "HEAD", "--", "sessions"]);
  if (tree.code !== 0) throw new Error(TOUR_BACKUP_WARNING);
  for (const record of tree.stdout.split("\0").filter(Boolean)) {
    const [metadata, path] = record.split("\t"), [mode, type, oid] = metadata?.split(" ") ?? [];
    if (!path?.startsWith("sessions/") || !["100644", "100755"].includes(mode ?? "") || type !== "blob" || !oid || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) continue;
    const name = path.slice("sessions/".length);
    if (name.includes("/") || !name.endsWith(".jsonl")) continue;
    const id = [...ids].find(id => name === `${id}.jsonl` || name.endsWith(`_${id}.jsonl`));
    if (!id) continue;
    const file = containedPath(dir, join(dir, path), true);
    try { lstatSync(file); continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(TOUR_BACKUP_WARNING); }
    // The object must come from this exact audited HEAD sessions path; cap before materializing it.
    const size = await git(dir, ["cat-file", "-s", oid]), bytes = Number(size.stdout.trim());
    if (size.code !== 0 || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 128 * 1024 * 1024) throw new Error(TOUR_BACKUP_WARNING);
    const blob = await git(dir, ["cat-file", "blob", oid], {}, TIMEOUT_MS, bytes + 1024);
    if (blob.code !== 0 || Buffer.byteLength(blob.stdout) !== bytes) throw new Error(TOUR_BACKUP_WARNING);
    const conversation = await (reader ?? readStoredConversation)({ text: blob.stdout });
    if (conversation.id !== id) throw new Error(TOUR_BACKUP_WARNING);
    const inventory = tourAttachmentPaths(id, conversation.branch);
    if (!inventory.length) continue;
    for (const path of inventory) paths.add(path);
    conversations.add(path);
  }
  return { paths: [...paths], conversations: [...conversations] };
}

/** Verify the committed tree, not the working tree or a claim that git add succeeded. */
async function verifyTourBackup(dir: string, inventory: TourBackupInventory, format: "sha1" | "sha256", index: boolean): Promise<boolean> {
  const files: TourBackupFile[] = [...inventory.files, ...inventory.conversations];
  for (let offset = 0; offset < files.length; offset += 100) {
    const batch = files.slice(offset, offset + 100), paths = batch.map(file => `:(literal)${file.path}`);
    const result = index ? await git(dir, ["ls-files", "--stage", "-z", "--", ...paths]) : await git(dir, ["ls-tree", "-z", "HEAD", "--", ...paths]);
    if (result.code !== 0) return false;
    const records = new Map(result.stdout.split("\0").filter(Boolean).map(record => { const [metadata, path] = record.split("\t"); return [path, metadata?.split(" ")] as const; }));
    if (records.size !== batch.length) return false;
    for (const file of batch) {
      const parts = records.get(file.path);
      if (parts?.[0] !== "100644" || (index ? parts?.[1] : parts?.[2]) !== file[format] || (index && parts?.[2] !== "0")) return false;
    }
  }
  const absent = [...inventory.detached, ...inventory.removedConversations];
  for (let offset = 0; offset < absent.length; offset += 100) {
    const paths = absent.slice(offset, offset + 100).map(path => `:(literal)${path}`);
    const result = index ? await git(dir, ["ls-files", "-z", "--", ...paths]) : await git(dir, ["ls-tree", "-z", "HEAD", "--", ...paths]);
    if (result.code !== 0 || result.stdout) return false;
  }
  return true;
}

/** Whether the repo's index tracks anything under `path` (false outside a repo). */
export async function tracks(dir: string, path: string): Promise<boolean> {
  const r = await git(dir, ["ls-files", "--", path]);
  return r.code === 0 && r.stdout.trim() !== "";
}

/** Stage `paths` (additions and deletions) and commit only them with `message`; no push. Throws on a failure. */
export function commitPaths(dir: string, paths: string[], message: string): Promise<void> {
  return serial(dir, async () => {
    const add = await git(dir, ["add", "-A", "--", ...paths]);
    if (add.code !== 0) throw new Error(`git add failed: ${add.stderr.trim()}`);
    if ((await git(dir, ["diff", "--cached", "--quiet", "--", ...paths])).code === 0) return;
    const commit = await git(dir, ["commit", "-q", "--no-verify", "-m", message, "--", ...paths], SOVA_IDENTITY);
    if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr.trim()}`);
  });
}

/** Whether HEAD has commits `origin` lacks, going by the remote-tracking branch (no network):
    none known for this branch counts as all of them. False without a commit or on a detached HEAD. */
async function unpushed(dir: string): Promise<boolean> {
  const branch = await git(dir, ["symbolic-ref", "-q", "--short", "HEAD"]);
  if (branch.code !== 0 || (await git(dir, ["rev-parse", "-q", "--verify", "HEAD"])).code !== 0) return false;
  const ref = `refs/remotes/origin/${branch.stdout.trim()}`;
  if ((await git(dir, ["rev-parse", "-q", "--verify", ref])).code !== 0) return true;
  const ahead = await git(dir, ["rev-list", "--count", `${ref}..HEAD`]);
  return ahead.code === 0 && Number(ahead.stdout.trim()) > 0;
}

const untrackedTourArtifact = (field: string): boolean => field === "?? tours" || field.startsWith("?? tours/");

/** Pending portable paths; retained untracked generated snapshots are not backup changes. */
export async function changedPaths(dir: string): Promise<string[]> {
  const r = await git(dir, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  if (r.code !== 0) return [];
  // -z: "XY path\0", a rename adds its source as the next field; keep the destinations.
  const out: string[] = [];
  const fields = r.stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.length < 4 || untrackedTourArtifact(f)) continue;
    out.push(f.slice(3));
    if (f[0] === "R" || f[0] === "C") i++;
  }
  return out;
}

/** When HEAD was committed (ms), or null when the repo has no commit yet. */
export async function headCommitMs(dir: string): Promise<number | null> {
  const r = await git(dir, ["log", "-1", "--format=%ct"]);
  const s = Number(r.stdout.trim());
  return r.code === 0 && Number.isFinite(s) && s > 0 ? s * 1000 : null;
}

/** Push HEAD to `origin` again after a failed push, when nothing new was committed since. */
export function retryPush(dir: string): Promise<CommitOutcome> {
  return serial(dir, async () => {
    const out: CommitOutcome = { committed: false };
    if (!lastErrors.get(dir)?.startsWith("git push failed") || !(await remoteOf(dir))) return out;
    const push = await git(dir, ["push", "-q", "origin", "HEAD"]);
    if (push.code !== 0) {
      out.error = `git push failed: ${push.stderr.trim()}`;
      lastErrors.set(dir, out.error);
      return out;
    }
    out.pushed = true;
    lastErrors.set(dir, null);
    return out;
  });
}

/** Everything the org page shows about the repo's git state. */
export async function gitStatus(dir: string): Promise<OrgGitStatus> {
  const [remote, log, porcelain] = await Promise.all([
    remoteOf(dir),
    git(dir, ["log", "-1", "--format=%h%x00%cI%x00%s"]),
    git(dir, ["status", "--porcelain", "-z", "--untracked-files=all"]),
  ]);
  const [sha, at, message] = log.code === 0 ? log.stdout.trim().split("\0") : [];
  return {
    remote,
    lastCommit: sha && at ? { sha, at, message: message ?? "" } : null,
    lastError: lastErrors.get(dir) ?? null,
    dirty: porcelain.code === 0 && porcelain.stdout.split("\0").some(field => field.length > 0 && !untrackedTourArtifact(field)),
  };
}

/** Whether `dir` is ignored by the git repo at `repo` (for the "never inside Sova" rule). */
export async function isIgnoredBy(repo: string, dir: string): Promise<boolean> {
  return (await git(repo, ["check-ignore", "-q", "--no-index", dir])).code === 0;
}

/** Whether `dir` is inside a git work tree (a Sova install may be a plain copy, not a checkout). */
export async function isInGitWorkTree(dir: string): Promise<boolean> {
  const r = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout.trim() === "true";
}

/** Wait for every queued job of `dir` (tests). */
export const settled = (dir: string): Promise<unknown> => queues.get(dir) ?? Promise.resolve();
