/** Owned persistent Claude Code stream-json adapter (probed with CLI 2.1.276 and 2.1.277).
 * Only one user UUID is in flight. Replay acknowledges delivery, result settles
 * work, and interrupt acknowledgment is NOT settlement. The only adoption is of
 * our own detached host's worker (options.adopt): its replayed user messages
 * re-create the in-flight task from the stream itself.
 */
import { randomUUID } from "node:crypto";
import { CLAUDE_PERMISSION_MODES, type ClaudePermissionMode } from "./policy.ts";
import {
	applyResultUsage, buildClaudeArgv, claudeEnv, ClaudeFailureDetector, ClaudePrivateFiles, ClaudeTransport, contextTokensFrom, deferred,
	isMessageStart, isUncorrelatedResult, mcpServerFailure, parseCanUseTool, permissionDenialsFrom, record,
	resultError, resultMatches, textBlocksText, textDelta,
	type ClaudeToolPermissionRequest, type ControlAck, type Deferred,
} from "./transport.ts";
import { freshAccessToken, refreshLogin, switchText, type RefreshImpl, type ClaudeAccountFailure, type ClaudeLoginChoice, type LoginUser } from "./accounts.ts";
import { ACCOUNTS_MODULE, CONFINED_DROP_ENV, CONFINED_SETTINGS, TOKEN_FD, claudeNeeds, confinedSourceEnv, confinedVersionProbe, launchModule, loginDirOf, type ClaudeConfine } from "./confined-launch.ts";
import type { AgentStatus, AgentUsage, TaskOutcome, TranscriptItem, TranscriptKind, SteerResult } from "../subagents/runner.ts";
import type { Worker, WorkerHandlers, SteerMode, SpawnOptions } from "../subagents/contracts.ts";
import { usageParentFromEnv } from "../llm-inflight/attribution.ts";
import { createClaudeRequestObserver, type ClaudeRequestObserver } from "../llm-inflight/claude.ts";

/**
 * Lower a launched worker to the niceness its hosting server asks for (Sova: §app.load-priority/workers,
 * installed as `Symbol.for("sova:lower-worker")`). No host (the TUI): nothing changes. Never throws.
 */
