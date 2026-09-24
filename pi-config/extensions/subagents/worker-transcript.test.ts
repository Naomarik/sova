import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	LEGACY_REGISTRY_ENTRY_TYPE,
	UnsupportedCapabilityError,
	WORKER_MANIFEST_ENTRY_TYPE,
	WorkerProtocolVersionError,
	WorkerTranscriptAdapters,
	noneAdapter,
	parseJsonLines,
	isInterrupted,
	hasEnded,
	readWorkerManifests,
	resolvedModel,
	resolveWorkerUsage,
	sumWorkerUsage,
	usageSnapshot,
	viewWorker,
	type WorkerTranscriptAdapter,
	type WorkerTranscriptRef,
} from "./worker-transcript.ts";
import { createPiTranscriptAdapter, piUsage, piUsageAccumulator } from "./adapters/pi.ts";
import { defaultWorkerTranscriptAdapters, workerUsageTally } from "./adapters/index.ts";

// ---------------------------------------------------------------------------
// Fixtures: pi session lines
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-09-24T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const usage = (input: number, output: number, cost: number, cacheRead = 0, cacheWrite = 0) => ({
	input, output, cacheRead, cacheWrite, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});
let seq = 0;
const nextId = () => `e${(++seq).toString(16).padStart(7, "0")}`;

/** Build a linear pi session; each line gets id/parentId unless given. */
function piSession(header: Record<string, unknown>, lines: Record<string, any>[]): string {
	let parent: string | null = null;
	const out = [JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: iso(T0), cwd: "/w", ...header })];
	for (const line of lines) {
		const id = line.id ?? nextId();
		out.push(JSON.stringify({ id, parentId: "parentId" in line ? line.parentId : parent, ...line }));
		parent = id;
	}
	return out.join("\n") + "\n";
}

const assistant = (at: number, u: unknown, extra: Record<string, unknown> = {}, content: unknown[] = [{ type: "text", text: "done" }]) => ({
	type: "message", timestamp: iso(at),
	message: { role: "assistant", provider: "ollama-cloud", model: "kimi-k3", content, usage: u, stopReason: "stop", ...extra },
});
const user = (at: number, text: string) => ({ type: "message", timestamp: iso(at), message: { role: "user", content: [{ type: "text", text }] } });
const marker = (at: number) => ({ type: "custom", customType: "subagents-worker-session", data: { v: 1, workerId: "ag_02" }, timestamp: iso(at) });

function tmpFile(name: string, text: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-transcript-"));
	const file = path.join(dir, name);
	fs.writeFileSync(file, text);
	return file;
}
const piRef = (file: string): WorkerTranscriptRef => ({ v: 1, backend: "pi", kind: "pi-session-file", locator: file });

// ---------------------------------------------------------------------------
// pi adapter
// ---------------------------------------------------------------------------

test("pi usage: exact with cost, per model, cache-warm usage entries included, dedupe by entry id", () => {
	const dup = assistant(T0 + 2000, usage(100, 10, 0.5));
	const lines = parseJsonLines(piSession({}, [
		{ type: "model_change", provider: "ollama-cloud", modelId: "kimi-k3", timestamp: iso(T0) },
		user(T0 + 1000, "task"),
		{ ...dup, id: "dup1" },
		{ type: "usage", kind: "cache_warm", provider: "anthropic", model: "claude-sonnet-5", usage: usage(0, 0, 0.01, 0, 500), timestamp: iso(T0 + 3000) },
		{ type: "message", timestamp: iso(T0 + 4000), message: { role: "toolResult", toolName: "delegate", content: [], usage: usage(7, 3, 0.02) } },
		{ type: "compaction", summary: "s", firstKeptEntryId: "x", tokensBefore: 1, usage: usage(20, 5, 0.1), timestamp: iso(T0 + 5000) },
	]));
	// The same entry appended twice (a re-read tail) counts once.
	const again = lines.find((e: any) => e.id === "dup1");
	const u = piUsage([...lines, again]);
	assert.equal(u.source, "transcript");
	assert.deepEqual([u.input, u.output, u.cacheRead, u.cacheWrite], [127, 18, 0, 500]);
	assert.ok(Math.abs((u.cost ?? 0) - 0.63) < 1e-9);
	assert.equal(u.turns, 1);
	const warm = u.byModel.find((r) => r.model === "anthropic/claude-sonnet-5");
	assert.equal(warm?.cacheWrite, 500);
	assert.equal(u.byModel.find((r) => r.model === "ollama-cloud/kimi-k3")?.input, 127);
	assert.equal(u.policy?.cacheWarm, true);
	assert.equal(u.policy?.forkBoundary, false);
});

