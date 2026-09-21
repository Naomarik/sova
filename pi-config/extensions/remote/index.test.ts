/**
 * The remote extension's file tools, run against this machine: a fake `exec` takes the argv the
 * extension built for an ssh target and runs its far command (argv's last word, what the far login
 * shell would parse) with a local `sh -c`, counting invocations. No ssh, no network.
 *
 *   npx tsx --test pi-config/extensions/remote/index.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "pi-remote-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { createBashToolDefinition, createEditToolDefinition, createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition } = await import("@earendil-works/pi-coding-agent");
const { placeholderDir, placeholderRoot } = await import("./argv.ts");
const { CHANNEL_PROGRAM } = await import("./channel.ts");
const { runArgv } = await import("./exec.ts");
const { channelOver, mutating, Remote, remoteGrep } = await import("./index.ts");
type RemoteDeps = import("./index.ts").RemoteDeps;
type ChannelLike = import("./index.ts").ChannelLike;
type RunOptions = import("./exec.ts").RunOptions;

const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A far dir for one test, a Remote on it, and the invocation counter at the run() choke point. */
async function setup(opts: { delayMs?: number; deps?: RemoteDeps } = {}) {
	const far = mkdtempSync(join(tmpdir(), "pi-remote-far-"));
	const calls: string[] = [];
	const exec = async (argv: readonly string[], o?: RunOptions) => {
		calls.push(argv[argv.length - 1]!);
		if (opts.delayMs) await sleep(opts.delayMs);
		return runArgv(["sh", "-c", argv[argv.length - 1]!], o);
	};
	const remote = new Remote({ name: "t", kind: "ssh", ssh: { host: "example.invalid" }, cwd: far }, [], far, { exec, ...opts.deps });
	await remote.preflight();
	calls.length = 0;
	return { far, calls, remote, done: () => (remote.dispose(), rmSync(far, { recursive: true, force: true })) };
}

test("read costs one invocation", async () => {
	const { far, calls, remote, done } = await setup();
	writeFileSync(join(far, "a.txt"), "hello\nworld\n");
	const read = createReadToolDefinition(far, { operations: remote.readOps() });
	const r = await read.execute("1", { path: "a.txt" }, undefined, undefined, undefined as never);
	assert.equal(text(r), "hello\nworld\n");
	assert.equal(calls.length, 1);
	done();
});

test("a failing read costs one invocation and still says why", async () => {
	const { far, calls, remote, done } = await setup();
	const read = createReadToolDefinition(far, { operations: remote.readOps() });
	await assert.rejects(read.execute("1", { path: "missing.txt" }, undefined, undefined, undefined as never), (e: Error) => {
		assert.equal(e.message, `ENOENT: no such file on t: ${far}/missing.txt`);
		return true;
	});
	assert.equal(calls.length, 1);
	if (process.getuid?.() !== 0) {
		writeFileSync(join(far, "secret"), "x");
		chmodSync(join(far, "secret"), 0);
		await assert.rejects(read.execute("2", { path: "secret" }, undefined, undefined, undefined as never), { message: `EACCES: not readable on t: ${far}/secret` });
		assert.equal(calls.length, 2);
	}
	done();
});

test("edit costs two invocations (read + write); write costs one", async () => {
	const { far, calls, remote, done } = await setup();
	writeFileSync(join(far, "b.txt"), "one\ntwo\n");
	const edit = createEditToolDefinition(far, { operations: remote.editOps() });
	await edit.execute("1", { path: "b.txt", edits: [{ oldText: "two", newText: "TWO" }] }, undefined, undefined, undefined as never);
	assert.equal(readFileSync(join(far, "b.txt"), "utf8"), "one\nTWO\n");
	assert.equal(calls.length, 2);

	calls.length = 0;
	const write = createWriteToolDefinition(far, { operations: remote.writeOps() });
	await write.execute("2", { path: "new/dir/c.txt", content: "made" }, undefined, undefined, undefined as never);
	assert.equal(readFileSync(join(far, "new/dir/c.txt"), "utf8"), "made");
	assert.equal(calls.length, 1);

	calls.length = 0;
	await assert.rejects(edit.execute("3", { path: "nope.txt", edits: [{ oldText: "a", newText: "b" }] }, undefined, undefined, undefined as never), {
		message: `Could not edit file: nope.txt. Error: ENOENT: no such file on t: ${far}/nope.txt.`,
	});
	assert.equal(calls.length, 1);
	done();
});

