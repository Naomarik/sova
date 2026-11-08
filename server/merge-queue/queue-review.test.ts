// A blocking review's hand-off and its card's record (§app.merge-queue/review-report, §app.merge-queue/send-back,
// §chat.merge-queue/review-card): the queue's records, with the run and the merge thread stood in for.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MergeEntry, ReviewFinding, ReviewVerdict } from "../../shared/merge-queue";
import type { ThreadEvent } from "./contract";
import { FINDING_MAX, MAX_FINDINGS } from "./review-verdict";
import { makeKit, until } from "./testing/queue-kit";

/** The format's maximum: ten findings of the longest text, each naming a file and line. */
const FINDINGS: ReviewFinding[] = Array.from({ length: MAX_FINDINGS }, (_, i) => ({ kind: i % 2 ? "hack" : "missing-test", file: `src/f${i}.ts`, line: i + 1, text: `${i}`.repeat(FINDING_MAX) }));
const blocking = (findings: ReviewFinding[], summary = "It should not land as is."): ReviewVerdict => ({
  verdict: "blocking",
  summary,
  findings,
  text: [summary, ...findings.map((f) => `- [${f.kind}] ${f.file}:${f.line}: ${f.text}`)].join("\n"),
  commit: "c".repeat(40),
  at: "t",
});

function reviewKit(up: (ev: ThreadEvent) => boolean) {
  const events: ThreadEvent[] = [];
  const k = makeKit({ deps: { thread: (ev) => (events.push(ev), up(ev)) } });
  return { k, events };
}
const newest = (e: MergeEntry) => e.reviews!.at(-1)!;
const at = (k: ReturnType<typeof makeKit>, id: string, what: string, ok: (e: MergeEntry) => boolean) => until(async () => (ok(await k.entry(id)) ? k.entry(id) : null), what);

