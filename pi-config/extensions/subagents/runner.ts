/**
 * SubagentRunner — one long-lived `pi --mode rpc` child process per subagent.
 *
 * Why RPC and not `--mode json -p` (what the shipped subagent example uses):
 * a `-p` child reads its prompt from argv and exits, so it can be waited on but
 * never redirected. RPC keeps the child alive on stdin/stdout, which is what
 * makes `agent_steer` and `agent_kill` possible at all.
 *
 * Lifecycle model (task outcome is deliberately separate from process state):
 *
 *   status        process/task lifecycle: starting → running → waiting ⇄ running
 *                 stopping (teardown in progress) → killed
 *                 terminal: done | error | killed (process has ENDED)
 *   taskOutcome   outcome of the most recently COMPLETED task:
 *                 "success" | "error" | "aborted"; undefined while a task runs
 *
 *   `waiting` means: process alive, idle, steerable. A task that FAILED still
 *   parks in `waiting` with taskOutcome "error" — the process is fine, the work
 *   failed. Callers that care about the result read `taskOutcome`, callers that
 *   care about the process read `isFinished()` / `processAlive`.
 *
 * Shutdown ladder: RPC `abort` (lets pi kill its own in-flight bash trees) →
 * SIGTERM (pi's rpc mode sweeps its tracked detached bash children and exits)
 * → SIGKILL (last resort; cannot be intercepted, may orphan pi's bash
 * grandchildren — unavoidable from outside the child).
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

/** Pi's built-in tool names. `--tools` and `--exclude-tools` also govern extension tools, so restriction must be phrased per case. */
export const BUILTIN_TOOLS: readonly string[] = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

export type AgentStatus = "starting" | "running" | "waiting" | "stopping" | "done" | "error" | "killed";

/** Outcome of the most recently completed task. Undefined while a task is running. */
export type TaskOutcome = "success" | "error" | "aborted";

export type TranscriptKind = "task" | "steer" | "assistant" | "thinking" | "tool" | "tool-result" | "error" | "system";

export interface TranscriptItem {
	ts: number;
	kind: TranscriptKind;
	text: string;
	toolName?: string;
}

export interface AgentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	contextTokens: number;
}

/** @internal Test seams: injected child-process factory and timing overrides. */
export interface RunnerTimings {
	/** How long to wait for a command response before resolving undefined. */
	requestTimeoutMs: number;
	/** kill(): abort → SIGTERM delay. */
	abortGraceMs: number;
	/** kill(): SIGTERM → SIGKILL delay. */
	termGraceMs: number;
	/** dispose(): abort → SIGTERM delay. */
	disposeAbortMs: number;
	/** dispose(): SIGTERM → SIGKILL delay. */
	disposeTermMs: number;
}

/**
 * Memory bounds. The child's own session file is the canonical full record.
 * maxTranscriptBytes is true UTF-8 bytes; maxItemChars and maxLineBytes are
 * JavaScript string characters (which bound the UTF-16 buffer memory).
 */
export interface RunnerLimits {
	/** In-memory transcript tail cap (UTF-8 bytes). Oldest items are trimmed. */
	maxTranscriptBytes: number;
	/** A single RPC line longer than this (in characters) without \n means the protocol is broken. */
	maxLineBytes: number;
	/** Per-transcript-item text cap (characters); longer items are truncated in memory. */
	maxItemChars: number;
}

const DEFAULT_TIMINGS: RunnerTimings = {
	requestTimeoutMs: 15000,
	abortGraceMs: 1000,
	termGraceMs: 3000,
	disposeAbortMs: 800,
	disposeTermMs: 700,
};

const DEFAULT_LIMITS: RunnerLimits = {
	maxTranscriptBytes: 2 * 1024 * 1024,
	maxLineBytes: 4 * 1024 * 1024,
	maxItemChars: 256 * 1024,
};

export interface SpawnOptions {
	id: string;
	groupId: string;
	name: string;
	task: string;
	model?: string;
	effort?: string;
	tools?: string[];
	systemPrompt?: string;
	cwd: string;
	allowNestedExtensions?: boolean;
	/** Trigger a parent turn when this worker settles while the parent is idle. Default true. */
	wake?: boolean;
	/** Extension sources (path, npm:, git:) loaded into the child with `-e`, on top of `--no-extensions`. */
	extensions?: string[];
	/** Parent session file to fork: the child starts with the parent's full message history. */
	forkSession?: string;
	/** @internal Directory for the temp system-prompt file. Default os.tmpdir(). */
	tmpDir?: string;
	/** @internal Injection seam: replace the real spawn with a fake child. */
	spawnImpl?: (command: string, args: string[], options: { cwd?: string; stdio: any[] }) => ChildProcess;
	/** @internal Test overrides. */
	timings?: Partial<RunnerTimings>;
	/** @internal Test overrides. */
	limits?: Partial<RunnerLimits>;
}

