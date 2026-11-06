// Run: pnpm test -- server/harness/pi/model-sync.test.ts. The server's Ollama Cloud check schedule
// (§app.model-levels/server-check): daily after a success, an hour after a failure, at once on Check
// now (joining one running), nothing when checks are off. A fake clock; no file, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CheckRecord } from "../../../pi-config/extensions/model-levels/core.ts";
import { type CheckClock, createModelCheck, nextCheckAt } from "./model-sync";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A clock whose timers fire only when the test advances it. */
function fakeClock(start = 0) {
  let t = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: CheckClock = {
    now: () => t,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout: (h) => void timers.delete(h as number),
  };
  return {
    clock,
    /** Move to `to`, firing every timer due by then. */
    advance(to: number) {
      t = to;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= to) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    pending: () => [...timers.values()].map((x) => x.at),
  };
}

/** A run the test settles by hand, so "while it runs" is a state, not a race. */
function controlledRun(clock: CheckClock) {
  const calls: { resolve: (r: CheckRecord) => void }[] = [];
  const run = () => new Promise<CheckRecord>((resolve) => calls.push({ resolve }));
  const settle = (ok: boolean) => {
    const call = calls.at(-1)!;
    const at = clock.now();
    call.resolve(ok ? { at, ok: true, added: [], retired: [] } : { at, ok: false, error: "couldn't reach ollama.com", retryAt: at + HOUR });
  };
  return { run, calls, settle };
}

/** Let the run's promise chain finish (microtasks only; no time passes). */
const flush = () => new Promise<void>((r) => setImmediate(r));

test("nextCheckAt: at once with none, a day after a success, the recorded retry after a failure", () => {
  assert.equal(nextCheckAt(undefined, 50), 50);
  assert.equal(nextCheckAt({ at: 10, ok: true }, 50), 10 + DAY);
  assert.equal(nextCheckAt({ at: 10, ok: false, retryAt: 999 }, 50), 999);
  assert.equal(nextCheckAt({ at: 10, ok: false }, 50), 10 + HOUR);
});

test("the schedule: first check at once, daily after success, an hour after failure", async () => {
  const f = fakeClock(1000);
  const r = controlledRun(f.clock);
  const check = createModelCheck({ enabled: true, run: r.run, last: () => undefined, clock: f.clock });
  check.start();
  assert.deepEqual(f.pending(), [1000], "never checked: due now");
  f.advance(1000);
  assert.equal(r.calls.length, 1);
  assert.equal(check.checking(), true);
  r.settle(false);
  await flush();
  assert.equal(check.checking(), false);
  assert.equal(check.nextAt(), 1000 + HOUR, "failed: an hour later");
  f.advance(1000 + HOUR - 1);
  assert.equal(r.calls.length, 1, "not before the hour");
  f.advance(1000 + HOUR);
  assert.equal(r.calls.length, 2);
  r.settle(true);
  await flush();
  assert.equal(check.nextAt(), 1000 + HOUR + DAY, "succeeded: a day later");
  check.stop();
  assert.deepEqual(f.pending(), []);
});

test("start resumes from the recorded check, not from zero", () => {
  const f = fakeClock(5 * HOUR);
  const check = createModelCheck({ enabled: true, run: controlledRun(fakeClock().clock).run, last: () => ({ at: 4 * HOUR, ok: true }), clock: f.clock });
  check.start();
  assert.equal(check.nextAt(), 4 * HOUR + DAY);
});

test("Check now runs at once, joins a running check, and re-arms the timer", async () => {
  const f = fakeClock(0);
  const r = controlledRun(f.clock);
  const check = createModelCheck({ enabled: true, run: r.run, last: () => ({ at: 0, ok: true }), clock: f.clock });
  check.start();
  assert.equal(check.nextAt(), DAY);
  f.advance(HOUR);
  const a = check.checkNow();
  const b = check.checkNow();
  assert.equal(r.calls.length, 1, "one check, however many presses");
  assert.equal(check.nextAt(), undefined, "the timer waits for the running check");
  r.settle(true);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra, rb);
  assert.equal(ra!.ok, true);
  assert.equal(check.nextAt(), HOUR + DAY);
});

test("checks off: no timer, and Check now runs nothing", async () => {
  const f = fakeClock(0);
  const r = controlledRun(f.clock);
  const check = createModelCheck({ enabled: false, run: r.run, last: () => undefined, clock: f.clock });
  check.start();
  assert.deepEqual(f.pending(), []);
  assert.equal(await check.checkNow(), undefined);
  assert.equal(r.calls.length, 0);
});

test("a run that throws counts as a failure and retries an hour later", async () => {
  const f = fakeClock(0);
  const check = createModelCheck({ enabled: true, run: () => Promise.reject(new Error("boom")), last: () => ({ at: 0, ok: true }), clock: f.clock });
  check.start();
  const rec = await check.checkNow();
  assert.deepEqual(rec, { at: 0, ok: false, error: "boom", retryAt: HOUR });
  assert.equal(check.nextAt(), HOUR);
});
