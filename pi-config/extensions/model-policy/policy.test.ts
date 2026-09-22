import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	EMPTY_POLICY,
	effectiveSubagentLists,
	globalBackendDenial,
	globalDenial,
	globallyEnabled,
	parsePolicy,
	providerOf,
	readPolicy,
	subagentEnabled,
} from "./policy.ts";

const policy = (over: Partial<typeof EMPTY_POLICY> = {}) => ({ ...EMPTY_POLICY, ...over });

test("parsePolicy tolerates missing, corrupt, foreign and partial files", () => {
	assert.deepEqual(parsePolicy(undefined), EMPTY_POLICY);
	assert.deepEqual(parsePolicy(null), EMPTY_POLICY);
	assert.deepEqual(parsePolicy("nope"), EMPTY_POLICY);
	assert.deepEqual(parsePolicy([]), EMPTY_POLICY);
	assert.deepEqual(parsePolicy({ version: 2, disabledProviders: ["x"], subagentDisabledModels: [] }), EMPTY_POLICY);
	assert.deepEqual(parsePolicy({ version: 1 }), EMPTY_POLICY);
	assert.deepEqual(
		parsePolicy({ version: 1, disabledProviders: ["Anthropic", 7, " "], subagentDisabledModels: [null, " zai/glm-5.3 "] }),
		policy({ disabledProviders: ["Anthropic"], subagentDisabledModels: ["zai/glm-5.3"] }),
	);
});

test("the legacy two-key file parses as subagent-only: nothing becomes globally disabled", () => {
	// What pi-web wrote before the Models tab. Its lists meant "not for workers", and a migration
	// that read them as global prohibitions would turn off models the user still uses by hand.
	assert.deepEqual(
		parsePolicy({ version: 1, disabledProviders: ["anthropic"], disabledModels: ["openai/gpt-5.2"] }),
		policy({ subagentDisabledProviders: ["anthropic"], subagentDisabledModels: ["openai/gpt-5.2"] }),
	);
	// The unified shape is told apart by its own keys, even when they are empty.
	assert.deepEqual(
		parsePolicy({ version: 1, disabledProviders: ["anthropic"], subagentDisabledProviders: [] }),
		policy({ disabledProviders: ["anthropic"] }),
	);
});

test("global rules cover a provider, an exact ref, and both spellings of a backend model", () => {
	const p = policy({ disabledProviders: ["Anthropic", "claude-code"], disabledModels: ["OpenAI/GPT-5.2"] });
	assert.equal(globallyEnabled(p, "pi", "anthropic/claude-sonnet-5"), false);
	assert.equal(globallyEnabled(p, "pi", "openai/gpt-5.2"), false);
	assert.equal(globallyEnabled(p, "pi", "openai/gpt-5.1"), true);
	assert.equal(globallyEnabled(p, "claude-code", "sonnet"), false); // the backend IS the provider
	assert.equal(globallyEnabled(policy({ disabledModels: ["claude-code/opus"] }), "claude-code", "opus"), false);
	assert.equal(globallyEnabled(policy({ disabledModels: ["opus"] }), "claude-code", "opus"), false);
	assert.equal(globallyEnabled(EMPTY_POLICY, "pi", ""), true); // no ref, no prohibition
	assert.equal(providerOf("pi", "zai/glm-5.3"), "zai");
	assert.equal(providerOf("claude-code", "sonnet"), "claude-code");
});

test("a globally disabled model is disabled for subagents too, and the preference is kept", () => {
	const p = policy({ disabledProviders: ["zai"], subagentDisabledModels: ["zai/glm-5.3", "openai/gpt-5.2"] });
	assert.equal(subagentEnabled(p, "pi", "zai/glm-5.3"), false);
	assert.equal(subagentEnabled(p, "pi", "openai/gpt-5.2"), false); // subagent-only restriction
	assert.equal(globallyEnabled(p, "pi", "openai/gpt-5.2"), true); //  …still yours to drive
	// Turning the provider back on returns the worker preference the user had before.
	const on = policy({ subagentDisabledModels: p.subagentDisabledModels });
	assert.equal(globallyEnabled(on, "pi", "zai/glm-5.3"), true);
	assert.equal(subagentEnabled(on, "pi", "zai/glm-5.3"), false);
});

test("denials name the thing and the way out; an allowed model has none", () => {
	const p = policy({ disabledProviders: ["anthropic", "claude-code"], disabledModels: ["openai/gpt-5.2"] });
	assert.match(globalDenial(p, "pi", "anthropic/claude-sonnet-5")!, /Provider anthropic is turned off.*Switch with \/model/s);
	assert.match(globalDenial(p, "pi", "openai/gpt-5.2")!, /^openai\/gpt-5\.2 is turned off/);
	assert.match(globalDenial(p, "claude-code", "sonnet")!, /Backend claude-code is turned off/);
	assert.equal(globalDenial(p, "pi", "openai/gpt-5.1"), null);
	// A backend spawn that named no model: only the provider-wide rule can apply.
	assert.match(globalBackendDenial(p, "claude-code")!, /Backend claude-code is turned off/);
	assert.equal(globalBackendDenial(p, "pi"), null);
	assert.equal(globalBackendDenial(EMPTY_POLICY, "claude-code"), null);
});

test("effectiveSubagentLists merges both dimensions, lowercase, deduped and sorted", () => {
	assert.deepEqual(
		effectiveSubagentLists(policy({
			disabledProviders: ["ZAI"],
			disabledModels: ["openai/gpt-5.2"],
			subagentDisabledProviders: ["zai", "anthropic"],
			subagentDisabledModels: ["Ollama/qwen3"],
		})),
		{ disabledProviders: ["anthropic", "zai"], disabledModels: ["ollama/qwen3", "openai/gpt-5.2"] },
	);
});

test("readPolicy: explicit file, either shape; missing and corrupt read as nothing disabled", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-policy-"));
	const file = path.join(dir, "model-policy.json");
	try {
		assert.deepEqual(readPolicy(file), EMPTY_POLICY);
		fs.writeFileSync(file, "{not json");
		assert.deepEqual(readPolicy(file), EMPTY_POLICY);
		fs.writeFileSync(file, JSON.stringify({ version: 1, disabledProviders: ["zai"], subagentDisabledProviders: ["openai"] }));
		assert.deepEqual(readPolicy(file), policy({ disabledProviders: ["zai"], subagentDisabledProviders: ["openai"] }));
		// mtime moves, the next read follows it: pi-web writes this file while sessions run.
		fs.writeFileSync(file, JSON.stringify({ version: 1, disabledProviders: [], subagentDisabledProviders: ["zai"] }));
		fs.utimesSync(file, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
		assert.deepEqual(readPolicy(file), policy({ subagentDisabledProviders: ["zai"] }));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
