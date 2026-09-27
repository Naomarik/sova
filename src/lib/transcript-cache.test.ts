import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptItem } from "../../shared/protocol";
import { cachedTranscript, cacheItems, cacheSpot, CACHED_SESSIONS, forgetTranscript, Lru, reconcileItems, sameItem } from "./transcript-cache";

const row = (id: string, text = id, extra: Partial<TranscriptItem> = {}): TranscriptItem => ({
  id,
  kind: "assistant-text",
  text,
  raw: { id: id.split(":")[0], timestamp: "2026-09-27T00:00:00Z", type: "message" },
  ...extra,
});

test("a refetch keeps the old object of every row that renders the same", () => {
  const prev = [row("a"), row("b"), row("c")];
  const next = [row("a"), row("b", "edited"), row("c"), row("d")];
  const out = reconcileItems(prev, next);
  assert.equal(out[0], prev[0]);
  assert.notEqual(out[1], prev[1], "changed text: the new row");
  assert.equal(out[1], next[1]);
  assert.equal(out[2], prev[2]);
  assert.equal(out[3], next[3], "a new row is itself");
});

test("an unchanged refetch returns the old list itself", () => {
  const prev = [row("a"), row("b")];
  assert.equal(reconcileItems(prev, [row("a"), row("b")]), prev);
});

test("a shorter refetch (a rewind) keeps the rows it still has, not the list", () => {
  const prev = [row("a"), row("b"), row("c")];
  const out = reconcileItems(prev, [row("a"), row("b")]);
  assert.notEqual(out, prev);
  assert.deepEqual(out, [prev[0], prev[1]]);
  assert.equal(out[0], prev[0]);
});

test("nothing to reconcile against: the new list as sent", () => {
  const next = [row("a")];
  assert.equal(reconcileItems(null, next), next);
  assert.equal(reconcileItems([], next), next);
});

test("sameItem tells apart every field a row renders from", () => {
  const base = row("t", "bash", { kind: "tool-call", toolCallId: "c1", model: "m/1" });
  assert.ok(sameItem(base, row("t", "bash", { kind: "tool-call", toolCallId: "c1", model: "m/1" })));
  assert.ok(!sameItem(base, { ...base, model: "m/2" }));
  assert.ok(!sameItem(base, { ...base, toolCallId: "c2" }));
  assert.ok(!sameItem(base, { ...base, images: ["data:x"] }));
  assert.ok(!sameItem(base, { ...base, report: { text: "x" } as never }));
  assert.ok(!sameItem(base, { ...base, raw: { id: "t", timestamp: "2026-09-27T00:00:01Z", type: "message" } }), "another write of the entry");
  assert.ok(sameItem({ ...base, images: ["data:a"] }, { ...base, images: ["data:a"] }), "equal images by value");
});

test("the LRU keeps the most recently used keys", () => {
  const l = new Lru<string, number>(2);
  l.set("a", 1);
  l.set("b", 2);
  l.get("a");
  l.set("c", 3);
  assert.deepEqual(l.keys(), ["a", "c"], "b was the least recently used");
  l.set("a", 4);
  assert.deepEqual(l.keys(), ["c", "a"]);
  assert.equal(l.get("a"), 4);
});

test("the transcript cache holds the last CACHED_SESSIONS sessions with their scroll spot", () => {
  const keys = Array.from({ length: CACHED_SESSIONS + 1 }, (_, i) => `k${i}`);
  for (const k of keys) cacheItems(k, [row(k)]);
  assert.equal(cachedTranscript(keys[0]!), undefined, "the oldest went");
  const last = keys[keys.length - 1]!;
  assert.equal(cachedTranscript(last)?.spot, null);
  cacheSpot(last, { follow: false, rowId: "x", offset: 12 });
  cacheItems(last, [row("y")]);
  assert.deepEqual(cachedTranscript(last)?.spot, { follow: false, rowId: "x", offset: 12 }, "new rows keep the spot");
  cacheSpot("never-cached", { follow: true });
  assert.equal(cachedTranscript("never-cached"), undefined, "a spot alone is not a transcript");
  for (const k of keys) forgetTranscript(k);
});