function lowerUnderHost(pid: number | undefined): void {
	const lower = (globalThis as Record<symbol, unknown>)[Symbol.for("sova:lower-worker")];
	if (typeof lower !== "function" || pid === undefined) return;
	try { lower(pid); } catch { /* the worker keeps its priority */ }
}

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
	/** `--settings` JSON object; buildClaudeArgv merges NO_ATTRIBUTION over it. */
	settingsJson?: string;
	spawnImpl?: SpawnOptions["spawnImpl"];
	/** @internal Signal the owned detached process group (test seam). */
	signalGroupImpl?: (pid: number, signal: NodeJS.Signals) => void;
	timings?: Partial<ClaudeRunnerTimings>;
	limits?: Partial<ClaudeRunnerLimits>;
	/** The login this worker starts on; its `env` is already merged into `env`. */
	login?: ClaudeLoginChoice;
	/**
	 * The host's logins (accounts.ts ClaudeLogins): on a usage limit or a failed sign-in the worker
	 * moves to the next one with `--resume`. Absent: a failure ends the task, as before.
	 */
	logins?: ClaudeWorkerLogins;
	/**
	 * How a failover's replacement process is spawned. Undefined = a plain local spawn: a worker
	 * that ran under a detached host continues without one (the host's files belong to its first process).
	 */
	respawnImpl?: SpawnOptions["spawnImpl"];
	/**
	 * Run every process of this worker inside the sandbox (confined-launch.ts): its start, a resume, a
	 * move to another login and a failover alike, since all of them go through launch(). Claude's own
	 * sandbox is then off, its login's access token is read again at each launch and handed over on an
	 * fd, and its private launch files live in its sandbox tmp. With `hostedTmpDir`, the first process's
	 * spawnImpl is a hosting process that confines the launch itself.
	 */
	confine?: ClaudeConfine;
	/** @internal How a confined launch refreshes its login (default accounts.ts refreshLogin with `executable`). */
	refreshImpl?: RefreshImpl;
	/**
	 * Gate the first confined launch on a confined `<executable> --version` (confinedVersionProbe). Default:
	 * on macOS only (Seatbelt); Linux's backend is probed by the sandbox itself.
	 */
	launchProbe?: boolean;
}
/** What a hosting process gets to confine a launch itself (host.ts); plain data, no secret. */
export interface ClaudeHostedConfine {
	module: string;
	scope: string;
	needs: ReturnType<typeof claudeNeeds>;
	/** The token the host reads itself (accounts.ts freshAccessToken of `dir`) and hands over on `fd`. */
	token: { module: string; dir: string; fd: number; force: boolean };
	/** The host's own environment minus these is the launch's source environment (confinedSourceEnv). */
	dropEnv: string[];
}
/** What a worker needs of the host's logins; accounts.ts ClaudeLogins is the real one. */
export interface ClaudeWorkerLogins {
	failover(from: ClaudeLoginChoice, failure: ClaudeAccountFailure): ClaudeLoginChoice | undefined;
	forcedFailure?(id: string): ClaudeAccountFailure | undefined;
	/** The pool (accounts.ts): the failed login goes back, and the next one may be borrowed. */
	failoverAsync?(from: ClaudeLoginChoice, failure: ClaudeAccountFailure): Promise<ClaudeLoginChoice | undefined>;
	/** The login a worker moves to when its own leaves this device (borrowing if need be). */
	acquire?(current?: string): Promise<ClaudeLoginChoice>;
	/** Record the worker's use of its login (the lease), and how to move it off when the login leaves. */
	track?(id: string, user: LoginUser): { done(): void; active(): void };
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
	/** The message, for sending again after a login switch. */
	message: string;
	kind: "task" | "steer";
	/** The worker used a tool during this task: a switch says the message was interrupted. */
	progressed?: boolean;
	/** A pool failover is choosing the next login (async): later failure signals wait for it. */
	failoverPending?: boolean;
	/** The pool found no login: the failure ends the task as before. */
	noFailover?: boolean;
	/** The failed result swallowed while the choice was pending, to settle the task after all. */
	heldResult?: Record<string, any>;
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
	/** modelUsage/total_cost_usd are cumulative over the Claude session, --resume history included. */
	readonly usageScope = "session" as const;
	/** Its first spawn: now, or for a resume the original start it carries. */
	readonly startedAt: number;
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
	/** CLI process, framing, control channel and shutdown escalation; replaced on a login switch. */
	private transport: ClaudeTransport;
	private readonly closedState = deferred<void>();
	/** The login the current process runs on. */
	login?: ClaudeLoginChoice;
	private readonly detector = new ClaudeFailureDetector();
	/** Between stopping a failed login's process and starting its replacement. */
	private switching = false;
	/** Processes this worker has started for login switches. */
	private respawns = 0;
	/** The current process's lease on its login (accounts.ts LoginUsers). */
	private lease?: { done(): void; active(): void };
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
	/** A resume that dies before initialize reports the CLI's own reason (e.g. no such conversation). */
	private lastStderr?: string;
	/** The current transport's process is started by the hosting process (a confined launch is then the host's). */
	private viaHost = false;
	/** The current transport's call counter (llm-inflight/claude.ts). */
	private requestObserver?: ClaudeRequestObserver;
	/** Confined: a launch of this worker used the sandbox's default tmp (released when the worker closes). */
	private defaultTmp = false;
	/** Confined: the transcript already says how the worker is confined. */
	private confinedNoted = false;
	/** Confined: the next launch refreshes its login's token first (after a 401). */
	private refreshNext = false;
	/** Confined: the login whose token a 401 already refreshed once; a second 401 on it fails over. */
	private authRefreshed?: string;

