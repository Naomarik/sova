/** Claude Code CLI stream-json transport (probed with CLI 2.1.276 and 2.1.277).
 *
 * Everything here is generic process plumbing: argv assembly, the private files
 * Claude reads at startup, NDJSON framing with hard size limits, control-request
 * correlation, stdin writes, interrupt, and EOF → TERM → KILL shutdown with the
 * pipe drain. Nothing worker- or subagent-specific belongs in this file: no task
 * state, no transcript, no permission policy, and no Pi runtime imports (node
 * builtins only), so both the subagent runner and the top-level model provider
 * can drive the same CLI protocol.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

// ---------------------------------------------------------------------------
// Event shapes
// ---------------------------------------------------------------------------

/** Every decoded record is a plain object; unknown fields stay reachable for probes. */
interface ClaudeEventFields { [key: string]: any }
export interface ClaudeControlResponseEvent extends ClaudeEventFields {
	type: "control_response";
	response?: { request_id?: string; subtype?: string; response?: Record<string, any>; error?: string };
}
export interface ClaudeControlRequestEvent extends ClaudeEventFields {
	type: "control_request";
	request_id?: string;
	request?: { subtype?: string; tool_name?: string; input?: Record<string, any>; tool_use_id?: string; description?: string };
}
export interface ClaudeControlCancelEvent extends ClaudeEventFields { type: "control_cancel_request"; request_id?: string }
export interface ClaudeSystemEvent extends ClaudeEventFields {
	type: "system";
	subtype?: string;
	model?: string;
	mcp_servers?: { name?: string; status?: string }[];
}
export interface ClaudeAssistantEvent extends ClaudeEventFields {
	type: "assistant";
	message?: { content?: unknown; usage?: Record<string, any> };
}
/** Also the `--replay-user-messages` echo of an accepted user message. */
export interface ClaudeUserEvent extends ClaudeEventFields {
	type: "user";
	uuid?: string;
	isReplay?: boolean;
	message?: { content?: unknown };
}
export interface ClaudeStreamDeltaEvent extends ClaudeEventFields {
	type: "stream_event";
	event?: { type?: string; delta?: { type?: string; text?: string } };
}
export interface ClaudeResultEvent extends ClaudeEventFields {
	type: "result";
	subtype?: string;
	is_error?: boolean;
	result?: string;
	terminal_reason?: string;
	user_message_uuid?: string | null;
	user_message_uuids?: string[];
	permission_denials?: any[];
	errors?: unknown[];
}
export interface ClaudeOtherEvent extends ClaudeEventFields { type: string }
export type ClaudeStreamEvent =
	| ClaudeControlResponseEvent
	| ClaudeControlRequestEvent
	| ClaudeControlCancelEvent
	| ClaudeSystemEvent
	| ClaudeAssistantEvent
	| ClaudeUserEvent
	| ClaudeStreamDeltaEvent
	| ClaudeResultEvent
	| ClaudeOtherEvent;

/** false is a correlated rejection; undefined means no known response. */
export type ControlAck = boolean | undefined;
/**
 * A correlated control response with its payload. `ack` carries the same
 * three-valued answer as ControlAck (undefined = no known response, which every
 * caller must treat as fail-closed); `response` is the CLI's own payload, which
 * round-trips (tools/list, mcp_message) need.
 */
export interface ClaudeControlResult {
	ack: ControlAck;
	response?: Record<string, any>;
	error?: string;
}

/** One stdio MCP server entry, in the shape Claude Code's mcp.json expects. */
export interface ClaudeMcpServerEntry { command: string; args: string[]; env?: Record<string, string> }

/** Structural usage accumulator (matches the subagents AgentUsage fields). */
export interface ClaudeUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	contextTokens: number;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