test("ls on one directory costs one invocation", async () => {
	const { far, calls, remote, done } = await setup();
	mkdirSync(join(far, "sub"));
	writeFileSync(join(far, "f.txt"), "");
	writeFileSync(join(far, ".hidden"), "");
	const ls = createLsToolDefinition(far, { operations: remote.lsOps() });
	const r = await ls.execute("1", { path: "." }, undefined, undefined, undefined as never);
	assert.equal(text(r), ".hidden\nf.txt\nsub/");
	assert.equal(calls.length, 1);

	calls.length = 0;
	await assert.rejects(createLsToolDefinition(far, { operations: remote.lsOps() }).execute("2", { path: "f.txt" }, undefined, undefined, undefined as never), {
		message: `Not a directory: ${far}/f.txt`,
	});
	assert.equal(calls.length, 1);
	done();
});

test("concurrent edits of one far file through two local spellings don't lose an update", async () => {
	for (const serialized of [false, true]) {
		const { far, remote, done } = await setup({ delayMs: 30 });
		writeFileSync(join(far, "shared.txt"), "a\nb\n");
		let edit = createEditToolDefinition(far, { operations: remote.editOps() });
		if (serialized) edit = mutating(edit, remote, far);
		// The placeholder path and the cwd-relative path both map to <far>/shared.txt, but pi's own
		// queue keys them apart.
		const viaPlaceholder = `${placeholderRoot(agentDir, "t")}${far}/shared.txt`;
		await Promise.all([
			edit.execute("1", { path: "shared.txt", edits: [{ oldText: "a", newText: "A" }] }, undefined, undefined, undefined as never),
			edit.execute("2", { path: viaPlaceholder, edits: [{ oldText: "b", newText: "B" }] }, undefined, undefined, undefined as never),
		]);
		const got = readFileSync(join(far, "shared.txt"), "utf8");
		if (serialized) assert.equal(got, "A\nB\n");
		else assert.notEqual(got, "A\nB\n", "the race should lose an update without the far-path queue (else this test proves nothing)");
		done();
	}
});

/**
 * A scripted channel: runs counted, state changes reported like channel.ts does. `next` scripts the
 * next channel made: its start can fail with a message, its runs can fail (poison) or abort.
 */
function fakeChannel() {
	type Fake = { state: ChannelLike["state"]; runs: number; fail: boolean; abort: boolean; closed: boolean };
	const made: Fake[] = [];
	const next: { startError?: string; refused?: boolean } = {};
	const factory: RemoteDeps["channel"] = (onState) => {
		const c: Fake = { state: "off", runs: 0, fail: false, abort: false, closed: false };
		const set = (st: ChannelLike["state"]) => {
			if (c.state === st) return;
			c.state = st;
			onState(st);
		};
		const { startError, refused } = next;
		made.push(c);
		return {
			get state() {
				return c.state;
			},
			start: async () => {
				set("warming");
				if (startError) {
					set("dead");
					throw Object.assign(new Error(startError), { refused: !!refused });
				}
				set("idle");
			},
			run: async (command) => {
				c.runs++;
				if (c.fail) {
					set("dead");
					throw new Error("poisoned");
				}
				if (c.abort) {
					set("dead");
					return { code: null, exitCode: null, stdout: Buffer.alloc(0), stderr: "", timedOut: false, aborted: true };
				}
				set("busy");
				await sleep(20);
				set("idle");
				return runArgv(["sh", "-c", command]);
			},
			close: () => {
				c.closed = true;
				set("dead");
			},
		};
	};
	return { made, next, factory };
}

/** A clock the test moves. */
function fakeClock(start = 1_000_000) {
	let t = start;
	return { now: () => t, advance: (ms: number) => void (t += ms) };
}

const REFUSED = "ssh: connect to host 192.0.2.10 port 22: Connection refused";

