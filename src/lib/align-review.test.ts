// Run: pnpm exec tsx --test src/lib/align-review.test.ts (or npm test). Adversarial review on the
// alignment card (§chat.alignment-review/card): the helpers the card renders from, and the card
// itself rendered with the feature off (nothing at all) and on (body lines, foot button or verdict).
import assert from "node:assert/strict";
import { test } from "node:test";

// The SSR helper stays plain .mjs (node runs it uncompiled), so it has no types; its one export.
// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const { AlignAnswerContext, AlignDocCard } = await importSsr(new URL("../components/AlignDocCard.tsx", import.meta.url), (s: string) => import.meta.resolve(s));
const { adversarialReview, planReviewRunning, reviewFoot, reviewLinesOf, reviewPhaseName, reviewRequestMessage, reviewVerdictLine, setAdversarialReview, NO_REVIEWER, PLAN_REVIEW_WAIT, REVIEW_ABOUT } = await import("./align-review");
import type { AlignAnswer } from "../components/AlignDocCard";
import type { AlignDocInfo, AlignReviewEntryInfo } from "../../shared/protocol";

const at = "2026-10-03T12:00:00.000Z";
const doc = (over: Partial<AlignDocInfo> = {}): AlignDocInfo => ({
  id: "al_2",
  title: "Queue",
  summary: "Persist the queue.",
  findings: [],
  approach: [{ id: "a1", text: "Write it to disk." }],
  rejected: [],
  questions: [{ id: "q1", topic: "Format", ask: "JSON or SQLite?", recommendation: { choice: "JSON", why: "small" }, decision: { text: "JSON", by: "user", at } }],
  phase: "open",
  next: { f: 0, a: 1, x: 0, q: 1 },
  rev: 3,
  createdAt: at,
  updatedAt: at,
  ...over,
});
const entry = (state: AlignReviewEntryInfo["state"], over: Partial<AlignReviewEntryInfo> = {}): AlignReviewEntryInfo => ({ state, reason: "r", at, ...over });

test("the request message matches the extension's /review words: the user's word in the prose, the id in the token", () => {
  assert.equal(reviewRequestMessage("al_3", "diff"), "al_3: run the adversarial implementation review now (align review, phase diff), whatever the rule says.");
  assert.equal(reviewRequestMessage("al_3", "plan"), "al_3: run the adversarial plan review now (align review, phase plan), whatever the rule says.");
});

test("verdict lines, in the extension's words", () => {
  const two = [{ id: "b1", title: "t", check: "c" }, { id: "b2", title: "u", check: "d" }];
  assert.equal(reviewVerdictLine("plan", entry("clear", { reason: "1 constraint added" })), "Plan reviewed · 1 constraint added");
  assert.equal(reviewVerdictLine("plan", entry("running")), "Reviewing the plan");
  assert.equal(reviewVerdictLine("plan", entry("skipped", { reason: "routine change" })), "Plan review skipped: routine change");
  assert.equal(reviewVerdictLine("plan", entry("incomplete", { reason: "spawn failed" })), "Plan review incomplete: spawn failed");
  assert.equal(reviewVerdictLine("plan", entry("blocking", { blockers: two })), "Plan review: 2 blocking");
  assert.equal(reviewVerdictLine("diff", entry("running")), "Reviewing the implementation");
  assert.equal(reviewVerdictLine("diff", entry("clear")), "Implementation review: no blocking issues");
  assert.equal(reviewVerdictLine("diff", entry("blocking", { blockers: two })), "Implementation review: 2 blocking");
  assert.equal(reviewVerdictLine("diff", entry("blocking", { blockers: [two[0]!, { ...two[1]!, closed: { by: "check" as const, evidence: "e", at } }] })), "Implementation review: 2 blocking (1 open)");
  assert.equal(reviewVerdictLine("diff", entry("skipped", { reason: "one-line change" })), "Implementation review skipped: one-line change");
  assert.equal(reviewVerdictLine("diff", entry("incomplete", { reason: "spawn failed" })), "Implementation review incomplete: spawn failed");
});

