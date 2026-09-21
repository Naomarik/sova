/**
 * The `remote` MCP server, driven the way Claude Code drives it. The transport is faked with an
 * `exec` that runs the far script under the LOCAL shell (as index.test.ts does), so the real far
 * scripts are exercised without a network; the spawned cases prove the launch itself.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import {
	BASH_MAX_TIMEOUT_SEC,
	MAX_LINE_CHARS,
	MAX_OUTPUT_BYTES,
	connectRemote,
	createRemoteMcpServer,
	remoteMcpTools,
	resolveFarPath,
	serveRemoteMcp,
	type RemoteTransport,
	type TransportResult,
} from "./mcp-server.ts";
import { REMOTE_MCP_ENV, encodeRemoteMcpIdentity, type RemoteMcpIdentity } from "./workers.ts";

const SELF = fileURLToPath(import.meta.url);
const SERVER = join(SELF, "..", "mcp-server.ts");

function scratch(t: any): string {
	const dir = mkdtempSync(join(tmpdir(), "remote-mcp-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** A far side that is this machine: the script runs under `sh -c`, rooted at the identity's cwd. */
function localTransport(farCwd: string, home = "/far/home") {
	const calls: { command: string; cwd?: string; input?: string; idempotent?: boolean }[] = [];
	const sh = (command: string, cwd: string | undefined, input: Buffer | string | undefined, merge: boolean): Promise<TransportResult> =>
		new Promise((resolve) => {
			const child = execFile("/bin/sh", ["-c", command], { cwd: cwd ?? farCwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
				const code = error && typeof (error as any).code === "number" ? (error as any).code : error ? 1 : 0;
				resolve({
					exitCode: code,
					stdout: merge ? Buffer.concat([stdout, stderr]) : stdout,
					stderr: merge ? "" : stderr.toString("utf8"),
					timedOut: false, aborted: false,
				});
			});
			if (input !== undefined) child.stdin!.end(input);
			else child.stdin!.end();
		});
	const transport: RemoteTransport & { calls: typeof calls; disposed: number } = {
		label: "agentbox",
		calls,
		disposed: 0,
		async home() { return home; },
		async run(command, options) {
			calls.push({ command, cwd: options.cwd, input: options.input === undefined ? undefined : String(options.input), idempotent: options.idempotent });
			return sh(command, options.cwd, options.input, false);
		},
		async bash(command, cwd, options) {
			calls.push({ command, cwd });
			const result = await sh(command, cwd, undefined, true);
			options.onData?.(result.stdout);
			return { ...result, stdout: Buffer.alloc(0) };
		},
		dispose() { transport.disposed++; },
	};
	return transport;
}

const identity = (farCwd: string): RemoteMcpIdentity => ({ version: 1, target: "agentbox-1", farCwd, label: "agentbox" });

/** One tools/call, returning the text and the error flag the model sees. */
async function callTool(server: ReturnType<typeof createRemoteMcpServer>, name: string, args: Record<string, unknown> = {}, id = 7) {
	const response = await server.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
	const result = (response as any).result;
	return { text: result.content[0].text as string, isError: result.isError === true };
}

