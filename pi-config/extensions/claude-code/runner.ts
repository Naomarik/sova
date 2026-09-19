/** Owned persistent Claude Code stream-json adapter (probed with CLI 2.1.276 and 2.1.277).
 * Only one user UUID is in flight. Replay acknowledges delivery, result settles
 * work, and interrupt acknowledgment is NOT settlement. No external adoption.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { CLAUDE_PERMISSION_MODES, type ClaudePermissionMode } from "./policy.ts";
import type { AgentStatus, AgentUsage, TaskOutcome, TranscriptItem, TranscriptKind, SteerResult } from "../subagents/runner.ts";
import type { Worker, WorkerHandlers, SteerMode, SpawnOptions } from "../subagents/contracts.ts";

export interface ClaudePermissionRequest {
	requestId: string;
	toolName: string;
	input: Record<string, unknown>;
	toolUseId?: string;
	description?: string;
	/** Identity of the requesting worker; count>1 batches share one spec name. */
	workerId: string;
	workerName: string;
	cwd: string;
}
/** Maximum task/steer characters; validated before a batch starts, and again by the runner. */
export const MAX_CLAUDE_INPUT_CHARS = 256 * 1024;
export type ClaudePermissionDecision =
	| { behavior: "allow"; updatedInput?: Record<string, unknown> }
	| { behavior: "deny"; message: string };
export interface ClaudeRunnerTimings {
	requestTimeoutMs: number;
	permissionTimeoutMs: number;
	settlementTimeoutMs: number;
	abortGraceMs: number;
	eofGraceMs: number;
	termGraceMs: number;
	/** Drain inherited output after escalation AND proven leader exit. */
	pipeDrainMs: number;
}
export interface ClaudeRunnerLimits {
	maxLineBytes: number;
	maxTranscriptBytes: number;
	maxItemChars: number;
	maxQueue: number;
	maxInputChars: number;
	maxPendingPermissions: number;
}
export interface ClaudeSpawnOptions extends SpawnOptions {
	id: string;
	groupId: string;
	name: string;
	task: string;
	cwd: string;
	wake?: boolean;
	model?: string;
	effort?: string;
	tools?: string[];
	allowedTools?: string[];
	systemPrompt?: string;
	executable?: string;
	/** @internal Directory for the private system-prompt file. Default os.tmpdir(). */
	tmpDir?: string;
	/** Defaults to bypassPermissions; explicit restrictive modes are preserved. */
	permissionMode?: ClaudePermissionMode;
	onPermission?: (request: ClaudePermissionRequest, signal: AbortSignal) => Promise<ClaudePermissionDecision>;
	/** Host must bound displayed dialogs itself; queue time does not consume the runner deadline. */
	permissionTimeoutManagedByHost?: boolean;
	maxBudgetUsd?: number;
	spawnImpl?: SpawnOptions["spawnImpl"];
	/** @internal Signal the owned detached process group (test seam). */
	signalGroupImpl?: (pid: number, signal: NodeJS.Signals) => void;
	timings?: Partial<ClaudeRunnerTimings>;
	limits?: Partial<ClaudeRunnerLimits>;
}
export type ClaudeRunnerHandlers = WorkerHandlers;
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const isPlain = (value: unknown): value is string => typeof value === "string" && !!value.trim() && !/[\x00-\x1f\x7f]/.test(value);
/** mcp.json entries are written verbatim, so they must be plain strings only. */
function validMcpServers(entries: [string, unknown][]): entries is [string, { command: string; args: string[]; env?: Record<string, string> }][] {
	return entries.every(([name, spec]) => MCP_SERVER_NAME.test(name) && !!spec && typeof spec === "object"
		&& isPlain((spec as any).command) && Array.isArray((spec as any).args) && (spec as any).args.every((a: unknown) => typeof a === "string")
		&& ((spec as any).env === undefined || (!!(spec as any).env && typeof (spec as any).env === "object" && !Array.isArray((spec as any).env)
			&& Object.entries((spec as any).env).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === "string"))));
}
interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void }
function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}
/** false is a correlated rejection; undefined means no known response. */
type ControlAck = boolean | undefined;
interface Task {
	id: string;
	accepted: Deferred<boolean>;
	settled: Deferred<boolean>;
	acceptTimer: ReturnType<typeof setTimeout>;
	/** Interrupt intent gates permissions, but does not determine the outcome. */
	cancelled: boolean;
	/** The user message was never written to stdin. */
	unsent?: boolean;
}
const TIMINGS: ClaudeRunnerTimings = {
	requestTimeoutMs: 30000, permissionTimeoutMs: 60000, settlementTimeoutMs: 15000,
	abortGraceMs: 1500, eofGraceMs: 1500, termGraceMs: 2000, pipeDrainMs: 250,
};
const LIMITS: ClaudeRunnerLimits = {
	maxLineBytes: 4 * 1024 * 1024, maxTranscriptBytes: 2 * 1024 * 1024,
	maxItemChars: 256 * 1024, maxQueue: 16, maxInputChars: MAX_CLAUDE_INPUT_CHARS, maxPendingPermissions: 8,
};
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }
function record(value: unknown): value is Record<string, any> { return !!value && typeof value === "object" && !Array.isArray(value); }
// API failures can arrive as is_error with subtype "success" and the message only in result.
function resultError(e: Record<string, any>): string {
	const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
	const errors = Array.isArray(e.errors) ? e.errors.slice(0, 20).map(text).filter(Boolean) : [];
	if (errors.length) return errors.join("\n");
	if (text(e.result)) return text(e.result);
	if (text(e.terminal_reason)) return `Claude task ended: ${text(e.terminal_reason)}`;
	if (text(e.subtype) && e.subtype !== "success") return `Claude task failed: ${text(e.subtype)}`;
	return "Claude task failed";
}

