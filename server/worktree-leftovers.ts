// What removing a worktree would delete that can't be rebuilt (§chat.worktrees/cleanup): its
// uncommitted and untracked files, its ignored files outside the rebuildable folders, and any
// repository or worktree nested inside it. `git worktree remove` without --force refuses only
// uncommitted and untracked files: it deletes ignored files, and a repository nested under an
// ignored folder with its uncommitted work, without a word. Every cleanup that removes a tree (Clean
// Up Merged, archive with worktree removal, a project-services teardown) reads this first and keeps a
// tree that holds any; Remove Anyway lists exactly this and removes only when it is unchanged. This file
// is the only answer in Sova to "what can't be rebuilt": no project, list or other rule adds to it.
//
// Read-only: git by argv under --no-optional-locks (server/worktrees.ts execGit), the folders by
// lstat, never following a symlink. A read that fails keeps the tree (`unreadable`).
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorktreeRemoveAnyway } from "../shared/protocol";
import { execGit, type GitRunner } from "./worktrees";

/** Dependency and build-output folders and caches: deleted with the tree, rebuilt on demand. */
const REBUILDABLE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".cache",
  ".turbo",
  ".vite",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".parcel-cache",
  ".cpcache",
  ".shadow-cljs",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".gradle",
]);
export const rebuildableDir = (name: string): boolean => REBUILDABLE_DIRS.has(name) || /^dist-[^/]+$/.test(name);
/** Rebuildable files wherever they are. */
const rebuildableFile = (name: string): boolean => name === ".DS_Store" || name.endsWith(".tsbuildinfo") || name.endsWith(".pyc");
/** The spec tools' own review folders: copies of what they review, never the only copy of work. Drafts need proof. */
const SPEC_REVIEW_DIRS = [".sova/spec/reviews/", ".sova/spec/assessments/"];
const DRAFTS_PREFIX = ".sova/spec/drafts/";
/** The draft a path is in (its folder under `.sova/spec/drafts`), or null: a file directly in that folder is in no draft. */
const draftOf = (rel: string): string | null => {
  if (!rel.startsWith(DRAFTS_PREFIX)) return null;
  const rest = rel.slice(DRAFTS_PREFIX.length);
  const cut = rest.indexOf("/");
  return cut > 0 ? rest.slice(0, cut) : null;
};
/** Ignored video files: a recording, which goes only when the same bytes outlive this removal. */
export const RECORDING = /\.(mp4|webm|mov|mkv)$/i;
/** Inside a folder of the user's own, only these tools' folders count as rebuildable: a "dist" or "out" in
    someone's ignored notes isn't build output. The generic names count where git lists the folder itself. */
const TOOL_DIRS = new Set(["node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"]);
/** Folders never walked: a package manager's tree is huge and its own. */
const UNWALKED = new Set(["node_modules"]);

/** What a hermetic agent dir (scripts/hermetic-agent-dir.mjs) generates: these files, any symlink, empty folders. */
const AGENT_GENERATED_FILES = new Set(["settings.json", "trust.json", "copied-sessions.json", "models.json", "keybindings.json", "vision-delegate.json", "sova/auth-token"]);
const AGENT_GENERATED_DIRS = ["sandbox-policy/", "extensions/"];

/** Entries walked per tree at most: past it the tree is kept, its contents too many to list exactly. */
export const MAX_ENTRIES = 200_000;

export interface NestedRepo {
  /** Relative to the tree's top. */
  path: string;
  kind: "repository" | "worktree";
  /** A nested worktree's repository (its gitdir's owner), when its `.git` file says. */
  of?: string;
}

/** What a test copy of Sova left in a finished or empty tree (§chat.worktrees/leftovers): it no longer keeps the tree. */
export interface TestCopyLeft {
  /** Test chats no real chat holds in full: moved aside before the folder goes. Under `.agent`. */
  keepAside: string[];
  /** Test chats a real chat holds in full. */
  copies: string[];
  /** `auth.json` and `claude-accounts/`, deleted for good. */
  login: string[];
  /** The rest of that `.agent`. */
  state: string[];
  /** Ignored `*.log` files. */
  logs: string[];
  /** Ignored recordings whose bytes outlive this removal. */
  recordings: string[];
}

