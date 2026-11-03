// Paged lists on the owner page (§app.owner-page/content, §app.project-assistant/chat, Paged): the newest page merged by
// key into what is loaded, earlier pages put before it, nothing loaded ever dropped by a later read. The server's own
// paging (shared/project-assistant.ts pageOf, which server/project-assistant.ts serves) is used for the pages, so both halves are the shipped code.
import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyPaged, hasOlder, mergeNewest, prependOlder, type Paged } from "./paged";
import { pageOf } from "../../shared/project-assistant";

type Msg = { n: number; text: string };
const conversation = (count: number): Msg[] => Array.from({ length: count }, (_, i) => ({ n: i + 1, text: `message ${i}` }));
const byN = (m: Msg) => m.n;
const asPaged = (p: { messages: Msg[]; older: number }): Paged<Msg> => ({ rows: p.messages, older: p.older });

test("250 messages: the newest page, every older page back to message 0, then a push while busy keeps 0-49 in order", () => {
  let all = conversation(250);
  let shown = mergeNewest(emptyPaged<Msg>(), asPaged(pageOf(all)), byN);
  assert.deepEqual(shown.rows.map((m) => m.text)[0], "message 200", "it opens on the newest 50");
  assert.equal(shown.older, 200);
  // Scrolling up: each earlier page goes before what is shown, back to the first message.
  while (hasOlder(shown)) shown = prependOlder(shown, asPaged(pageOf(all, shown.rows[0]!.n)), byN);
  assert.equal(shown.rows.length, 250);
  // While the answer is written the server pushes its newest page again, then once more with the reply.
  shown = mergeNewest(shown, asPaged(pageOf(all)), byN);
  all = [...all, { n: 251, text: "message 250" }];
  shown = mergeNewest(shown, asPaged(pageOf(all)), byN);
  assert.equal(shown.older, 0);
  assert.deepEqual(
    shown.rows.slice(0, 50).map((m) => m.text),
    Array.from({ length: 50 }, (_, i) => `message ${i}`),
    "messages 0-49 are still shown, in order",
  );
  assert.deepEqual(shown.rows.map(byN), Array.from({ length: 251 }, (_, i) => i + 1), "every message once, in order");
});

test("an unchanged row keeps the object on screen; a changed one is replaced", () => {
  const first = mergeNewest(emptyPaged<Msg>(), { rows: [{ n: 1, text: "a" }, { n: 2, text: "b" }], older: 0 }, byN);
  const next = mergeNewest(first, { rows: [{ n: 1, text: "a" }, { n: 2, text: "b, edited" }], older: 0 }, byN);
  assert.equal(next.rows[0], first.rows[0], "the same object: a keyed list leaves it drawn");
  assert.notEqual(next.rows[1], first.rows[1]);
});

test("a row that moved to the end (a plan card at its latest change) keeps every row before the page", () => {
  type It = { id: string };
  const key = (x: It) => x.id;
  const prev: Paged<It> = { rows: ["a", "b", "P", "c", "d", "e"].map((id) => ({ id })), older: 0 };
  const merged = mergeNewest(prev, { rows: ["d", "e", "P"].map((id) => ({ id })), older: 3 }, key);
  assert.deepEqual(merged.rows.map(key), ["a", "b", "c", "d", "e", "P"]);
});

test("past a gap (more new rows than a page since the last read) the page starts afresh; contiguous rows stay", () => {
  const prev: Paged<Msg> = { rows: conversation(10), older: 0 };
  const gap = mergeNewest(prev, { rows: [{ n: 70, text: "x" }], older: 69 }, byN);
  assert.deepEqual(gap.rows.map(byN), [70], "no hole between message 10 and 70");
  assert.equal(gap.older, 69);
  const next = mergeNewest(prev, { rows: [{ n: 11, text: "y" }], older: 10 }, byN);
  assert.deepEqual(next.rows.map(byN), [...conversation(10).map(byN), 11]);
});

test("pageOf: a page ends before `before`, and says how many come before it", () => {
  const all = conversation(120);
  assert.deepEqual([pageOf(all).messages[0]!.n, pageOf(all).older], [71, 70]);
  assert.deepEqual([pageOf(all, 71).messages[0]!.n, pageOf(all, 71).messages.length, pageOf(all, 71).older], [21, 50, 20]);
  assert.deepEqual([pageOf(all, 21).messages.length, pageOf(all, 21).older], [20, 0]);
  assert.deepEqual(pageOf([], 5), { messages: [], older: 0 });
});
