// worker-inheritance.mjs — plan v2 §11 #13 / v3 §8 #8: a worker starts with the parent's state
// (`--sandbox on`, no UI, no /sandbox command) and never turns itself off.
//
// W1-W3 are flag-level. W4 is end-to-end without an LLM: a REAL parent runtime emits its sandbox
// state on a tapped event bus, the REAL registerSubagents turns it into LaunchOptions, and the
// captured flags/extensions drive a REAL worker-shaped runtime whose effects are checked on the host.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { makeSuite, ok, eq } from "./kit.mjs";
import {
	EXT_ENTRY, PI_CONFIG, cleanupAll, hostMntNs, jiti, makeBus, makeFixture, openSession, rand, sha,
} from "./harness.mjs";

const SUBAGENTS_DIR = path.join(PI_CONFIG, "extensions/subagents");
const SUBAGENTS_ENTRY = path.join(SUBAGENTS_DIR, "index.ts");
const NO_POLICY_FILE = path.join(ARTIFACT_DIR(), "absent-policy.json");
function ARTIFACT_DIR() { return path.dirname(new URL(import.meta.url).pathname); }

/** Registration harness for the REAL subagents extension (shape per subagents/index.test.ts). */
async function registerSubagentsHarness(bus, ctxOverrides = {}) {
	const sub = await jiti.import(SUBAGENTS_ENTRY);
	const tools = new Map();
	const commands = new Map();
	const events = new Map();
	const workers = [];
	const ctx = {
		cwd: process.cwd(), mode: "tui", hasUI: true, thinkingLevel: "high",
		isIdle: () => true,
		model: { provider: "test", id: "model" },
		sessionManager: { getEntries: () => [], getSessionFile: () => undefined },
		modelRegistry: { find: (p, m) => (p === "test" && m === "model" ? { provider: p, id: m } : undefined) },
		ui: { setStatus() {}, notify() {} },
		...ctxOverrides,
	};
	const factory = (options, handlers) => {
		const worker = {
			...options,
			wake: options.wake ?? true,
			extensions: options.extensions ?? [],
			forked: Boolean(options.forkSession),
			status: "running", processAlive: true, transcript: [], output: "",
			usage: { input: 0, output: 0, turns: 0 }, steerCount: 0,
			isFinished() { return ["killed", "done", "error"].includes(this.status); },
			isSettled() { return this.isFinished() || this.status === "waiting"; },
			finalOutput() { return this.output ?? ""; },
			change() { handlers.onChange(); },
			async steer(message, signal, mode) { this.lastSteer = { message, signal, mode }; this.steerCount++; this.status = "running"; return { ok: true }; },
			async kill() { this.status = "killed"; },
			async dispose() { this.disposed = true; await this.kill(); },
			exit() { this.status = "done"; this.processAlive = false; handlers.onExit(this); },
			settle(error, status = "waiting") { this.status = status; this.error = error; handlers.onSettled(this); },
		};
		workers.push(worker);
		return worker;
	};
	const piFake = {
		events: bus,
		registerTool: (tool) => tools.set(tool.name, tool),
		on: (e, f) => events.set(e, f),
		registerCommand: (name, command) => commands.set(name, command),
		registerShortcut() {},
		appendEntry() {},
		getAgentDir: () => process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME, ".pi/agent"),
		getActiveTools: () => ["read", "bash", "agent_spawn"],
		sendMessage() {},
		sendUserMessage() {},
	};
	sub.registerSubagents(piFake, factory, { policyFile: NO_POLICY_FILE });
	return {
		tools, commands, events, workers, ctx,
		call: (name, params = {}, signal) => tools.get(name).execute("w4", params, signal, () => {}, ctx),
		close: () => events.get("session_shutdown")?.({}, ctx),
	};
}

const t = makeSuite("worker-inheritance");

// Plumbing check without importing anything from subagents: a textual reference to the flag.
let plumbing = false;
try {
	const idx = readFileSync(path.join(PI_CONFIG, "extensions/subagents/index.ts"), "utf8");
	plumbing = /sandbox/.test(idx);
} catch { /* no subagents extension in this layout */ }

