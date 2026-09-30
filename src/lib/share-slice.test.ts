// The share page's slice model (§app.session-share/share-page).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionShareView } from "../../shared/session-share";
import { applyHint, bounds, canFollowLive, earlierLine, endsLine, hints, inSlice, mergeEarlier, mergeNewest, normalize, rangeLabel, shareHref, shareRouteFromHash, sliceOfShare, spanOf, tap, WHOLE, type Slice, type SliceRow } from "./share-slice";

// u0 r1 r2 u3 r4 u5 r6 u7 — three turns with replies, the last question unanswered.
const rows: SliceRow[] = ["u0", "r1", "r2", "u3", "r4", "u5", "r6", "u7"].map((id) => ({ id, kind: id.startsWith("u") ? "user" : "reply" }));
const taps = (...ids: string[]): Slice => ids.reduce((s, id) => tap(rows, s, id), WHOLE);

test("the route round-trips its session, host, share and start, and refuses other hashes", () => {
  const href = shareHref("0198-a b", { host: "peer 1", share: "ss_x", from: "e/1" });
  assert.deepEqual(shareRouteFromHash(href), { sessionId: "0198-a b", host: "peer 1", share: "ss_x", from: "e/1" });
  assert.equal(shareHref("s1"), "#/share/s1");
  assert.deepEqual(shareRouteFromHash("#/share/s1"), { sessionId: "s1", host: null, share: null, from: null });
  assert.deepEqual(shareRouteFromHash("#/share/s1?from=e2&host=p"), { sessionId: "s1", host: "p", share: null, from: "e2" });
  for (const h of ["#/shares", "#/shares/", "#/share/", "#/share/a/b", "#/s/x", "#/share/%E0%A4"]) assert.equal(shareRouteFromHash(h), null, h);
});

test("the first tap is the start, the second the end", () => {
  assert.deepEqual(taps("r2"), { start: "r2", end: null });
  assert.deepEqual(taps("r2", "u5"), { start: "r2", end: "u5" });
});

test("a second tap above the start swaps them", () => {
  assert.deepEqual(taps("u5", "r1"), { start: "r1", end: "u5" });
});

test("tapping a boundary again clears it; a one-message slice clears whole", () => {
  assert.deepEqual(taps("r2", "r2"), WHOLE);
  assert.deepEqual(taps("r2", "u5", "r2"), { start: null, end: "u5" });
  assert.deepEqual(taps("r2", "u5", "u5"), { start: "r2", end: null });
  assert.deepEqual(taps("r2", "r2"), WHOLE);
  // start and end on one row: that row is a slice of one message, and one tap clears it
  assert.deepEqual(normalize(rows, { start: "r4", end: "r4" }), { start: "r4", end: "r4" });
  assert.deepEqual(tap(rows, { start: "r4", end: "r4" }, "r4"), WHOLE);
});

test("with only an end, the next tap is the start, swapping when it falls below", () => {
  assert.deepEqual(tap(rows, { start: null, end: "u5" }, "r1"), { start: "r1", end: "u5" });
  assert.deepEqual(tap(rows, { start: null, end: "u3" }, "r6"), { start: "u3", end: "r6" });
});

test("a third tap moves the nearer boundary; outside the range, the boundary on its side", () => {
  const both = taps("r1", "r6");
  assert.deepEqual(tap(rows, both, "r2"), { start: "r2", end: "r6" });
  assert.deepEqual(tap(rows, both, "u5"), { start: "r1", end: "u5" });
  assert.deepEqual(tap(rows, both, "u0"), { start: "u0", end: "r6" });
  assert.deepEqual(tap(rows, both, "u7"), { start: "r1", end: "u7" });
  // r1 (1) … r6 (6): u3 (3) is 2 from the start and 3 from the end; r4 (4) is a tie → the end moves
  assert.deepEqual(tap(rows, both, "u3"), { start: "u3", end: "r6" });
  assert.deepEqual(tap(rows, { start: "r1", end: "u7" }, "r4"), { start: "r1", end: "r4" });
});

test("a tap on an id not in the list changes nothing; a boundary that left the list is its default again", () => {
  assert.deepEqual(tap(rows, { start: "r2", end: null }, "gone"), { start: "r2", end: null });
  assert.deepEqual(normalize(rows, { start: "gone", end: "u5" }), { start: null, end: "u5" });
  assert.deepEqual(normalize(rows, { start: "u5", end: "r1" }), { start: "r1", end: "u5" });
});

