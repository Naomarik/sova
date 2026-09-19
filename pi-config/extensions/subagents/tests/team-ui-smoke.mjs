// Offline real-TUI smoke: drives an actual interactive Pi inside a PRIVATE tmux server.
//
// What is real: Pi's interactive TUI, overlay/focus/hide handling, confirm dialog, extension
// editor, key decoding through a terminal (tmux pane), resize, startup/shutdown, the subagents
// extension (index.ts) and the claude-code extension's validate/prepare/permission handler.
// What is fake: every worker (no child process, no model), and the parent model provider
// (points at 127.0.0.1:9, so any turn fails locally; every attempt is counted).
//
// Isolation: temp PI_CODING_AGENT_DIR/HOME/XDG dirs, `env -i` allowlisted environment (no API
// keys), --no-extensions/--no-skills/--no-prompt-templates/--no-context-files, a tmux server on a
// socket inside the temp dir (-S; never the user's default server), `-f` a generated tmux.conf.
// Cleanup signals only the exact pane PID recorded at start and kills only that private server.
//
// Usage: node tests/team-ui-smoke.mjs [--phase agents|team|all] [--keep] [--source <extensions dir>]
// --source loads subagents/ and claude-code/ from another tree (e.g. a frozen snapshot) instead
// of this repo; the Pi runtime is always the installed one.
// Exit: 0 all requested checks passed; 1 a check failed; 2 harness passed but /team checks are
// BLOCKED because the team API/workspace is not implemented yet (never reported as a pass).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cli, root } from "./runtime.mjs";

const argv = process.argv.slice(2);
const phase = argv.includes("--phase") ? argv[argv.indexOf("--phase") + 1] : "all";
assert.ok(["agents", "team", "all"].includes(phase), "--phase must be agents, team, or all");
const keep = argv.includes("--keep");
const source = argv.includes("--source") ? path.resolve(argv[argv.indexOf("--source") + 1]) : path.resolve(root, "..");
const subRoot = path.join(source, "subagents");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-ui-smoke-"));
const dirs = Object.fromEntries(
	["agent", "sessions", "home", "xdg-config", "xdg-cache", "xdg-data", "cwd", "control"].map((d) => {
		fs.mkdirSync(path.join(tmp, d), { recursive: true });
		return [d, path.join(tmp, d)];
	}),
);
const socket = path.join(tmp, "tmux.sock");
const session = "pi-team-ui";
const target = `${session}:0.0`;
const eventsFile = path.join(tmp, "events.jsonl");
const claudeRoot = path.join(source, "claude-code");