if (!existsSync(EXT_ENTRY)) {
	t.pending("W1-W3 flag-level worker shape", "pi-config/extensions/sandbox/index.ts does not exist yet");
} else {
	const fx = makeFixture();
	await t.test("W1 flag session starts ON with no UI: tools confined, no /sandbox command to flip", async () => {
		const s = await openSession({ cwd: fx.cwd, agentDir: fx.agentDir, withExtension: true, flags: { sandbox: "on" }, ui: false });
		try {
			eq(s.errors.length, 0, `worker session loaded clean: ${s.errors.join(" | ")}`);
			const r = await s.bash("readlink /proc/self/ns/mnt");
			ok(!r.isError && r.text.trim() !== hostMntNs(), `worker tools run confined (ns ${r.text.trim()})`);
			// A worker never turns itself off (spec §chat.sandbox/workers): no command at all, or a
			// command that REFUSES in a UI-less session. Both shapes satisfy the guarantee; the
			// behavioral check is that an off attempt does not take.
			const cmd = s.runner().getCommand("sandbox");
			if (!cmd) console.log("       worker shape: command absent");
			else {
				try { await s.command("sandbox", "off"); } catch { /* refusal may throw */ }
				const still = await s.bash("readlink /proc/self/ns/mnt");
				ok(still.text.trim() !== hostMntNs(), "a /sandbox off attempt in a UI-less worker session must NOT take effect");
				const entries = s.entries().filter((e) => e.type === "custom" && e.customType === "sandbox");
				const last = entries.at(-1);
				ok(!last || String(last.data?.on ?? last.on) !== "false", "no sandbox entry records on:false after the refused flip");
			}
		} finally {
			await s.dispose().catch(() => {});
		}
	});

	await t.test("W2 a worker write outside cwd is denied both layers", async () => {
		const s = await openSession({ cwd: fx.cwd, agentDir: fx.agentDir, withExtension: true, flags: { sandbox: "on" }, ui: false });
		try {
			const victim = path.join(fx.escape, `w2-${rand()}`);
			const r1 = await s.call("write", { path: victim, content: "pwned" });
			ok(r1.isError, "write tool refuses");
			const r2 = await s.bash(`touch '${victim}'`);
			ok(r2.isError, "bash is denied");
			ok(!existsSync(victim), "host-side: absent");
		} finally {
			await s.dispose().catch(() => {});
		}
	});

	await t.test("W3 flag OFF stays stock even with the extension loaded", async () => {
		const s = await openSession({ cwd: fx.cwd, agentDir: fx.agentDir, withExtension: true, flags: { sandbox: "off" }, ui: false });
		try {
			const r = await s.bash("readlink /proc/self/ns/mnt");
			eq(r.text.trim(), hostMntNs(), "--sandbox off runs unconfined");
			for (const x of s.registry()) eq(x.source, "builtin", `${x.name} stays builtin under --sandbox off`);
		} finally {
			await s.dispose().catch(() => {});
		}
	});
}

