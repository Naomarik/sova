// The composer's waiting badge and its dialog (§chat.composer/waiting-badge, §chat.composer/waiting-dialog):
// the counts, the ring's arc, the numeral, the faded and hidden looks, the name, and the dialog's grouping.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AlignDocInfo, AlignQuestionInfo } from "../../shared/protocol";
import type { AlignEntry } from "./align";
import {
  alignmentLine,
  cardNumeral,
  dash,
  dotXs,
  newestFirst,
  nextOpenTopic,
  progressLength,
  RING_ARC,
  RING_CIRCUMFERENCE,
  waitingAlignments,
  waitingCounts,
  waitingLabel,
  waitingLook,
  waitingTitle,
} from "./waiting";

const q = (id: string, state: "open" | "decided" | "dropped", topic = id): AlignQuestionInfo => ({
  id,
  topic,
  ask: `${topic}?`,
  recommendation: { choice: "a", why: "" },
  ...(state === "decided" ? { decision: { text: "a", by: "user" as const, at: "2026-10-01T00:00:00Z" } } : {}),
  ...(state === "dropped" ? { dropped: { why: "n/a", at: "2026-10-01T00:00:00Z" } } : {}),
});

const doc = (id: string, questions: AlignQuestionInfo[], phase: AlignDocInfo["phase"] = "open"): AlignDocInfo => ({
  id,
  title: `Title ${id}`,
  summary: "",
  findings: [],
  approach: [],
  rejected: [],
  questions,
  phase,
  next: { f: 1, a: 1, x: 1, q: questions.length + 1 },
  rev: 1,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
});
const entry = (d: AlignDocInfo, rowId = `row-${d.id}`): AlignEntry => ({ doc: d, rowId });

// The reference glyph's example: 2 alignments, 5 live questions, 2 decided, 3 open.
const two = [entry(doc("al_1", [q("q1", "decided"), q("q2", "open"), q("q3", "dropped")])), entry(doc("al_2", [q("q1", "decided"), q("q2", "open"), q("q3", "open")]))];

describe("the counts", () => {
  test("open alignments, their decided and live questions, and the open ones; dropped questions count nowhere", () => {
    assert.deepEqual(waitingCounts(two, 1), { alignments: 2, decided: 2, total: 5, open: 3, cards: 1 });
  });

  test("done and dropped alignments are not counted; implementing ones are", () => {
    const list = [...two, entry(doc("al_3", [q("q1", "open")], "done")), entry(doc("al_4", [q("q1", "open")], "dropped")), entry(doc("al_5", [q("q1", "decided")], "implementing"))];
    assert.deepEqual(waitingCounts(list, 0), { alignments: 3, decided: 3, total: 6, open: 3, cards: 0 });
  });
});

describe("the ring", () => {
  test("the track is 270° of a radius-14 circle, as the reference draws it", () => {
    assert.equal(dash(RING_ARC), "65.97 87.96");
    assert.equal(RING_CIRCUMFERENCE.toFixed(2), "87.96");
  });

  test("the progress is decided / total of the arc: 2/5 is the reference's 26.39", () => {
    assert.equal(dash(progressLength(waitingCounts(two, 0))), "26.39 87.96");
    assert.equal(progressLength({ decided: 0, total: 4 }), 0);
    assert.equal(progressLength({ decided: 4, total: 4 }), RING_ARC);
    assert.equal(progressLength({ decided: 0, total: 0 }), 0, "no questions: no progress, never NaN");
  });

  test("the dots: one per open alignment, centred, 6 apart; closer past 6, inside the ring", () => {
    assert.deepEqual(dotXs(0), []);
    assert.deepEqual(dotXs(1), [0]);
    assert.deepEqual(dotXs(2), [-3, 3]);
    assert.deepEqual(dotXs(3), [-6, 0, 6]);
    assert.equal(dotXs(6).at(-1), 15);
    const many = dotXs(11);
    assert.equal(many.length, 11);
    assert.ok(Math.max(...many.map(Math.abs)) <= 15, "stays within the ring's width");
  });
});

