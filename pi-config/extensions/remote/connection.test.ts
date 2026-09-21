/**
 * Connection on its own — what the workers' MCP server uses, without the extension around it. The
 * channel policy itself is covered through Remote in index.test.ts; this file covers the seam:
 * the far cwd both lanes run in, the `channel` dep's three meanings, idleClose, and bash.
 *
 *   npx tsx --test pi-config/extensions/remote/connection.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Target } from "./argv.ts";
import { type ChannelLike, type ChannelState, Connection, type ConnectionDeps } from "./connection.ts";
import { type RunOptions, runArgv } from "./exec.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The far command as it reaches the far login shell: `cd -- <path>` with ssh's quoting undone. */
const cdsInto = (farCommand: string, path: string) => farCommand.replace(/'\\''/g, "'").includes(`cd -- '${path}'`);

/** A far dir and a Connection whose per-call `exec` runs the far command with a local `sh -c`. */
async function setup(deps: ConnectionDeps = {}, farCwd?: string) {
	const far = mkdtempSync(join(tmpdir(), "pi-conn-far-"));
	const calls: string[] = [];
	const exec = async (argv: readonly string[], o?: RunOptions) => {
		calls.push(argv[argv.length - 1]!);
		return runArgv(["sh", "-c", argv[argv.length - 1]!], o);
	};
	const target: Target = { name: "t", kind: "ssh", ssh: { host: "example.invalid" }, cwd: far };
	const c = new Connection(target, [target], farCwd ?? far, { exec, channel: false, ...deps });
	await c.preflight();
	calls.length = 0;
	return { far, calls, c, done: () => (c.dispose(), rmSync(far, { recursive: true, force: true })) };
}

/** A channel that runs the command locally and records the cwd it was given. */
function fakeChannel() {
	const runs: { command: string; cwd?: string }[] = [];
	const idle: number[] = [];
	let state: ChannelState = "off";
	let notify: (s: ChannelState) => void = () => {};
	const ch: ChannelLike = {
		get state() {
			return state;
		},
		start: async () => {
			state = "idle";
			notify(state);
		},
		run: async (command, o) => {
			runs.push({ command, cwd: o.cwd });
			return runArgv(["sh", "-c", command]);
		},
		idleClose: (ms) => idle.push(ms),
		close: () => {
			state = "dead";
			notify(state);
		},
	};
	return {
		runs,
		idle,
		factory: (onState: (s: ChannelState) => void) => {
			notify = onState;
			return ch;
		},
	};
}

test("the probe, then run(), all in the session's far cwd — and the same cwd over the channel", async () => {
	const chan = fakeChannel();
	const far = mkdtempSync(join(tmpdir(), "pi-conn-far-"));
	const calls: string[] = [];
	const target: Target = { name: "t", kind: "ssh", ssh: { host: "example.invalid" }, cwd: "/entry/cwd" };
	const c = new Connection(target, [target], far, {
		exec: async (argv: readonly string[], o?: RunOptions) => {
			calls.push(argv[argv.length - 1]!);
			return runArgv(["sh", "-c", argv[argv.length - 1]!], o);
		},
		channel: chan.factory,
	});
	const info = await c.preflight();
	// The probe runs there, so `pwd` is the far cwd the caller gave — not the entry's cwd.
	assert.equal(info.cwd, far);
	assert.ok(cdsInto(calls[0]!, far), calls[0]);
	assert.equal(c.farCwd, far);

	// Per-call lane: same cd. Channel lane: the cwd travels as an option (channel.ts does the cd).
	await c.run("pwd");
	assert.ok(cdsInto(calls.at(-1)!, far), calls.at(-1));
	await sleep(0); // the background warm lands
	await c.run("pwd");
	assert.deepEqual(chan.runs.at(-1), { command: "pwd", cwd: far }, "the channel gets the same far cwd");
	c.dispose();
	rmSync(far, { recursive: true, force: true });
});

test("the `channel` dep: omitted = the target's own, `false` = none, a factory = that one", async () => {
	const target: Target = { name: "t", kind: "ssh", ssh: { host: "example.invalid" } };
	const exec = async () => ({ code: 0, exitCode: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false, aborted: false });
	// Omitted: built from the target (never started here — warm() only runs after a good probe).
	assert.equal(new Connection(target, [target], undefined, { exec }).status().channelState, "off");
	// `false`: no channel at all, so the status has nothing to say about one.
	assert.equal(new Connection(target, [target], undefined, { exec, channel: false }).status().channelState, undefined);
	// A target with no ssh hop has nothing to pin, even by default.
	const local: Target = { name: "d", kind: "docker", docker: { container: "web" } };
	assert.equal(new Connection(local, [local], undefined, { exec }).status().channelState, undefined);
	const chan = fakeChannel();
	assert.equal(new Connection(target, [target], undefined, { exec, channel: chan.factory }).status().channelState, "off");
});

test("idleClose reaches the live channel and every channel opened after it", async () => {
	const chan = fakeChannel();
	const { c, done } = await setup({ channel: chan.factory });
	await sleep(0);
	assert.deepEqual(chan.idle, [], "nothing said, nothing set");
	c.idleClose(0); // a worker: never idle-close
	assert.deepEqual(chan.idle, [0]);
	await c.reconnect();
	await sleep(0);
	assert.deepEqual(chan.idle, [0, 0], "the channel opened after reconnect gets it too");
	done();
});

test("run(): the far exit code, allowFail, and the far stderr as the error", async () => {
	const { c, done } = await setup();
	assert.equal((await c.run("echo hi")).stdout.toString(), "hi\n");
	await assert.rejects(() => c.run("echo boom >&2; exit 3"), /boom/);
	const r = await c.run("echo boom >&2; exit 3", { allowFail: true });
	assert.deepEqual([r.exitCode, r.stderr.trim()], [3, "boom"]);
	done();
});

test("bash(): streams, runs in the far cwd by default, and reports the far exit code", async () => {
	const { far, calls, c, done } = await setup();
	writeFileSync(join(far, "a.txt"), "x");
	const out: Buffer[] = [];
	assert.deepEqual(await c.bash("ls; exit 7", undefined, { onData: (d) => out.push(d) }), { exitCode: 7 });
	assert.equal(Buffer.concat(out).toString().trim(), "a.txt");
	// hangupGuard + the far cwd: bash is always per call, and dies with its connection.
	assert.match(calls.at(-1)!, /setsid|exec 3<&0/);
	assert.ok(cdsInto(calls.at(-1)!, far), calls.at(-1));
	// An explicit cwd wins over the session's.
	const sub = mkdtempSync(join(far, "sub-"));
	await c.bash("pwd", sub);
	assert.ok(cdsInto(calls.at(-1)!, sub), calls.at(-1));
	done();
});

test("status(): no mount unless a subclass says so, and the probe fills host", async () => {
	const { c, done } = await setup();
	const s = c.status();
	assert.deepEqual([s.state, s.mounted, s.mountPoint, s.pinned], ["online", false, undefined, false]);
	assert.ok(s.host && s.host.includes("@"), s.host);
	assert.ok(s.lastOkAt > 0);
	done();
});

/** Workers launch mcp-server.ts (which imports this file) as `node <file>.ts`: strip-only mode. */
test("connection.ts loads under node's strip-only type stripping", () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const code = `
		const m = await import(${JSON.stringify(join(here, "connection.ts"))});
		if (typeof m.Connection !== "function") throw new Error("no Connection");
		if (typeof m.channelOver !== "function") throw new Error("no channelOver");
	`;
	const r = spawnSync(process.execPath, ["--input-type=module", "--eval", code], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
});

/** The one import rule this file exists to keep: no pi runtime, so a worker can load it. */
test("connection.ts imports nothing from the pi runtime", () => {
	const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "connection.ts"), "utf8");
	// The prose mentions it; an import of it is what must never appear.
	assert.doesNotMatch(src, /from "@earendil-works\//);
});
