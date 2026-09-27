import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptItem } from "../../shared/protocol";
import { helloItems, historyItems, newRows, type Assembled } from "./tail-hello";

const row = (id: string, text = id): TranscriptItem => ({ id, kind: "user", text, raw: null });
const rows = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => row(`r${from + i}`));
const ids = (items: TranscriptItem[]) => items.map((it) => it.id);

/** A server's cut of `whole`: the tail from `start`, and history chunks of `size`, newest first. */
function cut(whole: TranscriptItem[], start: number, size: number) {
  const chunks: { items: TranscriptItem[]; left: number }[] = [];
  for (let to = start; to > 0; to -= size) {
    const from = Math.max(0, to - size);
    chunks.push({ items: whole.slice(from, to), left: from });
  }
  return { tail: whole.slice(start), older: start, chunks };
}
const feed = (a: Assembled, chunks: { items: TranscriptItem[]; left: number }[]) =>
  chunks.reduce((s, c) => (s.broken ? s : historyItems(s.items, s.arriving, c.items, c.left)), a);

test("a whole hello is whole: no older rows arriving, reconciled as before", () => {
  const prev = rows(0, 5);
  const next = rows(0, 5).map((r) => ({ ...r }));
  const a = helloItems(prev, next);
  assert.equal(a.arriving, null);
  assert.equal(a.items, prev, "unchanged rows keep the old list");
  assert.equal(helloItems(prev, next, 0).arriving, null);
});

test("cold open: each chunk is prepended as it lands, and the list ends whole", () => {
  const whole = rows(0, 100);
  const c = cut(whole, 70, 25);
  let a = helloItems(null, c.tail, c.older);
  assert.deepEqual(ids(a.items), ids(whole.slice(70)));
  assert.equal(a.arriving?.mode, "prepend");
  a = historyItems(a.items, a.arriving, c.chunks[0]!.items, c.chunks[0]!.left);
  assert.deepEqual(ids(a.items), ids(whole.slice(45)), "the first chunk is on screen already");
  assert.ok(a.arriving);
  a = feed(a, c.chunks.slice(1));
  assert.equal(a.arriving, null);
  assert.deepEqual(ids(a.items), ids(whole));
});

test("over a whole cached list: the cached rows stay until the last chunk, then one reconcile keeps their objects", () => {
  const whole = rows(0, 100);
  const cached = whole.map((r) => ({ ...r }));
  const c = cut(whole, 70, 25);
  let a = helloItems(cached, c.tail, c.older);
  assert.equal(a.arriving?.mode, "buffer");
  assert.deepEqual(ids(a.items), ids(whole), "nothing on screen moves");
  const before = a.items;
  a = historyItems(a.items, a.arriving, c.chunks[0]!.items, c.chunks[0]!.left);
  assert.equal(a.items, before, "a chunk alone changes nothing on screen");
  a = feed(a, c.chunks.slice(1));
  assert.equal(a.arriving, null);
  assert.deepEqual(ids(a.items), ids(whole));
  assert.ok(a.items.every((it, i) => it === cached[i]), "same objects: no row rebuilt");
});

test("over a partial cached list (left mid-history last time): the prefix is provisional, the end is whole", () => {
  const whole = rows(0, 100);
  const cached = whole.slice(40); // the last visit got this far
  const c = cut(whole, 70, 25);
  let a = helloItems(cached, c.tail, c.older);
  assert.equal(a.arriving?.mode, "buffer");
  assert.deepEqual(ids(a.items), ids(whole.slice(40)));
  a = feed(a, c.chunks);
  assert.deepEqual(ids(a.items), ids(whole));
});

test("a rewind whose hello's first row isn't on screen: the list becomes the tail, then prepends", () => {
  const cached = rows(0, 50);
  const branch = [...rows(0, 10), row("n1"), row("n2"), row("n3")];
  const c = cut(branch, 11, 5);
  const a = helloItems(cached, c.tail, c.older);
  assert.equal(a.arriving?.mode, "prepend");
  assert.deepEqual(ids(a.items), ["n2", "n3"]);
  assert.deepEqual(ids(feed(a, c.chunks).items), ids(branch));
});

