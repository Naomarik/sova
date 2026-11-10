// What removing a worktree would delete that can't be rebuilt (§chat.worktrees/cleanup): its
// uncommitted and untracked files, its ignored files outside the rebuildable folders, and any
// repository or worktree nested inside it. `git worktree remove` without --force refuses only
// uncommitted and untracked files: it deletes ignored files, and a repository nested under an
// ignored folder with its uncommitted work, without a word. Every cleanup that removes a tree (Clean
// Up Merged, archive with worktree removal, a project-services teardown) reads this first and keeps a
// tree that holds any; Remove Anyway lists exactly this and removes only when it is unchanged.
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
const rebuildableDir = (name: string): boolean => REBUILDABLE_DIRS.has(name) || /^dist-[^/]+$/.test(name);
/** Rebuildable files wherever they are. */
const rebuildableFile = (name: string): boolean => name === ".DS_Store" || name.endsWith(".tsbuildinfo") || name.endsWith(".pyc");
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
  /** Set when anything couldn't be read: the tree is kept, Remove Anyway isn't offered. */
  unreadable?: string;
}

/** Whether removing the tree would lose anything that can't be rebuilt. */
export const holdsWork = (l: Leftovers): boolean => !!l.unreadable || l.dirty.length > 0 || l.ignored.length > 0 || l.nested.length > 0;

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
    if (mode === "keep" && !rebuildableFile(rel.split("/").pop()!)) w.out.ignored.push(rel);
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
async function agentDir(w: Walk, rel: string): Promise<void> {
  const files: string[] = [];
  let sessions = false;
  let auth = false;
  let other = false;
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
    else if (name === "auth.json" || sub.startsWith("claude-accounts/") || sub.includes("/claude-accounts/")) auth = true;
    else if (!AGENT_GENERATED_FILES.has(sub) && !AGENT_GENERATED_DIRS.some((d) => sub.startsWith(d))) other = true;
  };
  await visit("");
  if (!sessions && !auth && !other) {
    w.out.rebuildable.push(`${rel}/`);
    return;
  }
  w.out.agent = sessions ? "sessions" : auth ? "auth.json" : "server state";
  for (const f of files) w.out.ignored.push(`${rel}/${f}`);
}

/**
 * What removing the tree at `dir` would delete that isn't in git: read fresh every call. `git`
 * defaults to the read-only runner (no optional locks).
 */
export async function leftovers(dir: string, git: GitRunner = execGit): Promise<Leftovers> {
  const out: Leftovers = { dirty: [], ignored: [], nested: [], rebuildable: [] };
  const st = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: dir });
  if (st.code !== 0) return { ...out, unreadable: `Git couldn't read it: ${firstLine(st.stderr || st.stdout, st.code)}` };
  const w: Walk = { top: dir, entries: 0, out };
  try {
    for (const p of porcelainPaths(st.stdout)) {
      // An untracked folder git lists whole is a nested repository (git doesn't look inside one).
      if (p.endsWith("/")) {
        const rel = p.slice(0, -1);
        const g = await lstat(join(dir, rel, ".git")).catch(() => null);
        if (g) out.nested.push(await nestedAt(dir, rel, g.isDirectory()));
        else await walkDirty(w, rel);
      } else out.dirty.push(p);
    }
    const ig = await git(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], { cwd: dir });
    if (ig.code !== 0) return { ...out, unreadable: `Git couldn't list its ignored files: ${firstLine(ig.stderr || ig.stdout, ig.code)}` };
    // Initialised submodules: clean ones show nowhere else, and --force takes their git dirs with the tree.
    const sub = await git(["submodule", "status", "--recursive"], { cwd: dir });
    if (sub.code !== 0) return { ...out, unreadable: `Git couldn't read its submodules: ${firstLine(sub.stderr || sub.stdout, sub.code)}` };
    for (const line of sub.stdout.split("\n")) {
      const m = /^([ +U])[0-9a-f]+ (.+?)(?: \(.*\))?$/.exec(line);
      if (m) out.nested.push({ path: m[2]!, kind: "repository" });
    }
    for (const raw of ig.stdout.split("\0")) {
      if (!raw) continue;
      const isDir = raw.endsWith("/");
      const rel = isDir ? raw.slice(0, -1) : raw;
      const segs = rel.split("/");
      const name = segs[segs.length - 1]!;
      if (rel === ".agent" && isDir) await agentDir(w, rel);
      // A file git lists by itself is judged by itself: its folder isn't wholly ignored, whatever its name.
      else if (isDir && rebuildableDir(name)) {
        out.rebuildable.push(`${rel}/`);
        if (!UNWALKED.has(name)) await walk(w, rel, "rebuild");
      } else if (!isDir && rebuildableFile(name)) out.rebuildable.push(rel);
      else await walk(w, rel, "keep");
    }
  } catch (err) {
    if (err instanceof Unreadable) return { ...out, unreadable: `Its files couldn't be read: ${err.message}` };
    throw err;
  }
  for (const k of ["dirty", "ignored", "rebuildable"] as const) out[k] = [...new Set(out[k])].sort();
  out.nested = [...new Map(out.nested.map((n) => [n.path, n])).values()].sort((a, b) => a.path.localeCompare(b.path));
  return out;
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
  // Only uncommitted files: worded as before.
  if (!ig.length && !l.nested.length) return `${parts[0]}.`;
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
