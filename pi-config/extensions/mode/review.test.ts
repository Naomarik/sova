// Adversarial review of alignments (§chat.alignment-review): the review record, the review and
// close_blocker ops, their slot refusals and guards, the record's normalization, and the reviewer
// prompt. Pure: no pi runtime.
import assert from "node:assert/strict";
import test from "node:test";
import {
	ALIGN_OPS,
	applyAlignCall,
	changeLine,
	foldAlignments,
	normalizeAlignDetails,
	normalizeAlignDocument,
	reviewLines,
	reviewRequestMessage,
	reviewVerdictLine,
	toMarkdown,
	type AlignDocument,
	type AlignEnv,
	type AlignReviewerSlot,
} from "./align.ts";
import { alignmentBrief, reviewerPrompt, reviewStartText, REVIEWER_TOOLS } from "./review-prompt.ts";

const NOW = "2026-10-03T12:00:00.000Z";
const SOL = { backend: "pi", model: "openai-codex/gpt-6.1-sol", effort: "high" };
const OPUS = { backend: "claude-code", model: "opus[1m]", effort: "high" };

function env(slot: AlignReviewerSlot | null = { use: SOL, via: "primary", retry: OPUS }): AlignEnv {
	return {
		now: NOW,
		readFile: () => {
			throw new Error("no files");
		},
		review: { reviewer: () => slot, startText: reviewStartText },
	};
}
const OFF: AlignEnv = { now: NOW, readFile: () => "" };

/** Apply calls in order, threading the documents like the host does. */
function run(calls: unknown[], e: AlignEnv = env(), start: AlignDocument[] = []) {
	let docs = start;
	let last: ReturnType<typeof applyAlignCall> | undefined;
	for (const call of calls) {
		last = applyAlignCall(docs, call, e);
		if (last.details.doc) docs = [...docs.filter((d) => d.id !== last!.details.doc!.id), last.details.doc];
	}
	return { docs, last: last!, doc: docs.at(-1)! };
}

const CREATE = {
	ops: [
		{
			op: "create",
			title: "Queue",
			summary: "Persist the queue.",
			approach: ["Write the queue to disk", "Reload it at start"],
			questions: [{ topic: "Format", ask: "JSON or SQLite?", options: [{ label: "JSON", tradeoff: "simple" }, { label: "SQLite", tradeoff: "robust" }], recommendation: { choice: "JSON", why: "small" } }],
			rejected: [{ option: "Keep it in memory", why: "lost at restart" }],
		},
	],
};
const START_PLAN = { ops: [{ op: "review", phase: "plan", state: "running", reason: "persistence format" }] };
const ACCEPT_IMPL = { ops: [{ op: "accept_all" }, { op: "status", to: "implementing" }] };

test("flag off: the review ops are not ops at all, and the error lists today's ops only", () => {
	const { docs } = run([CREATE], OFF);
	assert.throws(() => applyAlignCall(docs, START_PLAN, OFF), (e: Error) => e.message === `ops[0].op must be one of ${ALIGN_OPS.join(", ")}` && !e.message.includes("review"));
	assert.throws(() => applyAlignCall(docs, { ops: [{ op: "close_blocker", phase: "diff", id: "b1", by: "check", evidence: "x" }] }, OFF), /must be one of/);
	// With the flag off nothing guards done on a review, even if a record exists (a session started with it on).
	const on = run([CREATE, ACCEPT_IMPL, { ops: [{ op: "review", phase: "diff", state: "running", reason: "r" }] }]);
	assert.equal(applyAlignCall(on.docs, { ops: [{ op: "status", to: "done" }] }, OFF).details.doc?.phase, "done");
});

test("plan review: start reserves the slot before the spawn and returns the worker and the filled prompt", () => {
	const { doc, last } = run([CREATE, START_PLAN]);
	assert.deepEqual(doc.review?.plan && { ...doc.review.plan }, { state: "running", reason: "persistence format", model: "pi · openai-codex/gpt-6.1-sol · high", at: NOW });
	assert.deepEqual(last.details.changes, [{ kind: "review", phase: "plan", state: "running" }]);
	assert.equal(last.details.line, "plan review running");
	assert.match(last.text, /backend "pi", model "openai-codex\/gpt-6\.1-sol", effort "high", tools \["read","grep","find","ls"\]/);
	assert.match(last.text, /retry once with backend "claude-code", model "opus\[1m\]", effort "high", tools \["Read","Grep","Glob"\]/);
	assert.match(last.text, /Never give it your transcript/);
	assert.match(last.text, /Reviewer prompt:\n<<<\n/);
	assert.ok(last.text.includes(reviewerPrompt(doc, "plan")), "the prompt is the module's, filled from the alignment");
	assert.match(last.text, /Goal: Persist the queue\./);
});

