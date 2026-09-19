import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { discoverClaudeModels, type ClaudeModelDiscoveryOptions } from "./models.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
class FakeChild extends EventEmitter {
	pid = 4242;
	stdout = new PassThrough();
	stderr = new PassThrough();
	writes: any[] = [];
	signals: string[] = [];
	eof = false;
	autoClose = true;
	stdin = new Writable({
		write: (chunk, _encoding, callback) => { this.writes.push(JSON.parse(String(chunk))); callback(); },
		final: (callback) => { this.eof = true; callback(); if (this.autoClose) queueMicrotask(() => this.close()); },
	});
	kill(signal: string) { this.signals.push(signal); return true; }
	close() { this.emit("close", 0, null); }
	response(payload: unknown, requestId = this.writes[0].request_id, subtype = "success") {
		return { type: "control_response", response: { request_id: requestId, subtype, response: payload, error: "PRIVATE" } };
	}
	out(event: unknown) { this.stdout.write(JSON.stringify(event) + "\n"); }
}
function fixture(options: ClaudeModelDiscoveryOptions = {}, signal?: AbortSignal) {
	const child = new FakeChild();
	let argv: string[] = []; let spawnOptions: SpawnOptions = {}; let command = "";
	const promise = discoverClaudeModels(signal, {
		timeoutMs: 1000, eofGraceMs: 10, termGraceMs: 10, ...options,
		spawnImpl: (cmd, args, opts) => { command = cmd; argv = args; spawnOptions = opts; return child as unknown as ChildProcess; },
		signalGroupImpl: (_pid, sig) => child.kill(sig),
	});
	// Tests may deliberately delay awaiting a rejection until after child closure.
	void promise.catch(() => {});
	return { child, promise, argv, spawnOptions, command };
}
const cliModels = [
	{ value: "future-alias[1m]", displayName: "Future · model", description: "From CLI", resolvedModel: "future-version", supportedEffortLevels: ["low", "new-effort"], account: "PRIVATE" },
	{ value: "small", displayName: "Small" },
];