test("channel policy: warmed after the preflight, used when idle, busy → per call, failures → cooldown", async () => {
	const ch = fakeChannel();
	const clock = fakeClock();
	const statuses: string[] = [];
	const { far, calls, remote, done } = await setup({ deps: { channel: ch.factory, now: clock.now, onStatus: (s) => statuses.push(`${s.channelState}`) } });
	writeFileSync(join(far, "a.txt"), "x");
	await sleep(0);
	assert.equal(ch.made.length, 1, "warmed in the background after the preflight");
	const ops = remote.readOps();

	await ops.readFile(join(far, "a.txt"));
	assert.deepEqual([calls.length, ch.made[0]!.runs], [0, 1], "idle channel serves the call");

	// Two at once: the second must not queue behind the busy channel.
	await Promise.all([ops.readFile(join(far, "a.txt")), ops.readFile(join(far, "a.txt"))]);
	assert.deepEqual([calls.length, ch.made[0]!.runs], [1, 2]);

	// Writes (stdin) always go per call.
	await remote.writeOps().writeFile(join(far, "w.txt"), "w");
	assert.equal(calls.length, 2);

	// A broken channel falls back per call for that same command; no reopen for 30 s, then on the next call.
	ch.made[0]!.fail = true;
	assert.equal((await ops.readFile(join(far, "a.txt"))).toString(), "x");
	assert.equal(calls.length, 3);
	assert.equal(ch.made[0]!.closed, true);
	await sleep(0);
	assert.equal(ch.made.length, 1, "held after a poison teardown");
	clock.advance(30_000);
	await ops.readFile(join(far, "a.txt"));
	await sleep(0);
	assert.equal(ch.made.length, 2, "reopened by the first call after 30 s");

	// Second failure within 60 s: no channel for 60 s, even after the 30 s hold.
	ch.made[1]!.fail = true;
	await ops.readFile(join(far, "a.txt"));
	clock.advance(30_000);
	await ops.readFile(join(far, "a.txt"));
	await sleep(0);
	assert.equal(ch.made.length, 2, "cooling down: not reopened");
	assert.equal(remote.status().pinned, false);
	clock.advance(31_000);
	await ops.readFile(join(far, "a.txt"));
	await sleep(0);
	assert.equal(ch.made.length, 3, "cooldown over: reopened by the next call");
	assert.ok(statuses.includes("idle") && statuses.includes("dead"), statuses.join(","));
	done();
});

test("(a) abort then an immediate call: one open only, none before 30 s", async () => {
	const ch = fakeChannel();
	const clock = fakeClock();
	const { far, calls, remote, done } = await setup({ deps: { channel: ch.factory, now: clock.now } });
	writeFileSync(join(far, "a.txt"), "x");
	await sleep(0);
	assert.equal(ch.made.length, 1);
	const ops = remote.readOps();
	ch.made[0]!.abort = true;
	await assert.rejects(ops.readFile(join(far, "a.txt")), /Operation aborted/);
	assert.equal(ch.made[0]!.state, "dead");
	// Quick successive calls (and a second abort's worth of traffic) go per call; nothing reopens.
	for (let i = 0; i < 3; i++) {
		clock.advance(9_000);
		await ops.readFile(join(far, "a.txt"));
		await sleep(0);
	}
	assert.equal(ch.made.length, 1, "no reopen within 30 s of the teardown");
	assert.equal(calls.length, 3);
	clock.advance(3_000);
	await sleep(0);
	assert.equal(ch.made.length, 1, "the gap passing alone opens nothing: it waits for a tool call");
	await ops.readFile(join(far, "a.txt"));
	await sleep(0);
	assert.equal(ch.made.length, 2, "the first call after 30 s reopens, once");
	done();
});

