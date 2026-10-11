import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Which registered project's folder a path is in: the deepest root it equals or sits
 * under (as written or by its real path); else, inside a linked git worktree, its main checkout's; else, for a path
 * that is gone, a worktree folder as Sova names them (`<root's parent>/.worktrees/<root's name>-…`). Git is never run:
 * a worktree is known by its `.git` file. Reads the disk only; pure otherwise.
 */

export interface RootedProject {
  id: string;
  root: string;
}

const real = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

/** `path` is `root` or inside it (both absolute and normalized). */
const within = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** The main checkout a linked worktree's `.git` file names (`gitdir: <checkout>/.git/worktrees/<n>`), or null. */
function mainCheckoutOf(dotGit: string): string | null {
  let text: string;
  try {
    text = readFileSync(dotGit, "utf8");
  } catch {
    return null;
  }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!m) return null;
  const gitdir = resolve(dirname(dotGit), m[1]!);
  const w = /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(gitdir);
  return w ? w[1]! : null;
}

/**
 * The matcher for one listing pass (or one check): `projects` are the candidates (the caller leaves archived ones
 * out); `exclude` is a folder whose paths never match (the agent dir: a remote session's placeholder cwd). Each
 * distinct path is decided once.
 */
export function folderMatcher(projects: readonly RootedProject[], exclude?: string): (cwd: string) => string | null {
  const roots = projects.flatMap((p) => {
    const lexical = resolve(p.root);
    const r = real(lexical);
    return r && r !== lexical ? [{ id: p.id, root: lexical }, { id: p.id, root: r }] : [{ id: p.id, root: lexical }];
  });
  const excluded = exclude ? [resolve(exclude), real(exclude)].filter((x): x is string => !!x) : [];
  const memo = new Map<string, string | null>();

  const deepest = (paths: readonly string[]): string | null => {
    let best: { id: string; len: number } | null = null;
    for (const path of paths) for (const r of roots) if (within(r.root, path) && (!best || r.root.length > best.len)) best = { id: r.id, len: r.root.length };
    return best?.id ?? null;
  };

  const decide = (cwd: string): string | null => {
    if (!cwd || !isAbsolute(cwd) || !roots.length) return null;
    const lexical = resolve(cwd);
    const r = real(lexical);
    const forms = r && r !== lexical ? [lexical, r] : [lexical];
    if (forms.some((f) => excluded.some((x) => within(x, f)))) return null;
    // 1. The root itself, or inside it.
    const direct = deepest(forms);
    if (direct) return direct;
    if (r) {
      // 2. Inside a linked worktree: up to the first `.git`; a file names the main checkout, a folder is a repository of its own.
      for (let dir = r; ; dir = dirname(dir)) {
        const dotGit = join(dir, ".git");
        let isFile: boolean | null = null;
        try {
          isFile = statSync(dotGit).isFile();
        } catch {
          // none here
        }
        if (isFile === false) return null;
        if (isFile) {
          const main = mainCheckoutOf(dotGit);
          if (!main) return null;
          const mapped = join(main, relative(dir, r));
          return deepest([mapped, real(main) ? join(real(main)!, relative(dir, r)) : mapped]);
        }
        if (dirname(dir) === dir) return null;
      }
    }
    // 3. Gone: a worktree folder as Sova names them, beside the root.
    let best: { id: string; len: number } | null = null;
    for (const x of roots) {
      const prefix = join(dirname(x.root), ".worktrees", `${basename(x.root)}-`);
      if (forms.some((f) => f.startsWith(prefix) && f.length > prefix.length) && (!best || prefix.length > best.len)) best = { id: x.id, len: prefix.length };
    }
    return best?.id ?? null;
  };

  return (cwd) => {
    if (!memo.has(cwd)) memo.set(cwd, decide(cwd));
    return memo.get(cwd)!;
  };
}

/** Whether `cwd` may start one of the project's coding sessions: an existing folder, the root or inside it, or inside one
    of its linked worktrees, on canonical paths. */
export function startableIn(root: string, cwd: string): boolean {
  if (!isAbsolute(cwd)) return false;
  const r = real(cwd);
  if (!r || !existsSync(r) || !statSync(r).isDirectory()) return false;
  return folderMatcher([{ id: "p", root }])(r) === "p";
}
