// What a review kit may declare, and the review step's passes joined (§app.merge-queue/review-kit).
import assert from "node:assert/strict";
import { test } from "node:test";
import { kitDeclOf, ownFolder, reviewerProfileOf } from "./review-kit";
import { joinAnswers, reviewerText, reviewStep, type ReviewAnswer, type ReviewerStart } from "./review-step";

test("a kit declares model, effort, passes, time limit and a shell; anything Sova can't take is left out and named", () => {
  assert.deepEqual(kitDeclOf({}), { decl: {}, problems: [] }, "nothing declared: the default reviewer");
  assert.deepEqual(kitDeclOf({ model: "zai/glm-5.3", thinking: "high", passes: "2", "time-limit": "30", tools: "shell" }).decl, { model: "zai/glm-5.3", thinking: "high", passes: 2, timeLimitMin: 30, tools: ["shell"] });
  assert.deepEqual(kitDeclOf({ effort: "low" }).decl, { thinking: "low" }, "effort is thinking's other name");
  // Each edge of each value: the last good one in, the first bad one out.
  for (const [k, ok, bad] of [["passes", "3", "4"], ["passes", "1", "0"], ["time-limit", "120", "121"], ["time-limit", "1", "1.5"]] as const) {
    assert.equal(kitDeclOf({ [k]: ok }).problems.length, 0, `${k} ${ok}`);
    const r = kitDeclOf({ [k]: bad, model: "a/b" });
    assert.equal(r.problems.length, 1, `${k} ${bad}`);
    assert.deepEqual(r.decl, { model: "a/b" }, "the rest still applies");
  }
  assert.deepEqual(kitDeclOf({ model: "no-slash" }).decl, {});
  assert.deepEqual(kitDeclOf({ thinking: "huge" }).decl, {});
  const t = kitDeclOf({ tools: "shell, edit, web" });
  assert.deepEqual(t.decl, { tools: ["shell"] }, "a kit can't give its reviewer edit tools or the web");
  assert.equal(t.problems.length, 2);
});

test("the profile and folder follow the kit and the project: read-only in the merge copy unless it can run or write", () => {
  assert.equal(reviewerProfileOf({}, false), "merge-reviewer");
  assert.equal(reviewerProfileOf({ tools: ["shell"] }, false), "merge-reviewer-shell");
  assert.equal(reviewerProfileOf({}, true), "merge-reviewer-fix");
  assert.equal(reviewerProfileOf({ tools: ["shell"] }, true), "merge-reviewer-fix");
  assert.equal(ownFolder({}, false), false);
  assert.equal(ownFolder({ tools: ["shell"] }, false), true);
  assert.equal(ownFolder({}, true), true);
});

const f = (kind: "hack" | "naming", text: string, file?: string) => ({ kind, text, ...(file ? { file } : {}) });

test("passes joined: the strictest verdict wins, findings together, the same finding once, at most 10", () => {
  const ok: ReviewAnswer = { verdict: "ok" };
  const notes: ReviewAnswer = { verdict: "notes", summary: "Small things.", findings: [f("naming", "vague name", "a.ts")] };
  const blocking: ReviewAnswer = { verdict: "blocking", summary: "A hack.", findings: [f("hack", "left in", "b.ts"), f("naming", "Vague  name", "a.ts")] };
  assert.equal(joinAnswers([ok, ok]).verdict, "ok");
  assert.equal(joinAnswers([ok, notes]).verdict, "notes");
  const j = joinAnswers([notes, ok, blocking]);
  assert.equal(j.verdict, "blocking");
  assert.deepEqual(j.findings, [f("naming", "vague name", "a.ts"), f("hack", "left in", "b.ts")], "the same finding (case, spacing) once");
  assert.equal(j.summary, "Small things. A hack.");
  assert.equal(j.text, "Small things. A hack.\n- [naming] a.ts: vague name\n- [hack] b.ts: left in");
  const many = (n: number): ReviewAnswer => ({ verdict: "notes", summary: "s", findings: Array.from({ length: 6 }, (_, i) => f("naming", `n${n}-${i}`)) });
  assert.equal(joinAnswers([many(1), many(2)]).findings?.length, 10);
  assert.deepEqual(joinAnswers([notes]), notes, "one pass: as it answered");
});

const base: Omit<ReviewerStart, "text" | "attempt"> = { runId: "mr_1", projectId: "p", root: "/r", copy: "/c", base: "b".repeat(40), commit: "c".repeat(40), branch: "feat/x", kit: "kit" };

test("each pass is a fresh reviewer told which pass it is; the verdict carries the first pass's model", async () => {
  const texts: string[] = [];
  const answers: ReviewAnswer[] = [{ verdict: "notes", summary: "One.", findings: [f("naming", "x")] }, { verdict: "ok" }];
  let n = 0;
  const r = await reviewStep(
    { ...base, log: () => {}, signal: new AbortController().signal, decl: { passes: 2 } },
    {
      startReviewer: async (s) => {
        texts.push(s.text);
        const a = answers[n++]!;
        setTimeout(() => (import("./review-step").then((m) => m.deliverReview(s.runId, a))), 1);
        return { sessionId: `r${n}`, model: `m/${n}`, stop: async () => {} };
      },
    },
  );
  assert.ok(r.ok);
  assert.equal(r.verdict.verdict, "notes");
  assert.equal(r.model, "m/1");
  assert.equal(texts.length, 2);
  assert.match(texts[0]!, /reviewer 1 of 2/);
  assert.match(texts[1]!, /reviewer 2 of 2/);
});

test("the whole step's limit: no reviewer starts once it is spent", async () => {
  let started = 0;
  const r = await reviewStep({ ...base, log: () => {}, signal: new AbortController().signal, decl: { passes: 3 } }, { reviewTotalMs: 0, startReviewer: async () => (started++, { sessionId: "x", stop: async () => {} }) });
  assert.deepEqual([r.ok, started], [false, 0]);
  assert.match(r.ok ? "" : r.why, /passed its limit of 120 min in all/);
});

test("the first message says what the reviewer may do: read-only, a shell in its own folder, or fix on the branch's copy", () => {
  assert.match(reviewerText(base), /you have no shell/);
  assert.match(reviewerText(base), /merge copy at that commit/);
  const shell = reviewerText({ ...base, own: { at: base.commit, fixes: false }, shell: true });
  assert.match(shell, /You have a shell, in your own folder/);
  assert.match(shell, /not the merge copy the checks run in/);
  const fix = reviewerText({ ...base, own: { at: "a".repeat(40), fixes: true }, shell: true });
  assert.match(fix, /commit it there with git/);
  assert.match(fix, /copy of the branch feat\/x at its commit a{40}, not merged \(the diff is of the merge/);
  assert.match(fix, /never amend, rebase or reset/);
});
