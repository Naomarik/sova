/**
 * Detachable workers (PI_WORKER_TRANSPORT=host): transport switch, replay and
 * offset semantics, the real host.ts with a fake worker, registry lifecycle,
 * the detach flag, re-adoption through a FAKE host on a real unix socket, and
 * dead-host finalization. No model requests; every registry root is a temp dir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { registerSubagents } from "./index.ts";
import { DETACH_WORKERS, LEGACY_DETACH_WORKERS, TRANSPORT_ENV, WorkerHosting, detachRequested, hostingRequested, sentLines, workerTransport } from "./hosting.ts";
import { LEGACY_WORKERS_ROOT, NEW_WORKERS_ROOT, defaultWorkersRoot } from "./workers-dir.ts";
import { HostTransport, attachTransport, hostedSpawnImpl, pingHost } from "./host-transport.ts";
import { WORKER_MANIFEST_ENTRY_TYPE } from "./registry.ts";
import { deadDir, files, listOwner, pidAlive, procStartTime, reap, readJson, socketPath, workerDir, writeMeta, type WorkerMeta } from "./workers-dir.ts";

const skip = process.platform === "win32";
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 5000, what = "condition"): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await pause(10);
	}
}
function tempRoot(t: { after(fn: () => void): void }): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hosting-test-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return root;
}
/** A short private socket path (sun_path is ~108 bytes). */
function sockIn(t: { after(fn: () => void): void }, name = "h"): string {
	const dir = fs.mkdtempSync(path.join("/tmp", "pih-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return path.join(dir, `${name}.sock`);
}
/** Byte offset after each line of a newline-joined log. */
const ends = (lines: string[]) => { let o = 0; return lines.map((l) => (o += Buffer.byteLength(l) + 1)); };
/** A process id that certainly exited. */
async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	await new Promise((r) => child.once("exit", r));
	return child.pid!;
}

/**
 * Fake worker host speaking host.ts's socket protocol over a real unix socket.
 * `lines` is out.jsonl; `extra` lines are appended (live) after the replay.
 */
function fakeHost(sock: string, lines: string[]) {
	const received: any[] = [];
	const sockets = new Set<net.Socket>();
	let client: net.Socket | undefined;
	const offsets = ends(lines);
	const send = (s: net.Socket | undefined, frame: object) => s && !s.destroyed && s.write(`${JSON.stringify(frame)}\n`);
	const server = net.createServer((socket) => {
		sockets.add(socket);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("error", () => {});
		socket.on("data", (text: string) => {
			buffer += text;
			let i: number;
			while ((i = buffer.indexOf("\n")) !== -1) {
				const frame = JSON.parse(buffer.slice(0, i));
				buffer = buffer.slice(i + 1);
				received.push(frame);
				if (frame.type === "ping") send(socket, { t: "pong", hostPid: process.pid, workerPid: 999_999, exited: false });
				if (frame.type === "attach") {
					client = socket;
					send(socket, { t: "hello", hostPid: process.pid, hostStartTime: procStartTime(process.pid), workerPid: 999_999 });
					lines.forEach((l, n) => { if (offsets[n] > frame.offset) send(socket, { t: "o", o: offsets[n], l }); });
					send(socket, { t: "live" });
				}
				if (frame.type === "signal") send(socket, { t: "x", code: null, signal: frame.sig });
			}
		});
	});
	return {
		received,
		listen: () => new Promise<void>((r) => server.listen(sock, () => r())),
		/** A new live stdout line. */
		emit(line: string) {
			lines.push(line);
			offsets.push((offsets.at(-1) ?? 0) + Buffer.byteLength(line) + 1);
			send(client, { t: "o", o: offsets.at(-1), l: line });
		},
		exit(code: number | null, signal: string | null = null) { send(client, { t: "x", code, signal }); },
		close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
	};
}

// ── switch ───────────────────────────────────────────────────────────────────

test("rename bridge: workers registry root prefers sova/, falls back to legacy pi-web/, fresh installs get sova/", () => {
	const only = (paths: string[]) => ({ existsSync: (p: fs.PathLike) => paths.includes(String(p)) });
	assert.equal(defaultWorkersRoot(only([])), NEW_WORKERS_ROOT, "fresh state: new root is where a registry would be made");
	assert.equal(defaultWorkersRoot(only([LEGACY_WORKERS_ROOT])), LEGACY_WORKERS_ROOT, "pre-move: the old registry is the one that exists");
	assert.equal(defaultWorkersRoot(only([NEW_WORKERS_ROOT, LEGACY_WORKERS_ROOT])), NEW_WORKERS_ROOT, "post-move: the moved registry wins");
});

test("transport switch: unset/inline/unknown are inline, only 'host' hosts; the detach global never enables hosting", (t) => {
	assert.equal(TRANSPORT_ENV, "PI_WORKER_TRANSPORT");
	assert.equal(workerTransport({}), "inline");
	assert.equal(workerTransport({ PI_WORKER_TRANSPORT: "inline" }), "inline");
	assert.equal(workerTransport({ PI_WORKER_TRANSPORT: "" }), "inline");
	assert.equal(workerTransport({ PI_WORKER_TRANSPORT: "bogus" }), "inline");
	assert.equal(workerTransport({ PI_WORKER_TRANSPORT: "host" }), "host");
	assert.equal(workerTransport({ PI_WORKER_TRANSPORT: " Host " }), "host");
	const g = globalThis as Record<symbol, unknown>;
	const saved = g[DETACH_WORKERS];
	t.after(() => { if (saved === undefined) delete g[DETACH_WORKERS]; else g[DETACH_WORKERS] = saved; });
	for (const value of [true, false]) {
		g[DETACH_WORKERS] = value;
		assert.equal(hostingRequested({}), false, `detach global ${value} alone`);
		assert.equal(detachRequested(), value);
	}
	g[DETACH_WORKERS] = "yes";
	assert.equal(detachRequested(), false, "only boolean true detaches");
	// Rename bridge: the legacy pi-web:detach-workers symbol still requests detach, either symbol alone.
	const savedLegacy = g[LEGACY_DETACH_WORKERS];
	t.after(() => { if (savedLegacy === undefined) delete g[LEGACY_DETACH_WORKERS]; else g[LEGACY_DETACH_WORKERS] = savedLegacy; });
	delete g[DETACH_WORKERS];
	g[LEGACY_DETACH_WORKERS] = true;
	assert.equal(detachRequested(), true, "legacy symbol alone (pre-rename server) still detaches");
	g[DETACH_WORKERS] = true;
	g[LEGACY_DETACH_WORKERS] = false;
	assert.equal(detachRequested(), true, "new symbol alone");
	delete g[LEGACY_DETACH_WORKERS];
	// WorkerHosting.active(): env at call time, and only for a persisted owner session.
	const root = tempRoot(t);
	const h = new WorkerHosting({ root });
	h.setOwner("owner-1", "/s/owner.jsonl");
	const env = process.env[TRANSPORT_ENV];
	t.after(() => { if (env === undefined) delete process.env[TRANSPORT_ENV]; else process.env[TRANSPORT_ENV] = env; });
	delete process.env[TRANSPORT_ENV];
	assert.equal(h.active(), false);
	process.env[TRANSPORT_ENV] = "inline";
	assert.equal(h.active(), false);
	process.env[TRANSPORT_ENV] = "host";
	assert.equal(h.active(), true);
	h.setOwner("owner-1", undefined);
	assert.equal(h.active(), false, "in-memory sessions cannot be re-adopted");
	h.setOwner("../evil", "/s/x.jsonl");
	assert.equal(h.active(), false, "unsafe owner ids are refused");
	assert.deepEqual(fs.readdirSync(root), [], "deciding touches nothing on disk");
});

// ── transport replay semantics ───────────────────────────────────────────────

test("replay: history up to historyEnd is flagged and cannot write stdin; later lines are new; duplicates are dropped", { skip }, async (t) => {
	const sock = sockIn(t);
	const lines = ["a", "bb", "ccc", "dddd"];
	const off = ends(lines);
	const host = fakeHost(sock, [...lines]);
	await host.listen();
	t.after(() => host.close());
	const consumed: number[] = [];
	const transport = attachTransport(sock, { historyEnd: off[1], onConsumed: (o) => consumed.push(o) });
	const seen: [string, boolean][] = [];
	let live = false;
	transport.stdout.on("data", (chunk: Buffer) => {
		seen.push([chunk.toString().trimEnd(), transport.replaying]);
		transport.stdin.write(`reply-to-${chunk.toString().trimEnd()}\n`);
	});
	transport.on("live", () => { live = true; });
	transport.connect();
	await until(() => live, 3000, "live");
	assert.deepEqual(seen, [["a", true], ["bb", true], ["ccc", false], ["dddd", false]]);
	assert.deepEqual(consumed, off);
	assert.equal(transport.consumedOffset, off[3]);
	assert.equal(transport.hello?.hostPid, process.pid);
	// Writes made while history was delivered never reach the worker.
	await until(() => host.received.filter((f) => f.type === "stdin").length === 2, 2000, "stdin frames");
	assert.deepEqual(host.received.filter((f) => f.type === "stdin").map((f) => f.data), ["reply-to-ccc\n", "reply-to-dddd\n"]);
	assert.deepEqual(host.received[0], { type: "attach", offset: 0 });
	// A line re-sent after a reconnect (end <= consumed) is not delivered twice.
	transport.deliver(off[2], "ccc");
	assert.equal(seen.length, 4);
	host.emit("eeeee");
	await until(() => seen.length === 5, 2000, "live line");
	assert.deepEqual(seen[4], ["eeeee", false]);
	// The worker's exit arrives in ChildProcess order.
	const order: string[] = [];
	transport.stdout.on("end", () => order.push("end"));
	transport.on("exit", () => order.push("exit"));
	transport.on("close", (code, signal) => order.push(`close:${code}:${signal}`));
	host.exit(0);
	await until(() => order.length === 3, 2000, "close");
	assert.deepEqual(order, ["end", "exit", "close:0:null"]);
	assert.equal(transport.gone, true);
	assert.equal(transport.stdin.write("late\n"), false);
});

test("sentLines reads the in.jsonl tail and drops a cut first line", (t) => {
	const dir = tempRoot(t);
	assert.deepEqual(sentLines(dir), []);
	fs.writeFileSync(files(dir).in, `${"x".repeat(50)}\n{"a":1}\n\n{"b":2}\n`);
	assert.deepEqual(sentLines(dir), ["x".repeat(50), '{"a":1}', '{"b":2}']);
	assert.deepEqual(sentLines(dir, 20), ['{"a":1}', '{"b":2}']);
});

// ── the real host.ts ─────────────────────────────────────────────────────────

/** Fake worker: echoes each stdin line as {"echo":…}, exits 3 on "quit". */
const ECHO_WORKER = `
	process.stdout.write(JSON.stringify({ hi: process.pid }) + "\\n");
	let b = "";
	process.stdin.on("data", (d) => { b += d; let i; while ((i = b.indexOf("\\n")) !== -1) { const l = b.slice(0, i); b = b.slice(i + 1);
		if (l === "quit") process.exit(3); process.stdout.write(JSON.stringify({ echo: l }) + "\\n"); } });
	process.stdin.on("end", () => process.exit(0));
`;

test("real host: out.jsonl/in.jsonl, detach keeps the worker, re-attach replays from 0, exit writes status.json", { skip, timeout: 20_000 }, async (t) => {
	const dir = tempRoot(t);
	const sock = sockIn(t);
	let hostPid: number | undefined;
	t.after(() => { if (hostPid) try { process.kill(hostPid, "SIGKILL"); } catch { /* gone */ } });
	const first = hostedSpawnImpl({ dir, sock, lingerMs: 200, onHostStarted: (pid) => { hostPid = pid; } })(process.execPath, ["-e", ECHO_WORKER], { cwd: dir, stdio: [] }) as unknown as HostTransport;
	const out: string[] = [];
	first.stdout.on("data", (c: Buffer) => out.push(...c.toString().trim().split("\n")));
	await until(() => out.length === 1, 8000, "worker hello");
	first.stdin.write("one\n");
	await until(() => out.length === 2, 3000, "echo");
	assert.deepEqual(JSON.parse(out[1]), { echo: "one" });
	assert.ok(first.hello?.workerPid && pidAlive(first.hello.workerPid));
	const workerPid = first.hello!.workerPid!;
	// Detach: the worker lives on; nothing was signalled.
	first.detach();
	await pause(150);
	assert.ok(pidAlive(workerPid), "worker survives the manager detaching");
	const pong = await pingHost(sock);
	assert.equal(pong?.hostPid, hostPid);
	assert.equal(pong?.exited, false);
	assert.equal(fs.readFileSync(files(dir).in, "utf8"), "one\n");
	const log = fs.readFileSync(files(dir).out, "utf8");
	assert.equal(log.trim().split("\n").length, 2);
	// A second manager replays everything, the first two lines as history.
	const historyEnd = Buffer.byteLength(log);
	const second = attachTransport(sock, { historyEnd });
	const replay: [string, boolean][] = [];
	second.stdout.on("data", (c: Buffer) => replay.push([c.toString().trim(), second.replaying]));
	second.connect();
	await until(() => second.live, 3000, "live");
	assert.deepEqual(replay.map(([, r]) => r), [true, true]);
	second.stdin.write("two\n");
	await until(() => replay.length === 3, 3000, "live echo");
	assert.deepEqual([JSON.parse(replay[2][0]), replay[2][1]], [{ echo: "two" }, false]);
	// Worker exit: status.json, then the exit reaches the attached manager.
	let closed: unknown[] | undefined;
	second.on("close", (...args) => { closed = args; });
	second.stdin.write("quit\n");
	await until(() => !!closed, 5000, "close");
	assert.deepEqual(closed, [3, null]);
	assert.equal(readJson<any>(files(dir).status)?.exitCode, 3);
	second.release();
	await until(() => !pidAlive(hostPid), 5000, "host exit after release");
	assert.equal(fs.existsSync(sock), false);
});

test("real host: kill through the transport signals the worker's group", { skip, timeout: 20_000 }, async (t) => {
	const dir = tempRoot(t);
	const sock = sockIn(t);
	let hostPid: number | undefined;
	t.after(() => { if (hostPid) try { process.kill(hostPid, "SIGKILL"); } catch { /* gone */ } });
	const transport = hostedSpawnImpl({ dir, sock, lingerMs: 100, onHostStarted: (pid) => { hostPid = pid; } })(process.execPath, ["-e", ECHO_WORKER], { cwd: dir, stdio: [] }) as unknown as HostTransport;
	await until(() => !!transport.hello?.workerPid, 8000, "hello");
	let closed: unknown[] | undefined;
	transport.on("close", (...args) => { closed = args; });
	assert.equal(transport.pid, undefined, "runners must signal through kill(), never a local pid");
	transport.kill("SIGTERM");
	await until(() => !!closed, 5000, "close");
	assert.deepEqual(closed, [null, "SIGTERM"]);
	await until(() => !pidAlive(hostPid), 5000, "host exit");
});

// ── registry lifecycle ───────────────────────────────────────────────────────

function fakeWorker(id: string) {
	let resolve!: () => void;
	const whenClosed = new Promise<void>((r) => { resolve = r; });
	return { id, settled: true, isSettled() { return this.settled; }, isFinished: () => false, whenClosed, close: resolve } as any;
}

test("registry lifecycle: launch → running → detached → adopted by a new manager → exited and archived", { skip, timeout: 30_000 }, async (t) => {
	const root = tempRoot(t);
	const owner = `owner-${process.pid}-${Date.now().toString(36)}`;
	let hostPid: number | undefined;
	t.after(() => { if (hostPid) try { process.kill(hostPid, "SIGKILL"); } catch { /* gone */ } });
	const a = new WorkerHosting({ root, enabled: true, lingerMs: 200 });
	a.setOwner(owner, "/s/owner.jsonl");
	const spec = { prompt: "p", backend: "pi", name: "w", cwd: root, wake: true };
	const launched = a.launch({ id: "ag_01", groupId: "run_01", groupLabel: "label", name: "w", backend: "pi", spec });
	const dir = workerDir(root, owner, "ag_01");
	assert.equal(launched.tmpDir, dir);
	let meta = readJson<WorkerMeta>(files(dir).meta)!;
	assert.deepEqual([meta.state, meta.consumedOffset, meta.ownerSessionFile, meta.sock], ["starting", 0, "/s/owner.jsonl", socketPath(owner, "ag_01")]);
	assert.ok(fs.existsSync(files(dir).lock));
	const transport = launched.spawnImpl(process.execPath, ["-e", ECHO_WORKER], { cwd: root, stdio: [] }) as unknown as HostTransport;
	const w1 = fakeWorker("ag_01");
	a.bind("ag_01", w1);
	await until(() => readJson<WorkerMeta>(files(dir).meta)?.state === "running", 8000, "running");
	meta = readJson<WorkerMeta>(files(dir).meta)!;
	hostPid = meta.hostPid;
	assert.ok(meta.hostPid && meta.workerPid && meta.pidStartTime === procStartTime(meta.hostPid));
	assert.equal(a.candidates().length, 0, "own entries are not adoption candidates");
	// Identity: written once when it changes.
	a.observe({ id: "ag_01", sessionId: "sess-9", sessionFile: "/s/w.jsonl" } as any);
	assert.equal(readJson<WorkerMeta>(files(dir).meta)!.backendSessionId, "sess-9");
	await until(() => transport.consumedOffset > 0, 3000, "hello line");
	const consumed = transport.consumedOffset;
	// Detach: state + consumed offset persisted, lock released, host untouched.
	assert.deepEqual([...a.detachAll(() => true)], ["ag_01"]);
	meta = readJson<WorkerMeta>(files(dir).meta)!;
	assert.deepEqual([meta.state, meta.consumedOffset], ["detached", consumed]);
	assert.equal(fs.existsSync(files(dir).lock), false);
	assert.ok(pidAlive(meta.hostPid, meta.pidStartTime));
	w1.close(); // A detached entry is never finalized by its old runner.
	await pause(20);
	assert.equal(listOwner(root, owner).length, 1);
	// New manager: candidate, adopt (alive), replay with history flags.
	const b = new WorkerHosting({ root, enabled: true });
	b.setOwner(owner, "/s/owner.jsonl");
	assert.deepEqual(b.candidates().map((c) => c.meta.id), ["ag_01"]);
	const adoption = (await b.adopt(dir, b.candidates()[0].meta))!;
	assert.equal(adoption.alive, true);
	assert.equal(adoption.options.adopt.sessionId, "sess-9");
	assert.equal(adoption.options.adopt.ended, false);
	assert.equal(await b.adopt(dir, meta), undefined, "an entry is adopted once");
	const replayed: boolean[] = [];
	const t2 = adoption.options.spawnImpl("", [], { stdio: [] }) as unknown as HostTransport;
	t2.stdout.on("data", () => replayed.push(t2.replaying));
	const w2 = fakeWorker("ag_01");
	b.bind("ag_01", w2);
	await until(() => t2.live, 3000, "live");
	assert.deepEqual(replayed, [true]);
	// Ending: the worker exits, the runner closes, the entry moves to dead/.
	t2.kill("SIGTERM");
	await until(() => t2.gone, 5000, "exit");
	w2.close();
	await until(() => listOwner(root, owner).length === 0, 3000, "archive");
	const archived = fs.readdirSync(deadDir(root));
	assert.equal(archived.length, 1);
	assert.equal(readJson<WorkerMeta>(path.join(deadDir(root), archived[0], "meta.json"))!.state, "exited");
	await until(() => !pidAlive(hostPid), 5000, "host exit after release");
});

test("reaper: archives stale entries without a living host, keeps fresh or living ones, prunes old archives", async (t) => {
	const root = tempRoot(t);
	const now = Date.now();
	const dead = await deadPid();
	const write = (owner: string, id: string, over: Partial<WorkerMeta>) => {
		const dir = workerDir(root, owner, id);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(files(dir).meta, JSON.stringify({ v: 1, id, groupId: "g", name: id, backend: "pi", ownerSessionId: owner,
			sock: "/nope", outLog: files(dir).out, spec: { prompt: "", backend: "pi", name: id, cwd: "/", wake: true },
			consumedOffset: 0, state: "detached", createdAt: 0, updatedAt: 0, ...over }));
		return dir;
	};
	const stale = write("o1", "ag_01", { hostPid: dead, updatedAt: now - 25 * 3600_000 });
	const fresh = write("o1", "ag_02", { hostPid: dead, updatedAt: now - 3600_000 });
	const living = write("o2", "ag_01", { hostPid: process.pid, pidStartTime: procStartTime(process.pid), updatedAt: now - 48 * 3600_000 });
	const oldArchive = path.join(deadDir(root), "o0-ag_09-x");
	fs.mkdirSync(oldArchive, { recursive: true });
	const past = new Date(now - 8 * 24 * 3600_000);
	fs.utimesSync(oldArchive, past, past);
	assert.deepEqual(reap(root, now), [stale]);
	assert.ok(fs.existsSync(fresh) && fs.existsSync(living));
	assert.equal(fs.existsSync(oldArchive), false);
	assert.equal(fs.readdirSync(deadDir(root)).length, 1);
});

// ── manager: detach flag, re-adopt, dead host ────────────────────────────────

interface Manager {
	tools: Map<string, any>;
	events: Map<string, any>;
	appended: { customType: string; data: any }[];
	messages: any[];
	workers: any[];
	ctx: any;
	call(name: string, params: any): Promise<any>;
	start(): void;
	shutdown(): Promise<void>;
}

/** registerSubagents with hosting forced on. `factory` omitted = the real SubagentRunner. */
function manager(root: string, owner: string, factory?: (options: any, handlers: any) => any): Manager {
	const tools = new Map<string, any>();
	const events = new Map<string, any>();
	const appended: { customType: string; data: any }[] = [];
	const messages: any[] = [];
	const workers: any[] = [];
	const ctx: any = {
		cwd: path.resolve(fileURLToPath(new URL("../../", import.meta.url))), mode: "rpc", hasUI: false, thinkingLevel: "high",
		model: { provider: "test", id: "model" },
		sessionManager: { getEntries: () => [], getBranch: () => [], getSessionId: () => owner, getSessionFile: () => `/s/${owner}.jsonl` },
		modelRegistry: { find: (p: string, m: string) => (p === "test" && m === "model" ? { provider: p, id: m } : undefined) },
		ui: { setStatus() {}, notify() {} },
	};
	const pi = {
		events: { on: () => () => {}, emit() {} },
		registerTool: (t: any) => tools.set(t.name, t),
		on: (e: string, f: any) => events.set(e, f),
		registerCommand() {}, registerShortcut() {},
		appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
		getActiveTools: () => ["read"],
		sendMessage: (message: any) => messages.push(message),
	} as any;
	const wrapped = factory && ((options: any, handlers: any) => { const w = factory(options, handlers); workers.push(w); return w; });
	registerSubagents(pi, wrapped as any, { hosting: { root, enabled: true, lingerMs: 200, pingTimeoutMs: 500 } });
	return {
		tools, events, appended, messages, workers, ctx,
		call: (name, params) => tools.get(name).execute("t", params, undefined, () => {}, ctx),
		start: () => events.get("session_start")({}, ctx),
		shutdown: () => events.get("session_shutdown")({}, ctx),
	};
}

/** Minimal Worker over any ChildProcess-like proc: status from exit, kill via proc.kill. */
function procWorker(options: any, handlers: any, proc: any) {
	let resolve!: () => void;
	const w: any = {
		...options, extensions: [], forked: false, status: "running", transcript: [], usage: { input: 0, output: 0, turns: 0 },
		steerCount: 0, processAlive: true, proc, whenClosed: new Promise<void>((r) => { resolve = r; }),
		isFinished() { return ["killed", "done", "error"].includes(this.status); },
		isSettled() { return this.isFinished() || this.status === "waiting"; },
		finalOutput: () => "",
		kill() { proc.kill("SIGTERM"); return this.whenClosed; },
		dispose() { return this.kill(); },
	};
	proc.on("close", (code: number | null) => {
		w.status = code === 0 ? "done" : "killed"; w.processAlive = false; w.endedAt = Date.now();
		handlers.onExit(w); resolve();
	});
	return w;
}

test("detach flag: true leaves hosted workers running (registry 'detached'); unset kills them", { skip, timeout: 40_000 }, async (t) => {
	const g = globalThis as Record<symbol, unknown>;
	const saved = g[DETACH_WORKERS];
	t.after(() => { if (saved === undefined) delete g[DETACH_WORKERS]; else g[DETACH_WORKERS] = saved; });
	const root = tempRoot(t);
	const owner = `own-${Date.now().toString(36)}`;
	const hostPids: number[] = [];
	t.after(() => { for (const pid of hostPids) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } });
	const factory = (options: any, handlers: any) => {
		assert.equal(typeof options.spawnImpl, "function", "hosted workers get the host spawnImpl");
		const proc = options.spawnImpl(process.execPath, ["-e", ECHO_WORKER], { cwd: options.cwd, stdio: [] });
		return procWorker(options, handlers, proc);
	};
	// 1) Flag true: detach.
	const m1 = manager(root, owner, factory);
	m1.start();
	await m1.call("agent_spawn", { prompt: "stay alive", name: "keep" });
	const dir = workerDir(root, owner, "ag_01");
	await until(() => readJson<WorkerMeta>(files(dir).meta)?.state === "running", 8000, "running");
	const running = readJson<WorkerMeta>(files(dir).meta)!;
	hostPids.push(running.hostPid!);
	assert.deepEqual(m1.appended.filter((e) => e.customType === WORKER_MANIFEST_ENTRY_TYPE).map((e) => e.data.workerId), ["ag_01"]);
	g[DETACH_WORKERS] = true;
	await m1.shutdown();
	const detached = readJson<WorkerMeta>(files(dir).meta)!;
	assert.equal(detached.state, "detached");
	assert.ok(pidAlive(running.workerPid, running.workerStartTime), "worker survives");
	assert.ok((await pingHost(detached.sock))?.hostPid === running.hostPid);
	// 2) Next manager adopts it (fake runner over the adopt transport), then shuts down WITHOUT the flag: killed.
	delete g[DETACH_WORKERS];
	const m2 = manager(root, owner, (options, handlers) => {
		assert.ok(options.adopt, "adopt mode");
		assert.equal(options.id, "ag_01");
		assert.equal(options.task, "stay alive");
		return procWorker(options, handlers, options.spawnImpl("", [], { stdio: [] }));
	});
	m2.start();
	await until(() => m2.workers.length === 1, 5000, "adoption");
	const list = await m2.call("agent_list", {});
	assert.deepEqual(list.details.agents.map((a: any) => [a.id, a.name]), [["ag_01", "keep"]]);
	await m2.shutdown();
	assert.equal(pidAlive(running.workerPid, running.workerStartTime), false, "worker killed on a normal shutdown");
	assert.equal(listOwner(root, owner).length, 0, "entry archived");
	assert.ok(fs.readdirSync(deadDir(root)).some((n) => n.startsWith(`${owner}-ag_01-`)));
});

