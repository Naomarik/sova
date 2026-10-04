import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptItem } from "../../shared/protocol";
import { inputTotal, type Older, WHOLE } from "./older-rows";
import { cachedTranscript, cacheItems, cacheSpot, CACHED_SESSIONS, forgetTranscript, keptOlder, overBudget, reconcileItems, sameItem, TranscriptStore } from "./transcript-cache";

const row = (id: string, text = id, extra: Partial<TranscriptItem> = {}): TranscriptItem => ({
  id,
  kind: "assistant-text",
  text,
  at: "2026-09-27T00:00:00Z",
  ...(id.includes(":") && !id.endsWith(":0") ? {} : { meta: { type: "message", role: "assistant" } }),
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
  assert.ok(!sameItem(base, { ...base, at: "2026-09-27T00:00:01Z" }), "another write of the entry");
  assert.ok(!sameItem(base, { ...base, meta: { type: "message", role: "assistant", stopReason: "error" } }), "the entry's facts");
  assert.ok(!sameItem(base, { ...base, tool: { summary: "ls", lazy: true } }), "the folded line");
  assert.ok(!sameItem({ ...base, tool: { summary: "ls", stats: { added: 1, removed: 0 } } }, { ...base, tool: { summary: "ls", stats: { added: 2, removed: 0 } } }), "its count");
  assert.ok(sameItem({ ...base, tool: { summary: "ls", lazy: true } }, { ...base, tool: { summary: "ls", lazy: true } }), "equal tool parts by value");
  assert.ok(sameItem({ ...base, images: ["data:a"] }, { ...base, images: ["data:a"] }), "equal images by value");
});

test("opening keeps the last few sessions opened, least recent first out", () => {
  const st = new TranscriptStore(2);
  st.setItems("a", [row("a")]);
  st.setItems("b", [row("b")]);
  st.open("a");
  st.setItems("c", [row("c")]);
  assert.deepEqual(st.keys().sort(), ["a", "c"], "b was the least recently opened");
  st.setItems("a", [row("a2")]);
  st.setItems("d", [row("d")]);
  assert.deepEqual(st.keys().sort(), ["a", "d"]);
});

test("a pinned (Recent) session stays past the opened LRU and goes when unpinned", () => {
  const st = new TranscriptStore(2);
  st.pin(["r1", "r2"]);
  assert.ok(st.preload("r1", [row("x")], "2026-09-28T10:00:00.000Z", 10));
  assert.ok(st.preload("r2", [row("y")], "2026-09-28T10:00:00.000Z", 20));
  st.setItems("a", [row("a")]);
  st.setItems("b", [row("b")]);
  st.setItems("c", [row("c")]);
  assert.deepEqual(st.keys().sort(), ["b", "c", "r1", "r2"], "preloads never push an opened session out, nor opens a pinned one");
  st.pin(["r2", "b"]);
  assert.deepEqual(st.keys().sort(), ["b", "c", "r2"], "r1 left Recent and wasn't opened: gone");
  st.pin([]);
  assert.deepEqual(st.keys().sort(), ["b", "c"], "leaving Recent keeps what the LRU holds");
});

test("a pinned session opened and then unpinned stays as one of the last opened", () => {
  const st = new TranscriptStore(2);
  st.pin(["r"]);
  st.preload("r", [row("x")], "2026-09-28T10:00:00.000Z", 1);
  st.open("r");
  st.pin([]);
  assert.ok(st.peek("r"));
});

test("a preload is refused for an unpinned key and for a key a view shows", () => {
  const st = new TranscriptStore(2);
  assert.equal(st.preload("x", [row("x")], "2026-09-28T10:00:00.000Z", 1), false);
  st.pin(["x"]);
  const release = st.show("x");
  st.setItems("x", [row("live")]);
  assert.equal(st.preload("x", [row("old")], "2026-09-28T10:00:00.000Z", 1), false);
  assert.equal(st.peek("x")?.items[0]?.id, "live", "the view's rows win");
  release();
});

