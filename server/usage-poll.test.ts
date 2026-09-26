// Run: npx tsx --test server/usage-poll.test.ts
// A fake clock and timers, and an injected refresh: nothing is fetched, nothing touches disk.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CacheFile, RefreshResult } from "../pi-config/extensions/usage-status/fetch.ts";
import { FAILURE_RETRY_MS } from "../pi-config/extensions/usage-status/fetch.ts";
import { FIRST_TICK_MS, FIRST_TICK_JITTER_MS, JITTER_MS, MAX_TICK_MS, MIN_TICK_MS, startUsagePoller, type UsagePollerOptions } from "./usage-poll";

/** One pending timer at a time (the poller chains), advanced by hand. */
function harness(opts: Partial<UsagePollerOptions> & { random?: () => number } = {}) {
  let clock = 1_000_000;
  const timers: { fn: () => void; at: number; cleared: boolean }[] = [];
  const logs: string[] = [];
  const calls: { force: boolean; prev: CacheFile | undefined }[] = [];
  const results: (RefreshResult | undefined | Error)[] = [];
  const poller = startUsagePoller({
    enabled: true,
    now: () => clock,
    random: opts.random ?? (() => 0),
    setTimer: (fn, ms) => {
      const t = { fn, at: clock + ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      (t as { cleared: boolean }).cleared = true;
    },
    log: (m) => logs.push(m),
    refresh: async (force, prev) => {
      calls.push({ force, prev });
      const r = results.shift();
      if (r instanceof Error) throw r;
      return r;
    },
    ...opts,
  });
  const pending = () => timers.filter((t) => !t.cleared && !(t as { fired?: boolean }).fired);
  /** Fire the one pending timer; returns the delay it was scheduled with. */
  const fire = async (): Promise<number> => {
    const live = pending();
    assert.equal(live.length, 1, "exactly one pending timer");
    const t = live[0]!;
    const delay = t.at - clock;
    clock = t.at;
    (t as { fired?: boolean }).fired = true;
    t.fn();
    await new Promise((r) => setImmediate(r)); // let the async tick settle
    await new Promise((r) => setImmediate(r));
    return delay;
  };
  /** The pending timer's delay from now. */
  const due = (): number => {
    const live = pending();
    assert.equal(live.length, 1, "exactly one pending timer");
    return live[0]!.at - clock;
  };
  return { poller, fire, pending, due, logs, calls, results, now: () => clock, setNow: (n: number) => (clock = n) };
}

const cache = (nextFetchAt: number, fetchedAt = nextFetchAt - 150_000): CacheFile => ({ schemaVersion: 3, fetchedAt, nextFetchAt, errors: {} }) as CacheFile;
const ok = (c: CacheFile, fetched = true, errors: RefreshResult["errors"] = {}): RefreshResult => ({ cache: c, fetched, errors });

test("first tick 2–5s after start; each tick is an ordinary (never forced) refresh", async () => {
  const lo = harness({ random: () => 0 });
  assert.equal(lo.due(), FIRST_TICK_MS);
  lo.poller.stop();
  const hi = harness({ random: () => 0.999999 });
  const d = hi.due();
  assert.ok(d > FIRST_TICK_MS && d <= FIRST_TICK_MS + FIRST_TICK_JITTER_MS && d <= 5_000, `first delay ${d}`);
  hi.results.push(undefined);
  await hi.fire();
  assert.deepEqual(hi.calls, [{ force: false, prev: undefined }]);
  hi.poller.stop();
});

test("the next tick follows the cache's nextFetchAt, clamped to [30s, 5min], plus jitter", async () => {
  const h = harness();
  h.results.push(ok(cache(h.now() + FIRST_TICK_MS + 150_000)));
  await h.fire();
  assert.equal(h.due(), 150_000, "due in 150s: tick then");

  h.results.push(ok(cache(h.now() + 150_000 + 5_000))); // due soon after this tick
  await h.fire();
  assert.equal(h.due(), MIN_TICK_MS, "due in 5s: floor");

  h.results.push(ok(cache(h.now() + MIN_TICK_MS + 3_600_000)));
  await h.fire();
  assert.equal(h.due(), MAX_TICK_MS, "due in an hour: ceiling");

  h.results.push(ok(cache(h.now() - 1)));
  await h.fire();
  assert.equal(h.due(), MIN_TICK_MS, "overdue: floor, never a hot loop");
  h.poller.stop();

  const j = harness({ random: () => 0.5 });
  j.results.push(ok(cache(j.now() + FIRST_TICK_MS + FIRST_TICK_JITTER_MS / 2 + 100_000)));
  await j.fire();
  assert.equal(j.due(), 100_000 + JITTER_MS / 2);
  j.poller.stop();
});

test("the last cache is passed back as prev; undefined (lock held, nothing published) retries at the floor", async () => {
  const h = harness();
  const c = cache(h.now() + 200_000);
  h.results.push(ok(c, false));
  await h.fire();
  h.results.push(undefined);
  await h.fire();
  assert.equal(h.calls[1]?.prev, c);
  assert.equal(h.due(), MIN_TICK_MS);
  h.poller.stop();
});

test("errors never stop the chain, and each distinct one is logged once", async () => {
  const h = harness();
  h.results.push(new Error("EACCES: cache dir"), new Error("EACCES: cache dir"), ok(cache(0), true, { claude: "HTTP 500" }), ok(cache(0), true, { claude: "HTTP 500" }), new Error("other"));
  const delays: number[] = [];
  for (let i = 0; i < 5; i++) {
    await h.fire();
    delays.push(h.due());
  }
  assert.deepEqual(delays, [FAILURE_RETRY_MS, FAILURE_RETRY_MS, MIN_TICK_MS, MIN_TICK_MS, FAILURE_RETRY_MS]);
  assert.deepEqual(h.logs, ["refresh failed: EACCES: cache dir", "fetch failed: claude: HTTP 500", "refresh failed: other"]);
  h.poller.stop();
});

test("onFetched only when this tick fetched and wrote the cache", async () => {
  const seen: CacheFile[] = [];
  const h = harness({ onFetched: (c) => seen.push(c) });
  const adopted = cache(h.now() + 100_000);
  const fetched = cache(h.now() + 300_000);
  h.results.push(ok(adopted, false), ok(fetched, true));
  await h.fire();
  await h.fire();
  assert.deepEqual(seen, [fetched]);
  h.poller.stop();
});

test("a tick is skipped while Refresh Usage is in flight, and the chain goes on", async () => {
  let busy = true;
  const h = harness({ busy: () => busy });
  await h.fire();
  assert.equal(h.calls.length, 0, "no refresh while busy");
  assert.equal(h.due(), MIN_TICK_MS);
  busy = false;
  h.results.push(undefined);
  await h.fire();
  assert.equal(h.calls.length, 1);
  h.poller.stop();
});

test("stop() clears the pending timer, and a tick in flight at stop schedules nothing", async () => {
  const h = harness();
  h.poller.stop();
  assert.equal(h.pending().length, 0);

  let release!: (r: RefreshResult | undefined) => void;
  const g = harness({ refresh: () => new Promise((r) => (release = r)) });
  const t = g.pending()[0]!;
  t.fn();
  (t as { fired?: boolean }).fired = true;
  g.poller.stop();
  release(ok(cache(g.now() + 100_000)));
  await new Promise((r) => setImmediate(r));
  assert.equal(g.pending().length, 0);
});

test("SOVA_USAGE_POLL=off (enabled: false) starts nothing", () => {
  const timers: number[] = [];
  const logs: string[] = [];
  const p = startUsagePoller({ enabled: false, setTimer: (_fn, ms) => (timers.push(ms), {}), log: (m) => logs.push(m) });
  p.stop();
  assert.equal(timers.length, 0);
  assert.deepEqual(logs, ["off (SOVA_USAGE_POLL=off)"]);
  const prev = process.env.SOVA_USAGE_POLL;
  process.env.SOVA_USAGE_POLL = "off";
  try {
    startUsagePoller({ setTimer: (_fn, ms) => (timers.push(ms), {}), log: () => {} }).stop();
  } finally {
    if (prev === undefined) delete process.env.SOVA_USAGE_POLL;
    else process.env.SOVA_USAGE_POLL = prev;
  }
  assert.equal(timers.length, 0, "the env switch alone turns it off");
});