/** Pi rpc stream lines for one task run. */
const piRun = (user: string, answer: string) => [
	JSON.stringify({ type: "agent_start" }),
	JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: user }] } }),
	JSON.stringify({ type: "message_end", message: { role: "assistant", content: answer, usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } } }),
	JSON.stringify({ type: "agent_end", messages: [], willRetry: false }),
	JSON.stringify({ type: "agent_settled" }),
];

function writeEntry(root: string, owner: string, id: string, over: Partial<WorkerMeta>, log: string[]): string {
	const dir = workerDir(root, owner, id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(files(dir).out, log.map((l) => `${l}\n`).join(""));
	writeMeta(dir, {
		v: 1, id, groupId: "run_01", groupLabel: "earlier run", name: "worker", backend: "pi", ownerSessionId: owner,
		ownerSessionFile: `/s/${owner}.jsonl`, sock: "/nonexistent.sock", outLog: files(dir).out,
		spec: { prompt: "first task", backend: "pi", name: "worker", cwd: root, wake: true },
		consumedOffset: 0, state: "detached", createdAt: 1, updatedAt: 1, backendSessionId: "pi-sess", ...over,
	});
	return dir;
}

test("re-adopt (fake host, real unix socket, real SubagentRunner): history is silent, a completion after consumedOffset wakes once", { skip, timeout: 20_000 }, async (t) => {
	const root = tempRoot(t);
	const owner = `own-${Date.now().toString(36)}`;
	const sock = sockIn(t);
	const history = piRun("first task", "first answer");
	const fresh = piRun("steered", "second answer");
	const log = [...history, ...fresh];
	const host = fakeHost(sock, [...log]);
	await host.listen();
	t.after(() => host.close());
	const consumed = ends(history).at(-1)!;
	const dir = writeEntry(root, owner, "ag_03", { sock, hostPid: process.pid, pidStartTime: procStartTime(process.pid), consumedOffset: consumed }, log);
	const m = manager(root, owner);
	m.start();
	await until(() => m.messages.length === 1, 5000, "completion message");
	assert.equal(m.messages[0].customType, "subagent-complete");
	assert.match(m.messages[0].content, /second answer/);
	assert.doesNotMatch(m.messages[0].content, /first answer/);
	const list = await m.call("agent_list", {});
	const [worker] = list.details.agents;
	assert.deepEqual([worker.id, worker.groupId, worker.status, worker.taskOutcome, worker.sessionId], ["ag_03", "run_01", "waiting", "success", "pi-sess"]);
	// The whole log was attached from 0; nothing of the history was re-sent to the worker.
	assert.deepEqual(host.received.find((f) => f.type === "attach"), { type: "attach", offset: 0 });
	assert.equal(host.received.filter((f) => f.type === "stdin").length, 0);
	// Consumed offset advanced and persists (debounced save).
	await until(() => readJson<WorkerMeta>(files(dir).meta)!.consumedOffset === ends(log).at(-1), 3000, "consumedOffset");
	assert.equal(readJson<WorkerMeta>(files(dir).meta)!.state, "running");
	// A live completion later wakes again, exactly once.
	for (const line of piRun("third", "third answer")) host.emit(line);
	await until(() => m.messages.length === 2, 3000, "live completion");
	assert.match(m.messages[1].content, /third answer/);
	// Detach again at shutdown: fake host gets no signal.
	(globalThis as Record<symbol, unknown>)[DETACH_WORKERS] = true;
	try { await m.shutdown(); } finally { delete (globalThis as Record<symbol, unknown>)[DETACH_WORKERS]; }
	assert.equal(host.received.filter((f) => f.type === "signal").length, 0);
	const after = readJson<WorkerMeta>(files(dir).meta)!;
	assert.deepEqual([after.state, after.consumedOffset], ["detached", ends([...log, ...piRun("third", "third answer")]).at(-1)]);
});

test("dead host mid-turn: log replayed, worker finalized as lost, registry record 'lost', entry archived", { skip, timeout: 20_000 }, async (t) => {
	const root = tempRoot(t);
	const owner = `own-${Date.now().toString(36)}`;
	const log = [...piRun("first task", "first answer"), JSON.stringify({ type: "agent_start" })];
	const dead = await deadPid();
	writeEntry(root, owner, "ag_04", { hostPid: dead, workerPid: dead, workerStartTime: 1, consumedOffset: ends(log).at(-1)! }, log);
	const m = manager(root, owner);
	m.start();
	await until(() => listOwner(root, owner).length === 0, 5000, "archive");
	const [archived] = fs.readdirSync(deadDir(root));
	const meta = readJson<WorkerMeta>(path.join(deadDir(root), archived, "meta.json"))!;
	assert.equal(meta.state, "lost");
	assert.equal(meta.backendSessionId, "pi-sess", "kept for a manual resume");
	const list = await m.call("agent_list", {});
	assert.equal(list.details.agents[0].status, "error");
	const final = m.appended.filter((e) => e.customType === WORKER_MANIFEST_ENTRY_TYPE).map((e) => e.data);
	assert.deepEqual(final.map((r) => [r.workerId, r.status]), [["ag_04", "lost"]]);
	// The ending itself is new to every manager: one failure report, never a success.
	assert.equal(m.messages.length, 1);
	assert.match(m.messages[0].content, /ag_04 \(worker\) — error/);
	assert.doesNotMatch(m.messages[0].content, /first answer/);
	await m.shutdown();
});

test("dead host after a clean exit: status.json decides, a completion after consumedOffset still wakes", { skip, timeout: 20_000 }, async (t) => {
	const root = tempRoot(t);
	const owner = `own-${Date.now().toString(36)}`;
	const history = piRun("first task", "first answer");
	const log = [...history, ...piRun("steered", "late answer")];
	const dead = await deadPid();
	const dir = writeEntry(root, owner, "ag_05", { hostPid: dead, consumedOffset: ends(history).at(-1)! }, log);
	fs.writeFileSync(files(dir).status, JSON.stringify({ exitCode: 0, signal: null, endedAt: Date.now() }));
	const m = manager(root, owner);
	m.start();
	await until(() => listOwner(root, owner).length === 0, 5000, "archive");
	const [archived] = fs.readdirSync(deadDir(root));
	assert.equal(readJson<WorkerMeta>(path.join(deadDir(root), archived, "meta.json"))!.state, "exited");
	assert.equal(m.messages.length, 1);
	assert.match(m.messages[0].content, /late answer/);
	const final = m.appended.filter((e) => e.customType === WORKER_MANIFEST_ENTRY_TYPE).map((e) => e.data);
	assert.notEqual(final.at(-1)?.status, "lost");
	await m.shutdown();
});

test("adoption skips entries locked by another living manager and finished entries", { skip }, async (t) => {
	const root = tempRoot(t);
	const owner = `own-${Date.now().toString(36)}`;
	const dirA = writeEntry(root, owner, "ag_06", {}, []);
	// Held by a living process other than us (pid 1 is always alive).
	fs.writeFileSync(files(dirA).lock, JSON.stringify({ pid: 1, startTime: procStartTime(1) }));
	writeEntry(root, owner, "ag_07", { state: "exited" }, []);
	const h = new WorkerHosting({ root, enabled: true });
	h.setOwner(owner, "/s/o.jsonl");
	assert.deepEqual(h.candidates(), []);
	assert.equal(await h.adopt(dirA, readJson<WorkerMeta>(files(dirA).meta)!), undefined);
});