test("both copies say the same words: every phase and state, and the request message", async () => {
  const ext = await import("../../pi-config/extensions/mode/align.ts");
  const blockers = [{ id: "b1", title: "t", check: "c" }, { id: "b2", title: "u", check: "d", closed: { by: "check" as const, evidence: "e", at } }];
  for (const phase of ["plan", "diff"] as const) {
    assert.equal(reviewPhaseName(phase), ext.reviewPhaseName(phase));
    assert.equal(reviewRequestMessage("al_3", phase), ext.reviewRequestMessage("al_3", phase));
    for (const state of ["skipped", "running", "clear", "blocking", "incomplete"] as const) {
      const e = entry(state, state === "blocking" ? { blockers } : {});
      assert.equal(reviewVerdictLine(phase, e), ext.reviewVerdictLine(phase, e), `${phase} ${state}`);
    }
  }
});

test("the foot: a button while the phase is missing or skipped, else its verdict; never a second round", () => {
  assert.deepEqual(reviewFoot(doc()), { kind: "button", phase: "plan", label: "Review Plan" });
  assert.deepEqual(reviewFoot(doc({ review: { plan: entry("skipped") } })), { kind: "button", phase: "plan", label: "Review Plan" });
  assert.deepEqual(reviewFoot(doc({ review: { plan: entry("clear", { reason: "fine" }) } })), { kind: "line", phase: "plan", text: "Plan reviewed · fine" });
  assert.deepEqual(reviewFoot(doc({ review: { plan: entry("incomplete", { reason: "x" }) } })), { kind: "line", phase: "plan", text: "Plan review incomplete: x" });
  assert.deepEqual(reviewFoot(doc({ phase: "implementing", review: { plan: entry("clear") } })), { kind: "button", phase: "diff", label: "Review Implementation" });
  assert.deepEqual(reviewFoot(doc({ phase: "implementing", review: { diff: entry("running") } })), { kind: "line", phase: "diff", text: "Reviewing the implementation" });
  // After done: only a skipped implementation review offers its button.
  assert.deepEqual(reviewFoot(doc({ phase: "done", review: { diff: entry("skipped") } })), { kind: "button", phase: "diff", label: "Review Implementation" });
  assert.equal(reviewFoot(doc({ phase: "done" })), null);
  assert.equal(reviewFoot(doc({ phase: "done", review: { diff: entry("clear") } })), null);
  assert.equal(reviewFoot(doc({ phase: "dropped", droppedWhy: "x" })), null);
});

test("body lines: one per phase, plan first; open blockers with their checks; settled blockers read settled", () => {
  const blockers = [
    { id: "b1", title: "reload drops the tail", check: "node --test q.test.ts" },
    { id: "b2", title: "no fsync", check: "grep fsync", closed: { by: "check" as const, evidence: "passes", at } },
  ];
  const lines = reviewLinesOf(doc({ review: { diff: entry("blocking", { blockers, model: "pi · sol · high" }), plan: entry("skipped", { reason: "routine" }) } }));
  assert.deepEqual(lines, [
    { phase: "plan", text: "Plan review skipped: routine", tone: undefined, open: [] },
    { phase: "diff", text: "Implementation review: 2 blocking (1 open)", tone: "error", model: "pi · sol · high", open: [{ id: "b1", title: "reload drops the tail", check: "node --test q.test.ts" }] },
  ]);
  const closed = reviewLinesOf(doc({ review: { diff: entry("blocking", { blockers: blockers.map((b) => ({ ...b, closed: { by: "check" as const, evidence: "e", at } })) }) } }));
  assert.equal(closed[0]!.tone, "success");
  assert.deepEqual(reviewLinesOf(doc()), []);
  assert.equal(planReviewRunning(doc({ review: { plan: entry("running") } })), true);
});

const draw = (d: AlignDocInfo, answer: AlignAnswer | null = null): string =>
  renderToString(() => solid.createComponent(AlignAnswerContext.Provider, { value: answer, get children() { return solid.createComponent(AlignDocCard as never, { doc: d } as never); } }));

const answer = (over: Partial<AlignAnswer> = {}): AlignAnswer => ({
  on: () => true,
  current: () => undefined,
  picked: () => false,
  toggle() {},
  pickedOption: () => undefined,
  pick() {},
  tickBlocked: () => null,
  goBlocked: () => null,
  goWithRecommendations() {},
  review: () => true,
  reviewBlocked: () => null,
  requestReview() {},
  ...over,
});