test("appends while older rows arrive stay at the end", () => {
  const whole = rows(0, 30);
  const c = cut(whole, 20, 10);
  for (const prev of [null, whole.map((r) => ({ ...r }))]) {
    let a = helloItems(prev, c.tail, c.older);
    a = historyItems(a.items, a.arriving, c.chunks[0]!.items, c.chunks[0]!.left);
    a = { ...a, items: [...a.items, row("late")] };
    a = feed(a, c.chunks.slice(1));
    assert.deepEqual(ids(a.items), [...ids(whole), "late"], prev ? "buffer" : "prepend");
  }
});

test("a whole reload while rows arrive ends it: a later chunk is ignored", () => {
  const whole = rows(0, 30);
  const c = cut(whole, 20, 10);
  const a = helloItems(null, c.tail, c.older);
  // The view's resync set the whole list and dropped `arriving`.
  const after = historyItems(whole, null, c.chunks[0]!.items, c.chunks[0]!.left);
  assert.equal(after.items, whole);
  assert.equal(after.arriving, null);
  assert.ok(a.arriving);
});

test("a hello while rows arrive starts again from it", () => {
  const whole = rows(0, 30);
  const c = cut(whole, 20, 10);
  let a = helloItems(null, c.tail, c.older);
  a = historyItems(a.items, a.arriving, c.chunks[0]!.items, c.chunks[0]!.left);
  const again = helloItems(a.items, c.tail, c.older);
  assert.equal(again.arriving?.got, 0);
  assert.deepEqual(ids(feed(again, c.chunks).items), ids(whole));
});

test("chunks that don't add up break it, and the view reloads whole", () => {
  const whole = rows(0, 30);
  const c = cut(whole, 20, 10);
  const a = helloItems(null, c.tail, c.older);
  assert.equal(historyItems(a.items, a.arriving, c.chunks[0]!.items.slice(1), c.chunks[0]!.left).broken, true, "a row short");
  // The right count, but the last chunk repeats a row the tail already has.
  const first = historyItems(a.items, a.arriving, c.chunks[0]!.items, c.chunks[0]!.left);
  const repeated = historyItems(first.items, first.arriving, [...c.chunks[1]!.items.slice(1), c.tail[0]!], 0);
  assert.equal(repeated.broken, true, "a repeated row");
});

test("'N new' counts from the hello's first row: rows prepended above never count", () => {
  const whole = rows(0, 30);
  const c = cut(whole, 20, 10);
  let a = helloItems(null, c.tail, c.older);
  const from = c.tail[0]!.id;
  assert.equal(newRows(a.items, from).length, 10);
  a = feed(a, c.chunks);
  assert.equal(newRows(a.items, from).length, 10);
  assert.equal(newRows([...a.items, row("x")], from).length, 11);
  assert.equal(newRows(a.items, null).length, 30);
  assert.equal(newRows(a.items, "gone").length, 30);
});

test("historyApplier: chunks within the interval are applied together, the last at once; drop forgets the rest", async () => {
  const { historyApplier } = await import("./tail-hello");
  const calls: number[][] = [];
  const a = historyApplier((chunks) => calls.push(chunks.map((c) => c.left)), 40);
  a.push({ items: [], left: 30 }); // nothing applied yet in this interval: goes out on the next tick
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls, [[30]]);
  a.push({ items: [], left: 20 });
  a.push({ items: [], left: 10 });
  assert.deepEqual(calls, [[30]], "within the interval: held");
  a.push({ items: [], left: 0 });
  assert.deepEqual(calls, [[30], [20, 10, 0]], "the last chunk flushes everything held, at once");
  a.push({ items: [], left: 5 });
  a.drop();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.length, 2, "dropped: never applied");
});
