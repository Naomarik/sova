import assert from "node:assert/strict";
import test from "node:test";
import { ALIGN_INSTRUCTIONS } from "./minor.ts";
import {
	ALIGN_ENTRY_TYPE,
	clampScroll,
	deriveStatus,
	looksLikeAlignBlock,
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

const BOLD_NO_ANCHOR = `The Opus investigation came back. Report above has full details; here's the alignment summary:

**Findings**
- The hard part is already done by in-flight uncommitted work: session ids are plumbed.
- What's missing is purely Sova server side: resolve the file and tail it.
- CC's JSONL is tailable line by line.

**Approach** (recommended option a, ~1–1.5 days incl. tests)
1. resolveClaudeSession(uuid) in server/paths.ts maps a uuid to a transcript path.
2. New server/claude-transcript.ts tails the file.
3. Wire the watcher into the existing worker registry.
- No pi-config/ changes, no new deps. Everything stays server side.

**Open questions**
- The session-id plumbing is *uncommitted* — land that commit first or fold it in?
- CC's own nested subagents deferred — fine for v1?

**Rejected**
- (b) Extension publishing sessionFile — couples the extension to CC's layout.
- (c) Exposing the runner's in-memory transcript — duplicates what the file already has.

**Status: aligning** — want me to proceed with option (a) as specced?`;

test("bold pseudo-headings without an anchor parse as an anchorless block", () => {
	const parsed = parseAlignBlock(BOLD_NO_ANCHOR);
	assert.ok(parsed, "the transcript's bold block must parse");
	assert.equal(parsed.title, "");
	assert.equal(parsed.explicitStatus, "aligning");
	assert.deepEqual(parsed.questions, [
		{ n: 1, text: "The session-id plumbing is *uncommitted* — land that commit first or fold it in?", checked: false },
		{ n: 2, text: "CC's own nested subagents deferred — fine for v1?", checked: false },
	]);
	assert.ok(parsed.markdown.startsWith("**Findings**\n- The hard part"), "block starts at the first section heading");
	assert.ok(parsed.markdown.endsWith("as specced?"));
	assert.ok(!parsed.markdown.includes("The Opus investigation"), "prose before the block is excluded");
	for (const section of ["**Approach**", "**Rejected**", "**Status: aligning**"]) assert.ok(parsed.markdown.includes(section));
	assert.equal(sameBlock(nextDoc(null, parsed, "2026-09-20T00:00:00.000Z"), parsed.markdown), true, "re-emit dedupes");
});

test("bold anchor and bold sections parse like their markdown forms", () => {
	const bold = parseAlignBlock("intro\n\n**Alignment: Bold thing**\n**Findings**\nf\n**Open questions**\n1. [x] a\n2. [ ] b\n**Status**\nconfirmed\n\nTrailing prose");
	assert.ok(bold);
	assert.equal(bold.title, "Bold thing");
	assert.equal(bold.explicitStatus, "confirmed");
	assert.equal(bold.questions.length, 2);
	assert.ok(bold.markdown.startsWith("**Alignment: Bold thing**\n**Findings**"));
	assert.ok(bold.markdown.endsWith("Trailing prose"));
	assert.equal(parseAlignBlock("**Alignment — dashed**")?.title, "dashed");
	assert.equal(parseAlignBlock("**Alignment**\n**Open questions**\n- q")?.questions.length, 1);
	assert.equal(parseAlignBlock("**Alignments are hard**\n**Findings**"), undefined);
});

test("mixed markdown and bold headings within one block", () => {
	const mixed = parseAlignBlock("## Alignment: Mixed\n**Findings**\nf\n### Approach\na\n**Open questions**\n1. [ ] q1\n### Rejected\n- r\n**Status: implementing** — starting now\n## Next steps\n1. [ ] not a question");
	assert.ok(mixed);
	assert.equal(mixed.title, "Mixed");
	assert.equal(mixed.explicitStatus, "implementing");
	assert.deepEqual(mixed.questions, [{ n: 1, text: "q1", checked: false }]);
	assert.ok(mixed.markdown.endsWith("— starting now"), "a same-level markdown heading still ends the block");
	// A bold anchor with ## sections: known sections continue the block, unknown ones end it.
	const boldAnchor = parseAlignBlock("**Alignment: b**\n## Findings\nf\n## Open questions\n- q\n## Status\naligning\n## Wrap-up\nbye");
	assert.equal(boldAnchor?.questions.length, 1);
	assert.equal(boldAnchor?.explicitStatus, "aligning");
	assert.ok(boldAnchor?.markdown.endsWith("## Status\naligning"));
});

test("bold status heading with its value inline and trailing prose", () => {
	assert.equal(parseAlignBlock("## Alignment: s\n**Status: aligning** — want me to proceed?")?.explicitStatus, "aligning");
	assert.equal(parseAlignBlock("## Alignment: s\n**Status** confirmed, go")?.explicitStatus, "confirmed");
	assert.equal(parseAlignBlock("## Alignment: s\n**Status**\n\nimplementing")?.explicitStatus, "implementing");
	assert.equal(parseAlignBlock("## Alignment: s\n**Status: unknown** — hmm\nconfirmed")?.explicitStatus, undefined, "first inline value wins even when unknown");
});

test("prose that mentions section words is not a block; two headings are not enough", () => {
	const prose = "Our approach here is simple. The status of the findings is that open questions remain; rejected ideas are listed below.\n- approach: x\n- status: y";
	assert.equal(parseAlignBlock(prose), undefined);
	assert.equal(looksLikeAlignBlock(prose), false);
	const boldInline = "**Note:** the approach is fine.\n**Findings** below.\n**Status**: fine.\nThe **Approach** we took.";
	assert.equal(parseAlignBlock(boldInline), undefined, "only two bold section headings");
	assert.equal(parseAlignBlock("**Findings**\nf\n**Approach**\na"), undefined);
	assert.equal(parseAlignBlock("### Findings\nf\n### Status\naligning"), undefined);
	assert.equal(parseAlignBlock("**Findings**\nf\n**Questions**\n- q\n**Open questions**\n- q2"), undefined, "distinct sections, not distinct spellings");
	assert.equal(parseAlignBlock("```\n**Findings**\n**Approach**\n**Status**\n```"), undefined, "fenced headings are skipped");
	assert.equal(parseAlignBlock("**Approach to caching** is fine\n**Findings**\nf\n**Status**\nok"), undefined, "bold must be the bare section name");
});

test("anchorless markdown sections parse too; a same-level unknown heading ends the block", () => {
	const parsed = parseAlignBlock("Intro\n### Findings\nf\n### Approach\na\n### Open questions\n1. [ ] q\n### Status\naligning\n### Next steps\n1. [ ] no");
	assert.ok(parsed);
	assert.equal(parsed.title, "");
	assert.equal(parsed.questions.length, 1);
	assert.equal(parsed.explicitStatus, "aligning");
	assert.equal(parsed.markdown, "### Findings\nf\n### Approach\na\n### Open questions\n1. [ ] q\n### Status\naligning");
});

test("looksLikeAlignBlock: heading-shaped section names in any decoration, three distinct, outside fences", () => {
	assert.equal(looksLikeAlignBlock(BOLD_NO_ANCHOR), true);
	assert.equal(looksLikeAlignBlock(FULL), true);
	assert.equal(looksLikeAlignBlock("Findings:\nf\nApproach:\na\nStatus: aligning"), true, "bare labels count");
	assert.equal(looksLikeAlignBlock("*Findings*\nf\n__Approach__\na\n_Rejected_\nr"), true);
	assert.equal(looksLikeAlignBlock("Findings:\nf\nApproach:\na"), false, "two is not enough");
	assert.equal(looksLikeAlignBlock("```\nFindings:\nApproach:\nStatus:\n```"), false);
	assert.equal(looksLikeAlignBlock("The findings: fine. Approach: fine. Status: fine."), false);
	assert.equal(looksLikeAlignBlock("Just a plain answer with no sections.\n1. do x\n2. do y"), false);
	for (const input of [undefined, null, 42, {}, []] as unknown[]) assert.equal(looksLikeAlignBlock(input as string), false);
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

// The instruction block is a second implementation of the shape align.ts parses: parse its own template.
test("the align instructions' template numbers questions where the viewer keeps them", () => {
	const parsed = parseAlignBlock(ALIGN_INSTRUCTIONS);
	assert.ok(parsed, "the instruction template parses as an alignment block");
	assert.ok(parsed.questions.length >= 2, "the template shows more than one question");
	for (const [index, question] of parsed.questions.entries()) {
		// The number the user sees is part of the question text, so it survives checklist rendering.
		assert.ok(question.text.startsWith(`**${index + 1}. `), `question ${index + 1} is labelled in its text: ${question.text}`);
		assert.equal(question.n, index + 1);
	}
});
