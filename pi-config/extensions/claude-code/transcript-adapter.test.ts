import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	claudeSidechainFiles,
	claudeUsageAccumulator,
	createClaudeTranscriptAdapter,
	locateClaudeSession,
	summarizeClaudeEntries,
} from "./transcript-adapter.ts";
import { WorkerProtocolVersionError, parseJsonLines, resolveWorkerUsage, usageSnapshot, type WorkerTranscriptRef } from "../subagents/worker-transcript.ts";

const ID = "0b7a2b8e-6d0e-4a4e-9f55-3f0b6b1e2a11";
const CWD = "/home/u/webapps/.worktrees/sova-x";
const T = (s: number) => new Date(Date.parse("2026-09-24T10:00:00.000Z") + s * 1000).toISOString();

const u = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
	input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite,
});
/** One CLI line per content block, all sharing message.id and the same usage. */
const assistantLines = (msgId: string, at: number, blocks: unknown[], usage: unknown, extra: Record<string, unknown> = {}, model = "claude-sonnet-5", stop: string | null = "end_turn") =>
	blocks.map((block, i) => ({
		type: "assistant", uuid: `${msgId}-${i}`, isSidechain: false, timestamp: T(at), effort: "medium", ...extra,
		message: { id: msgId, model, role: "assistant", content: [block], stop_reason: stop, usage },
	}));
const userLine = (at: number, content: unknown, extra: Record<string, unknown> = {}) => ({
	type: "user", uuid: `u${at}`, isSidechain: false, timestamp: T(at), message: { role: "user", content }, ...extra,
});

function projects(): { root: string; write(slugDir: string, id: string, lines: unknown[]): string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-projects-"));
	return {
		root,
		write(slugDir, id, lines) {
			fs.mkdirSync(path.join(root, slugDir), { recursive: true });
			const file = path.join(root, slugDir, `${id}.jsonl`);
			fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
			return file;
		},
	};
}

const ref = (over: Partial<WorkerTranscriptRef> = {}): WorkerTranscriptRef => ({ v: 1, backend: "claude-code", kind: "claude-session-id", locator: ID, cwd: CWD, ...over });