test("direct isolated initialize-only launch returns live aliases/efforts, never private metadata", async () => {
	const old = process.env.CLAUDECODE; const oldEntry = process.env.CLAUDE_CODE_ENTRYPOINT;
	process.env.CLAUDECODE = "nested"; process.env.CLAUDE_CODE_ENTRYPOINT = "nested";
	let f: ReturnType<typeof fixture>;
	try { f = fixture(); }
	finally {
		if (old === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = old;
		if (oldEntry === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT; else process.env.CLAUDE_CODE_ENTRYPOINT = oldEntry;
	}
	assert.equal(f.command, "claude"); assert.equal(f.spawnOptions.shell, false);
	assert.equal(f.spawnOptions.detached, process.platform !== "win32");
	assert.equal(f.spawnOptions.env?.CLAUDECODE, undefined);
	assert.equal(f.spawnOptions.env?.CLAUDE_CODE_ENTRYPOINT, undefined);
	for (const flag of ["--tools", "--setting-sources"]) assert.equal(f.argv[f.argv.indexOf(flag) + 1], "");
	assert.ok(f.argv.includes("--strict-mcp-config"));
	assert.equal(f.child.writes.length, 1);
	assert.deepEqual(f.child.writes[0], { type: "control_request", request_id: f.child.writes[0].request_id, request: { subtype: "initialize" } });
	f.child.stderr.write("PRIVATE account credentials");
	f.child.out(f.child.response({ models: cliModels, account: { email: "PRIVATE" }, settings: "PRIVATE" }));
	assert.deepEqual(await f.promise, [
		{ id: "future-alias[1m]", name: "Future · model", description: "From CLI", resolvedModel: "future-version", efforts: ["low", "new-effort"] },
		{ id: "small", name: "Small" },
	]);
	assert.equal(f.child.eof, true); assert.equal(f.child.writes.length, 1);
	assert.deepEqual(f.child.signals, []);
});

test("correlates initialize and decodes split UTF-8, including final line without newline", async () => {
	const f = fixture();
	f.child.out({ type: "system", models: [{ value: "wrong", displayName: "Wrong" }] });
	f.child.out(f.child.response({ models: [] }, "stale"));
	assert.equal(f.child.eof, false);
	const bytes = Buffer.from(JSON.stringify(f.child.response({ models: cliModels })));
	for (const byte of bytes) f.child.stdout.write(Buffer.from([byte]));
	f.child.stdout.end();
	assert.equal((await f.promise)[0].name, "Future · model");
});

test("empty list is valid, duplicate aliases are removed without inventing efforts", async () => {
	const empty = fixture(); empty.child.out(empty.child.response({ models: [] }));
	assert.deepEqual(await empty.promise, []);
	const f = fixture(); f.child.out(f.child.response({ models: [cliModels[1], cliModels[1]] }));
	assert.deepEqual(await f.promise, [{ id: "small", name: "Small" }]);
});

for (const [name, payload] of [
	["missing models", { account: "PRIVATE" }],
	["invalid models", { models: "PRIVATE" }],
	["invalid item", { models: [{ value: "alias" }] }],
	["invalid effort", { models: [{ ...cliModels[0], supportedEffortLevels: [123] }] }],
] as const) test(`${name} rejects without leaking raw response`, async () => {
	const f = fixture(); f.child.out(f.child.response(payload));
	await assert.rejects(f.promise, (error: Error) => !error.message.includes("PRIVATE"));
	assert.equal(f.child.eof, true);
});

test("initialize errors and malformed JSON are sanitized", async () => {
	const f = fixture(); f.child.out(f.child.response({ account: "PRIVATE" }, undefined, "error"));
	await assert.rejects(f.promise, /^Error: Claude model discovery initialize failed$/);
	const malformed = fixture(); malformed.child.stdout.write("PRIVATE not json\n");
	await assert.rejects(malformed.promise, /^Error: Malformed Claude model discovery response$/);
});

for (const newline of ["", "\n"]) test(`bounded records (${newline ? "terminated" : "unterminated"})`, async () => {
	const f = fixture({ maxLineBytes: 32 });
	f.child.stdout.write("x".repeat(20)); f.child.stdout.write("x".repeat(20) + newline);
	await assert.rejects(f.promise, /record exceeds limit/);
});

test("total output is bounded even for many small unrelated records", async () => {
	const f = fixture({ maxOutputBytes: 32 });
	for (let i = 0; i < 20; i++) f.child.stdout.write("{}\n");
	await assert.rejects(f.promise, /output exceeds limit/);
});

test("success waits for close and escalates EOF then TERM then KILL", async () => {
	const f = fixture(); f.child.autoClose = false;
	let settled = false; void f.promise.then(() => { settled = true; });
	f.child.out(f.child.response({ models: [] }));
	assert.equal(f.child.eof, true); assert.deepEqual(f.child.signals, []);
	await sleep(300);
	assert.deepEqual(f.child.signals, ["SIGTERM", "SIGKILL"]); assert.equal(settled, false);
	assert.equal(f.child.stdout.destroyed, false, "no exit proof, so no forced pipe closure");
	f.child.close(); assert.deepEqual(await f.promise, []);
});

test("closure during TERM cancels KILL", async () => {
	const f = fixture(); f.child.autoClose = false;
	f.child.kill = (sig) => { f.child.signals.push(sig); f.child.close(); return true; };
	f.child.out(f.child.response({ models: [] }));
	await f.promise; await sleep(30);
	assert.deepEqual(f.child.signals, ["SIGTERM"]);
});

test("timeout bounds the caller while cleanup continues to confirmed closure", async () => {
	let closure!: Promise<void>;
	const f = fixture({ timeoutMs: 10, trackClosure: (closed) => { closure = closed; } }); f.child.autoClose = false;
	let closed = false; void closure.then(() => { closed = true; });
	await assert.rejects(f.promise, /timed out/);
	assert.equal(f.child.eof, true); assert.equal(closed, false);
	await sleep(50);
	assert.deepEqual(f.child.signals, ["SIGTERM", "SIGKILL"]); assert.equal(closed, false, "no exit proof yet");
	f.child.close(); await closure; assert.equal(closed, true);
});

test("a parsed result is returned at the deadline even if closure is stuck", async () => {
	let closure!: Promise<void>;
	const f = fixture({ timeoutMs: 40, trackClosure: (closed) => { closure = closed; } }); f.child.autoClose = false;
	f.child.out(f.child.response({ models: [{ value: "x", displayName: "X" }] }));
	assert.deepEqual(await f.promise, [{ id: "x", name: "X" }]);
	let closed = false; void closure.then(() => { closed = true; });
	await tick(); assert.equal(closed, false);
	f.child.close(); await closure;
});

test("abort before spawn does not spawn or expose abort reason", async () => {
	const controller = new AbortController(); controller.abort("PRIVATE");
	await assert.rejects(discoverClaudeModels(controller.signal, { spawnImpl: () => { assert.fail("must not spawn"); } }), { name: "AbortError", message: "Claude model discovery aborted" });
});

for (const afterResponse of [false, true]) test(`abort ${afterResponse ? "during cleanup" : "during initialization"} rejects immediately; closure stays tracked`, async () => {
	let closure!: Promise<void>;
	const controller = new AbortController(); const f = fixture({ trackClosure: (closed) => { closure = closed; } }, controller.signal); f.child.autoClose = false;
	if (afterResponse) f.child.out(f.child.response({ models: [] }));
	controller.abort("PRIVATE");
	await assert.rejects(f.promise, { name: "AbortError", message: "Claude model discovery aborted" });
	assert.equal(f.child.eof, true);
	let closed = false; void closure.then(() => { closed = true; });
	await tick(); assert.equal(closed, false, "caller released before closure");
	f.child.close(); await closure;
});

test("early close, EOF, spawn and pipe errors reject safely", async () => {
	const early = fixture(); early.child.close(); await assert.rejects(early.promise, /exited before/);
	const eof = fixture(); eof.child.stdout.end(); await assert.rejects(eof.promise, /output ended/);
	await assert.rejects(discoverClaudeModels(undefined, { spawnImpl: () => { throw new Error("PRIVATE"); } }), /^Error: Could not spawn Claude for model discovery$/);
	for (const target of ["child", "stdin", "stdout", "stderr"] as const) {
		const f = fixture();
		(target === "child" ? f.child : f.child[target]).emit("error", new Error("PRIVATE"));
		await assert.rejects(f.promise, (e: Error) => !e.message.includes("PRIVATE"));
		assert.equal(f.child.eof, true);
	}
});

test("real child ignoring EOF and TERM is killed and reaped before returning", async () => {
	let child: ChildProcess | undefined;
	let closed = false;
	const models = await discoverClaudeModels(undefined, {
		eofGraceMs: 20, termGraceMs: 20,
		spawnImpl: (_command, _args, options) => {
			child = spawn(process.execPath, ["-e", `
				process.on('SIGTERM', () => {});
				setInterval(() => {}, 1000);
				process.stdin.once('data', chunk => {
					const request = JSON.parse(String(chunk));
					console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:request.request_id,response:{models:[]}}}));
				});
			`], options);
			child.on("close", () => { closed = true; });
			return child;
		},
	});
	assert.deepEqual(models, []); assert.equal(closed, true);
	assert.equal(child?.signalCode, "SIGKILL");
	assert.throws(() => process.kill(child!.pid!, 0), { code: "ESRCH" });
});

for (const reply of [true, false]) test(`discovery releases detached inherited output after proven exit (reply=${reply})`, { skip: process.platform === "win32", timeout: 5000 }, async (t) => {
	let child: ChildProcess | undefined; let descendant: number | undefined;
	let exited = false; let closed = false;
	const signals: string[] = [];
	const promise = discoverClaudeModels(undefined, {
		timeoutMs: 1000, eofGraceMs: 20, termGraceMs: 20, pipeDrainMs: 30,
		spawnImpl: (_command, _args, options) => {
			child = spawn(process.execPath, ["-e", `
				const {spawn}=require('node:child_process');
				const gc=spawn(process.execPath,['-e',"process.send('ready');setInterval(()=>{},1000);setTimeout(()=>process.exit(0),10000)"],{detached:true,stdio:['ignore','inherit','inherit','ipc']});
				const ready=new Promise(r=>gc.once('message',()=>{process.send(gc.pid);gc.disconnect();gc.unref();r();}));
				process.stdin.once('data',async chunk=>{await ready;const e=JSON.parse(String(chunk));
					if(${reply})console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:e.request_id,response:{models:[]}}}));
					else process.exit(4);
				});
				process.stdin.on('end',()=>process.exit(0));
			`], { ...options, stdio: ["pipe", "pipe", "pipe", "ipc"] });
			child.on("message", (pid) => { descendant = Number(pid); });
			child.on("exit", () => { exited = true; }); child.on("close", () => { closed = true; });
			return child;
		},
		signalGroupImpl: (pid, sig) => { signals.push(sig); process.kill(-pid, sig); },
	});
	void promise.catch(() => {});
	t.after(async () => {
		if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch {} }
		if (child && !exited) child.kill("SIGKILL");
		await promise.catch(() => {});
	});
	if (reply) assert.deepEqual(await promise, []);
	else await assert.rejects(promise, /exited before/);
	assert.equal(exited, true); assert.equal(closed, true);
	assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
	assert.equal(child!.stdout!.destroyed, true); assert.equal(child!.stderr!.destroyed, true);
	assert.equal(process.kill(descendant!, 0), true, "discovery does not claim detached service containment");
});

test("real missing executable rejects after spawn failure closure", async () => {
	await assert.rejects(discoverClaudeModels(undefined, { executable: "/nonexistent/claude-discovery-test" }), /process failed/);
});

test("invalid resource limits fail before spawn", async () => {
	await assert.rejects(discoverClaudeModels(undefined, { maxLineBytes: -1, spawnImpl: () => { assert.fail("must not spawn"); } }), /positive integers/);
});