test("card, feature off: no review line, button or verdict — even for a document that carries a record", () => {
  setAdversarialReview(false);
  const d = doc({ review: { plan: entry("clear", { reason: "fine" }) } });
  const html = draw(d, answer({ current: () => d }));
  assert.ok(!html.includes("align-review"), "no review markup at all");
  assert.ok(!html.includes("Review Plan") && !html.includes("Plan reviewed"));
  assert.ok(!html.includes(REVIEW_ABOUT), "no explainer");
  assert.ok(!html.includes("card-foot"), "every question answered: no foot, as before");
});

test("card, feature on: body lines everywhere; the foot only on the answerable newest card", () => {
  setAdversarialReview(true);
  try {
    assert.equal(adversarialReview(), true);
    const d = doc();
    // All questions answered: the foot shows for review alone, with no Go button.
    const html = draw(d, answer({ current: () => d }));
    assert.match(html, /<button[^>]*class="button button-sm align-review-button"[^>]*>Review Plan<\/button>/);
    assert.ok(!html.includes("Go With Recommendations"));
    // Under the button, one line says what a review is.
    assert.equal(REVIEW_ABOUT, "An independent reviewer reads it and reports problems. It can't change code or run anything.");
    assert.match(html, /<\/button>[\s\S]*<span class="align-doc-foot-hint align-review-about">An independent reviewer reads it and reports problems\. It can(&#39;|')t change code or run anything\.<\/span>/);
    // A watch view (no answer context) or an older revision: read-only, no foot.
    assert.ok(!draw(d).includes("card-foot"), "no context: read-only");
    assert.ok(!draw(d, answer({ current: () => ({ ...d, rev: 4 }) })).includes("card-foot"), "an older revision: read-only");
    // Reviewer None: disabled with the reason.
    const none = draw(d, answer({ current: () => d, reviewBlocked: () => NO_REVIEWER }));
    assert.match(none, /aria-disabled="true"[^>]*title="No reviewer is set/);
    assert.match(none, /<span class="align-doc-foot-hint">No reviewer is set for this chat's subagent profile/, "the reason beside it");
    // Running: the body says so, the foot shows the verdict line, Go waits.
    const open = doc({ questions: [{ ...d.questions[0]!, decision: undefined }], review: { plan: entry("running", { model: "pi · sol · high" }) } });
    const running = draw(open, answer({ current: () => open }));
    assert.match(running, /class="align-review"/);
    assert.match(running, /Reviewing the plan/);
    assert.ok(!running.includes(">Review Plan<"), "no second start");
    assert.ok(!running.includes("align-review-about"), "the explainer goes with the button only");
    assert.match(running, /aria-disabled="true"[^>]*title="Wait for the plan review\."/);
    assert.ok(running.includes(PLAN_REVIEW_WAIT));
    // Implementing with a blocker: the body lists it with its check; the foot shows the verdict.
    const impl = doc({ phase: "implementing", review: { plan: entry("clear", { reason: "ok" }), diff: entry("blocking", { blockers: [{ id: "b1", title: "reload drops the tail", check: "node --test q.test.ts" }] }) } });
    const blocked = draw(impl, answer({ current: () => impl }));
    assert.match(blocked, /Implementation review: 1 blocking/);
    assert.match(blocked, /<\/i>Implementation<\/span>/, "the phase chip");
    assert.ok(!/>Diff</.test(blocked), "no Diff chip or label");
    assert.match(blocked, /b1<\/span>[\s\S]*reload drops the tail[\s\S]*Check: <code>node --test q\.test\.ts<\/code>/);
    assert.match(blocked, /class="align-doc-foot-hint align-review-verdict">Implementation review: 1 blocking</);
    assert.ok(!blocked.includes("Review Implementation"));
    // Implementing with the phase missing: the implementation button, with its explainer.
    const implOpen = doc({ phase: "implementing", review: { plan: entry("clear", { reason: "ok" }) } });
    const offer = draw(implOpen, answer({ current: () => implOpen }));
    assert.match(offer, />Review Implementation<\/button>/);
    assert.ok(offer.includes("align-review-about"));
  } finally {
    setAdversarialReview(false);
  }
});