	private readonly options: ClaudeSpawnOptions;
	private readonly handlers: ClaudeRunnerHandlers;
	constructor(options: ClaudeSpawnOptions, handlers: ClaudeRunnerHandlers) {
		this.options = options; this.handlers = handlers;
		this.id = options.id; this.groupId = options.groupId; this.name = options.name;
		this.task = options.task; this.cwd = options.cwd; this.wake = options.wake ?? true;
		this.startedAt = (options.adopt ? undefined : options.resume?.startedAt) ?? Date.now();
		this.model = options.model; this.effort = options.effort;
		this.timings = { ...TIMINGS, ...options.timings };
		this.limits = { ...LIMITS, ...options.limits };
		for (const value of [...Object.values(this.timings), ...Object.values(this.limits)]) {
			if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Runner limits/timings must be positive integers");
		}
		this.login = options.login;
		this.transport = this.makeTransport(options.spawnImpl, !!options.confine?.hostedTmpDir);
		this.whenClosed = this.closedState.promise;
		if (options.adopt) this.sessionId = options.adopt.sessionId;
		else if (options.resume) this.sessionId = options.resume.sessionId;
		// Defer callbacks until the owner has stored the constructed runner.
		queueMicrotask(() => (options.adopt ? this.adopt() : this.start()));
	}

	/**
	 * One process's transport. Its hooks act only while it is the worker's current one: a process
	 * being replaced after a login switch dies without failing, closing or notifying the worker.
	 */
	private makeTransport(spawnImpl: ClaudeSpawnOptions["spawnImpl"], viaHost = false): ClaudeTransport {
		this.viaHost = viaHost;
		const forced = this.login && this.options.logins?.forcedFailure?.(this.login.id);
		// Its model calls count in this process (llm-inflight). A re-adopted worker's replay is
		// history: counting starts when the host goes live (adopt()).
		// Its spend is recorded here too (the usage ledger): owned by its Claude session, its parent the
		// session that spawned it (PI_USAGE_PARENT, set at spawn). Only a first launch starts fresh.
		const parent = usageParentFromEnv(this.options.env ?? {});
		const requestObserver = createClaudeRequestObserver({
			active: !this.options.adopt || this.transport !== undefined,
			usage: {
				who: (claudeSession) => ({
					owner: claudeSession ?? this.sessionId ?? null,
					parent: parent?.parent ?? null,
					worker: parent?.worker ?? this.id,
					kind: "worker",
					cwd: this.cwd,
					routed: false,
				}),
				...(this.model ? { model: this.model } : {}),
				fresh: !this.options.adopt && !this.options.resume && this.transport === undefined,
			},
		});
		this.requestObserver = requestObserver;
		const transport: ClaudeTransport = new ClaudeTransport({
			timings: this.timings,
			limits: this.limits,
			spawnImpl,
			signalGroupImpl: this.options.signalGroupImpl,
			requestObserver,
			...(forced ? { simulateFailure: forced } : {}),
			hooks: {
				onEvent: (event) => { if (mine()) this.event(event as Record<string, any>); },
				onStderr: (text) => { if (mine()) { this.lastStderr = text; this.push("error", text); } },
				onProtocolError: (message) => { if (mine()) this.fail(message); },
				onStdinError: (message) => { if (mine() && !this.stopping) this.fail(message); },
				onProcessError: (message) => { if (mine()) this.fail(message); },
				// Every launch (start, resume, login move, failover) starts below the hosting server
				// (lowerUnderHost); a host's transport has no pid, the host was lowered at its spawn.
				onSpawned: (pid) => { lowerUnderHost(pid); if (this.transport === transport) { this.processAlive = true; this.pid = pid; } },
				onLeaderExit: () => { if (mine()) { this.processAlive = false; this.cancelPermissions(); } },
				onActivity: () => { if (mine()) this.touch(); },
				beforeEof: () => mine() ? this.abortActiveWork() : Promise.resolve(),
				onInterruptStart: () => { if (mine()) { if (this.active) this.active.cancelled = true; this.cancelPermissions(); } },
				onInterruptSettled: (ack) => { if (mine()) this.afterInterrupt(ack); },
				onClose: (code, signal) => { if (mine()) this.close(code, signal); },
			},
		});
		const mine = (): boolean => this.transport === transport && !this.switching;
		return transport;
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
			this.requestObserver?.activate();
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
		const o = this.options;
		if (o.resume) {
			// Nothing was asked of a resumed worker: it owes no completion, even if it never starts.
			this.initialOwed = false; this.notificationPending = false;
			if (!o.resume.sessionId) { this.fail("Cannot resume: no Claude session id was recorded for this worker"); return; }
		} else if (!this.validInput(this.task)) { this.fail("Initial task is empty or exceeds input limit"); return; }
		if (o.forkSession || o.extensions?.length || o.allowNestedExtensions) {
			this.fail("Claude runner does not support Pi forks or nested extensions"); return;
		}
		if (o.logins?.acquire && this.login) { void this.startOnAcquired(o.logins.acquire.bind(o.logins)); return; }
		this.afterLaunch(this.launch(o.resume?.sessionId, o.env), () => void this.initialize());
	}
	/** After a launch: `next` once it spawned (a confined launch resolves later). */
	private afterLaunch(launched: boolean | Promise<boolean>, next: () => void): void {
		if (launched === true) next();
		else if (launched !== false) void launched.then((ok) => { if (ok) next(); });
	}
	/** In the pool, a worker that would start on `default` borrows a login first (accounts.ts acquire). */
	private async startOnAcquired(acquire: (current?: string) => Promise<ClaudeLoginChoice>): Promise<void> {
		let env = this.options.env;
		try {
			const to = await acquire(this.login?.id);
			if (to.id !== this.login?.id) {
				this.login = to;
				env = { ...this.options.env, ...to.env };
				if (!to.env.CLAUDE_CONFIG_DIR) delete env.CLAUDE_CONFIG_DIR;
			}
		} catch { /* start on the login chosen at creation */ }
		if (this.stopping || this.closed) return;
		this.afterLaunch(this.launch(this.options.resume?.sessionId, env), () => void this.initialize());
	}

