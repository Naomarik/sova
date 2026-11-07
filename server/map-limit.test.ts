// Run: node scripts/run-tests.mjs server/map-limit.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mapLimit } from "./map-limit";

/** A call that settles when the test says so, so in-flight counts are read at known moments. */
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

test("never more than `limit` calls at once; each starts in the items' order; results in the items' order", async () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  const gates = items.map(() => gate());
  const started: number[] = [];
  let running = 0;
  let peak = 0;
  const done = mapLimit(items, 3, async (n) => {
    started.push(n);
    running++;
    peak = Math.max(peak, running);
    await gates[n]!.p;
    running--;
    return n * 10;
  });
  await Promise.resolve();
  assert.deepEqual(started, [0, 1, 2], "the first `limit` start at once, nothing more");
  // Free them out of order: a freed lane takes the next item, never a later one.
  for (const n of [1, 0, 2, 4, 3, 5, 6, 7, 8, 9]) {
    gates[n]!.open();
    await new Promise((r) => setImmediate(r));
  }
  assert.deepEqual(await done, items.map((n) => n * 10));
  assert.deepEqual(started, items, "started in the items' order");
  assert.equal(peak, 3);
});

test("empty input, a limit above the count, and a rejection", async () => {
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
  assert.deepEqual(await mapLimit([1, 2], 50, async (n) => n + 1), [2, 3]);
  await assert.rejects(mapLimit([1, 2, 3], 2, async (n) => (n === 2 ? Promise.reject(new Error("no")) : n)), /no/);
});