test("(b) a start refused by the host is rate limiting: backoff, not a failure", async () => {
	const ch = fakeChannel();
	ch.next.startError = REFUSED;
	const clock = fakeClock();
	const { far, calls, remote, done } = await setup({ deps: { channel: ch.factory, now: clock.now } });
	writeFileSync(join(far, "a.txt"), "x");
	await sleep(0);
	const s = remote.status();
	assert.equal(s.state, "online", "per call still works");
	assert.equal(s.channelState, "rate-limited");
	assert.equal(s.channelRetryAt, clock.now() + 45_000);
	assert.equal(s.pinned, false);
	assert.equal(s.error, REFUSED);
	assert.equal((remote as unknown as { channelFailures: number[] }).channelFailures.length, 0, "not counted");
	ch.next.startError = undefined;
	const ops = remote.readOps();
	clock.advance(44_000);
	await ops.readFile(join(far, "a.txt"));
	await sleep(0);
	assert.equal(calls.length, 1, "during the backoff: per call");
	assert.equal(ch.made.length, 1, "no reopen before channelRetryAt");
	clock.advance(1_000);
	await ops.readFile(join(far, "a.txt"));
	await sleep(0);
	assert.equal(ch.made.length, 2, "retried by the first call after channelRetryAt");
	assert.equal(remote.status().channelState, "idle");
	assert.equal(remote.status().channelRetryAt, undefined);

	// /remote reconnect bypasses the backoff once.
	ch.next.startError = REFUSED;
	await remote.reconnect();
	await sleep(0);
	assert.equal(ch.made.length, 3, "reconnect opens at once");
	assert.equal(remote.status().channelState, "rate-limited");
	await remote.reconnect();
	await sleep(0);
	assert.equal(ch.made.length, 4, "each reconnect is an explicit, single retry");
	await ops.readFile(join(far, "a.txt"));
	await sleep(0);
	assert.equal(ch.made.length, 4, "…but calls still respect the backoff");
	done();
});

test("(b′) channel.ts's `refused` flag alone marks rate limiting", async () => {
	const ch = fakeChannel();
	Object.assign(ch.next, { startError: "channel exited (code 255)", refused: true });
	const clock = fakeClock();
	const { remote, done } = await setup({ deps: { channel: ch.factory, now: clock.now } });
	await sleep(0);
	assert.equal(remote.status().channelState, "rate-limited");
	assert.equal((remote as unknown as { channelFailures: number[] }).channelFailures.length, 0);
	done();
});

test("(c) a start failure that isn't a refusal still counts toward the cooldown", async () => {
	const ch = fakeChannel();
	ch.next.startError = "channel not ready within 15s";
	const clock = fakeClock();
	const { remote, done } = await setup({ deps: { channel: ch.factory, now: clock.now } });
	await sleep(0);
	assert.equal((remote as unknown as { channelFailures: number[] }).channelFailures.length, 1);
	assert.equal(remote.status().channelState, "dead");
	assert.equal(remote.status().channelRetryAt, undefined);
	done();
});

test("status JSON: unknown → online, then unreachable with the error's first line", async () => {
	const seen: import("./index.ts").RemoteStatus[] = [];
	const events: string[] = [];
	let down = false;
	const exec = async (argv: readonly string[], o?: RunOptions) =>
		down
			? { code: 255, exitCode: 255, stdout: Buffer.alloc(0), stderr: "ssh: connect to host example.invalid port 22: Connection refused\n", timedOut: false, aborted: false }
			: runArgv(["sh", "-c", argv[argv.length - 1]!], o);
	const far = mkdtempSync(join(tmpdir(), "pi-remote-far-"));
	const remote = new Remote({ name: "t", kind: "ssh", ssh: { host: "example.invalid" }, cwd: far }, [], far, {
		exec,
		onStatus: (s) => seen.push(s),
		onEvent: (t) => events.push(t),
	});
	remote.emit();
	assert.equal(seen[0]!.state, "unknown");
	assert.equal(seen[0]!.lastOkAt, 0);
	await remote.preflight();
	const online = seen[seen.length - 1]!;
	assert.equal(online.state, "online");
	assert.match(online.host!, /^.+@.+$/);
	assert.equal(typeof online.latencyMs, "number");
	assert.ok(online.lastOkAt > 0 && online.at >= online.lastOkAt);
	assert.equal(online.pinned, false);
	assert.equal(online.channelState, undefined, "no channel configured: no channelState");

	down = true;
	await assert.rejects(remote.run("true"), /unreachable/);
	const lost = seen[seen.length - 1]!;
	assert.equal(lost.state, "unreachable");
	assert.equal(lost.error, `Target "t" (example.invalid) is unreachable: ssh: connect to host example.invalid port 22: Connection refused`);
	assert.deepEqual(events, [`remote: ${lost.error}`]);

	const before = seen.length;
	remote.republish();
	assert.equal(seen.length, before + 1);
	assert.deepEqual({ ...seen[seen.length - 1]!, at: 0 }, { ...lost, at: 0 }, "republish sends the same status");
	assert.equal(events.length, 1, "republish never toasts");

	down = false;
	const back = await remote.check();
	assert.equal(back.state, "online");
	assert.deepEqual(events.slice(1), ["remote: t reconnected"]);
	remote.dispose();
	rmSync(far, { recursive: true, force: true });
});

