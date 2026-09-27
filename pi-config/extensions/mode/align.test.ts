import assert from "node:assert/strict";
import test from "node:test";
import {
	ALIGN_ENTRY_TYPE,
	ALIGN_TOOL,
	AlignError,
	alignCounts,
	alignStateNote,
	alignStatus,
	applyAlignCall,
	changeLine,
	clampScroll,
	foldAlignments,
	legacyLine,
	legacyStatus,
	nextDocId,
	normalizeAlignDetails,
	normalizeAlignEntry,
	openText,
	planSignal,
	toMarkdown,
	viewport,
	widgetText,
	type AlignDetails,
	type AlignDocument,
	type AlignEnv,
} from "./align.ts";

const NOW = "2026-09-28T10:00:00.000Z";
const files: Record<string, string> = {};
const env: AlignEnv = {
	now: NOW,
	readFile: (path) => {
		if (!(path in files)) throw new Error(`ENOENT: no such file, open '${path}'`);
		return files[path]!;
	},
};

const Q = (topic: string, choice = "yes") => ({ topic, ask: `${topic}?`, recommendation: { choice, why: `because ${topic}` } });

const CREATE = {
	op: "create",
	title: "Session export",
	summary: "Let the user download a session as a file.",
	findings: ["The exporter lives in server/export.ts.", "Big sessions are 4 MB."],
	approach: ["Add a route.", "Stream the JSONL."],
	rejected: [{ option: "Client-side export", why: "too slow for big sessions" }],
	questions: [
		{ ...Q("Tool output"), context: "Tool output is most of the bytes.", options: [{ label: "Collapsed", tradeoff: "smaller" }, { label: "Full", tradeoff: "complete" }] },
		Q("Format", "plain JSONL"),
		Q("Zip", "no"),
	],
};

/** Apply calls in order, like a branch of tool results: each outcome's snapshot replaces its doc. */
function run(calls: unknown[], start: AlignDocument[] = []): { docs: AlignDocument[]; last: ReturnType<typeof applyAlignCall> } {
	let docs = start;
	let last!: ReturnType<typeof applyAlignCall>;
	for (const call of calls) {
		last = applyAlignCall(docs, call, env);
		const doc = last.details.doc;
		if (doc) docs = [...docs.filter((d) => d.id !== doc.id), doc];
	}
	return { docs, last };
}

const throwsAlign = (fn: () => unknown, message: RegExp) =>
	assert.throws(fn, (error: unknown) => error instanceof AlignError && message.test(error.message), `expected AlignError ${message}`);

test("create: a complete document with fresh ids, rev 1, derived status aligning, and a snapshot in details", () => {
	const { last, docs } = run([{ ops: [CREATE] }]);
	const doc = last.details.doc!;
	assert.equal(doc.id, "al_1");
	assert.deepEqual(doc.findings.map((f) => f.id), ["f1", "f2"]);
	assert.deepEqual(doc.approach.map((a) => a.id), ["a1", "a2"]);
	assert.deepEqual(doc.rejected, [{ id: "x1", option: "Client-side export", why: "too slow for big sessions" }]);
	assert.deepEqual(doc.questions.map((q) => q.id), ["q1", "q2", "q3"]);
	assert.deepEqual(doc.questions[0]!.options, [{ label: "Collapsed", tradeoff: "smaller" }, { label: "Full", tradeoff: "complete" }]);
	assert.equal(doc.questions[0]!.context, "Tool output is most of the bytes.");
	assert.equal(doc.rev, 1);
	assert.equal(doc.createdAt, NOW);
	assert.equal(alignStatus(doc), "aligning");
	assert.deepEqual(last.details.changes, [{ kind: "created" }]);
	assert.equal(last.details.line, "created");
	assert.equal(docs.length, 1);
	// The echo: the doc's line and one line per open question with its recommendation.
	assert.match(last.text, /^al_1 "Session export" · aligning · 3 of 3 open · v1 · created$/m);
	assert.match(last.text, /^ {2}q2 Format — open \(rec: plain JSONL\)$/m);
});

