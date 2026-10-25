// How big a repository's git folder is, and whether git's cleanup there looks stuck or overdue
// (shared/protocol.ts GitFolderReading, the new session card's Repository group). Read by stat
// alone, never `du` and never git: every file's size summed, the walk stopped at
// GIT_FOLDER_ENTRY_CAP entries, the pack folder walked first so the pack count is whole even when
// the cap cuts the rest. Cached GIT_FOLDER_TTL_MS per git folder (a 25 GB folder is a few hundred
// pack files, but a folder with many loose objects is not), concurrent callers sharing one walk.
import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { GitFolderReading } from "../shared/protocol";

export const GIT_FOLDER_TTL_MS = 5 * 60_000;
export const GIT_FOLDER_ENTRY_CAP = 50_000;
/** A cleanup lock older than this means a cleanup that died holding it. */
export const STUCK_LOCK_MS = 60 * 60_000;
/** More pack files than this, or loose objects than OVERDUE_LOOSE (git's own gc.auto default): cleanup hasn't run for a long time. */
export const OVERDUE_PACKS = 50;
export const OVERDUE_LOOSE = 6_700;
/** The locks a cut-off `git maintenance` run leaves, relative to the git folder. */
export const CLEANUP_LOCKS = ["objects/pack/multi-pack-index.lock", "objects/info/commit-graphs/commit-graph-chain.lock"] as const;

/** Walk `dir` by stat; null when the folder can't be read at all. */
export async function measureGitFolder(dir: string, now: number, cap = GIT_FOLDER_ENTRY_CAP): Promise<GitFolderReading | null> {
  try {
    if (!(await stat(dir)).isDirectory()) return null;
  } catch {
    return null;
  }
  let bytes = 0;
  let entries = 0;
  let partial = false;
  let packs = 0;
  let loose = 0;
  const pack = join(dir, "objects", "pack");
  const looseDir = /\/objects\/[0-9a-f]{2}$/;
  const queue: string[] = [pack, dir];
  const seen = new Set<string>();
  while (queue.length && !partial) {
    const d = queue.shift()!;
    if (seen.has(d)) continue;
    seen.add(d);
    let names: string[];
    try {
      names = await readdir(d);
    } catch {
      continue;
    }
    for (const name of names) {
      if (++entries > cap) {
        partial = true;
        break;
      }
      const p = join(d, name);
      let st;
      try {
        st = await lstat(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        queue.push(p);
        continue;
      }
      bytes += st.size;
      if (d === pack && name.endsWith(".pack")) packs++;
      else if (looseDir.test(d)) loose++;
    }
  }
  let stuck: { lock: string; path: string; since: number } | null = null;
  for (const rel of CLEANUP_LOCKS) {
    const path = join(dir, rel);
    try {
      const since = (await lstat(path)).mtimeMs;
      if (now - since > STUCK_LOCK_MS && (!stuck || since < stuck.since)) stuck = { lock: rel.split("/").pop()!, path, since };
    } catch {}
  }
  const over = { ...(packs > OVERDUE_PACKS ? { packs } : {}), ...(loose > OVERDUE_LOOSE ? { loose } : {}) };
  const warning: GitFolderReading["warning"] = stuck ? { kind: "stuck", ...stuck } : Object.keys(over).length ? { kind: "overdue", ...over } : null;
  return { path: dir, bytes, partial, packs, loose, warning, checkedAt: now };
}

const cache = new Map<string, GitFolderReading>();
const inflight = new Map<string, Promise<GitFolderReading | null>>();

/** measureGitFolder, cached per folder for GIT_FOLDER_TTL_MS; an unreadable folder is never cached. */
export function gitFolderReading(dir: string, now: () => number = Date.now): Promise<GitFolderReading | null> {
  const hit = cache.get(dir);
  if (hit && now() - hit.checkedAt < GIT_FOLDER_TTL_MS) return Promise.resolve(hit);
  const running = inflight.get(dir);
  if (running) return running;
  const run = measureGitFolder(dir, now())
    .then((r) => {
      if (r) cache.set(dir, r);
      else cache.delete(dir);
      return r;
    })
    .catch(() => null)
    .finally(() => inflight.delete(dir));
  inflight.set(dir, run);
  return run;
}

/** Test seam: forget every reading. */
export function clearGitFolderCache(): void {
  cache.clear();
}
