// Run: node scripts/run-tests.mjs server/share-rate-limit.test.ts. The share limiters' cost under a
// flood of distinct keys (§app.baton/share-listener): a sweep at most once a second, a hard key
// cap, and the same limits as before. In process with a throwaway PI_CODING_AGENT_DIR; ~/.pi
// untouched. Work is counted as map entries a sweep starts over, never as wall-clock time.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-share-limit-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const { RateLimiter } = await import("./share/edge");
const { tokenLimited, imageTokenLimited, ownerTokenLimited, tokenWindowSize, MESSAGES_PER_MINUTE, IMAGE_GETS_PER_MINUTE, OWNER_GETS_PER_MINUTE } = await import("./share/routes");

/** Run `fn`, counting the map walks it starts over a map holding more than `over` keys, and the
    entries those walks actually visit (for…of, entries, keys, values; forEach as a whole map). */
function walked(over: number, fn: () => void): { walks: number; entries: number } {
  const proto = Map.prototype as unknown as Record<string | symbol, (...a: unknown[]) => unknown>;
  const names: (string | symbol)[] = [Symbol.iterator, "entries", "keys", "values", "forEach"];
  const saved = names.map((n) => proto[n]!);
  const seen = { walks: 0, entries: 0 };
  names.forEach((n, i) => {
    proto[n] = function (this: Map<unknown, unknown>, ...a: unknown[]) {
      if (this.size <= over) return saved[i]!.apply(this, a);
      seen.walks++;
      if (n === "forEach") {
        seen.entries += this.size;
        return saved[i]!.apply(this, a);
      }
      const it = saved[i]!.apply(this, a) as Iterator<unknown>;
      const counted = {
        next: () => {
          const r = it.next();
          if (!r.done) seen.entries++;
          return r;
        },
        [Symbol.iterator]() {
          return counted;
        },
      };
      return counted;
    };
  });
  try {
    fn();
  } finally {
    names.forEach((n, i) => (proto[n] = saved[i]!));
  }
  return seen;
}

test("a flood of fresh addresses: the per-address limiter sweeps at most once a second, and still limits", () => {
  const r = new RateLimiter(60);
  const t0 = 5_000_000;
  let victim = 0;
  let limitedAt = -1;
  // 20k distinct addresses over 200 ms, a steady client among them.
  const seen = walked(1_000, () => {
    for (let i = 0; i < 20_000; i++) {
      const now = t0 + Math.floor(i / 100);
      r.limited(`flood-${i}`, now);
      if (i % 300 === 0 && limitedAt < 0) {
        victim++;
        if (r.limited("victim", now)) limitedAt = victim;
      }
    }
  });
  assert.ok(seen.entries <= 2 * 20_001, `${seen.entries} entries walked in 200 ms`);
  assert.equal(limitedAt, 61, "the 61st request inside the minute is limited, as before");
  // Stale keys still go: a minute later, the next sweep drops every flood key.
  r.limited("late", t0 + 120_000);
  r.limited("later", t0 + 121_500);
  assert.ok(r.size <= 3, `stale keys swept (${r.size} left)`);
});

test("a 200k-key flood inside one minute: the key count is capped, per-call work bounded, a steady client still limited", () => {
  const r = new RateLimiter(60);
  const t0 = 9_000_000;
  let limited = false;
  const seen = walked(1_000, () => {
    for (let i = 0; i < 200_000; i++) {
      const now = t0 + Math.floor(i / 10); // 20 s
      r.limited(`f-${i}`, now);
      if (i % 3_000 === 0) limited = r.limited("steady", now) || limited;
    }
  });
  assert.ok(r.size <= RateLimiter.MAX_KEYS, `${r.size} keys held`);
  // At most one sweep a second over at most MAX_KEYS + 1 keys, plus one key visited per eviction.
  assert.ok(seen.entries <= 21 * (RateLimiter.MAX_KEYS + 1) + 200_000, `entries walked: ${seen.entries}`);
  assert.equal(limited, true, "the steady client reached its limit despite the flood");
});

test("per-token limiters: same limits, no full walk per call under a flood of tokens, small windows still pruned on every call", () => {
  const t0 = 20_000_000;
  for (const [fn, limit] of [
    [tokenLimited, MESSAGES_PER_MINUTE],
    [imageTokenLimited, IMAGE_GETS_PER_MINUTE],
    [ownerTokenLimited, OWNER_GETS_PER_MINUTE],
  ] as const) {
    for (let i = 0; i < limit; i++) assert.equal(fn("tok-limit", t0 + i), false);
    assert.equal(fn("tok-limit", t0 + limit), true, `${fn.name}: over ${limit}`);
    assert.equal(fn("tok-other", t0 + limit), false, `${fn.name}: per token`);
    assert.equal(fn("tok-limit", t0 + 60_001 + limit), false, `${fn.name}: a sliding minute`);
    const seen = walked(2_000, () => {
      for (let i = 0; i < 5_000; i++) fn(`${fn.name}-flood-${i}`, t0 + 1_000 + Math.floor(i / 100));
    });
    assert.ok(seen.entries <= 10_000, `${fn.name}: ${seen.entries} entries walked for 5k tokens`);
  }
  // While small, a token with nothing left in its window is dropped on the next call.
  const t1 = t0 + 1_000_000;
  tokenLimited("tok-old", t1);
  tokenLimited("tok-new", t1 + 61_000);
  assert.equal(tokenWindowSize(), 1);
});
