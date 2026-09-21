import { test } from "node:test";
import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { buildTargetArgv, type Target } from "./argv.ts";
import {
	buildChannelArgv,
	Channel,
	CHANNEL_PROGRAM,
	ChannelError,
	type ChannelState,
	composeChannelScript,
	encodeRequest,
	ResponseParser,
} from "./channel.ts";

/** A channel on a LOCAL `sh` running the real far loop: no network. */
function local(extra: Partial<ConstructorParameters<typeof Channel>[0]> = {}) {
	const states: ChannelState[] = [];
	const ch = new Channel({ argv: ["sh", "-c", CHANNEL_PROGRAM], onState: (s) => states.push(s), ...extra });
	return { ch, states };
}

/** A scripted child: the test plays the far side byte by byte. */
function fake() {
	const child = new EventEmitter() as EventEmitter & {
		stdin: PassThrough;
		stdout: PassThrough;
		stderr: PassThrough;
		exitCode: number | null;
		signalCode: string | null;
		killed: boolean;
		kill: (sig?: string) => boolean;
	};
	child.stdin = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.exitCode = null;
	child.signalCode = null;
	child.killed = false;
	child.kill = (sig = "SIGTERM") => {
		child.killed = true;
		child.signalCode = sig;
		setImmediate(() => child.emit("exit", null, sig));
		return true;
	};
	const written: Buffer[] = [];
	child.stdin.on("data", (d: Buffer) => written.push(d));
	const ch = new Channel({ argv: ["fake"], spawn: () => child as unknown as ChildProcessWithoutNullStreams });
	const say = (s: string | Buffer) => child.stdout.write(s);
	return { ch, child, say, written };
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const tick = () => new Promise((r) => setImmediate(r));

async function collect(ch: Channel, command: string, cwd?: string) {
	const out: Buffer[] = [];
	const r = await ch.run({ command, cwd, onData: (d) => out.push(d) });
	return { exitCode: r.exitCode, out: Buffer.concat(out) };
}

test("length-prefixed request round-trips newlines, quotes and $()", async () => {
	const { ch } = local();
	await ch.start();
	const dir = mkdtempSync(join(tmpdir(), "pi-ch-it's $(x) "));
	try {
		const command = `a='single '\\'' quote'; b="dbl \\" $(printf sub)"\nprintf '%s|%s|%s\\n' "$a" "$b" "$(pwd)"\necho 'line1\nline2'\necho "@@pi-ch@@ 1 0"; printf 'no newline'`;
		const r = await collect(ch, command, dir);
		assert.equal(r.exitCode, 0);
		assert.equal(r.out.toString(), `single ' quote|dbl " sub|${dir}\nline1\nline2\n@@pi-ch@@ 1 0\nno newline`);
		// trailing newlines in the script survive (the far side's $(...) would strip them)
		const r2 = await collect(ch, "cat <<'EOF'\nx\nEOF\n\n\n");
		assert.equal(r2.out.toString(), "x\n");
		// multi-byte: the length is in bytes
		assert.equal((await collect(ch, "echo 'héllo ✓'")).out.toString(), "héllo ✓\n");
		assert.equal((await collect(ch, "exit 7")).exitCode, 7);
		assert.equal((await collect(ch, "true", join(dir, "missing"))).exitCode, 1);
		assert.equal((await collect(ch, "echo \"$FOO\"", undefined)).out.toString(), "\n");
		const out: Buffer[] = [];
		await ch.run({ command: 'echo "$FOO"', env: { FOO: "it's $(x)" }, onData: (d) => out.push(d) });
		assert.equal(Buffer.concat(out).toString(), "it's $(x)\n");
		assert.ok(ch.isReady());
	} finally {
		ch.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("binary output with NULs round-trips byte-exactly", async () => {
	const { ch } = local();
	await ch.start();
	const dir = mkdtempSync(join(tmpdir(), "pi-ch-"));
	try {
		const bytes = Buffer.alloc(300_000);
		for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919 + (i >> 8)) & 0xff;
		bytes.write("\n@@pi-ch@@ 1 0\n", 1000, "latin1");
		const f = join(dir, "bin");
		writeFileSync(f, bytes);
		const r = await collect(ch, `cat ${f}; printf '\\000'`);
		assert.equal(r.exitCode, 0);
		assert.ok(r.out.equals(Buffer.concat([bytes, Buffer.from([0])])));
	} finally {
		ch.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("rc >= 129 is already 128 + signal", async () => {
	const { ch } = local();
	await ch.start();
	try {
		assert.equal((await ch.run({ command: "kill -TERM $$" })).exitCode, 143);
		assert.equal((await ch.run({ command: "kill -KILL $$" })).exitCode, 137);
		assert.equal((await ch.run({ command: "exit 0" })).exitCode, 0);
	} finally {
		ch.kill();
	}
});

test("two concurrent runs: one refusal, not a queue", async () => {
	const { ch } = local();
	await ch.start();
	try {
		const a = ch.run({ command: "sleep 0.2; echo a" });
		assert.ok(ch.isBusy());
		await assert.rejects(ch.run({ command: "echo b" }), (e: ChannelError) => e.reason === "busy" && e.sent === false);
		assert.equal((await a).exitCode, 0);
		assert.ok(ch.isReady());
	} finally {
		ch.kill();
	}
});

test("abort tears the channel down, kills the far command, and leaves nothing reusable", async () => {
	const { ch, states } = local();
	await ch.start();
	const dir = mkdtempSync(join(tmpdir(), "pi-ch-"));
	try {
		const pidFile = join(dir, "pid");
		const ac = new AbortController();
		const p = ch.run({ command: `echo $$ > ${pidFile}; sleep 30`, signal: ac.signal });
		while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8").trim()) await new Promise((r) => setTimeout(r, 20));
		const pid = Number(readFileSync(pidFile, "utf8"));
		ac.abort();
		await assert.rejects(p, (e: ChannelError) => e.reason === "aborted" && e.sent === true && e.exitCode === null);
		assert.equal(ch.state, "dead");
		assert.deepEqual(states, ["warming", "idle", "busy", "dead"]);
		await assert.rejects(ch.run({ command: "true" }), (e: ChannelError) => e.reason === "not-ready");
		// the far watchdog saw the channel's EOF and killed the command's process group
		const deadline = Date.now() + 3000;
		let alive = true;
		while (alive && Date.now() < deadline) {
			try {
				process.kill(pid, 0);
				await new Promise((r) => setTimeout(r, 50));
			} catch {
				alive = false;
			}
		}
		assert.equal(alive, false, "far command still running after abort");
	} finally {
		ch.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("timeout tears the channel down", async () => {
	const { ch } = local();
	await ch.start();
	await assert.rejects(ch.run({ command: "sleep 5", timeoutMs: 150 }), (e: ChannelError) => e.reason === "timeout");
	assert.equal(ch.state, "dead");
});

test("an already-aborted signal is refused before anything is sent", async () => {
	const { ch } = local();
	await ch.start();
	try {
		await assert.rejects(ch.run({ command: "true", signal: AbortSignal.abort() }), (e: ChannelError) => e.reason === "aborted" && !e.sent);
		assert.ok(ch.isReady());
	} finally {
		ch.kill();
	}
});

test("kill() rejects the outstanding request", async () => {
	const { ch } = local();
	await ch.start();
	const p = ch.run({ command: "sleep 30" });
	ch.kill();
	await assert.rejects(p, (e: ChannelError) => e.reason === "killed" && e.sent);
	assert.equal(ch.death?.reason, "killed");
});

test("output over 16 MB poisons", async () => {
	const { ch } = local();
	await ch.start();
	let got = 0;
	await assert.rejects(
		ch.run({ command: "head -c 17000000 /dev/zero", onData: (d) => (got += d.length) }),
		(e: ChannelError) => e.reason === "poisoned" && /16 MB/.test(e.message),
	);
	assert.ok(got <= 16 * 1024 * 1024);
	assert.equal(ch.state, "dead");
});

test("idleClose closes an idle channel; a request disarms it", async () => {
	const { ch } = local({ idleMs: 150 });
	await ch.start();
	await ch.run({ command: "sleep 0.3" }); // longer than idleMs: the timer is off while busy
	assert.ok(ch.isReady());
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(ch.state, "dead");
	assert.equal(ch.death?.reason, "idle");
});

test("start fails fast when the far side can't run the loop", async () => {
	const ch = new Channel({ argv: ["sh", "-c", "echo 'Permission denied (publickey).' >&2; exit 255"] });
	await assert.rejects(ch.start(), /Permission denied/);
	assert.equal(ch.death?.reason, "start-failed");
	assert.equal(ch.death?.refused, undefined);
	const refused = new Channel({ argv: ["sh", "-c", "echo 'ssh: connect to host 192.0.2.1 port 22: Connection refused' >&2; exit 255"] });
	await assert.rejects(refused.start(), /Connection refused/);
	assert.deepEqual([refused.death?.reason, refused.death?.refused], ["start-failed", true]);
	const slow = new Channel({ argv: ["sh", "-c", "sleep 5"], startTimeoutMs: 100 });
	await assert.rejects(slow.start(), /not ready within/);
});

test("a failed start carries ssh's stderr even under load (stdout end can beat the stderr read)", async () => {
	const msgs = await Promise.all(
		Array.from({ length: 60 }, () => {
			const ch = new Channel({ argv: ["sh", "-c", "echo 'ssh: connect to host 192.0.2.1 port 22: Connection refused' >&2; exit 255"] });
			return ch.start().then(
				() => "started?!",
				(e: Error) => `${e.message} refused=${ch.death?.refused}`,
			);
		}),
	);
	for (const m of msgs) assert.match(m, /Connection refused refused=true$/);
});

test("login noise before the ready line is skipped", async () => {
	const { ch, say } = fake();
	const started = ch.start();
	say("Welcome to Ubuntu\n@@pi-ch@@ rea");
	await tick();
	assert.equal(ch.state, "warming");
	say("dy\n");
	await started;
	assert.ok(ch.isReady());
	ch.kill();
});

test("exec(): RunResult shape, stderr apart, stdin input, scripts past the 128 KB argv limit", async () => {
	const { ch } = local();
	await ch.start();
	try {
		const r = await ch.exec("echo out; echo err >&2; exit 2", { cwd: "/tmp" });
		assert.deepEqual({ ...r, stdout: r.stdout.toString() }, { code: 2, exitCode: 2, stdout: "out\n", stderr: "err\n", timedOut: false, aborted: false });
		// binary stdin with NULs, 1 MB: the payload rides inside the script
		const bytes = Buffer.alloc(1_000_000);
		for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 7)) & 0xff;
		const echo = await ch.exec("cat");
		assert.equal(echo.stdout.length, 0); // no input = /dev/null
		const cat = await ch.exec("cat", { input: bytes });
		assert.equal(cat.exitCode, 0);
		assert.ok(cat.stdout.equals(bytes));
		// a 300 KB command (one argv string caps at 128 KB)
		const big = await ch.exec(`x='${"a".repeat(300_000)}'; printf %s "\${#x}"`);
		assert.equal(big.stdout.toString(), "300000");
		// stderr is capped at 64 KB
		const noisy = await ch.exec("head -c 100000 /dev/zero | tr '\\0' e >&2");
		assert.equal(noisy.stderr.length, 64 * 1024);
		// merged mode still merges
		const out: Buffer[] = [];
		await ch.run({ command: "echo a; echo b >&2", onData: (d) => out.push(d) });
		assert.equal(Buffer.concat(out).toString(), "a\nb\n");
		// abort resolves with aborted and leaves the channel dead
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 100);
		const ab = await ch.exec("sleep 5", { signal: ac.signal });
		assert.equal(ab.aborted, true);
		assert.equal(ab.exitCode, null);
		assert.equal(ch.state, "dead");
		await assert.rejects(ch.exec("true"), (e: ChannelError) => e.reason === "not-ready" && !e.sent);
	} finally {
		ch.close();
	}
});

test("exec() timeout resolves with timedOut", async () => {
	const { ch } = local();
	await ch.start();
	const r = await ch.exec("sleep 5", { timeoutMs: 100 });
	assert.equal(r.timedOut, true);
	assert.equal(ch.state, "dead");
});

// --- the scripted far side ---------------------------------------------------

test("the request is length-prefixed on the wire", async () => {
	const { ch, say, written } = fake();
	const started = ch.start();
	say("@@pi-ch@@ ready\n");
	await started;
	const p = ch.run({ command: "echo 'a\nb' $(x)", cwd: "/srv/it's" });
	await tick();
	const script = composeChannelScript("echo 'a\nb' $(x)", "/srv/it's");
	assert.equal(script, "cd -- '/srv/it'\\''s' || exit 1\necho 'a\nb' $(x)");
	assert.ok(Buffer.concat(written).equals(encodeRequest("1", script)));
	assert.equal(Buffer.concat(written).toString(), `1 ${Buffer.byteLength(script)} m\n${script}\n`);
	say("\n@@pi-ch@@ 1 0\n");
	assert.deepEqual(await p, { exitCode: 0, stderr: "" });
	ch.kill();
});

test("a marker split across reads is never emitted as data", async () => {
	for (const cut of [1, 3, 8, 12, 14]) {
		const { ch, say } = fake();
		const started = ch.start();
		say("@@pi-ch@@ ready\n");
		await started;
		const out: Buffer[] = [];
		const p = ch.run({ command: "x", onData: (d) => out.push(d) });
		const wire = `${b64("hello world")}\n@@pi-ch@@ 1 5\n`;
		const at = b64("hello world").length + cut;
		say(wire.slice(0, at));
		await tick();
		say(wire.slice(at));
		assert.deepEqual(await p, { exitCode: 5, stderr: "" });
		assert.equal(Buffer.concat(out).toString(), "hello world");
		ch.kill();
	}
	// and one byte at a time
	const { ch, say } = fake();
	const started = ch.start();
	say("@@pi-ch@@ ready\n");
	await started;
	const out: Buffer[] = [];
	const p = ch.run({ command: "x", onData: (d) => out.push(d) });
	for (const c of `${b64("byte by byte")}\n@@pi-ch@@ 1 0\n`) {
		say(c);
		await tick();
	}
	await p;
	assert.equal(Buffer.concat(out).toString(), "byte by byte");
	ch.kill();
});

async function poisoned(wire: string, match: RegExp) {
	const { ch, say, child } = fake();
	const started = ch.start();
	say("@@pi-ch@@ ready\n");
	await started;
	const p = ch.run({ command: "x" });
	say(wire);
	await assert.rejects(p, (e: ChannelError) => e.reason === "poisoned" && match.test(e.message));
	assert.equal(ch.state, "dead");
	assert.ok(child.killed, "ssh child killed");
	await assert.rejects(ch.run({ command: "x" }), (e: ChannelError) => e.reason === "not-ready");
}

test("an id mismatch poisons", () => poisoned(`${b64("hi")}\n@@pi-ch@@ 2 0\n`, /request 2 while 1/));
test("a non-base64 byte poisons", () => poisoned(`${b64("hi")}\x00\n@@pi-ch@@ 1 0\n`, /non-base64 byte 0x00/));
test("a malformed terminator poisons", () => poisoned(`${b64("hi")}\n@@pi-XX@@ 1 0\n`, /malformed terminator/));
test("truncated base64 poisons", () => poisoned(`aGk\n@@pi-ch@@ 1 0\n`, /truncated/));
test("data after padding poisons", () => poisoned(`aA==aGk=\n@@pi-ch@@ 1 0\n`, /after padding/));
test("output after the terminator poisons (the finished request still resolves)", async () => {
	const { ch, say, child } = fake();
	const started = ch.start();
	say("@@pi-ch@@ ready\n");
	await started;
	const p = ch.run({ command: "x" });
	say("\n@@pi-ch@@ 1 0\nextra");
	assert.deepEqual(await p, { exitCode: 0, stderr: "" });
	assert.equal(ch.state, "dead");
	assert.match(ch.death!.message, /after the terminator/);
	assert.ok(child.killed);
});

test("a terminator in the wrong stderr mode poisons", () => poisoned(`\n@@pi-ch@@ 1 0 ZXJy\n`, /stderr mode/));

test("output while idle poisons", async () => {
	const { ch, say } = fake();
	const started = ch.start();
	say("@@pi-ch@@ ready\n");
	await started;
	say("stray");
	await tick();
	assert.equal(ch.state, "dead");
	assert.equal(ch.death?.reason, "poisoned");
});

test("EOF with a request outstanding rejects", async () => {
	const { ch, say, child } = fake();
	const started = ch.start();
	say("@@pi-ch@@ ready\n");
	await started;
	const p = ch.run({ command: "x" });
	say(b64("partial"));
	child.stderr.write("Connection reset by peer\n");
	await tick();
	child.stdout.end();
	await assert.rejects(p, (e: ChannelError) => e.reason === "lost" && e.sent && e.exitCode === null && /Connection reset/.test(e.message));
	assert.equal(ch.state, "dead");
});

test("a request write that never flushes poisons", async () => {
	const { child, say } = fake();
	child.stdin.write = (() => false) as never; // a stalled pipe: the write callback never fires
	const ch = new Channel({ argv: ["fake"], spawn: () => child as unknown as ChildProcessWithoutNullStreams, writeTimeoutMs: 50 });
	const started = ch.start();
	say("@@pi-ch@@ ready\n");
	await started;
	await assert.rejects(ch.run({ command: "x" }), (e: ChannelError) => e.reason === "poisoned" && /not flushed/.test(e.message));
	assert.ok(child.killed);
});

test("the parser flushes decoded bytes as they arrive", () => {
	const out: Buffer[] = [];
	let rc = -1;
	const p = new ResponseParser("9", { onData: (d) => out.push(d), onDone: (r) => (rc = r), onPoison: (w) => assert.fail(w) });
	const payload = b64(Buffer.from([0, 1, 2, 255, 254, 10, 13]));
	p.feed(Buffer.from(payload.slice(0, 5)));
	assert.equal(Buffer.concat(out).length, 3); // one whole quad decoded, the rest held
	p.feed(Buffer.from(payload.slice(5) + "\n@@pi-ch@@ 9 130\n"));
	assert.deepEqual([...Buffer.concat(out)], [0, 1, 2, 255, 254, 10, 13]);
	assert.equal(rc, 130);
});

// --- argv ----------------------------------------------------------------------

test("buildChannelArgv: its own connection, the same far side", () => {
	const t: Target = { name: "p", kind: "ssh", ssh: { user: "deploy", host: "h.example", port: 2222, key: "/k", options: ["ControlPersist=1h", "ControlMaster=auto", "Compression=yes"] } };
	const argv = buildChannelArgv(t)!;
	assert.deepEqual(argv.slice(0, 8), ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none"]);
	assert.ok(!argv.some((w) => /^ControlPersist|ControlMaster=auto/.test(w)));
	assert.ok(argv.includes("Compression=yes") && argv.includes("ConnectTimeout=10") && argv.includes("ServerAliveInterval=15") && argv.includes("ServerAliveCountMax=2"));
	assert.deepEqual(argv.slice(-7, -2), ["-p", "2222", "-i", "/k", "--"]);
	assert.equal(argv.at(-2), "deploy@h.example");
	const perCall = buildTargetArgv(t, { command: CHANNEL_PROGRAM, cwd: "" });
	assert.equal(argv.at(-1), perCall.at(-1));

	// docker over ssh via another target: the far side keeps its docker exec layer
	const host: Target = { name: "host", kind: "ssh", ssh: { host: "h2" } };
	const box: Target = { name: "box", kind: "docker", docker: { container: "web" }, via: "host" };
	const nested = buildChannelArgv(box, [host, box])!;
	assert.equal(nested.at(-2), "h2");
	assert.match(nested.at(-1)!, /docker exec -i web/);

	// no ssh anywhere: no channel
	assert.equal(buildChannelArgv({ name: "d", kind: "docker", docker: { container: "web" } }), null);
	assert.equal(Channel.forTarget({ name: "d", kind: "docker", docker: { container: "web" } }), null);
	assert.equal(Channel.forTarget(t)?.state, "new");
});

test("composeChannelScript refuses NUL and bad env names", () => {
	assert.throws(() => composeChannelScript("a\0b"), /NUL/);
	assert.throws(() => composeChannelScript("x", undefined, { "A-B": "1" }), /invalid environment/);
	assert.equal(composeChannelScript("x", "~/p"), `cd -- "$HOME"/'p' || exit 1\nx`);
});

/**
 * Workers' MCP servers are launched as `node <file>.ts` (subagents/index.ts does exactly that), which
 * is node's STRIP-ONLY type stripping: parameter properties, enums and namespaces are syntax errors
 * there. This module and everything it imports must stay inside that subset.
 */
test("channel.ts, argv.ts and exec.ts load under node's strip-only type stripping", () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const code = `
		const c = await import(${JSON.stringify(join(here, "channel.ts"))});
		await import(${JSON.stringify(join(here, "argv.ts"))});
		await import(${JSON.stringify(join(here, "exec.ts"))});
		const e = new c.ChannelError("lost", "boom", true);
		if (e.reason !== "lost" || e.sent !== true || e.exitCode !== null) throw new Error("ChannelError fields lost");
		if (typeof c.Channel !== "function") throw new Error("no Channel");
	`;
	// --input-type=module: plain node, no loader, no transform flag.
	const r = spawnSync(process.execPath, ["--input-type=module", "--eval", code], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
});
