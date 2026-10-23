import { realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { UsageProjectKind } from "../../shared/usage/wire";
import { checkoutFinder, folderMatcher } from "../project-folder";

/**
 * The Costs tab's By project rows: which row a call's folder falls in.
 * In order: the Overseer's folders; a registered project's (archived ones too), by the sidebar's rule
 * (server/project-folder.ts folderMatcher); any other `overseer` call; a code checkout on this computer;
 * else Other folders. Reads the disk only (never runs git); each distinct folder is decided once.
 */

/** What the server sends with a `costs` ask. */
export interface FoldInput {
  projects: { id: string; name: string; root: string; archived?: boolean }[];
  /** The Overseer's folder and each organization's workspace. */
  overseer: string[];
  /** Sova's agent folder: a remote session's stand-in folder is in it. */
  exclude?: string;
  /** The system's temporary folders. */
  temp?: string[];
}

export interface FoldRow {
  key: string;
  kind: UsageProjectKind;
  name: string;
  /** A project's root, a checkout's folder. */
  path?: string;
  /** The project id. */
  project?: string;
  archived?: true;
}

export type Fold = (cwd: string | null, kind: string, project: string | null) => FoldRow;

export const OVERSEER_ROW: FoldRow = { key: "o", kind: "overseer", name: "Overseer" };
export const OTHER_ROW: FoldRow = { key: "x", kind: "other", name: "Other folders" };

const real = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

const within = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** A folder and its real path, both resolved. */
const formsOf = (dirs: readonly string[]): string[] =>
  [...new Set(dirs.filter((d) => d && isAbsolute(d)).flatMap((d) => [resolve(d), real(d)]).filter((x): x is string => !!x))];

/** Guards what the server sent: a bad entry is dropped, never thrown. */
export function foldInputOf(v: unknown): FoldInput | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && isAbsolute(s)) : []);
  const projects = Array.isArray(o.projects)
    ? o.projects.flatMap((p) => {
        const q = p as Record<string, unknown> | null;
        if (!q || typeof q.id !== "string" || typeof q.root !== "string" || !isAbsolute(q.root)) return [];
        return [{ id: q.id, name: typeof q.name === "string" && q.name ? q.name : q.id, root: q.root, ...(q.archived === true ? { archived: true } : {}) }];
      })
    : [];
  return { projects, overseer: strs(o.overseer), ...(typeof o.exclude === "string" && isAbsolute(o.exclude) ? { exclude: o.exclude } : {}), temp: strs(o.temp) };
}

export function projectFold(input: FoldInput): Fold {
  const byId = new Map(input.projects.map((p) => [p.id, p]));
  const projectRow = (id: string): FoldRow => {
    const p = byId.get(id);
    return { key: `p:${id}`, kind: "project", name: p?.name ?? id, project: id, ...(p ? { path: p.root } : {}), ...(p?.archived ? { archived: true as const } : {}) };
  };
  const overseer = formsOf(input.overseer);
  const temp = formsOf(input.temp ?? []);
  const excluded = formsOf(input.exclude ? [input.exclude] : []);
  const matcher = folderMatcher(input.projects, input.exclude, { husks: true });
  const checkout = checkoutFinder();
  // Per folder: the row, or null when it falls to Other (an `overseer` call then still goes to the Overseer).
  const memo = new Map<string, FoldRow | null>();
  const decide = (cwd: string): FoldRow | null => {
    if (!isAbsolute(cwd)) return null;
    const lexical = resolve(cwd);
    const r = real(lexical);
    const forms = r && r !== lexical ? [lexical, r] : [lexical];
    const under = (dirs: string[]) => forms.some((f) => dirs.some((d) => within(d, f)));
    if (under(overseer)) return OVERSEER_ROW;
    const id = matcher(cwd);
    if (id) return projectRow(id);
    if (under(excluded) || under(temp)) return null;
    const root = checkout(cwd);
    return root ? { key: `f:${root}`, kind: "folder", name: basename(root) || root, path: root } : null;
  };
  return (cwd, kind, project) => {
    if (project) return projectRow(project);
    let row: FoldRow | null = null;
    if (cwd) {
      if (!memo.has(cwd)) memo.set(cwd, decide(cwd));
      row = memo.get(cwd)!;
    }
    if (row?.kind === "overseer" || row?.kind === "project") return row;
    if (kind === "overseer") return OVERSEER_ROW;
    return row ?? OTHER_ROW;
  };
}

/** How long a fold's per-folder answers are kept: folders come and go. */
const FOLD_TTL_MS = 5 * 60_000;

/** The helper keeps one fold per input across polls (the same projects ask again every few seconds). */
export function foldCache(now: () => number = Date.now): (input: FoldInput) => Fold {
  let last: { key: string; at: number; fold: Fold } | null = null;
  return (input) => {
    const key = JSON.stringify(input);
    const t = now();
    if (!last || last.key !== key || t - last.at > FOLD_TTL_MS) last = { key, at: t, fold: projectFold(input) };
    return last.fold;
  };
}