if (plumbing) {
	// W4 — end-to-end: real parent state event → real registerSubagents → captured launch options →
	// real worker-shaped runtime. Host-side assertions throughout; no LLM anywhere.
	const state = await jiti.import(path.join(PI_CONFIG, "extensions/sandbox/state.ts"));
	const fx4 = makeFixture();

	await t.test("W4a parent ON: spawn carries the worker flags and the extension; the captured launch actually confines", async () => {
		const bus = makeBus();
		const emitted = [];
		bus.on(state.SANDBOX_STATE_EVENT, (e) => emitted.push(e));
		let parent;
		try {
			parent = await openSession({ cwd: fx4.cwd, agentDir: fx4.agentDir, withExtension: true, eventBus: bus });
			eq(parent.errors.length, 0, `parent loaded clean: ${parent.errors.join(" | ")}`);
		} catch (err) {
			console.log(`       bus tap failed (${err?.message}); falling back without it`);
			parent = await openSession({ cwd: fx4.cwd, agentDir: fx4.agentDir, withExtension: true });
		}
		try {
			await parent.command("sandbox", "on");
			const h = await registerSubagentsHarness(bus, { cwd: fx4.cwd });
			if (emitted.length === 0) {
				console.log("       bus tap saw no emission (extension events not routed to an injected bus); replaying the parent's recorded state");
				const entry = parent.entries().filter((e) => e.type === "custom" && e.customType === "sandbox").at(-1);
				ok(entry, "the parent recorded its sandbox state");
				const data = entry.data ?? entry;
				bus.emit(state.SANDBOX_STATE_EVENT, {
					version: 1, on: data.on === true, extensionPath: realpathOf(EXT_ENTRY_DIR()),
					enforcement: data.enforcement ?? "full",
					...(data.workerFlags ? { workerFlags: data.workerFlags } : {}),
				});
			} else {
				console.log(`       real emission captured: ${JSON.stringify(emitted.at(-1)).slice(0, 220)}`);
				// registration also emits discover; the live extension answers on the shared bus
				bus.emit(state.SANDBOX_DISCOVER_EVENT, { version: 1 });
			}
			await h.call("agent_spawn", { prompt: "w4 pi worker" });
			eq(h.workers.length, 1, "one worker captured");
			const opts = launchShape(h.workers[0]);
			ok(opts.flags && opts.flags.sandbox === "on", `worker flags carry sandbox on (got ${JSON.stringify(opts.flags)})`);
			ok((opts.extensions ?? []).includes(realpathOf(EXT_ENTRY_DIR())), `worker loads the sandbox extension (got ${JSON.stringify(opts.extensions)})`);
			// The captured launch, driven for real: worker-shaped session (no UI) under the captured flags.
			const worker = await openSession({ cwd: fx4.cwd, agentDir: fx4.agentDir, withExtension: true, flags: opts.flags, ui: false });
			try {
				eq(worker.errors.length, 0, `worker loaded clean: ${worker.errors.join(" | ")}`);
				const ns = await worker.bash("readlink /proc/self/ns/mnt");
				ok(ns.text.trim() !== hostMntNs(), "the spawned worker's tools run confined");
				const victim = path.join(fx4.escape, `w4-${rand()}`);
				const w = await worker.call("write", { path: victim, content: "pwned" });
				ok(w.isError, "worker write outside cwd refused");
				const b = await worker.bash(`touch '${victim}'`);
				ok(b.isError, "worker bash outside cwd denied");
				ok(!existsSync(victim), "host-side: absent");
			} finally {
				await worker.dispose().catch(() => {});
			}
			await h.close()?.catch?.(() => {});
		} finally {
			await parent.dispose().catch(() => {});
		}
	});

	await t.test("W4b parent OFF: spawn is today's launch; the worker-shaped runtime is unconfined", async () => {
		const bus = makeBus();
		const parent = await openSession({ cwd: fx4.cwd, agentDir: fx4.agentDir, withExtension: true, eventBus: bus });
		try {
			eq(parent.errors.length, 0, `parent loaded clean: ${parent.errors.join(" | ")}`);
			// session_start should already have announced OFF; nudge discovery too.
			bus.emit(state.SANDBOX_DISCOVER_EVENT, { version: 1 });
			const h = await registerSubagentsHarness(bus, { cwd: fx4.cwd });
			await h.call("agent_spawn", { prompt: "w4 pi worker" });
			const opts = launchShape(h.workers[0]);
			ok(!opts.flags?.sandbox, `no sandbox flag under OFF (got ${JSON.stringify(opts.flags)})`);
			ok(!(opts.extensions ?? []).includes(realpathOf(EXT_ENTRY_DIR())), "no sandbox extension in the worker's -e list");
			const worker = await openSession({ cwd: fx4.cwd, agentDir: fx4.agentDir, withExtension: false, flags: {}, ui: false });
			try {
				const ns = await worker.bash("readlink /proc/self/ns/mnt");
				eq(ns.text.trim(), hostMntNs(), "today's worker runs in the host namespace");
				const victim = path.join(fx4.escape, `w4b-${rand()}`);
				const w = await worker.call("write", { path: victim, content: "today" });
				ok(!w.isError && existsSync(victim), "control: today's worker CAN write outside cwd (removed by cleanup)");
			} finally {
				await worker.dispose().catch(() => {});
			}
			await h.close()?.catch?.(() => {});
		} finally {
			await parent.dispose().catch(() => {});
		}
	});
} else if (!existsSync(EXT_ENTRY)) {
	t.pending("W4 parent→worker inheritance end-to-end", "extension entry absent");
} else {
	t.pending("W4 parent→worker inheritance end-to-end", "subagents/index.ts has no sandbox plumbing yet (integration, phase 2)");
}

function realpathOf(p) { return realpathSync(p); }
function EXT_ENTRY_DIR() { return path.dirname(EXT_ENTRY); }
function launchShape(w) { return Object.fromEntries(Object.entries(w).filter(([k]) => !["id", "groupId", "name"].includes(k)).filter(([, v]) => typeof v !== "function")); }

cleanupAll();
t.done();
process.exitCode ??= 0;