describe("the numeral", () => {
  test("I, II, III, IV, then V+; nothing at 0", () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 40].map(cardNumeral), ["", "I", "II", "III", "IV", "V+", "V+", "V+"]);
    assert.equal(cardNumeral(-1), "");
  });
});

describe("the look", () => {
  test("hidden with nothing to list; the track and numeral alone with only cards", () => {
    assert.equal(waitingLook(waitingCounts([], 0)), "hidden");
    assert.equal(waitingLook(waitingCounts([entry(doc("al_1", [q("q1", "open")], "done"))], 0)), "hidden", "a done alignment is nothing to list");
    assert.equal(waitingLook(waitingCounts([], 2)), "cards");
  });

  test("faded when nothing is undecided and no card waits; full otherwise", () => {
    const decided = [entry(doc("al_1", [q("q1", "decided")]))];
    assert.equal(waitingLook(waitingCounts(decided, 0)), "faded");
    assert.equal(waitingLook(waitingCounts([entry(doc("al_1", []))], 0)), "faded", "no questions yet: nothing to decide");
    assert.equal(waitingLook(waitingCounts(decided, 1)), "full", "a card waiting is something waiting");
    assert.equal(waitingLook(waitingCounts(two, 0)), "full");
  });
});

describe("the name", () => {
  test("the counts in words, singular and plural, empty parts left out", () => {
    assert.equal(waitingLabel(waitingCounts(two, 1)), "3 questions open in 2 alignments, 1 card waiting — show what's waiting");
    assert.equal(waitingLabel(waitingCounts([entry(doc("al_1", [q("q1", "open")]))], 0)), "1 question open in 1 alignment — show what's waiting");
    assert.equal(waitingLabel(waitingCounts([], 3)), "3 cards waiting — show what's waiting");
    assert.equal(waitingLabel(waitingCounts([entry(doc("al_1", [q("q1", "decided")]))], 0)), "All questions decided in 1 alignment — show what's waiting");
    assert.equal(waitingLabel(waitingCounts([entry(doc("al_1", [])), entry(doc("al_2", []))], 0)), "2 alignments open — show what's waiting");
  });
});

describe("the dialog", () => {
  test("alignments: open ones only, those with an open question first, each group the last touched first", () => {
    // Entries come oldest-touched first.
    const list = [entry(doc("al_1", [q("q1", "open")])), entry(doc("al_2", [q("q1", "decided")])), entry(doc("al_3", [q("q1", "open")], "done")), entry(doc("al_4", [q("q1", "open")])), entry(doc("al_5", []))];
    assert.deepEqual(waitingAlignments(list).map((e) => e.doc.id), ["al_4", "al_1", "al_5", "al_2"]);
  });

  test("an alignment's line: decided of live, and its next open question's topic in question order", () => {
    const d = doc("al_1", [q("q1", "decided", "Budget"), q("q2", "dropped", "Gone"), q("q3", "open", "Queue shape"), q("q4", "open", "Later")]);
    assert.equal(nextOpenTopic(d), "Queue shape");
    assert.deepEqual(alignmentLine(d), { decided: 1, live: 3, next: "Next: Queue shape" });
    assert.deepEqual(alignmentLine(doc("al_2", [q("q1", "decided")])), { decided: 1, live: 1, next: "All decided" });
  });

  test("option cards newest first; equal times keep the later one first", () => {
    const cards = [
      { id: "of_1", at: "2026-10-01T10:00:00Z" },
      { id: "of_2", at: "2026-10-03T10:00:00Z" },
      { id: "of_3", at: "2026-10-02T10:00:00Z" },
      { id: "of_4", at: "2026-10-03T10:00:00Z" },
    ];
    assert.deepEqual(newestFirst(cards).map((c) => c.id), ["of_4", "of_2", "of_3", "of_1"]);
    assert.deepEqual(cards.map((c) => c.id), ["of_1", "of_2", "of_3", "of_4"], "the input is left as it was");
  });

  test("the title counts the items", () => {
    assert.equal(waitingTitle(3), "Waiting on you · 3");
  });
});
