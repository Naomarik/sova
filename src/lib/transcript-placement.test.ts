// Run: pnpm test -- src/lib/transcript-placement.test.ts
// Where a card stands (§chat.transcript-cards/placement): every row stands where it was raised and
// nothing moves to the end; a following card raised again is a new revision at its own point, and
// only its newest revision (by key) draws the whole card.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptItem } from "../../shared/protocol";
import { newestAlignRows } from "./align";
import { kindById, newestRevisions, type KindContext } from "./transcript-kinds";
import { newestByKey } from "./transcript-placement";

const ctx: KindContext = { hasUserRow: () => true, tourCard: () => undefined, showChanges: () => undefined, offer: () => undefined, settings: () => undefined, card: () => undefined };
const doc = (id: string) => ({ id }) as never;

test("a card raised again follows by revision: only its newest row draws it", () => {
  const rows = [
    { id: "1", key: "al_1" },
    { id: "2", key: undefined },
    { id: "3", key: "al_2" },
    { id: "4", key: "al_1" },
  ];
  assert.deepEqual([...newestByKey(rows, (r) => r.key, (r) => r.id)].sort(), ["3", "4"]);
});

test("a follow card raised twice: the later revision draws full at its own place, the next reply after it, nothing moves to the end", () => {
  const items = [
    { id: "a", kind: "user", text: "go" },
    { id: "r1", kind: "align", align: { doc: doc("al_1") } },
    { id: "b", kind: "assistant-text", text: "thinking it over" },
    { id: "r2", kind: "align", align: { doc: doc("al_1") } },
    { id: "c", kind: "assistant-text", text: "the next reply" },
  ] as unknown as TranscriptItem[];
  assert.equal(kindById("align")?.placement, "follow");
  const full = newestRevisions(items, ctx);
  assert.deepEqual([...full], ["r2"], "only the later revision draws the whole card; r1 folds");
  // The kind list never reorders: the rows draw in the order they were raised.
  const order = items.map((it) => it.id);
  assert.deepEqual(order, ["a", "r1", "b", "r2", "c"]);
  assert.ok(order.indexOf("c") > order.indexOf("r2"), "the reply after it draws below it");
  assert.notEqual(order.at(-1), "r2", "nothing is pinned at the end");
});

test("the alignment card's newest revisions are the kind's follow rule, unchanged", () => {
  const items = [
    { id: "a", kind: "align", align: { doc: doc("al_1") } },
    { id: "b", kind: "info" },
    { id: "c", kind: "align", align: { doc: doc("al_2") } },
    { id: "d", kind: "align", align: { doc: doc("al_1") } },
    { id: "e", kind: "align", align: { exempt: { why: "x" } } },
  ] as unknown as TranscriptItem[];
  assert.deepEqual([...newestAlignRows(items)].sort(), ["c", "d"]);
  assert.deepEqual([...newestRevisions(items, ctx)].sort(), ["c", "d"]);
});

test("a card raised from outside stands after its entry's rows, by its time when that entry isn't on screen", async () => {
  const { placeOutsideCards } = await import("./transcript-placement");
  const rows = [
    { id: "e1", at: "2026-01-01T00:00:01Z" },
    { id: "e2", at: "2026-01-01T00:00:02Z" },
    { id: "e2:stop", at: "2026-01-01T00:00:02Z" },
    { id: "e3", at: "2026-01-01T00:00:05Z" },
  ];
  const row = (c: { id: string }) => ({ id: `card:${c.id}` });
  const ids = (cs: { id: string; at: string; after?: string | null }[]) => placeOutsideCards(rows, cs, row).map((r) => r.id);
  assert.deepEqual(ids([{ id: "cd_1", at: "2026-01-01T00:00:03Z", after: "e2" }]), ["e1", "e2", "e2:stop", "card:cd_1", "e3"], "after every row of its entry");
  assert.deepEqual(ids([{ id: "cd_1", at: "2026-01-01T00:00:03Z", after: "gone" }]), ["e1", "e2", "e2:stop", "card:cd_1", "e3"], "by time when its entry isn't loaded");
  assert.deepEqual(ids([{ id: "cd_1", at: "2026-01-01T00:00:00Z", after: null }]), ["card:cd_1", "e1", "e2", "e2:stop", "e3"]);
  assert.deepEqual(
    ids([
      { id: "cd_2", at: "2026-01-01T00:00:04Z", after: "e2" },
      { id: "cd_1", at: "2026-01-01T00:00:03Z", after: "e2" },
    ]),
    ["e1", "e2", "e2:stop", "card:cd_1", "card:cd_2", "e3"],
    "two at one place in the order they were raised",
  );
  assert.equal(placeOutsideCards(rows, [], row), rows, "no card: the same list");
});

test("a card row matches the card kind; a follow card's revisions share a key and only the newest draws whole", () => {
  const card = (id: string, rev: number, key = "k") => ({ id, type: "project.plan", title: "Plan", draws: "checklist", answerMode: "at-once", placement: "follow", key, revision: rev, data: { title: "P", items: [{ text: "a", done: false }] }, at: "2026-01-01T00:00:00Z", by: { kind: "script" }, after: null, state: "open" });
  const items = [
    { id: "card:cd_1", kind: "card", card: card("cd_1", 1) },
    { id: "u1", kind: "user", text: "hi" },
    { id: "card:cd_2", kind: "card", card: card("cd_2", 2) },
    { id: "card:cd_3", kind: "card", card: card("cd_3", 1, "other") },
  ] as never;
  assert.equal(kindById("card")?.match((items as { kind: string }[])[0] as never, ctx) ? "card" : undefined, "card");
  assert.deepEqual([...newestRevisions(items, ctx)].sort(), ["card:cd_2", "card:cd_3"]);
});
