// The words an answer to a waiting entry ends with (lib/merge-answers.ts): they say what the queue really did, read off
// the entry it answered with, so a Land that waits for a fix never reads "Queued".
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MergeEntry, MergeEntryState } from "../../shared/merge-queue";
import { answerDone, answersAtRun, answersRun, entryAnswers, landDone, nowWords, waitsForYou } from "./merge-answers";

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

test("the run page's line about its entry: \"below\" exactly where the page shows its answers, else its newest run, linked", () => {
  const needsYou = (run?: string, decisionRun?: string): Partial<MergeEntry> & Pick<MergeEntry, "state"> => ({
    state: "needs-user",
    ...(run ? { run } : {}),
    decision: { id: "dc_1", kind: "needs-you", question: "Which way?", choices: [], raisedBy: "merge-thread", actions: [], at: "", ...(decisionRun ? { run: decisionRun } : {}) },
  });
  const shapes = [needsYou(undefined, "B"), needsYou("B", "B"), needsYou("A", "B"), needsYou("B"), needsYou(), { state: "unattributed" as const, run: "B" }, { state: "unattributed" as const, run: "B", waitingRuling: true as const }, { state: "request-review" as const, run: "B" }, ...afters];
  for (const e of shapes)
    for (const run of ["A", "B"]) {
      const w = nowWords(e, run);
      const what = `${JSON.stringify(e)} on run ${run}: ${w.text}`;
      // The page's decision block renders exactly when answersAtRun says so (MergeRunView's waiting()).
      assert.equal(/below/.test(w.text), answersAtRun(e, run), what);
      if (/your answer/.test(w.text) && !answersAtRun(e, run)) assert.equal(w.at, answersRun(e), `${what}: links where the answers are`);
      if (!waitsForYou(e)) assert.doesNotMatch(w.text, /your answer/, what);
    }
  // The reviewer's case: its decision waits at run B; run A's page says so and links B, never "below".
  assert.deepEqual(nowWords(needsYou("B", "B"), "A"), { text: "It waits for your answer at its newest run.", at: "B" });
  assert.deepEqual(nowWords(needsYou("B", "B"), "B"), { text: "It waits for your answer below." });
  assert.deepEqual(nowWords(undefined, "A"), { text: "" });
  assert.equal(nowWords({ state: "queued", position: 2 }, "A").text, "Now 2nd in line.");
  assert.equal(nowWords({ state: "cancelled" }, "A").text, "It was taken off the queue since.");
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
