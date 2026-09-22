import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { buildDiscoveryArgv, claudeEnv } from "./transport.ts";
import type { BackendModel } from "../subagents/contracts.ts";

/** Test seams; production callers need only pass an optional abort signal. */
export interface ClaudeModelDiscoveryOptions {
	executable?: string;
	spawnImpl?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
	signalGroupImpl?: (pid: number, signal: NodeJS.Signals) => void;
	timeoutMs?: number;
	eofGraceMs?: number;
	termGraceMs?: number;
	pipeDrainMs?: number;
	maxLineBytes?: number;
	maxOutputBytes?: number;
	/** Receives the child's closure promise; the caller's result can precede it. */
	trackClosure?: (closed: Promise<void>) => void;
}
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function abortError(): Error {
	const error = new Error("Claude model discovery aborted");
	error.name = "AbortError";
	return error;
}
function modelsFrom(value: unknown): BackendModel[] {
	if (!Array.isArray(value)) throw new Error("Claude initialize response has no model list");
	const models: BackendModel[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (!record(item) || typeof item.value !== "string" || !item.value.trim()
			|| typeof item.displayName !== "string" || !item.displayName.trim()) {
			throw new Error("Claude initialize returned an invalid model list");
		}
		if (seen.has(item.value)) continue;
		seen.add(item.value);
		// Explicit allowlist: never retain account/settings/capability metadata.
		const model: BackendModel = { id: item.value, name: item.displayName };
		if (typeof item.description === "string") model.description = item.description;
		if (typeof item.resolvedModel === "string") model.resolvedModel = item.resolvedModel;
		if (Array.isArray(item.supportedEffortLevels)) {
			if (!item.supportedEffortLevels.every((effort) => typeof effort === "string" && effort.trim())) {
				throw new Error("Claude initialize returned invalid effort levels");
			}
			model.efforts = [...new Set(item.supportedEffortLevels as string[])];
		}
		models.push(model);
	}
	return models;
}

/** Initialize only: no user message, model task, or authoritative fallback list.
 * Normally settles at child closure, after cleanup. The caller never waits past
 * abort or timeoutMs: abort rejects immediately and the deadline settles with
 * whatever is known, while EOF → TERM → KILL cleanup continues. trackClosure
 * lets the owner keep responsibility for that closure (e.g. await it at shutdown).
 * Raw CLI errors/stderr are intentionally never exposed (may contain secrets).
 */