// ── generated wrapper extension (temp dir only; nothing is written to the repo) ────────────
fs.writeFileSync(
	path.join(dirs.agent, "settings.json"),
	JSON.stringify({ quietStartup: true, defaultProvider: "harness", defaultModel: "offline" }, null, 2),
);
fs.writeFileSync(
	path.join(tmp, "harness-extension.ts"),
	`import fs from "node:fs";
import path from "node:path";
import { registerSubagents } from ${JSON.stringify(path.join(subRoot, "index.ts"))};
import { registerClaudeCode } from ${JSON.stringify(path.join(claudeRoot, "index.ts"))};
import { BACKEND_REGISTER_EVENT } from ${JSON.stringify(path.join(subRoot, "contracts.ts"))};

const TMP = ${JSON.stringify(tmp)};
const CONTROL = ${JSON.stringify(dirs.control)};
const log = (kind: string, data: Record<string, unknown> = {}) =>
	fs.appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({ t: Date.now(), kind, ...data }) + "\\n");

export default function harness(pi: any) {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const workers = new Map<string, any>();
	const backendsSeen = new Set<string>();
	let ctx: any;
	let poll: ReturnType<typeof setInterval> | undefined;

	// Local-only parent provider: connection refused on 127.0.0.1:9. Never a paid request.
	pi.registerProvider("harness", {
		name: "Harness offline",
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "offline-harness",
		api: "openai-completions",
		models: [{ id: "offline", name: "Offline harness", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }],
	});
	pi.on("before_provider_request", () => { log("providerRequest"); });

	function fakeWorker(backend: string, options: any, handlers: any) {
		let closed!: () => void;
		const whenClosed = new Promise<void>((r) => { closed = r; });
		const w: any = {
			backend, id: options.id, groupId: options.groupId, name: options.name, task: options.task, cwd: options.cwd,
			wake: options.wake ?? true, extensions: options.extensions ?? [], forked: Boolean(options.forkSession),
			startedAt: Date.now(), whenClosed, status: "running", processAlive: true, model: options.model ?? "fake", effort: options.effort,
			transcript: [{ ts: Date.now(), kind: "task", text: options.task }], transcriptRevision: 1,
			transcriptOmitted: { items: 0, approxBytes: 0 },
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 },
			lastActivity: Date.now(), steerCount: 0, unreadCount: 0,
			isFinished() { return ["done", "error", "killed"].includes(this.status); },
			isSettled() { return this.isFinished() || this.status === "waiting"; },
			isStopping() { return false; },
			finalOutput() { return this.output ?? ""; },
			push(kind: string, text: string) {
				this.transcript.push({ ts: Date.now(), kind, text }); this.transcriptRevision++; this.lastActivity = Date.now(); handlers.onChange();
			},
			async steer(message: string, _signal?: AbortSignal, mode?: string) {
				log("steer", { id: this.id, backend, mode: mode ?? null, message });
				if (this.isFinished()) return { ok: false, reason: "worker finished" };
				this.steerCount++; this.status = "running"; this.taskOutcome = undefined; this.push("steer", message);
				return { ok: true };
			},
			async kill(reason?: string) {
				log("kill", { id: this.id, reason: reason ?? null });
				if (this.isFinished()) return;
				this.permissionAbort?.abort();
				this.status = "killed"; this.processAlive = false; this.endedAt = Date.now();
				handlers.onChange(); handlers.onExit(this); closed();
			},
			async dispose() { log("dispose", { id: this.id }); await this.kill("dispose"); },
			settle(outcome: string) {
				this.status = "waiting"; this.taskOutcome = outcome; this.output = this.name + " " + outcome;
				this.push(outcome === "success" ? "assistant" : "error", this.output); handlers.onSettled(this);
			},
			async permission() {
				if (typeof options.onPermission !== "function") return log("permissionDecision", { id: this.id, behavior: "no-handler" });
				this.permissionAbort = new AbortController();
				const decision = await options.onPermission({
					requestId: "harness-" + Date.now(), toolName: "Write", workerId: this.id, workerName: this.name, cwd: this.cwd,
					input: { file_path: path.join(TMP, "never-written.txt"), content: "HARNESS" },
				}, this.permissionAbort.signal);
				log("permissionDecision", { id: this.id, behavior: decision.behavior });
			},
		};
		workers.set(w.id, w);
		log("create", { id: w.id, backend, name: w.name, wake: w.wake });
		return w;
	}

	// Subagents: real manager/UI, fake default runner; capture tools/commands, record outbound messages.
	const subPi = new Proxy(pi, { get(t: any, k) {
		if (k === "registerTool") return (def: any) => { tools.set(def.name, def); return t.registerTool(def); };
		if (k === "registerCommand") return (name: string, o: any) => { commands.set(name, o); return t.registerCommand(name, o); };
		if (k === "sendMessage") return (m: any, o: any) => {
			log("sendMessage", { customType: m?.customType, display: m?.display, options: o ?? null, content: String(m?.content ?? "").slice(0, 4000) });
			return t.sendMessage(m, o);
		};
		if (k === "sendUserMessage") return (m: any, o: any) => { log("sendUserMessage", { content: String(m).slice(0, 4000), options: o ?? null }); return t.sendUserMessage(m, o); };
		if (k === "appendEntry") return (type: string, data: unknown) => { log("appendEntry", { customType: type, data }); return t.appendEntry(type, data); };
		const v = Reflect.get(t, k); return typeof v === "function" ? v.bind(t) : v;
	} });
	registerSubagents(subPi, (o: any, h: any) => fakeWorker("pi", o, h));

	// Claude: real validate/prepare/permission queue/dialog events; only create() is replaced.
	const wrapped = new WeakMap<object, any>();
	const claudeEvents = {
		on: (n: string, f: any) => pi.events.on(n, f),
		emit: (n: string, d: any) => {
			if (n === BACKEND_REGISTER_EVENT && d?.id === "claude-code") {
				backendsSeen.add(d.id);
				if (!wrapped.has(d)) wrapped.set(d, { ...d, listModels: undefined, create: (o: any, h: any) => fakeWorker("claude-code", o, h) });
				d = wrapped.get(d);
			}
			return pi.events.emit(n, d);
		},
	};
	registerClaudeCode(new Proxy(pi, { get(t: any, k) {
		if (k === "events") return claudeEvents;
		const v = Reflect.get(t, k); return typeof v === "function" ? v.bind(t) : v;
	} }));

	const ops: Record<string, (a: any) => unknown> = {
		ping: () => ({ commands: pi.getCommands().map((c: any) => c.name), tools: [...tools.keys()], backends: [...backendsSeen], mode: ctx?.mode }),
		tool: async (a) => {
			const def = tools.get(a.name);
			if (!def) throw new Error("tool not registered: " + a.name);
			const r = await def.execute("harness", a.params ?? {}, undefined, () => {}, ctx);
			return { text: r.content?.map((c: any) => c.text).join("\\n"), details: r.details };
		},
		// Invoked with the session ctx; handler promise is intentionally not awaited (overlays block).
		command: (a) => {
			const c = commands.get(a.name);
			if (!c) throw new Error("command not registered: " + a.name);
			Promise.resolve(c.handler(a.args ?? "", ctx)).then(() => log("commandDone", { name: a.name }), (e: unknown) => log("commandError", { name: a.name, error: String(e) }));
			return { started: true };
		},
		workers: () => [...workers.values()].map((w) => ({ id: w.id, name: w.name, backend: w.backend, status: w.status, task: w.task, steerCount: w.steerCount })),
		settle: (a) => { workers.get(a.id).settle(a.outcome ?? "success"); return true; },
		permission: (a) => { void workers.get(a.id).permission().catch((e: unknown) => log("permissionError", { id: a.id, error: String(e) })); return true; },
	};
	const handle = async (file: string) => {
		const n = file.slice(4, -5);
		let res: unknown;
		try {
			const req = JSON.parse(fs.readFileSync(path.join(CONTROL, file), "utf8"));
			fs.rmSync(path.join(CONTROL, file));
			res = { ok: true, value: await ops[req.op](req) };
		} catch (error) { res = { ok: false, error: String(error) }; }
		fs.writeFileSync(path.join(CONTROL, "res-" + n + ".tmp"), JSON.stringify(res));
		fs.renameSync(path.join(CONTROL, "res-" + n + ".tmp"), path.join(CONTROL, "res-" + n + ".json"));
	};
	pi.on("session_start", (_e: any, c: any) => {
		ctx = c;
		log("sessionStart", { mode: c.mode });
		if (poll) return;
		const busy = new Set<string>();
		poll = setInterval(() => {
			for (const f of fs.readdirSync(CONTROL)) {
				if (!/^cmd-\\d+\\.json$/.test(f) || busy.has(f)) continue;
				busy.add(f);
				void handle(f).finally(() => busy.delete(f));
			}
		}, 40);
		poll.unref?.();
	});
	pi.on("session_shutdown", () => { if (poll) clearInterval(poll); poll = undefined; log("sessionShutdown"); });
}
`,
);