export function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }
export function record(value: unknown): value is Record<string, any> { return !!value && typeof value === "object" && !Array.isArray(value); }
export const isPlain = (value: unknown): value is string => typeof value === "string" && !!value.trim() && !/[\x00-\x1f\x7f]/.test(value);
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/;
/** Environment blocks are passed verbatim to a child, so names must be shell-legal and values real strings. */
export function validEnv(env: unknown): env is Record<string, string> {
	return !!env && typeof env === "object" && !Array.isArray(env)
		&& Object.entries(env).every(([name, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof value === "string");
}
/** mcp.json entries are written verbatim, so they must be plain strings only. */
export function validMcpServers(entries: [string, unknown][]): entries is [string, ClaudeMcpServerEntry][] {
	return entries.every(([name, spec]) => MCP_SERVER_NAME.test(name) && !!spec && typeof spec === "object"
		&& isPlain((spec as any).command) && Array.isArray((spec as any).args) && (spec as any).args.every((a: unknown) => typeof a === "string")
		&& ((spec as any).env === undefined || validEnv((spec as any).env)));
}
export interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void }
export function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}
// API failures can arrive as is_error with subtype "success" and the message only in result.
export function resultError(e: Record<string, any>): string {
	const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
	const errors = Array.isArray(e.errors) ? e.errors.slice(0, 20).map(text).filter(Boolean) : [];
	if (errors.length) return errors.join("\n");
	if (text(e.result)) return text(e.result);
	if (text(e.terminal_reason)) return `Claude task ended: ${text(e.terminal_reason)}`;
	if (text(e.subtype) && e.subtype !== "success") return `Claude task failed: ${text(e.subtype)}`;
	return "Claude task failed";
}
/** Preserve configured CLI authentication/routing (including API keys), but do
 * not inherit Claude's nested-session markers from the host shell. `extra` is
 * applied last, so a caller's variable is what the CLI sees. */
export function claudeEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
	Object.assign(env, extra);
	return env;
}

// ---------------------------------------------------------------------------
// Stream decoding (pure: no transcript, no task state)
// ---------------------------------------------------------------------------

/** Text of a message `content`, which is either a string or a block array. */
export function textBlocksText(content: unknown): string {
	return typeof content === "string" ? content
		: Array.isArray(content) ? content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("") : "";
}
export function isMessageStart(e: Record<string, any>): boolean {
	return e.type === "stream_event" && e.event?.type === "message_start";
}
/** The text of a content_block_delta text delta, or undefined for any other event. */
export function textDelta(e: Record<string, any>): string | undefined {
	if (e.type !== "stream_event" || e.event?.type !== "content_block_delta" || e.event.delta?.type !== "text_delta") return undefined;
	return String(e.event.delta.text ?? "");
}
/** Cumulative context size reported with an assistant message. */
export function contextTokensFrom(usage: unknown): number {
	if (!record(usage)) return 0;
	return number(usage.input_tokens) + number(usage.cache_read_input_tokens) + number(usage.cache_creation_input_tokens) + number(usage.output_tokens);
}
/** The denied operations a terminal result reports, bounded and stringified. */
export function permissionDenialsFrom(value: unknown): { toolName: string; toolUseId?: string }[] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, 100).map((d: any) => ({
		toolName: String(d.tool_name ?? "tool").slice(0, 256),
		toolUseId: typeof d.tool_use_id === "string" ? d.tool_use_id.slice(0, 256) : undefined,
	}));
}
/** True when a result carries neither correlation field (CLI 2.1.277 session-scoped failures). */
export function isUncorrelatedResult(e: Record<string, any>): boolean {
	const ids = Array.isArray(e.user_message_uuids) ? e.user_message_uuids : [];
	return e.user_message_uuid === undefined && ids.length === 0;
}
/** True when a result settles the given user message id. */
export function resultMatches(e: Record<string, any>, uuid: string): boolean {
	const ids = Array.isArray(e.user_message_uuids) ? e.user_message_uuids : [];
	return e.user_message_uuid === uuid || ids.includes(uuid);
}
export function applyResultUsage(usage: ClaudeUsage, e: Record<string, any>): void {
	// modelUsage and total_cost_usd are process-cumulative; never sum results.
	if (record(e.modelUsage)) {
		const values = Object.values(e.modelUsage).filter(record);
		usage.input = values.reduce((n, u) => n + number(u.inputTokens), 0);
		usage.output = values.reduce((n, u) => n + number(u.outputTokens), 0);
		usage.cacheRead = values.reduce((n, u) => n + number(u.cacheReadInputTokens), 0);
		usage.cacheWrite = values.reduce((n, u) => n + number(u.cacheCreationInputTokens), 0);
	} else if (record(e.usage)) {
		usage.input += number(e.usage.input_tokens); usage.output += number(e.usage.output_tokens);
		usage.cacheRead += number(e.usage.cache_read_input_tokens); usage.cacheWrite += number(e.usage.cache_creation_input_tokens);
	}
	usage.cost = Math.max(usage.cost, number(e.total_cost_usd));
	usage.turns += number(e.num_turns);
}
/**
 * A server that does not connect is not an error to Claude: it reports `status: "failed"` in
 * its init event, says nothing on stderr, and runs the turn anyway — with `--tools ""` that
 * leaves a worker with no tools at all, which looks like a worker that simply invents its
 * answers. Returns the failure message, or undefined when every configured server connected.
 */