test("pi usage: a forked worker counts only entries after its own marker", () => {
	const text = piSession({ parentSession: "/parent.jsonl", timestamp: iso(T0 + 60_000) }, [
		user(T0, "parent task"),
		assistant(T0 + 1000, usage(1000, 100, 5)), // copied from the parent
		marker(T0 + 60_001),
		user(T0 + 61_000, "worker task"),
		assistant(T0 + 62_000, usage(10, 1, 0.01)),
	]);
	const u = piUsage(parseJsonLines(text));
	assert.deepEqual([u.input, u.output], [10, 1]);
	assert.equal(u.cost, 0.01);
	assert.equal(u.policy?.forkBoundary, true);
	// Opting out (a main session that was /fork-ed) counts everything.
	assert.equal(piUsage(parseJsonLines(text), { forkBoundary: false }).input, 1010);
});

test("pi usage: a fork with no marker falls back to the fork header's time", () => {
	const text = piSession({ parentSession: "/parent.jsonl", timestamp: iso(T0 + 60_000) }, [
		assistant(T0 + 1000, usage(1000, 100, 5)),
		assistant(T0 + 62_000, usage(10, 1, 0.01)),
	]);
	assert.equal(piUsage(parseJsonLines(text)).input, 10);
});

test("pi usage accumulator: incremental adds equal a whole read; reset starts over", () => {
	const all = parseJsonLines(piSession({}, [user(T0, "t"), assistant(T0 + 1, usage(5, 5, 0)), assistant(T0 + 2, usage(6, 6, 0))]));
	const acc = piUsageAccumulator();
	acc.add(all.slice(0, 2));
	acc.add(all.slice(2));
	assert.equal(acc.usage().input, 11);
	acc.reset();
	assert.equal(acc.usage().input, 0);
});

test("pi read: summary of the active branch, fork-own items, settled/in-progress", async () => {
	const file = tmpFile("w.jsonl", piSession({ parentSession: "/p.jsonl", timestamp: iso(T0 + 10_000) }, [
		{ id: "a", ...user(T0, "parent says hi") },
		{ id: "b", ...assistant(T0 + 1, usage(1, 1, 0), {}, [{ type: "text", text: "parent reply" }]) },
		{ id: "m", ...marker(T0 + 10_001) },
		{ id: "c", thinkingLevel: "high", type: "thinking_level_change", timestamp: iso(T0 + 10_002) },
		{ id: "d", ...user(T0 + 11_000, "worker task") },
		{ id: "x", ...assistant(T0 + 12_000, usage(3, 3, 0), {}, [{ type: "text", text: "abandoned branch" }]) },
		// rewind: a sibling of x wins as the leaf
		{ id: "e", parentId: "d", ...assistant(T0 + 13_000, usage(4, 4, 0.1), { stopReason: "toolUse" }, [{ type: "text", text: "working" }, { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }]) },
	]));
	const adapter = createPiTranscriptAdapter();
	const s = await adapter.read(piRef(file), { items: "all" });
	assert.equal(s.found, true);
	assert.equal(s.state, "in-progress");
	assert.equal(s.partialTurn, true);
	assert.equal(s.effort, "high");
	assert.equal(s.model, "ollama-cloud/kimi-k3");
	assert.equal(s.lastAssistantText, "working");
	assert.equal(s.startedAt, T0 + 10_000);
	assert.equal(s.lastActivityAt, T0 + 13_000);
	// Usage is the whole file after the boundary, the abandoned branch included.
	assert.equal(s.usage.input, 7);
	assert.deepEqual(s.items?.map((i) => i.kind), ["task", "assistant", "tool"]);
	assert.equal(s.items?.[0]?.text, "worker task");
	assert.equal(s.items?.[2]?.toolName, "bash");
	assert.ok((s.sizeBytes ?? 0) > 0);

	const tail = await adapter.read(piRef(file), { items: "tail", limit: 1 });
	assert.equal(tail.items?.length, 1);

	const settled = tmpFile("s.jsonl", piSession({}, [user(T0, "t"), assistant(T0 + 1, usage(1, 1, 0), { stopReason: "error", errorMessage: "boom" })]));
	const s2 = await adapter.read(piRef(settled), { items: "all" });
	assert.equal(s2.state, "settled");
	assert.equal(s2.lastOutcome, "error");
	assert.equal(s2.partialTurn, false);
	assert.equal(s2.items?.at(-1)?.kind, "error");
});