test("create: strict — every question needs a recommendation, unknown fields are named, empty strings refused", () => {
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "create", title: "t", summary: "s", questions: [{ topic: "x", ask: "y" }] }] }, env), /questions\[0\]\.recommendation must be an object/);
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "create", title: "t", summary: "s", questions: [{ ...Q("x"), answer: "no" }] }] }, env), /unknown field "answer"/);
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "create", title: " ", summary: "s" }] }, env), /title must be a non-empty string/);
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "create", title: "t" }] }, env), /summary must be a non-empty string/);
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "decide", q: "q1", decision: "x", topic: "nope" }] }, env), /ops\[0\] \(decide\): unknown field "topic"/);
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "frobnicate" }] }, env), /ops\[0\]\.op must be one of/);
	throwsAlign(() => applyAlignCall([], { ops: [] }, env), /non-empty array/);
	throwsAlign(() => applyAlignCall([], { ops: [Q("a")] }, env), /ops\[0\]\.op must be one of/);
});

test("create fromFile: the same document from JSON, strictly validated, with the file named in every error", () => {
	files["plan.json"] = JSON.stringify({ title: "From a worker", summary: "Planned elsewhere.", approach: ["one"], questions: [Q("Scope")] });
	const { last } = run([{ ops: [{ op: "create", fromFile: "plan.json" }] }]);
	assert.equal(last.details.doc!.title, "From a worker");
	assert.deepEqual(last.details.changes, [{ kind: "created", fromFile: true }]);
	assert.equal(last.details.line, "created from file");

	files["bad.json"] = "{ title: nope";
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "create", fromFile: "bad.json" }] }, env), /^fromFile bad\.json: not valid JSON/);
	files["extra.json"] = JSON.stringify({ title: "t", summary: "s", status: "aligning" });
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "create", fromFile: "extra.json" }] }, env), /^fromFile extra\.json: unknown field "status"/);
	files["types.json"] = JSON.stringify({ title: "t", summary: "s", findings: "one string" });
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "create", fromFile: "types.json" }] }, env), /^fromFile types\.json: findings must be an array/);
	files["deep.json"] = JSON.stringify({ title: "t", summary: "s", questions: [Q("a"), { ...Q("b"), options: [{ label: "x" }] }] });
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "create", fromFile: "deep.json" }] }, env), /questions\[1\]\.options\[0\]\.tradeoff must be a non-empty string/);
	files["array.json"] = "[]";
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "create", fromFile: "array.json" }] }, env), /must be a JSON object/);
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "create", fromFile: "missing.json" }] }, env), /^fromFile missing\.json: cannot read it \(ENOENT/);
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "create", fromFile: "plan.json", title: "both" }] }, env), /either fromFile or the document's fields/);
});