test("status JSON: a long command shows runningMs on every tick, and drops it when done", async () => {
	const seen: import("./index.ts").RemoteStatus[] = [];
	const { remote, done } = await setup({ deps: { statusTickMs: 40, onStatus: (s) => seen.push(s) } });
	seen.length = 0;
	await remote.run("sleep 0.25");
	const running = seen.filter((s) => s.runningMs !== undefined);
	assert.ok(running.length >= 3, `ticks: ${running.length}`);
	assert.ok(running.every((s, i) => i === 0 || s.runningMs! > running[i - 1]!.runningMs!));
	assert.equal(seen[seen.length - 1]!.runningMs, undefined);
	done();
});

test("/remote status re-publishes the current status without spawning or touching the channel", async () => {
	const ch = fakeChannel();
	const seen: import("./index.ts").RemoteStatus[] = [];
	const { calls, remote, done } = await setup({ deps: { channel: ch.factory, onStatus: (s) => seen.push(s) } });
	await sleep(0);
	const runs = ch.made.map((c) => c.runs);
	const before = seen.length;
	remote.republish();
	assert.equal(seen.length, before + 1);
	assert.equal(seen[seen.length - 1]!.state, "online");
	assert.equal(calls.length, 0, "no per-call spawn");
	assert.deepEqual(ch.made.map((c) => c.runs), runs, "no channel command");
	assert.equal(ch.made.length, runs.length, "no channel started");
	done();
});

test("the real channel loop, locally: reads ride it with zero spawns; errors keep their wording", async () => {
	const factory = channelOver(["sh", "-c", CHANNEL_PROGRAM]);
	const { far, calls, remote, done } = await setup({ deps: { channel: factory } });
	writeFileSync(join(far, "a.txt"), "over the channel\n");
	for (let i = 0; i < 50 && remote.status().channelState !== "idle"; i++) await sleep(20);
	assert.equal(remote.status().channelState, "idle");
	assert.equal(remote.status().pinned, true);
	const read = createReadToolDefinition(far, { operations: remote.readOps() });
	assert.equal(text(await read.execute("1", { path: "a.txt" }, undefined, undefined, undefined as never)), "over the channel\n");
	await assert.rejects(read.execute("2", { path: "missing" }, undefined, undefined, undefined as never), { message: `ENOENT: no such file on t: ${far}/missing` });
	const ls = createLsToolDefinition(far, { operations: remote.lsOps() });
	assert.equal(text(await ls.execute("3", { path: "." }, undefined, undefined, undefined as never)), "a.txt");
	const r = await remote.run("echo out; echo warn >&2");
	assert.deepEqual([r.stdout.toString(), r.stderr], ["out\n", "warn\n"], "stderr stays out of the output parsed");
	assert.equal(calls.length, 0);
	done();
});

// ---------------------------------------------------------------------------
// mounted mode: read/write/edit through the mount; bash/ls/find/grep remote; no channel

/**
 * A mounted-session scaffold: a "far" tree (the fake exec runs far commands locally with the
 * synthetic root /srv/app rewritten to it), a plain local dir standing in as the mount point
 * (the isMounted dep decides whether it counts as mounted), a dir outside the mount, and the
 * invocation counter. No network.
 */
function mountedRemote(isMounted: RemoteDeps["isMounted"], opts: { channel?: RemoteDeps["channel"] } = {}) {
	const far = mkdtempSync(join(tmpdir(), "pi-remote-far-"));
	const mountPoint = mkdtempSync(join(tmpdir(), "pi-mount-"));
	const localCwd = join(mountPoint, "work");
	const outside = mkdtempSync(join(tmpdir(), "pi-mount-outside-"));
	mkdirSync(join(far, "work"));
	mkdirSync(localCwd);
	writeFileSync(join(far, "work", "far-only.txt"), "far view\n");
	writeFileSync(join(localCwd, "a.txt"), "local view\n");
	writeFileSync(join(outside, "f.txt"), "host view\n");
	const calls: string[] = [];
	const exec = async (argv: readonly string[], o?: RunOptions) => {
		calls.push(argv[argv.length - 1]!);
		return runArgv(["sh", "-c", (argv[argv.length - 1] as string).replaceAll("/srv/app", far)], o);
	};
	const remote = new Remote(
		{ name: "t", kind: "ssh", ssh: { host: "example.invalid" }, cwd: "/srv/app", mount: { remote: "/srv/app", local: mountPoint } },
		[],
		localCwd,
		{ exec, isMounted, ...opts },
	);
	const done = () => {
		remote.dispose();
		for (const d of [far, mountPoint, outside]) rmSync(d, { recursive: true, force: true });
	};
	return { far, mountPoint, localCwd, outside, calls, remote, done };
}

