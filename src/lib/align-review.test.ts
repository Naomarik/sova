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
const { adversarialReview, planReviewRunning, reviewFoot, reviewLinesOf, reviewRequestMessage, reviewVerdictLine, setAdversarialReview, NO_REVIEWER } = await import("./align-review");
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

test("the request message matches the extension's /review words", () => {
  assert.equal(reviewRequestMessage("al_3", "diff"), "al_3: run the adversarial diff review now (align review, phase diff), whatever the rule says.");
});

test("verdict lines, in the extension's words", () => {
  assert.equal(reviewVerdictLine("plan", entry("clear", { reason: "1 constraint added" })), "Plan reviewed · 1 constraint added");
  assert.equal(reviewVerdictLine("diff", entry("clear")), "Diff: NO BLOCKING");
  assert.equal(reviewVerdictLine("diff", entry("blocking", { blockers: [{ id: "b1", title: "t", check: "c" }, { id: "b2", title: "u", check: "d" }] })), "Diff: 2 blocking");
  assert.equal(reviewVerdictLine("diff", entry("incomplete", { reason: "spawn failed" })), "Diff review incomplete: spawn failed");
  assert.equal(reviewVerdictLine("plan", entry("running")), "Reviewing plan");
  assert.equal(reviewVerdictLine("plan", entry("skipped", { reason: "routine change" })), "Plan review skipped: routine change");
});

test("the foot: a button while the phase is missing or skipped, else its verdict; never a second round", () => {
  assert.deepEqual(reviewFoot(doc()), { kind: "button", phase: "plan", label: "Review Plan" });
  assert.deepEqual(reviewFoot(doc({ review: { plan: entry("skipped") } })), { kind: "button", phase: "plan", label: "Review Plan" });
  assert.deepEqual(reviewFoot(doc({ review: { plan: entry("clear", { reason: "fine" }) } })), { kind: "line", phase: "plan", text: "Plan reviewed · fine" });
  assert.deepEqual(reviewFoot(doc({ review: { plan: entry("incomplete", { reason: "x" }) } })), { kind: "line", phase: "plan", text: "Plan review incomplete: x" });
  assert.deepEqual(reviewFoot(doc({ phase: "implementing", review: { plan: entry("clear") } })), { kind: "button", phase: "diff", label: "Review Diff" });
  assert.deepEqual(reviewFoot(doc({ phase: "implementing", review: { diff: entry("running") } })), { kind: "line", phase: "diff", text: "Reviewing diff" });
  // After done: only a skipped diff review offers its button.
  assert.deepEqual(reviewFoot(doc({ phase: "done", review: { diff: entry("skipped") } })), { kind: "button", phase: "diff", label: "Review Diff" });
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
    { phase: "diff", text: "Diff: 2 blocking (1 open)", tone: "error", model: "pi · sol · high", open: [{ id: "b1", title: "reload drops the tail", check: "node --test q.test.ts" }] },
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
    // A watch view (no answer context) or an older revision: read-only, no foot.
    assert.ok(!draw(d).includes("card-foot"), "no context: read-only");
    assert.ok(!draw(d, answer({ current: () => ({ ...d, rev: 4 }) })).includes("card-foot"), "an older revision: read-only");
    // Reviewer None: disabled with the reason.
    const none = draw(d, answer({ current: () => d, reviewBlocked: () => NO_REVIEWER }));
    assert.match(none, /aria-disabled="true"[^>]*title="No reviewer is set/);
    assert.match(none, /<span class="align-doc-foot-hint">No reviewer is set for this chat's subagent profile/, "the reason beside it");
    // Running: the card holds to its header and one status line; nothing to read, tick or press.
    const open = doc({ questions: [{ ...d.questions[0]!, decision: undefined }], review: { plan: entry("running", { model: "pi · sol · high" }) } });
    for (const running of [draw(open, answer({ current: () => open })), draw(open)]) {
      assert.match(running, /<p class="align-review-running" role="status"><span class="live-dot" aria-hidden="true"><\/span>/);
      assert.ok(running.includes("Plan review in progress — the alignment may change; it shows once the review finishes."));
      assert.match(running, /class="align-review-model"> · pi · sol · high</);
      assert.ok(running.includes("Queue"), "the header stays");
      assert.ok(!running.includes("Persist the queue."), "no summary");
      assert.ok(!running.includes("Go With Recommendations") && !running.includes(">Review Plan<"));
      assert.ok(!running.includes("card-foot"), "no foot");
      assert.ok(!running.includes("align-q-options") && !running.includes('type="radio"'), "no options to pick");
      assert.ok(!running.includes('class="align-review"'), "no review lines");
    }
    // Implementing with a blocker: the body lists it with its check; the foot shows the verdict.
    const impl = doc({ phase: "implementing", review: { plan: entry("clear", { reason: "ok" }), diff: entry("blocking", { blockers: [{ id: "b1", title: "reload drops the tail", check: "node --test q.test.ts" }] }) } });
    const blocked = draw(impl, answer({ current: () => impl }));
    assert.match(blocked, /Diff: 1 blocking/);
    assert.match(blocked, /b1<\/span>[\s\S]*reload drops the tail[\s\S]*Check: <code>node --test q\.test\.ts<\/code>/);
    assert.match(blocked, /class="align-doc-foot-hint align-review-verdict">Diff: 1 blocking</);
    assert.ok(!blocked.includes("Review Diff"));
  } finally {
    setAdversarialReview(false);
  }
});