test("ids are never reused: add after remove continues the count; a question is dropped, never removed", () => {
	const { docs, last } = run([
		{ ops: [CREATE] },
		{ ops: [{ op: "remove", ids: ["f2", "x1"] }] },
		{ ops: [{ op: "add", findings: ["Third"], rejected: [{ option: "Zip always", why: "slower" }], questions: [Q("Name")] }] },
	]);
	const doc = docs[0]!;
	assert.deepEqual(doc.findings.map((f) => f.id), ["f1", "f3"]);
	assert.deepEqual(doc.rejected.map((x) => x.id), ["x2"]);
	assert.deepEqual(doc.questions.map((q) => q.id), ["q1", "q2", "q3", "q4"]);
	assert.equal(doc.rev, 3);
	assert.deepEqual(last.details.changes, [{ kind: "added", ids: ["f3", "x2", "q4"] }]);
	assert.equal(last.details.line, "+f3 +x2 +q4");
	throwsAlign(() => applyAlignCall(docs, { ops: [{ op: "remove", ids: ["q1"] }] }, env), /q1 can't be removed .*drop a question instead/);
	throwsAlign(() => applyAlignCall(docs, { ops: [{ op: "remove", ids: ["f2"] }] }, env), /al_1 has no f2/);
});

test("edit: each item kind takes its own fields; the document's title and summary without an id", () => {
	const { docs, last } = run([
		{ ops: [CREATE] },
		{
			ops: [
				{ op: "edit", id: "q2", ask: "Which format?", context: "Readers vary.", recommendation: { choice: "markdown", why: "humans read it" } },
				{ op: "edit", id: "q1", context: "" },
				{ op: "edit", id: "a1", text: "Add GET /api/export." },
				{ op: "edit", id: "x1", why: "4 MB in the browser" },
				{ op: "edit", title: "Export a session" },
			],
		},
	]);
	const doc = docs[0]!;
	assert.equal(doc.questions[1]!.recommendation.choice, "markdown");
	assert.equal(doc.questions[1]!.context, "Readers vary.");
	assert.equal(doc.questions[0]!.context, undefined, '"" clears the context');
	assert.equal(doc.approach[0]!.text, "Add GET /api/export.");
	assert.equal(doc.rejected[0]!.why, "4 MB in the browser");
	assert.equal(doc.title, "Export a session");
	assert.equal(last.details.line, "q2 edited · q1 edited · a1 edited · x1 edited · title edited");
	throwsAlign(() => applyAlignCall(docs, { ops: [{ op: "edit", id: "f1", topic: "x" }] }, env), /f1 takes text, not topic/);
	throwsAlign(() => applyAlignCall(docs, { ops: [{ op: "edit", id: "q9", ask: "x" }] }, env), /al_1 has no question q9/);
	throwsAlign(() => applyAlignCall(docs, { ops: [{ op: "edit", ask: "x" }] }, env), /the document \(no id\) takes title, summary, not ask/);
});

test("answers: decide records the user's words, accept takes the recommendation, reopen and drop; status follows the data", () => {
	const { docs } = run([{ ops: [CREATE] }, { ops: [{ op: "decide", q: "q1", decision: "collapsed, like the web" }, { op: "accept", q: ["q2"] }] }]);
	const doc = docs[0]!;
	assert.deepEqual(doc.questions[0]!.decision, { text: "collapsed, like the web", by: "user", at: NOW });
	assert.deepEqual(doc.questions[1]!.decision, { text: "plain JSONL", by: "accepted-recommendation", at: NOW });
	assert.equal(openText(doc), "1 of 3 open");
	assert.equal(alignStatus(doc), "aligning");

	const dropped = run([{ ops: [{ op: "drop", q: "q3", why: "out of scope" }] }], docs).docs[0]!;
	assert.equal(alignStatus(dropped), "confirmed", "every live question decided: confirmed, with no explicit op");
	assert.equal(openText(dropped), "all 2 decided");
	throwsAlign(() => applyAlignCall([dropped], { ops: [{ op: "decide", q: "q3", decision: "x" }] }, env), /q3 is dropped; reopen it first/);

	const reopened = run([{ ops: [{ op: "reopen", q: "q1" }] }], [dropped]).docs[0]!;
	assert.equal(reopened.questions[0]!.decision, undefined);
	assert.equal(alignStatus(reopened), "aligning");
	throwsAlign(() => applyAlignCall([reopened], { ops: [{ op: "reopen", q: "q1" }] }, env), /q1 is already open/);
});

test("lifecycle: implementing and done need no open questions; accept open + status in one call is the 'your recs' path", () => {
	const { docs } = run([{ ops: [CREATE] }]);
	throwsAlign(() => applyAlignCall(docs, { ops: [{ op: "status", to: "implementing" }] }, env), /still has 3 open questions \(q1, q2, q3\)/);
	const { docs: going, last } = run([{ ops: [{ op: "accept", q: "open" }, { op: "status", to: "implementing" }] }], docs);
	assert.equal(alignStatus(going[0]!), "implementing");
	assert.equal(last.details.line, "q1, q2, q3 accepted · → implementing");
	throwsAlign(() => applyAlignCall(going, { ops: [{ op: "accept", q: "open" }] }, env), /no open questions to accept/);
	const done = run([{ ops: [{ op: "status", to: "done" }] }], going).docs[0]!;
	assert.equal(alignStatus(done), "done");
	// A finished document takes nothing but a move back to open.
	throwsAlign(() => applyAlignCall([done], { doc: "al_1", ops: [{ op: "add", findings: ["late"] }] }, env), /al_1 is done; move it back/);
	const back = run([{ doc: "al_1", ops: [{ op: "status", to: "open" }, { op: "add", findings: ["late"] }] }], [done]).docs[0]!;
	assert.equal(alignStatus(back), "confirmed");
	const gone = run([{ ops: [{ op: "drop", why: "user changed course" }] }], [back]).docs[0]!;
	assert.equal(alignStatus(gone), "dropped");
	assert.equal(gone.droppedWhy, "user changed course");
});

test("atomic: one bad op fails the whole call and the documents passed in are untouched", () => {
	const { docs } = run([{ ops: [CREATE] }]);
	const before = structuredClone(docs);
	throwsAlign(() => applyAlignCall(docs, { ops: [{ op: "decide", q: "q1", decision: "yes" }, { op: "add", findings: ["x"] }, { op: "decide", q: "q7", decision: "no" }] }, env), /no question q7/);
	assert.deepEqual(docs, before);
});

test("targets: one open doc is the default; with several, doc is required; an unknown doc is named", () => {
	const { docs } = run([{ ops: [CREATE] }, { ops: [{ ...CREATE, title: "Second concern" }] }]);
	assert.deepEqual(docs.map((d) => d.id), ["al_1", "al_2"]);
	assert.equal(nextDocId(docs), "al_3");
	throwsAlign(() => applyAlignCall(docs, { ops: [{ op: "accept", q: "open" }] }, env), /doc is required while several are open \(al_1 "Session export", al_2 "Second concern"\)/);
	throwsAlign(() => applyAlignCall(docs, { doc: "al_9", ops: [{ op: "get" }] }, env), /No alignment al_9 on this branch/);
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "add", findings: ["x"] }] }, env), /No open alignment to change: create one first/);
	const { last } = run([{ doc: "al_1", ops: [{ op: "decide", q: "q1", decision: "full" }] }], docs);
	assert.equal(last.details.doc!.id, "al_1");
	assert.equal(last.details.doc!.rev, 2);
	assert.match(last.text, /^Other open alignments: al_2 "Second concern" aligning \(3 open\)$/m);
});