/** What only a finished or empty tree's removal can ask: the answers that let a test copy's leavings go. */
export interface FinishedFacts {
  /** Whether a real chat holds all of this test chat's bytes. A string: it can't tell, and the chat keeps the tree. */
  heldByRealChat(abs: string): Promise<boolean | string>;
  /** Whether the same bytes outlive this removal. Throwing, or a string, is a doubt: the recording keeps the tree. */
  recordingElsewhere(rel: string, abs: string): Promise<boolean | string>;
}

export interface LeftoversOpts {
  /** The spec drafts in the tree proved landed, by name: only these go. A draft named nowhere here keeps the tree. */
  provedDrafts?: readonly string[];
  /** The tree is finished or empty: what a test copy left doesn't keep it. Absent: it does. */
  finished?: FinishedFacts;
}

/** Everything in a tree that isn't committed, sorted by kind. Paths are relative to its top. */
export interface Leftovers {
  /** Uncommitted changes and untracked files (git status), nested repositories aside. */
  dirty: string[];
  /** Ignored files outside the rebuildable folders, each file (a symlink as itself). */
  ignored: string[];
  /** Why an ignored `.agent` isn't rebuildable: "sessions", "auth.json", "server state". */
  agent?: string;
  nested: NestedRepo[];
  /** Rebuildable folders and files that go with it (a folder as "name/"). */
  rebuildable: string[];
  /** Ignored recordings found nowhere else: the last copy of each, and so kept. Finished or empty trees only. */
  lastRecordings?: string[];
  /** What a test copy left, let go. Finished or empty trees only. */
  testCopy?: TestCopyLeft;
  /** Set when anything couldn't be read: the tree is kept, Remove Anyway isn't offered. */
  unreadable?: string;
}

/** Whether removing the tree would lose anything that can't be rebuilt. */
export const holdsWork = (l: Leftovers): boolean => !!l.unreadable || l.dirty.length > 0 || l.ignored.length > 0 || l.nested.length > 0 || !!l.lastRecordings?.length;

const firstLine = (s: string, code: number | null): string => s.trim().split("\n")[0]?.trim() || `exit ${code}`;

/** NUL-separated porcelain v1 → paths (a rename's new name). */
function porcelainPaths(stdout: string): string[] {
  const out: string[] = [];
  const parts = stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e || e.length < 4) continue;
    out.push(e.slice(3));
    if (e[0] === "R" || e[0] === "C") i++;
  }
  return out;
}

class Unreadable extends Error {}

/** A `.git` entry below the top: a nested repository, or a worktree (its gitdir under some `worktrees/`). */
async function nestedAt(top: string, rel: string, isDir: boolean): Promise<NestedRepo> {
  if (isDir) return { path: rel, kind: "repository" };
  const text = await readFile(join(top, rel, ".git"), "utf8").catch(() => "");
  const gitdir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
  const m = gitdir ? /^(.*)\/\.git\/worktrees\/[^/]+$/.exec(gitdir) ?? /^(.*)\/worktrees\/[^/]+$/.exec(gitdir) : null;
  return m ? { path: rel, kind: "worktree", of: m[1] } : { path: rel, kind: "repository" };
}

interface Walk {
  top: string;
  entries: number;
  out: Leftovers;
}

/**
 * Walk `rel` (a folder or file under the top). `keep`: its files are listed as ignored; a
 * rebuildable folder inside switches to `rebuild`, where only nested repositories are looked for.
 */