export function mcpServerFailure(event: any, configured: readonly string[]): string | undefined {
	if (!configured.length) return undefined;
	const reported = new Map<string, string>();
	if (Array.isArray(event.mcp_servers)) {
		for (const server of event.mcp_servers) {
			if (server && typeof server.name === "string") reported.set(server.name, typeof server.status === "string" ? server.status : "unknown");
		}
	}
	for (const name of configured) {
		const status = reported.get(name);
		if (status === "connected") continue;
		return `MCP server "${name}" did not connect (status ${status ?? "missing"}); the worker would run without its tools`;
	}
	return undefined;
}

/** An inbound host control_request, dispatched to an owner that registers for it. */
export interface ClaudeInboundRequest {
	requestId: string;
	subtype: string;
	/** The whole frame: MCP envelopes carry their payload under `request`. */
	frame: ClaudeControlRequestEvent;
}
/** An incoming `can_use_tool` host permission request, without any host identity. */
export interface ClaudeToolPermissionRequest {
	requestId: string;
	toolName: string;
	input: Record<string, unknown>;
	toolUseId?: string;
	description?: string;
}
/** Decodes a can_use_tool control_request; undefined for any other host request. */
export function parseCanUseTool(e: Record<string, any>): ClaudeToolPermissionRequest | undefined {
	if (typeof e.request_id !== "string" || e.request?.subtype !== "can_use_tool") return undefined;
	return {
		requestId: e.request_id,
		toolName: String(e.request.tool_name ?? "tool"),
		input: record(e.request.input) ? e.request.input : {},
		toolUseId: e.request.tool_use_id,
		description: e.request.description,
	};
}

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

export const DEFAULT_CLAUDE_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"];
export interface ClaudeArgvOptions {
	permissionMode: string;
	/** Accepted permission modes; the caller owns the policy list. */
	permissionModes: readonly string[];
	/** The host answers permission prompts over the control channel. */
	hostPermissions: boolean;
	model?: string;
	effort?: string;
	tools?: string[];
	allowedTools?: string[];
	mcpServers?: Record<string, unknown>;
	env?: Record<string, string>;
	maxBudgetUsd?: number;
}
export type ClaudeArgvResult =
	| { args: string[]; mcpServers: [string, ClaudeMcpServerEntry][]; error?: undefined }
	| { args?: undefined; mcpServers?: undefined; error: string };
/**
 * The persistent stream-json argv, minus the private launch files (see
 * ClaudePrivateFiles). Validation failures are returned, in the order a caller
 * must report them, rather than thrown.
 */