test("handshake, tool list and unknown methods follow the MCP shape Claude expects", async (t) => {
	const dir = scratch(t);
	const server = createRemoteMcpServer(identity(dir), { connection: localTransport(dir) });

	const init = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
	const result = (init as any).result;
	assert.equal(result.protocolVersion, "2025-11-25", "a version we know is echoed");
	assert.deepEqual(result.capabilities, { tools: {} });
	assert.match(result.instructions, /All file and shell operations happen on the remote target/);
	assert.match(result.instructions, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the far cwd is named in the instructions");

	const unknown = await server.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
	assert.equal((unknown as any).result.protocolVersion, "2025-06-18", "an unknown version falls back, never echoes");

	assert.deepEqual(await server.handle({ jsonrpc: "2.0", id: 3, method: "ping" }), { jsonrpc: "2.0", id: 3, result: {} });

	const list = (await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/list" })) as any;
	assert.deepEqual(list.result.tools.map((tool: any) => tool.name),
		["remote_bash", "remote_read", "remote_write", "remote_edit", "remote_ls", "remote_find", "remote_grep"]);
	for (const tool of list.result.tools) {
		assert.match(tool.description, /remote target agentbox \(agentbox-1\)/, `${tool.name} says where it runs`);
		assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} rejects stray arguments`);
	}
	assert.match(list.result.tools[0].description, /NO local shell/);

	const bad = (await server.handle({ jsonrpc: "2.0", id: 5, method: "nope" })) as any;
	assert.equal(bad.error.code, -32601);
	assert.equal((await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })), undefined, "notifications get no response");
	assert.equal(((await server.handleLine("{oops")) as any).error.code, -32700);
	assert.equal(await server.handleLine("  "), undefined);
	assert.equal(((await server.handleLine(JSON.stringify({ jsonrpc: "1.0", id: 9, method: "ping" }))) as any).error.code, -32600);
});

test("tools/list needs no connection: the handshake must not touch the network", async (t) => {
	const dir = scratch(t);
	let connects = 0;
	const server = createRemoteMcpServer(identity(dir), { connect: () => { connects++; return localTransport(dir); } });
	await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
	await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
	assert.equal(connects, 0, "the channel is pinned lazily, on the first call");
	await callTool(server, "remote_ls");
	assert.equal(connects, 1);
	await callTool(server, "remote_ls");
	assert.equal(connects, 1, "and reused afterwards");
});

test("remote_read numbers lines, slices, and reports the far guards as prose", async (t) => {
	const dir = scratch(t);
	writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
	mkdirSync(join(dir, "sub"));
	const server = createRemoteMcpServer(identity(dir), { connection: localTransport(dir) });

	const all = await callTool(server, "remote_read", { path: "a.txt" });
	assert.equal(all.text, "    1\tone\n    2\ttwo\n    3\tthree");
	assert.equal(all.isError, false);

	const slice = await callTool(server, "remote_read", { path: "a.txt", offset: 2, limit: 1 });
	assert.equal(slice.text, "    2\ttwo", "numbering continues from the offset so line numbers can be quoted back");

	const missing = await callTool(server, "remote_read", { path: "nope.txt" });
	assert.ok(missing.isError);
	assert.match(missing.text, /no such file on the target: .*nope\.txt/);

	const directory = await callTool(server, "remote_read", { path: "sub" });
	assert.ok(directory.isError);
	assert.match(directory.text, /is a directory on the target/);

	writeFileSync(join(dir, "bin"), Buffer.from([0x41, 0x00, 0x42]));
	const binary = await callTool(server, "remote_read", { path: "bin" });
	assert.ok(binary.isError);
	assert.match(binary.text, /looks like a binary file/, "replacement characters would only mislead the model");

	writeFileSync(join(dir, "empty.txt"), "");
	assert.match((await callTool(server, "remote_read", { path: "empty.txt" })).text, /is empty/);

	const absolute = await callTool(server, "remote_read", { path: join(dir, "a.txt") });
	assert.match(absolute.text, /one/, "absolute far paths are taken as given");
});

test("remote_write creates parents, and remote_edit replaces exact text with pi's rules", async (t) => {
	const dir = scratch(t);
	const server = createRemoteMcpServer(identity(dir), { connection: localTransport(dir) });

	const written = await callTool(server, "remote_write", { path: "deep/dir/file.txt", content: "hello\nworld\n" });
	assert.equal(written.isError, false);
	assert.match(written.text, /Wrote .*deep\/dir\/file\.txt on agentbox \(12 bytes\)/);
	assert.equal(readFileSync(join(dir, "deep/dir/file.txt"), "utf8"), "hello\nworld\n");

	const edited = await callTool(server, "remote_edit", { path: "deep/dir/file.txt", oldText: "world", newText: "there" });
	assert.equal(edited.isError, false);
	assert.match(edited.text, /1 replacement\b/);
	assert.equal(readFileSync(join(dir, "deep/dir/file.txt"), "utf8"), "hello\nthere\n");

	const absent = await callTool(server, "remote_edit", { path: "deep/dir/file.txt", oldText: "nothing", newText: "x" });
	assert.ok(absent.isError);
	assert.match(absent.text, /oldText not found/);

	writeFileSync(join(dir, "twice.txt"), "a\na\n");
	const ambiguous = await callTool(server, "remote_edit", { path: "twice.txt", oldText: "a", newText: "b" });
	assert.ok(ambiguous.isError);
	assert.match(ambiguous.text, /appears 2 times/);
	assert.equal(readFileSync(join(dir, "twice.txt"), "utf8"), "a\na\n", "an ambiguous edit changes nothing");

	const all = await callTool(server, "remote_edit", { path: "twice.txt", oldText: "a", newText: "b", replaceAll: true });
	assert.match(all.text, /2 replacements/);
	assert.equal(readFileSync(join(dir, "twice.txt"), "utf8"), "b\nb\n");

	const missing = await callTool(server, "remote_edit", { path: "gone.txt", oldText: "a", newText: "b" });
	assert.ok(missing.isError);
	assert.match(missing.text, /no such file on the target/);

	// Content travels on stdin, so nothing in it is ever shell-interpreted.
	const nasty = "`touch pwned`$(touch pwned2)\n'\"\\\n";
	await callTool(server, "remote_write", { path: "nasty.txt", content: nasty });
	assert.equal(readFileSync(join(dir, "nasty.txt"), "utf8"), nasty);
	assert.equal(readFileSync(join(dir, "nasty.txt"), "utf8").includes("pwned"), true);
	assert.throws(() => readFileSync(join(dir, "pwned")), /ENOENT/, "the content was never executed");
});

test("paths with shell metacharacters stay data", async (t) => {
	const dir = scratch(t);
	const evil = "it's $(touch pwned)`touch pwned2`.txt";
	const server = createRemoteMcpServer(identity(dir), { connection: localTransport(dir) });
	await callTool(server, "remote_write", { path: evil, content: "safe\n" });
	assert.equal(readFileSync(join(dir, evil), "utf8"), "safe\n");
	assert.throws(() => readFileSync(join(dir, "pwned")), /ENOENT/);
	assert.throws(() => readFileSync(join(dir, "pwned2")), /ENOENT/);
	assert.match((await callTool(server, "remote_read", { path: evil })).text, /safe/);
});

test("remote_ls, remote_find and remote_grep list, cap and report emptiness without erroring", async (t) => {
	const dir = scratch(t);
	mkdirSync(join(dir, "src"));
	mkdirSync(join(dir, "node_modules"));
	writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\nconst needle = 2;\n");
	writeFileSync(join(dir, "src/b.txt"), "no match here\n");
	writeFileSync(join(dir, "node_modules/c.ts"), "const needle = 3;\n");
	const server = createRemoteMcpServer(identity(dir), { connection: localTransport(dir) });

	const ls = await callTool(server, "remote_ls");
	assert.equal(ls.isError, false);
	assert.deepEqual(ls.text.split("\n").sort(), ["node_modules/", "src/"]);

	const capped = await callTool(server, "remote_ls", { path: "src", limit: 1 });
	assert.match(capped.text, /\[1 entry limit reached\]/);

	const find = await callTool(server, "remote_find", { pattern: "**/*.ts" });
	assert.equal(find.text, "src/a.ts", "node_modules is pruned");

	const grep = await callTool(server, "remote_grep", { pattern: "needle" });
	assert.equal(grep.isError, false);
	assert.match(grep.text, /a\.ts/);
	assert.ok(!grep.text.includes("node_modules"), "node_modules is excluded from search too");

	const none = await callTool(server, "remote_grep", { pattern: "zzz-not-there" });
	assert.equal(none.isError, false, "no matches is not an error: grep exits 1 on purpose");
	assert.match(none.text, /No match for zzz-not-there/);

	assert.match((await callTool(server, "remote_ls", { path: "missing" })).text, /no such file on the target/);
	assert.match((await callTool(server, "remote_find", { pattern: "*", path: "missing" })).text, /no such file on the target/);
});

test("remote_bash merges the streams, keeps the tail, and reports exit codes as errors", async (t) => {
	const dir = scratch(t);
	const transport = localTransport(dir);
	const server = createRemoteMcpServer(identity(dir), { connection: transport });

	const hello = await callTool(server, "remote_bash", { command: "echo out; echo err >&2" });
	assert.equal(hello.isError, false);
	assert.deepEqual(hello.text.split("\n").sort(), ["err", "out"], "stderr is merged, as a terminal shows it");

	const failing = await callTool(server, "remote_bash", { command: "echo nope >&2; exit 3" });
	assert.ok(failing.isError, "a non-zero exit must reach the model as an error");
	assert.match(failing.text, /\[exit code 3\]/);

	const quiet = await callTool(server, "remote_bash", { command: "true" });
	assert.match(quiet.text, /\[no output, exit code 0\]/);

	const big = await callTool(server, "remote_bash", { command: `seq 1 200000` });
	assert.match(big.text, /output truncated to 64 KB \(start dropped\)/);
	assert.ok(Buffer.byteLength(big.text) <= MAX_OUTPUT_BYTES + 200);
	assert.match(big.text, /199999\n200000\n\n\[/, "a build says why on its last lines, so the tail is kept");
	assert.ok(!big.text.startsWith("1\n2\n"), "and the start is what gets dropped");

	const long = await callTool(server, "remote_bash", { command: `printf 'x%.0s' $(seq 1 5000); echo` });
	assert.match(long.text, /line truncated, 5000 chars/);
	assert.ok(long.text.split("\n")[0]!.length < MAX_LINE_CHARS + 60);

	// cwd is a far path resolved against the session's far cwd.
	mkdirSync(join(dir, "sub"));
	assert.match((await callTool(server, "remote_bash", { command: "pwd" }, 8)).text, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match((await callTool(server, "remote_bash", { command: "pwd", cwd: "sub" }, 9)).text, /\/sub$/);
});

test("bad arguments are tool errors the model can fix, not protocol errors", async (t) => {
	const dir = scratch(t);
	const server = createRemoteMcpServer(identity(dir), { connection: localTransport(dir) });
	for (const [args, expected] of [
		[{}, /command must be a non-blank string/],
		[{ command: "" }, /command must be a non-blank string/],
		[{ command: "true", timeout: 0 }, /timeout must be an integer from 1 to 600/],
		[{ command: "true", timeout: BASH_MAX_TIMEOUT_SEC + 1 }, /timeout must be an integer from 1 to 600/],
		[{ command: "true", timeout: 1.5 }, /timeout must be an integer/],
	] as [Record<string, unknown>, RegExp][]) {
		const result = await callTool(server, "remote_bash", args);
		assert.ok(result.isError, JSON.stringify(args));
		assert.match(result.text, expected);
	}
	const unknown = await callTool(server, "nope_tool");
	assert.ok(unknown.isError);
	assert.match(unknown.text, /Unknown tool: nope_tool/);
	const noName = (await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} })) as any;
	assert.equal(noName.error.code, -32602);
});

test("an unreachable target fails closed, names itself, and never falls back to this machine", async (t) => {
	const dir = scratch(t);
	let attempts = 0;
	const server = createRemoteMcpServer(identity(dir), {
		connect: () => { attempts++; throw new Error("ssh: connect to host example.invalid port 22: Network is unreachable"); },
	});
	const result = await callTool(server, "remote_read", { path: "/etc/hostname" });
	assert.ok(result.isError);
	assert.match(result.text, /Could not reach agentbox/);
	assert.match(result.text, /Network is unreachable/, "ssh's own words reach the model: this process's stderr does not");
	const again = await callTool(server, "remote_ls");
	assert.ok(again.isError);
	assert.equal(attempts, 2, "a failed open is not cached; the next call tries again");
});

test("notifications/cancelled aborts that request id and nothing else", async (t) => {
	const dir = scratch(t);
	let aborted = false;
	const transport: RemoteTransport = {
		label: "agentbox",
		async home() { return "/far/home"; },
		async run(_command, options) {
			return new Promise((resolve) => {
				options.signal?.addEventListener("abort", () => { aborted = true; resolve({ exitCode: null, stdout: Buffer.alloc(0), stderr: "", timedOut: false, aborted: true }); }, { once: true });
			});
		},
		async bash() { throw new Error("not used"); },
		dispose() {},
	};
	const server = createRemoteMcpServer(identity(dir), { connection: transport });
	const pending = callTool(server, "remote_ls", {}, 42);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(server.pending(), 1);

	await server.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 41 } });
	assert.equal(aborted, false, "a different request id is left alone");
	await server.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 42 } });
	const result = await pending;
	assert.equal(aborted, true);
	assert.ok(result.isError);
	assert.equal(server.pending(), 0);
});

test("a cancelled remote_bash carries the abort through to the far process", async (t) => {
	const dir = scratch(t);
	// The far side is killed by the signal reaching the run, not by us abandoning the promise:
	// without it an interrupted build keeps burning the target. exec.ts resolves on abort rather
	// than throwing, so the tool must still produce a result the model can read.
	let seen: AbortSignal | undefined;
	let killed = false;
	const transport: RemoteTransport = {
		label: "agentbox",
		async home() { return "/far/home"; },
		async run() { throw new Error("not used"); },
		async bash(_command, _cwd, options) {
			seen = options.signal;
			return new Promise((resolve) => {
				options.signal?.addEventListener("abort", () => {
					killed = true;
					options.onData?.(Buffer.from("partial output\n"));
					resolve({ exitCode: null, stdout: Buffer.alloc(0), stderr: "", timedOut: false, aborted: true });
				}, { once: true });
			});
		},
		dispose() {},
	};
	const server = createRemoteMcpServer(identity(dir), { connection: transport });
	const pending = callTool(server, "remote_bash", { command: "sleep 100" }, 11);
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(seen, "the tool's signal is handed to the far run");
	assert.equal(seen!.aborted, false);

	// Claude sends this both on a user interrupt and when MCP_TOOL_TIMEOUT fires.
	await server.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 11 } });
	const result = await pending;
	assert.equal(killed, true, "the far process is signalled, not merely abandoned");
	assert.equal(seen!.aborted, true);
	assert.ok(result.isError);
	assert.match(result.text, /cancelled/);
	assert.match(result.text, /partial output/, "whatever the command managed to print is still returned");
	assert.equal(server.pending(), 0);
});

test("far calls are serialized: the channel serves one command at a time", async (t) => {
	const dir = scratch(t);
	let concurrent = 0;
	let peak = 0;
	const transport: RemoteTransport = {
		label: "agentbox",
		async home() { return "/far/home"; },
		async run() {
			peak = Math.max(peak, ++concurrent);
			await new Promise((resolve) => setTimeout(resolve, 5));
			concurrent--;
			return { exitCode: 0, stdout: Buffer.from("x\n"), stderr: "", timedOut: false, aborted: false };
		},
		async bash() { throw new Error("not used"); },
		dispose() {},
	};
	const server = createRemoteMcpServer(identity(dir), { connection: transport });
	await Promise.all([1, 2, 3, 4].map((id) => callTool(server, "remote_ls", {}, id)));
	assert.equal(peak, 1, "a second concurrent call would be rejected by the channel as busy");
});

test("~ resolves against the target's home, and relative paths against the session's far cwd", () => {
	assert.equal(resolveFarPath("~", "/work/repo", "/home/ec2-user"), "/home/ec2-user");
	assert.equal(resolveFarPath("~/x/y", "/work/repo", "/home/ec2-user"), "/home/ec2-user/x/y");
	assert.equal(resolveFarPath("/abs", "/work/repo", "/home/ec2-user"), "/abs");
	assert.equal(resolveFarPath("rel", "/work/repo", "/home/ec2-user"), "/work/repo/rel");
	assert.equal(resolveFarPath(undefined, "/work/repo", undefined), "/work/repo");
	assert.equal(resolveFarPath(".", "/work/repo", undefined), "/work/repo");
	assert.equal(resolveFarPath("rel", "/work/repo/", undefined), "/work/repo/rel", "a trailing slash on the far cwd does not double up");
});

test("the tool surface names the target and its far cwd everywhere a model might look", () => {
	const tools = remoteMcpTools({ target: "t", farCwd: "/far/cwd", label: "Prod box" });
	assert.equal(tools.length, 7);
	for (const tool of tools) {
		assert.match(tool.description, /Prod box \(t\)/);
		assert.match(tool.description, /\/far\/cwd/);
	}
	const unlabelled = remoteMcpTools({ target: "t", farCwd: "/far/cwd" });
	assert.match(unlabelled[0]!.description, /remote target t\./);
});

test("serveRemoteMcp answers over the streams and ends, disposing the connection, at EOF", async (t) => {
	const dir = scratch(t);
	const transport = localTransport(dir);
	const input = new PassThrough();
	const output = new PassThrough();
	const lines: string[] = [];
	output.on("data", (chunk) => lines.push(...String(chunk).split("\n").filter(Boolean)));
	const done = serveRemoteMcp(identity(dir), input, output, { connection: transport });

	input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })}\n`);
	input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	// A request split across two chunks must still be answered exactly once.
	const call = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "remote_bash", arguments: { command: "echo hi" } } });
	input.write(call.slice(0, 20));
	await new Promise((resolve) => setTimeout(resolve, 5));
	input.write(`${call.slice(20)}\n`);
	await new Promise((resolve) => setTimeout(resolve, 50));
	input.end();
	await done;

	assert.equal(transport.disposed, 1, "the channel is torn down with the server");
	const responses = lines.map((line) => JSON.parse(line));
	assert.equal(responses.length, 2, "the notification got no response");
	assert.equal(responses[0].id, 1);
	assert.equal(responses[1].result.content[0].text, "hi");
});