async function walk(w: Walk, rel: string, mode: "keep" | "rebuild"): Promise<void> {
  if (++w.entries > MAX_ENTRIES) throw new Unreadable(`more than ${MAX_ENTRIES} files to list`);
  const abs = join(w.top, rel);
  let st;
  try {
    st = await lstat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Unreadable(`${rel}: ${(err as Error).message}`);
  }
  if (!st.isDirectory()) {
    // A symlink, wherever it is: removing the link keeps its target.
    if (mode === "keep") (st.isSymbolicLink() || rebuildableFile(rel.split("/").pop()!) ? w.out.rebuildable : w.out.ignored).push(rel);
    return;
  }
  let names: string[];
  try {
    names = await readdir(abs);
  } catch (err) {
    throw new Unreadable(`${rel}/: ${(err as Error).message}`);
  }
  if (names.includes(".git")) {
    const g = await lstat(join(abs, ".git")).catch(() => null);
    if (g) {
      w.out.nested.push(await nestedAt(w.top, rel, g.isDirectory()));
      return;
    }
  }
  for (const name of names.sort()) {
    const child = `${rel}/${name}`;
    if (mode === "rebuild" ? rebuildableDir(name) : TOOL_DIRS.has(name)) {
      const cst = await lstat(join(abs, name)).catch(() => null);
      if (cst?.isDirectory()) {
        if (mode === "keep") w.out.rebuildable.push(`${child}/`);
        if (!UNWALKED.has(name)) await walk(w, child, "rebuild");
        continue;
      }
    }
    await walk(w, child, mode);
  }
}

