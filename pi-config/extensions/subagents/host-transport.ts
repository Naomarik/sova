/**
 * HostTransport: a ChildProcess-compatible object whose stdin/stdout/stderr and
 * exit/close events are fed by a detached worker host (host.ts) over its unix
 * socket, so both runners' protocol logic is unchanged behind their spawnImpl
 * seam. Three ways to get one:
 *
 *   hostedSpawnImpl()   launch a host for a new worker (the runner's spawnImpl)
 *   attachTransport()   re-adopt a living host: replay out.jsonl from 0, then live
 *   logTransport()      the host is dead: replay out.jsonl, then report the exit
 *                       from status.json (or a lost host)
 *
 * Replay semantics: every stdout line carries its end offset in out.jsonl.
 * Lines ending at or before `historyEnd` (the consumedOffset persisted by the
 * previous manager) are HISTORY: they rebuild runner state, but `replaying` is
 * true while they are delivered, runners suppress settle notifications and
 * permission prompts for them, and stdin writes are dropped. Lines after it
 * are new to every manager and behave exactly like live output. The consumed
 * offset advances synchronously after each line is delivered (the runners
 * process a data event synchronously) and is reported through onConsumed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { HostSpawnSpec } from "./host.ts";
import { files, readStatus, type WorkerStatus } from "./workers-dir.ts";

export const HOST_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "host.ts");
type SpawnImpl = (command: string, args: string[], options: { cwd?: string; stdio: any[]; env?: NodeJS.ProcessEnv }) => ChildProcess;

export interface HostHello { hostPid: number; hostStartTime?: number; workerPid?: number; workerStartTime?: number }

export interface TransportOptions {
	/** Offset to attach from (0 = full replay). */
	offset?: number;
	/** Lines ending at or before this offset were already consumed by an earlier manager. */
	historyEnd?: number;
	onConsumed?: (offset: number) => void;
	onHello?: (hello: HostHello) => void;
	/** How long to keep retrying the first connection (host startup). */
	connectTimeoutMs?: number;
	/** Where the host writes status.json; read if the connection is lost for good. */
	statusFile?: string;
}

class TransportStream extends EventEmitter {
	destroyed = false;
	destroy(): this { this.destroyed = true; return this; }
	setEncoding(): this { return this; }
}

class TransportStdin extends EventEmitter {
	destroyed = false;
	writableEnded = false;
	writableLength = 0;
	private readonly transport: HostTransport;
	constructor(transport: HostTransport) { super(); this.transport = transport; }
	get writable(): boolean { return !this.destroyed && !this.writableEnded && !this.transport.gone; }
	write(chunk: string | Buffer): boolean {
		if (!this.writable) return false;
		// History is rebuilt, never re-driven: a reply to a replayed request would be stale.
		if (this.transport.replaying) return true;
		this.transport.sendFrame({ type: "stdin", data: String(chunk) });
		return true;
	}
	end(): this {
		if (this.writableEnded) return this;
		this.writableEnded = true;
		this.transport.sendFrame({ type: "eof" });
		return this;
	}
	destroy(): this { this.destroyed = true; return this; }
}

export class HostTransport extends EventEmitter {
	/** Undefined on purpose: runners then signal through kill(), which the host applies to the worker's group. */
	readonly pid: number | undefined = undefined;
	readonly stdin: TransportStdin;
	readonly stdout = new TransportStream();
	readonly stderr = new TransportStream();
	exitCode: number | null = null;
	signalCode: string | null = null;
	/** Byte offset in out.jsonl up to which lines have been delivered. */
	consumedOffset: number;
	readonly historyEnd: number;
	/** True while a history line (already consumed by an earlier manager) is being delivered. */
	replaying = false;
	/** The replay finished; output is live. */
	live = false;
	hello?: HostHello;
	/** Set before the synthesized exit of a dead host; lets the owner inspect the rebuilt state. */
	beforeExit?: () => void;
	private socket?: net.Socket;
	private queue: string[] = [];
	private connected = false;
	private finished = false;
	private detached = false;
	private buffer = "";
	private readonly options: TransportOptions;
	private readonly sock?: string;

	constructor(sock: string | undefined, options: TransportOptions = {}) {
		super();
		this.sock = sock;
		this.options = options;
		this.consumedOffset = options.offset ?? 0;
		this.historyEnd = options.historyEnd ?? 0;
		this.stdin = new TransportStdin(this);
	}

	/** Finished or detached: nothing more will be written or emitted. */
	get gone(): boolean { return this.finished || this.detached; }

	sendFrame(frame: Record<string, unknown>): void {
		if (this.gone) return;
		const line = `${JSON.stringify(frame)}\n`;
		if (this.connected && this.socket && !this.socket.destroyed) this.socket.write(line);
		else this.queue.push(line);
	}

