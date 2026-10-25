/**
 * A memory view's layout keeps the prompt cache: the guide and stable prefix go into the
 * initialize `systemPrompt` past SYSTEM_PROMPT_BOUNDARY, their own cached block, and only the newer lines and
 * the turn's messages go in the message. Pure (no child, no socket), so `pnpm test` runs it with every unit
 * file; bridge.test.ts drives the same layout through a fake CLI.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { memoryViewContent } from "./memory-view.ts";
import {
	memorySystemPrompt, memoryViewFrame, memoryViewOf, requestLayoutOf, SYSTEM_PROMPT_BOUNDARY, withoutMemoryPrefix,
} from "./memory-layout.ts";

const GUIDE = "# Memory\nguide text";
const PREFIX = "<chat>\n0+2|user: hi; sova: hello\n</chat>";
const view = (tail: string[]): Message => ({ role: "user", content: memoryViewContent(GUIDE, ["0+2|user: hi; sova: hello"], tail), timestamp: 1 });
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 2 });

test("memory layout: the guide and prefix go past the boundary, the newer lines and the turn in the message", () => {
	const history = [view(["2+1|user: port 4810"]), user("what port?")];
	const layout = requestLayoutOf(history);
	assert.deepEqual(layout.systemPrompt("BASE"), ["BASE", SYSTEM_PROMPT_BOUNDARY, `${GUIDE}\n\n${PREFIX}`]);
	assert.deepEqual(memorySystemPrompt("BASE", memoryViewOf(history)), layout.systemPrompt("BASE"));
	assert.equal(layout.rebuilds, true, "a view is rebuilt on purpose: never resumed");
	const tail = "<chat> (continued: the newest lines)\n2+1|user: port 4810\n</chat>";
	assert.deepEqual(layout.asIs, { text: `${tail}\n\nwhat port?`, images: [] });
	assert.deepEqual(memoryViewFrame(history), layout.asIs);
	assert.deepEqual(withoutMemoryPrefix(history)[0]!.content, [{ type: "text", text: tail }], "a fold carries the newer lines alone");
	assert.ok(!layout.asIs!.text.includes("guide text") && !layout.asIs!.text.includes("0+2|"), "the guide and prefix are never in the message");
});

test("memory layout: no view, no boundary", () => {
	const layout = requestLayoutOf([user("hi")]);
	assert.deepEqual(layout.systemPrompt("BASE"), ["BASE"]);
	assert.deepEqual(memorySystemPrompt("BASE", undefined), ["BASE"]);
	assert.equal(layout.rebuilds, false);
	assert.equal(layout.asIs, undefined);
});

test("memory layout: turns whose newer lines grow keep a byte-identical systemPrompt (the cached prefix)", () => {
	const first = requestLayoutOf([view(["2+1|user: port 4810"]), user("what port?")]);
	const second = requestLayoutOf([view(["2+1|user: port 4810", "3+1|user: what port?"]), user("and the host?")]);
	assert.equal(JSON.stringify(second.systemPrompt("BASE")), JSON.stringify(first.systemPrompt("BASE")));
	assert.notEqual(second.asIs!.text, first.asIs!.text, "only the message changed");
});
