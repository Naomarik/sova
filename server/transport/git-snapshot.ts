// A chat's code, carried exactly (§app.transport/package, §app.transport/arrival,
// §app.transport/edge-cases): per worktree, a snapshot of HEAD, then the index, then the working
// tree, as two commits on top of HEAD, made in a scratch object store that borrows the source's
// objects (no ref, index or file of the source changes); one bundle for every worktree; one tar of
// the files git doesn't hold (untracked files, scratch folders, the ticked private files). Rebuilt on
// the destination in a staging worktree, checked by the tracked status and every carried file's
// hash, and moved into place only at publish. Dependencies and build output are never carried.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
      ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args],
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
  const staged = await git(path, ["ls-files", "-s", "-z"]);
  if (nul(staged.stdout).some((l) => l.startsWith("160000 "))) return "It has submodules: finish or remove that first.";
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
      if (leftFile(n)) continue;
      out.push({ path: r, size: st.isFile() ? st.size : 0, kind });
      total += st.isFile() ? st.size : 0;
    }
  }
  return total;
}

/** What one worktree would carry, and whether it can travel. Reads only. */
export async function surveyWorktree(name: string, path: string): Promise<WorktreeSurvey> {
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
      if (st) loose.push({ path: p, size: st.isFile() ? st.size : 0, kind: "untracked" });
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
        if (st) loose.push({ path: p, size: st.isFile() ? st.size : 0, kind: "private" });
      }
    }
    if (nested.length) refusal = "It has nested repositories: finish or remove that first.";
  }
  return { name, path: top, branch, head, refusal, loose, scratch, left, roots, remotes, main };
}

// ---- the pack -----------------------------------------------------------------------------------

export interface WorktreeMeta {
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
  /** Every carried loose file: its sha256, or `L <target>` for a link. */
  files: Record<string, string>;
  /** This repository's own ignore rules (`info/exclude`), carried so a file hidden here is hidden there. */
  exclude?: string;
  main: boolean;
}

/** The transport's refs in the bundle: one per worktree. */
const refOf = (tid: string, name: string) => `refs/sova/transport/${tid}/${name}`;

