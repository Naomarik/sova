import assert from "node:assert/strict";
import test from "node:test";
import {
	answerText,
	AUTO_DESCRIBE_PROMPT,
	buildQuestionPrompt,
	conversationExcerpt,
	describedBy,
	imageBlocks,
	MAX_IMAGES,
	mimeForPath,
	skippedNote,
	viaLine,
} from "./describe.ts";

const model = { provider: "zai", id: "glm-5.3-flash" };
const image = (data = "AAAA") => ({ type: "image", data, mimeType: "image/png" });

test("supported image extensions map to mime types, case-insensitively", () => {
	assert.equal(mimeForPath("/tmp/shot.PNG"), "image/png");
	assert.equal(mimeForPath("a/b.jpeg"), "image/jpeg");
	assert.equal(mimeForPath("a/b.jpg"), "image/jpeg");
	assert.equal(mimeForPath("x.webp"), "image/webp");
	for (const bad of ["notes.txt", "archive.tar.gz", "Makefile", "x.svg", "x.pdf"]) assert.equal(mimeForPath(bad), undefined);
});

test("image blocks are recognized only when complete, and never invented", () => {
	const content = [{ type: "text", text: "hi" }, image(), { type: "image" }, { type: "image", data: 1, mimeType: "image/png" }, null];
	assert.deepEqual(imageBlocks(content as unknown[]), [image()]);
	assert.deepEqual(imageBlocks(undefined), []);
	assert.deepEqual(imageBlocks([]), []);
});

test("attribution names the delegate and numbers images only when there are several", () => {
	assert.equal(describedBy(model), "[image described by zai/glm-5.3-flash]");
	assert.equal(describedBy(model, 0, 1), "[image described by zai/glm-5.3-flash]");
	assert.equal(describedBy(model, 1, 3), "[image 2/3 described by zai/glm-5.3-flash]");
	assert.equal(viaLine(model, { overBudget: false }), "[via zai/glm-5.3-flash]");
	assert.match(viaLine(model, { overBudget: true, usedPct: 97 }), /^\[via zai\/glm-5\.3-flash\] \(every vision fallback is over budget; used anyway at 97%\)$/);
});

test("skipped images past the cap are disclosed, silently when there are none", () => {
	assert.equal(skippedNote(0), "");
	assert.equal(skippedNote(-1), "");
	assert.match(skippedNote(2), /2 further image\(s\) in this message were not described/);
	assert.equal(MAX_IMAGES, 3);
});

test("the question prompt carries the question, and context only when there is some", () => {
	const bare = buildQuestionPrompt("what does the error say?");
	assert.match(bare, /Question: what does the error say\?/);
	assert.doesNotMatch(bare, /<conversation>/);
	const withContext = buildQuestionPrompt("what does the error say?", "User: look at this");
	assert.match(withContext, /<conversation>\nUser: look at this\n<\/conversation>/);
	assert.match(AUTO_DESCRIBE_PROMPT, /^Describe this image precisely and completely/);
});

const entry = (role: string, text: string) => ({ type: "message", message: { role, content: [{ type: "text", text }] } });

test("the excerpt keeps the newest turns in order and ignores non-message entries", () => {
	const entries = [
		{ type: "custom", data: {} },
		entry("user", "first"),
		entry("assistant", "second"),
		{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "noise" }] } },
		entry("user", "third"),
	];
	assert.equal(conversationExcerpt(entries, 2000), "User: first\nAssistant: second\nUser: third");
	assert.equal(conversationExcerpt([], 2000), "");
	assert.equal(conversationExcerpt(undefined, 2000), "");
	assert.equal(conversationExcerpt(entries, 0), "");
});

test("the excerpt spends its budget on the tail and truncates rather than drops", () => {
	const entries = [entry("user", "A".repeat(100)), entry("assistant", "B".repeat(20)), entry("user", "recent")];
	const excerpt = conversationExcerpt(entries, 40);
	assert.ok(excerpt.length <= 41, excerpt);
	assert.match(excerpt, /User: recent$/);
	assert.match(excerpt, /^…/);
	assert.doesNotMatch(excerpt, /A/);
	// String content and empty messages are handled without throwing.
	assert.equal(conversationExcerpt([{ type: "message", message: { role: "user", content: "plain" } }], 100), "User: plain");
	assert.equal(conversationExcerpt([{ type: "message", message: { role: "user", content: [] } }], 100), "");
});

test("an answer is the model's text blocks, trimmed, with non-text ignored", () => {
	assert.equal(answerText([{ type: "thinking", thinking: "hmm" }, { type: "text", text: "  a  " }, { type: "text", text: "b" }]), "a  \nb");
	assert.equal(answerText([]), "");
	assert.equal(answerText(undefined), "");
	assert.equal(answerText([{ type: "toolCall", name: "x" }]), "");
});