export function buildClaudeArgv(o: ClaudeArgvOptions): ClaudeArgvResult {
	if (o.allowedTools?.some((tool) => !tool.trim() || /^\s*-/.test(tool) || /[\x00-\x1f\x7f]/.test(tool))) {
		return { error: "Invalid allowedTools: flags and control characters are not allowed" };
	}
	if (!o.permissionModes.includes(o.permissionMode)) return { error: "Unsupported permission mode" };
	const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
		"--include-partial-messages", "--replay-user-messages", "--permission-mode", o.permissionMode,
		"--permission-prompts", o.hostPermissions ? "host" : "none", "--setting-sources", "", "--strict-mcp-config"];
	if (o.hostPermissions) args.push("--permission-prompt-tool", "stdio");
	if (o.model) args.push("--model", o.model);
	if (o.effort) args.push("--effort", o.effort);
	args.push("--tools", (o.tools ?? DEFAULT_CLAUDE_TOOLS).join(","));
	const mcpServers = Object.entries(o.mcpServers ?? {});
	if (!validMcpServers(mcpServers)) return { error: "Invalid mcpServers: names must be [A-Za-z0-9_-], commands/args/env plain strings" };
	if (o.env !== undefined && !validEnv(o.env)) return { error: "Invalid env: names must be [A-Za-z_][A-Za-z0-9_]*, values strings" };
	// Non-bypass modes would prompt (or, without a host, deny) every MCP tool
	// call; a server the parent configured is trusted like the built-ins.
	const allowedTools = [...(o.allowedTools ?? []), ...(o.permissionMode === "bypassPermissions" ? [] : mcpServers.map(([name]) => `mcp__${name}`))];
	if (allowedTools.length) args.push("--allowedTools", ...allowedTools);
	if (o.maxBudgetUsd !== undefined) {
		if (!Number.isFinite(o.maxBudgetUsd) || o.maxBudgetUsd <= 0) return { error: "maxBudgetUsd must be positive" };
		args.push("--max-budget-usd", String(o.maxBudgetUsd));
	}
	return { args, mcpServers };
}
/** Initialize-only argv: no tools, no settings, no prompts. */
export function buildDiscoveryArgv(): string[] {
	return [
		"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
		"--tools", "", "--setting-sources", "", "--strict-mcp-config",
		"--permission-mode", "dontAsk", "--permission-prompts", "none",
	];
}

// ---------------------------------------------------------------------------
// Private launch files
// ---------------------------------------------------------------------------

/**
 * Files keep instructions and server environments out of the process list and
 * avoid argv size limits (E2BIG). Probed with CLI 2.1.277: the system prompt is
 * read at startup, so it can be removed once initialize succeeds; the MCP config
 * must stay until the process closes.
 */
export class ClaudePrivateFiles {
	/** Private 0700 directory for files Claude reads at startup. */
	dir?: string;
	systemPromptFile?: string;
	mcpConfigFile?: string;
	/** Writes the configured files and returns the argv flags for them. Throws after cleanup. */
	write(o: { tmpDir?: string; systemPrompt?: string; mcpServers: [string, ClaudeMcpServerEntry][] }): string[] {
		const args: string[] = [];
		if (!o.systemPrompt && !o.mcpServers.length) return args;
		try {
			this.dir = fs.mkdtempSync(path.join(o.tmpDir ?? os.tmpdir(), "pi-claude-"));
			if (o.systemPrompt) {
				this.systemPromptFile = path.join(this.dir, "system.md");
				fs.writeFileSync(this.systemPromptFile, o.systemPrompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
				args.push("--append-system-prompt-file", this.systemPromptFile);
			}
			if (o.mcpServers.length) {
				this.mcpConfigFile = path.join(this.dir, "mcp.json");
				fs.writeFileSync(this.mcpConfigFile, JSON.stringify({ mcpServers: Object.fromEntries(o.mcpServers) }), { encoding: "utf8", mode: 0o600, flag: "wx" });
				args.push("--mcp-config", this.mcpConfigFile);
			}
		} catch (error) {
			// Never run without the instructions or tools the caller configured.
			const what = o.mcpServers.length ? "private launch" : "system prompt";
			this.cleanup();
			throw new Error(`Could not write ${what} file: ${(error as Error).message}`);
		}
		return args;
	}
	/** After initialize: the system prompt has been read; the MCP config (if any) must outlive startup. */
	releaseSystemPrompt(): void {
		if (this.systemPromptFile) {
			try { fs.rmSync(this.systemPromptFile, { force: true }); } catch { /* best effort */ }
			this.systemPromptFile = undefined;
		}
		if (!this.mcpConfigFile) this.cleanup();
	}
	cleanup(): void {
		if (!this.dir) return;
		try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* best effort */ }
		this.dir = undefined; this.systemPromptFile = undefined; this.mcpConfigFile = undefined;
	}
}

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

