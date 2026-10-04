// The extension factory driven by a fake ExtensionAPI: registration (F3), the state event, and
// the worker scope (--sandbox-parent, workerLaunch). Real policy, real backend.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SANDBOX_STATE_EVENT, type SandboxStateEvent } from "../state.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WT = join(HERE, "..", "..", "..", "..");
// pi resolves @earendil-works/pi-tui for extensions; plain node needs the copy pi itself would load:
// nested under the package (npm) or beside its real path (pnpm). PI_PACKAGE_DIR as in harness.mjs.
const PI = realpathSync(process.env.PI_PACKAGE_DIR ?? join(WT, "node_modules/@earendil-works/pi-coding-agent"));
const TUI_DIR = createRequire(join(PI, "package.json")).resolve.paths("@earendil-works/pi-tui")!
	.map((dir) => join(dir, "@earendil-works/pi-tui"))
	.find((dir) => existsSync(join(dir, "package.json")));
if (!TUI_DIR) throw new Error(`@earendil-works/pi-tui is not resolvable from ${PI}`);
const TUI = pathToFileURL(join(TUI_DIR, "dist/index.js")).href;
registerHooks({ resolve: (spec, ctx, next) => next(spec === "@earendil-works/pi-tui" ? TUI : spec, ctx) });

const root = realpathSync(mkdtempSync(join("/var/tmp", "sbx-index-")));
const agentDir = join(root, "agent");
mkdirSync(join(agentDir, "sandbox-policy"), { recursive: true });
cpSync(join(HERE, "..", "..", "..", "sandbox-policy"), join(agentDir, "sandbox-policy"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
const { default: sandbox } = await import("../index.ts");
/** Every started instance, stopped at the end even when a test failed before its own stop(). */
const started: (() => Promise<void>)[] = [];
test.after(async () => {
	for (const stop of started) await stop();
	rmSync(root, { recursive: true, force: true });
});

type Handler = (event: unknown, ctx: unknown) => unknown;

/** One extension instance on a fake pi, started in `cwd` with these flag values. */
async function start(cwd: string, flags: Record<string, string>) {
	const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ content: { text?: string }[] }> }>();
	const handlers = new Map<string, Handler[]>();
	const listeners = new Map<string, ((d: unknown) => void)[]>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const events: SandboxStateEvent[] = [];
	const notes: string[] = [];
	const entries: { type: string; customType: string; data: unknown }[] = [];
	const pi = {
		registerFlag() {},
		getFlag: (n: string) => flags[n],
		registerTool: (d: { name: string }) => tools.set(d.name, d as never),
		registerCommand: (n: string, c: never) => commands.set(n, c),
		registerEntryRenderer() {},
		on: (e: string, h: Handler) => handlers.set(e, [...(handlers.get(e) ?? []), h]),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		events: {
			on: (e: string, f: (d: unknown) => void) => listeners.set(e, [...(listeners.get(e) ?? []), f]),
			emit: (e: string, d: unknown) => {
				if (e === SANDBOX_STATE_EVENT) events.push(d as SandboxStateEvent);
				for (const f of listeners.get(e) ?? []) f(d);
			},
		},
	};
	sandbox(pi as never);
	const sessionManager = { getBranch: () => entries, getSessionId: () => `s${Math.random().toString(36).slice(2)}`, getSessionFile: () => undefined };
	const ctx = { cwd, hasUI: true, ui: { notify: (t: string) => notes.push(t), setStatus() {} }, sessionManager };
	for (const h of handlers.get("session_start") ?? []) await h({ reason: "startup" }, ctx);
	const run = async (name: string, params: object) => {
		const r = await tools.get(name)!.execute("id", params, undefined, undefined, ctx);
		return r.content.map((c) => c.text ?? "").join("");
	};
	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		for (const h of handlers.get("session_shutdown") ?? []) await h({ reason: "quit" }, ctx);
	};
	started.push(stop);
	return { tools, events, notes, entries, run, stop, emit: pi.events.emit, command: (a: string) => commands.get("sandbox")!.handler(a, ctx), last: () => events.at(-1)! };
}

function dirs() {
	const base = realpathSync(mkdtempSync(join(root, "ws-")));
	const a = join(base, "a");
	const b = join(base, "b");
	mkdirSync(join(a, "sub"), { recursive: true });
	mkdirSync(b);
	return { a, b };
}

test("never on: no tool is registered and the event says off", async () => {
	const { a } = dirs();
	const s = await start(a, {});
	assert.equal(s.tools.size, 0);
	assert.equal(s.last().on, false);
	assert.deepEqual(s.last().workerLaunch!({ cwd: a, backend: "pi", owner: "w1" }), { kind: "none" });
	assert.equal(s.entries.length, 0, "opening a session writes nothing");
	await s.stop();
});

