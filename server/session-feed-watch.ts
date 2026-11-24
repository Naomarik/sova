import { readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { activityOf, failedWorkersOf, isOwnPid, readLiveRecords, workerCountsOf, workerErrorTimesOf } from "./live";
import { onSessionsChanged } from "./list-generation";
import { extraSessionRoots, LIVE_DIR, SESSIONS_DIR } from "./paths";
import { isWatchLimit, recentlyChanged, watchLimitLine } from "./session-watch-scope";

/**
 * What tells the session feed (server/session-feed.ts) that a row may have changed, so it compares
 * only then (§app.decisions/push):
 *
 * - the list generation moving (every in-process write a row reads, server/list-generation.ts);
 * - a `.jsonl` written, added or removed in the sessions folder, any folder under it, or an extra
 *   session root (an organization's workspace sessions); the folder set is re-read when the top
 *   folder changes and on each re-sync;
 * - a live record whose owner, status, activity, worker counts or failures changed, or whose
 *   process died or went stale. Writers rewrite their record on every heartbeat (~3-4 s), so a
 *   folder event only schedules a check of the records' signature, never a comparison by itself;
 *   the check also runs every LIVE_CHECK_MS, since a process that dies writes nothing;
 * - with that check, `checks`: merge readiness compares its tracked worktrees' Git inputs (index,
 *   HEAD, branch and base refs) as stat stamps and re-reads only a row whose stamps moved, so a
 *   commit made with no session-file write still reaches the list within seconds.
 *
 * Everything is started with the feed's first listener and stopped with its last.
 */

export const LIVE_CHECK_MS = 5_000;
/** How often the watched folder set is re-read (a new organization root, a watch that errored). */
export const RESYNC_MS = 60_000;
const OWN_FRESH_MS = 15_000;

export interface FeedWatchOptions {
  sessionsDir?: string;
  liveDir?: string;
  roots?: () => readonly string[];
  liveCheckMs?: number;
  resyncMs?: number;
  /** The live records' signature (tests stub it). */
  liveSignature?: () => string;
  /** Cheap checks run with the live check (merge readiness's Git-input stamps); each announces
      what it finds through the list generation itself. */
  checks?: readonly (() => void)[];
  /** Told which session files changed, before `changed` runs: a full path, or null when the
      watch can't say which (an event with no name, a folder added to the watched set, a watch
      lost), so the next listing reads every folder again (sessions-index's file tracker). */
  files?: (path: string | null) => void;
  /**
   * Watch only the chats that can change soon (§app.session-list/live-watch-scope). Without it every
   * per-folder sessions folder is watched, as before. With it, a per-folder sessions folder, and each
   * of `folders()` (the chat homes' `sessions/`), is watched only while it is in `hot()` (a chat
   * there open, running or recent) or was itself changed in the last 7 days; `active()` (the open
   * and running chats' files, cheap) is checked with the live check, so a chat opened or started
   * running is watched at once. pi's sessions folder, `roots` and the live folder stay watched.
   * `hot()` null (nothing listed yet): every folder is watched, as without a scope.
   */
  scope?: { hot: () => ReadonlySet<string> | null; active?: () => ReadonlySet<string>; folders?: () => readonly string[] };
  /** Where the out-of-watches line goes, and the watch itself (tests). */
  log?: (line: string) => void;
  watch?: typeof watch;
}

/** What of the live records a row, a mark, the digest or the Overseer's state reads; a heartbeat
    alone leaves it unchanged. */
export function liveSignature(now = Date.now()): string {
  const out: unknown[] = [];
  for (const r of readLiveRecords({ includeOwn: true })) {
    const rec = r.rec as any;
    const act = activityOf(rec);
    const beat = typeof rec?.heartbeat === "number" ? rec.heartbeat : 0;
    out.push([
      r.sessionFile,
      r.pid,
      String(rec?.presence?.status ?? rec?.session?.status ?? ""),
      typeof rec?.session?.mode === "string" ? rec.session.mode : null,
      act?.state ?? null,
      act?.since ?? null,
      workerCountsOf(rec) ?? null,
      failedWorkersOf(rec),
      workerErrorTimesOf(rec),
      isOwnPid(r.pid) && now - beat > OWN_FRESH_MS,
    ]);
  }
  return JSON.stringify(out.map((x) => JSON.stringify(x)).sort());
}

export function watchFeedInputs(changed: () => void, opts: FeedWatchOptions = {}): () => void {
  const sessionsDir = opts.sessionsDir ?? SESSIONS_DIR;
  const liveDir = opts.liveDir ?? LIVE_DIR;
  const roots = opts.roots ?? extraSessionRoots;
  const signature = opts.liveSignature ?? (() => liveSignature());
  const watchers = new Map<string, FSWatcher>();
  let stopped = false;

  const isSession = (name: string | Buffer | null) => name === null || String(name).endsWith(".jsonl");
  const files = opts.files;
  /** A session file event in `dir`: tell the tracker which file (or that it can't say). */
  const noteFile = (dir: string, name: string | Buffer | null): void => {
    files?.(name === null ? null : join(dir, String(name)));
  };
  /** Each sync after the first that adds a watch: files written before it existed went unseen. */
  let synced = false;

  /** This sync's watches the system refused for its file-watch limit: logged once per sync. */
  let limitErr: unknown = null;
  let limited = 0;
  const add = (dir: string, on: (name: string | Buffer | null) => void): void => {
    if (watchers.has(dir)) return;
    if (limitErr !== null) {
      // The limit is reached: the rest of this sync's folders are left out, read as unwatched ones are.
      limited++;
      return;
    }
    try {
      const w = (opts.watch ?? watch)(dir, { persistent: false }, (_event, name) => {
        if (!stopped) on(name);
      });
      w.on("error", (err) => {
        if (isWatchLimit(err)) (opts.log ?? console.warn)(watchLimitLine(err, 1));
        w.close();
        if (watchers.get(dir) === w) watchers.delete(dir);
        // Events may have been lost before the error: the next listing reads everything.
        if (!stopped) files?.(null);
      });
      watchers.set(dir, w);
      if (synced && dir !== liveDir) files?.(null);
    } catch (err) {
      if (isWatchLimit(err)) {
        limitErr = err;
        limited++;
      }
      // missing or unwatchable: the next re-sync tries again
    }
  };

  let lastLive: string | null = null;
  let liveTimer: ReturnType<typeof setTimeout> | null = null;
  const checkLive = (): void => {
    let sig: string;
    try {
      sig = signature();
    } catch {
      return;
    }
    if (lastLive !== null && sig !== lastLive) changed();
    lastLive = sig;
  };
  const liveSoon = (): void => {
    if (liveTimer || stopped) return;
    liveTimer = setTimeout(() => {
      liveTimer = null;
      checkLive();
    }, 200);
    liveTimer.unref?.();
  };

  const scope = opts.scope;
  const exists = (dir: string): boolean => {
    try {
      statSync(dir);
      return true;
    } catch {
      return false;
    }
  };
  /** A scoped folder is watched while hot, or changed itself (a file added or removed) lately. */
  const scoped = (dir: string, hot: ReadonlySet<string>, now: number): boolean => {
    if (hot.has(dir)) return true;
    try {
      return recentlyChanged(statSync(dir).mtimeMs, now);
    } catch {
      return false;
    }
  };
  const sync = (): void => {
    if (stopped) return;
    limitErr = null;
    limited = 0;
    const want = new Set<string>([sessionsDir]);
    const now = Date.now();
    let hot: ReadonlySet<string> | null = null;
    try {
      hot = scope ? scope.hot() : null;
    } catch {
      hot = null; // can't say: watch every folder, as before
    }
    try {
      for (const d of readdirSync(sessionsDir, { withFileTypes: true })) {
        const p = join(sessionsDir, d.name);
        if (d.isDirectory() && p !== liveDir && (!hot || scoped(p, hot, now))) want.add(p);
      }
    } catch {
      // no sessions folder yet
    }
    if (scope?.folders) {
      try {
        for (const p of scope.folders()) if (!hot || scoped(p, hot, now)) want.add(p);
      } catch {
        // the homes can't be listed now: the next re-sync tries again
      }
    }
    for (const r of roots()) want.add(r);
    for (const [dir, w] of watchers) {
      if (dir === liveDir || want.has(dir)) continue;
      w.close();
      watchers.delete(dir);
      // A folder gone (or moved away) may take its files with no event for each. One merely out of
      // scope keeps its files: the tracker's stat sweep and full build read them as before.
      if (!scope || !exists(dir)) files?.(null);
    }
    for (const dir of want) {
      if (dir === sessionsDir) {
        add(dir, (name) => {
          // A new cwd folder needs its own watch; a top-level file is a session.
          if (name === null || !String(name).endsWith(".jsonl")) syncSoon();
          if (isSession(name)) {
            noteFile(dir, name);
            changed();
          }
        });
      } else
        add(dir, (name) => {
          if (!isSession(name)) return;
          noteFile(dir, name);
          changed();
        });
    }
    add(liveDir, (name) => {
      if (name === null || (String(name).endsWith(".json") && !String(name).startsWith("."))) liveSoon();
    });
    if (limitErr !== null) (opts.log ?? console.warn)(watchLimitLine(limitErr, limited));
    synced = true;
  };
  /** A chat opened or started running in a folder not watched: watch it now, not at the re-sync. */
  const checkActive = (): void => {
    if (!scope?.active) return;
    let active: ReadonlySet<string>;
    try {
      active = scope.active();
    } catch {
      return;
    }
    let wanted = false;
    for (const dir of active) {
      // Once per folder per re-sync: one that is no session folder (or can't be watched) isn't retried every check.
      if (watchers.has(dir) || asked.has(dir)) continue;
      asked.add(dir);
      wanted = true;
    }
    if (wanted) syncSoon();
  };
  /** Folders checkActive already asked a sync for since the last re-sync. */
  const asked = new Set<string>();
  let syncTimer: ReturnType<typeof setTimeout> | null = null;
  const syncSoon = (): void => {
    if (syncTimer || stopped) return;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      sync();
    }, 200);
    syncTimer.unref?.();
  };

  sync();
  checkLive();
  const offGeneration = onSessionsChanged(changed);
  const periodic = (): void => {
    checkLive();
    checkActive();
    for (const check of opts.checks ?? []) {
      try {
        check();
      } catch (err) {
        console.warn("[session-feed] check failed:", err instanceof Error ? err.message : String(err));
      }
    }
  };
  const liveInterval = setInterval(periodic, opts.liveCheckMs ?? LIVE_CHECK_MS);
  liveInterval.unref?.();
  const resync = setInterval(() => {
    asked.clear();
    sync();
  }, opts.resyncMs ?? RESYNC_MS);
  resync.unref?.();

  return () => {
    stopped = true;
    offGeneration();
    clearInterval(liveInterval);
    clearInterval(resync);
    if (liveTimer) clearTimeout(liveTimer);
    if (syncTimer) clearTimeout(syncTimer);
    for (const w of watchers.values()) w.close();
    watchers.clear();
  };
}