export interface ClaudeTransportTimings {
	/** Control request deadline; also the caller's own delivery deadline. */
	requestTimeoutMs: number;
	eofGraceMs: number;
	termGraceMs: number;
	/** Drain inherited output after escalation AND proven leader exit. */
	pipeDrainMs: number;
}
export interface ClaudeTransportLimits {
	/** Caps one stream-json record, and queued stdin writes. */
	maxLineBytes: number;
}
export type SpawnImpl = (command: string, args: string[], options: any) => ChildProcess;
/**
 * Everything the transport cannot decide: what a protocol error means, what to
 * do with output, and whether the owner is already tearing down. Hooks are
 * called synchronously, in the order the CLI's events arrive.
 */
export interface ClaudeTransportHooks {
	/** Every decoded record, including control_response (already correlated). */
	onEvent(event: ClaudeStreamEvent): void;
	/**
	 * Optional second dispatch for inbound control_requests, after onEvent: for
	 * an owner that answers the control channel generically (MCP over
	 * control_request, for instance). Return true once the request has been
	 * answered with respond()/respondError(); returning false refuses it as
	 * unsupported. Omit the hook to handle control_requests in onEvent alone —
	 * the worker runner does, keeping its own can_use_tool policy.
	 */
	onControlRequest?(request: ClaudeInboundRequest): boolean;
	/** Decoded stderr text. Not called once closed. */
	onStderr?(text: string): void;
	/** Oversize or malformed record: the stream cannot be trusted any more. */
	onProtocolError(message: string): void;
	onStdinError(message: string): void;
	onProcessError(message: string): void;
	/** The child is wired up and its pid is known. */
	onSpawned?(pid: number | undefined): void;
	/** Leader `exit`, before shutdown escalation and the pipe drain. */
	onLeaderExit?(): void;
	/** Leader exit is activity worth reporting to an owner's idle bookkeeping. */
	onActivity?(): void;
	/** Process `close`, before whenClosed resolves. */
	onClose(code: number | null, signal: string | null): void;
	/** Owner work before stdin EOF (interrupt, settlement wait). Skipped once the leader exited. */
	beforeEof?(): Promise<void>;
	/** An interrupt is about to be written (cancel in-flight work here). */
	onInterruptStart?(): void;
	/** The single-flight interrupt settled; undefined means it was never answered. */
	onInterruptSettled?(ack: ControlAck): void;
}
export interface ClaudeTransportOptions {
	timings: ClaudeTransportTimings;
	limits: ClaudeTransportLimits;
	spawnImpl?: SpawnImpl;
	/** @internal Signal the owned detached process group (test seam). */
	signalGroupImpl?: (pid: number, signal: NodeJS.Signals) => void;
	hooks: ClaudeTransportHooks;
}

export class ClaudeTransport {
	/** Leader liveness; whenClosed additionally waits for pipe cleanup. */
	processAlive = false;
	pid?: number;
	readonly whenClosed: Promise<void>;
	private readonly timings: ClaudeTransportTimings;
	private readonly limits: ClaudeTransportLimits;
	private readonly hooks: ClaudeTransportHooks;
	private readonly spawnImpl?: SpawnImpl;
	private readonly signalGroupImpl?: (pid: number, signal: NodeJS.Signals) => void;
	private readonly closedState = deferred<void>();
	private proc?: ChildProcess;
	private closed = false;
	private leaderExited = false;
	private shutdownStarted = false;
	private escalationComplete = false;
	private pipeDrainTimer?: ReturnType<typeof setTimeout>;
	private buffer = "";
	private decoder = new StringDecoder("utf8");
	private stderrDecoder = new StringDecoder("utf8");
	private controls = new Map<string, { resolve: (result: ClaudeControlResult) => void; timer: ReturnType<typeof setTimeout> }>();
	private timers = new Set<ReturnType<typeof setTimeout>>();
	/** Pending while an interrupt is unanswered. */
	private interruptPromise?: Promise<ControlAck>;