test("exempt stands alone and touches nothing; get reads without a snapshot", () => {
	const ex = applyAlignCall([], { ops: [{ op: "exempt", why: "a question about the code, no change" }] }, env);
	assert.deepEqual(ex.details, { v: 1, changes: [], line: "", exempt: { why: "a question about the code, no change" } });
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "exempt", why: "x" }, { op: "get" }] }, env), /exempt stands alone/);
	const { docs } = run([{ ops: [CREATE] }]);
	const got = applyAlignCall(docs, { ops: [{ op: "get" }] }, env);
	assert.equal(got.details.doc, undefined, "no change, no snapshot: a get is never state");
	assert.match(got.text, /## al_1: Session export/);
	assert.match(got.text, /Recommended: \*\*plain JSONL\*\* — because Format/);
	assert.equal(applyAlignCall([], { ops: [{ op: "get" }] }, env).text, "No open alignments on this branch.");
});

const toolResult = (id: string, details: unknown, isError = false) => ({
	type: "message",
	id,
	message: { role: "toolResult", toolCallId: `c-${id}`, toolName: ALIGN_TOOL, content: [{ type: "text", text: "…" }], details, isError },
});

test("fold: newest snapshot per id in touch order; errors, other tools and malformed details are never state", () => {
	const a = run([{ ops: [CREATE] }]).last.details;
	const b = run([{ ops: [{ ...CREATE, title: "B" }] }], [a.doc!]).last.details;
	const a2 = run([{ doc: "al_1", ops: [{ op: "accept", q: "open" }] }], [a.doc!, b.doc!]).last.details;
	const entries = [
		{ type: "session", id: "h" },
		toolResult("1", JSON.parse(JSON.stringify(a))),
		toolResult("2", JSON.parse(JSON.stringify(b))),
		toolResult("3", JSON.parse(JSON.stringify(a2))),
		toolResult("4", { ...a2, doc: { ...a2.doc, title: "failed call" } }, true),
		toolResult("5", { v: 2, changes: [], line: "", doc: a2.doc }),
		toolResult("6", { ...a2, doc: { ...a2.doc, questions: [{ id: "q1" }] } }),
		{ type: "message", id: "7", message: { role: "toolResult", toolName: "bash", details: a2 } },
		{ type: "custom", customType: "mode", data: {} },
	];
	const fold = foldAlignments(entries);
	assert.deepEqual(fold.docs.map((d) => [d.id, d.title, d.rev]), [["al_2", "B", 1], ["al_1", "Session export", 2]]);
	assert.equal(fold.legacy, null);
	// A rewind is just a shorter branch: the fold lands on the earlier state.
	assert.deepEqual(foldAlignments(entries.slice(0, 3)).docs.map((d) => [d.id, d.rev]), [["al_1", 1], ["al_2", 1]]);
	assert.deepEqual(foldAlignments(null as unknown as unknown[]), { docs: [], legacy: null });
});