/** The ignored `.agent` folder: rebuildable when it holds only what a hermetic agent dir generates. */
async function agentDir(w: Walk, rel: string, finished?: FinishedFacts): Promise<void> {
  const files: string[] = [];
  let sessions = false;
  let auth = false;
  let other = false;
  const isLogin = (sub: string, name: string): boolean => name === "auth.json" || sub.startsWith("claude-accounts/") || sub.includes("/claude-accounts/");
  const visit = async (sub: string): Promise<void> => {
    if (++w.entries > MAX_ENTRIES) throw new Unreadable(`more than ${MAX_ENTRIES} files to list`);
    const abs = join(w.top, rel, sub);
    let st;
    try {
      st = await lstat(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Unreadable(`${rel}/${sub}: ${(err as Error).message}`);
    }
    if (st.isSymbolicLink()) return; // a generated link: removing it keeps its target
    if (st.isDirectory()) {
      let names: string[];
      try {
        names = await readdir(abs);
      } catch (err) {
        throw new Unreadable(`${rel}/${sub}/: ${(err as Error).message}`);
      }
      for (const n of names.sort()) {
        const child = sub ? `${sub}/${n}` : n;
        if (n === ".git") {
          const g = await lstat(join(abs, n)).catch(() => null);
          if (g) {
            w.out.nested.push(await nestedAt(w.top, sub ? `${rel}/${sub}` : rel, g.isDirectory()));
            continue;
          }
        }
        await visit(child);
      }
      return;
    }
    files.push(sub);
    const name = sub.split("/").pop()!;
    if (sub.startsWith("sessions/")) sessions = true;
    else if (isLogin(sub, name)) auth = true;
    else if (!AGENT_GENERATED_FILES.has(sub) && !AGENT_GENERATED_DIRS.some((d) => sub.startsWith(d))) other = true;
  };
  await visit("");
  if (!sessions && !auth && !other) {
    w.out.rebuildable.push(`${rel}/`);
    return;
  }
  if (finished) {
    const left = testCopyOf(w);
    const stuck: string[] = [];
    for (const sub of files) {
      const abs = join(w.top, rel, sub);
      if (sub.startsWith("sessions/") && !sub.startsWith("sessions/live/")) {
        // A chat a real one holds in full is that real chat's copy; anything else under sessions moves aside whole.
        const same = sub.endsWith(".jsonl") ? await finished.heldByRealChat(abs).catch((err: Error) => err.message) : false;
        if (typeof same === "string") stuck.push(sub);
        else (same ? left.copies : left.keepAside).push(`${rel}/${sub}`);
      } else (isLogin(sub, sub.split("/").pop()!) ? left.login : left.state).push(`${rel}/${sub}`);
    }
    if (!stuck.length) {
      w.out.rebuildable.push(`${rel}/`);
      return;
    }
    w.out.agent = "sessions";
    for (const f of stuck) w.out.ignored.push(`${rel}/${f}`);
    return;
  }
  w.out.agent = sessions ? "sessions" : auth ? "auth.json" : "server state";
  for (const f of files) w.out.ignored.push(`${rel}/${f}`);
}

const testCopyOf = (w: Walk): TestCopyLeft => (w.out.testCopy ??= { keepAside: [], copies: [], login: [], state: [], logs: [], recordings: [] });

/** What git says of a tree: its status, its ignored entries (a wholly ignored folder as "name/"), its submodules. */
interface GitListing {
  /** Uncommitted and untracked, as porcelain paths. */
  status: readonly string[];
  ignored: readonly string[];
  submodules: readonly NestedRepo[];
}

/** One rule over what git said of a tree: everything below runs for a working tree and for a folder git forgot alike. */
async function sorted(dir: string, listing: GitListing, opts: LeftoversOpts): Promise<Leftovers> {
  const out: Leftovers = { dirty: [], ignored: [], nested: [...listing.submodules], rebuildable: [] };
  const w: Walk = { top: dir, entries: 0, out };
  try {
    for (const p of listing.status) {
      // An untracked folder git lists whole is a nested repository (git doesn't look inside one).
      if (p.endsWith("/")) {
        const rel = p.slice(0, -1);
        const g = await lstat(join(dir, rel, ".git")).catch(() => null);
        if (g) out.nested.push(await nestedAt(dir, rel, g.isDirectory()));
        else await walkDirty(w, rel);
      } else out.dirty.push(p);
    }
    for (const raw of listing.ignored) {
      if (!raw) continue;
      const isDir = raw.endsWith("/");
      const rel = isDir ? raw.slice(0, -1) : raw;
      const segs = rel.split("/");
      const name = segs[segs.length - 1]!;
      if (rel === ".agent" && isDir) await agentDir(w, rel, opts.finished);
      // A file git lists by itself is judged by itself: its folder isn't wholly ignored, whatever its name.
      else if (isDir && (rebuildableDir(name) || rel === "tmp")) {
        out.rebuildable.push(`${rel}/`);
        if (!UNWALKED.has(name)) await walk(w, rel, "rebuild");
      } else if (!isDir && rebuildableFile(name)) out.rebuildable.push(rel);
      else await walk(w, rel, "keep");
    }
  } catch (err) {
    if (err instanceof Unreadable) return { ...out, unreadable: `Its files couldn't be read: ${err.message}` };
    throw err;
  }
  try {
    await letGo(w, opts);
  } catch (err) {
    if (err instanceof Unreadable) return { ...out, unreadable: `Its files couldn't be read: ${err.message}` };
    throw err;
  }
  for (const k of ["dirty", "ignored", "rebuildable"] as const) out[k] = [...new Set(out[k])].sort();
  out.nested = [...new Map(out.nested.map((n) => [n.path, n])).values()].sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** The ignored files the rule also lets go: the review folders, proved drafts, and in a finished tree logs and recordings. */
async function letGo(w: Walk, opts: LeftoversOpts): Promise<void> {
  const out = w.out;
  const kept: string[] = [];
  const proved = new Set(opts.provedDrafts ?? []);
  for (const rel of out.ignored) {
    if (SPEC_REVIEW_DIRS.some((d) => rel.startsWith(d))) {
      out.rebuildable.push(rel);
      continue;
    }
    const draft = draftOf(rel);
    if (draft !== null) {
      if (proved.has(draft)) out.rebuildable.push(rel);
      else kept.push(rel);
      continue;
    }
    if (opts.finished && rel !== ".agent" && !rel.startsWith(".agent/")) {
      const name = rel.split("/").pop()!;
      if (name.endsWith(".log")) {
        testCopyOf(w).logs.push(rel);
        continue;
      }
      if (RECORDING.test(name)) {
        const there = await opts.finished.recordingElsewhere(rel, join(w.top, rel)).catch((err: Error) => err.message);
        if (there === true) testCopyOf(w).recordings.push(rel);
        else (out.lastRecordings ??= []).push(rel);
        continue;
      }
    }
    kept.push(rel);
  }
  out.ignored = kept;
}

/**
 * What removing the tree at `dir` would delete that isn't in git: read fresh every call. `git`
 * defaults to the read-only runner (no optional locks).
 */
export async function leftovers(dir: string, git: GitRunner = execGit, opts: LeftoversOpts = {}): Promise<Leftovers> {
  const empty: Leftovers = { dirty: [], ignored: [], nested: [], rebuildable: [] };
  const st = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: dir });
  if (st.code !== 0) return { ...empty, unreadable: `Git couldn't read it: ${firstLine(st.stderr || st.stdout, st.code)}` };
  const ig = await git(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], { cwd: dir });
  if (ig.code !== 0) return { ...empty, unreadable: `Git couldn't list its ignored files: ${firstLine(ig.stderr || ig.stdout, ig.code)}` };
  // A skip-worktree or assume-unchanged file is invisible to status, and an edit under the flag would go with the tree.
  const flags = await git(["ls-files", "-v", "-z"], { cwd: dir });
  if (flags.code !== 0) return { ...empty, unreadable: `Git couldn't read it: ${firstLine(flags.stderr || flags.stdout, flags.code)}` };
  const flagged = flags.stdout.split("\0").filter((e) => e.length > 2 && (e[0] === "S" || /[a-z]/.test(e[0]!))).map((e) => e.slice(2));
  // Initialised submodules: clean ones show nowhere else, and --force takes their git dirs with the tree.
  const sub = await git(["submodule", "status", "--recursive"], { cwd: dir });
  if (sub.code !== 0) return { ...empty, unreadable: `Git couldn't read its submodules: ${firstLine(sub.stderr || sub.stdout, sub.code)}` };
  const submodules: NestedRepo[] = [];
  for (const line of sub.stdout.split("\n")) {
    const m = /^([ +U])[0-9a-f]+ (.+?)(?: \(.*\))?$/.exec(line);
    if (m) submodules.push({ path: m[2]!, kind: "repository" });
  }
  return sorted(dir, { status: [...porcelainPaths(st.stdout), ...flagged], ignored: ig.stdout.split("\0"), submodules }, opts);
}