	constructor(options: ClaudeTransportOptions) {
		this.timings = options.timings; this.limits = options.limits; this.hooks = options.hooks;
		this.spawnImpl = options.spawnImpl; this.signalGroupImpl = options.signalGroupImpl;
		this.whenClosed = this.closedState.promise;
	}

	/** The owned child, for owners that need its extra events (e.g. adoption's "live"). */
	get child(): ChildProcess | undefined { return this.proc; }
	isClosed(): boolean { return this.closed; }
	hasExited(): boolean { return this.leaderExited; }
	/** No new turn should be started while an interrupt is unanswered. */
	isInterruptPending(): boolean { return this.interruptPromise !== undefined; }

	/** Spawn the CLI. Spawn failures are thrown to the caller, which owns the message. */
	launch(command: string, args: string[], options: { cwd: string; env?: Record<string, string> }): void {
		const spawnOptions = { cwd: options.cwd, shell: false, detached: process.platform !== "win32", env: claudeEnv(options.env), stdio: ["pipe", "pipe", "pipe"] };
		this.proc = (this.spawnImpl ?? spawn)(command, args, spawnOptions);
		this.wire(this.proc);
	}
	/** Re-attach to a process another host started: no argv, no environment of ours. */
	attach(options: { cwd: string }): void {
		this.proc = (this.spawnImpl ?? spawn)("", [], { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
		this.wire(this.proc);
	}
	private wire(proc: ChildProcess): void {
		this.processAlive = true; this.pid = proc.pid;
		this.hooks.onSpawned?.(proc.pid);
		proc.stdin?.on("error", (e) => this.hooks.onStdinError(`stdin error: ${e.message}`));
		proc.stdout?.on("data", (chunk: Buffer) => this.consume(this.decoder.write(chunk)));
		proc.stdout?.on("end", () => { this.consume(this.decoder.end()); if (this.buffer) this.consume("\n"); });
		proc.stderr?.on("data", (chunk: Buffer) => { if (!this.closed) this.hooks.onStderr?.(this.stderrDecoder.write(chunk)); });
		proc.on("error", (e) => this.hooks.onProcessError(`Process error: ${e.message}`));
		proc.once("exit", () => {
			this.leaderExited = true; this.processAlive = false;
			this.hooks.onLeaderExit?.();
			// exit proves leader death, not EOF: detached descendants can retain pipes.
			void this.shutdown();
			this.schedulePipeDrain(); this.hooks.onActivity?.();
		});
		proc.on("close", (code, signal) => this.close(code, signal));
	}

	/** Write one stream-json frame to Claude's stdin. */
	send(value: unknown): boolean {
		const input = this.proc?.stdin;
		if (!input || input.destroyed || input.writableEnded || !input.writable || this.closed || this.leaderExited) return false;
		try {
			const line = JSON.stringify(value) + "\n";
			// Bound queued pipe writes too; write(false) means buffered, not rejected.
			if (input.writableLength + Buffer.byteLength(line) > this.limits.maxLineBytes) return false;
			input.write(line); return true;
		} catch { return false; }
	}
	/** One user turn, identified by uuid so its replay/result can be correlated. */
	sendUser(uuid: string, text: string): boolean {
		return this.send({ type: "user", uuid, message: { role: "user", content: [{ type: "text", text }] } });
	}
	/** A correlated control request, answered with the CLI's own payload. */
	request(subtype: string, fields?: Record<string, unknown>): Promise<ClaudeControlResult> {
		const request_id = randomUUID();
		return new Promise((resolve) => {
			const unanswered = () => resolve({ ack: undefined });
			const timer = setTimeout(() => { this.controls.delete(request_id); unanswered(); }, this.timings.requestTimeoutMs);
			this.controls.set(request_id, { resolve, timer });
			if (!this.send({ type: "control_request", request_id, request: { subtype, ...fields } })) {
				clearTimeout(timer); this.controls.delete(request_id); unanswered();
			}
		});
	}
	/** request(), reduced to its acknowledgment (initialize, interrupt, set_model, …). */
	control(subtype: string, fields?: Record<string, unknown>): Promise<ControlAck> {
		return this.request(subtype, fields).then((result) => result.ack);
	}
	/** Answer an incoming host control request. */
	respond(requestId: string, response: unknown): boolean {
		return this.send({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
	}
	respondError(requestId: string, error: string): boolean {
		return this.send({ type: "control_response", response: { subtype: "error", request_id: requestId, error } });
	}
	/** Single-flight: a second caller joins the interrupt already in flight. */
	interrupt(): Promise<ControlAck> {
		if (this.interruptPromise) return this.interruptPromise;
		this.hooks.onInterruptStart?.();
		const pending = this.control("interrupt");
		this.interruptPromise = pending;
		void pending.then((ack) => {
			if (this.interruptPromise !== pending) return;
			this.interruptPromise = undefined;
			this.hooks.onInterruptSettled?.(ack);
		});
		return pending;
	}
	/** Race a promise against a deadline and process closure; timers die with the process. */
	async bounded<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
		let timer!: ReturnType<typeof setTimeout>;
		const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); this.timers.add(timer); });
		try { return await Promise.race([promise, timeout, this.whenClosed.then(() => fallback)]); }
		finally { clearTimeout(timer); this.timers.delete(timer); }
	}

