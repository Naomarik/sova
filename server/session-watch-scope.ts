import { dirname } from "node:path";

/**
 * Which session folders the session feed watches live beyond the always-watched ones
 * (§app.session-list/live-watch-scope): a folder of pi's per-folder sessions, or a chat home's
 * `sessions/`, is watched only while one of its chats is open, running or was active in the last
 * RECENT_WATCH_MS. The rest are read on the feed's stat sweep and full build
 * (§app.session-list/listing-reuse). Pure: server/index.ts hands it the server's own facts.
 */

export const RECENT_WATCH_MS = 7 * 86_400_000;

export interface WatchScopeFacts {
  /** The last listing's rows: each session file and its last activity (ISO). */
  rows: Iterable<{ path: string; lastActiveAt?: string }>;
  /** Session files open in a window, held by this server, or named by a live record (a TUI, a
      worker) right now. */
  active: Iterable<string>;
  now?: number;
}

/** The folders holding a chat that is open, running or recent. */
export function hotFolders(facts: WatchScopeFacts): Set<string> {
  const now = facts.now ?? Date.now();
  const out = new Set<string>();
  for (const p of facts.active) if (p) out.add(dirname(p));
  for (const r of facts.rows) {
    const dir = dirname(r.path);
    if (out.has(dir) || !r.lastActiveAt) continue;
    const at = Date.parse(r.lastActiveAt);
    if (Number.isFinite(at) && now - at < RECENT_WATCH_MS) out.add(dir);
  }
  return out;
}

/** A folder changed (a file added or removed) in the last RECENT_WATCH_MS also counts as recent: a
    chat started there since the last listing has no row yet. */
export function recentlyChanged(mtimeMs: number | undefined, now = Date.now()): boolean {
  return mtimeMs !== undefined && now - mtimeMs < RECENT_WATCH_MS;
}

/** True for the errors a watch gets when the system's file-watch limit is reached (inotify's
    ENOSPC on Linux, too many open files elsewhere). */
export function isWatchLimit(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOSPC" || code === "EMFILE" || code === "ENFILE";
}

export function watchLimitLine(err: unknown, folders: number): string {
  const what = err instanceof Error ? err.message : String(err);
  const n = folders === 1 ? "1 folder isn't" : `${folders} folders aren't`;
  return `Session list: the system's file-watch limit is reached (${what}); ${n} watched, so their changes reach the list at the next full build.`;
}
