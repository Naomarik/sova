import assert from "node:assert/strict";
import test from "node:test";
import { parseClaudePolicy, validateClaudeTools, validateClaudeEffort, validateClaudeModel } from "./policy.ts";

test("Claude policy defaults to bypass permissions without enabling nested delegation", () => {
	assert.deepEqual(parseClaudePolicy(undefined), { permissionMode: "bypassPermissions", allowedTools: undefined, maxBudgetUsd: undefined });
	assert.deepEqual(validateClaudeTools([]), []);
	assert.ok(!validateClaudeTools(undefined).includes("Agent"));
	assert.equal(validateClaudeModel(undefined), "sonnet");
	assert.equal(validateClaudeEffort(undefined), "medium");
});
test("Claude native names and options validate without silent Pi mappings", () => {
	assert.throws(() => validateClaudeTools(["bash"]), /native names/);
	assert.throws(() => validateClaudeModel("anthropic/claude-sonnet-5"), /provider\/model/);
	assert.throws(() => validateClaudeEffort("off"), /Claude effort/);
	assert.deepEqual(validateClaudeTools(["Read", "Read", "Bash"]), ["Read", "Bash"]);
	assert.equal(validateClaudeModel("opus[1m]"), "opus[1m]");
	assert.deepEqual(parseClaudePolicy({ permissionMode: "manual", allowedTools: ["Bash(npm test *)"], maxBudgetUsd: 2 }), { permissionMode: "manual", allowedTools: ["Bash(npm test *)"], maxBudgetUsd: 2 });
});
test("Claude policy preserves explicit permission modes", () => {
	for (const permissionMode of ["bypassPermissions", "acceptEdits", "manual", "dontAsk", "plan"]) {
		assert.equal(parseClaudePolicy({ permissionMode }).permissionMode, permissionMode);
	}
});
test("Claude policy rejects unknown options, modes and malformed constraints", () => {
	for (const input of [null, [], "x", { permissionMode: "unknown" }, { settingSources: "user" }, { allowedTools: [1] }, { allowedTools: [""] }, { allowedTools: ["Read", "--dangerously-skip-permissions"] }, { allowedTools: [" --version"] }, { allowedTools: ["Read\n--version"] }, { maxBudgetUsd: 0 }, { maxBudgetUsd: Infinity }]) {
		assert.throws(() => parseClaudePolicy(input));
	}
});