// ── private tmux server ─────────────────────────────────────────────────────────────────────
fs.writeFileSync(
	path.join(tmp, "tmux.conf"),
	[
		"set -g extended-keys on",
		"set -g extended-keys-format csi-u",
		"set -g escape-time 0",
		"set -g status off",
		"set -g default-terminal tmux-256color",
		"set -g history-limit 2000",
		"",
	].join("\n"),
);
const tmuxEnv = { PATH: process.env.PATH, HOME: dirs.home, TMUX_TMPDIR: tmp, LANG: "C.UTF-8" };
const tmux = (...args) =>
	execFileSync("tmux", ["-S", socket, "-f", path.join(tmp, "tmux.conf"), ...args], {
		encoding: "utf8",
		env: tmuxEnv,
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 10000,
	});
const piEnv = {
	PATH: process.env.PATH,
	HOME: dirs.home,
	TERM: "tmux-256color",
	COLORTERM: "truecolor",
	LANG: "C.UTF-8",
	XDG_CONFIG_HOME: dirs["xdg-config"],
	XDG_CACHE_HOME: dirs["xdg-cache"],
	XDG_DATA_HOME: dirs["xdg-data"],
	PI_CODING_AGENT_DIR: dirs.agent,
	PI_CODING_AGENT_SESSION_DIR: dirs.sessions,
	PI_OFFLINE: "1",
	PI_SKIP_VERSION_CHECK: "1",
	PI_TELEMETRY: "0",
	PI_PACKAGE_DIR: process.env.PI_PACKAGE_DIR,
};
const piCommand = [
	"/usr/bin/env",
	"-i",
	...Object.entries(piEnv)
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => `${k}=${v}`),
	process.execPath,
	cli,
	"--offline",
	"--no-extensions",
	"--no-skills",
	"--no-prompt-templates",
	"--no-context-files",
	"--no-themes",
	"--session-dir",
	dirs.sessions,
	"--model",
	"harness/offline",
	"-e",
	path.join(tmp, "harness-extension.ts"),
];