test("a shown session is kept whatever the LRU says, and is stamped when its last view goes", () => {
  let now = Date.parse("2026-09-28T10:00:00.000Z");
  const st = new TranscriptStore(1, () => now);
  const r1 = st.show("pane1");
  st.setItems("pane1", [row("p")]);
  const r2 = st.show("pane1");
  st.setItems("other", [row("o")]);
  assert.ok(st.peek("pane1"), "a pane in view outlives the LRU");
  assert.equal(st.stamp("pane1"), null, "unknown while shown");
  assert.equal(st.shownSince("pane1"), now);
  now += 5_000;
  r1();
  assert.ok(st.showing("pane1"), "one of two views left");
  r2();
  r2();
  assert.equal(st.showing("pane1"), false);
  assert.equal(st.peek("pane1"), undefined, "no longer shown, not in the LRU of 1, not pinned");
  st.pin(["k"]);
  const r3 = st.show("k");
  st.setItems("k", [row("k")]);
  r3();
  assert.equal(st.stamp("k"), "2026-09-28T10:00:05.000Z", "current as of the view going away");
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

test("overBudget drops the largest first, only until the rest fit", () => {
  const sizes = new Map([["a", 10], ["b", 30], ["c", 20], ["d", 5]]);
  assert.deepEqual(overBudget(sizes, 65), [], "at the budget: nothing");
  assert.deepEqual(overBudget(sizes, 64), ["b"]);
  assert.deepEqual(overBudget(sizes, 30), ["b", "c"]);
  assert.deepEqual(overBudget(sizes, 0), ["b", "c", "a", "d"]);
});

test("Recent sessions past the budget go largest first; opened and shown ones never count", () => {
  const T = "2026-09-28T10:00:00.000Z";
  const st = new TranscriptStore(1, Date.now, 100);
  st.pin(["a", "b", "c", "o"]);
  st.setItems("o", [row("o")]); // opened: outside the budget however big
  assert.ok(st.preload("a", [row("a")], T, 40));
  assert.ok(st.preload("b", [row("b")], T, 50));
  assert.equal(st.preload("c", [row("c")], T, 30), true, "c fits once b, the largest, goes");
  assert.deepEqual(st.keys().sort(), ["a", "c", "o"]);
  assert.equal(st.wouldKeep("b"), false, "b was 50: it would be dropped again beside a and c");
  assert.equal(st.wouldKeep("new"), true, "unknown size: worth a try");
  assert.equal(st.preload("big", [row("big")], T, 500), false, "unpinned");
  st.pin(["a", "c", "o", "big"]);
  assert.equal(st.preload("big", [row("big")], T, 500), false, "bigger than the whole budget: dropped itself");
  assert.deepEqual(st.keys().sort(), ["a", "c", "o"]);
  st.pin(["b", "o"]);
  assert.equal(st.wouldKeep("b"), true, "room again once the others left Recent");
});

test("a Recent session a view filled is measured when it leaves the opened set", () => {
  const st = new TranscriptStore(1, Date.now, 60);
  st.pin(["v", "p"]);
  st.setItems("v", [row("v", "x".repeat(100))]);
  assert.ok(st.preload("p", [row("p")], "2026-09-28T10:00:00.000Z", 50));
  st.setItems("other", [row("o")]);
  assert.deepEqual(st.trim(), ["v"], "v, over 100 characters serialized, is the largest");
  assert.deepEqual(st.keys().sort(), ["other", "p"]);
});

// ---- What is above the kept rows (switching back's counts before the hello) ----

const above = (inputs: string[]): Older => ({ left: inputs.length + 2, summary: { inputs, messages: inputs.length * 2, replies: true } });

test("a switch back counts the last visit's inputs with its kept rows until the hello", () => {
  const store = new TranscriptStore();
  const list = [row("u1", "u1", { kind: "user" }), row("a1")];
  store.setItems("k", list, above(["u0", "u-1"]));
  const kept = store.open("k");
  // Before the hello the view holds the kept rows themselves, and `older` is null.
  const o = keptOlder(kept, kept!.items);
  assert.ok(o);
  assert.equal(inputTotal(kept!.items, o), 3);
  // The view writes its rows back before its hello: the kept pair stays.
  store.setItems("k", kept!.items, null);
  assert.deepEqual(store.peek("k")!.older, above(["u0", "u-1"]));
});

test("the kept older describes only the rows kept with it", () => {
  const store = new TranscriptStore();
  const list = [row("u1", "u1", { kind: "user" })];
  store.setItems("k", list, above(["u0"]));
  const kept = store.open("k");
  assert.equal(keptOlder(kept, [...list, row("a1")]), null, "other rows: nothing is known above them");
  assert.equal(keptOlder(undefined, list), null);
  assert.equal(keptOlder(kept, null), null);
  store.setItems("k", [...list, row("a1")], null);
  assert.equal(store.peek("k")!.older, null, "new rows without a hello's word drop the pair");
});

test("a hello's older replaces the kept one, and a kept older is never another view's", () => {
  const store = new TranscriptStore();
  const list = [row("u1", "u1", { kind: "user" })];
  store.setItems("a", list, above(["u0"]));
  store.setItems("a", list, WHOLE);
  assert.equal(store.peek("a")!.older, WHOLE);
  assert.equal(keptOlder(store.open("b"), list), null);
});

test("preloaded rows keep what their fetch said is above them", () => {
  const store = new TranscriptStore();
  store.pin(["p"]);
  assert.equal(store.preload("p", [row("x")], "2026-09-27T00:00:00Z", 10, above(["u0"])), true);
  assert.deepEqual(store.peek("p")!.older, above(["u0"]));
  store.preload("p", [row("x")], "2026-09-27T00:00:01Z", 10);
  assert.equal(store.peek("p")!.older, null);
});
