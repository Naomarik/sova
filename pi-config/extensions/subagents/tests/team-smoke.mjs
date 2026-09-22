// Team loading/shutdown smoke (batch 3b). Offline by default; --live is opt-in.
//
// Offline:
//   1. A real Pi (rpc mode) loads subagents + claude-code together and registers
//      /team alongside /agents, with no stderr and no extension errors.
//   2. In-process wiring with a fake runner (no child processes, no model):
//      team tools register; team_create persists its entry and installs the
//      team widget via refresh(); a settle pushes fresh views through the
//      throttled refresh; /team <objective> sends one extension-origin
//      team-plan message (followUp + triggerTurn); bare /team sends nothing;
//      session_shutdown clears the widget and disposes workers.
//
// --live: additionally runs ONE real, deliberately bounded Claude team member:
// haiku, tools: [], effort: low, wake: false, backendOptions.maxBudgetUsd: 0.5,
// whose whole task is a trivial fixed reply. This is a paid task and only runs
// when explicitly requested; everything it touches lives in a temp cwd.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cli, jiti, root } from "./runtime.mjs";

const LIVE = process.argv.includes("--live");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function deadline(promise, ms, label) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

// ── 1. real Pi loads both extensions; /team and /agents register ─────────────
{
	const claudeRoot = path.resolve(root, "..", "claude-code");
	const child = spawn(
		process.execPath,
		[
			cli,
			"--mode", "rpc", "--no-session", "--no-tools", "--no-extensions",
			"-e", path.join(root, "index.ts"),
			"-e", path.join(claudeRoot, "index.ts"),
		],
		{ cwd: root, stdio: ["pipe", "pipe", "pipe"] },
	);
	const closed = once(child, "close");
	let stderr = "";
	let buffer = "";
	const decoder = new StringDecoder("utf8");
	const startupErrors = [];
	child.stderr.on("data", (b) => {
		stderr += b.toString();
	});
	const commands = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", () => reject(new Error(`Pi closed before RPC response: ${stderr}`)));
		child.stdout.on("data", (chunk) => {
			buffer += decoder.write(chunk);
			let n;
			while ((n = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, n);
				buffer = buffer.slice(n + 1);
				if (!line.trim()) continue;
				let event;
				try {
					event = JSON.parse(line);
				} catch {
					startupErrors.push(line);
					continue;
				}
				if (event.type === "extension_error") startupErrors.push(event.error);
				if (event.type === "response" && event.id === "commands") resolve(event);
			}
		});
	});
	try {
		child.stdin.write(JSON.stringify({ id: "commands", type: "get_commands" }) + "\n");
		const response = await deadline(commands, 30000, "extension startup");
		assert.equal(response.success, true);
		for (const name of ["team", "agents", "subagents"])
			assert.ok(response.data.commands.some((c) => c.name === name), `/${name} must register`);
		assert.deepEqual(startupErrors, []);
		assert.equal(stderr.trim(), "", `Unexpected startup stderr: ${stderr}`);
		console.log("PASS: real Pi loaded both extensions; /team, /agents and /subagents register.");
	} finally {
		child.kill("SIGTERM");
		try {
			await deadline(closed, 5000, "Pi shutdown");
		} catch {
			child.kill("SIGKILL");
			await deadline(closed, 5000, "forced Pi shutdown");
		}
		if (process.platform === "linux") assert.equal(fs.existsSync(`/proc/${child.pid}`), false);
	}
}