	/** Signal the worker's process group through the host. */
	kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
		if (this.gone) return false;
		this.sendFrame({ type: "signal", sig: typeof signal === "number" ? "SIGTERM" : signal });
		return true;
	}

	ref(): void {}
	unref(): void {}

	/** Leave the worker running: close the socket without signaling, emit nothing more. */
	detach(): void {
		if (this.gone) return;
		this.detached = true;
		this.queue = [];
		try { this.socket?.end(); } catch { /* gone */ }
		this.socket = undefined;
	}

	/** The owner is done with an exited worker: let the host exit now instead of lingering. */
	release(): void {
		const socket = this.socket;
		if (!socket || socket.destroyed) return;
		try { socket.end(`${JSON.stringify({ type: "release" })}\n`); } catch { /* gone */ }
	}

	/** @internal Connect (retrying while the host starts) and attach from consumedOffset. */
	connect(): void {
		const deadline = Date.now() + (this.options.connectTimeoutMs ?? 10_000);
		let reconnects = 0;
		const attempt = () => {
			if (this.gone) return;
			const socket = net.connect(this.sock!);
			let opened = false;
			socket.setEncoding("utf8");
			socket.once("connect", () => {
				opened = true;
				if (this.gone) { socket.destroy(); return; }
				this.socket = socket;
				this.connected = true;
				socket.write(`${JSON.stringify({ type: "attach", offset: this.consumedOffset })}\n`);
				for (const line of this.queue.splice(0)) socket.write(line);
			});
			socket.on("data", (text: string) => this.onData(text));
			socket.on("error", () => { /* close follows */ });
			socket.once("close", () => {
				if (this.socket === socket) { this.socket = undefined; this.connected = false; }
				if (this.gone) return;
				if (!opened && Date.now() < deadline) { setTimeout(attempt, 50); return; }
				// A dropped connection to a living host resumes from the consumed offset.
				if (opened && reconnects++ < 3) { this.buffer = ""; setTimeout(attempt, 200); return; }
				this.connectionLost(opened ? "worker host connection closed" : "worker host did not open its socket");
			});
		};
		attempt();
	}

	/** @internal The host process itself failed before or instead of serving. */
	hostFailed(reason: string): void {
		if (this.gone) return;
		setTimeout(() => { if (!this.gone && !this.connected) this.connectionLost(reason); }, 100);
	}

	private onData(text: string): void {
		this.buffer += text;
		let index: number;
		while ((index = this.buffer.indexOf("\n")) !== -1) {
			const raw = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			if (this.gone) return;
			let frame: any;
			try { frame = JSON.parse(raw); } catch { continue; }
			this.onFrame(frame);
		}
	}

	private onFrame(frame: any): void {
		switch (frame?.t) {
			case "hello":
				this.hello = { hostPid: frame.hostPid, hostStartTime: frame.hostStartTime, workerPid: frame.workerPid, workerStartTime: frame.workerStartTime };
				this.options.onHello?.(this.hello);
				return;
			case "o":
				if (typeof frame.o === "number" && typeof frame.l === "string") this.deliver(frame.o, frame.l);
				return;
			case "e":
				if (typeof frame.d === "string" && !this.replaying) this.stderr.emit("data", Buffer.from(frame.d));
				return;
			case "live":
				this.goLive();
				return;
			case "x":
				this.finish(typeof frame.code === "number" ? frame.code : null, typeof frame.signal === "string" ? frame.signal : null, frame.error);
				return;
			case "superseded":
				// Another manager adopted this worker. Stop driving it; never kill it.
				this.stderr.emit("data", Buffer.from("worker adopted by another manager; this handle is detached\n"));
				this.detach();
				return;
		}
	}

	/** @internal One stdout line whose bytes end at `end` in out.jsonl. */
	deliver(end: number, line: string): void {
		if (this.gone || end <= this.consumedOffset) return; // duplicate after a reconnect
		this.replaying = end <= this.historyEnd;
		try {
			this.stdout.emit("data", Buffer.from(`${line}\n`, "utf8"));
		} finally {
			this.replaying = false;
		}
		this.consumedOffset = end;
		this.options.onConsumed?.(end);
	}

	/** @internal */
	goLive(): void {
		if (this.live || this.gone) return;
		this.live = true;
		this.emit("live");
	}

	private connectionLost(reason: string): void {
		const status = this.options.statusFile ? readJsonStatus(this.options.statusFile) : undefined;
		if (!status) this.stderr.emit("data", Buffer.from(`${reason}; the worker's fate is unknown\n`));
		this.finish(status?.exitCode ?? null, status ? status.signal : "SIGHUP", status?.error);
	}

	/** @internal Worker exited: output end, exit, close — in ChildProcess order. */
	finish(code: number | null, signal: string | null, error?: unknown): void {
		if (this.gone) return;
		this.goLive();
		this.beforeExit?.();
		if (typeof error === "string" && error) this.stderr.emit("data", Buffer.from(error));
		this.finished = true;
		this.exitCode = code;
		this.signalCode = signal;
		this.stdout.emit("end");
		this.emit("exit", code, signal);
		this.emit("close", code, signal);
	}
}