/** check-ignore's argv at one go. */
const BATCH = 200;

/** Which of `paths` (relative, `/`-separated) the repository's own ignore rules cover; a directory is asked with a trailing slash. */
async function ignoredOf(git: GitRunner, main: string, paths: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < paths.length; i += BATCH) {
    // Not -z (it needs stdin, and no runner here pipes one). Quoted names, a tab or newline in them, then match nothing
    // and read as not ignored, which holds the folder.
    const r = await git(["-c", "core.quotepath=off", "check-ignore", "--no-index", "--", ...paths.slice(i, i + BATCH)], { cwd: main });
    if (r.code !== 0 && r.code !== 1) throw new Unreadable(`git check-ignore: ${firstLine(r.stderr || r.stdout, r.code)}`);
    for (const p of r.stdout.split("\n")) if (p) out.add(p);
  }
  return out;
}

/** What git would list for a folder it has forgotten: top down, asking the repository's own ignore rules. A wholly ignored folder isn't walked. */
async function folderListing(top: string, main: string, git: GitRunner): Promise<{ untracked: string[]; ignored: string[] }> {
  const untracked: string[] = [];
  const ignored: string[] = [];
  let level: string[] = [""];
  let entries = 0;
  while (level.length) {
    const next: string[] = [];
    const here: { rel: string; dir: boolean }[] = [];
    for (const parent of level) {
      let names;
      try {
        names = await readdir(join(top, parent), { withFileTypes: true });
      } catch (err) {
        throw new Unreadable(`${parent || "."}/: ${(err as Error).message}`);
      }
      for (const e of names) {
        if (!parent && e.name === ".git") continue; // a stale pointer: its proof already said it holds nothing
        if (++entries > MAX_ENTRIES) throw new Unreadable(`more than ${MAX_ENTRIES} files to list`);
        const rel = parent ? `${parent}/${e.name}` : e.name;
        if (e.isSymbolicLink()) continue; // deleted with the folder, its target kept
        if (!e.isDirectory() && !e.isFile()) throw new Unreadable(`${rel} isn't a regular file`);
        here.push({ rel, dir: e.isDirectory() });
      }
    }
    const listed = await ignoredOf(git, main, here.map((h) => (h.dir ? `${h.rel}/` : h.rel)));
    for (const h of here) {
      if (listed.has(h.dir ? `${h.rel}/` : h.rel)) ignored.push(h.dir ? `${h.rel}/` : h.rel);
      else if (!h.dir) untracked.push(h.rel);
      // A repository inside: `sorted` names it, as for a working tree.
      else if (await lstat(join(top, h.rel, ".git")).catch(() => null)) untracked.push(`${h.rel}/`);
      else next.push(h.rel);
    }
    level = next;
  }
  return { untracked, ignored };
}