test("pi read: missing file and wrong ref kind are found:false with source none, never 0 usage-as-truth", async () => {
	const adapter = createPiTranscriptAdapter();
	const missing = await adapter.read(piRef("/nonexistent/x.jsonl"));
	assert.equal(missing.found, false);
	assert.equal(missing.usage.source, "none");
	assert.equal(adapter.locate({ v: 1, backend: "pi", kind: "claude-session-id", locator: "abc" }).file, null);
	assert.equal(adapter.locate(piRef("relative.jsonl")).file, null);
});

// ---------------------------------------------------------------------------
// Versioning, capabilities, registry
// ---------------------------------------------------------------------------

test("a ref of a higher major is refused with a typed error", async () => {
	const adapter = createPiTranscriptAdapter();
	const ref = { v: 2, backend: "pi", kind: "pi-session-file", locator: "/x" } as unknown as WorkerTranscriptRef;
	assert.throws(() => adapter.locate(ref), WorkerProtocolVersionError);
	await assert.rejects(adapter.read(ref), WorkerProtocolVersionError);
});

test("an adapter of a higher major is refused at registration", () => {
	const future = { ...noneAdapter("x"), protocol: 2 } as unknown as WorkerTranscriptAdapter;
	assert.throws(() => new WorkerTranscriptAdapters([future]), WorkerProtocolVersionError);
});

test("unknown backend: the none adapter declares nothing and read throws UnsupportedCapabilityError", async () => {
	const adapters = defaultWorkerTranscriptAdapters();
	assert.deepEqual(adapters.backends().sort(), ["claude-code", "pi"]);
	const none = adapters.get("codex");
	assert.equal(none.backend, "codex");
	assert.equal(adapters.has("codex"), false);
	assert.deepEqual(none.capabilities(), { read: false, usage: "none", perModel: false, cost: false, items: false, resume: "none" });
	assert.equal(none.locate({ v: 1, backend: "codex", kind: "x", locator: "y" }).file, null);
	await assert.rejects(none.read({ v: 1, backend: "codex", kind: "x", locator: "y" }), (error: unknown) =>
		error instanceof UnsupportedCapabilityError && error.backend === "codex" && error.capability === "read");
});

test("viewWorker: unknown backend is unavailable with usage from the snapshot or none, never a fake 0", async () => {
	const adapters = defaultWorkerTranscriptAdapters();
	const bare = await viewWorker({ v: 1, workerId: "ag_09", backend: "codex", at: 1 }, adapters);
	assert.match(bare.unavailable ?? "", /no transcript adapter/);
	assert.equal(bare.usage.source, "none");
	const snap = await viewWorker({ v: 1, workerId: "ag_09", backend: "codex", at: 1, usageSnapshot: usageSnapshot({ input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.2 }, 42) }, adapters);
	assert.equal(snap.usage.source, "snapshot");
	assert.equal(snap.usage.asOf, 42);
	assert.equal(snap.usage.cost, 0.2);
});

test("viewWorker: a pi worker reads its transcript", async () => {
	const file = tmpFile("v.jsonl", piSession({}, [user(T0, "t"), assistant(T0 + 1, usage(9, 1, 0.3))]));
	const view = await viewWorker({ v: 1, workerId: "ag_01", backend: "pi", at: 1, ref: piRef(file) }, defaultWorkerTranscriptAdapters());
	assert.equal(view.unavailable, undefined);
	assert.equal(view.summary?.state, "settled");
	assert.equal(view.usage.source, "transcript");
	assert.equal(view.usage.input, 9);
});

// ---------------------------------------------------------------------------
// Usage helpers
// ---------------------------------------------------------------------------

test("resolveWorkerUsage: transcript tokens, snapshot cost marked as-of when the transcript has none", () => {
	const fromTranscript = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, byModel: [], source: "transcript" as const };
	const snap = usageSnapshot({ input: 8, output: 2, cacheRead: 0, cacheWrite: 0, cost: 1.5 }, 1000);
	const merged = resolveWorkerUsage(fromTranscript, snap);
	assert.equal(merged.input, 10);
	assert.equal(merged.cost, 1.5);
	assert.equal(merged.costSource, "snapshot");
	assert.equal(merged.costAsOf, 1000);
	// A transcript with its own cost keeps it.
	assert.equal(resolveWorkerUsage({ ...fromTranscript, cost: 0.1 }, snap).cost, 0.1);
	assert.equal(resolveWorkerUsage(undefined, undefined).source, "none");
});

