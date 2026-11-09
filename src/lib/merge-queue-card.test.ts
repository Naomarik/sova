// The merge queue's card in a branch's chat: its words, its actions, its rows and their folding.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cardActionLabel, cardActions, cardDecision, cardFacts, cardPill, foldedLine, isNewest, notPushed, queueCardRows, queueRowOf, cardNewer, cardPlaceRow, mergeQueueBatchLabel, type QueueCard } from "./merge-queue-card";
import { placeFold, placeLine } from "./branch-place";

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

test("each state's actions: none of them writes into the chat, and none is a Send Back or a re-land (al_3)", () => {
  assert.deepEqual(cardActions(card()), ["remove"], "queued: Remove from Queue, the one name at every stage");
  assert.deepEqual(cardActions(card({ state: "checking" })), ["remove"], "Remove from Queue at every stage of an approval that stands");
  assert.deepEqual(cardActions(card({ state: "behaviour-differs" })), ["remove"], "no proposal: answered in the chat");
  assert.deepEqual(cardActions(card({ state: "behaviour-differs", conflict: { verdict: "behaviour-differs", ours: "a", theirs: "b", proposal: "c", at: "2026-11-02T10:00:00Z" } as QueueCard["conflict"] })), ["accept", "remove"]);
  assert.deepEqual(cardActions(card({ state: "review-flagged" })), ["remove"], "review findings go back to the chat by themselves");
  assert.deepEqual(cardActions(card({ state: "unattributed" })), ["land-anyway", "try-again", "remove"]);
  assert.deepEqual(cardActions(card({ state: "needs-fix" })), ["remove"], "every Needs a fix card: never left without a button");
  assert.deepEqual(cardActions(card({ state: "needs-fix", redrafted: true })), ["remove"], "its drafts fixed: it goes back in line by itself");
  assert.deepEqual(cardActions(card({ state: "with-chat", standing: { phase: "with-chat", try: 2, of: 3, why: "Unit tests failed" } })), ["remove"]);
  assert.deepEqual(cardActions(card({ state: "drafts-changed" })), ["land", "remove"]);
  assert.deepEqual(cardActions(card({ state: "cancelled", removed: true })), []);
  for (const settled of ["superseded", "merged", "gone"] as const)
    assert.deepEqual(cardActions(card({ state: "needs-fix", settled })), [], `settled ${settled}: nothing the queue would refuse`);
  assert.deepEqual(cardActions(card({ state: "landed" })), []);
  assert.deepEqual(cardActions(card({ state: "landed", newerCommits: 1 })), ["land-again"], "Land Again stays for work after landing");
  // The retired words are on no card in any state.
  const all = (["queued", "checking", "conflict", "behaviour-differs", "review-flagged", "unattributed", "drafts-changed", "needs-fix", "with-chat", "needs-user", "landed", "cancelled"] as const).flatMap((state) => cardActions(card({ state, newerCommits: 2 })).map(cardActionLabel));
  for (const gone of ["Send Back", "Send Back to Chat", "Land This Commit Again", "Land Newest Commit"]) assert.ok(!all.includes(gone), gone);
});

test("a decision: its kind names the pill, its actions are the queue's answers plus Remove from Queue, and it never offers a text box", () => {
  const decision: NonNullable<QueueCard["decision"]> = {
    id: "dc_1",
    kind: "needs-you",
    question: "Keep the old button label or the new one?",
    choices: ["Keep the old label", "Use the new label"],
    heldNote: { request: "rq_000000000001", text: "Apply the user's choice of label, then answer Fixed." },
    raisedBy: "merge-thread",
    actions: [],
    at: "2026-11-02T10:00:00Z",
  };
  const c = card({ state: "needs-user", decision });
  assert.deepEqual(cardPill(c), { label: "Needs you", tone: "warn" });
  assert.deepEqual(cardActions(c), ["remove"]);
  assert.equal(cardDecision(c)?.heldNote?.text, decision.heldNote!.text);
  assert.deepEqual(cardActions(card({ state: "needs-user", decision: { ...decision, kind: "out-of-tries", actions: ["land", "remove"] } })), ["land", "remove"]);
  assert.equal(cardPill(card({ state: "needs-fix", decision: { ...decision, kind: "out-of-tries", actions: ["land"] } })).label, "Out of tries");
  assert.deepEqual(cardActions(card({ state: "needs-user", decision: { ...decision, kind: "unattributed", actions: ["land-anyway", "try-again"] } })), ["land-anyway", "try-again", "remove"]);
  // Answered: the card goes back to its in-place words.
  const answered = card({ state: "with-chat", decision: { ...decision, answered: { at: "2026-11-02T10:05:00Z", how: "message" } }, standing: { phase: "with-chat", try: 1, of: 3, why: "Your answer" } });
  assert.equal(cardDecision(answered), null);
  assert.equal(cardPill(answered).label, "Back with the chat");
  // A landed card is never a decision, whatever it held.
  assert.equal(cardPill(card({ state: "landed", decision })).label, "Landed");
});