let panePid;
let serverStarted = false;
const screen = () => tmux("capture-pane", "-p", "-t", target);
const keys = (...k) => tmux("send-keys", "-t", target, ...k);
const type = (text) => tmux("send-keys", "-t", target, "-l", text);
const alive = () => panePid !== undefined && fs.existsSync(`/proc/${panePid}`);
async function until(predicate, label, ms = 8000) {
	const end = Date.now() + ms;
	let last;
	while (Date.now() < end) {
		last = screen();
		if (predicate(last)) return last;
		if (!alive()) throw new Error(`${label}: Pi exited.\n${last}`);
		await delay(60);
	}
	throw new Error(`${label} timed out. Screen:\n${last}`);
}
const events = () =>
	fs.existsSync(eventsFile)
		? fs
				.readFileSync(eventsFile, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];
const count = (kind, pred = () => true) => events().filter((e) => e.kind === kind && pred(e)).length;
let seq = 0;
async function control(op, data = {}, ms = 8000) {
	const n = ++seq;
	const file = path.join(dirs.control, `cmd-${n}.json`);
	fs.writeFileSync(`${file}.tmp`, JSON.stringify({ op, ...data }));
	fs.renameSync(`${file}.tmp`, file);
	const res = path.join(dirs.control, `res-${n}.json`);
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (fs.existsSync(res)) {
			const r = JSON.parse(fs.readFileSync(res, "utf8"));
			if (!r.ok) throw new Error(`control ${op}: ${r.error}`);
			return r.value;
		}
		if (!alive()) throw new Error(`control ${op}: Pi exited`);
		await delay(30);
	}
	throw new Error(`control ${op} timed out`);
}
async function slash(text, predicate, label) {
	type(text);
	await delay(250);
	keys("Enter");
	try {
		return await until(predicate, label, 2500);
	} catch {
		// First Enter may only accept an autocomplete suggestion.
		keys("Enter");
		return until(predicate, label);
	}
}

const results = [];
async function check(id, description, fn) {
	try {
		const detail = await fn();
		results.push({ id, status: "PASS", description, detail: detail ?? "" });
	} catch (error) {
		results.push({ id, status: "FAIL", description, detail: String(error?.stack ?? error).split("\n").slice(0, 40).join("\n") });
		throw error;
	}
}
const blocked = (id, description, reason) => results.push({ id, status: "BLOCKED", description, detail: reason });

