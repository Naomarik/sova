// Run: pnpm test -- src/lib/transcript-placement.test.ts
// Where a card stands (§chat.transcript-cards/placement): anchored rows keep their place, a following
// row stands at the end while its condition holds and settles back at its own place after, and a
// card raised again follows by revision (the newest row of each card draws it).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptItem } from "../../shared/protocol";
import { newestAlignRows } from "./align";
import { newestByKey, placeRows } from "./transcript-placement";

test("with nothing following, the rows are the same array, untouched", () => {
  const rows = ["a", "b", "c"];
  assert.equal(placeRows(rows, () => false), rows);
});

test("a following row stands at the end, below the newest row, in its own order with others", () => {
  const follows = new Set(["b", "d"]);
  assert.deepEqual(placeRows(["a", "b", "c", "d", "e"], (r) => follows.has(r)), ["a", "c", "e", "b", "d"]);
});

test("as the chat goes on it stays at the end; once its condition stops it settles where it was raised", () => {
  const open = new Set(["q"]);
  const follows = (r: string) => open.has(r);
  assert.deepEqual(placeRows(["a", "q", "b"], follows), ["a", "b", "q"]);
  assert.deepEqual(placeRows(["a", "q", "b", "c"], follows), ["a", "b", "c", "q"], "a new row arrives above it");
  open.delete("q");
  assert.deepEqual(placeRows(["a", "q", "b", "c"], follows), ["a", "q", "b", "c"], "answered: back at its place");
});

test("a card raised again follows by revision: only its newest row draws it", () => {
  const rows = [
    { id: "1", key: "al_1" },
    { id: "2", key: undefined },
    { id: "3", key: "al_2" },
    { id: "4", key: "al_1" },
  ];
  assert.deepEqual([...newestByKey(rows, (r) => r.key, (r) => r.id)].sort(), ["3", "4"]);
});

test("the alignment card's newest revisions are that rule, unchanged", () => {
  const doc = (id: string) => ({ id }) as never;
  const items = [
    { id: "a", kind: "align", align: { doc: doc("al_1") } },
    { id: "b", kind: "info" },
    { id: "c", kind: "align", align: { doc: doc("al_2") } },
    { id: "d", kind: "align", align: { doc: doc("al_1") } },
    { id: "e", kind: "align", align: { exempt: { why: "x" } } },
  ] as unknown as TranscriptItem[];
  assert.deepEqual([...newestAlignRows(items)].sort(), ["c", "d"]);
});
