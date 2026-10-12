import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CONTINUATION_OUTPUT_CHARS, claudeOnPi, continuationMessage, continuationOptions, continuationTools, seedContinuationSession,
} from "./claude-workers.ts";

test("claudeOnPi: a claude-code spec as the pi worker it runs as; any other spec as it is", () => {
	const pi = { prompt: "p", model: "zai/glm-5.3" };
	assert.equal(claudeOnPi(pi), pi);
	const out = claudeOnPi({ backend: "claude-code", prompt: "p", tools: ["Read", "Glob", "bash"], effort: "max" });
	assert.equal((out as { backend?: string }).backend, undefined, "recorded as pi");
	assert.match(out.model!, /^claude-code-cli\/claude-sonnet-/, "Sonnet when none is given");
	assert.deepEqual([out.effort, out.tools], ["max", ["read", "find", "bash"]]);
	assert.equal(claudeOnPi({ backend: "claude-code", prompt: "p" }).effort, "medium");
	assert.deepEqual(claudeOnPi({ backend: "claude-code", prompt: "p", backendOptions: { permissionMode: "plan" } }).tools, ["read", "grep", "find", "ls"]);
	assert.throws(() => claudeOnPi({ backend: "claude-code", prompt: "p", effort: "minimal" }), /low, medium, high, xhigh, or max/);
	assert.throws(() => claudeOnPi({ backend: "claude-code", prompt: "p", tools: ["WebFetch"] }), /"WebFetch" has no equivalent/);
	assert.throws(() => claudeOnPi({ backend: "claude-code", prompt: "p", backendOptions: { permissionMode: "manual" } }), /no per-call approval/);
	assert.throws(() => claudeOnPi({ backend: "claude-code", prompt: "p", backendOptions: { maxBudgetUsd: 1 } }), /no spend ceiling/);
	assert.throws(() => claudeOnPi({ backend: "claude-code", prompt: "p", model: "zai/glm-5.3" }), /Claude model ID/);
});

test("a continuation keeps what still means something: mapped tools (others dropped), plan alone of the options", () => {
	assert.equal(continuationTools(undefined), undefined, "none recorded: the default seven");
	assert.deepEqual(continuationTools([]), [], "no tools stays no tools");
	assert.deepEqual(continuationTools(["WebFetch", "WebSearch"]), ["read"], "none maps: read stays, so the handoff's transcript can be opened");
	assert.deepEqual(continuationTools(["Read", "WebFetch", "Edit", "MultiEdit", "Task", "Read"]), ["read", "edit"]);
	assert.deepEqual(continuationOptions({ permissionMode: "plan", maxBudgetUsd: 2 }), { permissionMode: "plan" });
	for (const o of [undefined, null, { permissionMode: "acceptEdits" }, { allowedTools: ["Bash(*)"] }]) assert.equal(continuationOptions(o), undefined);
});

test("the handoff names the old worker, its transcript and task, and only the end of its last answer", () => {
	const text = continuationMessage({ id: "ag_03", name: "rev", role: "reviewer", transcript: "/h/.claude/projects/x/s.jsonl", task: "Review f01.", lastOutput: `${"a".repeat(5000)}END` });
	assert.match(text, /^\[Continuing an earlier Claude Code worker: ag_03 \(rev, reviewer\)\]/);
	assert.match(text, /Its transcript is \/h\/\.claude\/projects\/x\/s\.jsonl \(read-only/);
	assert.match(text, /Its task:\nReview f01\./);
	const answer = text.split("Its last answer:\n")[1]!.split("\n\n")[0]!;
	assert.equal(answer.length, CONTINUATION_OUTPUT_CHARS + 1, "…plus the last 2,000 characters");
	assert.ok(answer.endsWith("END"));
	assert.match(continuationMessage({ id: "ag_04", name: "w" }), /No transcript of its run was found\.\n\nWait for your next instruction/);
});

test("seedContinuationSession: pi's header and one user message, a new file each time, never one that exists", () => {
	const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "seed-")), "sessions", "--p--");
	try {
		const at = new Date("2026-10-12T10:00:00.000Z");
		const file = seedContinuationSession(dir, "/p", "hello", 3, at);
		assert.match(path.basename(file), /^2026-10-12T10-00-00-000Z_[0-9a-f-]{36}\.jsonl$/);
		const [header, message] = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		assert.deepEqual([header.type, header.version, header.cwd, header.timestamp], ["session", 3, "/p", at.toISOString()]);
		assert.deepEqual([message.type, message.parentId, message.message.role, message.message.content], ["message", null, "user", [{ type: "text", text: "hello" }]]);
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		assert.notEqual(seedContinuationSession(dir, "/p", "hello", 3, at), file);
	} finally {
		fs.rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true });
	}
});
