// Offline check: when a code-writing worker finishes with spec on, the parent hears ONE line naming the §
// the worker's own changes landed in (pi and claude-code workers alike); a worker that changed nothing, a
// read-only worker and a spec-off session get no such line, and another process's commit in the worker's
// tree is not the worker's. Fake workers (no processes, no model) run the real worker half of the census
// around their work: a pi worker mode/spec-worker.ts's handlers, a Claude worker claude-code/spec-hooks.ts's
// runHook; the parent is the real subagents extension. Scratch Git projects; the real spec tools.
// Run: node tests/spec-landed.mjs [--json]
import "../../claude-code/tests/hermetic-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jiti, root } from "./runtime.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spec-landed-"));
// The pi worker finds the trusted tools through its agent dir (coreDir), as spec-mode.md's `$core` line does.
const workerAgentDir = path.join(scratch, "worker-agent");
fs.mkdirSync(path.join(workerAgentDir, "extensions"), { recursive: true });
fs.symlinkSync(path.resolve(root, "../spec"), path.join(workerAgentDir, "extensions/spec"));
process.env.PI_CODING_AGENT_DIR = workerAgentDir;
delete process.env.PI_SPEC_CENSUS_HOOK;
const CORE = fs.realpathSync(path.resolve(root, "../spec/core"));

const { registerSubagents } = await jiti.import(path.join(root, "index.ts"));
const { MODE_STATE_EVENT } = await jiti.import(path.join(root, "../mode/state.ts"));
const { BACKEND_REGISTER_EVENT } = await jiti.import(path.join(root, "contracts.ts"));
const { default: specWorker } = await jiti.import(path.join(root, "../mode/spec-worker.ts"));
const { runHook } = await jiti.import(path.join(root, "../claude-code/spec-hooks.ts"));

/** The line the parent gets: "landed in", naming the §. */
const LANDED = /landed in/i;
/** The env var naming a pi worker's landed file (only read off the spawn options, never asserted). */
const LANDED_ENV = "SOVA_SPEC_LANDED_FILE";
const SPEC_ON = { version: 1, mode: "normal", strict: false, minorModes: ["spec"] };
const C = ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"];
const git = (cwd, ...args) => {
	const r = spawnSync("git", ["-C", cwd, ...C, ...args], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	return r.stdout.trim();
};
const write = (cwd, rel, text) => {
	fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
	fs.writeFileSync(path.join(cwd, rel), text);
};
let n = 0;
/** A committed project: boundary `src`, §app/x claiming src/a.txt, §app/y claiming src/b.txt. */
function project() {
	const cwd = path.join(scratch, `p${++n}`);
	write(cwd, ".sova/spec/manifest.json", JSON.stringify({
		formatVersion: 1, grammar: { claimsRoot: "claims/", directoryKinds: ["section"] }, boundary: { include: ["src"], exclude: [] },
		claims: { "§app/x": { kind: "behavior", requires: [], code: ["src/a.txt"] }, "§app/y": { kind: "behavior", requires: [], code: ["src/b.txt"] } },
	}));
	write(cwd, ".sova/spec/claims/app/x.md", "# §app/x\n\nX.\n");
	write(cwd, ".sova/spec/claims/app/y.md", "# §app/y\n\nY.\n");
	write(cwd, "src/a.txt", "a\n");
	write(cwd, "src/b.txt", "b\n");
	write(cwd, ".gitignore", ".sova/spec/drafts/\n");
	git(cwd, "init", "-q", "-b", "main");
	git(cwd, "add", ".");
	git(cwd, "commit", "-qm", "base");
	return cwd;
}

function eventBus() {
	const listeners = new Map();
	return {
		on(name, handler) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(handler); return () => listeners.get(name)?.delete(handler); },
		emit(name, data) { for (const handler of listeners.get(name) ?? []) handler(data); },
	};
}

/** A pi worker's process, as far as the census goes: spec-worker.ts's handlers, with the env the spawn gave it. */
function piWorkerHooks(options) {
	const on = new Map();
	specWorker({ on: (name, fn) => on.set(name, fn) });
	let seq = 0;
	const ctx = { cwd: options.cwd, signal: undefined, sessionManager: { getBranch: () => [], getHeader: () => ({ timestamp: new Date().toISOString() }) } };
	const withEnv = async (fn) => {
		const prior = process.env[LANDED_ENV];
		if (options.env?.[LANDED_ENV]) process.env[LANDED_ENV] = options.env[LANDED_ENV];
		else delete process.env[LANDED_ENV];
		try { return await fn(); } finally { if (prior === undefined) delete process.env[LANDED_ENV]; else process.env[LANDED_ENV] = prior; }
	};
	return {
		start: (first = true) => withEnv(async () => { if (first) await on.get("session_start")?.({}, ctx); await on.get("agent_start")?.({}, ctx); }),
		call: (command, effect) => withEnv(async () => {
			const event = { toolName: "bash", toolCallId: `c${++seq}`, input: { command }, content: [] };
			await on.get("tool_call")?.(event, ctx);
			effect();
			await on.get("tool_result")?.({ ...event, isError: false }, ctx);
			await on.get("tool_execution_end")?.(event, ctx);
		}),
		end: () => on.get("agent_settled")?.({}, ctx),
	};
}
/** A Claude worker's hooks, run as Claude would, on the hook state dir its settings name. */
function claudeWorkerHooks(options, sessionId, stateDir) {
	const o = { core: CORE, stateDir };
	let seq = 0;
	const ev = (extra) => ({ session_id: sessionId, prompt_id: "p1", cwd: options.cwd, ...extra });
	return {
		start: () => runHook("turn", ev({ hook_event_name: "UserPromptSubmit" }), o),
		call: async (command, effect) => {
			const call = { tool_name: "Bash", tool_use_id: `toolu_${++seq}`, tool_input: { command } };
			await runHook("pre", ev({ hook_event_name: "PreToolUse", ...call }), o);
			effect();
			await runHook("post", ev({ hook_event_name: "PostToolUse", ...call, tool_response: {} }), o);
		},
		end: () => undefined,
	};
}