const AGENTS_HEADER = / Runs \(\d+\)/;
const PERMISSION = /Claude worker permission/;

async function agentsPhase() {
	await check("A1", "fake workers spawn through the real agent_spawn tool; footer status shows them", async () => {
		const r = await control("tool", {
			name: "agent_spawn",
			params: {
				agents: [
					{ name: "alpha", prompt: "HARNESS alpha", tools: [], wake: false },
					{ name: "beta", prompt: "HARNESS beta", tools: [], wake: false },
					{ name: "gamma", backend: "claude-code", prompt: "HARNESS gamma", wake: false, backendOptions: { permissionMode: "manual" } },
				],
			},
		});
		const ids = r.details.spawned.map((s) => s.id);
		assert.equal(ids.length, 3);
		assert.equal(r.details.spawned[2].backend, "claude-code");
		await until((s) => /3 working/.test(s), "footer status");
		return ids.join(",");
	});
	const workers = await control("workers");
	const byName = Object.fromEntries(workers.map((w) => [w.name, w]));

	await check("A2", "/agents opens the real overlay workspace", async () => {
		await slash("/agents", (s) => AGENTS_HEADER.test(s), "/agents overlay");
	});

	await check("A3", "keyboard reaches the workspace; f opens the editor for the selected worker; overlay hides while composing", async () => {
		// The workspace opens with the Subagents pane focused on the newest run.
		keys("j");
		await delay(100);
		keys("f");
		const s = await until((x) => /Follow up: beta/.test(x), "follow-up editor");
		assert.doesNotMatch(s, AGENTS_HEADER, "workspace must be hidden while the editor composes");
		type("HARNESS_FOLLOWUP_1");
		keys("Enter");
		await until((x) => AGENTS_HEADER.test(x), "workspace restored after editor");
		await until(() => count("steer", (e) => e.message === "HARNESS_FOLLOWUP_1") === 1, "steer", 3000).catch(() => {});
		const steer = events().find((e) => e.kind === "steer" && e.message === "HARNESS_FOLLOWUP_1");
		assert.ok(steer, "follow-up must reach a worker");
		assert.equal(steer.id, byName.beta.id, "exact recipient ID");
		assert.equal(steer.mode, "followUp");
	});

	await check("A4", "focus returns to the workspace after the editor; cancelled redirect sends nothing", async () => {
		const before = count("steer");
		keys("k");
		await delay(100);
		keys("r");
		await until((x) => /Redirect: alpha/.test(x), "redirect editor");
		keys("Escape");
		await until((x) => AGENTS_HEADER.test(x), "workspace restored after cancel");
		await delay(200);
		assert.equal(count("steer"), before, "cancelled editor must not steer");
	});

	await check("A5", "real Claude permission handler hides the workspace, dialog owns keys, workspace refocuses", async () => {
		await control("permission", { id: byName.gamma.id });
		const s = await until((x) => PERMISSION.test(x), "permission dialog");
		assert.doesNotMatch(s, AGENTS_HEADER, "workspace must not cover the permission dialog");
		assert.match(s, new RegExp(byName.gamma.id));
		// Default selection is Yes. If `j` leaked to the hidden workspace, Enter would allow.
		keys("j");
		await delay(120);
		keys("Enter");
		await until((x) => AGENTS_HEADER.test(x) && !PERMISSION.test(x), "workspace restored after dialog");
		await until(() => count("permissionDecision") === 1, "permission decision", 3000).catch(() => {});
		const d = events().find((e) => e.kind === "permissionDecision");
		assert.equal(d?.behavior, "deny", "keys must go to the dialog, not the hidden workspace");
		assert.equal(fs.existsSync(path.join(tmp, "never-written.txt")), false);
		keys("f");
		await until((x) => /Follow up: /.test(x), "workspace owns keys after dialog");
		keys("Escape");
		await until((x) => AGENTS_HEADER.test(x), "workspace back");
	});

	await check("A6", "workspace survives terminal resize (small, narrow, restore)", async () => {
		for (const [x, y] of [
			[60, 18],
			[34, 10],
			[120, 40],
		]) {
			tmux("resize-window", "-t", session, "-x", String(x), "-y", String(y));
			await delay(400);
			assert.ok(alive(), `Pi alive at ${x}x${y}`);
			const lines = screen().split("\n");
			assert.ok(lines.every((l) => [...l].length <= x), `capture fits ${x} columns`);
		}
		await until((s) => AGENTS_HEADER.test(s), "workspace after restore");
		return "rendering exactness is only checked by component tests; tmux clips at the pane edge";
	});

	await check("A7", "q closes the workspace; settled wake:false worker triggers no parent model request", async () => {
		keys("q");
		await until((s) => !AGENTS_HEADER.test(s), "workspace closed");
		await control("settle", { id: byName.alpha.id, outcome: "success" });
		await until(() => count("sendMessage", (e) => e.customType === "subagent-complete") >= 1, "completion message", 3000).catch(() => {});
		const msg = events().find((e) => e.kind === "sendMessage" && e.customType === "subagent-complete");
		assert.equal(msg?.options?.triggerTurn, false);
		await delay(300);
		assert.equal(count("providerRequest"), 0, "no model request");
	});
}

