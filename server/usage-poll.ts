// The server's own usage poller: keeps the shared usage cache (usage-status.json) fresh while
// the server runs, so the Usage page and the sidebar glance don't depend on an open TUI. Each tick
// asks the usage-status extension for an ordinary refresh; the extension's lock and the cache's
// nextFetchAt decide whether anything is actually fetched, so this never fetches more often than a
// TUI would. Never forced, never a credential write (fetch.ts only reads them).

// Part of the sanctioned pi-config import surface, like server/insights.ts — see CLAUDE.md.
import { describeErrors, FAILURE_RETRY_MS, nextClaudeReset, refreshCache, type CacheFile, type RefreshResult } from "../pi-config/extensions/usage-status/fetch.ts";

/** Tick bounds: the next tick follows the cache's nextFetchAt, clamped to [MIN, MAX]. */
export const MIN_TICK_MS = 30_000;
export const MAX_TICK_MS = 5 * 60_000;
/** Added to every tick, so servers started together don't race the lock in step. */
export const JITTER_MS = 5_000;
/** The first tick comes 2–5s after start: off the startup path, but soon. */
export const FIRST_TICK_MS = 2_000;
export const FIRST_TICK_JITTER_MS = 3_000;
/** Distinct failure messages remembered for log-once; past this the set starts over. */
const MAX_REMEMBERED_ERRORS = 50;

/** A timer handle: whatever setTimer returns, handed back to clearTimer. */
type Timer = object;

export interface UsagePollerOptions {
  /** Defaults to `process.env.SOVA_USAGE_POLL !== "off"`. */
  enabled?: boolean;
  /** fetch.ts's refreshCache; tests inject a fake. */
  refresh?: (force: boolean, prev: CacheFile | undefined) => Promise<RefreshResult | undefined>;
  /** True while a Refresh Usage (forced) refresh is in flight: the tick is skipped. */
  busy?: () => boolean;
  /** Called after a tick that fetched and wrote the cache itself. */
  onFetched?(cache: CacheFile): void;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
  log?: (message: string) => void;
}

export interface UsagePoller {
  stop(): void;
}

/**
 * The delay after a tick that returned `cache` (undefined: nothing to go on), before jitter: the
 * cache's nextFetchAt, or the earliest Claude window reset still ahead when that is sooner (the
 * cache is due once a reading's reset has passed), clamped to [MIN, MAX].
 */
export function nextDelay(cache: CacheFile | undefined, now: number): number {
  if (!cache) return MIN_TICK_MS;
  const reset = nextClaudeReset(cache, now);
  const at = reset !== undefined ? Math.min(cache.nextFetchAt, reset) : cache.nextFetchAt;
  return Math.min(MAX_TICK_MS, Math.max(MIN_TICK_MS, at - now));
}

export function startUsagePoller(opts: UsagePollerOptions = {}): UsagePoller {
  const log = opts.log ?? ((m: string) => console.warn(`[usage-poll] ${m}`));
  if (!(opts.enabled ?? process.env.SOVA_USAGE_POLL !== "off")) {
    log("off (SOVA_USAGE_POLL=off)");
    return { stop() {} };
  }
  const refresh = opts.refresh ?? ((force, prev) => refreshCache(force, prev));
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));

  let stopped = false;
  let timer: Timer | undefined;
  let prev: CacheFile | undefined;
  const logged = new Set<string>();
  const logOnce = (message: string) => {
    if (logged.has(message)) return;
    if (logged.size >= MAX_REMEMBERED_ERRORS) logged.clear();
    logged.add(message);
    log(message);
  };

  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimer(() => void tick(), ms);
  };

  const tick = async () => {
    timer = undefined;
    if (stopped) return;
    if (opts.busy?.()) return schedule(MIN_TICK_MS + random() * JITTER_MS);
    let delay: number;
    try {
      const result = await refresh(false, prev);
      if (result) {
        prev = result.cache;
        if (result.fetched) opts.onFetched?.(result.cache);
        const failed = describeErrors(result.errors);
        if (failed) logOnce(`fetch failed: ${failed}`);
      }
      delay = nextDelay(result?.cache, now());
    } catch (err) {
      logOnce(`refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      delay = FAILURE_RETRY_MS;
    }
    schedule(delay + random() * JITTER_MS);
  };

  schedule(FIRST_TICK_MS + random() * FIRST_TICK_JITTER_MS);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = undefined;
    },
  };
}