async function statusSha(path: string): Promise<string> {
  return sha256(await ok(path, ["status", "--porcelain=v1", "-z", "-uno"], "Reading the status"));
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
}): Promise<{ metas: WorktreeMeta[]; bundle: string }> {
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
  try {
    for (const t of o.trees) {
      const { gitDir } = await gitDirs(t.path);
      const wo = join(o.outDir, t.name);
      await mkdir(wo, { recursive: true, mode: 0o700 });
      const tmpIndex = join(o.outDir, `.index.${t.name}`);
      if (existsSync(join(gitDir, "index"))) await copyFile(join(gitDir, "index"), tmpIndex);
      else await rm(tmpIndex, { force: true });
      const env = { ...SNAP_ENV, GIT_OBJECT_DIRECTORY: join(scratchGit, "objects"), GIT_ALTERNATE_OBJECT_DIRECTORIES: join(common, "objects"), GIT_INDEX_FILE: tmpIndex };
      const indexTree = (await ok(t.path, ["write-tree"], "Reading the index", { env })).trim();
      // Index flags that hide files from `add -u` and from the status: carried as lists, cleared in the copy.
      const flags = (await ok(t.path, ["ls-files", "-v", "-z"], "Reading index flags")).split("\0").filter(Boolean);
      const skip = flags.filter((l) => l.startsWith("S ") || l.startsWith("s ")).map((l) => l.slice(2));
      const assume = flags.filter((l) => /^[a-z] /.test(l)).map((l) => l.slice(2));
      const ita = nul(await ok(t.path, ["status", "--porcelain=v2", "-z", "-uno"], "Reading the status"))
        .filter((l) => /^1 \.A /.test(l) && /^0+$/.test(l.split(" ")[7] ?? ""))
        .map((l) => l.split(" ").slice(8).join(" "));
      if (skip.length) await ok(t.path, ["update-index", "-z", "--no-skip-worktree", "--stdin"], "Clearing skip-worktree in the copy", { env, input: skip.join("\0") });
      if (assume.length) await ok(t.path, ["update-index", "-z", "--no-assume-unchanged", "--stdin"], "Clearing assume-unchanged in the copy", { env, input: assume.join("\0") });
      await ok(t.path, ["add", "-u"], "Snapshotting the working tree", { env });
      const workTree = (await ok(t.path, ["write-tree"], "Snapshotting the working tree", { env })).trim();
      const ci = (await ok(t.path, ["commit-tree", indexTree, "-p", t.head, "-m", "index"], "Snapshotting the index", { env })).trim();
      const ct = (await ok(t.path, ["commit-tree", workTree, "-p", ci, "-m", "worktree"], "Snapshotting the working tree", { env })).trim();
      await rm(tmpIndex, { force: true });
      await ok(o.outDir, ["--git-dir", scratchGit, "update-ref", refOf(o.tid, t.name), ct], "Recording the snapshot");
      refs.push(refOf(o.tid, t.name));
      // The loose files, by tar: full modes and links (git keeps only the executable bit).
      const files: Record<string, string> = {};
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
      }
      await writeTar(join(wo, "loose.tar"), entries);
      let exclude: string | undefined;
      try {
        const ex = await readFile(join(common, "info", "exclude"), "utf8");
        if (ex.split("\n").some((l) => l.trim() && !l.startsWith("#"))) exclude = ex;
      } catch {
        // no exclude file
      }
      const meta: WorktreeMeta = { name: t.name, branch: t.branch, head: t.head, snap: ct, statusSha: await statusSha(t.path), ita, skip, assume, files, ...(exclude ? { exclude } : {}), main: t.main };
      await writeFile(join(wo, "worktree.json"), `${JSON.stringify(meta)}\n`, { mode: 0o600 });
      metas.push(meta);
    }
    const bundle = join(o.outDir, "commits.bundle");
    const nots: string[] = [];
    for (const h of o.haves) if (/^[0-9a-f]{40,64}$/.test(h) && (await git(o.outDir, ["--git-dir", scratchGit, "cat-file", "-e", `${h}^{commit}`])).code === 0) nots.push(`^${h}`);
    let made = await git(o.outDir, ["--git-dir", scratchGit, "bundle", "create", "-q", bundle, ...refs, ...nots]);
    // Everything already there (a repack of a state the destination took): a whole bundle instead.
    if (made.code !== 0 && nots.length) made = await git(o.outDir, ["--git-dir", scratchGit, "bundle", "create", "-q", bundle, ...refs]);
    if (made.code !== 0) throw new SnapshotError("git", `Making the bundle: ${made.stderr.trim()}`);
    return { metas, bundle };
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
}

const stageOf = (target: string, tid: string) => join(dirname(target), `.incoming-${tid}-${basename(target)}`);

