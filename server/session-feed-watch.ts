import { readdirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { activityOf, failedWorkersOf, isOwnPid, readLiveRecords, workerCountsOf, workerErrorTimesOf } from "./live";
import { onSessionsChanged } from "./list-generation";
import { extraSessionRoots, LIVE_DIR, SESSIONS_DIR } from "./paths";

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

  const add = (dir: string, on: (name: string | Buffer | null) => void): void => {
    if (watchers.has(dir)) return;
    try {
      const w = watch(dir, { persistent: false }, (_event, name) => {
        if (!stopped) on(name);
      });
      w.on("error", () => {
        w.close();
        if (watchers.get(dir) === w) watchers.delete(dir);
      });
      watchers.set(dir, w);
    } catch {
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

  const sync = (): void => {
    if (stopped) return;
    const want = new Set<string>([sessionsDir]);
    try {
      for (const d of readdirSync(sessionsDir, { withFileTypes: true })) {
        const p = join(sessionsDir, d.name);
        if (d.isDirectory() && p !== liveDir) want.add(p);
      }
    } catch {
      // no sessions folder yet
    }
    for (const r of roots()) want.add(r);
    for (const [dir, w] of watchers) {
      if (dir === liveDir || want.has(dir)) continue;
      w.close();
      watchers.delete(dir);
    }
    for (const dir of want) {
      if (dir === sessionsDir) {
        add(dir, (name) => {
          // A new cwd folder needs its own watch; a top-level file is a session.
          if (name === null || !String(name).endsWith(".jsonl")) syncSoon();
          if (isSession(name)) changed();
        });
      } else add(dir, (name) => isSession(name) && changed());
    }
    add(liveDir, (name) => {
      if (name === null || (String(name).endsWith(".json") && !String(name).startsWith("."))) liveSoon();
    });
  };
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
  const resync = setInterval(sync, opts.resyncMs ?? RESYNC_MS);
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
