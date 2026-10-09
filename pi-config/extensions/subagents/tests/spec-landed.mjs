// Offline check: when a code-writing worker finishes with spec on, the parent hears ONE line naming the §
// the worker's own changes landed in (pi and claude-code workers alike); a worker that changed nothing, a
// read-only worker and a spec-off session get no such line. Fake workers (no processes, no model) on a
// scratch Git project; the real spec tools. Run: node tests/spec-landed.mjs
import "../../claude-code/tests/hermetic-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jiti, root } from "./runtime.mjs";

const { registerSubagents } = await jiti.import(path.join(root, "index.ts"));
const { MODE_STATE_EVENT } = await jiti.import(path.join(root, "../mode/state.ts"));
const { BACKEND_REGISTER_EVENT } = await jiti.import(path.join(root, "contracts.ts"));

/** The line the parent gets: "landed in", naming the §. */
const LANDED = /landed in/i;
const SPEC_ON = { version: 1, mode: "normal", strict: false, minorModes: ["spec"] };
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spec-landed-"));
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
/** A worker double: settle() is its run ending; output is its final answer. */
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
	}, (options, handlers) => { const w = fakeWorker(options, handlers); workers.push(w); return w; },
	{ policyFile: path.join(scratch, "no-policy.json"), agentDir });
	bus.emit(BACKEND_REGISTER_EVENT, {
		version: 1, id: "claude-code", validate() {}, prepare: (spec) => ({ model: spec.model ?? "claude-sonnet-5-5", backendOptions: { permissionMode: "default" } }),
		create: (options, handlers) => { const w = fakeWorker(options, handlers, { isFinished() { return this.status === "killed"; }, isSettled() { return this.status !== "running"; } }); workers.push(w); return w; },
	});
	return {
		bus, workers, messages, ctx,
		call: (name, params = {}) => tools.get(name).execute("test", params, undefined, () => {}, ctx),
		close: () => events.get("session_shutdown")?.({}, ctx),
	};
}
const completions = (h) => h.messages.filter(([m]) => m.customType === "subagent-complete").map(([m]) => m.content);
const landedLines = (texts) => texts.join("\n").split("\n").filter((l) => LANDED.test(l));
const settleQuiet = () => new Promise((r) => setTimeout(r, 50));
/** Completions come once the worker's census has run: wait for `count` of them (or the deadline). */
async function completionsAfter(h, count, ms = 15_000) {
	const end = Date.now() + ms;
	while (completions(h).length < count && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
	await settleQuiet();
	return completions(h);
}

const results = [];
/** One case: spawn, let `work` change the tree while the worker runs, settle, count the parent's landed lines. */
async function run(label, { spec = true, params = {}, work = () => {}, wait = false, expect, names = [], absent = [] }) {
	const cwd = project();
	const h = harness(cwd);
	try {
		if (spec) h.bus.emit(MODE_STATE_EVENT, SPEC_ON);
		await h.call("agent_spawn", { prompt: "task", ...params });
		const w = h.workers.at(-1);
		work(cwd);
		const waiting = wait ? h.call("agent_wait", { ids: [w.id] }) : undefined;
		w.settle();
		const texts = [];
		if (waiting) texts.push((await waiting).content[0].text);
		texts.push(...await completionsAfter(h, wait ? 0 : 1, wait ? 2_000 : 15_000));
		const lines = landedLines(texts);
		// The parent heard the worker at all (a wait result or a completion), else 0 lines proves nothing.
		const ok = texts.some((t) => t.includes(w.id)) && lines.length === expect && names.every((id) => lines.some((l) => l.includes(id))) && absent.every((id) => !lines.some((l) => l.includes(id)));
		results.push({ label, landedLines: lines.length, expect, ok, lines });
	} finally { await h.close(); }
}

const ownEdit = (cwd) => write(cwd, "src/a.txt", "mine\n");
const ownCommit = (cwd) => { write(cwd, "src/a.txt", "mine\n"); git(cwd, "commit", "-qam", "mine"); };
try {
	await run("pi worker commits a change to a claimed file", { work: ownCommit, expect: 1, names: ["§app/x"], absent: ["§app/y"] });
	await run("pi worker leaves an uncommitted change to a claimed file", { work: ownEdit, expect: 1, names: ["§app/x"] });
	await run("claude-code worker changes a claimed file", { params: { backend: "claude-code" }, work: ownEdit, expect: 1, names: ["§app/x"] });
	await run("worker collected by agent_wait: the line once across wait result and completion", { work: ownCommit, wait: true, expect: 1, names: ["§app/x"] });
	await run("pi worker changes nothing", { expect: 0 });
	await run("claude-code worker changes nothing", { params: { backend: "claude-code" }, expect: 0 });
	await run("read-only worker", { params: { tools: ["read", "grep"] }, expect: 0 });
	await run("spec off: a worker's change gets no line", { spec: false, work: ownCommit, expect: 0 });
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
if (process.argv.includes("--json")) console.log(JSON.stringify(results, null, 2));
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.label}: ${r.landedLines} landed line(s), expected ${r.expect}${r.lines.length ? ` — ${r.lines.join(" | ")}` : ""}`);
assert.equal(failed.length, 0, `${failed.length} case(s) failed`);
console.log("spec-landed: ok");
