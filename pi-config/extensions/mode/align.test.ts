import assert from "node:assert/strict";
import test from "node:test";
import {
	ALIGN_ENTRY_TYPE,
	clampScroll,
	deriveStatus,
	nextDoc,
	normalizeAlignEntry,
	parseAlignBlock,
	restoreAlignDoc,
	sameBlock,
	statusLabelText,
	summarize,
	viewport,
	widgetLine,
	type AlignDoc,
	type AlignEntryData,
} from "./align.ts";

const FULL = `Here is what I found.

## Alignment: Session export
### Findings
The exporter lives in server/export.ts.
### Approach
1. Add a route.
2. Stream the JSONL.
### Open questions
1. [x] Include tool output? — yes, collapsed
2. [ ] Zip or plain file?
   Leaning plain.
3. [ ] Which formats?
   - markdown
   - json
### Rejected
- Client-side export — too slow for big sessions.
### Status
aligning

Anything else, let me know.`;

function doc(overrides: Partial<AlignDoc> = {}): AlignDoc {
	return { version: 1, title: "t", markdown: "## Alignment: t", questions: [], revision: 1, capturedAt: "2026-09-20T00:00:00.000Z", ...overrides };
}

test("parseAlignBlock reads title, questions, status, and the block's markdown only", () => {
	const parsed = parseAlignBlock(FULL);
	assert.ok(parsed);
	assert.equal(parsed.version, 1);
	assert.equal(parsed.title, "Session export");
	assert.equal(parsed.explicitStatus, "aligning");
	assert.deepEqual(parsed.questions, [
		{ n: 1, text: "Include tool output? — yes, collapsed", checked: true },
		{ n: 2, text: "Zip or plain file? Leaning plain.", checked: false },
		{ n: 3, text: "Which formats? markdown json", checked: false },
	]);
	assert.ok(parsed.markdown.startsWith("## Alignment: Session export\n### Findings"));
	assert.ok(parsed.markdown.endsWith("### Status\naligning\n\nAnything else, let me know."));
	assert.ok(!parsed.markdown.includes("Here is what I found"));
});

test("parseAlignBlock ends the block at a heading of the anchor's level or higher", () => {
	const parsed = parseAlignBlock("## Alignment\n### Open questions\n1. [ ] a\n## Next steps\n1. [ ] not a question\n# Top");
	assert.ok(parsed);
	assert.equal(parsed.title, "");
	assert.equal(parsed.markdown, "## Alignment\n### Open questions\n1. [ ] a");
	assert.equal(parsed.questions.length, 1);
});

test("parseAlignBlock tolerates heading level, case, dash separators, and missing sections", () => {
	assert.equal(parseAlignBlock("# ALIGNMENT — Big thing")?.title, "Big thing");
	assert.equal(parseAlignBlock("#### alignment - small")?.title, "small");
	assert.equal(parseAlignBlock("### Alignment: x\nprose only")?.questions.length, 0);
	assert.equal(parseAlignBlock("##### Alignment: too deep"), undefined);
	assert.equal(parseAlignBlock("## Alignments are hard"), undefined);
	assert.equal(parseAlignBlock("## Misalignment"), undefined);
});

test("parseAlignBlock accepts an anchor with an empty body", () => {
	const parsed = parseAlignBlock("## Alignment: empty");
	assert.deepEqual(parsed, { version: 1, title: "empty", markdown: "## Alignment: empty", questions: [] });
});

test("parseAlignBlock ignores headings and anchors inside code fences", () => {
	const fenced = "```md\n## Alignment: example\n```\n## Alignment: real\n### Open questions\n```\n## not an end\n- [ ] not a question\n```\n1. [ ] real one";
	const parsed = parseAlignBlock(fenced);
	assert.ok(parsed);
	assert.equal(parsed.title, "real");
	assert.deepEqual(parsed.questions, [{ n: 1, text: "real one", checked: false }]);
	assert.ok(parsed.markdown.endsWith("1. [ ] real one"));
});

test("parseAlignBlock returns undefined without an anchor and never throws on garbage", () => {
	for (const input of ["", "no block here", "### Findings\n1. [ ] orphan", "\u0000\u0001￿##\n\n", "#".repeat(100_000), "x\n".repeat(50_000)]) {
		assert.equal(parseAlignBlock(input), undefined);
	}
	for (const input of [undefined, null, 42, {}, []] as unknown[]) {
		assert.equal(parseAlignBlock(input as string), undefined);
	}
	const huge = parseAlignBlock(`## Alignment\n### Open questions\n${"- [ ] q\n".repeat(20_000)}`);
	assert.equal(huge?.questions.length, 20_000);
});