	private consume(text: string): void {
		if (this.closed) return;
		// Bound individual records, including newline-terminated oversized records.
		let start = 0;
		while (start < text.length) {
			const end = text.indexOf("\n", start);
			const piece = text.slice(start, end < 0 ? text.length : end);
			if (Buffer.byteLength(this.buffer) + Buffer.byteLength(piece) > this.limits.maxLineBytes) {
				this.buffer = ""; this.hooks.onProtocolError("Claude stream-json record exceeds limit"); return;
			}
			this.buffer += piece;
			if (end < 0) return;
			const line = this.buffer; this.buffer = ""; start = end + 1;
			if (!line.trim()) continue;
			let event: unknown;
			try { event = JSON.parse(line); } catch { this.hooks.onProtocolError("Malformed Claude stream-json record"); return; }
			if (record(event)) this.event(event);
		}
	}
	private event(e: Record<string, any>): void {
		if (e.type === "control_response") {
			const response = e.response;
			const pending = this.controls.get(response?.request_id);
			if (pending) {
				this.controls.delete(response.request_id); clearTimeout(pending.timer);
				// The payload is handed to the caller that asked for it; the worker
				// runner takes only the ack, discarding private initialize metadata.
				pending.resolve({
					ack: response.subtype === "success" ? true : response.subtype === "error" ? false : undefined,
					response: record(response.response) ? response.response : undefined,
					error: typeof response.error === "string" ? response.error : undefined,
				});
			}
		}
		this.hooks.onEvent(e as ClaudeStreamEvent);
		if (e.type === "control_request" && this.hooks.onControlRequest && typeof e.request_id === "string") {
			const subtype = typeof e.request?.subtype === "string" ? e.request.subtype : "";
			if (!this.hooks.onControlRequest({ requestId: e.request_id, subtype, frame: e as ClaudeControlRequestEvent })) {
				this.respondError(e.request_id, "Unsupported host control request");
			}
		}
	}

	/** Interrupt (through beforeEof) → EOF → SIGTERM → SIGKILL, then a bounded pipe drain. */
	async shutdown(): Promise<void> {
		if (this.shutdownStarted || this.closed) return;
		this.shutdownStarted = true;
		if (!this.proc) { this.close(null, null); return; }
		if (!this.leaderExited) await this.hooks.beforeEof?.();
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
				(this.signalGroupImpl ?? ((pid, sig) => process.kill(-pid, sig)))(this.pid, signal);
			} else this.proc?.kill(signal);
		} catch { /* group/process may already be gone */ }
	}
	private close(code: number | null, signal: string | null): void {
		if (this.closed) return;
		this.closed = true; this.processAlive = false;
		clearTimeout(this.pipeDrainTimer); this.pipeDrainTimer = undefined;
		this.buffer = "";
		for (const entry of this.controls.values()) { clearTimeout(entry.timer); entry.resolve({ ack: undefined }); }
		this.controls.clear();
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
		this.hooks.onClose(code, signal);
		this.closedState.resolve();
	}
}