test("bounds and membership: the whole list until something is picked", () => {
  assert.deepEqual(bounds(rows, WHOLE), { first: 0, last: 7 });
  assert.deepEqual(bounds(rows, { start: "u3", end: null }), { first: 3, last: 7 });
  assert.deepEqual(bounds(rows, { start: null, end: "u3" }), { first: 0, last: 3 });
  assert.equal(inSlice(rows, { start: "r2", end: "r4" }, 1), false);
  assert.equal(inSlice(rows, { start: "r2", end: "r4" }, 2), true);
  assert.equal(inSlice(rows, { start: "r2", end: "r4" }, 4), true);
  assert.equal(inSlice(rows, { start: "r2", end: "r4" }, 5), false);
});

test("hints offer the other half of a turn, and only when it exists", () => {
  // a start on a reply: the turn's question, even two replies back
  assert.deepEqual(hints(rows, { start: "r2", end: null }), [{ kind: "question", id: "u0" }]);
  // an end on a question: the last reply of that turn
  assert.deepEqual(hints(rows, { start: null, end: "u0" }), [{ kind: "reply", id: "r2" }]);
  assert.deepEqual(hints(rows, { start: "r4", end: "u5" }), [
    { kind: "question", id: "u3" },
    { kind: "reply", id: "r6" },
  ]);
  // already paired: a start on a question, an end on a reply
  assert.deepEqual(hints(rows, { start: "u3", end: "r4" }), []);
  // defaults never hint; nor does a question with no reply yet, nor a reply with no question before it
  assert.deepEqual(hints(rows, WHOLE), []);
  assert.deepEqual(hints(rows, { start: null, end: "u7" }), []);
  const orphan: SliceRow[] = [{ id: "r0", kind: "reply" }, { id: "u1", kind: "user" }];
  assert.deepEqual(hints(orphan, { start: "r0", end: null }), []);
});

test("a hint moves exactly its boundary, and the result has no hint left", () => {
  const s: Slice = { start: "r4", end: "u5" };
  const [q, r] = hints(rows, s);
  const widened = applyHint(applyHint(s, q!), r!);
  assert.deepEqual(widened, { start: "u3", end: "r6" });
  assert.deepEqual(hints(rows, widened), []);
});

test("the range in words", () => {
  assert.equal(rangeLabel({ first: 12, last: 18, total: 40 }), "Messages 12–18 of 40");
  assert.equal(rangeLabel({ first: 12, last: 12, total: 40 }), "Message 12 of 40");
  assert.equal(rangeLabel({ first: 1, last: 40, total: 40 }), "All 40 messages");
  assert.equal(rangeLabel({ first: 1, last: 1, total: 1 }), "Message 1 of 1");
  assert.equal(rangeLabel({ first: 1, last: 0, total: 0 }), "No messages yet");
  assert.equal(rangeLabel({ first: 12, last: null, total: 40 }), "From message 12 · follows live");
  assert.equal(rangeLabel({ first: 1, last: null, total: 40 }), "All messages · follows live");
});

test("a picked slice's span, and Follow live only while the end is the latest", () => {
  assert.deepEqual(spanOf(rows, WHOLE, false), { first: 1, last: 8, total: 8 });
  assert.equal(rangeLabel(spanOf(rows, WHOLE, false)), "All 8 messages");
  assert.equal(rangeLabel(spanOf(rows, { start: "r2", end: "u5" }, false)), "Messages 3–6 of 8");
  assert.equal(rangeLabel(spanOf(rows, { start: "u3", end: null }, true)), "From message 4 · follows live");
  assert.equal(canFollowLive({ start: "u3", end: null }), true);
  assert.equal(canFollowLive({ start: null, end: "u3" }), false);
});

const view = (ns: number[], extra: Partial<SessionShareView> = {}): SessionShareView => ({
  title: "t",
  sharedAt: "2026-09-30T00:00:00Z",
  mode: "live",
  through: null,
  items: ns.map((n) => ({ kind: "user", n, text: `m${n}` })),
  images: 0,
  ...extra,
});