export class ClaudeRunner implements Worker {
	readonly backend = "claude-code" as const;
	readonly id: string;
	readonly groupId: string;
	readonly name: string;
	readonly task: string;
	readonly cwd: string;
	readonly wake: boolean;
	readonly extensions: readonly string[] = [];
	readonly forked = false;
	readonly startedAt = Date.now();
	readonly whenClosed: Promise<void>;
	status: AgentStatus = "starting";
	taskOutcome?: TaskOutcome;
	/** Leader liveness; isFinished/whenClosed additionally wait for pipe cleanup. */
	processAlive = false;
	model?: string;
	effort?: string;
	sessionId?: string;
	sessionFile?: string;
	pid?: number;
	exitCode?: number | null;
	signal?: string | null;
	error?: string;
	endedAt?: number;
	lastActivity = Date.now();
	steerCount = 0;
	unreadCount = 0;
	transcript: TranscriptItem[] = [];
	transcriptRevision = 0;
	transcriptOmitted = { items: 0, approxBytes: 0 };
	usage: AgentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 };
	/** Current task's denied operations, separately from success/error settlement. */
	permissionDenials: { toolName: string; toolUseId?: string }[] = [];
	private readonly timings: ClaudeRunnerTimings;
	private readonly limits: ClaudeRunnerLimits;
	private readonly closedState = deferred<void>();
	private proc?: ChildProcess;
	private closed = false;
	private leaderExited = false;
	private shutdownStarted = false;
	private escalationComplete = false;
	private pipeDrainTimer?: ReturnType<typeof setTimeout>;
	private stopping = false;
	private initialized = false;
	private initialOwed = true;
	/** Protocol settlement and host-visible idle notification are distinct. */
	private notificationPending = true;
	private active?: Task;
	private redirecting = false;
	private queue: string[] = [];
	private buffer = "";
	private output = "";
	private partial?: TranscriptItem;
	private lastAssistant?: TranscriptItem;
	private transcriptBytes = 0;
	private decoder = new StringDecoder("utf8");
	private stderrDecoder = new StringDecoder("utf8");
	private controls = new Map<string, { resolve: (ok: ControlAck) => void; timer: ReturnType<typeof setTimeout> }>();
	private permissions = new Map<string, { controller: AbortController; finish: (decision: ClaudePermissionDecision) => void }>();
	private timers = new Set<ReturnType<typeof setTimeout>>();
	/** Pending while an interrupt is unanswered; no new turn is dispatched under it. */
	private interruptPromise?: Promise<ControlAck>;
	/** Private 0700 directory for files Claude reads at startup (system prompt, mcp.json). */
	private privateDir?: string;
	private systemPromptFile?: string;
	private mcpConfigFile?: string;

	private readonly options: ClaudeSpawnOptions;
	private readonly handlers: ClaudeRunnerHandlers;
	constructor(options: ClaudeSpawnOptions, handlers: ClaudeRunnerHandlers) {
		this.options = options; this.handlers = handlers;
		this.id = options.id; this.groupId = options.groupId; this.name = options.name;
		this.task = options.task; this.cwd = options.cwd; this.wake = options.wake ?? true;
		this.model = options.model; this.effort = options.effort;
		this.timings = { ...TIMINGS, ...options.timings };
		this.limits = { ...LIMITS, ...options.limits };
		for (const value of [...Object.values(this.timings), ...Object.values(this.limits)]) {
			if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Runner limits/timings must be positive integers");
		}
		this.whenClosed = this.closedState.promise;
		// Defer callbacks until the owner has stored the constructed runner.
		queueMicrotask(() => this.start());
	}

	private start(): void {
		if (this.stopping || this.closed) return;
		if (!this.validInput(this.task)) { this.fail("Initial task is empty or exceeds input limit"); return; }
		const o = this.options;
		if (o.forkSession || o.extensions?.length || o.allowNestedExtensions) {
			this.fail("Claude runner does not support Pi forks or nested extensions"); return;
		}
		if (o.allowedTools?.some((tool) => !tool.trim() || /^\s*-/.test(tool) || /[\x00-\x1f\x7f]/.test(tool))) {
			this.fail("Invalid allowedTools: flags and control characters are not allowed"); return;
		}
		const permissionMode = o.permissionMode ?? "bypassPermissions";
		if (!CLAUDE_PERMISSION_MODES.includes(permissionMode)) { this.fail("Unsupported permission mode"); return; }
		const hostPermissions = permissionMode !== "bypassPermissions" && !!o.onPermission;
		const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
			"--include-partial-messages", "--replay-user-messages", "--permission-mode", permissionMode,
			"--permission-prompts", hostPermissions ? "host" : "none", "--setting-sources", "", "--strict-mcp-config"];
		if (hostPermissions) args.push("--permission-prompt-tool", "stdio");
		if (o.model) args.push("--model", o.model);
		if (o.effort) args.push("--effort", o.effort);
		args.push("--tools", (o.tools ?? ["Bash", "Read", "Edit", "Write", "Glob", "Grep"]).join(","));
		const mcpServers = Object.entries(o.mcpServers ?? {});
		if (!validMcpServers(mcpServers)) { this.fail("Invalid mcpServers: names must be [A-Za-z0-9_-], commands/args/env plain strings"); return; }
		// Non-bypass modes would prompt (or, without a host, deny) every MCP tool
		// call; a server the parent configured is trusted like the built-ins.
		const allowedTools = [...(o.allowedTools ?? []), ...(permissionMode === "bypassPermissions" ? [] : mcpServers.map(([name]) => `mcp__${name}`))];
		if (allowedTools.length) args.push("--allowedTools", ...allowedTools);
		if (o.maxBudgetUsd !== undefined) {
			if (!Number.isFinite(o.maxBudgetUsd) || o.maxBudgetUsd <= 0) { this.fail("maxBudgetUsd must be positive"); return; }
			args.push("--max-budget-usd", String(o.maxBudgetUsd));
		}
		if (o.systemPrompt || mcpServers.length) {
			// Files keep instructions and server environments out of the process
			// list and avoid argv size limits (E2BIG). Probed with CLI 2.1.277: the
			// system prompt is read at startup, so it is removed once initialize
			// succeeds; the MCP config stays until the process closes.
			try {
				this.privateDir = fs.mkdtempSync(path.join(o.tmpDir ?? os.tmpdir(), "pi-claude-"));
				if (o.systemPrompt) {
					this.systemPromptFile = path.join(this.privateDir, "system.md");
					fs.writeFileSync(this.systemPromptFile, o.systemPrompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
					args.push("--append-system-prompt-file", this.systemPromptFile);
				}
				if (mcpServers.length) {
					this.mcpConfigFile = path.join(this.privateDir, "mcp.json");
					fs.writeFileSync(this.mcpConfigFile, JSON.stringify({ mcpServers: Object.fromEntries(mcpServers) }), { encoding: "utf8", mode: 0o600, flag: "wx" });
					args.push("--mcp-config", this.mcpConfigFile);
				}
			} catch (error) {
				// Never run without the instructions or tools the worker was configured with.
				const what = mcpServers.length ? "private launch" : "system prompt";
				this.cleanupPrivateDir();
				this.fail(`Could not write ${what} file: ${(error as Error).message}`); return;
			}
		}
		try {
			// Preserve configured CLI authentication/routing (including API keys), but
			// do not inherit Claude's nested-session markers from the host shell.
			const env = { ...process.env };
			delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
			const spawnOptions = { cwd: o.cwd, shell: false, detached: process.platform !== "win32", env, stdio: ["pipe", "pipe", "pipe"] };
			this.proc = (o.spawnImpl ?? spawn)(o.executable ?? "claude", args, spawnOptions);
		} catch (error) { this.fail(`Spawn failed: ${String(error)}`); return; }
		const proc = this.proc;
		this.processAlive = true; this.pid = proc.pid;
		proc.stdin?.on("error", (e) => { if (!this.stopping) this.fail(`stdin error: ${e.message}`); });
		proc.stdout?.on("data", (chunk: Buffer) => this.consume(this.decoder.write(chunk)));
		proc.stdout?.on("end", () => { this.consume(this.decoder.end()); if (this.buffer) this.consume("\n"); });
		proc.stderr?.on("data", (chunk: Buffer) => { if (!this.closed) this.push("error", this.stderrDecoder.write(chunk)); });
		proc.on("error", (e) => this.fail(`Process error: ${e.message}`));
		proc.once("exit", () => {
			this.leaderExited = true; this.processAlive = false;
			this.cancelPermissions();
			// exit proves leader death, not EOF: detached descendants can retain pipes.
			void this.shutdown();
			this.schedulePipeDrain(); this.touch();
		});
		proc.on("close", (code, signal) => this.close(code, signal));
		void this.initialize();
	}

	private async initialize(): Promise<void> {
		const ok = await this.control("initialize");
		if (this.stopping || this.closed || this.leaderExited) return;
		if (!ok) { this.fail("Claude initialize failed or timed out"); return; }
		this.cleanupSystemPrompt();
		this.initialized = true;
		this.dispatch(this.task, "task");
	}
	/** After initialize: the system prompt has been read; the MCP config (if any) must outlive startup. */
	private cleanupSystemPrompt(): void {
		if (this.systemPromptFile) {
			try { fs.rmSync(this.systemPromptFile, { force: true }); } catch { /* best effort */ }
			this.systemPromptFile = undefined;
		}
		if (!this.mcpConfigFile) this.cleanupPrivateDir();
	}
	private cleanupPrivateDir(): void {
		if (!this.privateDir) return;
		try { fs.rmSync(this.privateDir, { recursive: true, force: true }); } catch { /* best effort */ }
		this.privateDir = undefined; this.systemPromptFile = undefined; this.mcpConfigFile = undefined;
	}
	private validInput(message: string): boolean { return !!message.trim() && message.length <= this.limits.maxInputChars; }
	private dispatch(message: string, kind: "task" | "steer"): Task {
		const task: Task = {
			id: randomUUID(), accepted: deferred<boolean>(), settled: deferred<boolean>(), cancelled: false,
			acceptTimer: setTimeout(() => {
				if (this.active === task) this.fail("User delivery unknown: no correlated replay/result before timeout");
			}, this.timings.requestTimeoutMs),
		};
		this.active = task; this.initialOwed = false; this.notificationPending = true;
		this.status = "running"; this.taskOutcome = undefined; this.error = undefined;
		this.permissionDenials = []; this.output = ""; this.partial = undefined; this.lastAssistant = undefined;
		this.push(kind, message);
		if (!this.send({ type: "user", uuid: task.id, message: { role: "user", content: [{ type: "text", text: message }] } })) {
			task.unsent = true; this.fail("Could not send user message");
		}
		return task;
	}
	private send(value: unknown): boolean {
		const input = this.proc?.stdin;
		if (!input || input.destroyed || input.writableEnded || !input.writable || this.closed || this.leaderExited) return false;
		try {
			const line = JSON.stringify(value) + "\n";
			// Bound queued pipe writes too; write(false) means buffered, not rejected.
			if (input.writableLength + Buffer.byteLength(line) > this.limits.maxLineBytes) return false;
			input.write(line); return true;
		} catch { return false; }
	}
	private control(subtype: string): Promise<ControlAck> {
		const request_id = randomUUID();
		return new Promise((resolve) => {
			const timer = setTimeout(() => { this.controls.delete(request_id); resolve(undefined); }, this.timings.requestTimeoutMs);
			this.controls.set(request_id, { resolve, timer });
			if (!this.send({ type: "control_request", request_id, request: { subtype } })) {
				clearTimeout(timer); this.controls.delete(request_id); resolve(undefined);
			}
		});
	}
	private consume(text: string): void {
		if (this.closed) return;
		// Bound individual records, including newline-terminated oversized records.
		let start = 0;
		while (start < text.length) {
			const end = text.indexOf("\n", start);
			const piece = text.slice(start, end < 0 ? text.length : end);
			if (Buffer.byteLength(this.buffer) + Buffer.byteLength(piece) > this.limits.maxLineBytes) {
				this.buffer = ""; this.fail("Claude stream-json record exceeds limit"); return;
			}
			this.buffer += piece;
			if (end < 0) return;
			const line = this.buffer; this.buffer = ""; start = end + 1;
			if (!line.trim()) continue;
			let event: unknown;
			try { event = JSON.parse(line); } catch { this.fail("Malformed Claude stream-json record"); return; }
			if (record(event)) this.event(event);
		}
	}
	private event(e: Record<string, any>): void {
		if (e.type === "control_response") {
			const response = e.response;
			const pending = this.controls.get(response?.request_id);
			if (pending) {
				this.controls.delete(response.request_id); clearTimeout(pending.timer);
				// Intentionally discard private initialize account/capability metadata.
				pending.resolve(response.subtype === "success" ? true : response.subtype === "error" ? false : undefined);
			}
			return;
		}
		if (e.type === "control_request") { this.permission(e); return; }
		if (e.type === "control_cancel_request") {
			this.permissions.get(e.request_id)?.controller.abort(); return;
		}
		if (typeof e.session_id === "string") {
			if (this.sessionId && this.sessionId !== e.session_id) { this.fail("Claude session identity changed unexpectedly"); return; }
			this.sessionId = e.session_id;
		}
		if (e.type === "system" && e.subtype === "init" && typeof e.model === "string") this.model = e.model;
		const task = this.active;
		if (!task) return;
		if (e.type === "user" && e.isReplay === true && e.uuid === task.id) {
			clearTimeout(task.acceptTimer); task.accepted.resolve(true);
		}
		if (e.type === "result") {
			const ids = Array.isArray(e.user_message_uuids) ? e.user_message_uuids : [];
			if (e.user_message_uuid !== task.id && !ids.includes(task.id)) {
				// CLI 2.1.277 omits both fields on session-scoped failures (e.g. a
				// crashed worker's zeroed result). The task's fate is unknown, so stop
				// rather than wait forever. Stale/mismatched UUIDs and uncorrelated
				// successes never settle the active task.
				const uncorrelated = e.user_message_uuid === undefined && ids.length === 0;
				if (uncorrelated && (e.is_error || e.subtype !== "success")) {
					this.fail(`Claude session failed without task correlation: ${resultError(e)}`);
				}
				return;
			}
			clearTimeout(task.acceptTimer); task.accepted.resolve(true);
			if (typeof e.result === "string") {
				this.output = this.clip(e.result);
				if (this.partial) this.replaceText(this.partial, this.output);
				else if (this.lastAssistant?.text !== this.output || !this.transcript.includes(this.lastAssistant)) this.push("assistant", e.result);
			}
			this.updateUsage(e);
			if (Array.isArray(e.permission_denials)) {
				this.permissionDenials = e.permission_denials.slice(0, 100).map((d: any) => ({ toolName: String(d.tool_name ?? "tool").slice(0, 256), toolUseId: typeof d.tool_use_id === "string" ? d.tool_use_id.slice(0, 256) : undefined }));
				if (this.permissionDenials.length) this.push("system", `${this.permissionDenials.length} operation(s) denied by permissions`);
			}
			// Interrupt intent can race natural completion or an unrelated error.
			// Only the CLI's explicit terminal reason proves an aborted task
			// (observed: aborted_tools during a tool, aborted_streaming mid-generation).
			const outcome: TaskOutcome = this.status === "error" ? "error"
				: typeof e.terminal_reason === "string" && e.terminal_reason.startsWith("aborted") ? "aborted"
				: e.is_error || e.subtype !== "success" ? "error" : "success";
			if (outcome === "error" && !this.error) this.error = this.clip(resultError(e));
			this.finishTask(task, outcome, true);
			return;
		}
		if (this.stopping) return;
		if (e.parent_tool_use_id) return; // Nested agent output does not own the root task's answer.
		if (e.type === "stream_event" && e.event?.type === "message_start") {
			this.partial = undefined; this.output = "";
		}
		if (e.type === "stream_event" && e.event?.type === "content_block_delta" && e.event.delta?.type === "text_delta") {
			const delta = String(e.event.delta.text ?? "");
			if (!this.partial) {
				const item = this.push("assistant", "");
				this.partial = this.transcript.includes(item) ? item : undefined;
			}
			this.output = this.clip(this.output + delta);
			if (this.partial) this.replaceText(this.partial, this.output);
		} else if (e.type === "assistant" && Array.isArray(e.message?.content)) {
			const text = e.message.content.filter((b: any) => b.type === "text").map((b: any) => String(b.text ?? "")).join("");
			if (text) {
				this.output = this.clip(text);
				if (this.partial) {
					this.replaceText(this.partial, this.output); this.lastAssistant = this.partial;
				} else this.lastAssistant = this.push("assistant", text);
				this.unreadCount++;
			}
			this.partial = undefined;
			for (const block of e.message.content) {
				if (block.type === "tool_use") this.push("tool", JSON.stringify(block.input ?? {}), String(block.name));
				if (block.type === "thinking") this.push("thinking", String(block.thinking ?? ""));
			}
			const u = e.message.usage;
			if (u) this.usage.contextTokens = number(u.input_tokens) + number(u.cache_read_input_tokens) + number(u.cache_creation_input_tokens) + number(u.output_tokens);
			this.touch();
		} else if (e.type === "user" && !e.isReplay && Array.isArray(e.message?.content)) {
			for (const block of e.message.content) if (block.type === "tool_result") this.push(block.is_error ? "tool-result" : "system", typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? ""));
		}
	}
	private updateUsage(e: Record<string, any>): void {
		// modelUsage and total_cost_usd are process-cumulative; never sum results.
		if (record(e.modelUsage)) {
			const values = Object.values(e.modelUsage).filter(record);
			this.usage.input = values.reduce((n, u) => n + number(u.inputTokens), 0);
			this.usage.output = values.reduce((n, u) => n + number(u.outputTokens), 0);
			this.usage.cacheRead = values.reduce((n, u) => n + number(u.cacheReadInputTokens), 0);
			this.usage.cacheWrite = values.reduce((n, u) => n + number(u.cacheCreationInputTokens), 0);
		} else if (record(e.usage)) {
			this.usage.input += number(e.usage.input_tokens); this.usage.output += number(e.usage.output_tokens);
			this.usage.cacheRead += number(e.usage.cache_read_input_tokens); this.usage.cacheWrite += number(e.usage.cache_creation_input_tokens);
		}
		this.usage.cost = Math.max(this.usage.cost, number(e.total_cost_usd));
		this.usage.turns += number(e.num_turns);
	}
	private finishTask(task: Task, outcome: TaskOutcome, correlated: boolean): void {
		if (this.active !== task) return;
		clearTimeout(task.acceptTimer); this.active = undefined; this.partial = undefined;
		this.cancelPermissions(); this.taskOutcome = outcome;
		// The abort our own redirect requested is not a failure of the queued
		// chain: the replacement runs next and acknowledged follow-ups follow it.
		const redirected = outcome === "aborted" && task.cancelled && this.redirecting && !this.stopping;
		if (redirected) this.push("system", "Task aborted by redirect");
		else if (outcome !== "success") {
			this.push(outcome === "error" ? "error" : "system", `Task ${outcome}${this.error ? `: ${this.error}` : ""}`);
			// Automatic continuation must not erase a failed predecessor. Explicit
			// steering can recover later; retain the failure in the transcript too.
			this.dropQueue(`after task ${outcome}`);
		}
		if (!this.stopping && !this.closed) this.status = "waiting";
		task.accepted.resolve(correlated); task.settled.resolve(correlated);
		this.touch();
		// Never wake the parent between queued tasks, during redirect, or while
		// shutdown still owns a live process. The task promise above still lets
		// interrupt wait for the precise protocol boundary.
		this.notifySettled();
		queueMicrotask(() => this.drainQueue());
	}

	private permission(e: Record<string, any>): void {
		if (typeof e.request_id !== "string") return;
		const id = e.request_id;
		if (this.permissions.has(id)) return;
		if (e.request?.subtype !== "can_use_tool") {
			this.send({ type: "control_response", response: { subtype: "error", request_id: id, error: "Unsupported host control request" } }); return;
		}
		const input = record(e.request.input) ? e.request.input : {};
		const request: ClaudePermissionRequest = { requestId: id, toolName: String(e.request.tool_name ?? "tool"), input,
			toolUseId: e.request.tool_use_id, description: e.request.description,
			workerId: this.id, workerName: this.name, cwd: this.cwd };
		const deny = (message: string): ClaudePermissionDecision => ({ behavior: "deny", message });
		const reply = (decision: ClaudePermissionDecision) => {
			if (this.leaderExited || this.closed) return;
			if (!this.send({ type: "control_response", response: { subtype: "success", request_id: id, response: decision } }) && !this.stopping) this.fail("Could not send permission decision");
		};
		if (this.stopping || this.leaderExited || !this.active || this.active.cancelled || !this.options.onPermission || this.permissions.size >= this.limits.maxPendingPermissions) {
			reply(deny("Host permission unavailable or task interrupted")); return;
		}
		const controller = new AbortController();
		const timer = this.options.permissionTimeoutManagedByHost
			? undefined : setTimeout(() => controller.abort(), this.timings.permissionTimeoutMs);
		let finished = false;
		const finish = (decision: ClaudePermissionDecision) => {
			if (finished) return; finished = true;
			if (timer !== undefined) clearTimeout(timer);
			this.permissions.delete(id);
			controller.signal.removeEventListener("abort", abort);
			const safe = decision?.behavior === "allow" && !controller.signal.aborted && !this.stopping && !this.leaderExited && !this.active?.cancelled
				? { behavior: "allow" as const, updatedInput: record(decision.updatedInput) ? decision.updatedInput : input }
				: deny(decision?.behavior === "deny" ? this.clip(String(decision.message)) : "Permission denied or cancelled");
			reply(safe); controller.abort();
			this.push("system", `Permission ${safe.behavior === "allow" ? "allowed" : "denied"}: ${request.toolName}`);
		};
		const abort = () => finish(deny("Permission request cancelled or timed out"));
		controller.signal.addEventListener("abort", abort, { once: true });
		this.permissions.set(id, { controller, finish });
		this.push("system", `Permission pending: ${request.toolName}`);
		Promise.resolve().then(() => {
			if (controller.signal.aborted) return deny("Permission cancelled");
			return this.options.onPermission!(request, controller.signal);
		}).then(finish, () => finish(deny("Host permission handler failed")));
	}
	private cancelPermissions(): void {
		for (const entry of [...this.permissions.values()]) entry.controller.abort();
	}
	private interrupt(): Promise<ControlAck> {
		if (this.interruptPromise) return this.interruptPromise;
		if (this.active) this.active.cancelled = true;
		this.cancelPermissions();
		const pending = this.control("interrupt");
		this.interruptPromise = pending;
		void pending.then((ack) => {
			if (this.interruptPromise !== pending) return;
			this.interruptPromise = undefined;
			if (this.stopping || this.closed || this.leaderExited) return;
			// CLI 2.1.277 answers interrupts promptly, even when idle. Silence
			// through the whole control deadline leaves a delayed interrupt that
			// could abort later work, so stop rather than dispatch under it.
			if (ack === undefined) { this.fail("Claude never answered an interrupt request; stopped so a delayed interrupt cannot affect later work"); return; }
			queueMicrotask(() => this.drainQueue());
		});
		return pending;
	}
	private async bounded<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
		let timer!: ReturnType<typeof setTimeout>;
		const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); this.timers.add(timer); });
		try { return await Promise.race([promise, timeout, this.whenClosed.then(() => fallback)]); }
		finally { clearTimeout(timer); this.timers.delete(timer); }
	}

	/** Redirect never writes mid-turn user input. followUp only acknowledges the HOST queue. */
	async steer(message: string, signal?: AbortSignal, mode: SteerMode = "redirect"): Promise<SteerResult> {
		if (signal?.aborted) return { ok: false, reason: "cancelled" };
		if (!this.validInput(message)) return { ok: false, reason: "message is empty or exceeds input limit" };
		if (!this.initialized || this.status === "starting") return { ok: false, reason: "agent is still starting" };
		if (this.stopping || this.closed || this.leaderExited) return { ok: false, reason: "agent is stopping or closed" };
		if (mode === "followUp") {
			if (this.queue.length >= this.limits.maxQueue) return { ok: false, reason: "follow-up queue is full" };
			const before = this.queue.length;
			this.queue.push(message); this.steerCount++;
			const task = this.drainQueue(); // An idle worker dispatches it immediately.
			// ok means held by the host or written to Claude, not executed. If the
			// immediate dispatch stopped the worker, the queue (and it) was dropped.
			if (this.stopping || this.closed || this.leaderExited) {
				const why = this.error ?? "agent stopped";
				return { ok: false, reason: task && !task.unsent ? `agent stopped during follow-up delivery; delivery unknown: ${why}` : `follow-up not delivered: ${why}` };
			}
			if (this.queue.length > before) this.push("system", "Follow-up queued in host (not yet delivered)");
			return { ok: true };
		}
		if (this.redirecting) return { ok: false, reason: "another redirect is pending" };
		if (this.interruptPromise && !this.active) return { ok: false, reason: "an earlier interrupt is still unanswered; new instructions would race it" };
		this.redirecting = true;
		// The caller owns only its wait, not this persistent worker. Once started,
		// the redirect transaction retains its barrier and protocol deadlines even
		// if the caller leaves; do not inject another turn under a pending interrupt.
		const cancelled = deferred<SteerResult>();
		const abort = () => cancelled.resolve({ ok: false, reason: "cancelled; delivery unknown (redirect continues in background)" });
		signal?.addEventListener("abort", abort, { once: true });
		try {
			return await Promise.race([this.redirect(message), cancelled.promise]);
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}
	private async redirect(message: string): Promise<SteerResult> {
		try {
			const previous = this.active;
			if (previous) {
				// A negative ack may mean the old turn completed naturally. Its
				// correlated result is authoritative, but still require a response:
				// a missing ack could leave an interrupt racing the replacement.
				const both = Promise.all([this.interrupt(), previous.settled.promise]).then(([ack, settled]) => ack !== undefined && settled);
				const ok = await this.bounded(both, this.timings.settlementTimeoutMs, false);
				if (!ok && this.active === previous) {
					// The task itself never settled: its state is unknown. Fail closed.
					if (!this.stopping) this.fail("Interrupt did not acknowledge and settle; redirect not delivered");
					return { ok: false, reason: "interrupt settlement failed" };
				}
				if (!ok && !this.stopping && !this.closed && !this.leaderExited) {
					// The previous task settled, so the worker is idle and intact. Only
					// the interrupt response is missing: reject this redirect rather
					// than stop the worker. The pending interrupt keeps blocking new
					// turns until it is answered; silence through its deadline stops
					// the worker (see interrupt()).
					this.push("system", "Redirect not delivered: previous task settled but its interrupt was not acknowledged");
					return { ok: false, reason: "previous task settled but the interrupt was not acknowledged; redirect not delivered and the worker kept idle" };
				}
			}
			if (this.stopping || this.closed || this.leaderExited) return { ok: false, reason: "agent stopped" };
			this.steerCount++;
			const next = this.dispatch(message, "steer");
			const accepted = await next.accepted.promise;
			return accepted && !this.stopping ? { ok: true } : { ok: false, reason: "delivery unknown or process stopped" };
		} finally {
			this.redirecting = false; this.drainQueue();
		}
	}
	followUp(message: string, signal?: AbortSignal): Promise<SteerResult> { return this.steer(message, signal, "followUp"); }
	private drainQueue(): Task | undefined {
		if (this.active || this.redirecting || this.stopping || this.closed || this.leaderExited || !this.initialized) return;
		// Queued work waits out an unanswered interrupt; interrupt() drains afterward.
		const message = this.interruptPromise ? undefined : this.queue.shift();
		const task = message !== undefined ? this.dispatch(message, "steer") : undefined;
		this.notifySettled();
		return task;
	}
	private dropQueue(why: string, kind: TranscriptKind = "system"): number {
		const dropped = this.queue.length;
		this.queue = [];
		if (dropped) this.push(kind, `Dropped ${dropped} queued follow-up(s) ${why}`);
		return dropped;
	}
	private notifySettled(): void {
		if (!this.notificationPending || !this.isSettled()) return;
		this.notificationPending = false;
		this.handlers.onSettled(this);
	}
	kill(reason = "killed by user"): Promise<void> {
		if (this.closed || this.stopping) return this.whenClosed;
		this.error = reason; this.status = "stopping"; this.stopping = true;
		this.push("system", reason); this.dropQueue("because the worker was stopped");
		void this.shutdown(); return this.whenClosed;
	}
	dispose(): Promise<void> { return this.kill("session shutdown"); }
	private fail(message: string): void {
		if (this.closed || this.stopping) return;
		this.error = this.clip(message); this.status = "error"; this.stopping = true;
		this.push("error", message); this.dropQueue("because the worker failed", "error");
		void this.shutdown();
	}
	private async shutdown(): Promise<void> {
		if (this.shutdownStarted || this.closed) return;
		this.shutdownStarted = true;
		if (!this.proc) { this.close(null, null); return; }
		if (!this.leaderExited) {
			const task = this.active;
			const interruption = this.interrupt(); // First allow Claude to cancel its own tools.
			await this.bounded(Promise.all([interruption, task?.settled.promise ?? Promise.resolve(true)]), this.timings.abortGraceMs, [false, false]);
		}
		if (this.closed) return;
		try { this.proc.stdin?.end(); } catch { /* proceed with escalation */ }
		await this.bounded(this.whenClosed.then(() => true), this.timings.eofGraceMs, false);
		if (this.closed) return;
		this.signalChild("SIGTERM");
		await this.bounded(this.whenClosed.then(() => true), this.timings.termGraceMs, false);
		if (!this.closed) {
			this.signalChild("SIGKILL");
			this.escalationComplete = true;
			this.schedulePipeDrain();
		}
	}
	private schedulePipeDrain(): void {
		// A deadline never proves death. If SIGKILL fails or the leader is stuck,
		// keep whenClosed pending until exit/close actually arrives.
		if (this.closed || !this.leaderExited || !this.escalationComplete || this.pipeDrainTimer) return;
		this.pipeDrainTimer = setTimeout(() => {
			this.pipeDrainTimer = undefined;
			if (this.closed) return;
			this.consume(this.decoder.end()); if (this.buffer) this.consume("\n");
			this.proc?.stdin?.destroy(); this.proc?.stdout?.destroy(); this.proc?.stderr?.destroy();
		}, this.timings.pipeDrainMs);
	}
	private signalChild(signal: NodeJS.Signals): void {
		try {
			// Claude first gets interrupt + EOF so it can reap tools itself. The
			// fallback owns the complete foreground group, including grandchildren
			// retaining stdout after the CLI leader exits. Detached services that
			// create their own process group remain outside this guarantee.
			if (process.platform !== "win32" && this.pid) {
				(this.options.signalGroupImpl ?? ((pid, sig) => process.kill(-pid, sig)))(this.pid, signal);
			} else this.proc?.kill(signal);
		} catch { /* group/process may already be gone */ }
	}
	private close(code: number | null, signal: string | null): void {
		if (this.closed) return;
		this.closed = true; this.processAlive = false; this.exitCode = code; this.signal = signal;
		clearTimeout(this.pipeDrainTimer); this.pipeDrainTimer = undefined;
		this.cancelPermissions(); this.buffer = ""; this.cleanupPrivateDir();
		// Acknowledged work that never ran is not a clean exit, even with code 0.
		const undelivered = this.stopping ? 0 : this.dropQueue("because Claude exited before delivering them", "error");
		const redirectPending = this.redirecting && !this.stopping;
		for (const entry of this.controls.values()) { clearTimeout(entry.timer); entry.resolve(undefined); }
		this.controls.clear();
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
		const unexpectedActive = !!this.active || this.initialOwed || redirectPending || undelivered > 0;
		if (this.status !== "error") {
			this.status = this.stopping ? "killed" : code === 0 && !unexpectedActive ? "done" : "error";
			if (this.status === "error") {
				this.error = undelivered || redirectPending
					? `Claude exited (${signal ?? code ?? "unknown"}) before delivering ${undelivered ? `${undelivered} queued follow-up(s)` : "a pending redirect"}`
					: `Claude exited before expected closure (${signal ?? code ?? "unknown"})`;
			}
		}
		if (this.active) this.finishTask(this.active, this.stopping && this.status !== "error" ? "aborted" : "error", false);
		else if (this.initialOwed) {
			this.initialOwed = false; this.taskOutcome = this.stopping && this.status !== "error" ? "aborted" : "error";
			}
		this.endedAt = Date.now(); this.notifySettled(); this.touch(); this.handlers.onExit(this); this.closedState.resolve();
	}
	isFinished(): boolean { return this.closed; }
	/** Teardown in flight or process exited, not yet closed; see Worker.isStopping. */
	isStopping(): boolean { return !this.closed && (this.stopping || this.leaderExited); }
	isSettled(): boolean { return this.closed || (!this.stopping && !this.leaderExited && !this.active && !this.redirecting && !this.queue.length && this.status === "waiting"); }
	finalOutput(): string { return this.output; }
	private clip(text: string): string {
		const cap = this.limits.maxItemChars;
		return text.length <= cap ? text : (text.slice(0, Math.max(0, cap - 14)) + "… [truncated]").slice(0, cap);
	}
	private size(item: TranscriptItem): number { return Buffer.byteLength(item.text) + Buffer.byteLength(item.toolName ?? "") + 48; }
	private push(kind: TranscriptKind, text: string, toolName?: string): TranscriptItem {
		const item: TranscriptItem = { ts: Date.now(), kind, text: this.clip(text), toolName: toolName?.slice(0, 256) };
		this.transcript.push(item); this.transcriptBytes += this.size(item); this.trim(); this.transcriptRevision++; this.touch(); return item;
	}
	private replaceText(item: TranscriptItem, text: string): void {
		if (!this.transcript.includes(item)) return;
		this.transcriptBytes -= this.size(item); item.text = this.clip(text); this.transcriptBytes += this.size(item);
		this.trim(); this.transcriptRevision++; this.touch();
	}
	private trim(): void {
		while (this.transcriptBytes > this.limits.maxTranscriptBytes && this.transcript.length) {
			const item = this.transcript.shift()!; const bytes = this.size(item);
			this.transcriptBytes -= bytes; this.transcriptOmitted.items++; this.transcriptOmitted.approxBytes += bytes;
			if (this.partial === item) this.partial = undefined;
		}
	}
	private touch(): void { this.lastActivity = Date.now(); this.handlers.onChange(); }
}