test("details round-trip through JSON and normalizeAlignDetails; the stored shape is checked field by field", () => {
	const { last } = run([{ ops: [CREATE] }, { ops: [{ op: "decide", q: "q1", decision: "full" }, { op: "drop", q: "q3", why: "later" }] }]);
	const stored = JSON.parse(JSON.stringify(last.details)) as AlignDetails;
	assert.deepEqual(normalizeAlignDetails(stored), last.details);
	for (const bad of [
		null,
		{ ...stored, v: 2 },
		{ ...stored, line: 1 },
		{ ...stored, changes: [{ kind: "teleported" }] },
		{ ...stored, doc: { ...stored.doc, id: "doc1" } },
		{ ...stored, doc: { ...stored.doc, phase: "aligning" } },
		{ ...stored, doc: { ...stored.doc, rev: 0 } },
		{ ...stored, doc: { ...stored.doc, questions: [{ ...stored.doc!.questions[0], decision: { text: "x", by: "robot", at: NOW } }] } },
		{ ...stored, exempt: { why: "" } },
	]) {
		assert.equal(normalizeAlignDetails(bad), undefined, JSON.stringify(bad).slice(0, 80));
	}
});

test("counts, the hidden note and the widget cover open documents only", () => {
	const { docs } = run([
		{ ops: [CREATE] },
		{ ops: [{ ...CREATE, title: "Second", questions: [Q("Only")] }] },
		{ doc: "al_2", ops: [{ op: "accept", q: "open" }, { op: "status", to: "done" }] },
		{ ops: [{ ...CREATE, title: "Third", questions: [Q("One"), Q("Two")] }] },
		{ doc: "al_3", ops: [{ op: "decide", q: "q1", decision: "no" }] },
	]);
	assert.deepEqual(alignCounts(docs), { docs: 2, open: 4, total: 5 });
	const note = alignStateNote(docs)!;
	assert.match(note, /^\[align\] Open alignments on this branch/);
	assert.match(note, /^al_1 "Session export" · aligning · 3 of 3 open$/m);
	assert.match(note, /^ {2}q2 Format: Format\? \(rec: plain JSONL\)$/m);
	assert.match(note, /^al_3 "Third" · aligning · 1 of 2 open$/m);
	assert.doesNotMatch(note, /al_2/, "a finished alignment is not in the note");
	assert.equal(alignStateNote(docs.filter((d) => d.id === "al_2")), undefined);
	assert.equal(widgetText(docs, "alt+a"), "◇ align · al_1 3/3 open · al_3 1/2 open · alt+a view");
});

test("changeLine: one short word per change, consecutive decisions merged", () => {
	assert.equal(changeLine([]), "");
	assert.equal(
		changeLine([
			{ kind: "decided", q: "q1" },
			{ kind: "decided", q: "q3" },
			{ kind: "added", ids: ["q11"] },
			{ kind: "removed", ids: ["f2", "a1"] },
			{ kind: "question-dropped", q: "q4" },
			{ kind: "reopened", q: "q2" },
			{ kind: "status", to: "open" },
			{ kind: "dropped" },
		]),
		"q1, q3 decided · +q11 · −f2 −a1 · q4 dropped · q2 reopened · → open · dropped",
	);
});

test("toMarkdown: every section and every question's parts", () => {
	const { docs } = run([{ ops: [CREATE] }, { ops: [{ op: "decide", q: "q1", decision: "full" }] }]);
	const md = toMarkdown(docs[0]!);
	for (const needle of ["## al_1: Session export", "_Let the user download a session as a file._", "### Questions", "**q1 · Tool output** (decided)", "- **Collapsed** — smaller", "Decided: full (user)", "### Findings", "- f1: The exporter", "### Approach", "1. a1: Add a route.", "### Rejected", "- x1: Client-side export — too slow"]) {
		assert.ok(md.includes(needle), needle);
	}
});