test("teardown kills the channel once, aborts what is in flight, and survives a second call", async (t) => {
	const dir = scratch(t);
	// The entry point disposes on SIGINT *and* on stdin EOF, and Claude routinely delivers both:
	// a second teardown must not throw or kill a channel twice.
	let disposals = 0;
	let aborted = false;
	const transport: RemoteTransport = {
		label: "agentbox",
		async home() { return "/far/home"; },
		async run(_command, options) {
			return new Promise((resolve) => {
				options.signal?.addEventListener("abort", () => { aborted = true; resolve({ exitCode: null, stdout: Buffer.alloc(0), stderr: "", timedOut: false, aborted: true }); }, { once: true });
			});
		},
		async bash() { throw new Error("not used"); },
		dispose() { disposals++; },
	};
	const server = createRemoteMcpServer(identity(dir), { connection: transport });
	const pending = callTool(server, "remote_ls", {}, 3);
	await new Promise((resolve) => setImmediate(resolve));

	server.dispose();
	assert.equal(disposals, 1, "the ssh child is killed now, not when the pipe eventually closes");
	assert.equal(aborted, true, "an in-flight far command is aborted, not left running on the target");
	assert.ok((await pending).isError);
	assert.equal(server.pending(), 0);

	assert.doesNotThrow(() => server.dispose());
	assert.doesNotThrow(() => server.dispose());
	assert.equal(disposals, 1, "teardown is idempotent");
});

