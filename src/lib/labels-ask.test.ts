// Run: pnpm test -- src/lib/labels-ask.test.ts
// The label pairs this page reads (src/lib/labels-ask.ts) are kept per browser: a load where an extension
// declared them last time starts with them, so its first list read and socket already carry labels and the
// declaration arriving changes nothing. A browser that never had one starts from null: today's URLs.
import assert from "node:assert/strict";
import { test } from "node:test";

const kept = new Map<string, string>([["sova:labels-read", "team-bar:owner"]]);
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => kept.get(k) ?? null,
  setItem: (k: string, v: string) => void kept.set(k, v),
  removeItem: (k: string) => void kept.delete(k),
};
const ask = await import("./labels-ask");

test("the pairs kept from last time are read at load, and every row read carries them", () => {
  assert.equal(ask.labelsAsk(), "team-bar:owner");
  assert.equal(ask.withLabels("/api/sessions"), "/api/sessions?labels=team-bar%3Aowner");
  assert.equal(ask.withLabels("/api/sessions/summary?id=a"), "/api/sessions/summary?id=a&labels=team-bar%3Aowner");
});

test("the same pairs again change nothing; new ones are kept; none clears the key and today's URLs come back", () => {
  let heard = 0;
  const off = ask.onLabelsAsk(() => heard++);
  ask.setLabelsAsk("team-bar:owner");
  assert.equal(heard, 0, "no reconnect, no re-read");
  ask.setLabelsAsk("people:owner");
  assert.equal(kept.get(ask.LABELS_READ_KEY), "people:owner");
  ask.setLabelsAsk(null);
  assert.equal(kept.has(ask.LABELS_READ_KEY), false);
  assert.equal(ask.withLabels("/api/sessions"), "/api/sessions");
  assert.equal(heard, 2);
  off();
});