test("mounted mode: read/write/edit local through the mount; bash, ls, find, grep remote; no channel", async () => {
	const ch = fakeChannel();
	const { far, mountPoint, localCwd, outside, calls, remote, done } = mountedRemote(() => true, { channel: ch.factory });
	const info = await remote.preflight();
	assert.equal(remote.mountedMode, true);
	assert.equal(info.cwd, `${far}/work`, "the far cwd is derived through the mount mapping, not the placeholder");
	assert.equal(remote.toFar(join(localCwd, "a.txt")), "/srv/app/work/a.txt");
	calls.length = 0;

	// read → LOCAL: the mount's copy, zero far invocations.
	const read = createReadToolDefinition(localCwd, { operations: remote.readOps() });
	assert.equal(text(await read.execute("1", { path: "a.txt" }, undefined, undefined, undefined as never)), "local view\n");
	// write → LOCAL (parents through the mount).
	const write = createWriteToolDefinition(localCwd, { operations: remote.writeOps() });
	await write.execute("2", { path: "new/d.txt", content: "made" }, undefined, undefined, undefined as never);
	assert.equal(readFileSync(join(localCwd, "new/d.txt"), "utf8"), "made");
	// edit → LOCAL.
	const edit = createEditToolDefinition(localCwd, { operations: remote.editOps() });
	await edit.execute("3", { path: "a.txt", edits: [{ oldText: "local", newText: "LOCAL" }] }, undefined, undefined, undefined as never);
	assert.equal(readFileSync(join(localCwd, "a.txt"), "utf8"), "LOCAL view\n");
	assert.equal(readFileSync(join(far, "work", "far-only.txt"), "utf8"), "far view\n", "the far tree untouched by the local tools");
	assert.equal(calls.length, 0, "read/write/edit cost zero far invocations in mounted mode");

	// bash → REMOTE, always: the cwd maps through the mount config and the host's shell runs there.
	const bash = createBashToolDefinition(localCwd, { operations: remote.bashOps() });
	const b = await bash.execute("4", { command: "pwd" }, undefined, undefined, undefined as never);
	assert.ok(text(b).includes(`${far}/work`), `bash ran on the host: ${text(b)}`);
	assert.equal(calls.length, 1);
	// ls → REMOTE: it lists the far tree, not the mount's local dir.
	const ls = createLsToolDefinition(localCwd, { operations: remote.lsOps() });
	assert.equal(text(await ls.execute("5", { path: "." }, undefined, undefined, undefined as never)), "far-only.txt");
	// find → REMOTE.
	assert.deepEqual(await remote.findOps().glob("*.txt", localCwd, { ignore: [], limit: 10 }), ["far-only.txt"]);
	// grep → REMOTE.
	const g = await remoteGrep(remote).execute("6", { pattern: "far view" }, undefined);
	assert.match(text(g), /far-only\.txt:1: far view/);
	assert.equal(calls.length, 4, "exactly the four remote tools spawned; nothing for read/write/edit");

	// The channel is never built in mounted mode (fuse provides the fast lane; a channel would
	// cost a second ssh login).
	assert.equal(ch.made.length, 0);
	const s = remote.status();
	assert.deepEqual([s.mounted, s.mountPoint, s.pinned, s.channelState], [true, mountPoint, false, "off"]);
	assert.deepEqual(
		Object.keys(s).sort(),
		["at", "channelState", "host", "lastOkAt", "latencyMs", "mountPoint", "mounted", "pinned", "state", "target"],
		"mounted and mountPoint are added; the other fields unchanged",
	);

	// An absolute path OUTSIDE the mount still means the host, exactly as today.
	assert.equal((await remote.readOps().readFile(join(outside, "f.txt"))).toString(), "host view\n");
	assert.equal(calls.length, 5);
	done();
});

