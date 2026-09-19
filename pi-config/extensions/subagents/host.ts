/**
 * Detached worker host: one small Node process per detachable worker, started
 * by the manager (host-transport.ts) with `detached: true` and no pipes to it,
 * so the manager's exit never reaches the worker.
 *
 *   node host.ts <spawn.json>
 *
 * The host spawns the REAL worker (claude -p / pi --mode rpc) with pipes, in
 * its own process group, and keeps the worker's stdin open for its lifetime.
 * Every stdout line is appended to out.jsonl. A unix socket serves one attached
 * manager at a time (newline-delimited JSON frames):
 *
 *   manager → host   { type: "attach", offset }   replay out.jsonl from offset, then stream live
 *                    { type: "stdin", data }      forward verbatim to the worker's stdin (and append to in.jsonl)
 *                    { type: "eof" }              end the worker's stdin
 *                    { type: "signal", sig }      signal the worker's process group
 *                    { type: "ping" }             → { t: "pong", hostPid, workerPid, exited }
 *                    { type: "release" }          manager is done: exit as soon as the worker has
 *   host → manager   { t: "hello", hostPid, hostStartTime, workerPid, workerStartTime }
 *                    { t: "o", o: endOffset, l: line }   one stdout line; o = byte offset after it
 *                    { t: "e", d: text }          stderr (live only, also kept in host.log)
 *                    { t: "live" }                replay done; everything after is live
 *                    { t: "x", code, signal, error? }    worker exited (after its output)
 *                    { t: "superseded" }          another manager attached
 *
 * After the worker exits the host writes status.json, keeps the socket for
 * lingerMs (so a restarting manager can still collect the ending), then exits.
 * If no manager is attached for orphanTtlMs the host stops the worker.
 *
 * Node builtins only (plus workers-dir.ts); runs under plain Node type stripping.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePrivateDir, procStartTime, writeJson, type HostInfo, type WorkerStatus } from "./workers-dir.ts";

export interface HostSpawnSpec {
	v: 1;
	command: string;
	args: string[];
	cwd?: string;
	sock: string;
	outLog: string;
	statusFile: string;
	hostInfoFile: string;
	/** Every stdin frame is also appended here, so an adopting manager knows what was already answered. */
	inLog?: string;
	/** Keep serving after the worker exited. Default 60s. */
	lingerMs?: number;
	/** Stop the worker after this long without an attached manager. Default 24h. */
	orphanTtlMs?: number;
}

const DEFAULT_LINGER_MS = 60_000;
const DEFAULT_ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;
/** Output a detached grandchild may still hold after the worker leader exited. */
const PIPE_DRAIN_MS = 250;
const REPLAY_CHUNK = 1024 * 1024;
const MAX_FRAME_CHARS = 16 * 1024 * 1024;

