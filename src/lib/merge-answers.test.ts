// The words an answer to a waiting entry ends with (lib/merge-answers.ts): they say what the queue really did, read off
// the entry it answered with, so a Land that waits for a fix never reads "Queued".
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MergeEntry, MergeEntryState } from "../../shared/merge-queue";
import { answerDone, entryAnswers, landDone, nowWords, waitsForYou } from "./merge-answers";

type After = Pick<MergeEntry, "state"> & Partial<Pick<MergeEntry, "position" | "standing" | "reason">>;
const STATES: MergeEntryState[] = ["queued", "checking", "conflict", "behaviour-differs", "review-flagged", "unattributed", "drafts-changed", "needs-fix", "with-chat", "needs-user", "landed", "cancelled", "request-review", "requested", "pushed", "closed"];
const afters: After[] = [
  ...STATES.map((state) => ({ state })),
  { state: "queued", position: 1 },
  { state: "queued", position: 2 },
  { state: "with-chat", standing: { phase: "waiting-fix", why: "2 uncommitted files in its folder: commit or remove them" } as MergeEntry["standing"] },
  { state: "with-chat", standing: { phase: "with-chat", try: 1, of: 3, why: "unit failed" } as MergeEntry["standing"] },
];

test("after Land, the words say where it went: queued only when it is in line; waiting for a fix says why", () => {
  for (const after of afters)
    for (const words of [answerDone("land", "feat/x", after), landDone("feat/x", after)]) {
      assert.equal(words.startsWith("Queued feat/x"), after.state === "queued", `${JSON.stringify(after)}: ${words}`);
      assert.doesNotMatch(words, /undefined|\.\.$/, words);
    }
  assert.equal(answerDone("land", "feat/x", { state: "queued", position: 2 }), "Queued feat/x · 2nd in line.");
  assert.equal(answerDone("land", "feat/x", { state: "queued", position: 1 }), "Queued feat/x · next in line.");
  assert.equal(answerDone("land", "feat/x", afters.at(-2)), "Approved feat/x · waiting for a fix: 2 uncommitted files in its folder: commit or remove them.");
  assert.equal(answerDone("land", "feat/x", { state: "with-chat" }), "Approved feat/x · back with its chat.");
  assert.equal(landDone("feat/x", { state: "queued", position: 3 }, " without review"), "Queued feat/x without review · 3rd in line.");
  // No entry in the answer: the answer alone, never a guess.
  assert.equal(answerDone("land", "feat/x", undefined), "Queued feat/x.");
  assert.equal(answerDone("try-again", "feat/x", { state: "queued", position: 1 }), "Checking feat/x again · next in line.");
  assert.equal(answerDone("try-again", "feat/x", { state: "checking" }), "Checking feat/x again now.");
  assert.equal(answerDone("remove", "feat/x"), "Removed feat/x from the merge queue.");
});

test("the run page's line about its entry now: your answer below only while it waits for you, else where it stands", () => {
  assert.equal(nowWords(undefined), "");
  assert.equal(nowWords({ state: "unattributed" }), "It waits for your answer below.");
  assert.equal(nowWords({ state: "unattributed", waitingRuling: true }), "Now can't tell whose failure · waiting for you.");
  assert.equal(nowWords({ state: "queued", position: 2 }), "Now 2nd in line.");
  assert.equal(nowWords({ state: "cancelled" }), "It was taken off the queue since.");
  // A request waiting for your look has its own row (Publish): not "your answer below".
  assert.notEqual(nowWords({ state: "request-review" }), "It waits for your answer below.");
  for (const a of afters) if (!waitsForYou(a)) assert.doesNotMatch(nowWords(a), /your answer/, a.state);
});

test("the answers an entry offers: Remove from Queue last and once; only Remove while the merge thread rules", () => {
  for (const state of STATES)
    for (const waitingRuling of [false, true]) {
      const got = entryAnswers({ state, ...(waitingRuling ? { waitingRuling: true as const } : {}) });
      assert.equal(got.at(-1), "remove", state);
      assert.equal(got.filter((a) => a === "remove").length, 1, state);
      if (waitingRuling) assert.deepEqual(got, ["remove"], state);
    }
  assert.deepEqual(entryAnswers({ state: "unattributed" }), ["land-anyway", "try-again", "remove"]);
  assert.deepEqual(entryAnswers({ state: "behaviour-differs" }), ["remove"], "Accept only with the thread's proposal");
  assert.deepEqual(entryAnswers({ state: "needs-user", decision: { id: "d", kind: "private-names", question: "q", choices: [], raisedBy: "queue", actions: ["allow", "send-back", "remove", "ask-thread"], at: "" } }), ["allow", "send-back", "ask-thread", "remove"]);
});