describe("a blocking review goes through the merge thread", () => {
  test("the whole report waits for the thread; its hand-off sends the reviewer's words with its note after them; a later note is a request counting no try", async () => {
    const { k, events } = reviewKit((ev) => ev.kind === "review" || ev.kind === "fix");
    try {
      let runs = 0;
      k.run.set(() => (++runs === 1 ? { verdict: "review-flagged", review: blocking(FINDINGS) } : runs === 2 ? { verdict: "failed", blame: "branch", why: "Unit tests failed" } : {}));
      const q = await k.q();
      const b = k.repo.branch("feat/rv", { "r.txt": "r\n" });
      const { entry } = await q.add({ branch: "feat/rv", by: "land-button", session: "s1" });
      let e = await at(k, entry.id, "with the thread", (x) => x.reviews?.length === 1);
      assert.equal(newest(e).state, "with-thread");
      assert.equal(e.requests?.length ?? 0, 0, "nothing goes to the chat before the thread hands it on");
      assert.deepEqual(newest(e).findings, FINDINGS, "every finding kept whole");
      const told = events.find((ev) => ev.kind === "review")!;
      for (const f of FINDINGS) assert.ok(told.findings!.includes(f.text), "the thread gets the whole report");

      // The note never carries the findings again, and stays short; refused, nothing goes.
      await assert.rejects(q.rule(entry.id, { ruling: "chat-fixes", text: `Restating for clarity:\n${told.findings}`.slice(0, 480) }), /repeats the review: the findings already go to the chat/);
      await assert.rejects(q.rule(entry.id, { ruling: "chat-fixes", text: "n".repeat(501) }), /at most 500 characters/);
      assert.equal((await k.entry(entry.id)).requests?.length ?? 0, 0);
      await q.rule(entry.id, { ruling: "chat-fixes", text: "Start with the missing tests." });
      e = await k.entry(entry.id);
      const rq = e.requests!.at(-1)!;
      for (const f of FINDINGS) assert.ok(rq.text.includes(`- [${f.kind}] ${f.file}:${f.line}: ${f.text}`), "the request carries each finding as written");
      assert.ok(rq.text.indexOf("Merge thread: Start with the missing tests.") > rq.text.indexOf(FINDINGS.at(-1)!.text), "the note comes after the findings");
      assert.deepEqual({ state: newest(e).state, note: newest(e).note?.text, request: newest(e).request, try: newest(e).try }, { state: "fixing", note: "Start with the missing tests.", request: rq.id, try: 1 });

      await q.rule(entry.id, { ruling: "chat-fixes", text: "Also rename f3." });
      e = await k.entry(entry.id);
      assert.equal(e.requests!.length, 2);
      assert.match(e.requests!.at(-1)!.text, /Also rename f3\./);
      assert.equal(e.tries?.used, 1, "a later note counts no try");
      assert.equal(newest(e).note?.text, "Also rename f3.");

      // Fixed and checked: re-reviewing; the re-run fails a check before any review: Stopped, its findings kept.
      const fix = k.repo.commitOn(b.path, { "r.txt": "fixed\n" }, "address the review");
      await q.respond(rq.id, "s1", { answer: "fixed", commit: fix, text: "addressed" });
      await until(async () => (await k.entry(entry.id)).fix?.told === true, "the fix told to the thread");
      await q.fixRuling(entry.id, rq.id, true, "");
      e = await at(k, entry.id, "the re-run stopped", (x) => newest(x).state === "stopped");
      assert.equal(e.reviews!.length, 1);
      assert.deepEqual(newest(e).findings, FINDINGS);
      assert.match(newest(e).stoppedFor ?? "", /a check failed: Unit tests failed/);
      e = await at(k, entry.id, "the failure back with the chat", (x) => x.state === "with-chat" && x.sentBackFor === "checks");
      assert.equal(newest(e).state, "stopped", "the failure's own request keeps it Stopped");

      // Fixed again: checked, re-reviewed, passes: the card passes and the branch lands.
      const rq2 = e.requests!.at(-1)!;
      const fix2 = k.repo.commitOn(b.path, { "r.txt": "fixed twice\n" }, "fix the test");
      await q.respond(rq2.id, "s1", { answer: "fixed", commit: fix2, text: "fixed" });
      await until(async () => (await k.entry(entry.id)).fix?.told === true, "told again");
      await q.fixRuling(entry.id, rq2.id, true, "");
      e = await at(k, entry.id, "landed", (x) => x.state === "landed");
      assert.equal(newest(e).state, "passed");
    } finally {
      await k.done();
    }
  });

  for (const thread of [false, true])
  test(`${thread ? "with" : "with no"} merge thread: ${thread ? "handed on" : "it goes at once"}; the same findings again stop for the user with a card of its own, the first left as it was`, async () => {
    const { k, events } = reviewKit((ev) => ev.kind === "fix" || (thread && ev.kind === "review" && !ev.waits));
    try {
      k.run.set(() => ({ verdict: "review-flagged", review: blocking(FINDINGS.slice(0, 2)) }));
      const q = await k.q();
      const b = k.repo.branch("feat/rv2", { "r.txt": "r\n" });
      const { entry } = await q.add({ branch: "feat/rv2", by: "land-button", session: "s1" });
      if (thread) {
        await at(k, entry.id, "with the thread", (x) => x.reviews?.length === 1);
        await q.rule(entry.id, { ruling: "chat-fixes" });
      }
      let e = await at(k, entry.id, "sent", (x) => !!x.requests?.length);
      assert.equal(newest(e).state, "fixing");
      assert.doesNotMatch(e.requests![0]!.text, /Merge thread:/, "no note without a thread");
      const fix = k.repo.commitOn(b.path, { "r.txt": "fixed\n" }, "try");
      await q.respond(e.requests![0]!.id, "s1", { answer: "fixed", commit: fix, text: "x" });
      await until(async () => (await k.entry(entry.id)).fix?.told === true, "told");
      await q.fixRuling(entry.id, e.requests![0]!.id, true, "");
      e = await at(k, entry.id, "out of tries", (x) => x.state === "needs-user");
      assert.equal(e.decision?.kind, "out-of-tries");
      assert.equal(e.reviews!.length, 2, "a card per review");
      assert.equal(e.reviews![0]!.state, "re-reviewing", "the earlier review's record is left as it was");
      assert.equal(newest(e).state, "waiting");
      assert.deepEqual({ try: newest(e).try, of: newest(e).of }, { try: 2, of: 3 }, "the try that run counted");
      assert.equal(events.filter((ev) => ev.kind === "review").at(-1)!.waits, "same-twice", "the thread is told it waits for the user");
    } finally {
      await k.done();
    }
  });

  test("the thread rules it the user's before the hand-off: the report stays on the card, Waiting for you, and no request goes", async () => {
    const { k } = reviewKit((ev) => ev.kind === "review");
    try {
      k.run.set(() => ({ verdict: "review-flagged", review: blocking(FINDINGS.slice(0, 1)) }));
      const q = await k.q();
      k.repo.branch("feat/rv3", { "r.txt": "r\n" });
      const { entry } = await q.add({ branch: "feat/rv3", by: "land-button", session: "s1" });
      await at(k, entry.id, "with the thread", (x) => x.reviews?.length === 1);
      await q.rule(entry.id, { ruling: "needs-user", text: "Keep the old setting or drop it?", choices: ["Keep it", "Drop it"] });
      const e = await k.entry(entry.id);
      assert.equal(newest(e).state, "waiting");
      assert.equal(e.requests?.length ?? 0, 0);
      assert.deepEqual(newest(e).findings, FINDINGS.slice(0, 1));
    } finally {
      await k.done();
    }
  });
});