export function runHost(spec: HostSpawnSpec): void {
	const lingerMs = spec.lingerMs ?? DEFAULT_LINGER_MS;
	const orphanTtlMs = spec.orphanTtlMs ?? DEFAULT_ORPHAN_TTL_MS;
	const outFd = fs.openSync(spec.outLog, "a", 0o600);
	let offset = fs.fstatSync(outFd).size;
	let client: net.Socket | undefined;
	let exitFrame: Record<string, unknown> | undefined;
	let orphanTimer: ReturnType<typeof setTimeout> | undefined;
	let lingerTimer: ReturnType<typeof setTimeout> | undefined;
	let released = false;
	let finished = false;

	const log = (message: string) => { try { process.stderr.write(`[host ${new Date().toISOString()}] ${message}\n`); } catch { /* no log */ } };
	const send = (socket: net.Socket | undefined, frame: Record<string, unknown>) => {
		if (!socket || socket.destroyed) return;
		try { socket.write(`${JSON.stringify(frame)}\n`); } catch { /* client gone */ }
	};

	let worker: ChildProcess;
	try {
		worker = spawn(spec.command, spec.args, { cwd: spec.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
	} catch (error) {
		// Nothing to serve: record why and leave (the manager finalizes from status.json).
		try { writeJson(spec.statusFile, { exitCode: null, signal: null, endedAt: Date.now(), error: `Spawn failed: ${String(error)}` }); } catch { /* no status */ }
		process.exit(1);
	}
	const workerPid = worker.pid;
	const info: HostInfo = { hostPid: process.pid, hostStartTime: procStartTime(process.pid), workerPid, workerStartTime: workerPid ? procStartTime(workerPid) : undefined, startedAt: Date.now() };
	try { writeJson(spec.hostInfoFile, info); } catch (error) { log(`host.json: ${String(error)}`); }
	const hello = () => ({ t: "hello", hostPid: info.hostPid, hostStartTime: info.hostStartTime, workerPid: info.workerPid, workerStartTime: info.workerStartTime });

	const signalWorker = (sig: NodeJS.Signals) => {
		if (finished || !workerPid) return;
		try {
			if (process.platform !== "win32") process.kill(-workerPid, sig);
			else worker.kill(sig);
		} catch {
			try { worker.kill(sig); } catch { /* already gone */ }
		}
	};

	// ── worker output ────────────────────────────────────────────────────────
	let pending = Buffer.alloc(0);
	const appendLine = (bytes: Buffer) => {
		const line = Buffer.concat([bytes, Buffer.from("\n")]);
		fs.writeSync(outFd, line);
		offset += line.length;
		send(client, { t: "o", o: offset, l: bytes.toString("utf8") });
	};
	worker.stdout?.on("data", (chunk: Buffer) => {
		pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
		let index: number;
		while ((index = pending.indexOf(0x0a)) !== -1) {
			appendLine(pending.subarray(0, index));
			pending = pending.subarray(index + 1);
		}
	});
	worker.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString("utf8");
		log(`worker stderr: ${text.trimEnd()}`);
		send(client, { t: "e", d: text });
	});
	worker.stdin?.on("error", (error) => log(`worker stdin: ${error.message}`));
	worker.on("error", (error) => {
		// Spawn failure (ENOENT): there is no exit event to wait for.
		if (!workerPid) finish({ exitCode: null, signal: null, endedAt: Date.now(), error: `Spawn failed: ${error.message}` });
		else log(`worker error: ${error.message}`);
	});
	let drainTimer: ReturnType<typeof setTimeout> | undefined;
	let exitStatus: WorkerStatus | undefined;
	const completeExit = () => {
		if (drainTimer) clearTimeout(drainTimer);
		if (exitStatus) finish(exitStatus);
	};
	worker.once("exit", (code, signal) => {
		exitStatus = { exitCode: code, signal, endedAt: Date.now() };
		// Detached descendants can hold stdout open; only proven leader exit lets us cut it off.
		drainTimer = setTimeout(completeExit, PIPE_DRAIN_MS);
	});
	worker.once("close", completeExit);

	function finish(status: WorkerStatus): void {
		if (finished) return;
		finished = true;
		if (pending.length) { appendLine(pending); pending = Buffer.alloc(0); }
		try { fs.fsyncSync(outFd); } catch { /* best effort */ }
		try { writeJson(spec.statusFile, status); } catch (error) { log(`status.json: ${String(error)}`); }
		try { worker?.stdin?.destroy(); worker?.stdout?.destroy(); worker?.stderr?.destroy(); } catch { /* gone */ }
		exitFrame = { t: "x", code: status.exitCode, signal: status.signal, ...(status.error ? { error: status.error } : {}) };
		send(client, exitFrame);
		if (orphanTimer) clearTimeout(orphanTimer);
		lingerTimer = setTimeout(shutdown, released ? 0 : lingerMs);
	}

	// ── socket ───────────────────────────────────────────────────────────────
	const replay = (socket: net.Socket, from: number) => {
		const start = Math.max(0, Math.min(from, offset));
		const fd = fs.openSync(spec.outLog, "r");
		try {
			let position = start;
			let carry = Buffer.alloc(0);
			const buffer = Buffer.alloc(REPLAY_CHUNK);
			// Synchronous on purpose: no live line can interleave with the replay.
			while (position < offset) {
				const read = fs.readSync(fd, buffer, 0, Math.min(REPLAY_CHUNK, offset - position), position);
				if (read <= 0) break;
				position += read;
				let data = carry.length ? Buffer.concat([carry, buffer.subarray(0, read)]) : Buffer.from(buffer.subarray(0, read));
				let lineStart = position - data.length;
				let index: number;
				while ((index = data.indexOf(0x0a)) !== -1) {
					lineStart += index + 1;
					send(socket, { t: "o", o: lineStart, l: data.subarray(0, index).toString("utf8") });
					data = data.subarray(index + 1);
				}
				carry = data;
			}
		} finally {
			fs.closeSync(fd);
		}
		send(socket, { t: "live" });
		if (exitFrame) send(socket, exitFrame);
	};
	const armOrphanTimer = () => {
		if (orphanTimer) clearTimeout(orphanTimer);
		orphanTimer = undefined;
		if (finished || client) return;
		orphanTimer = setTimeout(() => {
			log(`no manager attached for ${orphanTtlMs}ms; stopping the worker`);
			signalWorker("SIGTERM");
			setTimeout(() => signalWorker("SIGKILL"), 5000).unref();
		}, orphanTtlMs);
	};
	const handle = (socket: net.Socket, frame: Record<string, unknown>) => {
		switch (frame.type) {
			case "attach": {
				if (client && client !== socket) {
					send(client, { t: "superseded" });
					client.end();
				}
				client = socket;
				armOrphanTimer();
				send(socket, hello());
				replay(socket, typeof frame.offset === "number" ? frame.offset : 0);
				return;
			}
			case "stdin":
				if (socket !== client || finished || typeof frame.data !== "string") return;
				try { worker.stdin?.write(frame.data); } catch (error) { log(`stdin write: ${String(error)}`); }
				if (spec.inLog) try { fs.appendFileSync(spec.inLog, frame.data, { mode: 0o600 }); } catch (error) { log(`in.jsonl: ${String(error)}`); }
				return;
			case "eof":
				if (socket !== client || finished) return;
				try { worker.stdin?.end(); } catch { /* gone */ }
				return;
			case "signal": {
				if (socket !== client) return;
				const sig = String(frame.sig);
				if (["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGQUIT", "SIGUSR1", "SIGUSR2"].includes(sig)) signalWorker(sig as NodeJS.Signals);
				return;
			}
			case "ping":
				send(socket, { t: "pong", hostPid: process.pid, workerPid, exited: finished });
				return;
			case "release":
				if (socket !== client) return;
				released = true;
				if (finished) {
					if (lingerTimer) clearTimeout(lingerTimer);
					shutdown();
				}
				return;
		}
	};
	ensurePrivateDir(path.dirname(spec.sock));
	try { fs.unlinkSync(spec.sock); } catch { /* no stale socket */ }
	const server = net.createServer((socket) => {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (text: string) => {
			buffer += text;
			let index: number;
			while ((index = buffer.indexOf("\n")) !== -1) {
				const raw = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				let frame: unknown;
				try { frame = JSON.parse(raw); } catch { continue; }
				if (frame && typeof frame === "object") handle(socket, frame as Record<string, unknown>);
			}
			if (buffer.length > MAX_FRAME_CHARS) socket.destroy();
		});
		socket.on("error", () => { /* close follows */ });
		socket.on("close", () => {
			if (client === socket) {
				client = undefined;
				armOrphanTimer();
			}
		});
	});
	server.on("error", (error) => {
		log(`socket: ${error.message}`);
		// Without a socket nobody can drive or stop the worker: do not leave it orphaned.
		signalWorker("SIGTERM");
	});
	const oldMask = process.umask(0o077);
	server.listen(spec.sock, () => { process.umask(oldMask); log(`serving ${spec.sock} for worker ${workerPid}`); });
	armOrphanTimer();

	function shutdown(): void {
		try { server.close(); } catch { /* closed */ }
		try { fs.unlinkSync(spec.sock); } catch { /* gone */ }
		try { fs.closeSync(outFd); } catch { /* closed */ }
		process.exit(0);
	}
	// The host has no terminal; a deliberate TERM of the host stops its worker too.
	process.on("SIGHUP", () => {});
	process.on("SIGINT", () => {});
	process.on("SIGTERM", () => {
		signalWorker("SIGTERM");
		if (finished) shutdown();
	});
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
	const specPath = process.argv[2];
	if (!specPath) {
		process.stderr.write("usage: host.ts <spawn.json>\n");
		process.exit(2);
	}
	runHost(JSON.parse(fs.readFileSync(specPath, "utf8")) as HostSpawnSpec);
}