	/**
	 * Build the argv and private files, then spawn the current transport. False once failed. The one
	 * chokepoint every process of the worker starts through: a confined worker's launch goes through
	 * the sandbox here (launchConfined), whichever path asked for it.
	 */
	private launch(resume: string | undefined, env: Record<string, string> | undefined): boolean | Promise<boolean> {
		if (this.options.confine) return this.launchConfined(this.options.confine, resume, env);
		const o = this.options;
		const permissionMode = o.permissionMode ?? "bypassPermissions";
		const hostPermissions = permissionMode !== "bypassPermissions" && !!o.onPermission;
		const built = buildClaudeArgv({
			permissionMode, permissionModes: CLAUDE_PERMISSION_MODES, hostPermissions,
			model: o.model, effort: o.effort, tools: o.tools, allowedTools: o.allowedTools,
			mcpServers: o.mcpServers, env, maxBudgetUsd: o.maxBudgetUsd, settingsJson: o.settingsJson,
			...(resume ? { resume } : {}),
		});
		if (built.error !== undefined) { this.fail(built.error); return false; }
		const args = built.args;
		try {
			args.push(...this.privateFiles.write({ tmpDir: o.tmpDir, systemPrompt: o.systemPrompt, mcpServers: built.mcpServers }));
		} catch (error) { this.fail((error as Error).message); return false; }
		try {
			this.transport.launch(o.executable ?? "claude", args, { cwd: o.cwd, env });
		} catch (error) { this.fail(`Spawn failed: ${String(error)}`); return false; }
		this.trackLogin();
		return true;
	}

