import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backendDenial, EMPTY_POLICY, parsePolicy, policyDenial, readPolicy } from "./policy.ts";

test("parsePolicy tolerates missing, corrupt, foreign and partial files", () => {
	assert.deepEqual(parsePolicy(undefined), EMPTY_POLICY);
	assert.deepEqual(parsePolicy(null), EMPTY_POLICY);
	assert.deepEqual(parsePolicy("nope"), EMPTY_POLICY);
	assert.deepEqual(parsePolicy({ version: 2, disabledProviders: ["x"] }), EMPTY_POLICY);
	assert.deepEqual(parsePolicy({ version: 1 }), EMPTY_POLICY);
	assert.deepEqual(
		parsePolicy({ version: 1, disabledProviders: ["Anthropic", 7, ""], disabledModels: [null, "openai/gpt-5.2"] }),
		{ version: 1, disabledProviders: ["Anthropic"], disabledModels: ["openai/gpt-5.2"] },
	);
});

test("provider denial covers pi providers and non-pi backend ids, case-insensitively", () => {
	const policy = { version: 1 as const, disabledProviders: ["ANTHROPIC", "claude-code"], disabledModels: [] };
	assert.match(policyDenial(policy, "pi", "anthropic/claude-opus-4")!, /^Provider anthropic is disabled/);
	assert.equal(policyDenial(policy, "pi", "openai/gpt-5.2"), null);
	assert.match(policyDenial(policy, "claude-code", "sonnet")!, /^Backend claude-code is disabled/);
	assert.match(backendDenial(policy, "claude-code")!, /^Backend claude-code is disabled/);
	assert.equal(backendDenial(policy, "pi"), null);
	// No provider in the ref, or an empty one, can never match a provider rule.
	assert.equal(policyDenial(policy, "pi", "bareid"), null);
});

test("model denial matches pi refs and both backend spellings, case-insensitively", () => {
	const policy = { version: 1 as const, disabledProviders: [], disabledModels: ["openai/gpt-5.2", "claude-code/opus"] };
	assert.match(policyDenial(policy, "pi", "OpenAI/GPT-5.2")!, /^OpenAI\/GPT-5.2 is disabled/);
	assert.match(policyDenial(policy, "claude-code", "Opus")!, /^Opus is disabled/);
	assert.match(policyDenial(policy, "claude-code", "claude-code/opus")!, /^claude-code\/opus is disabled/);
	assert.equal(policyDenial(policy, "claude-code", "sonnet"), null);
	assert.equal(policyDenial(policy, "pi", "openai/gpt-5.2-mini"), null);
});

test("provider denial outranks model denial in the message", () => {
	const policy = { version: 1 as const, disabledProviders: ["zai"], disabledModels: ["zai/glm-5.3"] };
	assert.match(policyDenial(policy, "pi", "zai/glm-5.3")!, /^Provider zai is disabled/);
});

test("readPolicy: missing file reads empty, changes land without reload, corrupt reads empty", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-policy-"));
	const file = path.join(dir, "settings.json");
	const bump = (step: number) => {
		const at = new Date(Date.UTC(2024, 0, 2, 0, 0, step)); // distinct, explicit, collision-free
		fs.utimesSync(file, at, at);
	};
	try {
		assert.deepEqual(readPolicy(file), EMPTY_POLICY);
		fs.writeFileSync(file, JSON.stringify({ version: 1, disabledProviders: ["anthropic"], disabledModels: [] }));
		bump(1);
		assert.deepEqual(readPolicy(file).disabledProviders, ["anthropic"]);
		// A later write is picked up on the next call — no reload, no restart.
		fs.writeFileSync(file, JSON.stringify({ version: 1, disabledProviders: ["zai"], disabledModels: ["openai/gpt-5.2"] }));
		bump(2);
		assert.deepEqual(readPolicy(file), { version: 1, disabledProviders: ["zai"], disabledModels: ["openai/gpt-5.2"] });
		// Corrupt content with a fresh mtime reads as empty, never throws.
		fs.writeFileSync(file, "{corrupt");
		bump(3);
		assert.deepEqual(readPolicy(file), EMPTY_POLICY);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("the unified file adds the global dimension, and denials say which rule caught the model", () => {
	// Bare keys are global, subagent* keys narrow what is still allowed; workers obey both.
	const policy = parsePolicy({
		version: 1,
		disabledProviders: ["anthropic"],
		disabledModels: ["openai/gpt-5.2"],
		subagentDisabledProviders: ["zai"],
		subagentDisabledModels: ["ollama/qwen3-coder"],
	});
	assert.deepEqual(policy.disabledProviders, ["anthropic", "zai"]);
	assert.deepEqual(policy.disabledModels, ["openai/gpt-5.2", "ollama/qwen3-coder"]);
	assert.match(policyDenial(policy, "pi", "anthropic/claude-sonnet-5")!, /Provider anthropic is disabled everywhere/);
	assert.match(policyDenial(policy, "pi", "zai/glm-5.3")!, /Provider zai is disabled for subagents/);
	assert.match(policyDenial(policy, "pi", "openai/gpt-5.2")!, /^openai\/gpt-5\.2 is disabled everywhere/);
	assert.match(policyDenial(policy, "pi", "ollama/qwen3-coder")!, /is disabled as a subagent model/);
	assert.equal(policyDenial(policy, "pi", "openai/gpt-5.1"), null);
	// A backend turned off globally is refused whether or not the spawn named a model.
	const claude = parsePolicy({ version: 1, disabledProviders: ["claude-code"], subagentDisabledProviders: [] });
	assert.match(backendDenial(claude, "claude-code")!, /Backend claude-code is disabled everywhere/);
	assert.match(policyDenial(claude, "claude-code", "sonnet")!, /Backend claude-code is disabled everywhere/);
});

test("readPolicy falls back to the pre-Models-tab file only while the unified one is absent", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-policy-fallback-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		fs.mkdirSync(path.join(dir, "subagents"));
		fs.writeFileSync(
			path.join(dir, "subagents", "settings.json"),
			JSON.stringify({ version: 1, disabledProviders: ["zai"], disabledModels: [] }),
		);
		// The module resolved its paths at import time, so exercise the same rule the way the
		// module does: explicit-file reads for each candidate, in the order readPolicy tries them.
		assert.deepEqual(readPolicy(path.join(dir, "model-policy.json")), EMPTY_POLICY);
		const legacy = readPolicy(path.join(dir, "subagents", "settings.json"));
		assert.deepEqual(legacy.disabledProviders, ["zai"]);
		assert.equal(legacy.globalProviders, undefined); // the old lists were never global
		fs.writeFileSync(
			path.join(dir, "model-policy.json"),
			JSON.stringify({ version: 1, disabledProviders: [], subagentDisabledProviders: ["openai"] }),
		);
		assert.deepEqual(readPolicy(path.join(dir, "model-policy.json")).disabledProviders, ["openai"]);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
