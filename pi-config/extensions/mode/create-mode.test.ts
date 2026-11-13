// Create's shared rules (§chat/create-mode): which modes orchestrate, the composed prompt's order, the status
// label. What a chat does in Create (strict, restore, the hook that permits a switch) is Sova's engine's, in
// server/modes/engine-hooks.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { orchestrates } from "./state.ts";
import { CREATE_INSTRUCTIONS } from "./create/guide.ts";
import { buildDelegateAlignBridge, buildDelegatePrompt, composePrompt, DEFAULT_ROUTES, statusLabel } from "./prompt.ts";

test("orchestrates: Delegate and Create, and only they", () => {
	assert.deepEqual(["normal", "delegate", "create"].filter((m) => orchestrates(m as never)), ["delegate", "create"]);
});

test("the composed prompt is Delegate's block, the align bridge, then Create's block, in that order, with Delegate's unchanged", () => {
	const delegate = composePrompt({ mode: "delegate", strict: false, minorModes: ["align"] }, DEFAULT_ROUTES)!;
	const create = composePrompt({ mode: "create", strict: false, minorModes: ["align"] }, DEFAULT_ROUTES)!;
	const block = buildDelegatePrompt(DEFAULT_ROUTES);
	const bridge = buildDelegateAlignBridge();
	assert.ok(delegate.includes(block) && delegate.includes(bridge));
	assert.ok(!delegate.includes(CREATE_INSTRUCTIONS), "Delegate has no Create block");
	const at = [create.indexOf(block), create.indexOf(bridge), create.indexOf(CREATE_INSTRUCTIONS)];
	assert.ok(at.every((i) => i >= 0), `all three are there: ${at}`);
	assert.deepEqual([...at].sort((a, b) => a - b), at, "in that order");
	assert.ok(!composePrompt({ mode: "create", strict: false, minorModes: [] }, DEFAULT_ROUTES)!.includes(bridge), "no bridge once align is off");
	assert.equal(composePrompt({ mode: "normal", strict: false, minorModes: [] }, DEFAULT_ROUTES), undefined);
});

test("the status line reads as Delegate's does: strict shows, and it is lit", () => {
	assert.deepEqual(statusLabel("create", DEFAULT_ROUTES, true, []), { text: "create · strict", tone: "accent" });
});