	/**
	 * The confined launch: Claude's own sandbox off (merged over the caller's settings, spec hooks
	 * included), the private launch files in the worker's sandbox tmp named by their inside path, the
	 * login's access token read again (refreshed first when under an hour is left, or after a 401) and
	 * handed over on an fd, and the process wrapped by the sandbox's `confineLaunch`. A hosted process
	 * gets the same data and confines itself (the host reads the token). Never spawns unconfined.
	 */
	private async launchConfined(confine: ClaudeConfine, resume: string | undefined, env: Record<string, string> | undefined): Promise<boolean> {
		const o = this.options;
		const transport = this.transport;
		const gone = () => this.stopping || this.transport !== transport || transport.isClosed();
		let settings: Record<string, unknown> = {};
		if (o.settingsJson !== undefined) {
			let parsed: unknown;
			try { parsed = JSON.parse(o.settingsJson); } catch { parsed = undefined; }
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { this.fail("Invalid settingsJson: must be a JSON object"); return false; }
			settings = parsed as Record<string, unknown>;
		}
		const permissionMode = o.permissionMode ?? "bypassPermissions";
		const hostPermissions = permissionMode !== "bypassPermissions" && !!o.onPermission;
		const built = buildClaudeArgv({
			permissionMode, permissionModes: CLAUDE_PERMISSION_MODES, hostPermissions,
			model: o.model, effort: o.effort, tools: o.tools, allowedTools: o.allowedTools,
			mcpServers: o.mcpServers, env, maxBudgetUsd: o.maxBudgetUsd, settingsJson: JSON.stringify({ ...settings, ...CONFINED_SETTINGS }),
			...(resume ? { resume } : {}),
		});
		if (built.error !== undefined) { this.fail(built.error); return false; }
		const refusal = (why: string) => `This Claude Code worker cannot start confined by the sandbox: ${why}`;
		let needs: ReturnType<typeof claudeNeeds>;
		try { needs = claudeNeeds({ confine, cwd: o.cwd, login: this.login, env }); }
		catch (error) { this.refuse(refusal((error as Error).message)); return false; }
		// Only a hosting process owns the hosted tmp; an inline launch (a hosted worker's failover) uses the default one.
		if (!this.viaHost) delete needs.tmpDir;
		let module: Awaited<ReturnType<typeof launchModule>>;
		let tmp: { host: string; inside: string };
		try {
			module = await launchModule(confine.module);
			tmp = module.workerTmpDir(confine.scope, needs);
		} catch (error) { if (!gone()) this.refuse(refusal(`the sandbox's launch module failed (${(error as Error).message})`)); return false; }
		if (gone()) return false;
		const args = built.args;
		try {
			args.push(...this.privateFiles.write({ tmpDir: tmp.host, inside: tmp.inside, systemPrompt: o.systemPrompt, mcpServers: built.mcpServers }));
		} catch (error) { this.fail((error as Error).message); return false; }
		const force = this.refreshNext;
		this.refreshNext = false;
		const loginDir = loginDirOf(this.login);
		const source = confinedSourceEnv(claudeEnv(env));
		const command = o.executable ?? "claude";
		if (o.launchProbe ?? process.platform === "darwin") {
			const failed = await confinedVersionProbe({ module, moduleFile: confine.module, scope: confine.scope, needs, command, cwd: o.cwd, env: source });
			if (gone()) return false;
			if (failed) { this.privateFiles.cleanup(); this.refuse(refusal(failed)); return false; }
		}
		if (this.viaHost) {
			const hosted: ClaudeHostedConfine = { module: confine.module, scope: confine.scope, needs, token: { module: ACCOUNTS_MODULE, dir: loginDir, fd: TOKEN_FD, force }, dropEnv: [...CONFINED_DROP_ENV] };
			try { transport.launch(command, args, { cwd: o.cwd, env, hosted }); }
			catch (error) { this.fail(`Spawn failed: ${String(error)}`); return false; }
			this.noteConfined(confine);
			this.trackLogin();
			return true;
		}
		this.defaultTmp = true;
		const token = await freshAccessToken(loginDir, { force, refresh: o.refreshImpl ?? ((dir) => refreshLogin(dir, { executable: o.executable })) });
		if (gone()) return false;
		if (!token) { this.refuse(refusal(`the Claude login ${this.login?.label ?? "default"} has no access token to hand over (sign it in again)`)); return false; }
		let confined: Awaited<ReturnType<typeof module.confineLaunch>>;
		try { confined = await module.confineLaunch(confine.scope, { ...needs, fds: [{ fd: TOKEN_FD, data: token.token }] }, { command, args, cwd: o.cwd, env: source }); }
		catch (error) { if (!gone()) this.refuse(refusal((error as Error).message)); return false; }
		if ("refused" in confined) { if (!gone()) this.refuse(confined.refused); return false; }
		if (gone()) { void confined.cleanup(); return false; }
		try {
			transport.launch(confined.command, confined.args, { cwd: o.cwd, spawnEnv: confined.spawnEnv, fds: confined.fds });
		} catch (error) { void confined.cleanup(); this.fail(`Spawn failed: ${String(error)}`); return false; }
		void transport.whenClosed.then(() => confined.cleanup()).catch(() => undefined);
		this.noteConfined(confine);
		this.trackLogin();
		return true;
	}

