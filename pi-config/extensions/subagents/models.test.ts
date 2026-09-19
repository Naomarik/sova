import assert from "node:assert/strict";
import test from "node:test";
import { matchingModels, piModels } from "./models.ts";

test("model discovery uses active registry including extension/cloud providers", () => {
	let calls = 0;
	const choices = piModels({ modelRegistry: { getAvailable() { calls++; return [{ provider: "ollama-cloud", id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }]; } } } as any);
	assert.equal(calls, 1);
	assert.equal(choices[0].id, "ollama-cloud/deepseek-v4.1-flash");
	assert.equal(matchingModels(choices.map(m => ({ ...m, backend: "pi" })), "deepseek 4.1 flash").length, 1);
});
test("model search handles exact IDs, words and backend names without choosing ambiguous matches", () => {
	const models = [
		{ backend: "pi", id: "ollama-cloud/deepseek-v4.1-flash", name: "DeepSeek" },
		{ backend: "pi", id: "other/deepseek-v4.1-flash", name: "DeepSeek" },
		{ backend: "claude-code", id: "opus", name: "Opus", efforts: ["low", "high"] },
	];
	assert.equal(matchingModels(models, "deepseek 4.1 flash").length, 2);
	assert.equal(matchingModels(models, "claude opus")[0].id, "opus");
	assert.equal(matchingModels(models, "missing").length, 0);
	assert.equal(matchingModels(models).length, 3);
});
