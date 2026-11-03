// The merge queue's card in a branch's chat: its words, its actions, its rows and their folding.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cardActions, cardFacts, cardPill, foldedLine, isNewest, notPushed, queueCardRows, queueRowOf, cardNewer, type QueueCard } from "./merge-queue-card";

const SHA = "a".repeat(40);
const card = (x: Partial<QueueCard> = {}): QueueCard => ({
  id: "me_1",
  entry: "me_1",
  session: "s1",
  project: "prj_1",
  root: "/w/sova",
  branch: "feat/x",
  target: "master",
  commit: SHA,
  approvedBy: "land-button",
  state: "queued",
  notes: [],
  revisions: [{ id: "me_1:1", kind: "approved", at: "2026-11-02T10:00:00Z", state: "queued", position: 2 }],
  updatedAt: "2026-11-02T10:00:00Z",
  ...x,
});

test("live facts: the estimate while queued, the steps while checking, numbers once frozen", () => {
  assert.deepEqual(cardFacts(card({ eta: { startsInMs: 4 * 60_000, takesMs: 9 * 60_000 } })).map((f) => f.text), ["starts in ~4 min · takes ~9 min"]);
  assert.deepEqual(cardFacts(card({ state: "checking", progress: { done: 4, total: 7 } })).map((f) => f.text), ["Checking · 4 of 7 steps"]);
  assert.deepEqual(cardFacts(card({ state: "landed", stats: { commits: 8, added: 970, removed: 45 } })).map((f) => f.text), ["8 commits", "+970 −45"]);
});

test("each state's actions: none of them writes into the chat (all merge verbs)", () => {
  assert.deepEqual(cardActions(card()), ["cancel"]);
  assert.deepEqual(cardActions(card({ state: "checking" })), []);
  assert.deepEqual(cardActions(card({ state: "behaviour-differs" })), ["accept", "send-back"]);
  assert.deepEqual(cardActions(card({ state: "review-flagged" })), ["land-anyway", "send-back"]);
  assert.deepEqual(cardActions(card({ state: "needs-fix" })), []);
  assert.deepEqual(cardActions(card({ state: "landed" })), []);
  assert.deepEqual(cardActions(card({ state: "landed", newerCommits: 1 })), ["land-again"]);
});

test("landed: not pushed says why; newer commits are said", () => {
  const landed = { sha: "b".repeat(40), from: SHA, at: "2026-11-02T21:37:00Z", pushed: "not-pushed" as const, pushWhy: "push held: private names not set up yet" };
  // The why is said once, however it's phrased.
  assert.equal(notPushed(card({ state: "landed", landed })), "Push held: private names not set up yet.");
  assert.equal(notPushed(card({ state: "landed", landed: { ...landed, pushWhy: "Not pushed: origin is ahead" } })), "Not pushed: origin is ahead.");
  assert.equal(notPushed(card({ state: "landed", landed: { ...landed, pushWhy: "The leak scan found a name" } })), "Not pushed: the leak scan found a name.");
  assert.equal(notPushed(card({ state: "landed", landed: { ...landed, pushWhy: undefined } })), "Not pushed: this project doesn't push from the queue.");
  assert.equal(notPushed(card({ state: "landed", landed: { ...landed, pushed: "pushed" } })), null);
  assert.equal(cardNewer(card({ state: "landed", newerCommits: 1 })), "1 newer commit not included");
  assert.equal(cardPill(card({ state: "landed" })).label, "Landed");
});

test("one row per revision, keyed by the entry; only the newest is the card, the others fold to their frozen state", () => {
  const c = card({
    state: "landed",
    revisions: [
      { id: "me_1:1", kind: "approved", at: "2026-11-02T10:00:00Z", after: "e5", state: "queued", position: 2 },
      { id: "me_1:2", kind: "landed", at: "2026-11-02T10:20:00Z", after: "e9", state: "landed" },
    ],
  });
  const rows = queueCardRows([c, card({ id: "me_2", branch: "feat/y" })]);
  assert.deepEqual(rows.map((r) => r.id), ["mq:me_1:1", "mq:me_1:2", "mq:me_1:1"]);
  assert.deepEqual(rows.map((r) => [r.key, r.revision, r.after ?? null]), [["me_1", 1, "e5"], ["me_1", 2, "e9"], ["me_2", 1, null]]);
  const [first, second] = rows.map((r) => queueRowOf(r)!);
  assert.equal(isNewest(first!), false);
  assert.equal(isNewest(second!), true);
  assert.equal(foldedLine(c.branch, first!.revision), "feat/x · Queued 2nd");
  assert.equal(queueRowOf({ type: "project.other", data: {} }), null);
});

test("a request project's card: the pill follows the host's facts, the folded line its frozen state (al_3)", () => {
  const request = { how: "github-pr" as const, host: "github" as const, branch: "feat/x", base: "master", number: 123, url: "https://github.com/o/r/pull/123" };
  const facts = { state: "open" as const, checks: "pending" as const, review: "none" as const, mergeable: "mergeable" as const };
  assert.equal(cardPill(card({ state: "requested", request: { ...request, facts } })).label, "PR #123 open · checks running on GitHub");
  assert.equal(cardPill(card({ state: "requested", request: { ...request, facts: { ...facts, checks: "fail" } } })).label, "Host checks failed");
  assert.equal(cardPill(card({ state: "closed", request })).label, "Closed on GitHub");
  assert.equal(cardPill(card({ state: "pushed", request: { how: "push-branch", branch: "feat/x", base: "master" } })).label, "Pushed");
  assert.equal(cardPill(card({ state: "request-review", request })).label, "Review the request");
  assert.equal(foldedLine("feat/x", { state: "requested" }), "feat/x · Request opened");
  assert.deepEqual(cardActions(card({ state: "requested" })), [], "the request's own actions draw from its facts (MergeQueueRequests), not the card's list");
});

test("a host merge is never 'not pushed': nothing of Sova's was to push", () => {
  assert.equal(notPushed(card({ state: "landed", landed: { sha: SHA, from: SHA, at: "2026-11-02T10:00:00Z", pushed: "pending", via: "host" } })), null);
});