export interface RunnerHandlers {
	onChange: () => void;
	/** The agent finished its current instructions (or the attempt definitively failed). Fires again after a steer. */
	onSettled: (runner: SubagentRunner) => void;
	/** The child process ended. Fires exactly once. */
	onExit: (runner: SubagentRunner) => void;
}

export interface SteerResult {
	ok: boolean;
	reason?: string;
}

function emptyUsage(): AgentUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 };
}

/**
 * Resolve how to re-invoke pi itself. Mirrors the shipped subagent example:
 * prefer re-running the current script under the current runtime, fall back to
 * a `pi` on PATH.
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && (part as any).type === "text") {
			parts.push(String((part as any).text ?? ""));
		}
	}
	return parts.join("");
}

interface PendingRequest {
	resolve: (response: any) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class SubagentRunner {
	readonly id: string;
	readonly groupId: string;
	readonly name: string;
	readonly task: string;
	readonly cwd: string;
	readonly wake: boolean;
	readonly extensions: readonly string[];
	readonly forked: boolean;
	readonly startedAt = Date.now();
	/** The exact pid of the tracked child, captured at spawn. Diagnostics only — we always signal the tracked child object, never a re-resolved pid. */
	pid?: number;
	/** Resolves once the process has closed (or failed to start). Never rejects. */
	readonly whenClosed: Promise<void>;

	status: AgentStatus = "starting";
	/** Outcome of the most recently completed task; undefined while a task runs. */
	taskOutcome: TaskOutcome | undefined = undefined;
	/** Process state, independent of task state. */
	processAlive = false;
	/** Model actually in use (refined from the child's get_state, so a session default shows up). */
	model?: string;
	/** Thinking level actually in use (refined from the child's get_state). */
	effort?: string;
	sessionId?: string;
	sessionFile?: string;
	transcript: TranscriptItem[] = [];
	/** Bumped on every transcript change (push, trim, marker rewrite, rollback splice). Lets observers invalidate cheaply instead of diffing the array. */
	transcriptRevision = 0;
	/** How much of the transcript was trimmed from the front (full data lives in the session file). */
	transcriptOmitted = { items: 0, approxBytes: 0 };
	usage: AgentUsage = emptyUsage();
	exitCode?: number | null;
	signal?: string | null;
	error?: string;
	endedAt?: number;
	lastActivity = Date.now();
	steerCount = 0;
	unreadCount = 0;

	private proc: ChildProcess | null = null;
	private buffer = "";
	private nextReqId = 1;
	private pending = new Map<string, PendingRequest>();
	private tmpPromptPath: string | null = null;
	private tmpPromptDir: string | null = null;
	private escalateTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly onChange: () => void;
	private readonly onSettled: (runner: SubagentRunner) => void;
	private readonly onExit: (runner: SubagentRunner) => void;
	private readonly timings: RunnerTimings;
	private readonly limits: RunnerLimits;
	private readonly stdoutDecoder = new StringDecoder("utf-8");
	private readonly stderrDecoder = new StringDecoder("utf-8");
	/** True from the moment we decide the process must die (kill/dispose/fatal). All stream events except command responses are dropped. */
	private killInitiated = false;
	private abortSent = false;
	private closed = false;
	private closedResolve!: () => void;
	/** Guards against re-announcing the same completion. Re-armed when a prompt is accepted. */
	private settleAnnounced = false;
	/** Task-scoped failure flags, cleared when a prompt is accepted. A later successful assistant turn supersedes a transient error. */
	private taskError: string | undefined = undefined;
	private taskAborted = false;
	/** Tool calls awaiting their result, by toolCallId. */
	private openTools = new Map<string, string>();
	private markerItem: TranscriptItem | null = null;
	/** A steer prompt is awaiting its acceptance response. Serializes steers. */
	private steerPending = false;
	/** The initial task prompt has been ACCEPTED by the child. Readiness gate for steer: submission alone can still race the child's async preflight, so only the success ACK makes the runner steerable. */
	private initialPromptAccepted = false;
	/** A task completion was processed while a steer was pending acceptance. */
	private pendingSettled = false;
	/** A steer is armed; the next agent_start begins its run (used to re-arm the announcement slot and move the output boundary when a queued steer is delivered after the previous task settled). */
	private armedAwaitingRun = false;
	/** The transcript marker of the currently armed steer; moved to the new-run boundary at agent_start. */
	private armedSteerItem: TranscriptItem | null = null;

	constructor(options: SpawnOptions, handlers: RunnerHandlers) {
		this.id = options.id;
		this.groupId = options.groupId;
		this.name = options.name;
		this.task = options.task;
		this.cwd = options.cwd;
		this.wake = options.wake ?? true;
		this.extensions = [...(options.extensions ?? [])];
		this.forked = Boolean(options.forkSession);
		this.model = options.model;
		this.effort = options.effort;
		this.onChange = handlers.onChange;
		this.onSettled = handlers.onSettled;
		this.onExit = handlers.onExit;
		this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
		this.limits = {
			...DEFAULT_LIMITS,
			...options.limits,
			maxItemChars: Math.min(
				options.limits?.maxItemChars ?? DEFAULT_LIMITS.maxItemChars,
				options.limits?.maxTranscriptBytes ?? DEFAULT_LIMITS.maxTranscriptBytes,
			),
		};
		this.whenClosed = new Promise<void>((resolve) => {
			this.closedResolve = resolve;
		});
		this.start(options);
	}

	// ── lifecycle ────────────────────────────────────────────────────────────

	private start(options: SpawnOptions): void {
		this.push("task", options.task);
		const args = this.buildArgs(options);
		if (!args) return; // fail() already ran

		let proc: ChildProcess;
		try {
			const invocation = getPiInvocation(args);
			const spawnFn = options.spawnImpl ?? spawn;
			proc = spawnFn(invocation.command, invocation.args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (e) {
			this.taskOutcome = "error";
			this.fail(`Spawn failed: ${(e as Error).message}`);
			return;
		}
		this.proc = proc;
		this.pid = typeof proc.pid === "number" ? proc.pid : undefined;
		this.processAlive = true;

		// An async stdin write error while the child is still expected to be
		// healthy means we can never command it again — fail closed and tear it
		// down. During teardown (kill/dispose already running) EPIPE is expected
		// and the close handler owns finalization.
		proc.stdin?.on("error", (e: Error) => {
			if (!this.closed && !this.killInitiated) this.fail(`stdin pipe error: ${e.message}`);
		});
		proc.stdout?.on("data", (chunk: Buffer) => this.consume(this.stdoutDecoder.write(chunk)));
		proc.stdout?.on("end", () => this.flushStdout());
		proc.stderr?.on("data", (chunk: Buffer) => {
			const text = this.stderrDecoder.write(chunk).trim();
			if (text) this.push("error", text);
		});
		proc.on("error", (e) => {
			if (!this.closed) this.fail(`Process error: ${e.message}`);
		});
		proc.on("close", (code, signal) => this.finalizeExit(code ?? null, signal ?? null));

		// Status stays `starting` until begin() actually submits the task prompt:
		// see begin() for the immediate-steer race this prevents.
		void this.begin(options.task);
	}

	private buildArgs(options: SpawnOptions): string[] | null {
		const args = ["--mode", "rpc"];
		if (options.model) args.push("--model", options.model);
		if (options.effort) args.push("--thinking", options.effort);
		if (options.tools && options.extensions?.length) {
			// `--tools` is an allowlist over built-in AND extension tools, so it
			// would strip the extension tools the child was just given. Restrict
			// built-ins by exclusion instead; extension tools stay enabled.
			if (options.tools.length === 0) args.push("--no-builtin-tools");
			else {
				const excluded = BUILTIN_TOOLS.filter((t) => !options.tools!.includes(t));
				if (excluded.length) args.push("--exclude-tools", excluded.join(","));
			}
		} else if (options.tools) {
			// An explicitly empty allowlist means NO tools. Omitting the flag
			// entirely would give the child every tool — the opposite of what
			// was asked for. (Confirmed: `--no-tools, -nt` in dist/cli/args.js.)
			if (options.tools.length === 0) args.push("--no-tools");
			else args.push("--tools", options.tools.join(","));
		}
		// Subagents load no extensions by default, so they cannot recursively
		// spawn subagents of their own (and do not pay for UI extensions).
		if (!options.allowNestedExtensions) args.push("--no-extensions");
		// `-e` still loads after `--no-extensions`: discovery is off, explicit sources are on.
		for (const source of options.extensions ?? []) args.push("-e", source);
		// A fork copies the parent's session file into a new one; the parent's file is never written by the child.
		if (options.forkSession) args.push("--fork", options.forkSession);

		if (options.systemPrompt?.trim()) {
			try {
				this.tmpPromptDir = fs.mkdtempSync(path.join(options.tmpDir ?? os.tmpdir(), "pi-subagent-"));
				this.tmpPromptPath = path.join(this.tmpPromptDir, "system.md");
				fs.writeFileSync(this.tmpPromptPath, options.systemPrompt, { encoding: "utf-8", mode: 0o600 });
				args.push("--append-system-prompt", this.tmpPromptPath);
			} catch (e) {
				// Fail closed: never run the agent WITHOUT the system prompt it
				// was configured with — that would silently change its behavior.
				this.taskOutcome = "error";
				this.fail(`Could not write system prompt file: ${(e as Error).message}`);
				return null;
			}
		}
		return args;
	}

	private async begin(task: string): Promise<void> {
		const state = await this.request("get_state");
		if (this.closed || this.killInitiated) return;
		if (state?.success && state.data) {
			this.sessionId = state.data.sessionId;
			this.sessionFile = state.data.sessionFile;
			const model = state.data.model;
			if (model?.id) this.model = model.provider ? `${model.provider}/${model.id}` : String(model.id);
			if (typeof state.data.thinkingLevel === "string") this.effort = state.data.thinkingLevel;
			this.touch();
		}
		// Submit the task. Status leaves `starting` HERE — not at spawn — so the
		// UI reflects a working agent as soon as the prompt is on the wire (and
		// an immediate steer cannot slip in a second prompt ahead of the task).
		this.status = "running";
		this.touch();
		const res = await this.request("prompt", { message: task });
		if (this.closed || this.killInitiated) return;
		if (!res || res.success !== true) {
			const reason = res ? String(res.error ?? "prompt rejected") : "no response (timeout or process exit)";
			this.taskOutcome = "error";
			this.push("error", `Initial prompt rejected: ${reason}`);
			this.fail(`Initial prompt rejected: ${reason}`);
			return;
		}
		// Readiness is ACCEPTANCE, not submission: until the child ACKs the
		// initial prompt, its async preflight can still race a second prompt.
		// Status/outcome are deliberately NOT reset here — agent_start may
		// legitimately have flipped status before the ACK, and the task has
		// been armed since construction.
		this.initialPromptAccepted = true;
	}

	/** Terminal failure: record the error, stop trusting the child, tear it down. */
	private fail(message: string, immediate?: "SIGKILL"): void {
		if (this.closed) return;
		this.error = message;
		this.status = "error";
		this.killInitiated = true;
		this.push("error", message);
		this.cleanupTmp();
		if (!this.proc) {
			this.finalizeExit(null, null);
			return;
		}
		if (immediate === "SIGKILL") this.signalChild("SIGKILL");
		void this.terminate("dispose");
	}

	/**
	 * Exactly-once exit bookkeeping. Reached via process close, or directly when
	 * the runner failed before a process existed.
	 */
	private finalizeExit(code: number | null, signal: string | null): void {
		if (this.closed) return;
		this.closed = true;
		this.exitCode = code;
		this.signal = signal;
		this.processAlive = false;
		this.clearEscalation();
		this.clearPending();
		this.cleanupTmp();

		if (this.status === "stopping") {
			this.status = "killed";
		} else if (this.status !== "killed" && this.status !== "error") {
			if (code === 0) {
				this.status = "done";
			} else {
				this.status = "error";
				// Death by signal is NOT success. code === null with no signal of
				// ours means the child died abnormally — also not success.
				this.error ??=
					code !== null && code !== undefined
						? `pi exited with code ${code}`
						: `pi terminated by ${signal ?? "unknown cause"}`;
			}
		}

		// A process that dies without settling its current task (crashed or
		// killed mid-work) still owes the caller one completion announcement.
		if (!this.settleAnnounced) {
			this.settleAnnounced = true;
			this.taskOutcome ??= this.killInitiated && this.status !== "error" ? "aborted" : "error";
			this.onSettled(this);
		}

		this.endedAt = Date.now();
		this.touch();
		this.onExit(this);
		this.closedResolve();
	}

	private cleanupTmp(): void {
		if (this.tmpPromptPath) {
			try {
				fs.unlinkSync(this.tmpPromptPath);
			} catch {
				/* ignore */
			}
			this.tmpPromptPath = null;
		}
		if (this.tmpPromptDir) {
			try {
				fs.rmdirSync(this.tmpPromptDir);
			} catch {
				/* ignore */
			}
			this.tmpPromptDir = null;
		}
	}

	// ── protocol ─────────────────────────────────────────────────────────────

	/**
	 * Strict JSONL: split on \n only. rpc.md calls out that Node's readline is
	 * NOT protocol-compliant here, because it also splits on U+2028/U+2029 which
	 * are legal inside JSON strings. Chunks are decoded with StringDecoder so a
	 * multi-byte UTF-8 sequence split across chunk boundaries is reassembled
	 * instead of corrupting into replacement characters.
	 */
	private consume(text: string): void {
		if (this.closed) return;
		this.buffer += text;
		let newlineIndex: number;
		while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
			const raw = this.buffer.slice(0, newlineIndex);
			this.buffer = this.buffer.slice(newlineIndex + 1);
			const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
			if (!line.trim()) continue;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				continue; // malformed line: skip, keep the stream alive
			}
			// handleEvent is deliberately NOT wrapped here: its failures must
			// surface as errors, not be mistaken for malformed input.
			this.handleEvent(event);
		}
		// Bound the UNCONSUMED TAIL — a single unterminated record — never the
		// batch: one chunk carrying many valid lines is fine regardless of its
		// total size. A tail this long without a newline means the child is not
		// speaking the protocol (or stdout is now binary garbage): bound the
		// memory and fail closed.
		if (this.buffer.length > this.limits.maxLineBytes) {
			this.fail(
				`RPC line exceeded ${this.limits.maxLineBytes} chars without a newline — treating child as broken`,
				"SIGKILL",
			);
		}
	}

	/** Handle a possible final unterminated line when stdout ends. */
	private flushStdout(): void {
		const rest = this.stdoutDecoder.end();
		if (!this.closed && rest) this.buffer += rest;
		// Even when the decoder has nothing left to flush, this.buffer may hold
		// a complete-but-unterminated final line — do not drop it.
		const line = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
		this.buffer = "";
		if (this.closed || !line.trim()) return;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		this.handleEvent(event);
	}

	private handleEvent(event: any): void {
		// Command responses always resolve their pending request, even while
		// dying, so no caller hangs waiting on a dead child.
		if (event?.type === "response") {
			const id = event.id;
			const entry = typeof id === "string" ? this.pending.get(id) : undefined;
			if (entry) {
				this.pending.delete(id);
				clearTimeout(entry.timer);
				entry.resolve(event);
			}
			return;
		}

		// Once we are killing the child or it has closed, everything else on the
		// stream is stale: a queued agent_start must not resurrect a killed
		// agent, and half-flushed transcript output must not pollute the record.
		if (this.closed || this.killInitiated) return;

		switch (event?.type) {
			case "agent_start": {
				this.status = "running";
				if (this.armedAwaitingRun) {
					// This agent_start begins the armed steer's run. If the previous
					// task settled during (or after) the steer's pending window it
					// already consumed the announcement slot — re-arm it, and clear
					// the public outcome/error so the new task starts fresh.
					this.armedAwaitingRun = false;
					this.settleAnnounced = false;
					this.taskError = undefined;
					this.taskAborted = false;
					this.taskOutcome = undefined;
					this.error = undefined;
					// Fresh output boundary: the marker was provisionally pushed at
					// arm time, but old-task output may have arrived after it — move
					// it to the new-run start so finalOutput() cannot expose the old
					// answer as the new task's until fresh output arrives.
					if (this.armedSteerItem) {
						const idx = this.transcript.indexOf(this.armedSteerItem);
						if (idx !== -1 && idx !== this.transcript.length - 1) {
							this.transcript.splice(idx, 1);
							this.transcript.push(this.armedSteerItem);
							this.transcriptRevision++;
						}
						this.armedSteerItem = null;
					}
				}
				break;
			}

			case "agent_settled":
				this.processSettled();
				break;

			case "message_end": {
				const message = event.message;
				if (!message) break;
				if (message.role === "assistant") {
					this.usage.turns++;
					this.addUsage(message.usage);
					const text = textOf(message.content);
					if (text.trim()) {
						this.push("assistant", text.trim());
						this.unreadCount++;
					}
					// Task-scoped failure flags. A failed assistant turn is a
					// failed TASK, not a dying process: the outcome is reported
					// via taskOutcome at settle time, while the process parks in
					// `waiting` and stays steerable. A later successful turn (or
					// a successful auto-retry) supersedes a transient failure.
					if (message.errorMessage) this.taskError = String(message.errorMessage);
					else if (message.stopReason === "error") this.taskError = "assistant turn failed (stopReason: error)";
					else this.taskError = undefined;
					this.taskAborted = message.stopReason === "aborted";
				} else if (message.role === "toolResult") {
					// Tool-reported usage is nested LLM work; it contributes to totals.
					this.addUsage(message.usage);
				}
				break;
			}

			case "tool_execution_start": {
				const name = event.toolName ?? "tool";
				const args = event.args ?? {};
				if (event.toolCallId) this.openTools.set(event.toolCallId, name);
				this.push("tool", summarizeToolCall(name, args), name);
				break;
			}

			case "tool_execution_end": {
				const name = event.toolName ?? this.openTools.get(event.toolCallId) ?? "tool";
				if (event.toolCallId) this.openTools.delete(event.toolCallId);
				if (event.isError) {
					const text = textOf(event.result?.content) || "(tool failed)";
					this.push("tool-result", text.slice(0, 2000), name);
				}
				break;
			}

			case "auto_retry_start":
				this.push(
					"system",
					`auto-retry ${event.attempt ?? "?"}/${event.maxAttempts ?? "?"}: ${String(event.errorMessage ?? "transient error").slice(0, 200)}`,
				);
				break;

			case "auto_retry_end":
				// A retry that overcame the transient error un-fails the task; a
				// final failure pins it (generic reason if the child sent none).
				if (event.success === true) this.taskError = undefined;
				else if (event.success === false)
					this.taskError ??= event.finalError ? String(event.finalError) : "auto-retry failed after transient errors";
				break;

			case "compaction_end":
				// Compaction failure (e.g. API quota exceeded) can settle the run
				// WITHOUT a new assistant error message — without this, the settle
				// would claim success. An aborted compaction is not a task failure.
				if (!event.aborted && event.errorMessage) this.taskError = String(event.errorMessage);
				// Compaction's summarization call is model work; include it.
				if (event.result?.usage) this.addUsage(event.result.usage);
				break;

			case "extension_error":
				this.push("error", String(event.error ?? "extension error"));
				break;
		}
		this.touch();
	}

	/** Complete the current task: park in `waiting`, record the outcome, announce once. */
	private processSettled(): void {
		if (this.settleAnnounced) return;
		if (this.steerPending) this.pendingSettled = true;
		if (this.status === "running" || this.status === "starting") this.status = "waiting";
		this.openTools.clear();
		this.settleAnnounced = true;
		this.taskOutcome = this.taskAborted ? "aborted" : this.taskError ? "error" : "success";
		if (this.taskOutcome === "error") this.error = this.taskError;
		else if (this.taskOutcome === "success") this.error = undefined;
		// Synchronous on purpose: a queued callback could observe state that a
		// concurrently accepted steer already reset (armed BEFORE its ACK). The
		// callback must see exactly this task's completed state.
		this.onSettled(this);
	}

	private addUsage(usage: any): void {
		if (!usage) return;
		this.usage.input += usage.input || 0;
		this.usage.output += usage.output || 0;
		this.usage.cacheRead += usage.cacheRead || 0;
		this.usage.cacheWrite += usage.cacheWrite || 0;
		this.usage.cost += usage.cost?.total || 0;
		if (usage.totalTokens) this.usage.contextTokens = usage.totalTokens;
	}

	private send(command: Record<string, unknown>): boolean {
		const stdin = this.proc?.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable || stdin.writableEnded) return false;
		try {
			stdin.write(`${JSON.stringify(command)}\n`);
			return true;
		} catch {
			return false; // child is gone; close handler will finalize
		}
	}

	private request(
		type: string,
		extra: Record<string, unknown> = {},
		timeoutMs = this.timings.requestTimeoutMs,
	): Promise<any> {
		const id = `req-${this.nextReqId++}`;
		return new Promise((resolve) => {
			const entry = { resolve } as PendingRequest;
			entry.timer = setTimeout(() => {
				this.pending.delete(id);
				resolve(undefined);
			}, timeoutMs);
			this.pending.set(id, entry);
			if (!this.send({ id, type, ...extra })) {
				clearTimeout(entry.timer);
				this.pending.delete(id);
				resolve(undefined);
			}
		});
	}

	// ── teardown machinery ────────────────────────────────────────────────────

	/** Signal the exact tracked child object. No pid lookups, no sweeps, no pkill. */
	private signalChild(sig: NodeJS.Signals): void {
		const proc = this.proc;
		if (!proc || this.closed) return;
		try {
			proc.kill(sig);
		} catch {
			/* already dead; close handler finalizes */
		}
	}

	/**
	 * Graceful shutdown ladder, event-driven rather than fire-and-forget: send
	 * abort, WAIT for actual process close, then escalate SIGTERM, then SIGKILL.
	 * Closing at any step cancels the remaining escalation. The abort and SIGTERM
	 * steps are what let pi kill its own in-flight bash subprocesses.
	 */
	private terminate(kind: "kill" | "dispose"): Promise<void> {
		const proc = this.proc;
		if (!proc) {
			this.finalizeExit(null, null);
			return this.whenClosed;
		}
		if (!this.abortSent) {
			this.abortSent = true;
			this.send({ type: "abort" });
		}
		if (!this.escalateTimer && !this.closed) {
			const t = this.timings;
			const abortMs = kind === "kill" ? t.abortGraceMs : t.disposeAbortMs;
			const termMs = kind === "kill" ? t.termGraceMs : t.disposeTermMs;
			this.escalateTimer = setTimeout(() => {
				this.escalateTimer = null;
				this.signalChild("SIGTERM");
				this.escalateTimer = setTimeout(() => {
					this.escalateTimer = null;
					this.signalChild("SIGKILL");
				}, termMs);
			}, abortMs);
		}
		return this.whenClosed;
	}

	private clearEscalation(): void {
		if (this.escalateTimer) {
			clearTimeout(this.escalateTimer);
			this.escalateTimer = null;
		}
	}

	/** Resolve every in-flight request so no caller hangs on a dead child. */
	private clearPending(): void {
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.resolve(undefined);
		}
		this.pending.clear();
	}

	// ── public control surface ───────────────────────────────────────────────

	/**
	 * Redirect a running agent. Delivered as a steering prompt while it streams,
	 * a fresh prompt when idle. Resolves once the child ACCEPTS or REJECTS the
	 * message — a rejected steer reports ok:false instead of silently doing
	 * nothing. On acceptance the previous task's error/outcome are cleared (any
	 * completion that raced the acceptance is announced first, never swallowed).
	 */
	async steer(message: string): Promise<SteerResult> {
		if (this.isFinished()) return { ok: false, reason: `agent is ${this.status}` };
		if (!this.initialPromptAccepted) return { ok: false, reason: "agent is still starting" };
		if (this.killInitiated) return { ok: false, reason: "agent is being stopped" };
		if (this.steerPending) return { ok: false, reason: "another steer is still awaiting acceptance" };
		if (!this.proc?.stdin || this.proc.stdin.destroyed) return { ok: false, reason: "process is gone" };

		const wasRunning = this.status === "running";
		const snapshot = {
			status: this.status,
			taskOutcome: this.taskOutcome,
			error: this.error,
			settleAnnounced: this.settleAnnounced,
			taskError: this.taskError,
			taskAborted: this.taskAborted,
			openTools: new Map(this.openTools),
			armedAwaitingRun: this.armedAwaitingRun,
			armedSteerItem: this.armedSteerItem,
		};

		// Arm the new task BEFORE sending the request. The child's ACK and the
		// new task's events can arrive in the SAME stdout chunk — consume()
		// parses every line synchronously, so the await continuation runs only
		// after all of them, and (in the other order) a fast child can emit its
		// entire run before the ACK reaches this await. Either way those events
		// must land in the NEW task: completion announced, parked in waiting,
		// finalOutput scoped after the steer marker. Arming only after the ACK
		// swallowed all of that and left the runner stuck in `running`.
		this.steerPending = true;
		this.pendingSettled = false;
		this.armedAwaitingRun = true;
		this.settleAnnounced = false;
		this.taskOutcome = undefined;
		this.error = undefined;
		if (!wasRunning) {
			// Steering an idle agent: nothing else was running, so any prior
			// failure flags are stale history.
			this.taskError = undefined;
			this.taskAborted = false;
		}
		// Steering a running agent: its in-flight flags survive until its own
		// settle (possibly during our pending window) so the OLD task's outcome
		// is reported correctly; agent_start clears them for the new run.
		this.openTools.clear();
		this.status = "running";
		this.steerCount++;
		this.push("steer", message);
		const steerItem = this.transcript[this.transcript.length - 1];
		this.armedSteerItem = steerItem;
		this.touch();

		const attempt = (streaming: boolean) =>
			this.request("prompt", streaming ? { message, streamingBehavior: "steer" } : { message });
		let res = await attempt(wasRunning);
		// Our idea of "streaming" can race the child's. If the rejection is
		// about streaming state, retry once with the other variant.
		if (res && res.success === false && /stream/i.test(String(res.error ?? ""))) {
			res = await attempt(!wasRunning);
		}
		this.steerPending = false;

		if (this.closed || this.killInitiated) {
			// The close/kill path announced whatever was owed.
			return { ok: false, reason: "process exited" };
		}
		if (!res) {
			// Timeout: delivery is UNKNOWN — the child may be executing the
			// message without us ever seeing the ACK. Report the ambiguity and
			// fail closed rather than assume it was not delivered.
			this.fail(
				`steer acceptance unknown: no response within ${this.timings.requestTimeoutMs}ms — stopping the subagent`,
			);
			return { ok: false, reason: "acceptance unknown (timeout) — subagent stopped" };
		}
		if (res.success !== true) {
			// Explicit rejection: the child never accepted, so undo the arm —
			// except completion state that legitimately progressed meanwhile
			// (the previous task settling while we asked keeps its announcement).
			const idx = this.transcript.indexOf(steerItem);
			if (idx !== -1) {
				this.transcript.splice(idx, 1);
				this.transcriptRevision++;
			}
			this.steerCount--;
			// A previously accepted steer may still be awaiting ITS run — restore
			// the armed bookkeeping, not just this attempt's marker.
			this.armedAwaitingRun = snapshot.armedAwaitingRun;
			this.armedSteerItem = snapshot.armedSteerItem;
			if (!this.pendingSettled) {
				this.status = snapshot.status;
				this.taskOutcome = snapshot.taskOutcome;
				this.error = snapshot.error;
				this.settleAnnounced = snapshot.settleAnnounced;
				this.taskError = snapshot.taskError;
				this.taskAborted = snapshot.taskAborted;
				this.openTools = snapshot.openTools;
			}
			this.touch();
			return { ok: false, reason: String(res.error ?? "prompt rejected") };
		}

		// Accepted. The new task is already armed and any events that raced the
		// ACK (same chunk or earlier) were processed under it. Nothing is reset
		// after the ACK — by design.
		return { ok: true };
	}

	/**
	 * Abort politely, wait for the process to actually close, then escalate
	 * SIGTERM → SIGKILL. Resolves when the process has closed (never rejects).
	 * Status goes to `stopping` immediately, then `killed` when the process is
	 * really gone. Any outstanding completion is announced only after closure.
	 */
	kill(reason = "killed by user"): Promise<void> {
		if (this.closed) return this.whenClosed;
		if (!this.killInitiated) {
			this.killInitiated = true;
			this.status = "stopping";
			this.error = reason;
			this.push("system", reason);
			if (!this.settleAnnounced) {
				// The in-flight task is definitively aborted — record that now, but
				// DEFER the announcement to finalizeExit: onSettled fires only for a
				// finished task or a definitive failure, never while the runner is
				// merely stopping. The UI sees `stopping` via touch() anyway, and an
				// already-settled task never gets a second completion.
				this.taskOutcome = "aborted";
			}
			this.touch();
		}
		return this.terminate("kill");
	}

	/**
	 * Session-shutdown teardown: abort → SIGTERM → SIGKILL (faster ladder than
	 * kill). Resolves when the process has actually closed. Safe to call more
	 * than once; never rejects.
	 */
	dispose(): Promise<void> {
		if (this.closed) return this.whenClosed;
		if (!this.killInitiated) {
			this.killInitiated = true;
			if (this.status !== "error") this.status = "stopping";
			// Same deferred-announcement contract as kill().
			if (!this.settleAnnounced) this.taskOutcome = "aborted";
			this.touch();
		}
		return this.terminate("dispose");
	}

	/**
	 * Process has actually ended. Terminal status alone is NOT enough: a fatal
	 * error (or a kill) flips the status while the teardown ladder is still
	 * running and the process is still alive. Only closed processes count, so
	 * liveness checks and kills prove real closure.
	 */
	isFinished(): boolean {
		return !this.processAlive && (this.status === "done" || this.status === "error" || this.status === "killed");
	}

	/**
	 * The agent has nothing left to do right now. This — not isFinished() — is
	 * what callers should wait on: a healthy agent parks in `waiting` and keeps
	 * its process alive for steering. `stopping` and error-during-teardown are
	 * deliberately NOT settled: teardown is in flight and waits should prove
	 * actual closure. Check `taskOutcome` for how the task ended.
	 */
	isSettled(): boolean {
		return this.isFinished() || this.status === "waiting";
	}

	/**
	 * Latest assistant text from the CURRENT task only. An accepted steer starts
	 * a new task, so until it produces assistant output this returns "" rather
	 * than the previous task's stale answer.
	 */
	finalOutput(): string {
		for (let i = this.transcript.length - 1; i >= 0; i--) {
			const item = this.transcript[i];
			if (item.kind === "assistant") return item.text;
			if (item.kind === "steer" || item.kind === "task") break;
		}
		return "";
	}

	// ── transcript ───────────────────────────────────────────────────────────

	private push(kind: TranscriptKind, text: string, toolName?: string): void {
		const maxChars = this.limits.maxItemChars;
		if (text.length > maxChars) {
			text = `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars — full content in this agent's session file]`;
		}
		this.transcript.push({ ts: Date.now(), kind, text, toolName });
		this.lastActivity = Date.now();
		this.trimTranscript();
		// After trim, so in-place marker rewrites are covered by this bump too.
		this.transcriptRevision++;
	}

	/**
	 * Bound in-memory retention to a ~2 MiB tail, measured in UTF-8 bytes. The
	 * child's own session file is the canonical full record, so dropping the
	 * oldest items loses nothing permanent. A head marker item notes what was
	 * omitted so the modal (which renders this array directly) can show it.
	 */
	private trimTranscript(): void {
		const cap = this.limits.maxTranscriptBytes;
		const sizeOf = (t: TranscriptItem) => Buffer.byteLength(t.text, "utf8") + 48;
		let total = 0;
		for (const item of this.transcript) total += sizeOf(item);
		if (total <= cap) return;

		const head = this.transcript[0]?.kind === "task" ? 1 : 0; // never trim the task item
		const hasMarker = this.markerItem !== null && this.transcript.includes(this.markerItem);
		const fixed = head + (hasMarker ? 1 : 0);
		const target = Math.floor(cap * 0.75); // trim with hysteresis to amortize
		let dropped = 0;
		let droppedBytes = 0;
		while (this.transcript.length > fixed + 1 && total > target) {
			const item = this.transcript.splice(fixed, 1)[0];
			total -= sizeOf(item);
			dropped++;
			droppedBytes += sizeOf(item);
		}
		if (!dropped) return;
		this.transcriptOmitted.items += dropped;
		this.transcriptOmitted.approxBytes += droppedBytes;
		const text = `… ${this.transcriptOmitted.items} earlier transcript item(s) (~${Math.max(1, Math.round(this.transcriptOmitted.approxBytes / 1024))} KiB) trimmed — full history in this agent's session file …`;
		if (this.markerItem) {
			this.markerItem.text = text;
		} else {
			this.markerItem = { ts: Date.now(), kind: "system", text };
			this.transcript.splice(head, 0, this.markerItem);
		}
	}

	private touch(): void {
		this.lastActivity = Date.now();
		this.onChange();
	}
}

export function summarizeToolCall(name: string, args: Record<string, any>): string {
	const shorten = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};
	switch (name) {
		case "bash": {
			const command = String(args.command ?? "");
			return command.length > 120 ? `${command.slice(0, 120)}…` : command;
		}
		case "read":
		case "write":
		case "edit":
			return shorten(String(args.path ?? args.file_path ?? "?"));
		case "ls":
			return shorten(String(args.path ?? "."));
		case "grep":
			return `/${args.pattern ?? ""}/ in ${shorten(String(args.path ?? "."))}`;
		case "find":
			return `${args.pattern ?? "*"} in ${shorten(String(args.path ?? "."))}`;
		default: {
			const json = JSON.stringify(args ?? {});
			return json.length > 100 ? `${json.slice(0, 100)}…` : json;
		}
	}
}