// ── 2. in-process widget/command wiring with a fake runner (no model) ────────
{
	const { registerSubagents } = await jiti.import(path.join(root, "index.ts"));
	const { registerClaudeCode } = await jiti.import(path.resolve(root, "..", "claude-code", "index.ts"));
	const { visibleWidth } = await jiti.import("@earendil-works/pi-tui");

	const hooks = new Map();
	const listeners = new Map();
	const tools = new Map();
	const commands = new Map();
	const workers = [];
	const notices = [];
	const messages = [];
	const appended = [];
	const widgets = [];
	const theme = { fg: (_c, s) => s, bold: (s) => s };
	const pi = {
		events: {
			on(name, fn) {
				const set = listeners.get(name) ?? new Set();
				set.add(fn);
				listeners.set(name, set);
				return () => set.delete(fn);
			},
			emit(name, data) {
				for (const fn of listeners.get(name) ?? []) fn(data);
			},
		},
		registerTool: (t) => tools.set(t.name, t),
		registerCommand: (name, command) => commands.set(name, command),
		registerShortcut() {},
		on(name, fn) {
			const list = hooks.get(name) ?? [];
			list.push(fn);
			hooks.set(name, list);
		},
		appendEntry: (customType, data) => appended.push({ customType, data }),
		getActiveTools: () => ["read", "bash"],
		sendMessage: (...m) => messages.push(m),
		sendUserMessage: () => {
			throw new Error("teams must never send user messages");
		},
		registerFlag: () => {},
		getFlag: () => undefined,
	};
	registerClaudeCode(pi);
	registerSubagents(pi, (options, handlers) => {
		const worker = {
			...options,
			wake: options.wake ?? true,
			extensions: options.extensions ?? [],
			forked: Boolean(options.forkSession),
			status: "running",
			error: undefined,
			transcript: [],
			usage: { input: 0, output: 0, turns: 0 },
			steerCount: 0,
			isFinished() {
				return ["killed", "done", "error"].includes(this.status);
			},
			isSettled() {
				return this.isFinished() || this.status === "waiting";
			},
			finalOutput() {
				return this.output ?? "";
			},
			async steer() {
				return { ok: true };
			},
			async kill() {
				this.status = "killed";
			},
			async dispose() {
				await this.kill();
				this.disposed = true;
			},
			settle(error, status = "waiting") {
				this.status = status;
				this.error = error;
				handlers.onSettled(this);
			},
		};
		workers.push(worker);
		return worker;
	});
	const ctx = {
		cwd: root,
		mode: "tui",
		hasUI: true,
		thinkingLevel: "high",
		isIdle: () => true,
		model: { provider: "test", id: "model" },
		sessionManager: { getEntries: () => [], getBranch: () => [], getSessionFile: () => undefined },
		modelRegistry: { find: (p, m) => (p === "test" && m === "model" ? { provider: p, id: m } : undefined) },
		ui: {
			setStatus() {},
			notify: (...a) => notices.push(a),
			setWidget: (key, content, options) => widgets.push({ key, content, options }),
		},
	};
	const call = (name, params = {}) => tools.get(name).execute("smoke", params, undefined, () => {}, ctx);

	try {
		for (const fn of hooks.get("session_start") ?? []) await fn({}, ctx);
		for (const name of ["team_create", "team_add", "team_list"])
			assert.ok(tools.has(name), `${name} must register`);
		assert.ok(commands.has("team"), "/team must register");

		const created = await call("team_create", {
			name: "smoke-team",
			objective: "SMOKE_OBJECTIVE",
			members: [{ role: "builder", prompt: "Smoke build.", ownedPaths: ["src/smoke"], wake: false }],
		});
		assert.equal(created.details.teamId, "team_01");
		assert.equal(created.details.members.length, 1);
		assert.ok(appended.some((e) => e.customType === "subagents-team-v1" && e.data.op === "create"));

		// The refresh inside team_create installs the widget (component form, key "team").
		assert.equal(widgets.length, 1, "exactly one widget install");
		assert.equal(widgets[0].key, "team");
		assert.equal(typeof widgets[0].content, "function");
		const component = widgets[0].content({ requestRender() {} }, theme);
		const initial = component.render(80);
		assert.ok(initial.some((l) => l.includes("smoke-team")), initial.join("\n"));
		assert.ok(initial.some((l) => l.includes("builder") && l.includes("working")));
		assert.ok(initial.every((l) => visibleWidth(l) === 80), "rows exactly 80 cells");

		// A settle rides the throttled refresh into the same widget component.
		workers[0].settle();
		await delay(200);
		const lines = component.render(80).join("\n");
		assert.match(lines, /1 idle/);
		assert.match(lines, /◐ builder/);

		// Bare /team must not send anything.
		const beforeMessages = messages.length;
		ctx.ui.custom = () => new Promise(() => {}); // never resolves; overlay stays open
		void commands.get("team").handler("", ctx);
		await delay(100);
		assert.equal(messages.length, beforeMessages, "bare /team sends nothing");
		// No overlay interference with dialogs: the widget is not an overlay and
		// the workspace hide/show path belongs to batch 2's tests; here we only
		// assert the objective path goes through sendMessage, never user input.
		delete ctx.ui.custom;

		await commands.get("team").handler("SMOKE_REPLAN", ctx);
		const plan = messages.at(-1);
		assert.equal(plan[0].customType, "team-plan");
		assert.equal(plan[0].display, true);
		assert.deepEqual(plan[1], { deliverAs: "followUp", triggerTurn: true });
		assert.match(plan[0].content, /SMOKE_REPLAN/);
		assert.match(plan[0].content, /team_create/);

		for (const fn of hooks.get("session_shutdown") ?? []) await fn({}, ctx);
		assert.equal(widgets.at(-1).key, "team");
		assert.equal(widgets.at(-1).content, undefined, "shutdown clears the widget");
		assert.equal(workers[0].disposed, true, "workers disposed at shutdown");
		console.log("PASS: team tools, widget refresh/shutdown wiring and /team semantics (offline, no model).");
	} finally {
		for (const fn of hooks.get("session_shutdown") ?? []) await Promise.resolve(fn({}, ctx)).catch(() => {});
	}
}

