/**
 * The share listener's sliding-window limiters (§app.baton/share-listener): per client address at
 * the edge, per token in the share routes. Its own file so routes.ts and edge.ts (which imports
 * routes.ts) can both build them at load.
 *
 * A key with nothing left in its window is forgotten at the next sweep: on every call while the
 * limiter holds at most EAGER_MAX keys, and at most once every SWEEP_MS above that, so a flood of
 * fresh keys never costs a full walk per request. The map is kept in last-seen order, and past
 * MAX_KEYS the least recently seen keys go first. Who is limited is decided by the key's own
 * window alone, swept or not.
 */
export class RateLimiter {
  /** At or below this many keys, every call sweeps. */
  static readonly EAGER_MAX = 1_000;
  /** Above EAGER_MAX, the least time between sweeps. */
  static readonly SWEEP_MS = 1_000;
  /** The most keys held; far above any real load (a minute of 60-a-minute clients). */
  static readonly MAX_KEYS = 100_000;

  private hits = new Map<string, number[]>();
  private sweptAt = -Infinity;
  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  /** Count one hit; true when over the limit (an over-limit hit is not counted). */
  limited(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    const over = recent.length >= this.limit;
    if (!over) recent.push(now);
    // Re-inserted, so iteration order is least recently seen first.
    this.hits.delete(key);
    this.hits.set(key, recent);
    this.prune(key, now);
    return over;
  }

  /** How many keys are held. */
  get size(): number {
    return this.hits.size;
  }

  private prune(key: string, now: number): void {
    const n = this.hits.size;
    if (n <= RateLimiter.EAGER_MAX || now - this.sweptAt >= RateLimiter.SWEEP_MS) {
      if (n > RateLimiter.EAGER_MAX) this.sweptAt = now;
      for (const [k, v] of this.hits) if (k !== key && !v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    }
    if (this.hits.size <= RateLimiter.MAX_KEYS) return;
    for (const k of this.hits.keys()) {
      if (this.hits.size <= RateLimiter.MAX_KEYS) break;
      if (k !== key) this.hits.delete(k);
    }
  }
}