test("a pushed newest page keeps earlier pages read; a reset replaces the view whole", () => {
  const read = view([0, 1, 2, 3]);
  const merged = mergeNewest(read, view([2, 3, 4], { before: 2 }));
  assert.deepEqual(merged.items.map((i) => i.n), [0, 1, 2, 3, 4]);
  assert.equal(merged.before, undefined);
  // the start moved: the new slice renumbers from 0, and none of the old one may stay on screen
  const reset = mergeNewest(read, view([2, 3], { earlier: true }), true);
  assert.deepEqual(reset.items.map((i) => i.text), ["m2", "m3"]);
  assert.equal(reset.earlier, true);
  assert.deepEqual(mergeNewest(null, view([5])).items.map((i) => i.n), [5]);
});

test("the earlier line shows only above the slice's first item", () => {
  assert.equal(earlierLine({ earlier: true }), true);
  assert.equal(earlierLine({ earlier: true, before: 200 }), false);
  assert.equal(earlierLine({}), false);
});

test("Change Slice opens on the share's own slice", () => {
  const timed = rows.map((r, i) => ({ ...r, at: `2026-09-30T00:0${i}:00Z` }));
  assert.deepEqual(sliceOfShare(timed, { mode: "snapshot", from: "r2", cut: "u5", cutAt: null }), { start: "r2", end: "u5" });
  assert.deepEqual(sliceOfShare(timed, { mode: "live", from: "r2", cutAt: null }), { start: "r2", end: null });
  // a cut that isn't a row (a tool step's entry): the span's last, else the last row by the cut's time
  assert.deepEqual(sliceOfShare(timed, { mode: "snapshot", cut: "tool", cutAt: null, span: { first: 1, last: 4, total: 8 } }), { start: null, end: "u3" });
  assert.deepEqual(sliceOfShare(timed, { mode: "snapshot", cut: "tool", cutAt: "2026-09-30T00:02:30Z" }), { start: null, end: "r2" });
  // a start that left the branch is the default again
  assert.deepEqual(sliceOfShare(timed, { mode: "live", from: "gone", cutAt: null }), WHOLE);
});

test("the two ends in words", () => {
  assert.equal(endsLine(rows, WHOLE, false), "From the first message · To the latest");
  assert.equal(endsLine(rows, { start: "r2", end: "u5" }, false), "From message 3 · To message 6");
  assert.equal(endsLine(rows, { start: "u3", end: null }, true), "From message 4 · Follows live");
});

const many = (from: number, to: number, lineage: string, tag = "m", extra: Partial<SessionShareView> = {}): SessionShareView =>
  view([], { lineage, ...extra, items: Array.from({ length: to - from }, (_, k) => ({ kind: "user" as const, n: from + k, text: `${tag}${from + k}` })) });

test("a view of another lineage replaces the page whole, earlier pages included, even with no reset", () => {
  // 450 items: the newest 200 read, then two Show Earlier pages
  let cur = many(250, 450, "A", "m", { before: 250 });
  cur = mergeEarlier(cur, many(50, 250, "A", "m", { before: 50 }))!;
  cur = mergeEarlier(cur, many(0, 50, "A"))!;
  assert.equal(cur.items.length, 450);
  // the start moved: the same numbers now hold other messages, in lineage B
  const next = many(100, 300, "B", "x", { before: 100, earlier: true });
  const after = mergeNewest(cur, next);
  assert.deepEqual(after, next);
  assert.equal(after.items.some((i) => i.text.startsWith("m")), false);
});

test("the same lineage merges with the earlier pages already read", () => {
  let cur = many(250, 450, "A", "m", { before: 250 });
  cur = mergeEarlier(cur, many(50, 250, "A", "m", { before: 50 }))!;
  const grown = mergeNewest(cur, many(260, 460, "A", "m", { before: 260 }));
  assert.deepEqual(grown.items.map((i) => i.n), Array.from({ length: 410 }, (_, k) => 50 + k));
  assert.equal(grown.before, 50);
});

test("a Show Earlier answer of another lineage is dropped", () => {
  const cur = many(250, 450, "A", "m", { before: 250 });
  assert.equal(mergeEarlier(cur, many(50, 250, "B", "x", { before: 50 })), null);
  assert.equal(mergeEarlier(cur, many(50, 250, "A", "m", { before: 50 }))!.items.length, 400);
});