/** A worker double: settle() is its run ending; output is its final answer; hooks are its census half. */
function fakeWorker(options, handlers, extra = {}) {
	return {
		...options, wake: options.wake ?? true, extensions: options.extensions ?? [], status: "running", processAlive: true, transcript: [],
		usage: { input: 0, output: 0, turns: 0 }, steerCount: 0, output: "Done.",
		isFinished() { return ["killed", "done", "error"].includes(this.status); },
		isSettled() { return this.isFinished() || this.status === "waiting"; },
		finalOutput() { return this.output; },
		async steer() { this.steerCount++; this.status = "running"; return { ok: true }; },
		async kill() { this.status = "killed"; },
		async dispose() { this.status = "killed"; },
		settle() { this.status = "waiting"; handlers.onSettled(this); },
		...extra,
	};
}
function harness(cwd) {
	const bus = eventBus();
	const tools = new Map(), events = new Map(), workers = [], messages = [];
	const agentDir = path.join(scratch, `agent${n}`);
	const ctx = {
		cwd, mode: "tui", hasUI: true, thinkingLevel: "high", isIdle: () => true, model: { provider: "test", id: "model" },
		sessionManager: { getEntries: () => [], getBranch: () => [], getSessionFile: () => undefined, getSessionId: () => "parent" },
		modelRegistry: { find: (p, m) => (p === "test" && m === "model" ? { provider: p, id: m } : undefined) },
		ui: { setStatus() {}, notify() {} },
	};
	registerSubagents({
		events: bus, registerTool: (t) => tools.set(t.name, t), on: (e, f) => events.set(e, f), registerCommand() {}, registerShortcut() {}, appendEntry() {},
		getAgentDir: () => agentDir, getActiveTools: () => ["read", "bash", "edit", "write"],
		sendMessage: (...m) => messages.push(m), sendUserMessage() {},
	}, (options, handlers) => {
		const w = fakeWorker(options, handlers);
		w.hooks = piWorkerHooks(options);
		workers.push(w);
		return w;
	}, { policyFile: path.join(scratch, "no-policy.json"), agentDir });
	bus.emit(BACKEND_REGISTER_EVENT, {
		version: 1, id: "claude-code", validate() {}, prepare: (spec) => ({ model: spec.model ?? "claude-sonnet-5-5", backendOptions: { permissionMode: "default" } }),
		create: (options, handlers) => {
			const sessionId = `cc-${n}-${workers.length}`;
			// Its hooks' state dir, as the settings the spawn built name it (none: no hooks run, as for a worker without them).
			const command = options.settingsJson ? JSON.parse(options.settingsJson).hooks?.PostToolUse?.at(-1)?.hooks?.[0]?.command : undefined;
			const stateDir = command?.match(/--state (\S+)/)?.[1]?.replace(/^'|'$/g, "");
			const w = fakeWorker(options, handlers, { sessionId, isFinished() { return this.status === "killed"; }, isSettled() { return this.status !== "running"; } });
			w.hooks = stateDir ? claudeWorkerHooks(options, sessionId, stateDir) : { start() {}, call: async (_c, effect) => effect(), end() {} };
			workers.push(w);
			return w;
		},
	});
	return {
		bus, workers, messages, ctx,
		call: (name, params = {}) => tools.get(name).execute("test", params, undefined, () => {}, ctx),
		close: () => events.get("session_shutdown")?.({}, ctx),
	};
}
const completions = (h) => h.messages.filter(([m]) => m.customType === "subagent-complete").map(([m]) => m.content);
const landedLines = (texts) => texts.join("\n").split("\n").filter((l) => LANDED.test(l));
async function completionsAfter(h, count, ms) {
	const end = Date.now() + ms;
	while (completions(h).length < count && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
	await new Promise((r) => setTimeout(r, 50));
	return completions(h);
}

const results = [];
/**
 * One case: spawn; `before` (another process) runs after the worker started; the worker makes its `calls`
 * through its hooks (pi spec-worker or Claude hooks); settle; count the parent's landed lines.
 */
async function run(label, { spec = true, params = {}, before = () => {}, calls = [], wait = false, again, expect, names = [], absent = [] }) {
	const cwd = project();
	const h = harness(cwd);
	try {
		if (spec) h.bus.emit(MODE_STATE_EVENT, SPEC_ON);
		await h.call("agent_spawn", { prompt: "task", cwd, ...params });
		const w = h.workers.at(-1);
		await w.hooks.start();
		before(cwd);
		for (const [command, effect] of calls) await w.hooks.call(command, () => effect(cwd));
		await w.hooks.end();
		const waiting = wait ? h.call("agent_wait", { ids: [w.id] }) : undefined;
		w.settle();
		const texts = [];
		if (waiting) texts.push((await waiting).content[0].text);
		texts.push(...await completionsAfter(h, wait ? 0 : 1, wait ? 500 : 5_000));
		const heard = texts.some((t) => t.includes(w.id));
		const lines = landedLines(texts);
		const ok = heard && lines.length === expect && names.every((id) => lines.some((l) => l.includes(id))) && absent.every((id) => !lines.some((l) => l.includes(id)));
		const result = { label, heard, landedLines: lines.length, expect, ok, lines };
		// A second task on the same worker (steered), that changes nothing: informational, how often the line repeats.
		if (again) {
			await h.call("agent_steer", { id: w.id, message: "again" });
			await w.hooks.start(false);
			for (const [command, effect] of again) await w.hooks.call(command, () => effect(cwd));
			await w.hooks.end();
			const had = completions(h).length;
			w.settle();
			const all = await completionsAfter(h, had + 1, 5_000);
			result.secondTaskHeard = all.length > had;
			result.secondTaskLandedLines = landedLines(all.slice(had)).length;
		}
		results.push(result);
	} finally { await h.close(); }
}

const ownEdit = ["printf 'mine\\n' > src/a.txt", (cwd) => write(cwd, "src/a.txt", "mine\n")];
const ownCommit = ["printf 'mine\\n' > src/a.txt && git commit -qam mine", (cwd) => { write(cwd, "src/a.txt", "mine\n"); git(cwd, "commit", "-qam", "mine"); }];
const readOnly = ["git log -1 --oneline", () => {}];
const foreign = (cwd) => { write(cwd, "src/b.txt", "theirs\n"); git(cwd, "commit", "-qam", "elsewhere"); };
const CC = { backend: "claude-code" };
try {
	await run("pi worker commits a change to a claimed file", { calls: [ownCommit], expect: 1, names: ["§app/x"], absent: ["§app/y"] });
	await run("pi worker leaves an uncommitted change to a claimed file", { calls: [ownEdit], expect: 1, names: ["§app/x"] });
	await run("claude-code worker commits a change to a claimed file", { params: CC, calls: [ownCommit], expect: 1, names: ["§app/x"], absent: ["§app/y"] });
	await run("claude-code worker leaves an uncommitted change", { params: CC, calls: [ownEdit], expect: 1, names: ["§app/x"] });
	await run("worker collected by agent_wait: the line once across wait result and completion", { calls: [ownCommit], wait: true, expect: 1, names: ["§app/x"] });
	await run("pi: another process commits §app/y's file, then the worker changes §app/x's: only §app/x", { before: foreign, calls: [readOnly, ownEdit], expect: 1, names: ["§app/x"], absent: ["§app/y"] });
	await run("claude-code: another process commits §app/y's file, then the worker changes §app/x's: only §app/x", { params: CC, before: foreign, calls: [readOnly, ownEdit], expect: 1, names: ["§app/x"], absent: ["§app/y"] });
	await run("pi worker changes nothing (read-only calls)", { calls: [readOnly], expect: 0 });
	await run("claude-code worker changes nothing (read-only calls)", { params: CC, calls: [readOnly], expect: 0 });
	await run("pi worker changes nothing, another process commits meanwhile", { before: foreign, calls: [readOnly], expect: 0 });
	await run("read-only worker", { params: { tools: ["read", "grep"] }, calls: [], expect: 0 });
	await run("spec off: a worker's change gets no line", { spec: false, calls: [ownCommit], expect: 0 });
	await run("pi worker, a second task that changes nothing (informational: line repeats?)", { calls: [ownCommit], again: [readOnly], expect: 1, names: ["§app/x"] });
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
if (process.argv.includes("--json")) console.log(JSON.stringify(results, null, 2));
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.label}: ${r.landedLines} landed line(s), expected ${r.expect}${r.heard ? "" : " (parent heard nothing)"}${r.secondTaskLandedLines === undefined ? "" : `; second task: ${r.secondTaskLandedLines}${r.secondTaskHeard ? "" : " (not heard)"}`}${r.lines.length ? ` — ${r.lines.join(" | ")}` : ""}`);
assert.equal(failed.length, 0, `${failed.length} case(s) failed`);
console.log("spec-landed: ok");