test("usage: dedupe by message.id, sidechains counted, per-model rows, tokens only", () => {
	const lines = [
		userLine(0, "task"),
		...assistantLines("msg_1", 1, [{ type: "thinking", thinking: "hm" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], u(10, 5, 100, 50), {}, "claude-sonnet-5", "tool_use"),
		userLine(2, [{ type: "tool_result", tool_use_id: "t1", content: "a\nb" }]),
		// an inline sidechain (older CLI): the worker's own Task agent
		...assistantLines("msg_side", 3, [{ type: "text", text: "nested" }], u(1, 1), { isSidechain: true }, "claude-haiku-4-5"),
		...assistantLines("msg_2", 4, [{ type: "text", text: "all done" }], u(20, 7, 200, 0)),
		// a synthetic error line carries zero usage: counted as a turn, no row
		...assistantLines("msg_err", 5, [{ type: "text", text: "API Error" }], u(0, 0), { isApiErrorMessage: true }, "<synthetic>", "stop_sequence"),
	];
	const acc = claudeUsageAccumulator();
	acc.add(lines);
	acc.add(lines.slice(1, 3)); // the same message straddling a re-read
	const usage = acc.usage();
	assert.deepEqual([usage.input, usage.output, usage.cacheRead, usage.cacheWrite], [31, 13, 300, 50]);
	assert.equal(usage.cost, undefined);
	assert.equal(usage.turns, 4);
	assert.deepEqual(usage.byModel.map((r) => r.model).sort(), ["claude/claude-haiku-4-5", "claude/claude-sonnet-5"]);
	assert.equal(usage.policy?.nestedAgents, true);
});

test("summary: main chain only; settled success, tool_use in progress, interrupted = aborted, API error = error", () => {
	const base = [userLine(0, "task"), ...assistantLines("m1", 1, [{ type: "text", text: "final answer" }], u(1, 1))];
	const settled = summarizeClaudeEntries(base, [], ref(), { items: "all" });
	assert.equal(settled.state, "settled");
	assert.equal(settled.lastOutcome, "success");
	assert.equal(settled.lastAssistantText, "final answer");
	assert.equal(settled.model, "claude/claude-sonnet-5");
	assert.equal(settled.effort, "medium");
	assert.deepEqual(settled.items?.map((i) => i.kind), ["task", "assistant"]);

	const mid = summarizeClaudeEntries([...base, userLine(2, "next"), ...assistantLines("m2", 3, [{ type: "tool_use", id: "t", name: "Read", input: {} }], u(1, 1), {}, "claude-sonnet-5", "tool_use")], [], ref());
	assert.equal(mid.state, "in-progress");
	assert.equal(mid.partialTurn, true);

	const aborted = summarizeClaudeEntries([...base, userLine(2, "go"), userLine(3, [{ type: "text", text: "[Request interrupted by user]" }])], [], ref());
	assert.equal(aborted.lastOutcome, "aborted");
	assert.equal(aborted.partialTurn, false);

	const failed = summarizeClaudeEntries([...base, ...assistantLines("e", 4, [{ type: "text", text: "API Error: 500" }], u(0, 0), { isApiErrorMessage: true }, "<synthetic>")], [], ref(), { items: "all" });
	assert.equal(failed.lastOutcome, "error");
	assert.equal(failed.lastAssistantText, "final answer");
	assert.equal(failed.items?.at(-1)?.kind, "error");

	// Sidechain lines and meta user lines never become the main chain's last turn or items.
	const side = summarizeClaudeEntries([...base, userLine(5, "injected", { isMeta: true }), ...assistantLines("s", 6, [{ type: "tool_use", id: "x", name: "Bash", input: {} }], u(1, 1), { isSidechain: true }, "claude-haiku-4-5", "tool_use")], [], ref(), { items: "all" });
	assert.equal(side.state, "settled");
	assert.equal(side.items?.length, 2);
	assert.equal(side.usage.input, 2);

	const compacted = summarizeClaudeEntries([{ type: "system", subtype: "compact_boundary", uuid: "c", timestamp: T(9) }, ...base], [], ref());
	assert.equal(compacted.compactions, 1);
});

test("locate: cwd slug dir first, else a scan of every project dir; UUID-validated; symlink escape refused", () => {
	const p = projects();
	const slug = CWD.replace(/[^a-zA-Z0-9]/g, "-");
	const own = p.write(slug, ID, [userLine(0, "x")]);
	assert.equal(locateClaudeSession(ID, { cwd: CWD, root: p.root }), fs.realpathSync(own));
	// Moved cwd: still found by scan.
	assert.equal(locateClaudeSession(ID, { cwd: "/elsewhere", root: p.root }), fs.realpathSync(own));
	assert.equal(locateClaudeSession("../../etc/passwd", { root: p.root }), null);
	const other = "11111111-2222-4333-8444-555555555555";
	assert.equal(locateClaudeSession(other, { root: p.root }), null);
	// A symlink out of the root is not followed.
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
	fs.writeFileSync(path.join(outside, "secret.jsonl"), "{}\n");
	fs.mkdirSync(path.join(p.root, "-evil"));
	fs.symlinkSync(path.join(outside, "secret.jsonl"), path.join(p.root, "-evil", `${other}.jsonl`));
	assert.equal(locateClaudeSession(other, { root: p.root }), null);
});

test("read: main record plus <uuid>/subagents/*.jsonl sidechains, deduped across files", async () => {
	const p = projects();
	const slug = CWD.replace(/[^a-zA-Z0-9]/g, "-");
	const main = p.write(slug, ID, [userLine(0, "task"), ...assistantLines("m1", 1, [{ type: "text", text: "ok" }], u(10, 1))]);
	const subDir = path.join(main.replace(/\.jsonl$/, ""), "subagents");
	fs.mkdirSync(subDir, { recursive: true });
	fs.writeFileSync(path.join(subDir, "agent-a1.jsonl"), [
		{ type: "fork-context-ref", agentId: "a1", parentSessionId: ID },
		...assistantLines("side_1", 2, [{ type: "text", text: "nested" }], u(5, 2), { isSidechain: true }, "claude-haiku-4-5"),
		...assistantLines("m1", 1, [{ type: "text", text: "ok" }], u(10, 1)), // copied context: deduped
	].map((l) => JSON.stringify(l)).join("\n") + "\n");
	fs.writeFileSync(path.join(subDir, "agent-a1.meta.json"), "{}");
	assert.equal(claudeSidechainFiles(main).length, 1);

	const adapter = createClaudeTranscriptAdapter({ root: p.root });
	assert.deepEqual(adapter.capabilities(), { read: true, usage: "tokens-only", perModel: true, cost: false, items: true, resume: "native" });
	const s = await adapter.read(ref(), { items: "tail", limit: 1 });
	assert.equal(s.found, true);
	assert.equal(s.file, fs.realpathSync(main));
	assert.equal(s.usage.input, 15);
	assert.equal(s.usage.output, 3);
	assert.equal(s.usage.cost, undefined);
	assert.equal(s.items?.length, 1);
	assert.equal(s.state, "settled");

	// Claude worker cost after restart: tokens from the transcript, cost from the last snapshot "as of".
	const merged = resolveWorkerUsage(s.usage, usageSnapshot({ input: 12, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.42 }, 777));
	assert.equal(merged.input, 15);
	assert.equal(merged.cost, 0.42);
	assert.equal(merged.costSource, "snapshot");
	assert.equal(merged.costAsOf, 777);
});

test("read: missing record, wrong kind, higher-major ref", async () => {
	const p = projects();
	const adapter = createClaudeTranscriptAdapter({ root: p.root });
	const missing = await adapter.read(ref());
	assert.equal(missing.found, false);
	assert.equal(missing.usage.source, "none");
	assert.equal(adapter.locate(ref({ kind: "pi-session-file", locator: "/x.jsonl" })).file, null);
	assert.equal(adapter.locate(ref({ locator: "not-a-uuid" })).file, null);
	await assert.rejects(adapter.read({ ...ref(), v: 2 } as unknown as WorkerTranscriptRef), WorkerProtocolVersionError);
});

test("parseJsonLines skips a torn last line", () => {
	assert.equal(parseJsonLines('{"a":1}\n{"b":').length, 1);
});
