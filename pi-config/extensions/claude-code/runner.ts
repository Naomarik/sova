/** Owned persistent Claude Code stream-json adapter (probed with CLI 2.1.276 and 2.1.277).
 * Only one user UUID is in flight. Replay acknowledges delivery, result settles
 * work, and interrupt acknowledgment is NOT settlement. The only adoption is of
 * our own detached host's worker (options.adopt): its replayed user messages
 * re-create the in-flight task from the stream itself.
 */
import { randomUUID } from "node:crypto";
import { CLAUDE_PERMISSION_MODES, type ClaudePermissionMode } from "./policy.ts";
import {
	applyResultUsage, buildClaudeArgv, ClaudePrivateFiles, ClaudeTransport, contextTokensFrom, deferred,
	isMessageStart, isUncorrelatedResult, mcpServerFailure, parseCanUseTool, permissionDenialsFrom, record,
	resultError, resultMatches, textBlocksText, textDelta,
	type ClaudeToolPermissionRequest, type ControlAck, type Deferred,
} from "./transport.ts";
import type { AgentStatus, AgentUsage, TaskOutcome, TranscriptItem, TranscriptKind, SteerResult } from "../subagents/runner.ts";
import type { Worker, WorkerHandlers, SteerMode, SpawnOptions } from "../subagents/contracts.ts";