/** Blobs some ref reaches: what outlives git's own tidy-up (a dangling blob doesn't). Kept briefly: a stale answer here can only be a hold. */
const reachable = new Map<string, { at: number; blobs: Set<string> }>();
export async function reachableBlobs(git: GitRunner, main: string): Promise<Set<string>> {
  const now = Date.now();
  const hit = reachable.get(main);
  if (hit && now - hit.at < 60_000) return hit.blobs;
  const r = await git(["rev-list", "--objects", "--no-object-names", "--all"], { cwd: main });
  // A list that couldn't be read says nothing is reachable, which holds.
  const blobs = new Set(r.code === 0 ? r.stdout.split("\n").filter(Boolean) : []);
  reachable.set(main, { at: now, blobs });
  return blobs;
}

/** Which of `files` (absolute) the repository has, by content, and some ref reaches: hashed unfiltered, as a filtered file would read as new. */
async function inGit(git: GitRunner, main: string, files: readonly string[]): Promise<Set<string>> {
  const known = new Set<string>();
  if (!files.length) return known;
  const tree = await git(["ls-tree", "-r", "HEAD"], { cwd: main });
  const blobs = new Set(tree.code === 0 ? tree.stdout.split("\n").map((l) => l.split(/\s+/)[2]).filter(Boolean) : []);
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const hashed = await git(["hash-object", "--no-filters", "--", ...batch], { cwd: main });
    if (hashed.code !== 0) throw new Unreadable(`git hash-object: ${firstLine(hashed.stderr || hashed.stdout, hashed.code)}`);
    const oids = hashed.stdout.trim().split("\n");
    if (oids.length !== batch.length) throw new Unreadable("git hash-object: its answer didn't match the files asked about");
    for (let j = 0; j < batch.length; j++) {
      if (blobs.has(oids[j]!) || (await reachableBlobs(git, main)).has(oids[j]!)) known.add(batch[j]!);
    }
  }
  return known;
}

/**
 * The same rule for a folder with no working `.git`, what a partial delete leaves (§chat.worktrees/cleanup): judged by
 * the repository's own ignore rules from its main checkout, and a file already in git by content is no leftover. A
 * draft is never cleared by content: only by its proof.
 */
export async function leftoversOfFolder(dir: string, main: string, git: GitRunner = execGit, opts: LeftoversOpts = {}): Promise<Leftovers> {
  const empty: Leftovers = { dirty: [], ignored: [], nested: [], rebuildable: [] };
  try {
    const listed = await folderListing(dir, main, git);
    // A draft's files are one kind whether or not this repository's rules ignore them: `letGo` asks its proof.
    const isDraft = (p: string): boolean => p.startsWith(DRAFTS_PREFIX);
    const l = await sorted(dir, { status: listed.untracked.filter((p) => !isDraft(p)), ignored: [...listed.ignored, ...listed.untracked.filter(isDraft)], submodules: [] }, opts);
    if (l.unreadable) return l;
    const asked = [...l.dirty, ...l.ignored].filter((rel) => !rel.startsWith(DRAFTS_PREFIX));
    const have = await inGit(git, main, asked.map((rel) => join(dir, rel)));
    const here = (rel: string): boolean => have.has(join(dir, rel));
    return { ...l, dirty: l.dirty.filter((r) => !here(r)), ignored: l.ignored.filter((r) => !here(r)) };
  } catch (err) {
    if (err instanceof Unreadable) return { ...empty, unreadable: `Its files couldn't be read: ${err.message}` };
    throw err;
  }
}