test("serveRemoteMcp hands back the server so a signal handler can tear it down", async (t) => {
	const dir = scratch(t);
	const transport = localTransport(dir);
	const input = new PassThrough();
	const output = new PassThrough();
	let captured: any;
	const done = serveRemoteMcp(identity(dir), input, output, { connection: transport, onServer: (server) => { captured = server; } });
	assert.ok(captured, "the handle is available before any input arrives: a signal can land immediately");

	// What the SIGINT handler does, before the stream ever ends.
	captured.dispose();
	assert.equal(transport.disposed, 1);
	input.end();
	await done;
	assert.equal(transport.disposed, 1, "the EOF path does not dispose a second time");
});

test("connectRemote drives a real Connection end to end", { skip: process.platform === "win32" }, async (t) => {
	// A target with no ssh hop and no docker block composes to a plain local `sh -c` (argv.ts
	// environmentArgv), so the whole real stack — Connection preflight, dispatch, exec.ts — runs
	// here with no network. This is the one path the fake transport cannot cover.
	const dir = scratch(t);
	const agentDir = scratch(t);
	writeFileSync(join(agentDir, "targets.json"), JSON.stringify({ version: 1, targets: [{ name: "local", kind: "ssh", ssh: { host: "example.invalid" }, cwd: dir }] }));
	writeFileSync(join(dir, "hello.txt"), "line one\nline two\n");

	// index.test.ts's seam: take the argv the real Connection composed for the ssh target and run
	// its far command (argv's last word, what the far login shell would parse) under a local sh.
	const { runArgv } = await import("./exec.ts");
	const id: RemoteMcpIdentity = { version: 1, target: "local", farCwd: dir, agentDir, label: "loopback" };
	const transport = await connectRemote(id, {
		exec: (argv, options) => runArgv(["sh", "-c", argv[argv.length - 1]!], options),
		channel: false,
	});
	t.after(() => transport.dispose());
	const server = createRemoteMcpServer(id, { connection: transport });

	assert.equal(transport.label, "loopback");
	assert.match((await callTool(server, "remote_bash", { command: "pwd" }, 1)).text, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.equal((await callTool(server, "remote_read", { path: "hello.txt" }, 2)).text, "    1\tline one\n    2\tline two");
	assert.equal((await callTool(server, "remote_write", { path: "made.txt", content: "made\n" }, 3)).isError, false);
	assert.equal(readFileSync(join(dir, "made.txt"), "utf8"), "made\n");
	assert.equal((await callTool(server, "remote_ls", {}, 4)).text.split("\n").sort().join(","), "hello.txt,made.txt");

	// `~` needs the far probe, which the real Connection answers from its preflight.
	assert.match((await callTool(server, "remote_bash", { command: "echo ok" }, 5)).text, /ok/);
	const failing = await callTool(server, "remote_bash", { command: "exit 7" }, 6);
	assert.ok(failing.isError);
	assert.match(failing.text, /exit code 7/);

	// A non-zero far exit is the tool's result, not a thrown "could not reach".
	const missing = await callTool(server, "remote_read", { path: "nope.txt" }, 7);
	assert.ok(missing.isError);
	assert.match(missing.text, /no such file on the target/);
	assert.ok(!/Could not reach/.test(missing.text), "allowFail keeps far exit codes out of the transport error path");
});

test("the server launches under plain node type-stripping, and refuses to serve without an identity", { skip: process.platform === "win32" }, async (t) => {
	// The launcher is `node mcp-server.ts` with no flags (like member-mcp.ts), so any TypeScript
	// the stripper cannot handle — a constructor parameter property, an enum — must fail here
	// rather than in a worker.
	const loaded = spawnSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(SERVER)}).then(m => { if (typeof m.createRemoteMcpServer !== "function") process.exit(9); })`], { encoding: "utf8" });
	assert.equal(loaded.status, 0, `strip-only import failed: ${loaded.stderr}`);

	for (const env of [undefined, "", "not json", JSON.stringify({ version: 2, target: "t", farCwd: "/x" }), JSON.stringify({ version: 1, target: "t" })]) {
		const run = spawnSync(process.execPath, [SERVER], {
			encoding: "utf8", input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
			env: { ...process.env, [REMOTE_MCP_ENV]: env as string },
		});
		assert.equal(run.status, 1, `expected a refusal for ${String(env)}`);
		assert.equal(run.stdout, "", "nothing is served without a valid identity");
		assert.match(run.stderr, new RegExp(REMOTE_MCP_ENV));
	}

	// With an identity it serves the handshake and lists its tools without touching the network;
	// only a tool call needs the target, and an unreachable one fails closed naming it.
	const dir = scratch(t);
	writeFileSync(join(dir, "targets.json"), JSON.stringify({ version: 1, targets: [{ name: "t", kind: "ssh", ssh: { host: "example.invalid" } }] }));
	const id: RemoteMcpIdentity = { version: 1, target: "t", farCwd: "/work", agentDir: dir, label: "unreachable" };
	const requests = [
		{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
		{ jsonrpc: "2.0", id: 2, method: "tools/list" },
	].map((request) => `${JSON.stringify(request)}\n`).join("");
	const served = spawnSync(process.execPath, [SERVER], {
		encoding: "utf8", input: requests, env: { ...process.env, [REMOTE_MCP_ENV]: encodeRemoteMcpIdentity(id) },
	});
	assert.equal(served.status, 0, served.stderr);
	const responses = served.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
	assert.equal(responses.length, 2);
	assert.match(responses[0].result.instructions, /remote target "unreachable \(t\)" in \/work/);
	assert.deepEqual(responses[1].result.tools.map((tool: any) => tool.name)[0], "remote_bash");
	assert.ok(served.stdout.split("\n").filter(Boolean).every((line) => line.startsWith("{")), "every stdout byte is JSON-RPC; ssh noise never lands here");
});
