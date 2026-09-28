import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ALIGN_FILE_MAX_BYTES, readAlignFile } from "./align-file.ts";
import {
	ALIGN_ENTRY_TYPE,
	ALIGN_OP_FIELDS,
	ALIGN_OPS,
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
	optionLetter,
	planSignal,
	recommendedOption,
	recommendedText,
	toMarkdown,
	viewport,
	widgetText,
	type AlignDetails,
	type AlignDocument,
	type AlignEnv,
	type AlignOpName,
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
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "create", title: "t" }] }, env), /ops\[0\] \(create\): summary is required/);
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "create", title: "t", summary: "" }] }, env), /summary must be a non-empty string/);
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "decide", q: "q1", decision: "x", topic: "nope" }] }, env), /ops\[0\] \(decide\): unknown field "topic"/);
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "create", title: "t", summary: "s", questions: [{ ...Q("x"), answer: "no" }] }] }, env), /unknown field "answer" \(allowed/, "no hint where the meant field isn't allowed either");
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "frobnicate" }] }, env), /ops\[0\]\.op must be one of/);
	throwsAlign(() => applyAlignCall([], { ops: [] }, env), /non-empty array/);
	throwsAlign(() => applyAlignCall([], { ops: [Q("a")] }, env), /ops\[0\]\.op must be one of/);
});

test("import: the same document from a JSON file at an absolute path, strictly validated, with the file named in every error", () => {
	files["/plans/plan.json"] = JSON.stringify({ title: "From a worker", summary: "Planned elsewhere.", approach: ["one"], questions: [Q("Scope")] });
	const { last } = run([{ ops: [{ op: "import", path: "/plans/plan.json" }] }]);
	assert.equal(last.details.doc!.title, "From a worker");
	assert.deepEqual(last.details.changes, [{ kind: "created", fromFile: true }], "the stored change keeps its name");
	assert.equal(last.details.line, "created from file");
	files["~/plans/home.json"] = files["/plans/plan.json"]!;
	assert.equal(run([{ ops: [{ op: "import", path: "~/plans/home.json" }] }]).last.details.doc!.title, "From a worker", "~/ counts as absolute");

	throwsAlign(() => applyAlignCall([], { ops: [{ op: "import", path: "plan.json" }] }, env), /ops\[0\] \(import\): path must be absolute \(e\.g\. "\/tmp\/align-plan\.json"\), not "plan\.json"/);
	files["/p/bad.json"] = "{ title: nope";
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "import", path: "/p/bad.json" }] }, env), /^import \/p\/bad\.json: not valid JSON/);
	files["/p/extra.json"] = JSON.stringify({ title: "t", summary: "s", status: "aligning" });
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "import", path: "/p/extra.json" }] }, env), /^import \/p\/extra\.json: unknown field "status"/);
	files["/p/types.json"] = JSON.stringify({ title: "t", summary: "s", findings: "one string" });
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "import", path: "/p/types.json" }] }, env), /^import \/p\/types\.json: findings must be an array/);
	files["/p/deep.json"] = JSON.stringify({ title: "t", summary: "s", questions: [Q("a"), { ...Q("b"), options: [{ label: "x" }] }] });
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "import", path: "/p/deep.json" }] }, env), /questions\[1\]\.options\[0\]\.tradeoff must be a non-empty string/);
	files["/p/array.json"] = "[]";
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "import", path: "/p/array.json" }] }, env), /must be a JSON object/);
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "import", path: "/p/missing.json" }] }, env), /^import \/p\/missing\.json: cannot read it \(ENOENT/);
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "import", path: "/plans/plan.json", title: "both" }] }, env), /ops\[0\] \(import\): unknown field "title" \(allowed: op, path\)/);
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "create", title: "t", summary: "s" }, { op: "import", path: "/plans/plan.json" }] }, env), /create or import must be the first op, once per call/);
	// A parse error says where, never what: no quote of the file's first bytes.
	files["/p/secret.txt"] = "SECRET_TOKEN=abc123";
	assert.throws(
		() => applyAlignCall([], { ops: [{ op: "import", path: "/p/secret.txt" }] }, env),
		(error: Error) => /^import \/p\/secret\.txt: not valid JSON/.test(error.message) && !/SECRET|abc123/.test(error.message),
	);
});