export async function discoverClaudeModels(
	signal?: AbortSignal,
	options: ClaudeModelDiscoveryOptions = {},
): Promise<BackendModel[]> {
	if (signal?.aborted) throw abortError();
	const timeoutMs = options.timeoutMs ?? 15000;
	const eofGraceMs = options.eofGraceMs ?? 500;
	const termGraceMs = options.termGraceMs ?? 1000;
	const pipeDrainMs = options.pipeDrainMs ?? 250;
	const maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
	const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
	for (const value of [timeoutMs, eofGraceMs, termGraceMs, pipeDrainMs, maxLineBytes, maxOutputBytes]) {
		if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Discovery limits/timings must be positive integers");
	}
	const env = claudeEnv();
	let child: ChildProcess;
	try {
		child = (options.spawnImpl ?? spawn)(options.executable ?? "claude", buildDiscoveryArgv(),
			{ shell: false, detached: process.platform !== "win32", env, stdio: ["pipe", "pipe", "pipe"] });
	} catch { throw new Error("Could not spawn Claude for model discovery"); }
	let markClosed!: () => void;
	const closure = new Promise<void>((resolve) => { markClosed = resolve; });
	options.trackClosure?.(closure);

	return new Promise<BackendModel[]>((resolveCaller, rejectCaller) => {
		let callerSettled = false;
		// Unlike `timeout`, cleanup never clears this: it bounds only the caller.
		const deadline = setTimeout(() => {
			// A parsed result stays valid even if closure is slow.
			if (models !== undefined && !failure) { resolve(models); stop(); return; }
			stop(new Error("Claude model discovery timed out"));
			reject(failure ?? new Error("Claude model discovery timed out"));
		}, timeoutMs);
		function settle(): void {
			callerSettled = true;
			clearTimeout(deadline);
			signal?.removeEventListener("abort", abort);
		}
		function resolve(value: BackendModel[]): void { if (!callerSettled) { settle(); resolveCaller(value); } }
		function reject(error: Error): void { if (!callerSettled) { settle(); rejectCaller(error); } }
		const requestId = randomUUID();
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		let lineBytes = 0;
		let outputBytes = 0;
		let models: BackendModel[] | undefined;
		let failure: Error | undefined;
		let stopping = false;
		let closed = false;
		let leaderExited = false;
		let cleanupStarted = false;
		let escalationComplete = false;
		let pipeDrainTimer: ReturnType<typeof setTimeout> | undefined;
		let eofTimer: ReturnType<typeof setTimeout> | undefined;
		let termTimer: ReturnType<typeof setTimeout> | undefined;
		const timeout = setTimeout(() => stop(new Error("Claude model discovery timed out")), timeoutMs);

		function kill(sig: NodeJS.Signals): void {
			try {
				if (process.platform !== "win32" && child.pid) {
					(options.signalGroupImpl ?? ((pid, s) => process.kill(-pid, s)))(child.pid, sig);
				} else child.kill(sig);
			} catch {
				try { child.kill(sig); } catch { /* already gone; still await close */ }
			}
		}
		function stop(error?: Error): void {
			if (closed) return;
			if (error && !failure) failure = error;
			if (stopping) return;
			stopping = true;
			buffer = "";
			startCleanup();
		}
		function schedulePipeDrain(): void {
			// Failed signals/timeouts are not evidence of leader death.
			if (closed || !leaderExited || !escalationComplete || pipeDrainTimer) return;
			pipeDrainTimer = setTimeout(() => {
				pipeDrainTimer = undefined;
				if (closed) return;
				if (!stopping) {
					consume(decoder.end());
					if (buffer && !stopping) parse(buffer);
				}
				child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
			}, pipeDrainMs);
		}
		function startCleanup(): void {
			if (cleanupStarted || closed) return;
			cleanupStarted = true;
			clearTimeout(timeout);
			// Schedule before end(), which can synchronously close a test child.
			eofTimer = setTimeout(() => {
				kill("SIGTERM");
				if (!closed) termTimer = setTimeout(() => {
					kill("SIGKILL"); escalationComplete = true; schedulePipeDrain();
				}, termGraceMs);
			}, eofGraceMs);
			try { child.stdin?.end(); } catch { /* escalate */ }
		}
		function abort(): void { stop(abortError()); reject(abortError()); }
		function parse(line: string): void {
			if (!line.trim() || stopping) return;
			let event: unknown;
			try { event = JSON.parse(line); }
			catch { stop(new Error("Malformed Claude model discovery response")); return; }
			if (!record(event) || event.type !== "control_response" || !record(event.response)) return;
			const response = event.response;
			if (response.request_id !== requestId) return;
			if (response.subtype !== "success") { stop(new Error("Claude model discovery initialize failed")); return; }
			try {
				models = modelsFrom(record(response.response) ? response.response.models : undefined);
			} catch (error) { stop(error as Error); return; }
			stop();
		}
		function consume(text: string): void {
			let start = 0;
			while (!stopping && start < text.length) {
				const end = text.indexOf("\n", start);
				const piece = text.slice(start, end < 0 ? text.length : end);
				lineBytes += Buffer.byteLength(piece);
				if (lineBytes > maxLineBytes) { stop(new Error("Claude model discovery record exceeds limit")); return; }
				buffer += piece;
				if (end < 0) return;
				const line = buffer; buffer = ""; lineBytes = 0;
				parse(line); start = end + 1;
			}
		}
		child.once("exit", () => {
			leaderExited = true;
			startCleanup(); schedulePipeDrain();
		});
		child.on("close", () => {
			if (closed) return;
			closed = true;
			clearTimeout(timeout); clearTimeout(eofTimer); clearTimeout(termTimer); clearTimeout(pipeDrainTimer);
			buffer = "";
			if (failure) reject(failure);
			else if (models !== undefined) resolve(models);
			else reject(new Error("Claude exited before model discovery completed"));
			markClosed();
		});
		child.on("error", () => stop(new Error("Claude model discovery process failed")));
		child.stdin?.on("error", () => { if (!stopping) stop(new Error("Could not initialize Claude model discovery")); });
		child.stdout?.on("error", () => stop(new Error("Claude model discovery output failed")));
		child.stderr?.on("error", () => stop(new Error("Claude model discovery output failed")));
		child.stderr?.resume(); // Drain, never accumulate or report potentially private stderr.
		child.stdout?.on("data", (chunk: Buffer) => {
			if (stopping) return;
			outputBytes += chunk.length;
			if (outputBytes > maxOutputBytes) { stop(new Error("Claude model discovery output exceeds limit")); return; }
			consume(decoder.write(chunk));
		});
		child.stdout?.on("end", () => {
			if (stopping) return;
			consume(decoder.end());
			if (buffer && !stopping) parse(buffer);
			if (!stopping) stop(new Error("Claude output ended before model discovery completed"));
		});
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) { abort(); return; }
		if (!child.stdin || !child.stdout || !child.stderr) { stop(new Error("Claude model discovery requires piped stdio")); return; }
		try {
			child.stdin.write(JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } }) + "\n");
		} catch { stop(new Error("Could not initialize Claude model discovery")); }
	});
}
