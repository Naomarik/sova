// A chat's code, carried exactly (§app.transport/package, §app.transport/arrival,
// §app.transport/edge-cases): per worktree, a snapshot of HEAD, then the index, then the working
// tree, as two commits on top of HEAD, made in a scratch object store that borrows the source's
// objects (no ref, index or file of the source changes); one bundle for every worktree; one tar of
// the files git doesn't hold (untracked files, scratch folders, the ticked private files). Rebuilt on
// the destination in a staging worktree, checked by the tracked status and every carried file's
// hash, and moved into place only at publish. Dependencies and build output are never carried.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, readdirSync } from "node:fs";
import { copyFile, cp, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { NO_BACKGROUND_CLEANUP } from "../git-no-background";
import { checkMembers, entryOf, listTar, type TarEntry, writeTar } from "./tar";

// ---- git ------------------------------------------------------------------------------------------

export interface Git {
  code: number | null;
  stdout: string;
  stderr: string;
}

const GIT_LONG_MS = 300_000;
const GIT_BUFFER = 256 * 1024 * 1024;
/** The identity and date of a snapshot commit: fixed, so the same state packs to the same bytes. */
const SNAP_ENV = {
  GIT_AUTHOR_NAME: "sova",
  GIT_AUTHOR_EMAIL: "sova@local",
  GIT_COMMITTER_NAME: "sova",
  GIT_COMMITTER_EMAIL: "sova@local",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

function gitEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR"]) delete env[k];
  return { ...env, ...extra };
}

/** git with `args` in `cwd`; never throws. `input` is fed on stdin. */
export function git(cwd: string, args: readonly string[], o: { env?: Record<string, string>; input?: string } = {}): Promise<Git> {
  return new Promise((done) => {
    const child = execFile(
      "git",
      // Submodules are built one by one here: git never recurses into them by itself (a fetch on demand from their
      // remotes, a read-tree into them under a user's submodule.recurse).
      ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "submodule.recurse=false", "-c", "fetch.recurseSubmodules=false", ...args],
      { cwd, env: gitEnv(o.env ?? {}), timeout: GIT_LONG_MS, killSignal: "SIGKILL", maxBuffer: GIT_BUFFER, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (!err) return done({ code: 0, stdout, stderr });
        const e = err as NodeJS.ErrnoException & { code?: unknown; killed?: boolean };
        done({ code: typeof e.code === "number" && !e.killed ? e.code : null, stdout: stdout ?? "", stderr: stderr || (e.killed ? "git timed out" : String(e.message)) });
      },
    );
    if (o.input !== undefined) child.stdin?.end(o.input);
  });
}

// ---- whether the destination gets the project from its remote, or from the source ---------------------

/** A remote URL without the credentials it may carry (`https://user:token@host/…` → `https://host/…`; an ssh URL
    keeps its user, never a password). Pure. */
export const withoutCredentials = (u: string): string =>
  u.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)([^@/]*)@/i, (_m, scheme: string, who: string) => (/^ssh/i.test(scheme) && who && !who.includes(":") ? `${scheme}${who}@` : scheme));

/** How long `remoteReachable` waits for a remote: inside the source's 10 s wait for the needs answer. */
export const REACH_MS = 6_000;

/**
 * Whether this device can read `url` now, without asking anyone: `git ls-remote` with no prompt (no terminal,
 * askpass or credential window; ssh in batch mode), stopped after `ms`. Only plain transports: a URL that runs a
 * command (`ext::`, `fd::`) or reads as an option is never tried; a local folder is. The URL is never logged.
 */