test("sumWorkerUsage: rows merge by model; source is the weakest seen", () => {
	const a = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 1, byModel: [{ model: "m", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }], source: "transcript" as const };
	const b = { ...usageSnapshot({ input: 2, output: 0, cacheRead: 0, cacheWrite: 0 }, 5), byModel: [{ model: "m", input: 2, output: 0, cacheRead: 0, cacheWrite: 0 }] };
	const sum = sumWorkerUsage([a, b]);
	assert.equal(sum.input, 3);
	assert.equal(sum.cost, 1);
	assert.equal(sum.source, "snapshot");
	assert.deepEqual(sum.byModel, [{ model: "m", input: 3, output: 1, cacheRead: 0, cacheWrite: 0 }]);
	assert.equal(sumWorkerUsage([]).source, "none");
});

// ---------------------------------------------------------------------------
// Manifest fold
// ---------------------------------------------------------------------------

const custom = (customType: string, data: unknown, id?: string) => ({ type: "custom", customType, data, ...(id ? { id } : {}) });

test("readWorkerManifests: newest wins per field; spec/team merge one level; legacy registry records fold in", () => {
	const entries = [
		custom(LEGACY_REGISTRY_ENTRY_TYPE, {
			v: 1, kind: "worker-registry", workerId: "ag_01", backend: "claude-code", groupId: "run_01", at: 1,
			backendSessionId: "0b7a2b8e-6d0e-4a4e-9f55-3f0b6b1e2a11", spec: { name: "old", cwd: "/w", task: "t", taskChars: 1, wake: true, teamId: "team_01", role: "r" },
		}, "l1"),
		custom(WORKER_MANIFEST_ENTRY_TYPE, {
			v: 1, kind: "worker-manifest", workerId: "ag_02", backend: "pi", at: 2, name: "pi-w",
			spec: { cwd: "/w", model: "ollama-cloud/kimi-k3", taskPreview: "go", wake: false, sandbox: { on: true } },
			team: { teamId: "team_01", role: "a" },
		}, "m1"),
		custom(WORKER_MANIFEST_ENTRY_TYPE, { v: 1, kind: "worker-manifest", workerId: "ag_02", backend: "pi", at: 3, ref: { v: 1, backend: "pi", kind: "pi-session-file", locator: "/f.jsonl" }, spec: { effort: "high" }, team: { orchestrator: true } }, "m2"),
		custom(WORKER_MANIFEST_ENTRY_TYPE, { v: 1, kind: "worker-manifest", workerId: "ag_02", backend: "pi", at: 4, status: "waiting", usageSnapshot: usageSnapshot({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.5 }, 4) }, "m3"),
		custom(WORKER_MANIFEST_ENTRY_TYPE, { v: 2, kind: "worker-manifest", workerId: "ag_03", backend: "pi", at: 5 }, "m4"),
		custom(WORKER_MANIFEST_ENTRY_TYPE, { v: 1, kind: "worker-manifest", backend: "pi", at: 5 }, "junk"),
		{ type: "message", id: "z" },
	];
	const { manifests, refused } = readWorkerManifests(entries, { activeEntryIds: new Set(["m1", "z"]) });
	assert.equal(refused, 1);
	assert.deepEqual([...manifests.keys()], ["ag_01", "ag_02"]);
	const legacy = manifests.get("ag_01")!;
	assert.equal(legacy.name, "old");
	assert.deepEqual(legacy.ref, { v: 1, backend: "claude-code", kind: "claude-session-id", locator: "0b7a2b8e-6d0e-4a4e-9f55-3f0b6b1e2a11", cwd: "/w" });
	assert.deepEqual(legacy.team, { teamId: "team_01", role: "r" });
	assert.equal(legacy.spec?.taskPreview, "t");
	assert.equal(legacy.onActiveBranch, false);
	const w = manifests.get("ag_02")!;
	assert.equal(w.at, 4);
	assert.equal(w.status, "waiting");
	assert.equal(w.spec?.model, "ollama-cloud/kimi-k3");
	assert.equal(w.spec?.effort, "high");
	assert.deepEqual(w.spec?.sandbox, { on: true });
	assert.deepEqual(w.team, { teamId: "team_01", role: "a", orchestrator: true });
	assert.equal(w.ref?.locator, "/f.jsonl");
	assert.equal(w.usageSnapshot?.source, "snapshot");
	assert.equal(w.onActiveBranch, true);
	assert.equal("kind" in w, false);
	// Without activeEntryIds no branch flag is set.
	assert.equal(readWorkerManifests(entries).manifests.get("ag_02")?.onActiveBranch, undefined);
});