test("in place while the chat fixes it: one card, its pill where the standing approval stands", () => {
  assert.equal(cardPill(card({ state: "with-chat", standing: { phase: "with-chat", try: 2, of: 3, why: "Unit tests failed" } })).label, "Back with the chat");
  assert.equal(cardPill(card({ state: "with-chat", standing: { phase: "waiting-thread" } })).label, "Waiting for the merge thread");
  assert.equal(cardPill(card({ state: "with-chat", standing: { phase: "paused" } })).label, "Paused: you stopped the chat");
  assert.equal(cardPill(card({ state: "with-chat", standing: { phase: "waiting-fix", why: "Conflicts with master" } })).label, "Approved · waiting for a fix");
  assert.equal(cardPill(card({ state: "with-chat" })).label, "Back with the chat", "no standing facts yet: still never Unknown");
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
  // Remove from Queue: the card and its revision say Removed, never Cancelled.
  assert.equal(cardPill(card({ state: "cancelled", removed: true })).label, "Removed");
  assert.equal(cardPill(card({ state: "cancelled" })).label, "Cancelled");
  assert.equal(foldedLine("feat/x", { state: "cancelled", kind: "removed" }), "feat/x · Removed");
  assert.deepEqual(cardActions(card({ state: "requested" })), [], "the request's own actions draw from its facts (MergeQueueRequests), not the card's list");
});

test("a host merge is never 'not pushed': nothing of Sova's was to push", () => {
  assert.equal(notPushed(card({ state: "landed", landed: { sha: SHA, from: SHA, at: "2026-11-02T10:00:00Z", pushed: "pending", via: "host" } })), null);
});

test("newer commits are said only on a landed card: while its chat fixes it, the user's Land carries the fixes", () => {
  assert.equal(cardNewer(card({ state: "needs-fix", newerCommits: 3 })), null);
  assert.equal(cardNewer(card({ state: "with-chat", newerCommits: 3 })), null);
  assert.equal(cardNewer(card({ state: "landed", newerCommits: 2 })), "2 newer commits not included", "a landed card keeps its words");
  assert.equal(cardActionLabel("remove"), "Remove from Queue");
  assert.equal(cardActionLabel("try-again"), "Try Again");
});

test("Land Again only for real work the server counted, never once the entry settled", () => {
  assert.deepEqual(cardActions({ state: "landed", newerCommits: 1 }), ["land-again"]);
  assert.deepEqual(cardActions({ state: "landed" }), []);
  assert.deepEqual(cardActions({ state: "landed", newerCommits: 1, settled: "gone" as never }), []);
});

test("the card's place line: its target while in line, merged once landed, none on a card from before", () => {
  const place = { label: "AmalMoney", root: "/w/sova" };
  assert.equal(placeLine(cardPlaceRow(card({ place }))), "AmalMoney · merges into master");
  assert.equal(placeLine(cardPlaceRow(card({ place, state: "landed" }))), "AmalMoney · merged into master");
  assert.equal(placeLine(cardPlaceRow(card())), undefined);
  assert.deepEqual(placeFold(cardPlaceRow(card({ place, worktree: "/w/x" })), "/w").lines, [
    { label: "Branch folder", value: "~/x" },
    { label: "Merges into", value: "master of ~/sova" },
  ]);
});

test("the batch row names its one branch in its place, or counts several", () => {
  const note = (branch: string, place?: string) => ({ id: "qi", from: { sessionId: "merge-queue", title: "Merge queue" }, at: "", text: "t", request: { id: "rq", branch, ...(place ? { place } : {}) } });
  const label = (...notes: ReturnType<typeof note>[]) => mergeQueueBatchLabel({ topic: "t", batch: "b", notes, mergeQueue: true });
  assert.equal(label(note("feat/x", "AmalMoney")), "Merge queue · feat/x in AmalMoney · 1 request");
  assert.equal(label(note("feat/x"), note("feat/x", "~/code/tools")), "Merge queue · feat/x in ~/code/tools · 2 requests");
  assert.equal(label(note("feat/x")), "Merge queue · feat/x · 1 request");
  assert.equal(label(note("feat/x", "A"), note("feat/y", "B")), "Merge queue · 2 branches · 2 requests");
});
