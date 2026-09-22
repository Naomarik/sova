import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { policyGated } from "./summarizers/policy-gate.ts";
import { SummarizerError, type SummarizeInput, type SummarizerResult } from "./types.ts";

const INPUT: SummarizeInput = { existingOutline: "", newLines: ["m1 USER: hi"] };
const RESULT: SummarizerResult = { now: "n", overall: "o", topicUpdates: [] };

function fake() {
	let calls = 0;
	return {
		calls: () => calls,
		summarizer: {
			name: "pi/zai/glm-5.3",
			async summarize(): Promise<SummarizerResult> {
				calls++;
				return RESULT;
			},
		},
	};
}

function policyFile(policy: Record<string, unknown>, dir: string, writes: number): string {
	const file = path.join(dir, "model-policy.json");
	fs.writeFileSync(file, JSON.stringify(policy));
	const future = new Date(Date.now() + 5000 * writes); // beat the reader's mtime cache
	fs.utimesSync(file, future, future);
	return file;
}

test("the policy is read at the call, so a model turned off mid-session stops being summarized with", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outline-policy-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const inner = fake();
	const file = policyFile({ version: 1, disabledProviders: [], subagentDisabledProviders: [] }, dir, 1);
	const gated = policyGated(inner.summarizer, { backend: "pi", model: "zai/glm-5.3" }, file);

	assert.deepEqual(await gated.summarize(INPUT), RESULT);
	assert.equal(inner.calls(), 1);

	// The same chain, the same session, one file write later: the next summary must not call it.
	policyFile({ version: 1, disabledModels: ["zai/glm-5.3"], subagentDisabledProviders: [] }, dir, 2);
	await assert.rejects(gated.summarize(INPUT), (error: unknown) => {
		assert.ok(error instanceof SummarizerError, "denial is the chain's 'try the next backend' error");
		assert.match((error as Error).message, /zai\/glm-5\.3 is turned off in Settings → Models/);
		return true;
	});
	assert.equal(inner.calls(), 1, "the backend was never called");

	// And back on again, without a reload.
	policyFile({ version: 1, disabledModels: [], subagentDisabledProviders: [] }, dir, 3);
	assert.deepEqual(await gated.summarize(INPUT), RESULT);
	assert.equal(inner.calls(), 2);
});

test("a claude-code summarizer is gated by the backend name, which is its provider", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outline-policy-cc-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const inner = fake();
	const file = policyFile({ version: 1, disabledProviders: ["claude-code"], subagentDisabledProviders: [] }, dir, 1);
	const gated = policyGated(inner.summarizer, { backend: "claude-code", model: "haiku" }, file);
	await assert.rejects(gated.summarize(INPUT), /claude-code\/haiku is turned off/);
	assert.equal(inner.calls(), 0);
	// A subagent-only restriction is a different question and never stops a summary.
	const workers = policyFile({ version: 1, disabledProviders: [], subagentDisabledProviders: ["claude-code"] }, dir, 2);
	assert.deepEqual(await policyGated(inner.summarizer, { backend: "claude-code", model: "haiku" }, workers).summarize(INPUT), RESULT);
	assert.equal(inner.calls(), 1);
});

test("the gate keeps the summarizer's name, so the chain's backoff bookkeeping is unchanged", () => {
	const inner = fake();
	assert.equal(policyGated(inner.summarizer, { backend: "pi", model: "zai/glm-5.3" }).name, inner.summarizer.name);
});