// ── 3. opt-in bounded live team smoke (ONE paid haiku member) ────────────────
if (!LIVE) {
	console.log("SKIP: live team smoke deferred (pass --live to run one bounded haiku member: tools [], effort low, maxBudgetUsd 0.5, wake false).");
} else {
	const { registerSubagents } = await jiti.import(path.join(root, "index.ts"));
	const { registerClaudeCode } = await jiti.import(path.resolve(root, "..", "claude-code", "index.ts"));
	const hooks = new Map();
	const listeners = new Map();
	const tools = new Map();
	const messages = [];
	const pi = {
		events: {
			on(name, fn) {
				const set = listeners.get(name) ?? new Set();
				set.add(fn);
				listeners.set(name, set);
				return () => set.delete(fn);
			},
			emit(name, data) {
				for (const fn of listeners.get(name) ?? []) fn(data);
			},
		},
		registerTool: (t) => tools.set(t.name, t),
		registerCommand() {},
		registerShortcut() {},
		registerFlag() {},
		getFlag: () => undefined,
		on(name, fn) {
			const list = hooks.get(name) ?? [];
			list.push(fn);
			hooks.set(name, list);
		},
		appendEntry() {},
		getActiveTools: () => [],
		sendMessage: (m, o) => messages.push([m, o]),
	};
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-smoke-live-"));
	// No UI at all: a permission prompt would be denied outright, so nothing here
	// may ask for one (tools: [] and the default bypassPermissions ensure that).
	// RPC mode (not print) so worker completions take the normal sendMessage path.
	const ctx = {
		cwd,
		mode: "rpc",
		hasUI: false,
		ui: { notify() {}, setStatus() {} },
		sessionManager: { getEntries: () => [], getBranch: () => [], getSessionFile: () => undefined },
		modelRegistry: {
			find() {
				throw new Error("Claude members must not consult the Pi registry");
			},
		},
	};
	const call = (name, params = {}) => tools.get(name).execute("live", params, undefined, () => {}, ctx);
	try {
		registerClaudeCode(pi);
		registerSubagents(pi);
		for (const fn of hooks.get("session_start") ?? []) await fn({}, ctx);
		const created = await call("team_create", {
			name: "live-smoke",
			objective: "Answer a fixed token (bounded smoke; nothing else).",
			defaults: { backend: "claude-code", model: "haiku", effort: "low", backendOptions: { maxBudgetUsd: 0.5 } },
			members: [{ role: "echo", prompt: "Reply with exactly TEAM_SMOKE_OK and no other text, then stop.", tools: [], wake: false }],
		});
		const memberId = created.details.members[0].workerId;
		assert.equal(created.details.members[0].model, "haiku");
		const waited = await deadline(call("agent_wait", { ids: [memberId], timeoutSeconds: 120 }), 150000, "live member settle");
		assert.equal(waited.details.waited[0].taskOutcome, "success", waited.content[0].text);
		const transcript = await call("agent_transcript", { id: memberId });
		assert.match(transcript.content[0].text, /TEAM_SMOKE_OK/);
		// wake:false must queue the completion without starting a parent turn.
		const completion = messages.find(([m]) => m.customType === "subagent-complete");
		assert.ok(completion, "completion message recorded");
		assert.equal(completion[1].triggerTurn, false);
		const list = await call("team_list");
		assert.match(list.content[0].text, /live-smoke/);
		await call("agent_kill", { id: memberId });
		const listed = await call("team_list");
		assert.equal(listed.details.teams[0].members[0].processAlive, false, "own worker stopped");
		console.log("PASS: one bounded live Claude member ran through team_create and was stopped (haiku, tools [], effort low, maxBudgetUsd 0.5, wake false).");
	} finally {
		for (const fn of hooks.get("session_shutdown") ?? []) await Promise.resolve(fn({}, ctx)).catch(() => {});
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}