	/** The transcript's one line saying how the worker is confined (its first confined launch). */
	private noteConfined(confine: ClaudeConfine): void {
		if (this.confinedNoted) return;
		this.confinedNoted = true;
		this.push("system", `[sandbox: confined — ${confine.describe ?? "the session's sandbox"}]`);
	}
	/** A launch the sandbox refused: the transcript's `[sandbox: refused — …]` line, then the worker fails with the reason. */
	private refuse(reason: string): void {
		if (this.closed || this.stopping) return;
		this.push("system", `[sandbox: refused — ${reason}]`);
		this.fail(reason);
	}

	/**
	 * Lease the process's login while it runs: the pool sees the worker on it, and when the login
	 * starts leaving this device an idle worker moves to the next login (relocate), a busy one as
	 * soon as its task settles.
	 */
	private trackLogin(): void {
		const logins = this.options.logins;
		const login = this.login;
		const transport = this.transport;
		if (!logins?.track || !login || this.options.adopt) return;
		let lease: { done(): void; active(): void } | undefined;
		try {
			lease = logins.track(login.id, {
				busy: () => this.transport === transport && (!!this.active || this.switching || this.redirecting),
				release: () => { if (this.transport === transport) return this.relocate(); },
				pid: () => transport.pid,
			});
		} catch { return; }
		this.lease?.done();
		this.lease = lease;
		void transport.whenClosed.then(() => { lease?.done(); if (this.lease === lease) this.lease = undefined; });
	}

	/**
	 * The worker's login is leaving this device while it is idle: stop its process and start one on
	 * the next login (`--resume` of the same session), with nothing sent. A worker that is busy by
	 * now is released again after its task (the lease ticker asks once more).
	 */
	private async relocate(): Promise<void> {
		const logins = this.options.logins;
		if (!logins?.acquire || this.switching || this.stopping || this.closed || this.leaderExited || this.active || this.redirecting || !this.sessionId || !this.initialized) return;
		const from = this.login;
		let to: ClaudeLoginChoice | undefined;
		try { to = await logins.acquire(); } catch { to = undefined; }
		if (!to || to.id === from?.id || this.switching || this.stopping || this.closed || this.leaderExited || this.active || this.redirecting) return;
		this.switching = true;
		this.initialized = false;
		this.cancelPermissions();
		this.push("system", `Claude: moved ${from?.label ?? "?"} → ${to.label} (the login left this device)`);
		const old = this.transport;
		try { await old.shutdown(); await old.whenClosed; } catch { /* gone either way */ }
		this.privateFiles.cleanup();
		if (this.stopping) { this.switching = false; this.close(null, null); return; }
		this.login = to;
		const env = { ...this.options.env, ...to.env };
		if (!to.env.CLAUDE_CONFIG_DIR) delete env.CLAUDE_CONFIG_DIR;
		this.transport = this.makeTransport(this.options.respawnImpl);
		this.switching = false;
		if (!(await this.launch(this.sessionId, env))) return;
		const ok = await this.transport.control("initialize");
		if (this.stopping || this.closed || this.leaderExited) return;
		if (!ok) { this.fail(`Claude initialize failed after moving to ${to.label}`); return; }
		this.privateFiles.releaseSystemPrompt();
		this.initialized = true;
		this.drainQueue();
	}

