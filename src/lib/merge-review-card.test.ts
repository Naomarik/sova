// A blocking review's own card: its state line across every state, its fold, and the queue card's pointer.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewCard, ReviewCardState } from "../../shared/merge-queue";
import { cardNotes, reviewNotes, reviewPointer, type QueueCard } from "./merge-queue-card";
import { foldedIds, foldedReviewLine, kindWord, REVIEW_KIND_WORD, REVIEW_STATE_LABEL, reviewCardRows, reviewHead, reviewRowOf, reviewStateLine } from "./merge-review-card";
import { REVIEW_KINDS } from "../../shared/merge-queue";

const SHA = "b".repeat(40);
const review = (x: Partial<ReviewCard> = {}): ReviewCard => ({
  id: "me_1:mr_1",
  entry: "me_1",
  session: "s1",
  project: "prj_1",
  root: "/w/sova",
  branch: "feat/x",
  target: "master",
  commit: SHA,
  run: "mr_1",
  try: 1,
  of: 3,
  summary: "Two shortcuts.",
  findings: [
    { kind: "hack", file: "a.ts", line: 4, text: "x" },
    { kind: "missing-test", text: "y" },
  ],
  state: "fixing",
  reviewed: { base: "c".repeat(40), tip: "d".repeat(40), kept: true },
  at: "2026-11-08T10:00:00Z",
  updatedAt: "2026-11-08T10:00:00Z",
  ...x,
});

const STATES: ReviewCardState[] = ["with-thread", "fixing", "re-reviewing", "stopped", "passed", "waiting", "removed"];

test("every state has its own label, and only Waiting for you points to the decision", () => {
  const labels = STATES.map((s) => reviewStateLine(review({ state: s })).label);
  assert.equal(new Set(labels).size, STATES.length);
  for (const s of STATES) {
    const l = reviewStateLine(review({ state: s }));
    assert.equal(l.label, REVIEW_STATE_LABEL[s]);
    assert.ok(l.text.startsWith(l.label), s);
    assert.equal(!!l.toDecision, s === "waiting", s);
  }
  // The two lines the copy deck spells out beyond the label.
  assert.equal(reviewStateLine(review({ state: "fixing" })).text, "Fixing · this chat answers when it's done");
  assert.equal(reviewStateLine(review({ state: "stopped", stoppedFor: "a check failed: unit" })).text, "Stopped before re-review · a check failed: unit");
});

test("every kind the reviewer may use reads as a word, and an unknown one as Other", () => {
  for (const k of REVIEW_KINDS) assert.ok(REVIEW_KIND_WORD[k] && REVIEW_KIND_WORD[k] !== k, k);
  assert.equal(kindWord("something-new"), "Other");
});

test("head and fold read the review's own try and count", () => {
  assert.equal(reviewHead(review()), "feat/x into master · bbbbbbb · try 1 of 3");
  assert.equal(foldedReviewLine(review()), "Review · try 1 · 2 issues · fixed");
  assert.equal(foldedReviewLine(review({ findings: [{ kind: "other", text: "z" }] })), "Review · try 1 · 1 issue · fixed");
});

test("a later review of the same entry folds the earlier one; another entry's stays open", () => {
  const a = review();
  const b = review({ id: "me_1:mr_2", run: "mr_2", try: 2, at: "2026-11-08T11:00:00Z" });
  const other = review({ id: "me_2:mr_3", entry: "me_2", at: "2026-11-08T09:00:00Z" });
  assert.deepEqual([...foldedIds([b, a, other])], [a.id]);
  const rows = reviewCardRows([a, b, other]);
  assert.deepEqual(rows.map((r) => r.state), ["superseded", "open", "open"]);
  // Each review is its own card: keys never collide, so a later one never replaces an earlier one.
  assert.equal(new Set(rows.map((r) => r.key)).size, 3);
  assert.equal(reviewRowOf(rows[0]!)?.folded, true);
  assert.equal(reviewRowOf({ type: "sova.merge-queue", data: rows[0]!.data }), null);
});

const card = (x: Partial<QueueCard> = {}): QueueCard =>
  ({ id: "me_1", entry: "me_1", session: "s1", project: "prj_1", root: "/w", branch: "feat/x", target: "master", commit: SHA, approvedBy: "land-button", state: "with-chat", notes: [], revisions: [], updatedAt: "2026-11-08T10:00:00Z", ...x }) as QueueCard;

test("the queue card points to the review card while it stands, never once landed", () => {
  const standing = { phase: "with-chat", try: 1, of: 3, why: "the review flagged it: …" } as const;
  const p = reviewPointer(card({ reviewFound: { card: "me_1:mr_1", session: "s1", count: 3 }, standing }));
  assert.deepEqual(p && { tries: p.tries, words: p.words, id: p.id }, { tries: "try 1 of 3", words: "Review found 3 issues", id: "me_1:mr_1" });
  assert.equal(reviewPointer(card({ reviewFound: { card: "me_1:mr_1", session: "s1", count: 1 } }))?.words, "Review found 1 issue");
  assert.equal(reviewPointer(card({ state: "landed", reviewFound: { card: "x", session: "s1", count: 1 } })), null);
  assert.equal(reviewPointer(card()), null);
});

test("a Landed card lists review notes in full and drops the one-line Review note", () => {
  const findings = [{ kind: "naming" as const, text: "n" }];
  const landed = card({ state: "landed", review: { verdict: "notes", commit: SHA, at: "t", summary: "S", findings }, notes: [{ kind: "review", text: "S\n- [naming] n", at: "t" }] as QueueCard["notes"] });
  assert.deepEqual(reviewNotes(landed), { summary: "S", findings });
  assert.ok(!cardNotes(landed).some((n) => n.label === "Review"));
  // Before landing, or with no findings kept (an older record), the note stays as it was.
  assert.equal(reviewNotes({ ...landed, state: "with-chat" }), null);
  assert.ok(cardNotes({ ...landed, review: { verdict: "notes", commit: SHA, at: "t" } }).some((n) => n.label === "Review"));
});