test("readWorkerManifests: a resume record clears the ending; launch is replaced whole; interrupted vs ended", () => {
	const rec = (at: number, fields: Record<string, unknown>) => custom(WORKER_MANIFEST_ENTRY_TYPE, { v: 1, kind: "worker-manifest", workerId: "ag_04", backend: "claude-code", at, ...fields });
	const entries = [
		rec(1, { status: "running", launch: { systemPrompt: "a", tools: ["x"] }, spec: { cwd: "/w", taskPreview: "t", wake: true } }),
		rec(2, { status: "waiting", settledAt: 2, taskOutcome: "success" }),
		rec(3, { status: "error", endedAt: 3, error: "boom", taskOutcome: "error" }),
	];
	const ended = readWorkerManifests(entries).manifests.get("ag_04")!;
	assert.equal(hasEnded(ended), true);
	assert.equal(isInterrupted(ended), false);
	assert.equal(ended.settledAt, 2);

	const resumed = readWorkerManifests([...entries, rec(4, { resumedAt: 4, status: "waiting", launch: { systemPrompt: "b" } })]).manifests.get("ag_04")!;
	assert.equal(resumed.status, "waiting");
	assert.equal(resumed.endedAt, undefined);
	assert.equal(resumed.error, undefined);
	assert.equal(resumed.taskOutcome, undefined);
	assert.equal(resumed.resumedAt, 4);
	assert.equal(resumed.settledAt, 2);
	assert.deepEqual(resumed.launch, { systemPrompt: "b" });
	assert.equal(resumed.spec?.cwd, "/w");

	assert.equal(isInterrupted(readWorkerManifests(entries.slice(0, 1)).manifests.get("ag_04")!), true);
	assert.equal(isInterrupted({ status: "lost" }), true);
	assert.equal(isInterrupted({ status: "waiting" }), false);
});

test("workerUsageTally: snapshot restarts, append adds, lines straddling appends count once", () => {
	const text = piSession({}, [user(T0, "t"), assistant(T0 + 1, usage(5, 1, 0.1)), assistant(T0 + 2, usage(7, 1, 0.2))]);
	const lines = text.split("\n");
	const tally = workerUsageTally("pi");
	assert.equal(tally(lines.slice(0, 3).join("\n") + "\n", "snapshot").input, 5);
	assert.equal(tally(lines.slice(2).join("\n"), "append").input, 12); // line 3 again: deduped
	assert.equal(tally(text, "snapshot").input, 12);
	const claude = workerUsageTally("claude-code");
	const line = JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-sonnet-5", usage: { input_tokens: 3, output_tokens: 1 } } });
	claude(line + "\n", "snapshot");
	assert.equal(claude(line + "\n", "append").input, 3);
});

test("resolvedModel: transcript reply, else the biggest snapshot row, else the spec; claude/ prefix dropped for claude-code only", () => {
	const row = (model: string, input: number) => ({ model, input, output: 0, cacheRead: 0, cacheWrite: 0 });
	const claude = { v: 1 as const, workerId: "ag_01", backend: "claude-code", at: 1, spec: { cwd: "/w", model: "sonnet", taskPreview: "t", wake: true } };
	const summary = (model?: string) => ({ summary: { ...(model ? { model } : {}) } as any });
	assert.equal(resolvedModel(claude, summary("claude/claude-sonnet-5")), "claude-sonnet-5");
	const snap = { ...usageSnapshot({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 1), byModel: [row("claude/small", 1), row("claude/big", 9)] };
	assert.equal(resolvedModel({ ...claude, usageSnapshot: snap }, summary()), "big");
	assert.equal(resolvedModel(claude, undefined), "sonnet");
	assert.equal(resolvedModel({ ...claude, backend: "pi" }, summary("claude/x")), "claude/x");
	assert.equal(resolvedModel({ v: 1, workerId: "ag_02", backend: "pi", at: 1 }, undefined), undefined);
});