/** Whether `target` already holds exactly this worktree (a retry after publish). */
async function holds(target: string, meta: WorktreeMeta): Promise<boolean> {
  if (!existsSync(join(target, ".git"))) return false;
  const head = (await git(target, ["rev-parse", "-q", "--verify", "HEAD"])).stdout.trim();
  return head === meta.head && (await statusSha(target).catch(() => "")) === meta.statusSha;
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

/** Rebuild one worktree at its stage (idempotent: a stage left by a dead attempt is replaced). */
async function rebuildOne(repo: string | null, codeDir: string, tid: string, meta: WorktreeMeta, target: string): Promise<StagedTree> {
  const stage = stageOf(target, tid);
  const wo = join(codeDir, meta.name);
  if (meta.main) {
    // The repository itself: built whole beside its folder, published by one rename.
    if (existsSync(target) && (await readdir(target)).length) throw new SnapshotError("taken", `${target} already exists there; pick another folder.`);
    await rm(stage, { recursive: true, force: true });
    await mkdir(stage, { recursive: true });
    await ok(stage, ["init", "-q"], "Making the repository");
    await ok(stage, ["fetch", "-q", join(codeDir, "commits.bundle"), `+${refOf(tid, "*")}:${refOf(tid, "*")}`], "Fetching the bundle");
    if (meta.branch) {
      await ok(stage, ["update-ref", `refs/heads/${meta.branch}`, meta.head], "Making the branch");
      await ok(stage, ["symbolic-ref", "HEAD", `refs/heads/${meta.branch}`], "Checking out the branch");
    } else await ok(stage, ["update-ref", "--no-deref", "HEAD", meta.head], "Checking out the commit");
    await finishStage(stage, wo, meta);
    return { name: meta.name, target, stage, branch: meta.branch, main: true };
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
  return { name: meta.name, target, stage, branch: b.branch, ...(b.renamedFrom ? { renamedFrom: b.renamedFrom } : {}), main: false };
}

async function finishStage(stage: string, wo: string, meta: WorktreeMeta): Promise<void> {
  // index = working tree = the source's working tree; then index = the source's index, files untouched.
  await ok(stage, ["read-tree", "--reset", "-u", `${meta.snap}^{tree}`], "Writing the working tree");
  await ok(stage, ["read-tree", "-m", `${meta.snap}^{tree}`, `${meta.snap}^^{tree}`], "Writing the index");
  await extractTar(join(wo, "loose.tar"), stage);
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
  await verify(stage, meta);
}

/**
 * Rebuild every worktree of a package in its stage and check it (§app.transport/arrival). `repo` is
 * the destination's repository (null when the package carries the main checkout, which makes it).
 * `targets` maps each worktree's name to its folder there. Nothing is in place until `publishTrees`.
 */
export async function rebuildWorktrees(o: { repo: string | null; codeDir: string; tid: string; metas: readonly WorktreeMeta[]; targets: Record<string, string> }): Promise<StagedTree[]> {
  const out: StagedTree[] = [];
  const main = o.metas.find((m) => m.main);
  let repo = o.repo;
  if (main) {
    const target = o.targets[main.name]!;
    if (await holds(target, main)) out.push({ name: main.name, target, stage: target, branch: main.branch, main: true });
    else out.push(await rebuildOne(null, o.codeDir, o.tid, main, target));
    repo = out[0]!.stage;
  } else if (repo) {
    const v = await git(repo, ["bundle", "verify", "-q", join(o.codeDir, "commits.bundle")]);
    if (v.code !== 0) throw new SnapshotError("needs-base", "The repository there lacks commits the package builds on.");
    await ok(repo, ["fetch", "-q", join(o.codeDir, "commits.bundle"), `+${refOf(o.tid, "*")}:${refOf(o.tid, "*")}`], "Fetching the bundle");
  }
  for (const m of o.metas) {
    if (m.main) continue;
    const target = o.targets[m.name]!;
    if (await holds(target, m)) {
      out.push({ name: m.name, target, stage: target, branch: m.branch, main: false });
      continue;
    }
    out.push(await rebuildOne(repo, o.codeDir, o.tid, m, target));
  }
  return out;
}

/** Move each staged tree into its folder (the main checkout first), then drop the transport's refs. */
export async function publishTrees(trees: readonly StagedTree[], tid: string): Promise<void> {
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
    const common = (await gitDirs(t.stage)).common;
    await mkdir(dirname(t.target), { recursive: true });
    await ok(dirname(common), ["--git-dir", common, "worktree", "move", t.stage, t.target], `Moving ${t.name} into place`);
    repo ??= dirname(common);
  }
  if (main) for (const t of trees) if (!t.main) await git(main.target, ["worktree", "repair", t.target]);
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