const linux = process.platform === "linux" && existsSync("/usr/bin/bwrap");

/** A pi worker's flags from workerLaunch (asserting that is what it got). */
function piFlags(e: SandboxStateEvent, req: { cwd: string; root?: string }): Record<string, string> {
	const r = e.workerLaunch!({ ...req, backend: "pi", owner: "w1" });
	assert.equal(r.kind, "pi", JSON.stringify(r));
	return (r as { flags: Record<string, string> }).flags;
}

test("a parent that is on hands its workers its writable roots, and refuses a cwd outside them", { skip: !linux }, async () => {
	const { a, b } = dirs();
	const s = await start(a, { sandbox: "on" });
	const e = s.last();
	assert.equal(e.on, true);
	assert.equal(e.enforcement, "full");
	const flags = piFlags(e, { cwd: a });
	assert.deepEqual(Object.keys(flags), ["sandbox", "sandbox-parent"]);
	assert.equal(flags.sandbox, "on");
	const scope = JSON.parse(flags["sandbox-parent"]!);
	// The flag is the scope as parentScopeOf builds it, keys in that order (the spelling pi workers always got).
	assert.deepEqual(Object.keys(scope), ["version", "level", "workspaceRoot", "writable", "readOnly", "hidden", "proxyAllow", "envAllow"]);
	assert.equal(JSON.stringify(scope), flags["sandbox-parent"]);
	assert.equal(scope.level, "workspace-write");
	assert.ok(scope.writable.includes(a));
	assert.ok(!scope.writable.some((w: string) => w.includes("pi-sandbox-")), "the parent's session tmp is not handed down");
	for (const backend of ["pi", "claude-code"]) {
		const launch = (cwd: string) => e.workerLaunch!({ cwd, backend, owner: "w1" });
		assert.notEqual(launch(a).kind, "refused");
		assert.notEqual(launch("sub").kind, "refused", "relative to the parent's cwd");
		assert.deepEqual(launch(b), { kind: "refused", reason: `Sandbox: worker cwd ${b} is outside the parent's sandbox` });
		assert.match((launch("../b") as { reason: string }).reason, /outside the parent's sandbox/);
	}
	await s.stop();
});

test("a worker started outside its parent's roots refuses every tool; inside, it writes only where the parent may", { skip: !linux }, async () => {
	const { a, b } = dirs();
	const parent = await start(a, { sandbox: "on" });
	const flags = piFlags(parent.last(), { cwd: a });
	await parent.stop();

	const outside = await start(b, { ...flags });
	assert.equal(outside.tools.size, 7);
	for (const [name, params] of [["bash", { command: "touch x" }], ["write", { path: "x", content: "x" }], ["read", { path: "x" }]] as const) {
		await assert.rejects(outside.run(name, params), new RegExp(`^Error: Sandbox: worker cwd ${b} is outside the parent's sandbox$`), name);
	}
	assert.equal(existsSync(join(b, "x")), false);
	// It cannot be turned off from inside the worker either.
	await outside.command("off");
	assert.equal(outside.last().on, true);
	assert.ok(outside.notes.some((n) => /started with --sandbox on/.test(n)));
	await outside.stop();

	const inside = await start(join(a, "sub"), { ...flags });
	await inside.run("write", { path: "ok.txt", content: "ok" });
	assert.equal(readFileSync(join(a, "sub", "ok.txt"), "utf8"), "ok");
	await inside.run("write", { path: "../up.txt", content: "up" });
	assert.equal(readFileSync(join(a, "up.txt"), "utf8"), "up", "the parent's whole root is the worker's too");
	await assert.rejects(inside.run("write", { path: join(b, "no.txt"), content: "x" }), /\[sandbox:/);
	await assert.rejects(inside.run("bash", { command: `touch ${join(b, "no2.txt")}` }), /Read-only file system/);
	assert.equal(existsSync(join(b, "no.txt")) || existsSync(join(b, "no2.txt")), false);
	// Its own event narrows transitively: grandchildren get the same roots.
	assert.deepEqual(JSON.parse(piFlags(inside.last(), { cwd: join(a, "sub") })["sandbox-parent"]!).writable, JSON.parse(flags["sandbox-parent"]!).writable);
	await inside.stop();
});

test("a malformed --sandbox-parent fails closed", async () => {
	const { a } = dirs();
	const s = await start(a, { "sandbox-parent": "{nope" });
	assert.equal(s.last().on, true);
	assert.equal(s.last().enforcement, "unavailable");
	await assert.rejects(s.run("write", { path: "x", content: "x" }), /Sandbox unavailable: --sandbox-parent is not valid JSON/);
	for (const backend of ["pi", "claude-code"]) assert.match((s.last().workerLaunch!({ cwd: a, backend, owner: "w1" }) as { reason: string }).reason, /Sandbox unavailable in the parent/);
	await s.stop();
});

test("partial enforcement: every backend is refused unless acceptPartial", { skip: !linux }, async () => {
	const { LinuxBwrapBackend } = await import("../backends/linux-bwrap.ts");
	const real = LinuxBwrapBackend.prototype.probe;
	LinuxBwrapBackend.prototype.probe = async () => ({ ok: true, enforcement: "partial", reasons: ["test: stubbed partial"], network: "none" });
	const policyFile = join(agentDir, "sandbox-policy", "linux", "policy.json");
	const original = readFileSync(policyFile, "utf8");
	try {
		const { a } = dirs();
		const s = await start(a, { sandbox: "on" });
		const e = s.last();
		assert.equal(e.enforcement, "partial");
		const text = "Sandbox enforcement is partial (test: stubbed partial); set acceptPartial in the sandbox policy to start unattended workers.";
		for (const backend of ["pi", "claude-code"]) assert.deepEqual(e.workerLaunch!({ cwd: a, backend, owner: "w1" }), { kind: "refused", reason: text }, backend);
		await s.stop();

		// acceptPartial lets them start.
		writeFileSync(policyFile, JSON.stringify({ ...JSON.parse(original), acceptPartial: true }));
		utimesSync(policyFile, new Date(), new Date(Date.now() + 60_000));
		const ok = await start(a, { sandbox: "on" });
		assert.equal(ok.last().enforcement, "partial");
		for (const backend of ["pi", "claude-code"]) assert.notEqual(ok.last().workerLaunch!({ cwd: a, backend, owner: "w1" }).kind, "refused", backend);
		await ok.stop();
	} finally {
		LinuxBwrapBackend.prototype.probe = real;
		writeFileSync(policyFile, original);
		utimesSync(policyFile, new Date(), new Date(Date.now() + 120_000));
	}
});

const { decodeLaunchScope } = await import("../launch.ts");
const { narrowScope, writeOnlyScope } = await import("../policy.ts");

test("workerLaunch off: none outside a tracked worktree; inside one, a write-only scope for either kind of worker", async () => {
	const { a } = dirs();
	const s = await start(a, {});
	const wl = s.last().workerLaunch!;
	assert.deepEqual(wl({ cwd: a, backend: "pi", owner: "w1" }), { kind: "none" });
	assert.deepEqual(wl({ cwd: a, backend: "claude-code", owner: "w1" }), { kind: "none" });
	const pi = wl({ cwd: a, root: a, backend: "pi", owner: "w1" });
	assert.equal(pi.kind, "pi");
	if (pi.kind !== "pi") return;
	assert.deepEqual(pi.flags, { sandbox: "on", "sandbox-parent": JSON.stringify(writeOnlyScope(a)) }, "the write-only scope, as pi workers always got it");
	const cc = wl({ cwd: a, root: a, backend: "claude-code", owner: "w1" });
	assert.equal(cc.kind, "confine");
	if (cc.kind !== "confine") return;
	assert.ok(cc.module.endsWith("/launch.ts") && existsSync(cc.module));
	const d = decodeLaunchScope(cc.scope);
	assert.ok(d.ok);
	assert.deepEqual(d.value.parent, JSON.parse(pi.flags["sandbox-parent"]!), "the confined worker gets the pi worker's scope");
	assert.deepEqual(d.value.parent.readOnly, [join(a, ".agent")]);
	assert.equal(d.value.agentDir, agentDir);
	assert.equal(d.value.owner, "w1");
	assert.deepEqual(wl({ cwd: a, root: a, backend: "claude-code", owner: "../x" }).kind, "refused", "an owner that is no plain id");
	await s.stop();
});

test("three states (§chat.sandbox/states): Off lifts every worker, Subagents only confines a worktree's, and the entry says which", async () => {
	const { a } = dirs();
	const s = await start(a, {});
	// The default with defaultOn false: Subagents only, nothing written.
	assert.equal(s.last().on, false);
	assert.equal(s.last().workers, undefined);
	assert.equal(s.entries.length, 0);
	await s.command("off");
	const off = s.last();
	assert.equal(off.on, false);
	assert.equal(off.workers, "off");
	for (const backend of ["pi", "claude-code"]) {
		assert.deepEqual(off.workerLaunch!({ cwd: a, root: a, backend, owner: "w1" }), { kind: "none" }, `${backend} in a worktree`);
		assert.deepEqual(off.workerLaunch!({ cwd: a, backend, owner: "w1" }), { kind: "none" }, `${backend} outside one`);
	}
	assert.deepEqual(s.entries.at(-1)!.data, { version: 1, on: false, level: "workspace-write", backend: "none", enforcement: "none", workers: "off" });
	assert.match(s.notes.at(-1)!, /^Sandbox off · workers unconfined\. Running subagents keep theirs until resumed\.$/);
	// Off again changes nothing and records nothing.
	const n = s.entries.length;
	await s.command("off");
	assert.equal(s.entries.length, n);
	await s.command("subagents");
	assert.equal(s.last().workers, undefined);
	assert.equal(s.last().workerLaunch!({ cwd: a, root: a, backend: "pi", owner: "w1" }).kind, "pi", "write-only again");
	assert.deepEqual(s.entries.at(-1)!.data, { version: 1, on: false, level: "workspace-write", backend: "none", enforcement: "none" });
	assert.match(s.notes.at(-1)!, /^Sandbox subagents only/);
	// No tool was ever registered: Off and Subagents only both leave the session's own tools pi's.
	assert.equal(s.tools.size, 0);
	await s.command("sideways");
	assert.equal(s.notes.at(-1), "usage: /sandbox on | subagents | off");
	await s.stop();
});

test("the --sandbox flag takes the three states", async () => {
	const { a } = dirs();
	const off = await start(a, { sandbox: "off" });
	assert.equal(off.last().workers, "off");
	assert.deepEqual(off.last().workerLaunch!({ cwd: a, root: a, backend: "pi", owner: "w1" }), { kind: "none" });
	assert.equal(off.entries.length, 0, "coming up off writes nothing");
	await off.stop();
	const sub = await start(a, { sandbox: "subagents" });
	assert.equal(sub.last().workers, undefined);
	assert.equal(sub.last().workerLaunch!({ cwd: a, root: a, backend: "pi", owner: "w1" }).kind, "pi");
	await sub.stop();
});

test("a worker started with --sandbox on cannot lower it to subagents or off", { skip: !linux }, async () => {
	const { a } = dirs();
	const w = await start(a, { sandbox: "on" });
	assert.equal(w.last().on, true);
	for (const arg of ["subagents", "off"]) {
		await w.command(arg);
		assert.equal(w.last().on, true, arg);
		assert.match(w.notes.at(-1)!, /cannot be turned off here/, arg);
	}
	await w.stop();
});

test("workerLaunch on: the parent's scope (narrowed in a worktree) for either kind of worker; a cwd outside refused", { skip: !linux }, async () => {
	const { a, b } = dirs();
	const s = await start(a, { sandbox: "on" });
	const e = s.last();
	const wl = e.workerLaunch!;
	const pi = wl({ cwd: a, backend: "pi", owner: "w1" });
	assert.equal(pi.kind === "pi" && pi.extensionPath, e.extensionPath);
	const full = JSON.parse(piFlags(e, { cwd: a })["sandbox-parent"]!);
	const narrowed = wl({ cwd: join(a, "sub"), root: join(a, "sub"), backend: "pi", owner: "w1" });
	assert.deepEqual(narrowed, { kind: "pi", extensionPath: e.extensionPath, flags: { sandbox: "on", "sandbox-parent": JSON.stringify(narrowScope(full, join(a, "sub"))) } }, "the parent's scope narrowed, as pi workers always got it");
	for (const [cwd, root] of [[a, undefined], [join(a, "sub"), join(a, "sub")]] as const) {
		const cc = wl({ cwd, ...(root ? { root } : {}), backend: "claude-code", owner: "w2" });
		assert.equal(cc.kind, "confine");
		if (cc.kind !== "confine") continue;
		const d = decodeLaunchScope(cc.scope);
		assert.ok(d.ok);
		assert.deepEqual(d.value.parent, JSON.parse(piFlags(e, { cwd, ...(root ? { root } : {}) })["sandbox-parent"]!), "the pi worker's scope");
	}
	for (const backend of ["pi", "claude-code"]) {
		assert.deepEqual(wl({ cwd: b, backend, owner: "w1" }), { kind: "refused", reason: `Sandbox: worker cwd ${b} is outside the parent's sandbox` }, backend);
	}
	await s.stop();
});

test("workerLaunch: an unavailable parent refuses every backend; a remote session has none", async () => {
	const { a } = dirs();
	const s = await start(a, { "sandbox-parent": "{nope" });
	for (const backend of ["pi", "claude-code"]) {
		const r = s.last().workerLaunch!({ cwd: a, backend, owner: "w1" });
		assert.equal(r.kind, "refused");
		if (r.kind === "refused") assert.match(r.reason, /Sandbox unavailable in the parent/);
	}
	await s.stop();
	const r = await start(a, {});
	r.emit("remote:session", { version: 1, target: "far" });
	await r.command("on");
	assert.equal(r.last().on, false);
	assert.equal(r.last().workerLaunch, undefined);
	await r.stop();
});