test("parseAlignBlock handles truncated blocks", () => {
	const truncated = parseAlignBlock("## Alignment: cut\n### Open questions\n1. [x] first\n2. [ ] sec");
	assert.deepEqual(truncated?.questions, [
		{ n: 1, text: "first", checked: true },
		{ n: 2, text: "sec", checked: false },
	]);
	assert.equal(truncated?.explicitStatus, undefined);
	assert.equal(parseAlignBlock("## Alignment: cut\n### Open ques")?.questions.length, 0);
	assert.equal(parseAlignBlock("## Alignment: open fence\n```\n## still inside")?.markdown, "## Alignment: open fence\n```\n## still inside");
});

test("questions: bullets and boxless items, 1) numbering, positional numbers, X checks, prose ends an item", () => {
	const parsed = parseAlignBlock(
		"## Alignment\n### Questions\n- plain bullet\n* [X] star checked\n• [ ] dot\n4) paren\nSome prose between.\n  indented after prose",
	);
	assert.deepEqual(parsed?.questions, [
		{ n: 1, text: "plain bullet", checked: false },
		{ n: 2, text: "star checked", checked: true },
		{ n: 3, text: "dot", checked: false },
		{ n: 4, text: "paren", checked: false },
	]);
});

test("questions are read only from the Open questions section", () => {
	const parsed = parseAlignBlock("## Alignment\n### Approach\n1. [ ] step\n### Open questions\n- [ ] q\n### Custom notes\n- [ ] not a question");
	assert.deepEqual(parsed?.questions, [{ n: 1, text: "q", checked: false }]);
	assert.ok(parsed?.markdown.includes("### Custom notes"));
});

test("status: first non-empty line of the section, or inline on the heading; unknown words ignored", () => {
	assert.equal(parseAlignBlock("## Alignment\n### Status\n\nConfirmed by user")?.explicitStatus, "confirmed");
	assert.equal(parseAlignBlock("## Alignment\n### Status: implementing")?.explicitStatus, "implementing");
	assert.equal(parseAlignBlock("## Alignment\n### Status\npending\nconfirmed")?.explicitStatus, undefined);
	assert.equal(parseAlignBlock("## Alignment\n### Status\n")?.explicitStatus, undefined);
});

test("duplicate streamed text: the first block wins", () => {
	const block = "## Alignment: once\n### Open questions\n1. [ ] a";
	const parsed = parseAlignBlock(`${block}\n\n${block.replace("once", "twice")}`);
	assert.equal(parsed?.title, "once");
	assert.equal(parsed?.questions.length, 1);
});

test("CRLF input parses like LF", () => {
	const parsed = parseAlignBlock("## Alignment: w\r\n### Open questions\r\n1. [x] a\r\n");
	assert.equal(parsed?.markdown, "## Alignment: w\n### Open questions\n1. [x] a");
	assert.deepEqual(parsed?.questions, [{ n: 1, text: "a", checked: true }]);
});

test("deriveStatus precedence: implementing > confirmed > open > ready > aligning", () => {
	const open = { n: 1, text: "a", checked: false };
	const done = { n: 2, text: "b", checked: true };
	assert.equal(deriveStatus(doc({ explicitStatus: "implementing", questions: [open] })), "implementing");
	assert.equal(deriveStatus(doc({ explicitStatus: "confirmed", questions: [open] })), "confirmed");
	assert.equal(deriveStatus(doc({ explicitStatus: "aligning", questions: [open, done] })), "questions-open");
	assert.equal(deriveStatus(doc({ questions: [done] })), "ready");
	assert.equal(deriveStatus(doc({ explicitStatus: "aligning", questions: [done] })), "ready");
	assert.equal(deriveStatus(doc()), "aligning");
});

test("summarize and widgetLine format counts and omit settled when there are no questions", () => {
	const parsed = parseAlignBlock(FULL);
	assert.ok(parsed);
	const summary = summarize(nextDoc(null, parsed, "now"));
	assert.deepEqual(summary, {
		status: "questions-open",
		lines: parsed.markdown.split("\n").length,
		open: 2,
		settled: 1,
		total: 3,
		revision: 1,
		title: "Session export",
	});
	assert.equal(widgetLine(summary, "alt+a"), `◇ align · questions open · 1/3 settled · ${summary.lines} lines · alt+a view`);
	assert.equal(widgetLine(summarize(doc()), "alt+a"), "◇ align · aligning · 1 line · alt+a view");
	assert.equal(widgetLine(summarize(doc()), ""), "◇ align · aligning · 1 line");
	assert.deepEqual(
		(["aligning", "questions-open", "ready", "confirmed", "implementing"] as const).map(statusLabelText),
		["aligning", "questions open", "ready to confirm", "confirmed", "implementing"],
	);
});