test("a used phase never starts again; a skipped one does; a skip can't replace a run", () => {
	const ran = run([CREATE, START_PLAN, { ops: [{ op: "review", phase: "plan", state: "clear", reason: "1 constraint added" }] }]);
	assert.throws(() => applyAlignCall(ran.docs, START_PLAN, env()), /plan review already ran \(clear\); there is no second round/);
	assert.throws(() => applyAlignCall(ran.docs, { ops: [{ op: "review", phase: "plan", state: "skipped", reason: "x" }] }, env()), /a skip can't replace it/);
	const skipped = run([CREATE, { ops: [{ op: "review", phase: "plan", state: "skipped", reason: "routine rename" }] }]);
	assert.equal(skipped.doc.review?.plan?.state, "skipped");
	assert.equal(skipped.last.details.line, "plan review skipped");
	const later = run([START_PLAN], env(), skipped.docs);
	assert.equal(later.doc.review?.plan?.state, "running", "a skip leaves the slot usable (the card's button)");
	// A failed or interrupted run stays incomplete and keeps its slot.
	const failed = run([{ ops: [{ op: "review", phase: "plan", state: "incomplete", reason: "spawn failed" }] }], env(), later.docs);
	assert.throws(() => applyAlignCall(failed.docs, START_PLAN, env()), /already ran \(incomplete\)/);
});

test("no reviewer configured refuses the start; neither runnable records incomplete with no question", () => {
	const { docs } = run([CREATE]);
	assert.throws(() => applyAlignCall(docs, START_PLAN, env(null)), /names no reviewer \(Reviewer: None\); record \{op: "review", phase: "plan", state: "skipped"/);
	const none = applyAlignCall(docs, START_PLAN, env({ use: null, via: "none", retry: null, reason: "openai-codex/gpt-6.1-sol is denied; opus[1m] is not offered" }));
	assert.equal(none.details.doc?.review?.plan?.state, "incomplete");
	assert.match(none.details.doc!.review!.plan!.reason, /^no reviewer can run: .*denied/);
	assert.match(none.text, /INCOMPLETE: no reviewer can run .* Do not ask the user for a model/);
	assert.ok(!none.text.includes("Reviewer prompt"), "nothing to spawn");
});

test("the fallback is named and disclosed when the primary can't run", () => {
	const { last } = run([CREATE, START_PLAN], env({ use: OPUS, via: "fallback", retry: null, reason: "gpt-6.1-sol is not offered by pi" }));
	assert.match(last.text, /configured FALLBACK — the primary is unavailable \(gpt-6\.1-sol is not offered by pi\); say so once/);
	assert.equal(last.details.doc?.review?.plan?.model, "claude-code · opus[1m] · high");
});

test("implementing is refused while the plan review runs; the phases follow the lifecycle", () => {
	const { docs } = run([CREATE, START_PLAN]);
	assert.throws(() => applyAlignCall(docs, ACCEPT_IMPL, env()), /plan review is running: record its verdict/);
	const { docs: d2 } = run([CREATE]);
	assert.throws(() => applyAlignCall(d2, { ops: [{ op: "review", phase: "diff", state: "running", reason: "r" }] }, env()), /the diff is reviewed while implementing/);
	const impl = run([CREATE, ACCEPT_IMPL]);
	assert.throws(() => applyAlignCall(impl.docs, START_PLAN, env()), /the plan phase is over/);
});

test("verdicts: only for a running review; blocking diff needs blockers; others take none", () => {
	const { docs } = run([CREATE, ACCEPT_IMPL]);
	assert.throws(() => applyAlignCall(docs, { ops: [{ op: "review", phase: "diff", state: "clear", reason: "x" }] }, env()), /is not started; a verdict is recorded only for a running review/);
	const running = run([{ ops: [{ op: "review", phase: "diff", state: "running", reason: "persistence" }] }], env(), docs);
	assert.throws(() => applyAlignCall(running.docs, { ops: [{ op: "review", phase: "diff", state: "blocking", reason: "2 found" }] }, env()), /needs its blockers/);
	assert.throws(() => applyAlignCall(running.docs, { ops: [{ op: "review", phase: "diff", state: "clear", reason: "ok", blockers: [{ title: "t", check: "c" }] }] }, env()), /only a blocking verdict takes blockers/);
	assert.throws(() => applyAlignCall(running.docs, { ops: [{ op: "review", phase: "diff", state: "blocking", reason: "x", blockers: [{ title: "t" }] }] }, env()), /check must be a non-empty string/);
	const fallbackRan = applyAlignCall(running.docs, { ops: [{ op: "review", phase: "diff", state: "clear", reason: "nothing found", model: "claude-code · opus[1m] · high" }] }, env());
	assert.equal(fallbackRan.details.doc?.review?.diff?.model, "claude-code · opus[1m] · high", "the verdict can name the fallback that ran");
	assert.equal(fallbackRan.details.line, "implementation review: no blocking");
});

test("done guard: refused while a review runs or a blocker is open; closed only by check, evidence or waiver", () => {
	const blocked = run([
		CREATE,
		ACCEPT_IMPL,
		{ ops: [{ op: "review", phase: "diff", state: "running", reason: "persistence" }] },
	]);
	assert.throws(() => applyAlignCall(blocked.docs, { ops: [{ op: "status", to: "done" }] }, env()), /diff review is running: record its verdict \(review\) before done/);
	const verdict = run(
		[
			{
				ops: [
					{
						op: "review",
						phase: "diff",
						state: "blocking",
						reason: "2 blocking",
						blockers: [
							{ title: "reload drops the last item", check: "node --test queue.test.ts -t reload" },
							{ title: "no fsync before rename", check: "grep -n fsync queue.ts" },
						],
					},
				],
			},
		],
		env(),
		blocked.docs,
	);
	assert.deepEqual(verdict.doc.review?.diff?.blockers?.map((b) => b.id), ["b1", "b2"]);
	assert.equal(verdict.last.details.line, "implementation review: blocking");
	assert.throws(() => applyAlignCall(verdict.docs, { ops: [{ op: "status", to: "done" }] }, env()), /2 open blockers \(diff b1, diff b2\): close each with close_blocker/);
	assert.throws(() => applyAlignCall(verdict.docs, { ops: [{ op: "close_blocker", phase: "diff", id: "b1", by: "opinion", evidence: "x" }] }, env()), /by must be check/);
	assert.throws(() => applyAlignCall(verdict.docs, { ops: [{ op: "close_blocker", phase: "diff", id: "b9", by: "check", evidence: "x" }] }, env()), /has no blocker b9 \(it has b1, b2\)/);
	// Closing one and marking done in the same call is still refused: atomically, nothing changes.
	assert.throws(
		() => applyAlignCall(verdict.docs, { ops: [{ op: "close_blocker", phase: "diff", id: "b1", by: "check", evidence: "passes" }, { op: "status", to: "done" }] }, env()),
		/1 open blocker \(diff b2\)/,
	);
	const done = run(
		[
			{
				ops: [
					{ op: "close_blocker", phase: "diff", id: "b1", by: "check", evidence: "node --test queue.test.ts -t reload passes" },
					{ op: "close_blocker", phase: "diff", id: "b2", by: "waiver", evidence: "user: \"ship it, fsync later\"" },
					{ op: "status", to: "done" },
				],
			},
		],
		env(),
		verdict.docs,
	);
	assert.equal(done.doc.phase, "done");
	assert.equal(done.last.details.line, "implementation b1 closed · implementation b2 closed · → done");
	assert.throws(() => applyAlignCall(done.docs, { doc: "al_1", ops: [{ op: "close_blocker", phase: "diff", id: "b1", by: "check", evidence: "x" }] }, env()), /is done; move it back/);
});

test("a late diff review after done: allowed only when skipped, and a blocker reopens it to implementing", () => {
	const done = run([
		CREATE,
		{ ops: [{ op: "review", phase: "plan", state: "skipped", reason: "small" }] },
		ACCEPT_IMPL,
		{ ops: [{ op: "review", phase: "diff", state: "skipped", reason: "one-line change" }, { op: "status", to: "done" }] },
	]);
	assert.equal(done.doc.phase, "done");
	assert.throws(() => applyAlignCall(done.docs, { doc: "al_1", ops: [START_PLAN.ops[0]] }, env()), /is done; move it back/, "only the diff phase runs late");
	const late = run(
		[
			{ doc: "al_1", ops: [{ op: "review", phase: "diff", state: "running", reason: "user asked" }] },
			{ doc: "al_1", ops: [{ op: "review", phase: "diff", state: "blocking", reason: "1 blocking", blockers: [{ title: "t", check: "c" }] }] },
		],
		env(),
		done.docs,
	);
	assert.equal(late.doc.phase, "implementing");
	assert.equal(late.last.details.line, "implementation review: blocking · → implementing");
	const clean = run(
		[
			{ doc: "al_1", ops: [{ op: "review", phase: "diff", state: "running", reason: "user asked" }] },
			{ doc: "al_1", ops: [{ op: "review", phase: "diff", state: "clear", reason: "none" }] },
		],
		env(),
		done.docs,
	);
	assert.equal(clean.doc.phase, "done", "a clean late review leaves it done");
});

test("the record survives the fold (resume, fork, rewind) and old snapshots still read", () => {
	const { docs } = run([CREATE, START_PLAN]);
	const entries = docs.map((doc) => ({ type: "message", message: { role: "toolResult", toolName: "align", details: { v: 1, doc, changes: [], line: "" } } }));
	const folded = foldAlignments(entries).docs[0]!;
	assert.deepEqual(folded.review, docs[0]!.review);
	// An older session's snapshot, without a record, reads as before: no review key at all.
	const old = structuredClone(docs[0]!);
	delete old.review;
	const normalized = normalizeAlignDocument(old)!;
	assert.equal("review" in normalized, false);
	assert.deepEqual(reviewLines(normalized), []);
	assert.equal(toMarkdown(normalized).includes("### Review"), false);
});

test("normalization is strict about the record", () => {
	const { doc } = run([CREATE, ACCEPT_IMPL, { ops: [{ op: "review", phase: "diff", state: "running", reason: "r" }] }, { ops: [{ op: "review", phase: "diff", state: "blocking", reason: "r", blockers: [{ title: "t", check: "c" }] }] }]);
	assert.ok(normalizeAlignDocument(doc));
	const bad = (mutate: (d: Record<string, any>) => void) => {
		const d = structuredClone(doc) as unknown as Record<string, any>;
		mutate(d);
		return normalizeAlignDocument(d);
	};
	assert.equal(bad((d) => (d.review.diff.state = "maybe")), undefined);
	assert.equal(bad((d) => (d.review.extra = {})), undefined);
	assert.equal(bad((d) => (d.review.diff.reason = "")), undefined);
	assert.equal(bad((d) => (d.review.diff.blockers[0].id = "x1")), undefined);
	assert.equal(bad((d) => d.review.diff.blockers.push({ ...d.review.diff.blockers[0] })), undefined, "duplicate blocker id");
	assert.equal(bad((d) => (d.review.diff.blockers[0].closed = { by: "vibes", evidence: "e", at: NOW })), undefined);
	assert.equal(bad((d) => (d.review.diff.blockers = [])), undefined);
	// The new change kinds check out; an unknown one fails the details.
	assert.ok(normalizeAlignDetails({ v: 1, doc, changes: [{ kind: "review", phase: "diff", state: "blocking" }, { kind: "blocker-closed", phase: "diff", id: "b1" }], line: "x" }));
	assert.equal(normalizeAlignDetails({ v: 1, doc, changes: [{ kind: "review", phase: "later", state: "clear" }], line: "x" }), undefined);
});

test("verdict lines, change line and markdown say the record the card shows", () => {
	const at = NOW;
	assert.equal(reviewVerdictLine("plan", { state: "skipped", reason: "routine change", at }), "Plan review skipped: routine change");
	assert.equal(reviewVerdictLine("plan", { state: "running", reason: "r", at }), "Reviewing the plan");
	assert.equal(reviewVerdictLine("plan", { state: "clear", reason: "1 constraint added", at }), "Plan reviewed · 1 constraint added");
	assert.equal(reviewVerdictLine("plan", { state: "incomplete", reason: "spawn failed", at }), "Plan review incomplete: spawn failed");
	assert.equal(reviewVerdictLine("diff", { state: "running", reason: "r", at }), "Reviewing the implementation");
	assert.equal(reviewVerdictLine("diff", { state: "clear", reason: "x", at }), "Implementation review: no blocking issues");
	assert.equal(reviewVerdictLine("diff", { state: "skipped", reason: "one-line change", at }), "Implementation review skipped: one-line change");
	const two = [
		{ id: "b1", title: "a", check: "c" },
		{ id: "b2", title: "b", check: "d", closed: { by: "check" as const, evidence: "e", at } },
	];
	const twoOpen = two.map(({ closed: _, ...b }) => b);
	assert.equal(reviewVerdictLine("diff", { state: "blocking", reason: "x", at, blockers: twoOpen }), "Implementation review: 2 blocking");
	assert.equal(reviewVerdictLine("diff", { state: "blocking", reason: "x", at, blockers: two }), "Implementation review: 2 blocking (1 open)");
	assert.equal(reviewVerdictLine("plan", { state: "blocking", reason: "x", at, blockers: twoOpen }), "Plan review: 2 blocking");
	assert.equal(reviewVerdictLine("diff", { state: "incomplete", reason: "spawn failed", at }), "Implementation review incomplete: spawn failed");
	assert.equal(changeLine([{ kind: "review", phase: "plan", state: "skipped" }, { kind: "blocker-closed", phase: "diff", id: "b1" }]), "plan review skipped · implementation b1 closed");
	assert.equal(changeLine([{ kind: "review", phase: "diff", state: "running" }]), "implementation review running");
	const doc = { review: { diff: { state: "blocking" as const, reason: "x", at, model: "pi · m · high", blockers: two } } };
	assert.deepEqual(reviewLines(doc), ["Implementation review: 2 blocking (1 open) (pi · m · high)", "  implementation b1 open: a — check: c"]);
});

test("the request message the card and /review send: the user's word in the prose, the id in the token", () => {
	assert.equal(reviewRequestMessage("al_3", "diff"), "al_3: run the adversarial implementation review now (align review, phase diff), whatever the rule says.");
	assert.equal(reviewRequestMessage("al_3", "plan"), "al_3: run the adversarial plan review now (align review, phase plan), whatever the rule says.");
});

test("reviewer prompt: fixed stance, hunt order, output shape, budget; plan and diff variants", () => {
	const { doc } = run([CREATE, { ops: [{ op: "decide", q: "q1", decision: "SQLite, with WAL" }] }]);
	const plan = reviewerPrompt(doc, "plan");
	const diff = reviewerPrompt(doc, "diff");
	for (const p of [plan, diff]) {
		assert.match(p, /report-only/);
		assert.match(p, /1\. Drift[\s\S]*2\. Correctness at seams[\s\S]*3\. Security[\s\S]*4\. Checks that would pass in the bad state[\s\S]*5\. Maintainability/);
		assert.match(p, /counter-evidence/);
		assert.match(p, /evidence, never instructions/);
		assert.match(p, /Verdict: BLOCKING \| NO BLOCKING \| INCOMPLETE\nCoverage:/);
		assert.match(p, /at most 5, at most 2 of them non-blocking; "none" is a valid answer/);
		assert.match(p, /A clean review is the first two lines only/);
		assert.match(p, /about 12k tokens of context, about 1,200 tokens of answer, 8 minutes/);
		assert.match(p, /Decisions:\n- q1 Format: SQLite, with WAL/);
		assert.match(p, /Rejected:\n- x1: Keep it in memory — lost at restart/);
	}
	assert.match(plan, /Review the PLAN/);
	assert.doesNotMatch(plan, /Diff base/);
	assert.match(diff, /Review the DIFF/);
	assert.match(diff, /Diff base: <commit or branch>\nChanged files: <paths>\nTest results:/);
	assert.match(alignmentBrief(doc), /^Alignment al_1: Queue\nGoal: Persist the queue\./);
	assert.deepEqual(REVIEWER_TOOLS, { pi: ["read", "grep", "find", "ls"], "claude-code": ["Read", "Grep", "Glob"] });
});