export interface ClaudePermissionRequest extends ClaudeToolPermissionRequest {
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
	/**
	 * Extra variables for Claude's own process, merged over the inherited
	 * environment. For settings the CLI reads only from its environment and not
	 * from a flag or the MCP config — `MCP_TOOL_TIMEOUT` bounds every MCP tool
	 * call, and a per-server `env` in mcp.json reaches the server, not Claude.
	 */
	env?: Record<string, string>;
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
	/** CLI process, framing, control channel and shutdown escalation. */
	private readonly transport: ClaudeTransport;
	/** Private 0700 directory for files Claude reads at startup (system prompt, mcp.json). */
	private readonly privateFiles = new ClaudePrivateFiles();
	private stopping = false;
	private initialized = false;
	/** The configured MCP servers were checked against an init event; every turn re-emits one. */
	private mcpChecked = false;
	private initialOwed = true;
	/** Protocol settlement and host-visible idle notification are distinct. */
	private notificationPending = true;
	/** A CLI-initiated turn's completion was announced; new idle output re-arms it. */
	private idleAnnounced = false;
	private active?: Task;
	private redirecting = false;
	private queue: string[] = [];
	private output = "";
	private partial?: TranscriptItem;
	private lastAssistant?: TranscriptItem;
	private transcriptBytes = 0;
	private permissions = new Map<string, { controller: AbortController; finish: (decision: ClaudePermissionDecision) => void }>();
	/** Adopt mode: tasks re-created from replayed user messages; the first is the initial task. */
	private adoptedTasks = 0;
	/** Adopt mode: replayed permission requests no earlier manager answered; prompted again once live. */
	private readonly replayedPermissions = new Map<string, Record<string, any>>();
	private answeredIds?: Set<string>;

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
		this.transport = new ClaudeTransport({
			timings: this.timings,
			limits: this.limits,
			spawnImpl: options.spawnImpl,
			signalGroupImpl: options.signalGroupImpl,
			hooks: {
				onEvent: (event) => this.event(event as Record<string, any>),
				onStderr: (text) => { this.push("error", text); },
				onProtocolError: (message) => this.fail(message),
				onStdinError: (message) => { if (!this.stopping) this.fail(message); },
				onProcessError: (message) => this.fail(message),
				onSpawned: (pid) => { this.processAlive = true; this.pid = pid; },
				onLeaderExit: () => { this.processAlive = false; this.cancelPermissions(); },
				onActivity: () => this.touch(),
				beforeEof: () => this.abortActiveWork(),
				onInterruptStart: () => { if (this.active) this.active.cancelled = true; this.cancelPermissions(); },
				onInterruptSettled: (ack) => this.afterInterrupt(ack),
				onClose: (code, signal) => this.close(code, signal),
			},
		});
		this.whenClosed = this.transport.whenClosed;
		if (options.adopt) this.sessionId = options.adopt.sessionId;
		// Defer callbacks until the owner has stored the constructed runner.
		queueMicrotask(() => (options.adopt ? this.adopt() : this.start()));
	}

	/** True while the transport delivers output an earlier manager already consumed. */
	private replaying(): boolean { return this.options.adopt?.replaying() === true; }
	/** An earlier manager sent a control_response for this request (adopt.sent is its stdin). */
	private answered(requestId: string): boolean {
		if (!this.answeredIds) {
			this.answeredIds = new Set();
			for (const line of this.options.adopt?.sent ?? []) {
				try {
					const frame = JSON.parse(line);
					if (frame?.type === "control_response" && typeof frame.response?.request_id === "string") this.answeredIds.add(frame.response.request_id);
				} catch { /* not a frame */ }
			}
		}
		return this.answeredIds.has(requestId);
	}

	/**
	 * Re-attach to a worker our detached host kept running. No argv, initialize
	 * or first message: the replayed stream rebuilds the task (see event()).
	 */
	private adopt(): void {
		if (this.stopping || this.closed) return;
		try {
			this.transport.attach({ cwd: this.options.cwd });
		} catch (error) { this.fail(`Adoption failed: ${String(error)}`); return; }
		this.initialized = true; this.initialOwed = false; this.notificationPending = false;
		this.status = "running";
		this.transport.child?.on("live", () => {
			// Claude still waits on requests the earlier manager never answered.
			const pending = [...this.replayedPermissions.values()];
			this.replayedPermissions.clear();
			for (const e of pending) this.permission(e);
			// Replay done: no task in flight means the worker is idle and steerable.
			if (this.closed || this.stopping || this.active || this.status !== "running") return;
			this.status = "waiting"; this.touch();
		});
	}

	private start(): void {
		if (this.stopping || this.closed) return;
		if (!this.validInput(this.task)) { this.fail("Initial task is empty or exceeds input limit"); return; }
		const o = this.options;
		if (o.forkSession || o.extensions?.length || o.allowNestedExtensions) {
			this.fail("Claude runner does not support Pi forks or nested extensions"); return;
		}
		const permissionMode = o.permissionMode ?? "bypassPermissions";
		const hostPermissions = permissionMode !== "bypassPermissions" && !!o.onPermission;
		const built = buildClaudeArgv({
			permissionMode, permissionModes: CLAUDE_PERMISSION_MODES, hostPermissions,
			model: o.model, effort: o.effort, tools: o.tools, allowedTools: o.allowedTools,
			mcpServers: o.mcpServers, env: o.env, maxBudgetUsd: o.maxBudgetUsd,
		});
		if (built.error !== undefined) { this.fail(built.error); return; }
		const args = built.args;
		try {
			args.push(...this.privateFiles.write({ tmpDir: o.tmpDir, systemPrompt: o.systemPrompt, mcpServers: built.mcpServers }));
		} catch (error) { this.fail((error as Error).message); return; }
		try {
			this.transport.launch(o.executable ?? "claude", args, { cwd: o.cwd, env: o.env });
		} catch (error) { this.fail(`Spawn failed: ${String(error)}`); return; }
		void this.initialize();
	}

	/** Transport state the worker's own guards read. */
	private get closed(): boolean { return this.transport.isClosed(); }
	private get leaderExited(): boolean { return this.transport.hasExited(); }

	private async initialize(): Promise<void> {
		const ok = await this.transport.control("initialize");
		if (this.stopping || this.closed || this.leaderExited) return;
		if (!ok) { this.fail("Claude initialize failed or timed out"); return; }
		this.privateFiles.releaseSystemPrompt();
		this.initialized = true;
		this.dispatch(this.task, "task");
	}
	private validInput(message: string): boolean { return !!message.trim() && message.length <= this.limits.maxInputChars; }
	/** adoptedId: the task was sent by an earlier manager and is only being re-created here (never re-sent). */
	private dispatch(message: string, kind: "task" | "steer", adoptedId?: string): Task {
		const task: Task = {
			id: adoptedId ?? randomUUID(), accepted: deferred<boolean>(), settled: deferred<boolean>(), cancelled: false,
			acceptTimer: setTimeout(() => {
				if (this.active === task) this.fail("User delivery unknown: no correlated replay/result before timeout");
			}, this.timings.requestTimeoutMs),
		};
		this.active = task; this.initialOwed = false; this.notificationPending = true; this.idleAnnounced = false;
		this.status = "running"; this.taskOutcome = undefined; this.error = undefined;
		this.permissionDenials = []; this.output = ""; this.partial = undefined; this.lastAssistant = undefined;
		this.push(kind, message);
		if (adoptedId) {
			clearTimeout(task.acceptTimer); task.accepted.resolve(true);
			return task;
		}
		if (!this.transport.sendUser(task.id, message)) {
			task.unsent = true; this.fail("Could not send user message");
		}
		return task;
	}
	private event(e: Record<string, any>): void {
		// Correlated by the transport; its private initialize account/capability
		// metadata is intentionally never read here.
		if (e.type === "control_response") return;
		if (e.type === "control_request") { this.permission(e); return; }
		if (e.type === "control_cancel_request") {
			this.replayedPermissions.delete(e.request_id);
			this.permissions.get(e.request_id)?.controller.abort(); return;
		}
		if (typeof e.session_id === "string") {
			if (this.sessionId && this.sessionId !== e.session_id) { this.fail("Claude session identity changed unexpectedly"); return; }
			this.sessionId = e.session_id;
		}
		if (e.type === "system" && e.subtype === "init") {
			if (typeof e.model === "string") this.model = e.model;
			if (!this.mcpChecked && !this.checkMcpServers(e)) return;
		}
		// Adopt mode: Claude echoes each user message it accepted (--replay-user-messages).
		// One this runner did not send is the earlier manager's task; take it over.
		if (this.options.adopt && !this.active && !this.stopping && e.type === "user" && e.isReplay === true && typeof e.uuid === "string") {
			this.dispatch(textBlocksText(e.message?.content), this.adoptedTasks++ ? "steer" : "task", e.uuid);
		}
		const task = this.active;
		if (task && e.type === "user" && e.isReplay === true && e.uuid === task.id) {
			clearTimeout(task.acceptTimer); task.accepted.resolve(true);
		}
		if (e.type === "result") {
			// A result with no task in flight completes a turn the CLI started by
			// itself (observed when it reaps a Bash command it backgrounded at its
			// own 120s timeout). That answer is newer than the settled task's.
			if (!task) { this.idleResult(e); return; }
			if (!resultMatches(e, task.id)) {
				// CLI 2.1.277 omits both fields on session-scoped failures (e.g. a
				// crashed worker's zeroed result). The task's fate is unknown, so stop
				// rather than wait forever. Stale/mismatched UUIDs and uncorrelated
				// successes never settle the active task.
				const uncorrelated = isUncorrelatedResult(e);
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
			applyResultUsage(this.usage, e);
			if (Array.isArray(e.permission_denials)) {
				this.permissionDenials = permissionDenialsFrom(e.permission_denials);
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
		// Text is never dropped for want of a task: a CLI-initiated turn owns the
		// idle session's answer too, and arms the next completion announcement.
		if (!task && (e.type === "assistant" || e.type === "stream_event")) this.idleAnnounced = false;
		if (isMessageStart(e)) {
			this.partial = undefined; this.output = "";
		}
		const delta = textDelta(e);
		if (delta !== undefined) {
			if (!this.partial) {
				const item = this.push("assistant", "");
				this.partial = this.transcript.includes(item) ? item : undefined;
			}
			this.output = this.clip(this.output + delta);
			if (this.partial) this.replaceText(this.partial, this.output);
		} else if (e.type === "assistant" && Array.isArray(e.message?.content)) {
			const text = textBlocksText(e.message.content);
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
			if (u) this.usage.contextTokens = contextTokensFrom(u);
			this.touch();
		} else if (e.type === "user" && !e.isReplay && Array.isArray(e.message?.content)) {
			for (const block of e.message.content) if (block.type === "tool_result") this.push(block.is_error ? "tool-result" : "system", typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? ""));
		}
	}
	/**
	 * Settlement-shaped bookkeeping for a CLI-initiated turn: only a genuinely
	 * uncorrelated success counts (stale/mismatched UUIDs belong to a task that
	 * already settled, and a failure never announces a completion). The parent
	 * hears it through the same notification a settled task uses, once per turn.
	 */
	private idleResult(e: Record<string, any>): void {
		// Never before the worker's own first task: that turn is not the CLI's.
		if (this.stopping || this.closed || this.leaderExited || this.initialOwed || this.idleAnnounced) return;
		const ids = Array.isArray(e.user_message_uuids) ? e.user_message_uuids : [];
		if (e.user_message_uuid !== undefined && e.user_message_uuid !== null) return;
		if (ids.length || e.is_error || e.subtype !== "success") return;
		if (typeof e.result === "string") {
			this.output = this.clip(e.result);
			if (this.partial) this.replaceText(this.partial, this.output);
			else if (this.lastAssistant?.text !== this.output || !this.transcript.includes(this.lastAssistant)) this.push("assistant", e.result);
		}
		this.partial = undefined;
		applyResultUsage(this.usage, e);
		this.taskOutcome = "success";
		// The earlier manager already announced whatever history replays.
		if (this.replaying()) return;
		this.status = "waiting";
		this.idleAnnounced = true;
		// Announce only after the new answer is stored: the manager reads finalOutput().
		this.notificationPending = true;
		this.touch();
		this.notifySettled();
	}
	private finishTask(task: Task, outcome: TaskOutcome, correlated: boolean): void {
		if (this.active !== task) return;
		clearTimeout(task.acceptTimer); this.active = undefined; this.partial = undefined;
		this.cancelPermissions(); this.replayedPermissions.clear(); this.taskOutcome = outcome;
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
		// A replayed request was answered by the earlier manager, or is still
		// pending in Claude: then it is prompted again once the replay is done.
		if (this.replaying()) {
			if (!this.answered(e.request_id)) this.replayedPermissions.set(e.request_id, e);
			return;
		}
		// The adopted worker already exited: its log is only being read back.
		if (this.options.adopt?.ended) return;
		const id = e.request_id;
		if (this.permissions.has(id)) return;
		const parsed = parseCanUseTool(e);
		if (!parsed) {
			this.transport.respondError(id, "Unsupported host control request"); return;
		}
		const input = parsed.input;
		const request: ClaudePermissionRequest = { ...parsed, workerId: this.id, workerName: this.name, cwd: this.cwd };
		const deny = (message: string): ClaudePermissionDecision => ({ behavior: "deny", message });
		const reply = (decision: ClaudePermissionDecision) => {
			if (this.leaderExited || this.closed) return;
			if (!this.transport.respond(id, decision) && !this.stopping) this.fail("Could not send permission decision");
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
	/** Transport hook: the single-flight interrupt settled (undefined = unanswered). */
	private afterInterrupt(ack: ControlAck): void {
		if (this.stopping || this.closed || this.leaderExited) return;
		// CLI 2.1.277 answers interrupts promptly, even when idle. Silence
		// through the whole control deadline leaves a delayed interrupt that
		// could abort later work, so stop rather than dispatch under it.
		if (ack === undefined) { this.fail("Claude never answered an interrupt request; stopped so a delayed interrupt cannot affect later work"); return; }
		queueMicrotask(() => this.drainQueue());
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
		if (this.transport.isInterruptPending() && !this.active) return { ok: false, reason: "an earlier interrupt is still unanswered; new instructions would race it" };
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
				const both = Promise.all([this.transport.interrupt(), previous.settled.promise]).then(([ack, settled]) => ack !== undefined && settled);
				const ok = await this.transport.bounded(both, this.timings.settlementTimeoutMs, false);
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
		const message = this.transport.isInterruptPending() ? undefined : this.queue.shift();
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
		// The earlier manager already announced history settles; never twice.
		if (!this.replaying()) this.handlers.onSettled(this);
	}
	kill(reason = "killed by user"): Promise<void> {
		if (this.closed || this.stopping) return this.whenClosed;
		this.error = reason; this.status = "stopping"; this.stopping = true;
		this.push("system", reason); this.dropQueue("because the worker was stopped");
		void this.transport.shutdown(); return this.whenClosed;
	}
	dispose(): Promise<void> { return this.kill("session shutdown"); }
	/**
	 * Checked once, on the first init event; a later turn's init repeats it (see
	 * mcpServerFailure). Returns false when the worker was failed.
	 */
	private checkMcpServers(event: any): boolean {
		const configured = Object.keys(this.options.mcpServers ?? {});
		if (!configured.length) return true;
		this.mcpChecked = true;
		const failure = mcpServerFailure(event, configured);
		if (!failure) return true;
		this.fail(failure);
		return false;
	}
	private fail(message: string): void {
		if (this.closed || this.stopping) return;
		this.error = this.clip(message); this.status = "error"; this.stopping = true;
		this.push("error", message); this.dropQueue("because the worker failed", "error");
		void this.transport.shutdown();
	}
	/** Transport hook before stdin EOF: first allow Claude to cancel its own tools. */
	private async abortActiveWork(): Promise<void> {
		const task = this.active;
		const interruption = this.transport.interrupt();
		await this.transport.bounded(Promise.all([interruption, task?.settled.promise ?? Promise.resolve(true)]), this.timings.abortGraceMs, [false, false]);
	}
	/** Transport hook: the process closed; its pipes and control channel are already done. */
	private close(code: number | null, signal: string | null): void {
		this.processAlive = false; this.exitCode = code; this.signal = signal;
		this.cancelPermissions(); this.privateFiles.cleanup();
		// Acknowledged work that never ran is not a clean exit, even with code 0.
		const undelivered = this.stopping ? 0 : this.dropQueue("because Claude exited before delivering them", "error");
		const redirectPending = this.redirecting && !this.stopping;
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
		this.endedAt = Date.now(); this.notifySettled(); this.touch(); this.handlers.onExit(this);
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