test("accumulation across turns: nextDoc bumps the revision, sameBlock dedupes re-emits", () => {
	const first = parseAlignBlock("## Alignment: a\n### Open questions\n1. [ ] q");
	assert.ok(first);
	const v1 = nextDoc(null, first, "2026-09-20T00:00:00.000Z");
	assert.equal(v1.revision, 1);
	assert.equal(v1.capturedAt, "2026-09-20T00:00:00.000Z");
	assert.equal(sameBlock(null, first.markdown), false);
	assert.equal(sameBlock(v1, first.markdown), true);

	const second = parseAlignBlock("## Alignment: a\n### Open questions\n1. [x] q — yes\n### Status\nconfirmed");
	assert.ok(second);
	assert.equal(sameBlock(v1, second.markdown), false);
	const v2 = nextDoc(v1, second, "2026-09-20T00:01:00.000Z");
	assert.equal(v2.revision, 2);
	assert.equal(deriveStatus(v2), "confirmed");
	assert.equal(v1.questions[0].checked, false, "earlier revisions are not mutated");
	// The parsed object is not aliased into the doc.
	second.questions[0].text = "mutated";
	assert.equal(v2.questions[0].text, "q — yes");
});

test("entry payload round-trips through JSON and normalizeAlignEntry", () => {
	const parsed = parseAlignBlock(FULL);
	assert.ok(parsed);
	const data: AlignEntryData = { version: 1, doc: nextDoc(null, parsed, "2026-09-20T00:00:00.000Z") };
	assert.deepEqual(normalizeAlignEntry(JSON.parse(JSON.stringify(data))), data);
	assert.deepEqual(normalizeAlignEntry({ version: 1, doc: null }), { version: 1, doc: null });
	// Unknown keys are dropped, not rejected.
	assert.deepEqual(normalizeAlignEntry({ version: 1, extra: 1, doc: { ...data.doc, extra: true } }), data);
});

test("normalizeAlignEntry rejects bad shapes without throwing", () => {
	const good = doc({ questions: [{ n: 1, text: "a", checked: false }] });
	const bad: unknown[] = [
		undefined,
		null,
		"x",
		42,
		[],
		{},
		{ version: 2, doc: null },
		{ version: 1 },
		{ version: 1, doc: "str" },
		{ version: 1, doc: { ...good, version: 2 } },
		{ version: 1, doc: { ...good, title: 1 } },
		{ version: 1, doc: { ...good, markdown: null } },
		{ version: 1, doc: { ...good, revision: "1" } },
		{ version: 1, doc: { ...good, revision: Number.NaN } },
		{ version: 1, doc: { ...good, capturedAt: undefined } },
		{ version: 1, doc: { ...good, questions: {} } },
		{ version: 1, doc: { ...good, questions: [{ n: 1, text: "a", checked: "no" }] } },
		{ version: 1, doc: { ...good, questions: [null] } },
		{ version: 1, doc: { ...good, explicitStatus: "done" } },
	];
	for (const value of bad) assert.equal(normalizeAlignEntry(value), undefined, JSON.stringify(value));
	const hostile = {
		version: 1,
		get doc() {
			throw new Error("boom");
		},
	};
	assert.equal(normalizeAlignEntry(hostile), undefined);
});

test("restoreAlignDoc: newest valid align-doc entry wins, doc:null clears, malformed entries are skipped", () => {
	const older = doc({ revision: 1 });
	const newer = doc({ revision: 2 });
	const entry = (data: unknown) => ({ type: "custom", customType: ALIGN_ENTRY_TYPE, data });
	assert.equal(restoreAlignDoc([]), null);
	assert.deepEqual(restoreAlignDoc([entry({ version: 1, doc: older }), entry({ version: 1, doc: newer })]), newer);
	assert.deepEqual(
		restoreAlignDoc([
			entry({ version: 1, doc: older }),
			entry({ version: 1, doc: { broken: true } }),
			{ type: "custom", customType: "mode", data: { version: 1, doc: newer } },
			{ type: "message", data: { version: 1, doc: newer } },
		]),
		older,
	);
	assert.equal(restoreAlignDoc([entry({ version: 1, doc: older }), entry({ version: 1, doc: null })]), null);
	assert.deepEqual(restoreAlignDoc([entry({ version: 1, doc: null }), entry({ version: 1, doc: newer })]), newer);
	assert.equal(restoreAlignDoc(null as never), null);
	assert.equal(restoreAlignDoc([null, undefined] as never), null);
});

test("clampScroll/viewport keep the window inside the content", () => {
	assert.equal(clampScroll(-5, 100, 10), 0);
	assert.equal(clampScroll(5, 100, 10), 5);
	assert.equal(clampScroll(500, 100, 10), 90);
	assert.equal(clampScroll(3, 4, 10), 0);
	assert.equal(clampScroll(Number.NaN, 100, 10), 0);
	assert.equal(clampScroll(2.7, 100, 10), 2);
	const lines = Array.from({ length: 20 }, (_, i) => i);
	assert.deepEqual(viewport(lines, 0, 3), [0, 1, 2]);
	assert.deepEqual(viewport(lines, 99, 3), [17, 18, 19]);
	assert.deepEqual(viewport(lines, 5, 0), []);
	assert.deepEqual(viewport([], 5, 10), []);
	assert.deepEqual(viewport(lines.slice(0, 2), 1, 10), [0, 1]);
});