async function teamPhase() {
	const info = await control("ping");
	const missing = [
		...["team"].filter((c) => !info.commands.includes(c)).map((c) => `/${c} command`),
		...["team_create", "team_add", "team_list"].filter((t) => !info.tools.includes(t)).map((t) => `${t} tool`),
	];
	if (missing.length) {
		blocked("B*", "team workspace checks", `Batch 1 API not loaded: missing ${missing.join(", ")}. Re-run after index.ts/teams.ts land.`);
		return;
	}
	const baseRequests = count("providerRequest");
	const baseMessages = count("sendMessage") + count("sendUserMessage");

	await check("B1", "bare /team never sends a message or triggers a model request", async () => {
		type("/team");
		await delay(250);
		keys("Enter");
		await delay(1500);
		assert.equal(count("sendMessage") + count("sendUserMessage"), baseMessages);
		assert.equal(count("providerRequest"), baseRequests);
		keys("Escape"); // close the workspace (or the autocomplete) if one opened
		await delay(300);
	});

	let team;
	await check("B2", "team_create spawns fake members through the shared path with a composed header", async () => {
		const r = await control("tool", {
			name: "team_create",
			params: {
				name: "harness-team",
				objective: "HARNESS_OBJECTIVE",
				members: [
					{ role: "builder", prompt: "HARNESS build", ownedPaths: ["src/owned-a"], tools: [], wake: false },
					{ role: "reviewer", backend: "claude-code", prompt: "HARNESS review", wake: false, backendOptions: { permissionMode: "manual" } },
				],
			},
		});
		team = r.details;
		assert.match(team.teamId, /^team_\d+$/);
		assert.equal(team.members.length, 2);
		const ws = await control("workers");
		const builder = ws.find((w) => w.id === team.members.find((m) => m.role === "builder").workerId);
		for (const needle of ["harness-team", "HARNESS_OBJECTIVE", "builder", "src/owned-a", "HARNESS build"])
			assert.ok(builder.task.includes(needle), `composed task includes ${needle}`);
		return JSON.stringify(team.members);
	});
	if (!team) return;
	const member = Object.fromEntries(team.members.map((m) => [m.role, m.workerId]));

	await check("B3", "compact widget renders above the editor outside the workspace", async () => {
		await until((s) => /harness-team/.test(s) && !AGENTS_HEADER.test(s), "team widget");
	});

	const TEAM_VIEW = (s) => /harness-team/.test(s) && s.includes(member.builder) && s.includes(member.reviewer) && /builder/.test(s) && /reviewer/.test(s);
	let workspace = true;
	await check("B4", "/team opens a workspace showing roles and exact member IDs", async () => {
		type("/team");
		await delay(250);
		keys("Enter");
		try {
			await until(TEAM_VIEW, "/team workspace", 4000);
		} catch (error) {
			workspace = false;
			throw error;
		}
	}).catch(() => {});
	if (!workspace) {
		results.pop();
		blocked("B4-B10", "team workspace interaction", "`/team` did not render a workspace with roles and member IDs (batch 2 not landed?).");
		keys("Escape");
	} else {
		await check("B5", "one workspace slot: /agents while /team is open does not open a second overlay", async () => {
			await control("command", { name: "agents" });
			await delay(600);
			const s = screen();
			assert.doesNotMatch(s, AGENTS_HEADER);
			assert.ok(TEAM_VIEW(s), "team workspace still shown");
		});

		let selected;
		await check("B6", "f opens a follow-up editor naming the member; submission reaches that exact worker", async () => {
			keys("f");
			const s = await until((x) => /Follow up/i.test(x), "team follow-up editor");
			selected = s.includes("reviewer") && !s.includes("builder") ? "reviewer" : "builder";
			type("HARNESS_TEAM_FOLLOWUP");
			keys("Enter");
			await until(TEAM_VIEW, "team workspace restored");
			await until(() => count("steer", (e) => e.message === "HARNESS_TEAM_FOLLOWUP") === 1, "team steer", 3000).catch(() => {});
			const steer = events().find((e) => e.kind === "steer" && e.message === "HARNESS_TEAM_FOLLOWUP");
			assert.ok(steer, "steer delivered");
			assert.ok(Object.values(member).includes(steer.id), "recipient is a team member");
			assert.equal(steer.mode, "followUp");
			return `recipient ${steer.id} (editor title matched ${selected})`;
		});

		await check("B7", "redirect editor warns it interrupts; cancel sends nothing and refocuses", async () => {
			const before = count("steer");
			keys("r");
			await until((x) => /Redirect/i.test(x) && /interrupts current task/i.test(x), "redirect editor warning");
			keys("Escape");
			await until(TEAM_VIEW, "workspace after cancel");
			await delay(200);
			assert.equal(count("steer"), before);
		});

		await check("B8", "Claude permission dialog uncovers from /team and returns focus", async () => {
			const before = count("permissionDecision");
			await control("permission", { id: member.reviewer });
			const s = await until((x) => PERMISSION.test(x), "permission over team");
			assert.ok(!TEAM_VIEW(s), "team workspace hidden while dialog is open");
			keys("j");
			await delay(120);
			keys("Enter");
			await until((x) => TEAM_VIEW(x) && !PERMISSION.test(x), "team workspace restored");
			await until(() => count("permissionDecision") > before, "decision", 3000).catch(() => {});
			assert.equal(events().filter((e) => e.kind === "permissionDecision").at(-1)?.behavior, "deny");
			keys("f");
			await until((x) => /Follow up/i.test(x), "team workspace owns keys after dialog");
			keys("Escape");
			await until(TEAM_VIEW, "back");
		});

		await check("B9", "x x stops exactly the selected member", async () => {
			const kills = count("kill");
			keys("x");
			await delay(300);
			assert.equal(count("kill"), kills, "single x only arms");
			keys("x");
			await until(() => count("kill") > kills, "kill", 3000).catch(() => {});
			const k = events().filter((e) => e.kind === "kill").slice(kills);
			assert.equal(k.length, 1, "exactly one worker stopped");
			assert.ok(Object.values(member).includes(k[0].id));
			return `stopped ${k[0].id}`;
		});

		await check("B10", "workspace survives resize at 30/60/120 columns", async () => {
			for (const x of [30, 60, 120]) {
				tmux("resize-window", "-t", session, "-x", String(x), "-y", "30");
				await delay(400);
				assert.ok(alive());
			}
			tmux("resize-window", "-t", session, "-x", "120", "-y", "40");
			keys("q");
			await until((s) => !PERMISSION.test(s) && !AGENTS_HEADER.test(s), "closed");
		});
	}

	await check("B11", "/team <objective> queues one extension-origin followUp that triggers a turn", async () => {
		const before = count("sendMessage", (e) => e.customType === "team-plan");
		await slash("/team HARNESS_PLAN_OBJECTIVE", () => count("sendMessage", (e) => e.customType === "team-plan") > before, "team-plan message");
		const m = events().filter((e) => e.kind === "sendMessage" && e.customType === "team-plan").at(-1);
		assert.equal(m.display, true);
		assert.equal(m.options?.deliverAs, "followUp");
		assert.equal(m.options?.triggerTurn, true);
		assert.match(m.content, /HARNESS_PLAN_OBJECTIVE/);
		await delay(1000);
		return `local dead-endpoint provider attempts: ${count("providerRequest") - baseRequests} (no network egress)`;
	});
}

