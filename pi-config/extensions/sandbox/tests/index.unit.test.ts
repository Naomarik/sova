// The extension factory driven by a fake ExtensionAPI: registration (F3), the state event, and
// the worker scope (--sandbox-parent, workerFlags, checkWorker). Real policy, real backend.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SANDBOX_STATE_EVENT, type SandboxStateEvent } from "../state.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WT = join(HERE, "..", "..", "..", "..");
// pi resolves @earendil-works/pi-tui for extensions; plain node needs the package's nested copy.
const TUI = pathToFileURL(join(WT, "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js")).href;
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
	return { tools, events, notes, entries, run, stop, command: (a: string) => commands.get("sandbox")!.handler(a, ctx), last: () => events.at(-1)! };
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
	assert.equal(s.last().workerFlags, undefined);
	assert.equal(s.last().checkWorker, undefined);
	assert.equal(s.entries.length, 0, "opening a session writes nothing");
	await s.stop();
});

const linux = process.platform === "linux" && existsSync("/usr/bin/bwrap");

test("a parent that is on hands its workers its writable roots, and checkWorker refuses a cwd outside them", { skip: !linux }, async () => {
	const { a, b } = dirs();
	const s = await start(a, { sandbox: "on" });
	const e = s.last();
	assert.equal(e.on, true);
	assert.equal(e.enforcement, "full");
	assert.equal(e.workerFlags?.sandbox, "on");
	const scope = JSON.parse(e.workerFlags!["sandbox-parent"]!);
	assert.equal(scope.level, "workspace-write");
	assert.ok(scope.writable.includes(a));
	assert.ok(!scope.writable.some((w: string) => w.includes("pi-sandbox-")), "the parent's session tmp is not handed down");
	for (const backend of ["pi", "claude-code"]) {
		assert.equal(e.checkWorker!({ cwd: a, backend }), undefined);
		assert.equal(e.checkWorker!({ cwd: "sub", backend }), undefined, "relative to the parent's cwd");
		assert.equal(e.checkWorker!({ cwd: b, backend }), `Sandbox: worker cwd ${b} is outside the parent's sandbox`);
		assert.match(e.checkWorker!({ cwd: "../b", backend })!, /outside the parent's sandbox/);
	}
	await s.stop();
});

test("a worker started outside its parent's roots refuses every tool; inside, it writes only where the parent may", { skip: !linux }, async () => {
	const { a, b } = dirs();
	const parent = await start(a, { sandbox: "on" });
	const flags = parent.last().workerFlags!;
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
	assert.deepEqual(JSON.parse(inside.last().workerFlags!["sandbox-parent"]!).writable, JSON.parse(flags["sandbox-parent"]!).writable);
	await inside.stop();
});

test("a malformed --sandbox-parent fails closed", async () => {
	const { a } = dirs();
	const s = await start(a, { "sandbox-parent": "{nope" });
	assert.equal(s.last().on, true);
	assert.equal(s.last().enforcement, "unavailable");
	await assert.rejects(s.run("write", { path: "x", content: "x" }), /Sandbox unavailable: --sandbox-parent is not valid JSON/);
	assert.match(s.last().checkWorker!({ cwd: a, backend: "pi" })!, /Sandbox unavailable in the parent/);
	assert.ok(s.last().claudeRefusal);
	await s.stop();
});