test("mounted mode with the mount gone: file tools fail closed; the remote tools still run", async () => {
	let up = true;
	const { localCwd, outside, calls, remote, done } = mountedRemote(() => up);
	await remote.preflight();
	calls.length = 0;
	const read = remote.readOps();
	await read.access(join(localCwd, "a.txt")); // works while the mount is up
	up = false;
	await assert.rejects(read.access(join(localCwd, "a.txt")), /the sshfs mount for target t at .* is gone; remount it \(\/remote mount\)/);
	await assert.rejects(read.readFile(join(localCwd, "a.txt")), /is gone/);
	await assert.rejects(remote.writeOps().writeFile(join(localCwd, "x.txt"), "y"), /is gone/);
	await assert.rejects(remote.editOps().readFile(join(localCwd, "a.txt")), /is gone/);
	// paths outside the mount, and the remote tools, are unaffected:
	assert.equal((await read.readFile(join(outside, "f.txt"))).toString(), "host view\n");
	assert.equal((await remote.bashOps().exec("true", localCwd, { onData: () => {} })).exitCode, 0);
	assert.equal(calls.length, 2);
	// …and the mount coming back heals the file tools with no re-registration:
	up = true;
	assert.equal((await read.readFile(join(localCwd, "a.txt"))).toString(), "local view\n");
	done();
});

test("a mount-configured target, placeholder cwd: today's behavior exactly, channel and all", async () => {
	const far = mkdtempSync(join(tmpdir(), "pi-remote-far-"));
	const mountPoint = mkdtempSync(join(tmpdir(), "pi-mount-"));
	const cwd = placeholderDir(agentDir, "t", far);
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(cwd, "a.txt"), "x");
	writeFileSync(join(far, "a.txt"), "x"); // the copy the fake far side serves
	const calls: string[] = [];
	const exec = async (argv: readonly string[], o?: RunOptions) => {
		calls.push(argv[argv.length - 1]!);
		return runArgv(["sh", "-c", argv[argv.length - 1]!], o);
	};
	const ch = fakeChannel();
	const remote = new Remote(
		{ name: "t", kind: "ssh", ssh: { host: "example.invalid" }, cwd: far, mount: { remote: "/srv/app", local: mountPoint } },
		[],
		cwd,
		{ exec, channel: ch.factory, isMounted: () => true },
	);
	try {
		assert.equal(remote.mountedMode, false, "the cwd decides the mode, not the target's mount");
		await remote.preflight();
		calls.length = 0;
		const read = createReadToolDefinition(cwd, { operations: remote.readOps() });
		assert.equal(text(await read.execute("1", { path: "a.txt" }, undefined, undefined, undefined as never)), "x");
		assert.deepEqual([calls.length, ch.made[0]!.runs], [0, 1], "read stays remote (over the channel), the target's mount being up changes nothing");
		await sleep(0);
		assert.equal(ch.made.length, 1, "the channel warms exactly as today");
		// the status is TARGET-level: mounted reflects the live table whatever this session's cwd is.
		const s = remote.status();
		assert.equal(s.mounted, true);
		assert.equal(s.mountPoint, mountPoint);
		// a session whose cwd is inside the mount point with the mount DOWN at start is not mounted
		// mode either: it keeps today's remote routing.
		const down = new Remote(
			{ name: "t", kind: "ssh", ssh: { host: "example.invalid" }, cwd: "/srv/app", mount: { remote: "/srv/app", local: mountPoint } },
			[],
			join(mountPoint, "work"),
			{ exec, isMounted: () => false },
		);
		assert.equal(down.mountedMode, false);
		assert.equal(down.status().mounted, false, "…but the status reports the real table: not mounted");
		down.dispose();
	} finally {
		remote.dispose();
		rmSync(far, { recursive: true, force: true });
		rmSync(mountPoint, { recursive: true, force: true });
	}
});

test("a plain target's status: mounted false, no mountPoint, the rest as before", async () => {
	const { remote, done } = await setup();
	const s = remote.status();
	assert.equal(s.mounted, false);
	assert.equal(s.mountPoint, undefined);
	assert.ok(!("mountPoint" in s));
	done();
});