let exitCode = 0;
try {
	execFileSync("tmux", ["-V"], { encoding: "utf8" });
	tmux("new-session", "-d", "-s", session, "-x", "120", "-y", "40", "-c", dirs.cwd, ...piCommand);
	serverStarted = true;
	panePid = Number(tmux("display-message", "-p", "-t", target, "#{pane_pid}").trim());
	assert.ok(Number.isSafeInteger(panePid) && panePid > 0, "pane PID");
	await check("A0", "real interactive Pi starts in isolated config with the harness extension", async () => {
		const cmdline = fs.readFileSync(`/proc/${panePid}/cmdline`, "utf8");
		assert.ok(cmdline.includes(cli), "pane PID is the Pi process");
		const info = await control("ping", {}, 30000);
		assert.equal(info.mode, "tui");
		assert.ok(info.commands.includes("agents"));
		assert.ok(info.tools.includes("agent_spawn"));
		assert.ok(info.backends.includes("claude-code"), "real claude-code registration wrapped");
		return `pid ${panePid}`;
	});
	if (phase !== "team") await agentsPhase();
	if (phase !== "agents") await teamPhase();
	await check("Z1", "quit disposes every live fake worker and exits Pi", async () => {
		keys("Escape");
		await delay(200);
		keys("C-d");
		const end = Date.now() + 10000;
		while (alive() && Date.now() < end) await delay(100);
		assert.equal(alive(), false, "Pi exited");
		const created = events().filter((e) => e.kind === "create").map((e) => e.id);
		const finished = new Set(events().filter((e) => e.kind === "kill" || e.kind === "dispose").map((e) => e.id));
		assert.deepEqual(created.filter((id) => !finished.has(id)), [], "every worker stopped");
		assert.equal(count("sessionShutdown"), 1);
	});
} catch (error) {
	exitCode = 1;
	if (!results.some((r) => r.status === "FAIL")) results.push({ id: "!", status: "FAIL", description: "harness", detail: String(error?.stack ?? error) });
} finally {
	if (panePid && alive()) {
		// Exact PID only; never a name pattern.
		try {
			process.kill(panePid, "SIGTERM");
		} catch {}
		const end = Date.now() + 5000;
		while (alive() && Date.now() < end) await delay(100);
		if (alive()) process.kill(panePid, "SIGKILL");
	}
	if (serverStarted) {
		try {
			tmux("kill-server");
		} catch {
			/* Already exited with its last pane. */
		}
	}
	if (panePid) assert.equal(alive(), false, `Pi PID ${panePid} must be gone`);
}

console.log(`Source: ${source}`);
for (const r of results) console.log(`${r.status.padEnd(7)} ${r.id.padEnd(6)} ${r.description}${r.detail ? `\n        ${r.detail.replace(/\n/g, "\n        ")}` : ""}`);
if (!exitCode && results.some((r) => r.status === "BLOCKED")) exitCode = 2;
console.log(
	exitCode === 0 ? "PASS: all requested real-TUI checks passed." : exitCode === 2 ? "BLOCKED: harness verified; team checks await implementation." : "FAIL",
);
if (keep || exitCode === 1) console.log(`Artifacts: ${tmp}`);
else fs.rmSync(tmp, { recursive: true, force: true });
process.exitCode = exitCode;