test("hints: the names models reached for in the eval point at the op or field meant", () => {
	const { docs } = run([{ ops: [CREATE] }]);
	const hint = (call: unknown, message: RegExp, start = docs) => throwsAlign(() => applyAlignCall(start, call, env), message);
	// Fields borrowed from pi's edit, the older shape, or a sibling op.
	hint({ ops: [{ op: "edit", id: "a1", newText: "x" }] }, /ops\[0\] \(edit\): unknown field "newText" \(did you mean "text"\?\)/);
	hint({ ops: [{ op: "edit", id: "a1", replacement: "x" }] }, /unknown field "replacement" \(did you mean "text"\?\)/);
	hint({ ops: [{ op: "import", file: "/plans/plan.json" }] }, /ops\[0\] \(import\): unknown field "file" \(did you mean "path"\?\)/, []);
	hint({ ops: [{ op: "drop_question", q: "q1", why: "later" }] }, /\(drop_question\): unknown field "why" \(did you mean "reason"\?\)/);
	hint({ ops: [{ op: "drop_alignment", why: "later" }] }, /\(drop_alignment\): unknown field "why" \(did you mean "reason"\?\)/);
	hint({ ops: [{ op: "exempt", why: "trivial" }] }, /\(exempt\): unknown field "why" \(did you mean "reason"\?\)/, []);
	hint({ ops: [{ op: "edit_rejected", id: "x1", reason: "slow" }] }, /\(edit_rejected\): unknown field "reason" \(did you mean "why"\?\)/);
	hint({ ops: [{ op: "accept", q: ["q1"] }] }, /\(accept\): unknown field "q" \(did you mean "qs"\?\)/);
	hint({ ops: [{ op: "edit_question", id: "q1", ask: "x" }] }, /\(edit_question\): unknown field "id" \(did you mean "q"\?\)/);
	hint({ ops: [{ op: "status", status: "implementing" }] }, /\(status\): unknown field "status" \(did you mean "to"\?\)/);
	// Op names.
	hint({ ops: [{ op: "delete", ids: ["f1"] }] }, /ops\[0\]\.op "delete" is not an op: use \{op: "remove", ids: \[\.\.\.\]\}/);
	hint({ ops: [{ op: "add_question", questions: [Q("x")] }] }, /ops\[0\]\.op "add_question" is not an op: use \{op: "add", questions: \[\.\.\.\]\}/);
	hint({ ops: [{ op: "drop", q: "q1", why: "x" }] }, /ops\[0\]\.op "drop" is not an op: use drop_question \{q, reason\} for one question, or drop_alignment \{reason\}/);
	// The older shapes of ops that kept their name.
	hint({ ops: [{ op: "create", fromFile: "/plans/plan.json" }] }, /ops\[0\] \(create\): a file is imported with \{op: "import", path: "\/absolute\/path\.json"\}/, []);
	hint({ ops: [{ op: "accept", q: "open" }] }, /ops\[0\] \(accept\): every open question is accepted with \{op: "accept_all"\}/);
	hint({ ops: [{ op: "edit", id: "q2", ask: "x" }] }, /ops\[0\] \(edit\): a question is changed with \{op: "edit_question", q: "q2"/);
	hint({ ops: [{ op: "edit", id: "x1", why: "x" }] }, /ops\[0\] \(edit\): a rejected alternative is changed with \{op: "edit_rejected", id: "x1"/);
	hint({ ops: [{ op: "edit", title: "x" }] }, /ops\[0\] \(edit\): the title and summary are changed with \{op: "edit_doc"/);
	// No wrapper.
	hint({ op: "decide", q: "q1", decision: "yes" }, /^wrap ops in \{ops: \[\.\.\.\]\}/);
	hint([{ op: "decide", q: "q1", decision: "yes" }], /^wrap ops in \{ops: \[\.\.\.\]\}/);
	// Required fields are named when missing.
	hint({ ops: [{ op: "edit", id: "a1" }] }, /ops\[0\] \(edit\): text is required/);
	hint({ ops: [{ op: "drop_question", q: "q1" }] }, /ops\[0\] \(drop_question\): reason is required/);
	hint({ ops: [{ op: "accept", qs: "q1" }] }, /ops\[0\] \(accept\): qs must be an array/);
	hint({ ops: [{ op: "decide", q: ["q1"], decision: "x" }] }, /ops\[0\] \(decide\): q must be one question id like "q3"/);
});

test("\"1 yes, 2 your rec\": decide one, accept the other, the third stays open and blocks implementing", () => {
	const { docs, last } = run([{ ops: [CREATE] }, { ops: [{ op: "decide", q: "q1", decision: "yes" }, { op: "accept", qs: ["q2"] }] }]);
	assert.equal(last.details.line, "q1 decided · q2 accepted");
	assert.deepEqual(docs[0]!.questions.map((q) => q.decision?.by ?? "open"), ["user", "accepted-recommendation", "open"]);
	throwsAlign(() => applyAlignCall(docs, { ops: [{ op: "status", to: "implementing" }] }, env), /still has 1 open question \(q3\): only once the user has answered it/);
	// "go": a plain go-ahead takes the recommendation for what is left.
	const going = run([{ ops: [{ op: "accept_all" }, { op: "status", to: "implementing" }] }], docs).last.details;
	assert.equal(going.line, "q3 accepted · → implementing");
});

test("ALIGN_OP_FIELDS is what applyAlignCall enforces: each op's minimal call applies, and each required field is required", () => {
	const minimal: Record<AlignOpName, Record<string, unknown>> = {
		create: { title: "t", summary: "s" },
		import: { path: "/plans/plan.json" },
		add: { findings: ["x"] },
		edit: { id: "a1", text: "x" },
		edit_question: { q: "q1", ask: "x" },
		edit_rejected: { id: "x1", why: "x" },
		edit_doc: { title: "x" },
		remove: { ids: ["f1"] },
		decide: { q: "q1", decision: "x" },
		accept: { qs: ["q1"] },
		accept_all: {},
		reopen: { q: "q1" },
		drop_question: { q: "q1", reason: "x" },
		drop_alignment: { reason: "x" },
		status: { to: "done" },
		exempt: { reason: "x" },
		get: {},
	};
	assert.deepEqual(Object.keys(minimal).sort(), [...ALIGN_OPS].sort());
	files["/plans/plan.json"] = JSON.stringify({ title: "t", summary: "s" });
	// A start where each op applies: q1 decided (reopen), q2 open, everything else open.
	const start = run([{ ops: [CREATE] }, { ops: [{ op: "decide", q: "q1", decision: "yes" }] }]).docs;
	const startFor = (op: AlignOpName) => (op === "reopen" ? start : op === "status" ? run([{ ops: [{ op: "accept_all" }] }], start).docs : op === "decide" || op === "accept" || op === "edit_question" || op === "drop_question" ? run([{ ops: [{ op: "reopen", q: "q1" }] }], start).docs : start);
	for (const op of ALIGN_OPS) {
		const docs = op === "create" || op === "import" || op === "exempt" ? [] : startFor(op);
		applyAlignCall(docs, { ops: [{ op, ...minimal[op] }] }, env);
		const { required, optional } = ALIGN_OP_FIELDS[op];
		assert.deepEqual([...required, ...optional].filter((k) => !(k in minimal[op]) && required.includes(k)), [], `${op}: the minimal call has every required field`);
		for (const key of required) {
			const { [key]: _gone, ...rest } = minimal[op];
			throwsAlign(() => applyAlignCall(docs, { ops: [{ op, ...rest }] }, env), new RegExp(`\\(${op}\\): ${key} is required`));
		}
	}
});

test("readAlignFile: regular files up to the cap, relative to the cwd or absolute; never a pipe, a device or a remote session's path", () => {
	const dir = mkdtempSync(join(tmpdir(), "align-file-"));
	try {
		writeFileSync(join(dir, "plan.json"), "{}");
		assert.equal(readAlignFile(dir, "plan.json"), "{}", "relative to the cwd");
		assert.equal(readAlignFile("/nowhere", join(dir, "plan.json")), "{}", "an absolute path as is");
		writeFileSync(join(dir, "big.json"), "x".repeat(ALIGN_FILE_MAX_BYTES + 1));
		assert.throws(() => readAlignFile(dir, "big.json"), /is too large for an alignment \(the limit is 256 KB\)/);
		writeFileSync(join(dir, "edge.json"), "x".repeat(ALIGN_FILE_MAX_BYTES));
		assert.equal(readAlignFile(dir, "edge.json").length, ALIGN_FILE_MAX_BYTES, "exactly the cap is fine");
		assert.throws(() => readAlignFile(dir, "/dev/zero"), /not a regular file/, "a device never grows memory");
		assert.throws(() => readAlignFile(dir, "."), /not a regular file|EISDIR/);
		// A FIFO with no writer: opened non-blocking and refused at once, never hanging the process.
		if (spawnSync("mkfifo", [join(dir, "pipe")]).status === 0) assert.throws(() => readAlignFile(dir, "pipe"), /not a regular file/);
		assert.throws(() => readAlignFile(dir, "missing.json"), /ENOENT/);
		// A remote session's tools run on its target: the local disk is the wrong machine.
		assert.throws(() => readAlignFile(dir, "plan.json", "box"), /target "box", and import reads this machine's disk; use create instead/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
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
	throwsAlign(() => applyAlignCall(docs, { ops: [{ op: "remove", ids: ["q1"] }] }, env), /q1 can't be removed .*a question takes drop_question/);
	throwsAlign(() => applyAlignCall(docs, { ops: [{ op: "remove", ids: ["f2"] }] }, env), /al_1 has no f2/);
});

test("edit, edit_question, edit_rejected, edit_doc: each target takes its own fields", () => {
	const { docs, last } = run([
		{ ops: [CREATE] },
		{
			ops: [
				{ op: "edit_question", q: "q2", ask: "Which format?", context: "Readers vary.", recommendation: { choice: "markdown", why: "humans read it" } },
				{ op: "edit_question", q: "q1", context: "" },
				{ op: "edit", id: "a1", text: "Add GET /api/export." },
				{ op: "edit_rejected", id: "x1", why: "4 MB in the browser" },
				{ op: "edit_doc", title: "Export a session" },
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
	throwsAlign(() => applyAlignCall(docs, { ops: [{ op: "edit", id: "f1", topic: "x" }] }, env), /ops\[0\] \(edit\): unknown field "topic" \(allowed: op, id, text\)/);
	throwsAlign(() => applyAlignCall(docs, { ops: [{ op: "edit_question", q: "q9", ask: "x" }] }, env), /al_1 has no question q9/);
	throwsAlign(() => applyAlignCall(docs, { ops: [{ op: "edit_question", q: "q1" }] }, env), /give at least one of topic, ask, context, options, recommendation/);
	throwsAlign(() => applyAlignCall(docs, { ops: [{ op: "edit", id: "a9", text: "x" }] }, env), /al_1 has no a9/);
	throwsAlign(() => applyAlignCall(docs, { ops: [{ op: "edit_doc", ask: "x" }] }, env), /ops\[0\] \(edit_doc\): unknown field "ask"/);
});

test("answers: decide records the user's words, accept takes the recommendation, reopen and drop; status follows the data", () => {
	const { docs } = run([{ ops: [CREATE] }, { ops: [{ op: "decide", q: "q1", decision: "collapsed, like the web" }, { op: "accept", qs: ["q2"] }] }]);
	const doc = docs[0]!;
	assert.deepEqual(doc.questions[0]!.decision, { text: "collapsed, like the web", by: "user", at: NOW });
	assert.deepEqual(doc.questions[1]!.decision, { text: "plain JSONL", by: "accepted-recommendation", at: NOW });
	assert.equal(openText(doc), "1 of 3 open");
	assert.equal(alignStatus(doc), "aligning");
	// accept never replaces what the user said, and one id named twice is refused, not doubled.
	throwsAlign(() => applyAlignCall(docs, { ops: [{ op: "accept", qs: ["q1"] }] }, env), /q1 is already decided \("collapsed, like the web"\); reopen it first/);
	throwsAlign(() => applyAlignCall(docs, { ops: [{ op: "accept", qs: ["q3", "q3"] }] }, env), /q3 is named twice/);
	assert.deepEqual(run([{ ops: [{ op: "accept_all" }] }], docs).docs[0]!.questions[0]!.decision?.by, "user", "accept_all leaves decided questions alone");

	const dropped = run([{ ops: [{ op: "drop_question", q: "q3", reason: "out of scope" }] }], docs).docs[0]!;
	assert.equal(alignStatus(dropped), "confirmed", "every live question decided: confirmed, with no explicit op");
	assert.equal(openText(dropped), "all 2 decided");
	throwsAlign(() => applyAlignCall([dropped], { ops: [{ op: "decide", q: "q3", decision: "x" }] }, env), /q3 is dropped; reopen it first/);

	const reopened = run([{ ops: [{ op: "reopen", q: "q1" }] }], [dropped]).docs[0]!;
	assert.equal(reopened.questions[0]!.decision, undefined);
	assert.equal(alignStatus(reopened), "aligning");
	throwsAlign(() => applyAlignCall([reopened], { ops: [{ op: "reopen", q: "q1" }] }, env), /q1 is already open/);
});

test("lifecycle: implementing and done need no open questions; accept_all + status in one call is the 'your recs' path", () => {
	const { docs } = run([{ ops: [CREATE] }]);
	throwsAlign(() => applyAlignCall(docs, { ops: [{ op: "status", to: "implementing" }] }, env), /still has 3 open questions \(q1, q2, q3\)/);
	const { docs: going, last } = run([{ ops: [{ op: "accept_all" }, { op: "status", to: "implementing" }] }], docs);
	assert.equal(alignStatus(going[0]!), "implementing");
	assert.equal(last.details.line, "q1, q2, q3 accepted · → implementing");
	throwsAlign(() => applyAlignCall(going, { ops: [{ op: "accept_all" }] }, env), /no open questions to accept/);
	const done = run([{ ops: [{ op: "status", to: "done" }] }], going).docs[0]!;
	assert.equal(alignStatus(done), "done");
	// A finished document takes nothing but a move back to open.
	throwsAlign(() => applyAlignCall([done], { doc: "al_1", ops: [{ op: "add", findings: ["late"] }] }, env), /al_1 is done; move it back/);
	const back = run([{ doc: "al_1", ops: [{ op: "status", to: "open" }, { op: "add", findings: ["late"] }] }], [done]).docs[0]!;
	assert.equal(alignStatus(back), "confirmed");
	const gone = run([{ ops: [{ op: "drop_alignment", reason: "user changed course" }] }], [back]).docs[0]!;
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
	throwsAlign(() => applyAlignCall(docs, { ops: [{ op: "accept_all" }] }, env), /doc is required while several are open \(al_1 "Session export", al_2 "Second concern"\)/);
	throwsAlign(() => applyAlignCall(docs, { doc: "al_9", ops: [{ op: "get" }] }, env), /No alignment al_9 on this branch/);
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "add", findings: ["x"] }] }, env), /No open alignment to change: create one first/);
	const { last } = run([{ doc: "al_1", ops: [{ op: "decide", q: "q1", decision: "full" }] }], docs);
	assert.equal(last.details.doc!.id, "al_1");
	assert.equal(last.details.doc!.rev, 2);
	assert.match(last.text, /^Other open alignments: al_2 "Second concern" aligning \(3 open\)$/m);
});

test("exempt stands alone and touches nothing; get reads without a snapshot", () => {
	const ex = applyAlignCall([], { ops: [{ op: "exempt", reason: "a question about the code, no change" }] }, env);
	assert.deepEqual(ex.details, { v: 1, changes: [], line: "", exempt: { why: "a question about the code, no change" } });
	assert.match(ex.text, /^Recorded: no alignment needed — a question about the code, no change\.$/m);
	const dotted = applyAlignCall([], { ops: [{ op: "exempt", reason: "Just a command run." }] }, env);
	assert.match(dotted.text, /— Just a command run\.$/m, "a reason that ends a sentence gets no second period");
	throwsAlign(() => applyAlignCall([], { ops: [{ op: "exempt", reason: "x" }, { op: "get" }] }, env), /exempt stands alone/);
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
	const a2 = run([{ doc: "al_1", ops: [{ op: "accept_all" }] }], [a.doc!, b.doc!]).last.details;
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

test("fold: a session written with the old op names (create + fromFile, accept \"open\", drop, edit of a question, exempt {why}) folds from its results, never its args", () => {
	// Written by align.ts as of 9eb0af2, before the op rename; the args are the old shapes.
	const entries = readFileSync(new URL("./tests/align-old-ops.jsonl", import.meta.url), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const args = entries.filter((e) => e.message.role === "assistant").flatMap((e) => e.message.content[0].arguments.ops.map((o: { op: string }) => o.op));
	assert.ok(args.includes("drop") && entries.some((e) => e.message.content[0]?.arguments?.ops?.[0]?.fromFile), "the fixture really is the old format");
	const { docs } = foldAlignments(entries);
	assert.deepEqual(docs.map((d) => [d.id, d.title, alignStatus(d), d.rev]), [["al_1", "Old import", "implementing", 3], ["al_2", "Old second", "dropped", 2]]);
	const [imported, dropped] = docs;
	assert.deepEqual(imported!.questions.map((q) => [q.id, q.decision?.by ?? (q.dropped ? `dropped: ${q.dropped.why}` : "open")]), [
		["q1", "accepted-recommendation"],
		["q2", "dropped: out of scope"],
		["q3", "accepted-recommendation"],
	]);
	assert.equal(imported!.questions[2]!.ask, "Call it export or dump?");
	assert.equal(dropped!.droppedWhy, "user changed course");
	// New ops continue from the old state.
	const done = applyAlignCall(docs, { doc: "al_1", ops: [{ op: "status", to: "done" }] }, env).details.doc!;
	assert.equal(done.rev, 4);
	assert.equal(alignStatus(done), "done");
});

test("details round-trip through JSON and normalizeAlignDetails; the stored shape is checked field by field", () => {
	const { last } = run([{ ops: [CREATE] }, { ops: [{ op: "decide", q: "q1", decision: "full" }, { op: "drop_question", q: "q3", reason: "later" }] }]);
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
		// The invariants ids depend on: unique per kind, never past the counter, dropped iff why.
		{ ...stored, doc: { ...stored.doc, questions: [stored.doc!.questions[0], { ...stored.doc!.questions[1], id: "q1" }, stored.doc!.questions[2]] } },
		{ ...stored, doc: { ...stored.doc, next: { ...stored.doc!.next, q: 2 } } },
		{ ...stored, doc: { ...stored.doc, findings: [{ id: "f0", text: "zero" }] } },
		{ ...stored, doc: { ...stored.doc, findings: [{ id: "fx1", text: "not an id" }] } },
		{ ...stored, doc: { ...stored.doc, phase: "dropped" } },
		{ ...stored, doc: { ...stored.doc, droppedWhy: "why, while open" } },
	]) {
		assert.equal(normalizeAlignDetails(bad), undefined, JSON.stringify(bad).slice(0, 80));
	}
	// A stored snapshot whose ids ran past its counter would make the next add reuse one.
	const dropped = run([{ ops: [{ op: "drop_alignment", reason: "moved on" }] }], [last.details.doc!]).last.details;
	assert.deepEqual(normalizeAlignDetails(JSON.parse(JSON.stringify(dropped))), dropped, "a dropped document with its why is valid");
});

test("counts, the hidden note and the widget cover open documents only", () => {
	const { docs } = run([
		{ ops: [CREATE] },
		{ ops: [{ ...CREATE, title: "Second", questions: [Q("Only")] }] },
		{ doc: "al_2", ops: [{ op: "accept_all" }, { op: "status", to: "done" }] },
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
	// A user prompt's note lists only what is open; the one after a compaction adds what was decided.
	assert.doesNotMatch(note, /q1 One/, "a decided question is not in a prompt's note");
	const compacted = alignStateNote(docs, true)!;
	assert.match(compacted, /^\[align\] The context was just compacted/);
	assert.match(compacted, /recommendations are not decisions/);
	assert.match(compacted, /^al_3 "Third" · aligning · 1 of 2 open\n {2}q1 One: decided — no\n {2}q2 Two: Two\? \(rec: /m);
	assert.doesNotMatch(compacted, /al_2/, "a finished alignment is not in it either");
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
	for (const needle of ["## al_1: Session export", "_Let the user download a session as a file._", "### Questions", "**q1 · Tool output** (decided)", "a. **Collapsed** — smaller", "b. **Full** — complete", "Recommended: **yes** — because Tool output", "Decided: full (user)", "### Findings", "- f1: The exporter", "### Approach", "1. a1: Add a route.", "### Rejected", "- x1: Client-side export — too slow"]) {
		assert.ok(md.includes(needle), needle);
	}
});

test("options are lettered; a recommendation naming one reads by letter and label", () => {
	const opts = [{ label: "CSV", tradeoff: "readable" }, { label: "CSV + gzip", tradeoff: "smaller" }, { label: "**Parquet**", tradeoff: "compact" }];
	const q = (choice: string, options: typeof opts | undefined = opts) => ({ options, recommendation: { choice, why: "w" } });
	assert.deepEqual([0, 1, 25, 26].map(optionLetter), ["a", "b", "z", "27"]);
	assert.equal(recommendedOption(q(" csv ")), 0, "trimmed, case-insensitive");
	assert.equal(recommendedOption(q("CSV + gzip")), 1, "the exact label beats a shorter prefix");
	assert.equal(recommendedOption(q("CSV + gzip, since it is smaller")), 1, "the longest label the choice starts with");
	assert.equal(recommendedOption(q("CSV — it reads anywhere")), 0);
	assert.equal(recommendedOption(q("parquet")), 2, "bold markers on the label are ignored");
	assert.equal(recommendedOption(q("**Parquet**")), 2, "and on the choice");
	assert.equal(recommendedOption(q("CSVs")), undefined, "a prefix must end at a word boundary");
	assert.equal(recommendedOption(q("Avro")), undefined);
	assert.equal(recommendedOption({ recommendation: { choice: "CSV", why: "w" } }), undefined, "no options, no letter");

	const { docs } = run([{ ops: [{ ...CREATE, questions: [{ topic: "Format", ask: "Which?", options: opts, recommendation: { choice: "csv + GZIP", why: "the warehouse reads it" } }, Q("Zip", "no")] }] }]);
	const [format, zip] = docs[0]!.questions;
	assert.equal(recommendedText(format!), "b — CSV + gzip", "the option's own label, not the choice's spelling");
	assert.equal(recommendedText(zip!), "no");
	const md = toMarkdown(docs[0]!);
	assert.ok(md.includes("a. **CSV** — readable\n\nb. **CSV + gzip** — smaller\n\nc. "), md);
	assert.ok(md.includes("Recommended: b — **CSV + gzip** — the warehouse reads it"), md);
	assert.ok(md.includes("Recommended: **no** — because Zip"), md);
	const note = alignStateNote(docs)!;
	assert.match(note, /^ {2}q1 Format: Which\? — a\. CSV · b\. CSV \+ gzip · c\. \*\*Parquet\*\* \(rec: b — CSV \+ gzip\)$/m);
	assert.match(note, /^ {2}q2 Zip: Zip\? \(rec: no\)$/m);
	const echo = applyAlignCall(docs, { ops: [{ op: "get" }] }, env).text;
	assert.match(echo, /^ {2}q1 Format — open \(rec: b — CSV \+ gzip\)$/m);
});

// The settle nudge's heuristic, calibrated offline against the two sessions the design report names
// (a delegate · align · spec session with 114 final replies, and the freeform-plan session). There
// it fired on every markdown alignment block, on the freeform plans ("…take my recommendations on
// 1–6?", "Should I go ahead with those answers?", "Which do you want: …?"), and on one of ~80 other
// replies; status reports, lane reports and merge questions stayed quiet. A live glm run then
// closed a prose plan on a statement after its "Questions for you:" list, which that rule missed;
// the labelled-list rule added for it changes nothing in those two sessions and adds 29 of ~3,200
// final replies across 222 others, nearly all prose plans asking for decisions (the rest: lists of
// merge or follow-up questions, which the nudge text sends to exempt). The shapes below are written
// for this test, after those replies.
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

	// A labelled list of questions counts wherever it sits: a reply may close on a statement.
	const closesOnStatement = [
		"Sketch for weekly goals:",
		"- Count completions per week",
		"- Show progress per habit",
		"",
		"Questions for you:",
		"",
		"1. **Week start** — Monday or Sunday?",
		"2. **Data shape** — a separate section, or a field on each habit?",
		"",
		"Once the tool runner is stable I'll record this as an alignment.",
	].join("\n");
	assert.equal(planSignal(closesOnStatement), "question-list");
	assert.equal(planSignal(closesOnStatement.replace("2. **Data shape** — a separate section, or a field on each habit?", "2. **Data shape** — a separate section.")), null, "one question under the label is not a list of them");
	assert.equal(planSignal(closesOnStatement.replace("Questions for you:", "Things I checked:")), null, "questions without a label that hands them to the user");
	assert.equal(planSignal("**Open questions:**\n1. Zip or tar?\n\nMore context here.\n\n2. Cap at 400?\n\nDone."), null, "a paragraph between ends the list");

	assert.equal(planSignal("Lane E is finished. It found 2 bugs:\n- the guard\n- the restart\n\nLanes B, C and D are still running."), null);
	assert.equal(planSignal("The fix is on `feat/x`, 3 commits, tests pass.\n\nWant me to merge it?"), null);
	assert.equal(planSignal("Merged. The open questions from before are recorded in al_2.\n\nAnything else?"), null, "decision words above, but no list and no asking end");
	assert.equal(planSignal("```\nShould I go ahead?\n```\nDone."), null, "code fences are ignored");

	// False positives from the review, pinned: none of these asks the user to decide a design.
	assert.equal(planSignal("Fixed it.\n\n**Alignment card**: the chip now shows counts.\n\nAll tests pass."), null, "a bold line that mentions alignment");
	assert.equal(planSignal("## Alignment fixes shipped\n\n- a\n- b\n\nDone."), null, "a heading that mentions alignment, with no colon and title");
	assert.equal(planSignal("## Alignment: Export\n\nx"), "markdown-alignment", "the old anchor itself still counts");
	assert.equal(planSignal("Tests pass.\n\n- a\n- b\n\nShould I proceed with the merge?"), null, "a merge confirmation");
	assert.equal(planSignal("Built on `feat/x`.\n\nShould I go ahead and push it?"), null, "a push confirmation");
	assert.equal(planSignal("I looked at the open questions in the issue tracker:\n- q1\n- q2\n\nAnything else you need?"), null, "decision words and a list, closed by an ordinary question");
	assert.equal(planSignal("Partly true.\n\n- the guard\n- the restart\n\nNeither is covered by the open questions. Should I steer the worker to check it?"), null, "a steer question after a list");
	const options = "The two options are:\n- A: a flag\n- B: a subcommand\n\nWhich do you prefer?";
	assert.equal(planSignal(options, { userAsked: true }), null, "options answering the user's own question");
	assert.equal(planSignal(options), "asks-decision", "the same choice, when the user asked for work, is a decision");
	assert.equal(planSignal("**Decisions for you:**\n1. Should I merge `feat/x`?\n2. Should I restart the server?\n\nFull report in the cache."), null, "a list of run confirmations");
	assert.equal(planSignal("Questions for you:\n1. Merge now?\n2. Keep UTC or local dates?\n3. Streaks too?\n\nI'll wait."), "question-list", "run confirmations don't count, design questions do");
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
