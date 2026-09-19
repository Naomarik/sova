/**
 * Tests for accordion folding of code-heavy transcript items.
 *
 * Uses node:test + node:assert/strict only; no external dependencies.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FOLD_MAX_LINES, foldTranscriptItem as foldAt, summarizeFileChange, transcriptDisplayText as displayAt } from "./codefold.ts";
import type { TranscriptItem } from "./runner.ts";

const W = 78;
const foldTranscriptItem = (it: TranscriptItem) => foldAt(it, W);
const transcriptDisplayText = (it: TranscriptItem, expanded: boolean) => displayAt(it, expanded, W);

const HOME = os.homedir();
const item = (p: Partial<TranscriptItem>): TranscriptItem => ({ ts: 1, kind: "tool", text: "", ...p });
const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join("\n");

test("summarizeFileChange: write counts content lines and shortens home paths", () => {
	assert.equal(summarizeFileChange("write", { path: `${HOME}/p/member.ts`, content: `${lines(212)}\n` }), "✎ write ~/p/member.ts  +212");
	assert.equal(summarizeFileChange("Write", { file_path: "/tmp/a.ts", content: "" }), "✎ write /tmp/a.ts  +0");
	assert.equal(summarizeFileChange("write", { path: "a.ts" }), undefined, "no content → no summary");
	assert.equal(summarizeFileChange("bash", { command: "ls" }), undefined);
});

test("summarizeFileChange: pi edits[] oldText/newText, including JSON-string and single-object shapes", () => {
	const edits = [
		{ oldText: "a\nb\nc", newText: "a\nB1\nB2\nc" }, // shared head/tail ignored: +2 −1
		{ oldText: "x\ny", newText: "z" }, // +1 −2
	];
	assert.equal(summarizeFileChange("edit", { path: "/r/teams.ts", edits }), "✎ edit /r/teams.ts  +3 −3");
	assert.equal(summarizeFileChange("edit", { path: "/r/t.ts", edits: JSON.stringify(edits) }), "✎ edit /r/t.ts  +3 −3");
	assert.equal(summarizeFileChange("edit", { path: "/r/t.ts", edits: edits[1] }), "✎ edit /r/t.ts  +1 −2");
	assert.equal(summarizeFileChange("edit", { path: "/r/t.ts", oldText: "", newText: lines(4) }), "✎ edit /r/t.ts  +4 −0");
	assert.equal(summarizeFileChange("edit", { path: "/r/t.ts" }), undefined);
});

test("summarizeFileChange: claude Edit and MultiEdit old_string/new_string", () => {
	assert.equal(
		summarizeFileChange("Edit", { file_path: "/r/x.ts", old_string: lines(12, "old"), new_string: lines(34, "new") }),
		"✎ edit /r/x.ts  +34 −12",
	);
	assert.equal(
		summarizeFileChange("MultiEdit", {
			file_path: "/r/x.ts",
			edits: [
				{ old_string: "a", new_string: "b\nc" },
				{ old_string: "d\ne", new_string: "" },
			],
		}),
		"✎ edit /r/x.ts  +2 −3",
	);
});

test("fold: claude tool items recover write/edit summaries from JSON input and hide the blob", () => {
	const content = lines(40, "\t\tconst x =");
	const write = item({ toolName: "Write", text: JSON.stringify({ file_path: "/r/member.ts", content }) });
	assert.ok(write.text.includes("\\n\\t\\t"), "fixture carries literal escapes like real claude items");
	assert.deepEqual(foldTranscriptItem(write), { text: "✎ write /r/member.ts  +40", hidesContent: true });
	assert.equal(transcriptDisplayText(write, false), "✎ write /r/member.ts  +40");
	assert.equal(transcriptDisplayText(write, true), write.text, "expanded shows the original text");
	const edit = item({ toolName: "Edit", text: JSON.stringify({ file_path: "/r/a.ts", old_string: "a", new_string: "b" }) });
	assert.equal(transcriptDisplayText(edit, false), "✎ edit /r/a.ts  +1 −1");
	assert.equal(transcriptDisplayText(edit, true), "✎ edit /r/a.ts  +1 −1", "short items have nothing to expand");
});

test("fold: a stored runner summary replaces the short pi one-liner in both states", () => {
	const pi = item({ toolName: "write", text: "~/p/member.ts", summary: "✎ write ~/p/member.ts  +212" });
	assert.equal(transcriptDisplayText(pi, false), "✎ write ~/p/member.ts  +212");
	assert.equal(transcriptDisplayText(pi, true), "✎ write ~/p/member.ts  +212");
});

test("fold: long escaped-newline text collapses to a band with the tool name and first meaningful line", () => {
	const text = JSON.stringify({ command: "npm test \\\n  && echo ok", timeout: 5 }).replace("}", `,"x":"${"\\n\\t".repeat(10)}"}`);
	const bash = item({ toolName: "Bash", text });
	const fold = foldTranscriptItem(bash);
	assert.ok(fold?.hidesContent);
	assert.match(fold!.text, /^▕ bash ▕ npm test \\ +▕ 12 lines ▕ o ▕$/);
	assert.equal(visibleWidth(fold!.text), W);
	// Non-JSON wall of escapes (e.g. an assistant item with no real newlines): code signature.
	const wall = item({ kind: "assistant", text: `{\\n\\t\\tfunction go() {${"\\n\\t\\treturn 1;".repeat(10)}` });
	assert.match(transcriptDisplayText(wall, false), /^▕ code ▕ function go\(\) \{ +▕ 12 lines ▕ o ▕$/);
	assert.equal(transcriptDisplayText(wall, true), wall.text);
});

test("fold: long system/tool-result output collapses to a band; task, steer and error never fold", () => {
	const out = `{\n${lines(20, "row")}\n}`;
	assert.match(transcriptDisplayText(item({ kind: "system", text: out }), false), /^▕ text ▕ row 0 +▕ 22 lines ▕ o ▕$/);
	const result = transcriptDisplayText(item({ kind: "tool-result", toolName: "read", text: "x".repeat(400) }), false);
	assert.match(result, /^▕ read ▕ x+… ▕ 400 chars ▕ o ▕$/, "one unbroken line counts chars");
	assert.equal(visibleWidth(result), W);
	for (const kind of ["task", "steer", "error"] as const) {
		assert.equal(foldTranscriptItem(item({ kind, text: out })), undefined, kind);
	}
});

test("fold: assistant prose stays, only long fenced blocks collapse", () => {
	const code = lines(FOLD_MAX_LINES + 4, "  let v =");
	const text = `Here is the fix:\n\n\`\`\`ts\n\n${code}\n\`\`\`\n\nAnd a short one:\n\`\`\`\nok()\n\`\`\`\nDone.`;
	const a = item({ kind: "assistant", text });
	const out = transcriptDisplayText(a, false).split("\n");
	assert.deepEqual([out[0], out[1], ...out.slice(3)], ["Here is the fix:", "", "", "And a short one:", "```", "ok()", "```", "Done."]);
	assert.match(out[2], /^▕ ts ▕ let v = 0 +▕ 11 lines ▕ o ▕$/);
	assert.equal(visibleWidth(out[2]), W);
	assert.equal(transcriptDisplayText(a, true), text);
	// An unclosed fence (still streaming) folds to the end of the text.
	const streaming = item({ kind: "assistant", text: `Writing:\n\`\`\`py\n${code}` });
	assert.match(transcriptDisplayText(streaming, false), /^Writing:\n▕ py ▕ let v = 0 +▕ 10 lines ▕ o ▕$/);
});

test("fold: below-threshold items pass through unchanged", () => {
	for (const p of [
		{ kind: "assistant", text: `Short answer.\n\`\`\`\n${lines(FOLD_MAX_LINES)}\n\`\`\`` },
		{ kind: "tool", toolName: "bash", text: "ls -la" },
		{ kind: "system", text: lines(FOLD_MAX_LINES) },
		{ kind: "thinking", text: "brief thought" },
	] as Partial<TranscriptItem>[]) {
		const it = item(p);
		assert.equal(foldTranscriptItem(it), undefined, it.text);
		assert.equal(transcriptDisplayText(it, false), it.text);
	}
});

test("fold: memo revalidates when an item is rewritten in place", () => {
	const it = item({ kind: "system", text: "short" });
	assert.equal(transcriptDisplayText(it, false), "short");
	it.text = lines(10);
	assert.match(transcriptDisplayText(it, false), /▕ line 0 +▕ 10 lines ▕/);
	// Width is part of the memo key: bands always fill the width they were asked for.
	assert.equal(visibleWidth(displayAt(it, false, 40)), 40);
	assert.equal(visibleWidth(displayAt(it, false, W)), W);
});

test("fold: fences use the shared scanner at the modal threshold (column-0 only, >6 body lines)", () => {
	const at = (n: number) => item({ kind: "assistant", text: `\`\`\`py\n${lines(n)}\n\`\`\`` });
	assert.equal(foldTranscriptItem(at(FOLD_MAX_LINES)), undefined);
	assert.match(foldTranscriptItem(at(FOLD_MAX_LINES + 1))!.text, /▕ 7 lines ▕ o ▕$/);
	const listed = item({ kind: "assistant", text: `- step\n  \`\`\`py\n${lines(20).replace(/^/gm, "  ")}\n  \`\`\`` });
	assert.equal(foldTranscriptItem(listed), undefined, "fences nested in lists render natively, as on the main thread");
});
