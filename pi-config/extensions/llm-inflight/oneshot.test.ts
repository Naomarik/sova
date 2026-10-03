// The topic outline's `claude -p` one-shot against a fake CLI: counted from spawn to the
// process's real exit, never ended by the kill that a timeout or an abort only requests.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeCliSummarizer } from "../topic-outline/summarizers/claude-cli.ts";
import { snapshot } from "./tracker.ts";

const fakeClaude = (body: string) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-inflight-claude-"));
	const bin = path.join(dir, "claude");
	fs.writeFileSync(bin, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
	return { bin, dir };
};
const input = (signal: AbortSignal) => ({ existingOutline: "[]", newLines: ["[m1] USER: hi"], validRefs: new Set(["m1"]), signal }) as any;

test("a one-shot counts (approximate) until its process has exited, a timeout's kill included", { timeout: 15_000 }, async () => {
	const base = snapshot();
	const { bin, dir } = fakeClaude(`process.stdin.resume(); setInterval(() => {}, 1000);`);
	const summarizer = createClaudeCliSummarizer({ model: "haiku", timeoutMs: 150 } as any, bin);
	let atKill: { active: number; approximate: number } | undefined;
	const running = summarizer.summarize(input(new AbortController().signal)).catch((error) => {
		// Settled the moment the kill was requested: the process hasn't reported its exit yet.
		const s = snapshot();
		atKill = { active: s.active - base.active, approximate: s.approximate - base.approximate };
		return error;
	});
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(snapshot().active, base.active + 1, "in flight while the CLI runs");
	assert.match(String(await running), /timed out/);
	assert.deepEqual(atKill, { active: 1, approximate: 1 }, "a kill is intent: still counted");
	for (let i = 0; i < 200 && snapshot().active !== base.active; i++) await new Promise((r) => setTimeout(r, 10));
	assert.equal(snapshot().active, base.active, "gone once the process exited");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("a one-shot that can't spawn never counts past its error", async () => {
	const base = snapshot().active;
	const { bin, dir } = fakeClaude("");
	fs.chmodSync(bin, 0o644); // exists, not executable: spawn fails
	const summarizer = createClaudeCliSummarizer({ model: "haiku", timeoutMs: 5_000 } as any, bin);
	await assert.rejects(summarizer.summarize(input(new AbortController().signal)));
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(snapshot().active, base);
	fs.rmSync(dir, { recursive: true, force: true });
});