	/** Transport state the worker's own guards read. */
	private get closed(): boolean { return !this.switching && this.transport.isClosed(); }
	private get leaderExited(): boolean { return !this.switching && this.transport.hasExited(); }

	private async initialize(): Promise<void> {
		const ok = await this.transport.control("initialize");
		if (this.stopping || this.closed || this.leaderExited) return;
		if (!ok) { this.fail("Claude initialize failed or timed out"); return; }
		this.privateFiles.releaseSystemPrompt();
		this.initialized = true;
		if (this.options.resume) {
			// Probed (CLI 2.1.281): `--resume` replays nothing at startup and keeps the session id;
			// the next user message continues the old conversation. Idle until steered.
			this.status = "waiting";
			this.push("system", `Resumed Claude session ${this.sessionId}; idle until steered`);
			return;
		}
		this.dispatch(this.task, "task");
	}
	private validInput(message: string): boolean { return !!message.trim() && message.length <= this.limits.maxInputChars; }
	/** adoptedId: the task was sent by an earlier manager and is only being re-created here (never re-sent). */
	private dispatch(message: string, kind: "task" | "steer", adoptedId?: string): Task {
		const task: Task = {
			id: adoptedId ?? randomUUID(), accepted: deferred<boolean>(), settled: deferred<boolean>(), cancelled: false, message, kind,
			acceptTimer: setTimeout(() => {
				if (this.active === task) this.fail("User delivery unknown: no correlated replay/result before timeout");
			}, this.timings.requestTimeoutMs),
		};
		this.active = task; this.initialOwed = false; this.notificationPending = true; this.idleAnnounced = false;
		this.lease?.active();
		this.status = "running"; this.taskOutcome = undefined; this.error = undefined;
		this.permissionDenials = []; this.output = ""; this.partial = undefined; this.lastAssistant = undefined;
		this.detector.reset();
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
		if (this.options.logins && this.login && this.active && !this.options.adopt) {
			const early = this.detector.observe(e);
			if (early && this.failover(this.active, early)) return;
			if (e.type === "assistant" && Array.isArray(e.message?.content) && e.message.content.some((b: any) => b?.type === "tool_use")) this.active.progressed = true;
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
			if (this.options.logins && this.login && !this.options.adopt && this.status !== "error") {
				const failure = this.detector.settle(e);
				if (failure && this.failover(task, failure, e)) return;
			}
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
		// A task that ran through is proof the login's token works again: a later 401 refreshes once more.
		if (outcome === "success") this.authRefreshed = undefined;
		task.accepted.resolve(correlated); task.settled.resolve(correlated);
		this.touch();
		// Never wake the parent between queued tasks, during redirect, or while
		// shutdown still owns a live process. The task promise above still lets
		// interrupt wait for the precise protocol boundary.
		this.notifySettled();
		queueMicrotask(() => this.drainQueue());
	}

	/**
	 * A usage limit or a failed sign-in on this worker's login: move to the next usable login (the
	 * host's order; ClaudeWorkerLogins.failover records the failure), stop this process, start one
	 * with `--resume` of the same Claude session on the new login, and send the message again. False
	 * when no login is left or the worker is going away: the task then ends as before.
	 */
	private failover(task: Task, failure: ClaudeAccountFailure, result?: Record<string, any>): boolean {
		if (task.noFailover) return false;
		if (task.failoverPending) { if (result) task.heldResult = result; return true; }
		if (this.switching || this.stopping || this.redirecting || task.cancelled || !this.sessionId || this.respawns >= 16) return false;
		const from = this.login!;
		const logins = this.options.logins!;
		// Confined: the login is likely fine and only the token handed in expired. Refresh it once and
		// resume on the same login; a second refusal fails over as usual.
		if (this.options.confine && failure.kind === "auth" && this.authRefreshed !== from.id) {
			this.authRefreshed = from.id;
			this.refreshNext = true;
			this.respawns++;
			this.switching = true;
			this.initialized = false;
			clearTimeout(task.acceptTimer);
			this.cancelPermissions();
			this.push("system", `Claude: ${from.label} refused the worker's token; refreshing it and resuming on the same login`);
			void this.respawnOn(task, from);
			return true;
		}
		if (logins.failoverAsync) {
			// The pool: `from` goes back, and the next login may be borrowed first. The failed result
			// waits; with no login found it settles the task as it would have.
			task.failoverPending = true;
			if (result) task.heldResult = result;
			void logins.failoverAsync(from, failure).catch(() => undefined).then((to) => {
				task.failoverPending = false;
				if (this.active !== task || this.stopping || this.closed || this.leaderExited) return;
				if (!to || this.switching || this.redirecting || task.cancelled) {
					task.noFailover = true;
					if (task.heldResult) this.event(task.heldResult);
					return;
				}
				this.switchTo(task, from, to, failure);
			});
			return true;
		}
		let to: ClaudeLoginChoice | undefined;
		try { to = logins.failover(from, failure); } catch { to = undefined; }
		if (!to) return false;
		this.switchTo(task, from, to, failure);
		return true;
	}
	private switchTo(task: Task, from: ClaudeLoginChoice, to: ClaudeLoginChoice, failure: ClaudeAccountFailure): void {
		this.respawns++;
		this.switching = true;
		this.initialized = false;
		// The failed result's usage is left out: its modelUsage can be empty, and the resumed
		// process reports the whole session again (usageScope "session").
		clearTimeout(task.acceptTimer);
		this.cancelPermissions();
		this.push("system", switchText(from, to, failure));
		void this.respawnOn(task, to);
	}
	private async respawnOn(task: Task, to: ClaudeLoginChoice): Promise<void> {
		const old = this.transport;
		try { await old.shutdown(); await old.whenClosed; } catch { /* it is gone either way */ }
		this.privateFiles.cleanup();
		// The task the old process failed settles quietly; its message goes out again below.
		if (this.active === task) this.active = undefined;
		task.accepted.resolve(true); task.settled.resolve(true);
		if (this.stopping) {
			// Killed while switching: the old process's close was withheld, so close now, on it.
			this.switching = false;
			this.close(null, null);
			return;
		}
		const same = this.login?.id === to.id;
		this.login = to;
		const env = { ...this.options.env, ...to.env };
		if (!to.env.CLAUDE_CONFIG_DIR) delete env.CLAUDE_CONFIG_DIR;
		this.transport = this.makeTransport(this.options.respawnImpl);
		this.switching = false;
		if (!(await this.launch(this.sessionId, env))) return;
		const ok = await this.transport.control("initialize");
		if (this.stopping || this.closed || this.leaderExited) return;
		if (!ok) { this.fail(`Claude initialize failed after switching to ${to.label}`); return; }
		this.privateFiles.releaseSystemPrompt();
		this.initialized = true;
		const again = task.progressed
			? `[Your previous turn was interrupted: ${same ? `its Claude login's token was refreshed (${to.label})` : `its Claude login was switched (${to.label})`}. Continue where you left off. The interrupted message was:]\n\n${task.message}`
			: task.message;
		this.dispatch(again.length <= this.limits.maxInputChars ? again : task.message, task.kind);
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
		if (this.options.resume && !this.initialized && this.status !== "error" && !this.stopping) {
			this.status = "error";
			this.error = this.clip(`Could not resume Claude session ${this.options.resume.sessionId}: ${this.lastStderr?.trim() || `exited (${signal ?? code ?? "unknown"})`}`);
		}
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
		// A confined worker's default sandbox tmp goes with it: every inline launch used it (a hosted
		// process's tmp is its host's).
		const confine = this.options.confine;
		if (confine && this.defaultTmp) void launchModule(confine.module).then((m) => m.releaseWorkerTmp?.(confine.scope)).catch(() => undefined);
		this.endedAt = Date.now(); this.notifySettled(); this.touch(); this.handlers.onExit(this);
		this.closedState.resolve();
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