// The settle nudge's heuristic, calibrated offline against the two sessions the design report names
// (a delegate · align · spec session with 114 final replies, and the freeform-plan session). There
// it fired on every markdown alignment block, on the freeform plans ("…take my recommendations on
// 1–6?", "Should I go ahead with those answers?", "Which do you want: …?"), and on one of ~80 other
// replies; status reports, lane reports and merge questions stayed quiet. The shapes below are
// written for this test, after those replies.
test("planSignal: catches a plan that asks the user to decide, and leaves reports and plain questions alone", () => {
	const freeform = [
		"The planning worker is done, and nothing has been changed yet. The full plan is in `~/.cache/x/PLAN.md`.",
		"",
		"**Open questions, with my suggested answers:**",
		"1. **Cap:** raise it to 400. I suggest yes.",
		"2. **Grouping:** by worker. I suggest yes.",
		"",
		"Should I go ahead with those answers?",
	].join("\n");
	assert.equal(planSignal(freeform), "asks-decision");
	assert.equal(planSignal(`${freeform}\n\nAlso changes: none`), "asks-decision", "the spec mode's last line is not the reply's end");
	assert.equal(planSignal("## Alignment: Export\n### Findings\nx\n### Open questions\n- [ ] **1. Zip:** yes?"), "markdown-alignment");
	assert.equal(planSignal("Options:\n- **Daily 6** — simple\n- **3 per run** — bursty\n\nWhich do you want: the daily 6 or 3 per run?"), "asks-decision");
	assert.equal(planSignal("Here is the plan, and its open questions are in the doc:\n1. Add the route\n2. Stream it\n\nGo?"), "list-then-decision");

	assert.equal(planSignal("Lane E is finished. It found 2 bugs:\n- the guard\n- the restart\n\nLanes B, C and D are still running."), null);
	assert.equal(planSignal("The fix is on `feat/x`, 3 commits, tests pass.\n\nWant me to merge it?"), null);
	assert.equal(planSignal("Merged. The open questions from before are recorded in al_2.\n\nAnything else?"), null, "decision words above, but no list and no asking end");
	assert.equal(planSignal("```\nShould I go ahead?\n```\nDone."), null, "code fences are ignored");
	assert.equal(planSignal(""), null);
	assert.equal(planSignal(undefined as unknown as string), null);
});

test("legacy align-doc entries: read-only, strictly shaped, newest on the branch wins in the fold", () => {
	const legacyDoc = { version: 1, title: "Old", markdown: "## Alignment: Old", questions: [{ n: 1, text: "a", checked: true }, { n: 2, text: "b", checked: false }], revision: 3, capturedAt: NOW };
	assert.deepEqual(normalizeAlignEntry({ version: 1, doc: legacyDoc }), { version: 1, doc: legacyDoc });
	assert.deepEqual(normalizeAlignEntry({ version: 1, doc: null }), { version: 1, doc: null });
	for (const bad of [null, {}, { version: 2, doc: null }, { version: 1, doc: { ...legacyDoc, questions: [{ n: "1" }] } }, { version: 1, doc: { ...legacyDoc, explicitStatus: "done" } }]) {
		assert.equal(normalizeAlignEntry(bad), undefined);
	}
	assert.equal(legacyStatus(legacyDoc), "questions-open");
	assert.equal(legacyLine(legacyDoc), "v3 · questions open · 1/2 settled");
	const entry = (doc: unknown) => ({ type: "custom", customType: ALIGN_ENTRY_TYPE, data: { version: 1, doc } });
	assert.equal(foldAlignments([entry(legacyDoc), entry({ ...legacyDoc, revision: 4 })]).legacy?.revision, 4);
	assert.equal(foldAlignments([entry(legacyDoc), entry(null)]).legacy, null);
	assert.deepEqual(foldAlignments([entry(legacyDoc)]).docs, [], "a legacy doc is never a tool document");
});

test("clampScroll/viewport keep the window inside the content", () => {
	assert.equal(clampScroll(-5, 10, 4), 0);
	assert.equal(clampScroll(99, 10, 4), 6);
	assert.equal(clampScroll(3, 2, 4), 0);
	assert.equal(clampScroll(Number.NaN, 10, 4), 0);
	assert.deepEqual(viewport([1, 2, 3, 4, 5], 1, 2), [2, 3]);
	assert.deepEqual(viewport([1, 2, 3], 5, 2), [2, 3]);
	assert.deepEqual(viewport([1, 2, 3], 0, 0), []);
});