export function remoteReachable(url: string, ms = REACH_MS): Promise<boolean> {
  const u = url.trim();
  if (!plainRemote(u)) return Promise.resolve(false);
  return new Promise((done) => {
    execFile("git", [...PROMPT_FREE_ARGS, "ls-remote", u, "HEAD"], { cwd: "/", env: gitEnv(PROMPT_FREE), timeout: ms, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (err) => done(!err));
  });
}

/** A URL git may be asked to read: never one that runs a command (`ext::`, `fd::`) or reads as an option. */
const plainRemote = (u: string): boolean => !!u && !u.startsWith("-") && !/^[a-z0-9+.-]+::/i.test(u);

/** Asking for nothing: no terminal, askpass or credential window; ssh in batch mode. */
const PROMPT_FREE: Record<string, string> = {
  GIT_ASKPASS: "true",
  SSH_ASKPASS: "true",
  SSH_ASKPASS_REQUIRE: "never",
  GCM_INTERACTIVE: "never",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=5",
};
const PROMPT_FREE_ARGS = ["-c", "protocol.ext.allow=never", "-c", "credential.interactive=never"];

/**
 * A submodule's address as `git submodule init` resolves it (git's `relative_url`): a `./` or `../` URL is taken
 * against `base`, the address of the repository holding it (its recorded remote), each `../` dropping one part of
 * that address (a `/` part, else an scp-like `host:` part). Never with credentials. "" when a relative URL has no
 * address to resolve against (git would use this device's own folder, which means nothing on another device).
 * Pure.
 */
export function resolveSubmoduleUrl(url: string, base: string | null): string {
  const u = url.trim();
  if (!u) return "";
  if (!u.startsWith("./") && !u.startsWith("../")) return withoutCredentials(u);
  let at = base ? withoutCredentials(base).replace(/\/+$/, "") : "";
  // A relative base (a folder path relative to this device) resolves nowhere there.
  if (!at || (!/^[a-z][a-z0-9+.-]*:\/\//i.test(at) && !at.startsWith("/") && !/^[^/]+:/.test(at))) return "";
  let rest = u;
  let colon = false;
  for (;;) {
    if (rest.startsWith("../")) {
      rest = rest.slice(3);
      const slash = at.lastIndexOf("/");
      const scp = at.lastIndexOf(":");
      if (slash >= 0) at = at.slice(0, slash);
      else if (scp >= 0) {
        at = at.slice(0, scp);
        colon = true;
      } else return "";
    } else if (rest.startsWith("./")) rest = rest.slice(2);
    else break;
  }
  return `${at}${colon ? ":" : "/"}${rest}`;
}

/** Whether `folder` lacks a repository: it isn't there, or is an empty folder. */
export function lacksRepo(folder: string): boolean {
  try {
    if (!lstatSync(folder).isDirectory()) return false;
  } catch {
    return true;
  }
  return readdirSync(folder).length === 0;
}

/** Where the project comes from for a folder there: it is `there`, its remote can `clone` it, or it comes `from-source`
    (no remote recorded, or none reachable from there). */
export async function projectComesFrom(folder: string, remotes: readonly string[], reachable: (url: string) => Promise<boolean> = remoteReachable): Promise<"there" | "clone" | "from-source"> {
  if (!lacksRepo(folder)) return "there";
  // Each recorded remote at once, so the answer comes within one wait.
  const any = await Promise.all(remotes.slice(0, 4).map((r) => reachable(withoutCredentials(r)).catch(() => false)));
  return any.some(Boolean) ? "clone" : "from-source";
}

export class SnapshotError extends Error {
  constructor(
    readonly reason: "refused" | "needs-base" | "mismatch" | "taken" | "git",
    message: string,
  ) {
    super(message);
    this.name = "SnapshotError";
  }
}

async function ok(cwd: string, args: readonly string[], what: string, o: { env?: Record<string, string>; input?: string } = {}): Promise<string> {
  const r = await git(cwd, args, o);
  if (r.code !== 0) throw new SnapshotError("git", `${what}: ${r.stderr.split("\n").find((l) => l.trim())?.trim() ?? `exit ${r.code}`}`);
  return r.stdout;
}

const nul = (s: string) => s.split("\0").filter(Boolean);
const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

async function fileSha(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const c of createReadStream(path)) h.update(c as Buffer);
  return h.digest("hex");
}

// ---- what travels and what stays ----------------------------------------------------------------

/** Dependency and build-output folders: rebuilt there, never sent. `.cache` is not one of them:
    agents keep scratch work there, so it travels as a scratch folder. */
const LEFT_DIRS = new Set([
  "node_modules", "dist", "build", "out", "target", "coverage", ".turbo", ".vite", ".next", ".nuxt", ".svelte-kit",
  ".parcel-cache", ".cpcache", ".shadow-cljs", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".gradle",
]);
export const leftDir = (name: string): boolean => LEFT_DIRS.has(name) || /^dist-[^/]+$/.test(name);
const leftFile = (name: string): boolean => name === ".DS_Store" || name.endsWith(".tsbuildinfo") || name.endsWith(".pyc");
/** A dependency or build folder, or a link named as one (a worktree's node_modules linking to the main checkout's):
    git names a link with no trailing `/`, so it is told apart from a file by what it is, never offered as one. */
const leftEntry = (name: string, st: { isDirectory(): boolean; isSymbolicLink(): boolean }): boolean => leftDir(name) && (st.isDirectory() || st.isSymbolicLink());

/** An untracked file over this is asked about (§app.transport/edge-cases). */
export const LARGE_FILE = 50 * 1024 * 1024;

export interface LooseFile {
  /** Relative to the worktree, with `/`. */
  path: string;
  size: number;
  /** untracked: git would add it; private: a file git ignores; scratch: inside a folder git ignores. */
  kind: "untracked" | "private" | "scratch";
}

export interface WorktreeSurvey {
  name: string;
  path: string;
  branch: string | null;
  head: string;
  /** Why it can't travel, in the dialog's words; null when it can. */
  refusal: string | null;
  loose: LooseFile[];
  /** Folders git ignores that travel, with their sizes. */
  scratch: { dir: string; size: number }[];
  /** Dependency and build folders left to rebuild. */
  left: string[];
  /** The repository's first commits: how the destination tells it holds the same project. */
  roots: string[];
  /** The repository's remotes' addresses. */
  remotes: string[];
  /** Whether it is the repository's main checkout (not a linked worktree). */
  main: boolean;
  /** Its submodules, each travelling like the project itself (their loose files, scratch and private files are in
      `loose` and `scratch` above, by their path in this tree). */
  submodules: SubmoduleSurvey[];
}

/** One submodule of a tree (§app.transport/edge-cases). */
export interface SubmoduleSurvey {
  /** Its name in `.gitmodules` (its path when it has none). */
  name: string;
  /** Its path in the tree that holds it, with `/`. */
  path: string;
  /** Its path from the worktree being transported (a nested one's: through each submodule above it). */
  key: string;
  /** Its address, from `.gitmodules`, a relative one resolved against the holding repository's recorded remote;
      without credentials; "" when none can be told. */
  url: string;
  /** Its own survey when it is checked out here; null when only its gitlink is (never initialised). */
  tree: WorktreeSurvey | null;
}

async function gitDirs(path: string): Promise<{ gitDir: string; common: string; top: string }> {
  const out = (await ok(path, ["rev-parse", "--absolute-git-dir", "--git-common-dir", "--show-toplevel"], "Not a git repository")).split("\n");
  const gitDir = out[0]!;
  const commonRaw = out[1]!;
  const common = commonRaw.startsWith("/") ? commonRaw : join(path, commonRaw);
  return { gitDir, common: await realOr(common), top: out[2]! };
}

async function realOr(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

/** Why this worktree can't travel exactly yet, or null (§app.transport/edge-cases). */
async function refusalOf(path: string, gitDir: string): Promise<string | null> {
  const has = (f: string) => existsSync(join(gitDir, f));
  if (has("MERGE_HEAD")) return "It has a merge in progress: finish or remove that first.";
  if (has("rebase-merge") || has("rebase-apply")) return "It has a rebase in progress: finish or remove that first.";
  if (has("CHERRY_PICK_HEAD") || has("REVERT_HEAD")) return "It has a cherry-pick in progress: finish or remove that first.";
  if ((await git(path, ["ls-files", "-u"])).stdout.trim()) return "It has a merge in progress: finish or remove that first.";
  if ((await git(path, ["rev-parse", "--is-shallow-repository"])).stdout.trim() === "true") return "It is a shallow clone: fetch its whole history first.";
  if ((await git(path, ["config", "--bool", "core.sparseCheckout"])).stdout.trim() === "true") return "It uses a sparse checkout: turn that off first.";
  return null;
}

/** Sizes of the files under `abs` (never following a link), skipping left folders. */
async function walk(root: string, rel: string, out: LooseFile[], kind: LooseFile["kind"], nested: string[]): Promise<number> {
  let total = 0;
  let names: string[];
  try {
    names = (await readdir(join(root, rel))).sort();
  } catch {
    return 0;
  }
  for (const n of names) {
    const r = `${rel}/${n}`;
    let st;
    try {
      st = await lstat(join(root, r));
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (leftDir(n)) continue;
      if (n === ".git") {
        nested.push(rel);
        continue;
      }
      total += await walk(root, r, out, kind, nested);
    } else if (st.isFile() || st.isSymbolicLink()) {
      if (leftFile(n) || leftEntry(n, st)) continue;
      out.push({ path: r, size: st.isFile() ? st.size : 0, kind });
      total += st.isFile() ? st.size : 0;
    }
  }
  return total;
}

/** The address a repository's relative submodule URLs resolve against: its `origin`, else its first remote. */
async function recordedRemote(top: string): Promise<string | null> {
  const origin = (await git(top, ["config", "--get", "remote.origin.url"])).stdout.trim();
  if (origin) return origin;
  const first = (await git(top, ["config", "--get-regexp", "^remote\\..*\\.url$"])).stdout.split("\n")[0]?.split(" ").slice(1).join(" ").trim();
  return first || null;
}

/** The gitlinks of the tree at `top` (from its index), with their names and URLs from its `.gitmodules`. */
export async function gitlinksOf(top: string): Promise<{ path: string; name: string; url: string }[]> {
  const paths = nul((await git(top, ["ls-files", "-s", "-z"])).stdout)
    .filter((l) => l.startsWith("160000 "))
    .map((l) => l.slice(l.indexOf("\t") + 1));
  if (!paths.length) return [];
  const byPath = new Map<string, string>();
  const urls = new Map<string, string>();
  if (existsSync(join(top, ".gitmodules")))
    for (const kv of nul((await git(top, ["config", "-z", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.(path|url)$"])).stdout)) {
      const nl = kv.indexOf("\n");
      const key = nl < 0 ? kv : kv.slice(0, nl);
      const value = nl < 0 ? "" : kv.slice(nl + 1);
      const name = key.slice("submodule.".length, key.lastIndexOf("."));
      if (key.endsWith(".path")) byPath.set(value, name);
      else urls.set(name, value);
    }
  return [...new Set(paths)].sort().map((p) => {
    const name = byPath.get(p) ?? p;
    return { path: p, name, url: urls.get(name) ?? "" };
  });
}

/** Whether `dir` is a checked-out repository of its own (an initialised submodule), not the tree above it. */
async function checkedOut(dir: string): Promise<boolean> {
  if (!existsSync(join(dir, ".git"))) return false;
  const top = (await git(dir, ["rev-parse", "--show-toplevel"])).stdout.trim();
  return !!top && (await realOr(top)) === (await realOr(dir));
}

/** What one worktree would carry, and whether it can travel. Reads only. */
export function surveyWorktree(name: string, path: string): Promise<WorktreeSurvey> {
  return surveyTree(name, path, "", null);
}

/** A tree's survey; `key` is its path from the transported worktree ("" for that one), `base` the address its
    relative submodule URLs resolve against when it is a submodule (null: its own recorded remote). */
async function surveyTree(name: string, path: string, key: string, base: string | null): Promise<WorktreeSurvey> {
  const { gitDir, common, top } = await gitDirs(path);
  const main = (await realOr(gitDir)) === common;
  const head = (await git(path, ["rev-parse", "-q", "--verify", "HEAD"])).stdout.trim();
  const branch = (await git(path, ["symbolic-ref", "-q", "--short", "HEAD"])).stdout.trim() || null;
  const roots = head ? nul((await git(path, ["rev-list", "--max-parents=0", "-z", "HEAD"])).stdout.replace(/\n/g, "\0")).slice(0, 8) : [];
  const remotes = [...new Set((await git(path, ["config", "--get-regexp", "^remote\\..*\\.url$"])).stdout.split("\n").map((l) => l.split(" ").slice(1).join(" ").trim()).filter(Boolean))];
  let refusal = head ? await refusalOf(top, gitDir) : "It has no commits yet: commit once first.";
  const loose: LooseFile[] = [];
  const scratch: { dir: string; size: number }[] = [];
  const left: string[] = [];
  const nested: string[] = [];
  if (!refusal) {
    for (const p of nul((await ok(top, ["ls-files", "-o", "--exclude-standard", "-z"], "Listing new files")))) {
      if (p.endsWith("/")) {
        nested.push(p.slice(0, -1));
        continue;
      }
      const st = await lstat(join(top, p)).catch(() => null);
      if (st && leftEntry(p.split("/").at(-1)!, st)) left.push(p);
      else if (st) loose.push({ path: p, size: st.isFile() ? st.size : 0, kind: "untracked" });
    }
    // git names an ignored folder once and never walks it (40,000 files of node_modules cost nothing).
    for (const p of nul((await ok(top, ["ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"], "Listing ignored files"))).sort()) {
      const parts = p.replace(/\/$/, "").split("/");
      if (parts.some((s, i) => (i < parts.length - 1 || p.endsWith("/")) && leftDir(s))) {
        if (p.endsWith("/")) left.push(p.replace(/\/$/, ""));
        continue;
      }
      if (p.endsWith("/")) {
        const dir = p.slice(0, -1);
        const size = await walk(top, dir, loose, "scratch", nested);
        scratch.push({ dir, size });
      } else if (!leftFile(parts.at(-1)!)) {
        const st = await lstat(join(top, p)).catch(() => null);
        if (st && leftEntry(parts.at(-1)!, st)) left.push(p);
        else if (st) loose.push({ path: p, size: st.isFile() ? st.size : 0, kind: "private" });
      }
    }
    if (nested.length) refusal = "It has nested repositories: finish or remove that first.";
  }
  // Each submodule travels like the project (q32): checked out here, its own survey, its files by their path here.
  const submodules: SubmoduleSurvey[] = [];
  if (!refusal) {
    const holder = base ?? (await recordedRemote(top));
    for (const l of await gitlinksOf(top)) {
      const dir = join(top, l.path);
      const subKey = key ? `${key}/${l.path}` : l.path;
      let url = resolveSubmoduleUrl(l.url, holder);
      const tree = (await checkedOut(dir)) ? await surveyTree(l.name, dir, subKey, url || null) : null;
      if (!url && tree?.remotes[0]) url = withoutCredentials(tree.remotes[0]);
      submodules.push({ name: l.name, path: l.path, key: subKey, url, tree });
      if (!tree) continue;
      if (tree.refusal && !refusal) refusal = tree.refusal.replace(/^It (has|is|uses)/, `Its submodule ${subKey} $1`);
      for (const f of tree.loose) loose.push({ ...f, path: `${l.path}/${f.path}` });
      for (const d of tree.scratch) scratch.push({ dir: `${l.path}/${d.dir}`, size: d.size });
      for (const d of tree.left) left.push(`${l.path}/${d}`);
    }
  }
  return { name, path: top, branch, head, refusal, loose, scratch, left, roots, remotes, main, submodules };
}

// ---- the pack -----------------------------------------------------------------------------------

/** A tree's tracked state, as it is rebuilt there: HEAD, the index and the working tree, and its submodules. */
export interface TrackedMeta {
  name: string;
  branch: string | null;
  head: string;
  /** The working-tree snapshot commit; its parent is the index snapshot. */
  snap: string;
  /** sha256 of `git status --porcelain=v1 -z -uno`: the tracked state, which no device's own ignore rules change. */
  statusSha: string;
  ita: string[];
  skip: string[];
  assume: string[];
  /** This repository's own ignore rules (`info/exclude`), carried so a file hidden here is hidden there. */
  exclude?: string;
  /** Its submodules, by path (none in a package from before they travelled). */
  submodules?: SubmoduleMeta[];
}

export interface WorktreeMeta extends TrackedMeta {
  /** Every carried loose file (its submodules' too, by their path in this tree): its sha256, or `L <target>` for a link. */
  files: Record<string, string>;
  /** The carried files git ignores that aren't in a scratch folder (the ticked private files). */
  private?: string[];
  main: boolean;
}

/** A submodule as it travels: its gitlink always; when it was checked out, its repository too. */
export interface SubmoduleMeta {
  name: string;
  path: string;
  key: string;
  /** Its address there (no credentials; "" when none can be told). */
  url: string;
  /** Checked out where it came from: its commits (`<dir>/commits.bundle` in the code folder) and its state. */
  repo?: TrackedMeta & { dir: string };
}

/** The transport's refs in the bundle: one per worktree. */
const refOf = (tid: string, name: string) => `refs/sova/transport/${tid}/${name}`;

/** The repository itself, when it travels from this device (the destination lacks it and can't clone it):
    its default branch and the branches the bundle carries as `refs/heads/*`. */
export interface RepoMeta {
  defaultBranch: string | null;
  branches: string[];
}

const headAt = async (cwd: string, name: string) => (await git(cwd, ["rev-parse", "-q", "--verify", `refs/heads/${name}^{commit}`])).stdout.trim();

/** The repository's default branch here: the one its remote's HEAD names, else the one its main checkout is on;
    null when neither is a local branch. */
async function defaultBranchOf(cwd: string, common: string): Promise<string | null> {
  const remoteHead = (await git(cwd, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"])).stdout.trim().replace(/^origin\//, "");
  if (remoteHead && (await headAt(cwd, remoteHead))) return remoteHead;
  const mainHead = (await git(cwd, ["--git-dir", common, "symbolic-ref", "-q", "--short", "HEAD"])).stdout.trim();
  return mainHead && (await headAt(cwd, mainHead)) ? mainHead : null;
}

/** The local branches the repository travels with: its default branch and each worktree's branch (never a remote's refs). */
async function repoBranches(trees: readonly WorktreeSurvey[]): Promise<{ meta: RepoMeta; heads: [string, string][] }> {
  const at = trees[0]!.path;
  const { common } = await gitDirs(at);
  const defaultBranch = await defaultBranchOf(at, common);
  const heads: [string, string][] = [];
  for (const b of [defaultBranch, ...trees.map((t) => t.branch)]) {
    if (!b || heads.some(([n]) => n === b)) continue;
    const sha = await headAt(at, b);
    if (sha) heads.push([b, sha]);
  }
  return { meta: { defaultBranch, branches: heads.map(([n]) => n) }, heads };
}

/** About how many bytes the repository's history adds to the package when it travels (the dialog's size). */
export async function historyBytes(trees: readonly WorktreeSurvey[]): Promise<number> {
  if (!trees.length) return 0;
  const at = trees[0]!.path;
  const { heads } = await repoBranches(trees);
  const tips = [...new Set([...heads.map(([, s]) => s), ...trees.map((t) => t.head).filter(Boolean)])];
  return (await objectBytes(at, tips)) + (await submoduleHistoryBytes(trees));
}

/** About how many bytes the objects reachable from `tips` take in the repository at `at`. */
async function objectBytes(at: string, tips: readonly string[]): Promise<number> {
  const r = await git(at, ["rev-list", "--objects", "--disk-usage", ...tips]);
  if (r.code === 0 && /^\d+\s*$/.test(r.stdout)) return Number(r.stdout.trim());
  const c = await git(at, ["count-objects", "-v"]);
  const kib = (k: string) => Number(new RegExp(`^${k}: (\\d+)$`, "m").exec(c.stdout)?.[1] ?? 0);
  return (kib("size") + kib("size-pack")) * 1024;
}

/** About how many bytes the checked-out submodules' histories add when they travel whole (each repository once). */
export async function submoduleHistoryBytes(trees: readonly WorktreeSurvey[]): Promise<number> {
  const seen = new Set<string>();
  let n = 0;
  const each = async (subs: readonly SubmoduleSurvey[]): Promise<void> => {
    for (const s of subs) {
      if (!s.tree) continue;
      const { common } = await gitDirs(s.tree.path);
      if (!seen.has(common)) {
        seen.add(common);
        n += await objectBytes(s.tree.path, [s.tree.head]);
      }
      await each(s.tree.submodules);
    }
  };
  for (const t of trees) await each(t.submodules);
  return n;
}

/** Every submodule of `trees` (nested ones too) with its key and address: what the destination checks it can fetch. */
export function submodulesOf(trees: readonly WorktreeSurvey[]): { key: string; url: string }[] {
  const out = new Map<string, string>();
  const each = (subs: readonly SubmoduleSurvey[]): void => {
    for (const s of subs) {
      if (!out.has(s.key)) out.set(s.key, s.url);
      if (s.tree) each(s.tree.submodules);
    }
  };
  for (const t of trees) each(t.submodules);
  return [...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, url]) => ({ key, url }));
}

async function statusSha(path: string): Promise<string> {
  return sha256(await ok(path, ["status", "--porcelain=v1", "-z", "-uno"], "Reading the status"));
}

/**
 * A tree's HEAD, index and working tree as two commits on top of HEAD (index, then working tree), made in the scratch
 * store `scratchGit` from a copy of its index (`tmpIndex`): nothing of the tree changes. The index flags that hide
 * files from `add -u` and from the status are carried as lists and cleared in the copy.
 */
async function snapshotOf(t: WorktreeSurvey, scratchGit: string, tmpIndex: string): Promise<{ ct: string; ita: string[]; skip: string[]; assume: string[] }> {
  const { gitDir, common } = await gitDirs(t.path);
  if (existsSync(join(gitDir, "index"))) await copyFile(join(gitDir, "index"), tmpIndex);
  else await rm(tmpIndex, { force: true });
  const env = { ...SNAP_ENV, GIT_OBJECT_DIRECTORY: join(scratchGit, "objects"), GIT_ALTERNATE_OBJECT_DIRECTORIES: join(common, "objects"), GIT_INDEX_FILE: tmpIndex };
  try {
    const indexTree = (await ok(t.path, ["write-tree"], "Reading the index", { env })).trim();
    const flags = (await ok(t.path, ["ls-files", "-v", "-z"], "Reading index flags")).split("\0").filter(Boolean);
    const skip = flags.filter((l) => l.startsWith("S ") || l.startsWith("s ")).map((l) => l.slice(2));
    const assume = flags.filter((l) => /^[a-z] /.test(l)).map((l) => l.slice(2));
    const ita = nul(await ok(t.path, ["status", "--porcelain=v2", "-z", "-uno"], "Reading the status"))
      .filter((l) => /^1 \.A /.test(l) && /^0+$/.test(l.split(" ")[7] ?? ""))
      .map((l) => l.split(" ").slice(8).join(" "));
    if (skip.length) await ok(t.path, ["update-index", "-z", "--no-skip-worktree", "--stdin"], "Clearing skip-worktree in the copy", { env, input: skip.join("\0") });
    if (assume.length) await ok(t.path, ["update-index", "-z", "--no-assume-unchanged", "--stdin"], "Clearing assume-unchanged in the copy", { env, input: assume.join("\0") });
    // A checked-out submodule's gitlink takes its HEAD here, as `add -u` records it.
    await ok(t.path, ["add", "-u"], "Snapshotting the working tree", { env });
    const workTree = (await ok(t.path, ["write-tree"], "Snapshotting the working tree", { env })).trim();
    const ci = (await ok(t.path, ["commit-tree", indexTree, "-p", t.head, "-m", "index"], "Snapshotting the index", { env })).trim();
    const ct = (await ok(t.path, ["commit-tree", workTree, "-p", ci, "-m", "worktree"], "Snapshotting the working tree", { env })).trim();
    return { ct, ita, skip, assume };
  } finally {
    await rm(tmpIndex, { force: true });
  }
}

/** A repository's own ignore rules (`info/exclude`) when they hold any rule. */
async function excludeOf(common: string): Promise<string | undefined> {
  try {
    const ex = await readFile(join(common, "info", "exclude"), "utf8");
    return ex.split("\n").some((l) => l.trim() && !l.startsWith("#")) ? ex : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Each submodule of a tree (q32): its gitlink always; a checked-out one also its HEAD, index and working tree, snapshot
 * as the tree's own are, and its commits in `<dir>/modules/<i>/commits.bundle`: only what its remote lacks (by its
 * remote-tracking refs here) when the destination reached that remote, else its whole history. Its loose files go in
 * the holding tree's own (they are listed there). Nested submodules the same, inside it.
 */
async function packSubmodules(subs: readonly SubmoduleSurvey[], o: { tid: string; outDir: string; dir: string; fetchable: ReadonlySet<string>; n: { n: number } }): Promise<SubmoduleMeta[]> {
  const out: SubmoduleMeta[] = [];
  for (const [i, s] of [...subs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).entries()) {
    const base: SubmoduleMeta = { name: s.name, path: s.path, key: s.key, url: s.url };
    if (!s.tree) {
      out.push(base);
      continue;
    }
    const t = s.tree;
    const dir = `${o.dir}/modules/${i}`;
    const abs = join(o.outDir, dir);
    await mkdir(abs, { recursive: true, mode: 0o700 });
    const { common } = await gitDirs(t.path);
    const scratchGit = join(o.outDir, `.sub-${o.n.n++}.git`);
    await rm(scratchGit, { recursive: true, force: true });
    await ok(o.outDir, ["init", "-q", "--bare", scratchGit], "Making the scratch store");
    await writeFile(join(scratchGit, "objects", "info", "alternates"), `${join(common, "objects")}\n`);
    try {
      const { ct, ita, skip, assume } = await snapshotOf(t, scratchGit, join(o.outDir, `.index.sub-${o.n.n}`));
      const ref = refOf(o.tid, "snap");
      await ok(o.outDir, ["--git-dir", scratchGit, "update-ref", ref, ct], "Recording the snapshot");
      const nots: string[] = [];
      if (o.fetchable.has(s.key) && s.url)
        for (const h of new Set((await git(t.path, ["for-each-ref", "--format=%(objectname)", "refs/remotes"])).stdout.split("\n").filter(Boolean)))
          if ((await git(o.outDir, ["--git-dir", scratchGit, "cat-file", "-e", `${h}^{commit}`])).code === 0) nots.push(`^${h}`);
      const bundle = join(abs, "commits.bundle");
      let made = await git(o.outDir, ["--git-dir", scratchGit, "bundle", "create", "-q", bundle, ref, ...nots]);
      if (made.code !== 0 && nots.length) made = await git(o.outDir, ["--git-dir", scratchGit, "bundle", "create", "-q", bundle, ref]);
      if (made.code !== 0) throw new SnapshotError("git", `Making the bundle of submodule ${s.key}: ${made.stderr.trim()}`);
      const exclude = await excludeOf(common);
      const nested = await packSubmodules(t.submodules, { ...o, dir });
      out.push({
        ...base,
        repo: { dir, name: s.name, branch: t.branch, head: t.head, snap: ct, statusSha: await statusSha(t.path), ita, skip, assume, ...(exclude ? { exclude } : {}), ...(nested.length ? { submodules: nested } : {}) },
      });
    } finally {
      await rm(scratchGit, { recursive: true, force: true });
    }
  }
  return out;
}

/**
 * Pack `trees` (all of one repository) into `outDir`: `commits.bundle` and, per worktree,
 * `<name>/loose.tar` and `<name>/worktree.json`. `skip(name, file)` leaves a loose file out (unticked,
 * or too large and not asked for). `haves` are commits the destination said it has: left out of the
 * bundle when this repository has them too.
 */
export async function packWorktrees(o: {
  tid: string;
  trees: readonly WorktreeSurvey[];
  haves: readonly string[];
  outDir: string;
  skip?: (name: string, f: LooseFile) => boolean;
  /** The destination lacks the repository and can't clone it: the bundle carries its default branch and the
      worktrees' branches too, with their whole history. */
  repo?: boolean;
  /** The submodules (by key) whose remotes the destination reached: only what those remotes lack travels for them;
      every other checked-out submodule travels with its history. */
  fetchable?: readonly string[];
}): Promise<{ metas: WorktreeMeta[]; bundle: string; repo?: RepoMeta }> {
  if (!o.trees.length) throw new SnapshotError("refused", "No worktree to pack.");
  for (const t of o.trees) if (t.refusal) throw new SnapshotError("refused", t.refusal);
  await mkdir(o.outDir, { recursive: true, mode: 0o700 });
  const { common } = await gitDirs(o.trees[0]!.path);
  const scratchGit = join(o.outDir, ".snap.git");
  await rm(scratchGit, { recursive: true, force: true });
  await ok(o.outDir, ["init", "-q", "--bare", scratchGit], "Making the scratch store");
  await writeFile(join(scratchGit, "objects", "info", "alternates"), `${join(common, "objects")}\n`);
  const metas: WorktreeMeta[] = [];
  const refs: string[] = [];
  const counter = { n: 0 };
  try {
    for (const t of o.trees) {
      const wo = join(o.outDir, t.name);
      await mkdir(wo, { recursive: true, mode: 0o700 });
      const { ct, ita, skip, assume } = await snapshotOf(t, scratchGit, join(o.outDir, `.index.${t.name}`));
      await ok(o.outDir, ["--git-dir", scratchGit, "update-ref", refOf(o.tid, t.name), ct], "Recording the snapshot");
      const submodules = await packSubmodules(t.submodules, { tid: o.tid, outDir: o.outDir, dir: t.name, fetchable: new Set(o.fetchable ?? []), n: counter });
      refs.push(refOf(o.tid, t.name));
      // The loose files, by tar: full modes and links (git keeps only the executable bit).
      const files: Record<string, string> = {};
      const privates: string[] = [];
      const entries: TarEntry[] = [];
      const dirs = new Set<string>();
      for (const f of [...t.loose].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
        if (o.skip?.(t.name, f)) continue;
        const parts = f.path.split("/");
        for (let i = 1; i < parts.length; i++) {
          const d = parts.slice(0, i).join("/");
          if (dirs.has(d)) continue;
          dirs.add(d);
          const e = await entryOf(t.path, d).catch(() => null);
          if (e?.type === "dir") entries.push(e);
        }
        const e = await entryOf(t.path, f.path).catch(() => null);
        if (!e) continue;
        entries.push(e);
        files[f.path] = e.type === "symlink" ? `L ${e.target}` : await fileSha(join(t.path, f.path));
        if (f.kind === "private") privates.push(f.path);
      }
      await writeTar(join(wo, "loose.tar"), entries);
      const exclude = await excludeOf(common);
      const meta: WorktreeMeta = { name: t.name, branch: t.branch, head: t.head, snap: ct, statusSha: await statusSha(t.path), ita, skip, assume, files, ...(privates.length ? { private: privates } : {}), ...(exclude ? { exclude } : {}), ...(submodules.length ? { submodules } : {}), main: t.main };
      await writeFile(join(wo, "worktree.json"), `${JSON.stringify(meta)}\n`, { mode: 0o600 });
      metas.push(meta);
    }
    let repo: RepoMeta | undefined;
    if (o.repo) {
      const r = await repoBranches(o.trees);
      for (const [name, sha] of r.heads) await ok(o.outDir, ["--git-dir", scratchGit, "update-ref", `refs/heads/${name}`, sha], "Recording the branches");
      refs.push(...r.heads.map(([name]) => `refs/heads/${name}`));
      repo = r.meta;
    }
    const bundle = join(o.outDir, "commits.bundle");
    const nots: string[] = [];
    for (const h of o.haves) if (/^[0-9a-f]{40,64}$/.test(h) && (await git(o.outDir, ["--git-dir", scratchGit, "cat-file", "-e", `${h}^{commit}`])).code === 0) nots.push(`^${h}`);
    let made = await git(o.outDir, ["--git-dir", scratchGit, "bundle", "create", "-q", bundle, ...refs, ...nots]);
    // Everything already there (a repack of a state the destination took): a whole bundle instead.
    if (made.code !== 0 && nots.length) made = await git(o.outDir, ["--git-dir", scratchGit, "bundle", "create", "-q", bundle, ...refs]);
    if (made.code !== 0) throw new SnapshotError("git", `Making the bundle: ${made.stderr.trim()}`);
    return { metas, bundle, ...(repo ? { repo } : {}) };
  } finally {
    await rm(scratchGit, { recursive: true, force: true });
  }
}

// ---- the rebuild (destination) --------------------------------------------------------------------

export interface StagedTree {
  name: string;
  /** Where it goes at publish. */
  target: string;
  /** Where it was rebuilt and checked. */
  stage: string;
  /** The branch it is on there (a suffix when the name was taken). */
  branch: string | null;
  /** The branch's name here when it differs there. */
  renamedFrom?: string;
  main: boolean;
  /** The ticked private files, by path in the tree. */
  private?: string[];
  /** The folder already held this code (a project prepared there, or a retry after publish): its carried
      loose files, unpacked and checked in `dir`, are put in at publish beside what is there, replacing nothing. */
  loose?: { dir: string; files: Record<string, string> };
  /** The folder holds this commit with nothing changed (a project prepared there): the snapshot's tracked changes are
      written into it at publish, once checked in a scratch worktree. */
  base?: WorktreeMeta;
  /** The base folder's HEAD when it was checked: publish refuses if it moved since. */
  baseHead?: string;
  /** The base folder was made for this transport (it didn't exist when the offer came). */
  ours?: boolean;
  /** The package's code folder: a base folder's submodules are built from it at publish. */
  code?: string;
  /** Its submodules that weren't checked out where it came from: each arrives as its gitlink only (by key). */
  uninitialised?: string[];
}

const stageOf = (target: string, tid: string) => join(dirname(target), `.incoming-${tid}-${basename(target)}`);

/** Whether `target` already holds exactly this worktree (a retry after publish). */
async function holds(target: string, meta: TrackedMeta): Promise<boolean> {
  if (!existsSync(join(target, ".git"))) return false;
  const head = (await git(target, ["rev-parse", "-q", "--verify", "HEAD"])).stdout.trim();
  if (head !== meta.head || (await statusSha(target).catch(() => "")) !== meta.statusSha) return false;
  // The status names the changed files, not their content: changed files there must match the snapshot's.
  const changed = (await git(target, ["status", "--porcelain=v1", "-uno"])).stdout.trim();
  if (!changed) return true;
  if ((await git(target, ["cat-file", "-e", `${meta.snap}^{tree}`])).code !== 0) return false;
  return (await git(target, ["diff", "--quiet", meta.snap, "--"])).code === 0;
}

/** A folder that already holds the code: its loose files unpacked aside and checked, for publish to put in. */
async function heldTree(codeDir: string, meta: WorktreeMeta, target: string): Promise<StagedTree> {
  const dir = join(codeDir, meta.name, "loose");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await extractTar(join(codeDir, meta.name, "loose.tar"), dir);
  await verifyFiles(dir, meta);
  return { name: meta.name, target, stage: target, branch: meta.branch, main: meta.main, ...(meta.private?.length ? { private: meta.private } : {}), loose: { dir, files: meta.files } };
}

/**
 * Whether `target` can take the chat's code (§app.transport/arrival): a checkout of the same repository with no
 * tracked change, at the chat's commit or behind it. Taken over only when it was made for this transport (`ours`)
 * or is on the chat's branch already: its branch moves to the chat's commit. One detached at such a commit gets the
 * chat's branch by the edge-case rule (reused at the same commit, else a suffix). A checkout of yours on another
 * branch is left as it is: refused. Its HEAD and the branch to check out, else why not. Needs the package's commits.
 */
async function baseOf(target: string, meta: WorktreeMeta, ours: boolean, tid: string): Promise<{ head: string; branch: string | null; renamedFrom?: string } | { why: string }> {
  const taken = `${target} already exists there`;
  if (!existsSync(join(target, ".git"))) return { why: `${taken} and isn't a checkout of this project; pick another folder.` };
  const head = (await git(target, ["rev-parse", "-q", "--verify", "HEAD"])).stdout.trim();
  if (!head) return { why: `${taken} with no commit checked out; pick another folder.` };
  if ((await git(target, ["cat-file", "-e", `${meta.head}^{commit}`])).code !== 0) return { why: `${taken} and holds another repository; pick another folder.` };
  if (head !== meta.head && (await git(target, ["merge-base", "--is-ancestor", head, meta.head])).code !== 0)
    return { why: `${taken} at a commit the chat's code doesn't build on (newer, or another line of work); pick another folder.` };
  const changed = (await git(target, ["status", "--porcelain=v1", "-uno"])).stdout.trim();
  const n = changed ? changed.split("\n").length : 0;
  if (n) return { why: `${taken} with changes of its own (${n} ${n === 1 ? "file" : "files"}); nothing was replaced. Commit or move them away, or pick another folder.` };
  const cur = (await git(target, ["symbolic-ref", "-q", "--short", "HEAD"])).stdout.trim() || null;
  if (!meta.branch) return ours || !cur ? { head, branch: null } : { why: `${taken} on its own branch ${cur}, and the chat's code isn't on a branch; nothing was changed. Pick another folder.` };
  if (ours || cur === meta.branch) {
    const at = (await git(target, ["rev-parse", "-q", "--verify", `refs/heads/${meta.branch}`])).stdout.trim();
    if (at && at !== meta.head && (await git(target, ["merge-base", "--is-ancestor", at, meta.head])).code !== 0)
      return { why: `${taken} with its own ${meta.branch} branch, which the chat's doesn't build on; pick another folder.` };
    return { head, branch: meta.branch };
  }
  if (cur) return { why: `${taken} on its own branch ${cur}, and the chat's code is on ${meta.branch}; nothing was changed. Check out ${meta.branch} there, or pick another folder.` };
  const b = await branchThere(target, meta.branch, meta.head, tid);
  return { head, branch: b.branch, ...(b.renamedFrom ? { renamedFrom: b.renamedFrom } : {}) };
}

/** Files the snapshot adds since `from` that a file there already stands on (writing the changes would replace it). */
async function inTheWay(target: string, meta: { snap: string }, from: string): Promise<string[]> {
  const added = nul(await ok(target, ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=A", from, `${meta.snap}^{tree}`], "Reading the changes"));
  const out = new Set<string>();
  const kind = (rel: string) => lstat(join(target, rel)).then((st) => (st.isDirectory() ? "dir" : "other"), () => "none");
  for (const p of added) {
    if ((await kind(p)) !== "none") out.add(p);
    // A file or link where the path needs a folder: writing it would replace that too.
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      const up = parts.slice(0, i).join("/");
      const k = await kind(up);
      if (k === "other") out.add(up);
      if (k !== "dir") break;
    }
  }
  return [...out];
}

/** A base folder: the snapshot rebuilt and checked in a scratch worktree of its repository (then dropped), its loose files unpacked aside. */
async function baseTree(repo: string, codeDir: string, meta: WorktreeMeta, target: string, base: { head: string; branch: string | null; renamedFrom?: string }, ours: boolean): Promise<StagedTree> {
  const head = base.head;
  const scratch = join(codeDir, meta.name, "check");
  await git(repo, ["worktree", "remove", "--force", scratch]);
  await rm(scratch, { recursive: true, force: true });
  await git(repo, ["worktree", "prune"]);
  await ok(repo, ["worktree", "add", "-q", "--no-checkout", "--detach", scratch, meta.head], "Checking the package");
  try {
    await finishStage(scratch, join(codeDir, meta.name), meta);
  } finally {
    await git(repo, ["worktree", "remove", "--force", scratch]);
    await rm(scratch, { recursive: true, force: true });
    await git(repo, ["worktree", "prune"]);
  }
  const way = await inTheWay(target, meta, head);
  if (way.length) throw new SnapshotError("taken", `${target} already has ${way.slice(0, 3).join(", ")}${way.length > 3 ? ` and ${way.length - 3} more` : ""}, which the chat's code adds; nothing was replaced. Move ${way.length === 1 ? "it" : "them"} away or pick another folder.`);
  return { ...(await heldTree(codeDir, meta, target)), base: meta, baseHead: head, branch: base.branch, ...(base.renamedFrom ? { renamedFrom: base.renamedFrom } : {}), ...(ours ? { ours: true } : {}), ...(meta.submodules?.some((s) => s.repo) ? { code: codeDir } : {}) };
}

/** At publish: a base folder takes the chat's commit, branch and unfinished changes (working tree, index, flags). */
async function applyBase(t: StagedTree): Promise<void> {
  const meta = t.base!;
  if (await holds(t.target, meta)) return; // a retry after it was applied
  const again = await baseOf(t.target, meta, !!t.ours, "");
  const changed = `${t.target} changed there since it was checked; nothing was replaced. Retry to check it again.`;
  if ("why" in again || again.head !== t.baseHead || (await inTheWay(t.target, meta, again.head)).length) throw new SnapshotError("taken", changed);
  await ok(t.target, ["read-tree", "--reset", "-u", `${meta.snap}^{tree}`], "Writing the changes");
  await ok(t.target, ["read-tree", "-m", `${meta.snap}^{tree}`, `${meta.snap}^^{tree}`], "Writing the index");
  if (t.branch) {
    await ok(t.target, ["update-ref", `refs/heads/${t.branch}`, meta.head], "Moving the branch");
    await ok(t.target, ["symbolic-ref", "HEAD", `refs/heads/${t.branch}`], "Checking out the branch");
  } else await ok(t.target, ["update-ref", "--no-deref", "HEAD", meta.head], "Checking out the commit");
  if (meta.ita.length) await ok(t.target, ["add", "-N", "--pathspec-from-file=-", "--pathspec-file-nul"], "Marking intent-to-add", { input: meta.ita.join("\0") });
  if (meta.assume.length) await ok(t.target, ["update-index", "-z", "--assume-unchanged", "--stdin"], "Marking assume-unchanged", { input: meta.assume.join("\0") });
  if (meta.skip.length) await ok(t.target, ["update-index", "-z", "--skip-worktree", "--stdin"], "Marking skip-worktree", { input: meta.skip.join("\0") });
  for (const sm of meta.submodules ?? []) if (sm.repo && t.code) await buildSubmodule(t.target, t.code, sm);
  await git(t.target, ["update-index", "-q", "--refresh"]);
  if ((await statusSha(t.target)) !== meta.statusSha) throw new SnapshotError("mismatch", `${meta.name} didn't take its changes exactly there.`);
}

async function shaOf(abs: string): Promise<string> {
  try {
    const st = await lstat(abs);
    return st.isSymbolicLink() ? `L ${await readlink(abs)}` : st.isFile() ? await fileSha(abs) : "other";
  } catch {
    return "missing";
  }
}

/** One loose file put where nothing is: its bytes, mode and time, or the link. */
async function placeLoose(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  const st = await lstat(from);
  if (st.isSymbolicLink()) await symlink(await readlink(from), to);
  else await cp(from, to, { preserveTimestamps: true, errorOnExist: true, force: false });
}

/** What publish did with a held folder's loose files: a file that differs there is kept, and the arrived one goes beside it. */
export interface KeptFile {
  tree: string;
  /** The file there, kept as it was. */
  path: string;
  /** Where the arrived copy went, beside it. */
  beside: string;
}

async function putLoose(t: StagedTree, from: string, kept: KeptFile[]): Promise<Map<string, string>> {
  const landed = new Map<string, string>();
  const tag = `from-${from.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "there"}`;
  for (const [p, want] of Object.entries(t.loose!.files)) {
    const src = join(t.loose!.dir, p);
    const dest = join(t.target, p);
    const have = await shaOf(dest);
    if (have === want) {
      landed.set(p, p);
      continue;
    }
    if (have === "missing") {
      await placeLoose(src, dest);
      landed.set(p, p);
      continue;
    }
    // Something else is there: it stays, and the arrived copy goes beside it (the same one again: already there).
    let beside = `${p}.${tag}`;
    for (let i = 2; (await shaOf(join(t.target, beside))) !== "missing" && (await shaOf(join(t.target, beside))) !== want; i++) beside = `${p}.${tag}-${i}`;
    if ((await shaOf(join(t.target, beside))) === "missing") await placeLoose(src, join(t.target, beside));
    // A private file's arrived copy stays as hidden from git as the file it sits beside (never committed by mistake).
    // A submodule's file: the repository holding it is the submodule's, and so are its ignore rules.
    const holder = t.private?.includes(p) ? (await git(dirname(join(t.target, beside)), ["rev-parse", "--show-toplevel"])).stdout.trim() || t.target : t.target;
    const rel = relative(await realOr(holder), join(await realOr(dirname(join(t.target, beside))), basename(beside)));
    if (t.private?.includes(p) && (await git(holder, ["check-ignore", "-q", "--no-index", rel])).code !== 0) {
      const { common } = await gitDirs(holder);
      await mkdir(join(common, "info"), { recursive: true });
      const file = join(common, "info", "exclude");
      const have = await readFile(file, "utf8").catch(() => "");
      const line = `/${rel.replace(/([*?[\]\\!#])/g, "\\$1")}`;
      if (!have.split("\n").includes(line)) await writeFile(file, `${have}${have && !have.endsWith("\n") ? "\n" : ""}${line}\n`);
    }
    kept.push({ tree: t.name, path: p, beside });
    landed.set(p, beside);
  }
  return landed;
}

async function extractTar(tarFile: string, into: string): Promise<void> {
  // Checked before a byte is written: nothing in it may land outside the stage (a tracked link counts).
  let members;
  try {
    members = await listTar(tarFile);
  } catch (err) {
    throw new SnapshotError("refused", `The package was refused: it holds ${err instanceof Error ? err.message : String(err)}. Nothing was written.`);
  }
  const why = checkMembers(members, (rel) => {
    try {
      return lstatSync(join(into, rel)).isSymbolicLink();
    } catch {
      return false;
    }
  });
  if (why) throw new SnapshotError("refused", `The package was refused: ${why}. Nothing was written.`);
  await new Promise<void>((done, fail) => {
    execFile("tar", ["-x", "-p", "--no-same-owner", "-f", tarFile, "-C", into], { timeout: GIT_LONG_MS, maxBuffer: 4 * 1024 * 1024 }, (err, _o, stderr) =>
      err ? fail(new SnapshotError("git", `Unpacking the loose files: ${String(stderr).trim() || err.message}`)) : done(),
    );
  });
}

/** Check a rebuilt tree against what the source recorded: the tracked status and every carried file. */
async function verify(stage: string, meta: WorktreeMeta): Promise<void> {
  await git(stage, ["update-index", "-q", "--refresh"]);
  const got = await statusSha(stage);
  if (got !== meta.statusSha) {
    const short = (await git(stage, ["status", "--short", "-uno"])).stdout.split("\n").slice(0, 5).join("; ");
    throw new SnapshotError("mismatch", `${meta.name} didn't rebuild exactly (status differs: ${short || "no detail"}).`);
  }
  await verifyFiles(stage, meta);
}

async function verifyFiles(stage: string, meta: WorktreeMeta): Promise<void> {
  for (const [p, want] of Object.entries(meta.files)) {
    const abs = join(stage, p);
    let have: string;
    try {
      const st = await lstat(abs);
      have = st.isSymbolicLink() ? `L ${await readlink(abs)}` : await fileSha(abs);
    } catch {
      have = "missing";
    }
    if (have !== want) throw new SnapshotError("mismatch", `${meta.name}: ${p} didn't arrive exactly.`);
  }
}

/** The commits this repository has, for the source to leave out of the bundle (a few thousand at most). */
export async function havesOf(repo: string): Promise<string[]> {
  if (!existsSync(repo)) return [];
  const r = await git(repo, ["for-each-ref", "--count=4000", "--format=%(objectname)", "refs/heads", "refs/remotes", "refs/tags"]);
  return r.code === 0 ? [...new Set(r.stdout.split("\n").filter(Boolean))] : [];
}

/** The branch a worktree takes there: its own name when free, or holding the same commit unchecked-out; else a suffix. */
async function branchThere(repo: string, branch: string | null, head: string, tid: string): Promise<{ branch: string | null; renamedFrom?: string }> {
  if (!branch) return { branch: null };
  const cur = (await git(repo, ["rev-parse", "-q", "--verify", `refs/heads/${branch}`])).stdout.trim();
  if (!cur) return { branch };
  const inUse = (await git(repo, ["worktree", "list", "--porcelain"])).stdout.split("\n").includes(`branch refs/heads/${branch}`);
  if (cur === head && !inUse) return { branch };
  for (let i = 2; i < 100; i++) {
    const name = `${branch}-${i}`;
    const at = (await git(repo, ["rev-parse", "-q", "--verify", `refs/heads/${name}`])).stdout.trim();
    if (!at || at === head) return { branch: name, renamedFrom: branch };
  }
  return { branch: `${branch}-${tid}`, renamedFrom: branch };
}

/** A repository started in `stage` from the package's bundle: the transport's refs and, when the bundle carries the
    repository (§app.transport/package), its branches; `origin` the recorded remote, without credentials. Nothing is
    fetched from anywhere else. */
async function seedRepo(stage: string, codeDir: string, tid: string, origin: string | null): Promise<void> {
  const bundle = join(codeDir, "commits.bundle");
  await ok(stage, ["init", "-q"], "Making the repository");
  const heads = (await git(stage, ["bundle", "list-heads", bundle])).stdout.split("\n").some((l) => / refs\/heads\/./.test(l));
  await ok(stage, [...NO_BACKGROUND_CLEANUP, "fetch", "-q", "--update-head-ok", bundle, `+${refOf(tid, "*")}:${refOf(tid, "*")}`, ...(heads ? ["+refs/heads/*:refs/heads/*"] : [])], "Fetching the bundle");
  if (origin) await ok(stage, ["remote", "add", "origin", withoutCredentials(origin)], "Recording the remote");
}

/** What a repository made there from the package needs: its folder, its remote (none: no origin) and default branch. */
export interface RepoFromPackage {
  path: string;
  origin: string | null;
  defaultBranch: string | null;
}

/**
 * The repository a chat's linked worktrees build on, made from the package when the destination lacked it
 * (§app.transport/arrival): built whole beside its folder, on its default branch (detached at it when a worktree
 * of the chat takes that branch), checked clean, published by one rename before the worktrees move in.
 */
async function makeRepo(o: RepoFromPackage, codeDir: string, tid: string, metas: readonly WorktreeMeta[]): Promise<StagedTree> {
  const target = o.path;
  if (!lacksRepo(target)) throw new SnapshotError("taken", `${target} already exists there; pick another folder.`);
  const stage = stageOf(target, tid);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  await seedRepo(stage, codeDir, tid, o.origin);
  const taken = new Set(metas.map((m) => m.branch).filter(Boolean));
  const def = o.defaultBranch && (await headAt(stage, o.defaultBranch)) ? o.defaultBranch : null;
  if (def && !taken.has(def)) await ok(stage, ["symbolic-ref", "HEAD", `refs/heads/${def}`], "Checking out the default branch");
  else await ok(stage, ["update-ref", "--no-deref", "HEAD", def ? await headAt(stage, def) : metas[0]!.head], "Checking out the default branch");
  await ok(stage, ["read-tree", "--reset", "-u", "HEAD"], "Writing the checkout");
  await git(stage, ["update-index", "-q", "--refresh"]);
  if ((await git(stage, ["status", "--porcelain=v1", "-uall"])).stdout.trim()) throw new SnapshotError("mismatch", `${target} didn't build cleanly from the package.`);
  return { name: basename(target), target, stage, branch: def && !taken.has(def) ? def : null, main: true };
}

/** Rebuild one worktree at its stage (idempotent: a stage left by a dead attempt is replaced). */
async function rebuildOne(repo: string | null, codeDir: string, tid: string, meta: WorktreeMeta, target: string, origin: string | null = null): Promise<StagedTree> {
  const stage = stageOf(target, tid);
  const wo = join(codeDir, meta.name);
  if (meta.main) {
    // The repository itself: built whole beside its folder, published by one rename.
    if (existsSync(target) && (await readdir(target)).length) throw new SnapshotError("taken", `${target} already exists there; pick another folder.`);
    await rm(stage, { recursive: true, force: true });
    await mkdir(stage, { recursive: true });
    await seedRepo(stage, codeDir, tid, origin);
    if (meta.branch) {
      await ok(stage, ["update-ref", `refs/heads/${meta.branch}`, meta.head], "Making the branch");
      await ok(stage, ["symbolic-ref", "HEAD", `refs/heads/${meta.branch}`], "Checking out the branch");
    } else await ok(stage, ["update-ref", "--no-deref", "HEAD", meta.head], "Checking out the commit");
    await finishStage(stage, wo, meta);
    return { name: meta.name, target, stage, branch: meta.branch, main: true, ...(meta.private?.length ? { private: meta.private } : {}) };
  }
  if (!repo) throw new SnapshotError("git", `No repository there for ${meta.name}.`);
  if (existsSync(target)) throw new SnapshotError("taken", `${target} already exists there; pick another folder.`);
  // A dead attempt's stage goes first: it would hold the branch and push this one to a suffix.
  await git(repo, ["worktree", "prune"]);
  if (existsSync(stage)) {
    await git(repo, ["worktree", "remove", "--force", stage]);
    await rm(stage, { recursive: true, force: true });
    await git(repo, ["worktree", "prune"]);
  }
  const b = await branchThere(repo, meta.branch, meta.head, tid);
  await mkdir(dirname(stage), { recursive: true });
  if (!b.branch) await ok(repo, ["worktree", "add", "-q", "--no-checkout", "--detach", stage, meta.head], "Adding the worktree");
  else {
    if (!(await git(repo, ["rev-parse", "-q", "--verify", `refs/heads/${b.branch}`])).stdout.trim()) await ok(repo, ["branch", "-q", b.branch, meta.head], "Making the branch");
    await ok(repo, ["worktree", "add", "-q", "--no-checkout", stage, b.branch], "Adding the worktree");
  }
  await finishStage(stage, wo, meta);
  return { name: meta.name, target, stage, branch: b.branch, ...(b.renamedFrom ? { renamedFrom: b.renamedFrom } : {}), main: false, ...(meta.private?.length ? { private: meta.private } : {}) };
}

async function finishStage(stage: string, wo: string, meta: WorktreeMeta): Promise<void> {
  await writeTracked(stage, dirname(wo), meta);
  // The loose files after the submodules: theirs go inside them.
  await extractTar(join(wo, "loose.tar"), stage);
  await verify(stage, meta);
}

/** A tree's tracked state written at `stage`: index = working tree = the source's working tree, then index = the
    source's index (files untouched); its submodules built inside; its own ignore rules and index flags as there. */
async function writeTracked(stage: string, codeDir: string, meta: TrackedMeta): Promise<void> {
  await ok(stage, ["read-tree", "--reset", "-u", `${meta.snap}^{tree}`], "Writing the working tree");
  await ok(stage, ["read-tree", "-m", `${meta.snap}^{tree}`, `${meta.snap}^^{tree}`], "Writing the index");
  for (const sm of meta.submodules ?? []) await buildSubmodule(stage, codeDir, sm);
  if (meta.exclude) {
    const { common } = await gitDirs(stage);
    await mkdir(join(common, "info"), { recursive: true });
    const file = join(common, "info", "exclude");
    const have = await readFile(file, "utf8").catch(() => "");
    const add = meta.exclude.split("\n").filter((l) => l.trim() && !l.startsWith("#") && !have.split("\n").includes(l));
    if (add.length) await writeFile(file, `${have}${have && !have.endsWith("\n") ? "\n" : ""}${add.join("\n")}\n`);
  }
  if (meta.ita.length) await ok(stage, ["add", "-N", "--pathspec-from-file=-", "--pathspec-file-nul"], "Marking intent-to-add", { input: meta.ita.join("\0") });
  if (meta.assume.length) await ok(stage, ["update-index", "-z", "--assume-unchanged", "--stdin"], "Marking assume-unchanged", { input: meta.assume.join("\0") });
  if (meta.skip.length) await ok(stage, ["update-index", "-z", "--skip-worktree", "--stdin"], "Marking skip-worktree", { input: meta.skip.join("\0") });
}

// ---- submodules there (q32) -----------------------------------------------------------------------

/** Join a submodule's folder `at` and its repository `mod` as git's own layout does: `at/.git` names `mod`, and
    `mod`'s `core.worktree` names `at`, each by a relative path. */
async function connectSubmodule(at: string, mod: string): Promise<void> {
  const realAt = await realOr(at);
  const realMod = await realOr(mod);
  await writeFile(join(at, ".git"), `gitdir: ${relative(realAt, realMod)}\n`);
  // By its config file: git run on the repository would first go to the folder its config still names.
  await ok("/", ["config", "--file", join(realMod, "config"), "core.bare", "false"], "Joining the submodule");
  await ok("/", ["config", "--file", join(realMod, "config"), "core.worktree", relative(realMod, realAt)], "Joining the submodule");
}

/** A submodule's commits fetched into the repository at `at`: its package's bundle, after what its remote has when
    the bundle carries only what the remote lacks (fetched asking for nothing). Never with credentials. */
async function fetchSubmodule(at: string, codeDir: string, sm: SubmoduleMeta): Promise<void> {
  const r = sm.repo!;
  const bundle = join(codeDir, r.dir, "commits.bundle");
  if (sm.url && plainRemote(sm.url) && !(await git(at, ["remote", "get-url", "origin"])).stdout.trim()) await ok(at, ["remote", "add", "origin", sm.url], "Recording the submodule's remote");
  let v = await git(at, ["bundle", "verify", "-q", bundle]);
  if (v.code !== 0 && sm.url && plainRemote(sm.url)) {
    await git(at, [...NO_BACKGROUND_CLEANUP, ...PROMPT_FREE_ARGS, "fetch", "-q", sm.url, "+refs/heads/*:refs/remotes/origin/*"], { env: PROMPT_FREE });
    v = await git(at, ["bundle", "verify", "-q", bundle]);
  }
  if (v.code !== 0) throw new SnapshotError("needs-base", `The submodule ${sm.key} lacks commits the package builds on, and ${sm.url ? `its remote ${sm.url} didn't give them here` : "it has no remote recorded"}.`);
  await ok(at, [...NO_BACKGROUND_CLEANUP, "fetch", "-q", bundle, "+refs/sova/transport/*:refs/sova/transport/*"], `Fetching the submodule ${sm.key}`);
}

/** The submodule's HEAD as it was where it came from: detached at its commit, or on its branch (moved there when the
    name is free or behind it, else the edge-case suffix). */
async function checkOutSubmodule(at: string, r: TrackedMeta): Promise<void> {
  if (!r.branch) return void (await ok(at, ["update-ref", "--no-deref", "HEAD", r.head], "Checking out the submodule's commit"));
  const cur = (await git(at, ["rev-parse", "-q", "--verify", `refs/heads/${r.branch}`])).stdout.trim();
  const behind = !cur || cur === r.head || (await git(at, ["merge-base", "--is-ancestor", cur, r.head])).code === 0;
  const name = behind ? r.branch : ((await branchThere(at, r.branch, r.head, "submodule")).branch ?? r.branch);
  await ok(at, ["update-ref", `refs/heads/${name}`, r.head], "Making the submodule's branch");
  await ok(at, ["symbolic-ref", "HEAD", `refs/heads/${name}`], "Checking out the submodule's branch");
}

/** Check a rebuilt submodule against what the source recorded (its HEAD and tracked status), then drop the
    transport's refs in it. */
async function verifySubmodule(at: string, sm: SubmoduleMeta): Promise<void> {
  const r = sm.repo!;
  await git(at, ["update-index", "-q", "--refresh"]);
  const head = (await git(at, ["rev-parse", "-q", "--verify", "HEAD"])).stdout.trim();
  if (head !== r.head || (await statusSha(at)) !== r.statusSha) {
    const short = (await git(at, ["status", "--short", "-uno"])).stdout.split("\n").slice(0, 5).join("; ");
    throw new SnapshotError("mismatch", `The submodule ${sm.key} didn't rebuild exactly (${head !== r.head ? "its commit differs" : `status differs: ${short || "no detail"}`}).`);
  }
  const refs = (await git(at, ["for-each-ref", "--format=delete %(refname)", "refs/sova/transport/"])).stdout;
  if (refs.trim()) await git(at, ["update-ref", "--stdin"], { input: refs });
}

/**
 * One submodule of the tree at `top`, as it was where it came from (q32): one never checked out there stays a gitlink
 * (its empty folder); a checked-out one gets its repository in git's own layout (`<top's git dir>/modules/<name>`),
 * its commits, its HEAD, its unfinished changes and its own submodules, and is checked like the tree; the holding
 * repository records its URL and marks it active, as `git submodule init` does, unless it already does. One already
 * checked out there (a project prepared there) takes the chat's state when it is clean and its commit is the chat's
 * or behind it; a folder with files of its own is refused, replacing nothing.
 */
async function buildSubmodule(top: string, codeDir: string, sm: SubmoduleMeta): Promise<void> {
  const r = sm.repo;
  if (!r) return;
  const at = join(top, sm.path);
  if (await checkedOut(at)) {
    if (await holds(at, r)) return;
    const changed = (await git(at, ["status", "--porcelain=v1", "-uno"])).stdout.trim();
    if (changed) throw new SnapshotError("taken", `${at} has changes of its own; nothing was replaced. Commit or move them away, or pick another folder.`);
    const head = (await git(at, ["rev-parse", "-q", "--verify", "HEAD"])).stdout.trim();
    await fetchSubmodule(at, codeDir, sm);
    if (head && head !== r.head && (await git(at, ["merge-base", "--is-ancestor", head, r.head])).code !== 0)
      throw new SnapshotError("taken", `${at} is at a commit the chat's submodule ${sm.key} doesn't build on; nothing was replaced. Pick another folder.`);
    const way = head ? await inTheWay(at, r, head) : [];
    if (way.length) throw new SnapshotError("taken", `${at} already has ${way.slice(0, 3).join(", ")}${way.length > 3 ? ` and ${way.length - 3} more` : ""}, which the chat's submodule adds; nothing was replaced. Move ${way.length === 1 ? "it" : "them"} away or pick another folder.`);
  } else {
    await mkdir(at, { recursive: true });
    if ((await readdir(at)).length) throw new SnapshotError("taken", `${at} already has files where the chat's submodule ${sm.key} goes; nothing was replaced. Move them away or pick another folder.`);
    const gitDir = await realOr((await ok(top, ["rev-parse", "--absolute-git-dir"], "Reading the repository")).trim());
    const mod = join(gitDir, "modules", sm.name);
    await mkdir(mod, { recursive: true });
    await ok(top, ["init", "-q", "--bare", mod], `Making the submodule ${sm.key}`);
    await connectSubmodule(at, mod);
    await fetchSubmodule(at, codeDir, sm);
  }
  await checkOutSubmodule(at, r);
  await writeTracked(at, codeDir, r);
  await verifySubmodule(at, sm);
  const has = async (k: string) => (await git(top, ["config", "--get", k])).stdout.trim();
  if (sm.url && !(await has(`submodule.${sm.name}.url`))) await ok(top, ["config", `submodule.${sm.name}.url`, sm.url], "Recording the submodule's URL");
  if (!(await has(`submodule.${sm.name}.active`))) await ok(top, ["config", `submodule.${sm.name}.active`, "true"], "Marking the submodule active");
}

/** After a tree moved (its stage renamed into place), each checked-out submodule joined again to its repository in
    git's layout, nested ones too. A submodule whose `.git` names another existing repository is left as it is. */
async function reconnectSubmodules(dir: string): Promise<void> {
  const links = await gitlinksOf(dir);
  if (!links.length) return;
  const gitDir = await realOr((await ok(dir, ["rev-parse", "--absolute-git-dir"], "Reading the repository")).trim());
  for (const l of links) {
    const at = join(dir, l.path);
    const mod = join(gitDir, "modules", l.name);
    const file = join(at, ".git");
    if (!existsSync(mod) || !(await lstat(file).then((st) => st.isFile(), () => false))) continue;
    const named = /^gitdir: (.*)$/m.exec(await readFile(file, "utf8"))?.[1]?.trim() ?? "";
    const was = named.startsWith("/") ? named : join(at, named);
    if (existsSync(was) && (await realOr(was)) !== mod) continue;
    await connectSubmodule(at, mod);
    await reconnectSubmodules(at);
  }
}

/**
 * Rebuild every worktree of a package in its stage and check it (§app.transport/arrival). `repo` is
 * the destination's repository (null when the package carries the main checkout, which makes it).
 * `targets` maps each worktree's name to its folder there. Nothing is in place until `publishTrees`.
 */
async function fetchBundle(repo: string, codeDir: string, tid: string): Promise<void> {
  const v = await git(repo, ["bundle", "verify", "-q", join(codeDir, "commits.bundle")]);
  if (v.code !== 0) throw new SnapshotError("needs-base", "The repository there lacks commits the package builds on.");
  await ok(repo, [...NO_BACKGROUND_CLEANUP, "fetch", "-q", join(codeDir, "commits.bundle"), `+${refOf(tid, "*")}:${refOf(tid, "*")}`], "Fetching the bundle");
}

export async function rebuildWorktrees(o: {
  repo: string | null;
  codeDir: string;
  tid: string;
  metas: readonly WorktreeMeta[];
  targets: Record<string, string>;
  ours?: readonly string[];
  /** The repository the linked worktrees build on isn't there: it is made from the package (`repo` names its folder). */
  makeRepo?: RepoFromPackage;
  /** The recorded remote, for a repository the package builds whole (no credentials; null: none). */
  origin?: string | null;
}): Promise<StagedTree[]> {
  const ours = (target: string) => (o.ours ?? []).includes(target);
  const out: StagedTree[] = [];
  const main = o.metas.find((m) => m.main);
  let repo = o.repo;
  if (main) {
    const target = o.targets[main.name]!;
    // A folder there that is a checkout: the package's commits go into it first (its linked worktrees and the
    // checks build on them); anything else non-empty is refused by rebuildOne.
    const there = existsSync(join(target, ".git")) && (await readdir(target)).length > 0;
    let fetched = false;
    try {
      if (there) fetched = await fetchBundle(target, o.codeDir, o.tid).then(() => true, () => false);
      const held = fetched && (await holds(target, main));
      const base = fetched && !held ? await baseOf(target, main, ours(target), o.tid) : null;
      if (held) out.push(await heldTree(o.codeDir, main, target));
      else if (base && "head" in base) out.push(await baseTree(target, o.codeDir, main, target, base, ours(target)));
      else if (there) throw new SnapshotError("taken", base && "why" in base ? base.why : `${target} already exists there and holds another repository; pick another folder.`);
      else out.push(await rebuildOne(null, o.codeDir, o.tid, main, target, o.origin ?? null));
    } catch (err) {
      // The folder is someone's repository: what this attempt fetched into it goes with the failure.
      if (fetched) {
        const refs = (await git(target, ["for-each-ref", "--format=delete %(refname)", `refs/sova/transport/${o.tid}/`])).stdout;
        if (refs.trim()) await git(target, ["update-ref", "--stdin"], { input: refs });
      }
      throw err;
    }
    repo = out[0]!.stage;
  } else if (o.makeRepo) {
    const made = await makeRepo(o.makeRepo, o.codeDir, o.tid, o.metas);
    out.push(made);
    repo = made.stage;
  } else if (repo) {
    await fetchBundle(repo, o.codeDir, o.tid);
  }
  for (const m of o.metas) {
    if (m.main) continue;
    const target = o.targets[m.name]!;
    if (await holds(target, m)) {
      out.push(await heldTree(o.codeDir, m, target));
      continue;
    }
    if (repo && existsSync(join(target, ".git"))) {
      const base = await baseOf(target, m, ours(target), o.tid);
      if ("why" in base) throw new SnapshotError("taken", base.why);
      out.push(await baseTree(repo, o.codeDir, m, target, base, ours(target)));
      continue;
    }
    out.push(await rebuildOne(repo, o.codeDir, o.tid, m, target));
  }
  // A submodule never checked out where it came from arrives as its gitlink only, and the arrival says so.
  return out.map((t) => {
    const m = o.metas.find((x) => x.name === t.name);
    const left = m ? uninitialisedOf(m) : [];
    return left.length ? { ...t, uninitialised: left } : t;
  });
}

/** The keys of a tree's submodules (nested ones too) that travel as their gitlink only. */
function uninitialisedOf(meta: TrackedMeta): string[] {
  return (meta.submodules ?? []).flatMap((s) => (s.repo ? uninitialisedOf(s.repo) : [s.key]));
}

/** Move each staged tree into its folder (the main checkout first), then drop the transport's refs. A folder that
    already held the code gets the arrived loose files beside what is there (`from`: the source device, for the
    name a kept file's arrived copy takes). Where every ticked private file landed, and what was kept. */
export async function publishTrees(trees: readonly StagedTree[], tid: string, o: { from?: string } = {}): Promise<{ privateFiles: string[]; kept: KeptFile[] }> {
  const kept: KeptFile[] = [];
  const privateFiles: string[] = [];
  for (const t of trees) {
    if (t.base) await applyBase(t);
    const landed = t.loose ? await putLoose(t, o.from ?? "there", kept) : null;
    for (const p of t.private ?? []) privateFiles.push(join(t.target, landed?.get(p) ?? p));
  }
  await publishStages(trees, tid);
  return { privateFiles, kept };
}

/** The name git gives a worktree's records (`<common>/worktrees/<id>`) for a folder: its last part as a ref name may
    hold it, then a number while that name is taken. */
function adminIdFor(common: string, folder: string): string {
  const base = basename(folder).replace(/[\x00-\x20~^:?*[\\\x7f]/g, "-").replace(/\.\.+/g, "-").replace(/^\./, "-").replace(/\.lock$/, "-lock") || "worktree";
  if (!existsSync(join(common, "worktrees", base))) return base;
  for (let i = 1; ; i++) if (!existsSync(join(common, "worktrees", `${base}${i}`))) return `${base}${i}`;
}

/**
 * A worktree moved into place keeps the records git made for its staging folder (`worktrees/-incoming-…`; git's own
 * move keeps them too): they take the name git would give the folder it is in now, its `.git` names them there, and
 * git's link back is repaired. Nothing named for the staging folder is left.
 */
async function nameAdminFor(target: string, common: string): Promise<void> {
  const admin = await realOr((await ok(target, ["rev-parse", "--absolute-git-dir"], "Reading the worktree")).trim());
  const worktrees = join(await realOr(common), "worktrees");
  if (dirname(admin) !== worktrees || !basename(admin).startsWith("-incoming-")) return;
  const to = join(worktrees, adminIdFor(common, target));
  await rename(admin, to);
  await writeFile(join(target, ".git"), `gitdir: ${to}\n`);
  await ok(dirname(common), ["--git-dir", common, "worktree", "repair", target], "Repairing the worktree");
}

async function publishStages(trees: readonly StagedTree[], tid: string): Promise<void> {
  const main = trees.find((t) => t.main);
  let repo: string | null = null;
  if (main) {
    if (main.stage !== main.target) {
      await mkdir(dirname(main.target), { recursive: true });
      // An empty folder may stand where it goes; anything put there since the rebuild is never removed.
      if (existsSync(main.target)) {
        if ((await readdir(main.target)).length) throw new SnapshotError("taken", `${main.target} isn't empty any more there; nothing was removed. Empty it or pick another folder.`);
        await rmdir(main.target);
      }
      await rename(main.stage, main.target);
      // The linked stages still point at the main stage's old folder.
      const linked = trees.filter((t) => !t.main && t.stage !== t.target).map((t) => t.stage);
      if (linked.length) await ok(main.target, ["worktree", "repair", ...linked], "Repairing the worktrees");
    }
    repo = main.target;
  }
  for (const t of trees) {
    if (t.main || t.stage === t.target) continue;
    if (existsSync(t.target)) throw new SnapshotError("taken", `${t.target} exists there now; nothing was removed. Move it away or pick another folder.`);
    const { gitDir, common } = await gitDirs(t.stage);
    await mkdir(dirname(t.target), { recursive: true });
    // git won't move a worktree holding submodules: renamed, then git's records of it repaired.
    if (existsSync(join(gitDir, "modules"))) {
      await rename(t.stage, t.target);
      await ok(dirname(common), ["--git-dir", common, "worktree", "repair", t.target], `Moving ${t.name} into place`);
    } else await ok(dirname(common), ["--git-dir", common, "worktree", "move", t.stage, t.target], `Moving ${t.name} into place`);
    await nameAdminFor(t.target, common);
    repo ??= dirname(common);
  }
  if (main) for (const t of trees) if (!t.main) await git(main.target, ["worktree", "repair", t.target]);
  // Each submodule's repository and folder name each other again where they are now.
  for (const t of trees) if (t.stage !== t.target) await reconnectSubmodules(t.target);
  const at = repo ?? (trees[0] ? trees[0].target : null);
  if (at) {
    const refs = (await git(at, ["for-each-ref", "--format=delete %(refname)", `refs/sova/transport/${tid}/`])).stdout;
    if (refs.trim()) await git(at, ["update-ref", "--stdin"], { input: refs });
  }
}

/** Remove what a rebuild left (Cancel, or a failed attempt): the stages, their registrations, the refs. */
export async function dropStages(trees: readonly { stage: string; target: string; main: boolean }[], repo: string | null, tid: string): Promise<void> {
  for (const t of trees) {
    if (t.stage === t.target) continue;
    if (!t.main && repo) await git(repo, ["worktree", "remove", "--force", t.stage]);
    await rm(t.stage, { recursive: true, force: true });
  }
  if (repo && existsSync(repo)) {
    await git(repo, ["worktree", "prune"]);
    const refs = (await git(repo, ["for-each-ref", "--format=delete %(refname)", `refs/sova/transport/${tid}/`])).stdout;
    if (refs.trim()) await git(repo, ["update-ref", "--stdin"], { input: refs });
  }
}

/** sizes for the dialog */
export const looseBytes = (s: WorktreeSurvey, kinds: LooseFile["kind"][]): number => s.loose.filter((f) => kinds.includes(f.kind)).reduce((n, f) => n + f.size, 0);

/** Whether a stat of `p` works (a tiny helper the arrival shares). */
export async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}