function readJsonStatus(file: string): WorkerStatus | undefined {
	try { return JSON.parse(fs.readFileSync(file, "utf8")) as WorkerStatus; } catch { return undefined; }
}

export interface HostLaunch {
	dir: string;
	sock: string;
	lingerMs?: number;
	orphanTtlMs?: number;
	/** Test seam: the script the host process runs. */
	hostScript?: string;
	onHostStarted?: (hostPid: number | undefined) => void;
	transport?: TransportOptions;
	/** Receives the transport as soon as it exists (before the runner sees it). */
	onTransport?: (transport: HostTransport) => void;
}

/**
 * A runner spawnImpl that starts a detached host for the worker instead of
 * the worker itself. The worker's environment reaches it through the host's
 * own environment; nothing secret is written to disk.
 */
export function hostedSpawnImpl(launch: HostLaunch): SpawnImpl {
	return (command, args, options) => {
		const f = files(launch.dir);
		const spec: HostSpawnSpec = {
			v: 1, command, args, cwd: options.cwd, sock: launch.sock, outLog: f.out, statusFile: f.status, hostInfoFile: f.host, inLog: f.in,
			...(launch.lingerMs === undefined ? {} : { lingerMs: launch.lingerMs }),
			...(launch.orphanTtlMs === undefined ? {} : { orphanTtlMs: launch.orphanTtlMs }),
		};
		fs.writeFileSync(f.spawn, JSON.stringify(spec), { mode: 0o600 });
		const transport = new HostTransport(launch.sock, { statusFile: f.status, ...launch.transport });
		launch.onTransport?.(transport);
		const logFd = fs.openSync(f.log, "a", 0o600);
		let host: ChildProcess;
		try {
			host = spawn(process.execPath, [launch.hostScript ?? HOST_SCRIPT, f.spawn], {
				cwd: launch.dir, detached: true, stdio: ["ignore", logFd, logFd], env: options.env ?? process.env,
			});
		} finally {
			fs.closeSync(logFd);
		}
		host.once("error", (error) => transport.hostFailed(`worker host failed to start: ${error.message}`));
		host.once("exit", (code, signal) => transport.hostFailed(`worker host exited (${signal ?? code})`));
		host.unref();
		launch.onHostStarted?.(host.pid);
		transport.connect();
		return transport as unknown as ChildProcess;
	};
}

/** Re-adopt a living host: full replay from 0 (history up to historyEnd), then live. */
export function attachTransport(sock: string, options: TransportOptions): HostTransport {
	return new HostTransport(sock, { offset: 0, ...options });
}

/**
 * The host is gone. Replay out.jsonl as history/new output exactly like a live
 * attach would, then report the worker's exit from status.json — or, without
 * one, a lost host. Emission starts on connect() (i.e. when the runner spawns).
 */
export function logTransport(outLog: string, statusFile: string, options: TransportOptions = {}): HostTransport {
	const transport = new HostTransport(undefined, { offset: 0, ...options });
	(transport as any).connect = () => {
		setImmediate(() => {
			let data: Buffer;
			try { data = fs.readFileSync(outLog); } catch { data = Buffer.alloc(0); }
			let position = 0;
			let index: number;
			while ((index = data.indexOf(0x0a, position)) !== -1) {
				transport.deliver(index + 1, data.subarray(position, index).toString("utf8"));
				position = index + 1;
			}
			const status = readStatus(path.dirname(statusFile)) ?? readJsonStatus(statusFile);
			if (!status) transport.stderr.emit("data", Buffer.from("worker host died without recording the worker's exit\n"));
			transport.finish(status?.exitCode ?? null, status ? status.signal : "SIGKILL", status?.error);
		});
	};
	return transport;
}

/** One-shot ping over a host socket: resolves the pong, or undefined on error/timeout. */
export function pingHost(sock: string, timeoutMs = 1000): Promise<{ hostPid: number; workerPid?: number; exited: boolean } | undefined> {
	return new Promise((resolve) => {
		let done = false;
		let buffer = "";
		const socket = net.connect(sock);
		const finish = (value: { hostPid: number; workerPid?: number; exited: boolean } | undefined) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(value);
		};
		const timer = setTimeout(() => finish(undefined), timeoutMs);
		socket.setEncoding("utf8");
		socket.once("connect", () => socket.write(`${JSON.stringify({ type: "ping" })}\n`));
		socket.on("data", (text: string) => {
			buffer += text;
			const index = buffer.indexOf("\n");
			if (index === -1) return;
			try {
				const frame = JSON.parse(buffer.slice(0, index));
				finish(frame?.t === "pong" ? { hostPid: frame.hostPid, workerPid: frame.workerPid, exited: frame.exited === true } : undefined);
			} catch {
				finish(undefined);
			}
		});
		socket.on("error", () => finish(undefined));
		socket.on("close", () => finish(undefined));
	});
}

/** A runner spawnImpl that hands over an existing transport (adoption) and starts it. */
export function adoptSpawnImpl(transport: HostTransport): SpawnImpl {
	return () => {
		transport.connect();
		return transport as unknown as ChildProcess;
	};
}