/** An untracked folder git listed as "dir/" though not a repository (it does with -uall only for those): its files. */
async function walkDirty(w: Walk, rel: string): Promise<void> {
  const before = w.out.ignored.length;
  await walk(w, rel, "keep");
  // Files walked here are untracked, not ignored.
  w.out.dirty.push(...w.out.ignored.splice(before));
}

/** The digest Remove Anyway confirms: every path it would delete, by kind. */
export function leftoversDigest(l: Leftovers): string {
  const h = createHash("sha256");
  h.update(JSON.stringify({ d: l.dirty, i: l.ignored, n: l.nested.map((n) => `${n.kind}:${n.path}`), r: l.rebuildable }));
  return h.digest("hex").slice(0, 32);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const some = (items: string[], max = 2): string => (items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} and ${items.length - max} more`);

/** Ignored files grouped by their top folder, for the reason: "local.env", ".agent (sessions)", "notes/ (3 files)". */
function ignoredGroups(l: Leftovers): string[] {
  const groups = new Map<string, number>();
  for (const f of l.ignored) {
    const top = f.includes("/") ? `${f.split("/")[0]}/` : f;
    groups.set(top, (groups.get(top) ?? 0) + 1);
  }
  return [...groups].map(([top, n]) => (top === ".agent/" ? `.agent (${l.agent ?? "state"})` : top.endsWith("/") ? `${top} (${plural(n, "file")})` : top));
}

/** The one reason a tree holding work is kept, or null when it holds none. */
export function leftoversReason(l: Leftovers): string | null {
  if (l.unreadable) return l.unreadable.endsWith(".") ? l.unreadable : `${l.unreadable}.`;
  if (!holdsWork(l)) return null;
  const parts: string[] = [];
  // "1 uncommitted file: a" · "3 uncommitted files: a and 2 more" (the copy deck's words).
  if (l.dirty.length) parts.push(`${plural(l.dirty.length, "uncommitted file")}: ${l.dirty.length === 1 ? l.dirty[0] : `${l.dirty[0]} and ${l.dirty.length - 1} more`}`);
  const ig = ignoredGroups(l);
  if (ig.length) parts.push(`${plural(l.ignored.length, "ignored file")}: ${some(ig)}`);
  if (l.nested.length) parts.push(`${plural(l.nested.length, "nested repository", "nested repositories")}: ${some(l.nested.map((n) => n.path))}`);
  if (l.lastRecordings?.length) parts.push(`${plural(l.lastRecordings.length, "recording")} found nowhere else: ${l.lastRecordings[0]}${l.lastRecordings.length > 1 ? ` and ${l.lastRecordings.length - 1} more` : ""}`);
  // Only uncommitted files: worded as before.
  if (!ig.length && !l.nested.length && !l.lastRecordings?.length) return `${parts[0]}.`;
  return `Holds what can't be rebuilt: ${parts.join("; ")}.`;
}

/** Remove Anyway's listing of a tree kept only for what it holds: each list's first entries, the exact counts, the digest. */
export const REMOVE_ANYWAY_LIST = 500;
export function removeAnywayOf(l: Leftovers): WorktreeRemoveAnyway {
  const cap = <T,>(xs: T[]): T[] => xs.slice(0, REMOVE_ANYWAY_LIST);
  return {
    uncommitted: cap(l.dirty),
    ignored: cap(l.ignored),
    nested: cap(l.nested).map((n) => ({ path: n.path, kind: n.kind, ...(n.of ? { of: n.of } : {}) })),
    rebuildable: cap(l.rebuildable),
    counts: { uncommitted: l.dirty.length, ignored: l.ignored.length, nested: l.nested.length, rebuildable: l.rebuildable.length },
    digest: leftoversDigest(l),
  };
}

/** A read that threw, as a Leftovers that keeps the tree. */
export const unreadableLeftovers = (err: Error): Leftovers => ({ dirty: [], ignored: [], nested: [], rebuildable: [], unreadable: `Its files couldn't be read: ${err.message}` });
