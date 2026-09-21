/**
 * One persistent Claude CLI process per pi session, driving pi's tools through
 * the MCP facade in mcp-host.ts.
 *
 * The shape of this file follows from one fact about pi: `streamSimple` is
 * called once per ASSISTANT MESSAGE, and a tool's result only arrives in the
 * NEXT call's transcript. A Claude CLI turn spans all of those calls. So a turn
 * is held open across provider calls, the `tools/call` the CLI is blocked on
 * outlives the iterator that surfaced it, and this file — not stream.ts — owns
 * the continuity. stream.ts stays pure and stateless.
 *
 * Continuity is checked, never assumed. Every turn fingerprints the transcript
 * prefix; anything that is not a clean extension of what the CLI already saw
 * (a rewind, a branch, a compaction, a foreign append, a changed tool set or
 * system prompt, a model or effort change) restarts the child with the history
 * folded into one user message. The fold is lossy and says so.
 *
 * Verified against CLI 2.1.278 by the team's protocol spike:
 *   - `initialize` with `sdkMcpServers: ["pi"]` works under `-p` stream-json.
 *   - `--allowedTools mcp__pi` is MANDATORY. Without it `--permission-mode
 *     dontAsk` auto-denies every MCP call and `tools/call` never reaches us.
 *   - A held `tools/call` blocks with no deadline of the CLI's own.
 */
import { createHash } from "node:crypto";
import {
	buildClaudeArgv, ClaudeTransport,
	type ClaudeTransportLimits, type ClaudeTransportTimings, type SpawnImpl,
} from "../transport.ts";
import type { ImageContent, Message, TextContent, Tool } from "@earendil-works/pi-ai";
import { PiMcpHost, type HeldMcpCall, type McpContent, type McpToolResult } from "./mcp-host.ts";
import {
	parseClaudeFrame, PI_MCP_SERVER_NAME, PI_MCP_TOOL_PREFIX,
	type ClaudeFrame, type ClaudeSessionBridge, type ClaudeTurnRequest,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * `MCP_TOOL_TIMEOUT` for the child, in ms.
 *
 * The CLI resolves a tool call's wall clock as
 * `clamp(perServerTimeout ?? MCP_TOOL_TIMEOUT ?? <built-in default>, 1000, 2147483647)`,
 * and reads it ONLY from its own environment — not a flag, and not a per-server
 * `env` in an MCP config. It has to exceed pi's tool time, and pi tools have no
 * hard timeout of their own: a held call lasts as long as pi takes, which can
 * include pi prompting the user. The real bound on a held call is
 * `heldCallTimeoutMs` below, not this; this is only the CLI-side backstop.
 *
 * Do not set a per-server `timeout` alongside it — any value >= 1000 overrides
 * this one, so it would only add a second limit to keep in sync. 24 h: the
 * CLI's own built-in default is about 27.8 h (its `ko()` resolver, read from
 * the 2.1.278 binary), so a tighter value would only lower the ceiling.
 */
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 86_400_000;

export interface SessionBridgeTimings {
	/** Control-request deadline (initialize, interrupt). */
	requestTimeoutMs: number;
	eofGraceMs: number;
	termGraceMs: number;
	pipeDrainMs: number;
	/**
	 * How long to wait, after an assistant message announced `tool_use`, for the
	 * matching `tools/call` to arrive over the control channel. Only a protocol
	 * fault trips this; normal dispatch is immediate.
	 */
	toolDispatchTimeoutMs: number;
	/** How long a held call may wait for pi before the child is torn down. */
	heldCallTimeoutMs: number;
	/** Grace for a turn to settle after an interrupt before escalating. */
	abortGraceMs: number;
}

export interface SessionBridgeLimits {
	maxLineBytes: number;
	/** Idle CLI children kept alive across pi sessions. */
	maxIdleSessions: number;
	/** Characters of any one tool result folded into restarted history. */
	maxFoldedResultChars: number;
	/** Characters of the whole folded history message. */
	maxFoldedChars: number;
}

const TIMINGS: SessionBridgeTimings = {
	requestTimeoutMs: 30_000, eofGraceMs: 1_500, termGraceMs: 2_000, pipeDrainMs: 250,
	toolDispatchTimeoutMs: 30_000, heldCallTimeoutMs: 3_600_000, abortGraceMs: 5_000,
};
const LIMITS: SessionBridgeLimits = {
	maxLineBytes: 4 * 1024 * 1024, maxIdleSessions: 4,
	maxFoldedResultChars: 8_000, maxFoldedChars: 512 * 1024,
};

export interface SessionBridgeOptions {
	/** CLI executable. Resolved on PATH without a shell, so a shell alias cannot leak in. */
	executable?: string;
	/** Working directory for the CLI child. Defaults to the current process cwd. */
	cwd?: string;
	/** Extra child environment, merged after the nested-session markers are dropped. */
	env?: Record<string, string>;
	mcpToolTimeoutMs?: number;
	/**
	 * Send pi's system prompt through `initialize`. The CLI accepts
	 * `systemPrompt: string[]` there; argv has no equivalent that survives
	 * `--setting-sources ''`.
	 */
	sendSystemPrompt?: boolean;
	timings?: Partial<SessionBridgeTimings>;
	limits?: Partial<SessionBridgeLimits>;
	spawnImpl?: SpawnImpl;
	signalGroupImpl?: (pid: number, signal: NodeJS.Signals) => void;
}

// ---------------------------------------------------------------------------
// uuid5, for a CLI session id that survives a pi-web restart
// ---------------------------------------------------------------------------

/** RFC 4122 namespace URL. */
const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/**
 * RFC 4122 v5 (SHA-1) UUID. No `uuid` dependency exists here — pi-config
 * extensions are restricted to node builtins — so it is derived directly.
 * Checked against the RFC vector
 * `uuid5(DNS, "python.org") === 886313e1-3b8a-5372-9b90-0c9aee199e5d`.
 */
export function uuidv5(namespace: string, name: string): string {
	const hex = namespace.replace(/-/g, "");
	if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error("uuidv5: namespace is not a UUID");
	const digest = createHash("sha1").update(Buffer.from(hex, "hex")).update(Buffer.from(name, "utf8")).digest();
	const bytes = Buffer.from(digest.subarray(0, 16));
	bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
	bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
	const s = bytes.toString("hex");
	return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** The CLI `--session-id` for a pi session. Stable across pi-web restarts. */
export function claudeSessionId(piSessionId: string): string {
	return uuidv5(NAMESPACE_URL, `pi:${piSessionId}`);
}

// ---------------------------------------------------------------------------
// Transcript fingerprinting
// ---------------------------------------------------------------------------

function sha(...parts: string[]): string {
	const hash = createHash("sha256");
	for (const part of parts) hash.update(part).update("\u0000");
	return hash.digest("hex").slice(0, 32);
}

function contentFingerprint(content: unknown): string {
	if (typeof content === "string") return `t:${content.length}:${sha(content)}`;
	if (!Array.isArray(content)) return "none";
	return content.map((block: unknown) => {
		if (!block || typeof block !== "object") return "?";
		const b = block as Record<string, unknown>;
		if (b.type === "text") return `t:${sha(String(b.text ?? ""))}`;
		// Hash the image's identity, not its bytes: base64 payloads are large and
		// a size plus mime type separates them well enough for divergence.
		if (b.type === "image") return `i:${String(b.mimeType ?? "")}:${String(b.data ?? "").length}`;
		if (b.type === "thinking") return `k:${sha(String(b.thinking ?? ""))}`;
		if (b.type === "toolCall") return `c:${String(b.id ?? "")}:${sha(JSON.stringify(b.arguments ?? {}))}`;
		return `o:${String(b.type ?? "")}`;
	}).join("|");
}

function messageFingerprint(message: Message): string {
	const role = message.role;
	if (role === "toolResult") {
		return sha(role, String(message.toolCallId), String(message.isError), contentFingerprint(message.content));
	}
	if (role === "system") {
		// System messages carry tool state; that is fingerprinted separately from
		// the tool declarations, so only the prompt text matters here.
		return sha(role, String((message as { content?: unknown }).content ?? ""));
	}
	return sha(role, contentFingerprint((message as { content?: unknown }).content));
}

/**
 * Cumulative per-message hashes.
 *
 * The array, rather than one final digest, is what makes "is a prefix of"
 * answerable: the new transcript extends the old one exactly when every
 * recorded entry still matches at its own index.
 */
export function transcriptFingerprint(messages: readonly Message[]): string[] {
	const out: string[] = [];
	let running = "";
	for (const message of messages) {
		running = sha(running, messageFingerprint(message));
		out.push(running);
	}
	return out;
}

export function isPrefix(recorded: readonly string[], next: readonly string[]): boolean {
	if (recorded.length > next.length) return false;
	return recorded.every((hash, i) => hash === next[i]);
}

/** Identity of everything outside the message list that would invalidate the CLI's state. */
function turnMeta(request: ClaudeTurnRequest): string {
	const tools = request.tools.map((tool) => `${tool.name}\u0001${tool.description}\u0001${JSON.stringify(tool.parameters ?? {})}`).join("\u0002");
	return sha(request.model, request.effort ?? "", request.systemPrompt ?? "", tools);
}

// ---------------------------------------------------------------------------
// History folding
// ---------------------------------------------------------------------------

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: unknown): b is TextContent => !!b && typeof b === "object" && (b as { type?: unknown }).type === "text")
		.map((b) => b.text)
		.join("");
}

function imagesOf(content: unknown): ImageContent[] {
	if (!Array.isArray(content)) return [];
	return content.filter((b: unknown): b is ImageContent =>
		!!b && typeof b === "object" && (b as { type?: unknown }).type === "image");
}

export interface FoldedHistory {
	text: string;
	images: ImageContent[];
}

/**
 * Collapse a transcript into ONE user message for a restarted CLI child.
 *
 * Lossy on purpose, and the prose says so to the model: thinking blocks and
 * their signatures are gone, tool results are truncated, and the CLI's own
 * prompt cache and tool bookkeeping start over. Images cannot be folded into
 * text, so they ride the same message as real image blocks; their place in the
 * narrative is marked inline.
 */
export function foldHistory(messages: readonly Message[], limits: SessionBridgeLimits): FoldedHistory {
	const images: ImageContent[] = [];
	const parts: string[] = [];
	const clip = (text: string, cap: number) =>
		text.length <= cap ? text : `${text.slice(0, cap)}… [truncated]`;

	for (const message of messages) {
		if (message.role === "system") continue; // Re-sent as the system prompt, not as history.
		if (message.role === "user") {
			const found = imagesOf(message.content);
			for (const image of found) images.push(image);
			const suffix = found.length ? `\n[${found.length} image(s) attached to this message, included below]` : "";
			parts.push(`## User\n${textOf(message.content)}${suffix}`);
		} else if (message.role === "assistant") {
			const text = textOf(message.content);
			if (text) parts.push(`## Assistant\n${text}`);
			for (const block of message.content) {
				if (block.type === "toolCall") {
					parts.push(`## Assistant tool call \`${block.name}\` (id ${block.id})\n\`\`\`json\n${clip(JSON.stringify(block.arguments), limits.maxFoldedResultChars)}\n\`\`\``);
				}
			}
		} else if (message.role === "toolResult") {
			const found = imagesOf(message.content);
			for (const image of found) images.push(image);
			const suffix = found.length ? `\n[${found.length} image(s) returned by this tool, included below]` : "";
			const label = message.isError ? "failed" : "returned";
			parts.push(`## Tool \`${message.toolName}\` (id ${message.toolCallId}) ${label}\n${clip(textOf(message.content), limits.maxFoldedResultChars)}${suffix}`);
		}
	}

	const body = clip(parts.join("\n\n"), limits.maxFoldedChars);
	const text = [
		"<pi-conversation-history>",
		"The previous Claude Code process was restarted, so this is a condensed, LOSSY replay of the",
		"conversation so far. Reasoning blocks and their signatures are gone and tool output may be",
		"truncated. Treat it as context you are being told about, not as your own verbatim memory.",
		"",
		body,
		"</pi-conversation-history>",
		"",
		"Continue the conversation from here, answering the most recent user message above.",
	].join("\n");
	return { text, images };
}

// ---------------------------------------------------------------------------
// Frame queue
// ---------------------------------------------------------------------------

class FrameQueue {
	private items: ClaudeFrame[] = [];
	private waiters: { resolve: (r: IteratorResult<ClaudeFrame>) => void; reject: (e: unknown) => void }[] = [];
	private ended = false;
	private failure?: unknown;

	push(frame: ClaudeFrame): void {
		if (this.ended) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter.resolve({ value: frame, done: false });
		else this.items.push(frame);
	}
	end(): void {
		if (this.ended) return;
		this.ended = true;
		for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
	}
	fail(error: unknown): void {
		if (this.ended) return;
		this.ended = true; this.failure = error;
		for (const waiter of this.waiters.splice(0)) waiter.reject(error);
	}
	isEnded(): boolean { return this.ended; }

	async *drain(): AsyncGenerator<ClaudeFrame> {
		for (;;) {
			if (this.items.length) { yield this.items.shift()!; continue; }
			if (this.ended) {
				if (this.failure) throw this.failure;
				return;
			}
			const next = await new Promise<IteratorResult<ClaudeFrame>>((resolve, reject) => {
				this.waiters.push({ resolve, reject });
			});
			if (next.done) {
				if (this.failure) throw this.failure;
				return;
			}
			yield next.value;
		}
	}
}

// ---------------------------------------------------------------------------
// One CLI child, for one pi session
// ---------------------------------------------------------------------------

interface PendingToolUse {
	id: string;
	/** Bare pi tool name, as `tools/call` will name it. */
	name: string;
	input: unknown;
	held?: HeldMcpCall;
}

interface TurnState {
	queue: FrameQueue;
	pending: PendingToolUse[];
	/** The assistant message announced it is finished (message_stop / assistant frame). */
	messageComplete: boolean;
	/** Whether the finished message ended in tool_use. */
	wantsTools: boolean;
	dispatchTimer?: ReturnType<typeof setTimeout>;
	signal?: AbortSignal;
	onAbort?: () => void;
}

function deepEqual(a: unknown, b: unknown): boolean {
	try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

class CliSession {
	readonly piSessionId: string;
	lastUsed = Date.now();
	private readonly options: SessionBridgeOptions;
	private readonly timings: SessionBridgeTimings;
	private readonly limits: SessionBridgeLimits;
	private transport?: ClaudeTransport;

	/** Process-exit path only: nothing async runs then, so signal the group directly. */
	killNow(): void {
		const pid = this.transport?.pid;
		if (!pid || this.transport?.isClosed()) return;
		try {
			if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
			else this.transport?.child?.kill("SIGKILL");
		} catch { /* already gone */ }
	}
	private host?: PiMcpHost;
	private turn?: TurnState;
	/** Held `tools/call`s keyed by the CLI tool_use id pi will echo back. */
	private held = new Map<string, HeldMcpCall>();
	/** Held calls whose tool_use block has not been seen yet (dispatch can race). */
	private unmatched: HeldMcpCall[] = [];
	private heldTimer?: ReturnType<typeof setTimeout>;
	private recorded: string[] = [];
	private meta?: string;
	private currentTools: readonly Tool[] = [];
	private started = false;
	private disposing = false;
	/** True while a child is being replaced: the turn outlives the old process. */
	private restarting = false;
	private failure?: string;

	constructor(piSessionId: string, options: SessionBridgeOptions) {
		this.piSessionId = piSessionId;
		this.options = options;
		this.timings = { ...TIMINGS, ...options.timings };
		this.limits = { ...LIMITS, ...options.limits };
	}

	isBusy(): boolean { return !!this.turn || this.held.size > 0; }

	// -- turn ---------------------------------------------------------------

	async *runTurn(request: ClaudeTurnRequest, signal?: AbortSignal): AsyncGenerator<ClaudeFrame> {
		this.lastUsed = Date.now();
		this.currentTools = request.tools;
		if (signal?.aborted) return;

		const next = transcriptFingerprint(request.messages);
		const plan = this.plan(request, next);

		// The turn is registered before anything is written to the child, so a
		// frame that arrives during startup lands in this turn's queue instead of
		// falling on the floor.
		const queue = new FrameQueue();
		const turn: TurnState = { queue, pending: [], messageComplete: false, wantsTools: false, signal };
		this.turn = turn;

		if (signal) {
			turn.onAbort = () => { void this.abortTurn(); };
			signal.addEventListener("abort", turn.onAbort, { once: true });
		}

		try {
			if (plan.restart) await this.restart(request, plan.reason);
			this.deliver(request, plan);
			this.recorded = next;
			this.meta = turnMeta(request);
			yield* queue.drain();
		} finally {
			if (turn.onAbort && signal) signal.removeEventListener("abort", turn.onAbort);
			if (turn.dispatchTimer) clearTimeout(turn.dispatchTimer);
			if (this.turn === turn) this.turn = undefined;
			this.armHeldTimer();
			this.lastUsed = Date.now();
		}
	}

	/**
	 * Decide whether the CLI child can carry this turn on.
	 *
	 * Everything that is not a clean append restarts. That is deliberate for v1:
	 * a restart is deterministic and costs a fold, whereas guessing at what the
	 * CLI still believes is how you get a silently wrong conversation.
	 */
	private plan(request: ClaudeTurnRequest, next: string[]): TurnPlan {
		if (!this.started || !this.transport || this.transport.isClosed() || this.transport.hasExited()) {
			return { restart: true, reason: "no live CLI process", results: [], user: undefined };
		}
		if (this.meta !== undefined && this.meta !== turnMeta(request)) {
			return { restart: true, reason: "model, effort, system prompt or tool set changed", results: [], user: undefined };
		}
		if (!isPrefix(this.recorded, next)) {
			return { restart: true, reason: "transcript diverged (rewind, branch, compaction or foreign append)", results: [], user: undefined };
		}
		const tail = request.messages.slice(this.recorded.length);
		const results = tail.filter((m): m is Extract<Message, { role: "toolResult" }> => m.role === "toolResult");
		const user = [...tail].reverse().find((m) => m.role === "user");
		if (this.held.size && results.length !== this.held.size) {
			return { restart: true, reason: "pi answered only some of the held tool calls", results: [], user: undefined };
		}
		if (results.some((result) => !this.held.has(result.toolCallId))) {
			return { restart: true, reason: "a tool result did not match a held call", results: [], user: undefined };
		}
		if (!results.length && !user) {
			return { restart: true, reason: "nothing new to send", results: [], user: undefined };
		}
		return { restart: false, reason: "", results, user };
	}

	/** Answer held calls first, then any newly arrived user message (steering). */
	private deliver(request: ClaudeTurnRequest, plan: TurnPlan): void {
		if (plan.restart) return; // restart() already sent the folded history.
		for (const result of plan.results) {
			const call = this.held.get(result.toolCallId);
			if (!call) continue;
			this.held.delete(result.toolCallId);
			this.host?.answer(call, toMcpResult(result));
		}
		if (plan.user) this.sendUserMessage(textOf(plan.user.content), imagesOf(plan.user.content));
	}

	private sendUserMessage(text: string, images: readonly ImageContent[]): void {
		const content: Record<string, unknown>[] = [];
		if (text) content.push({ type: "text", text });
		for (const image of images) {
			// stream-json user messages are Anthropic messages, so images use the
			// Anthropic source shape rather than MCP's flat one.
			content.push({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } });
		}
		if (!content.length) content.push({ type: "text", text: "" });
		this.transport?.send({ type: "user", message: { role: "user", content } });
	}

	// -- lifecycle ----------------------------------------------------------

	private async restart(request: ClaudeTurnRequest, reason: string): Promise<void> {
		this.restarting = true;
		try {
			await this.spawnFresh(request, reason);
		} finally {
			this.restarting = false;
		}
	}

	private async spawnFresh(request: ClaudeTurnRequest, reason: string): Promise<void> {
		if (this.started) await this.teardown(`restarting: ${reason}`);
		this.failure = undefined;
		this.recorded = [];
		this.meta = undefined;

		const built = buildClaudeArgv({
			permissionMode: "dontAsk",
			permissionModes: ["dontAsk"],
			hostPermissions: false,
			model: request.model,
			effort: request.effort,
			tools: [], // No built-ins: every tool the model can reach is pi's.
			// MANDATORY. Under dontAsk an unlisted MCP server is auto-denied and
			// the held tools/call never reaches this host at all.
			allowedTools: [`mcp__${PI_MCP_SERVER_NAME}`],
			sessionId: claudeSessionId(this.piSessionId),
		});
		if ("error" in built) throw new Error(`Claude argv rejected: ${built.error}`);
		const args = built.args;

		const host = new PiMcpHost({
			tools: () => this.currentTools,
			respond: (id, response) => this.transport?.respond(id, response) ?? false,
			respondError: (id, error) => this.transport?.respondError(id, error) ?? false,
			onHeldCall: (call) => this.onHeldCall(call),
			onProtocolError: (message) => this.protocolError(message),
		});
		this.host = host;

		const transport = new ClaudeTransport({
			timings: this.transportTimings(),
			limits: { maxLineBytes: this.limits.maxLineBytes } satisfies ClaudeTransportLimits,
			spawnImpl: this.options.spawnImpl,
			signalGroupImpl: this.options.signalGroupImpl,
			hooks: {
				onEvent: (event) => this.onEvent(event as unknown as Record<string, unknown>),
				// The MCP facade rides the control channel; returning false lets the
				// transport refuse anything else as unsupported.
				onControlRequest: (request) => this.host?.handleFrame(request.frame as unknown as Record<string, unknown>) ?? false,
				onProtocolError: (message) => this.protocolError(message),
				onStdinError: (message) => this.protocolError(message),
				onProcessError: (message) => this.protocolError(message),
				onClose: (code, signal) => this.onClose(code, signal),
			},
		});
		this.transport = transport;

		transport.launch(this.options.executable ?? "claude", args, {
			cwd: this.options.cwd ?? process.cwd(),
			env: {
				...this.options.env,
				MCP_TOOL_TIMEOUT: String(this.options.mcpToolTimeoutMs ?? DEFAULT_MCP_TOOL_TIMEOUT_MS),
			},
		});
		this.started = true;

		const fields: Record<string, unknown> = { sdkMcpServers: [PI_MCP_SERVER_NAME] };
		if (this.options.sendSystemPrompt !== false && request.systemPrompt) {
			fields.systemPrompt = [request.systemPrompt];
			fields.systemPromptSnapshot = false;
		}
		const ack = await transport.control("initialize", fields);
		if (ack !== true) {
			const why = ack === undefined ? "did not answer initialize" : "rejected initialize";
			await this.teardown(`Claude ${why}`);
			throw new Error(`Claude ${why}`);
		}

		const folded = foldHistory(request.messages, this.limits);
		this.sendUserMessage(folded.text, folded.images);
	}

	private transportTimings(): ClaudeTransportTimings {
		return {
			requestTimeoutMs: this.timings.requestTimeoutMs,
			eofGraceMs: this.timings.eofGraceMs,
			termGraceMs: this.timings.termGraceMs,
			pipeDrainMs: this.timings.pipeDrainMs,
		};
	}

	/** Reject every held call, then take the child down through the full ladder. */
	async teardown(reason: string): Promise<void> {
		if (this.disposing) return;
		this.disposing = true;
		try {
			this.rejectHeld(reason);
			if (this.heldTimer) { clearTimeout(this.heldTimer); this.heldTimer = undefined; }
			const transport = this.transport;
			this.transport = undefined; this.host = undefined; this.started = false;
			if (transport && !transport.isClosed()) {
				await transport.shutdown();
				await transport.whenClosed;
			}
			if (!this.restarting) {
				this.turn?.queue.end();
				this.turn = undefined;
			}
		} finally {
			this.disposing = false;
		}
	}

	private async abortTurn(): Promise<void> {
		const transport = this.transport;
		if (!transport || transport.isClosed()) { this.turn?.queue.end(); return; }
		// Held calls must go first: the CLI is blocked on them and would never
		// reach the point where it can honour an interrupt.
		this.rejectHeld("the turn was aborted");
		await transport.interrupt();
		// Interrupt acknowledgment is not settlement; the CLI still owes a result
		// frame with an aborted terminal reason, and that ends the turn naturally.
		const settled = await transport.bounded(
			new Promise<boolean>((resolve) => {
				const turn = this.turn;
				if (!turn || turn.queue.isEnded()) { resolve(true); return; }
				const check = setInterval(() => {
					if (!this.turn || this.turn.queue.isEnded()) { clearInterval(check); resolve(true); }
				}, 25);
				void transport.whenClosed.then(() => { clearInterval(check); resolve(true); });
			}),
			this.timings.abortGraceMs,
			false,
		);
		if (!settled) {
			this.turn?.queue.push({ type: "result", outcome: "aborted", message: "Aborted; Claude did not settle the turn" });
			this.turn?.queue.end();
		}
	}

	// -- events -------------------------------------------------------------

	private onEvent(event: Record<string, unknown>): void {
		// Control traffic is answered by onControlRequest (MCP) or correlated by
		// the transport itself; only conversational frames reach a turn.
		if (event.type === "control_request" || event.type === "control_response" || event.type === "control_cancel_request") return;

		let frame: ClaudeFrame | undefined;
		try {
			frame = parseClaudeFrame(event);
		} catch (error) {
			this.protocolError(error instanceof Error ? error.message : String(error));
			return;
		}
		if (!frame) return;
		this.track(frame);
		this.turn?.queue.push(frame);
		if (frame.type === "result") {
			this.turn?.queue.end();
			return;
		}
		this.checkBoundary();
	}

	/** Follow the current assistant message's tool_use blocks and completion. */
	private track(frame: ClaudeFrame): void {
		const turn = this.turn;
		if (!turn) return;
		if (frame.type === "stream") {
			const event = frame.event;
			if (event.type === "message_start") {
				turn.pending = []; turn.messageComplete = false; turn.wantsTools = false;
			} else if (event.type === "content_block_start" && event.block.kind === "tool_use") {
				this.addPending(turn, event.block.id, event.block.name, event.block.input);
			} else if (event.type === "content_block_stop") {
				// The block's arguments are complete now; re-try any held call that
				// arrived before we had the block to match it against.
				this.rematch(turn);
			} else if (event.type === "message_delta") {
				if (event.stopReason === "tool_use") turn.wantsTools = true;
			} else if (event.type === "message_stop") {
				turn.messageComplete = true;
			}
			return;
		}
		if (frame.type === "assistant") {
			for (const block of frame.blocks) {
				if (block.kind === "tool_use") this.addPending(turn, block.id, block.name, block.input);
			}
			if (frame.stopReason === "tool_use") turn.wantsTools = true;
			turn.messageComplete = true;
			this.rematch(turn);
		}
	}

	private addPending(turn: TurnState, id: string, name: string, input: unknown): void {
		if (turn.pending.some((p) => p.id === id)) return;
		const bare = name.startsWith(PI_MCP_TOOL_PREFIX) ? name.slice(PI_MCP_TOOL_PREFIX.length) : name;
		turn.pending.push({ id, name: bare, input });
		turn.wantsTools = true;
		this.rematch(turn);
	}

	/**
	 * A held `tools/call` names its tool but carries no `tool_use` id, so it is
	 * matched against the announced blocks: same name, and same arguments when
	 * that distinguishes two calls of one tool. Arrival order breaks the tie.
	 */
	private rematch(turn: TurnState): void {
		if (!this.unmatched.length) return;
		const rest: HeldMcpCall[] = [];
		for (const call of this.unmatched) {
			const exact = turn.pending.find((p) => !p.held && p.name === call.name && deepEqual(p.input, call.arguments));
			const slot = exact ?? turn.pending.find((p) => !p.held && p.name === call.name);
			if (!slot) { rest.push(call); continue; }
			slot.held = call;
			this.held.set(slot.id, call);
		}
		this.unmatched = rest;
		this.checkBoundary();
	}

	private onHeldCall(call: HeldMcpCall): void {
		this.lastUsed = Date.now();
		const turn = this.turn;
		if (!turn) {
			// No turn is listening: nothing will ever answer this, so fail it fast
			// rather than leave the CLI blocked forever.
			this.host?.fail(call, "pi is not running a turn for this session");
			return;
		}
		this.unmatched.push(call);
		this.rematch(turn);
	}

	/**
	 * End the pi message once the assistant message is finished AND every
	 * announced tool_use has a held call. Ending earlier would hand pi a partial
	 * batch and drop the rest of a parallel tool call.
	 */
	private checkBoundary(): void {
		const turn = this.turn;
		if (!turn || turn.queue.isEnded()) return;
		if (!turn.messageComplete || !turn.wantsTools) return;
		if (!turn.pending.length) return;
		if (turn.pending.every((p) => p.held)) {
			if (turn.dispatchTimer) { clearTimeout(turn.dispatchTimer); turn.dispatchTimer = undefined; }
			turn.queue.end();
			return;
		}
		if (turn.dispatchTimer) return;
		turn.dispatchTimer = setTimeout(() => {
			if (this.turn !== turn || turn.queue.isEnded()) return;
			turn.queue.push({ type: "result", outcome: "error", message: "Claude announced a tool call it never dispatched" });
			turn.queue.end();
		}, this.timings.toolDispatchTimeoutMs);
	}

	private protocolError(message: string): void {
		if (this.restarting) return; // The old child's death is expected here.
		this.failure = message;
		const turn = this.turn;
		if (turn && !turn.queue.isEnded()) {
			turn.queue.push({ type: "result", outcome: "error", message });
			turn.queue.end();
		}
		void this.teardown(message);
	}

	private onClose(code: number | null, signal: string | null): void {
		this.started = false;
		this.rejectHeld("the Claude process exited");
		if (this.restarting) return; // A replacement child is already on its way.
		const turn = this.turn;
		if (turn && !turn.queue.isEnded()) {
			const why = this.failure ?? `Claude exited (${signal ?? code ?? "unknown"}) before finishing the turn`;
			turn.queue.push({ type: "result", outcome: "error", message: why });
			turn.queue.end();
		}
	}

	private rejectHeld(reason: string): void {
		const calls = [...this.held.values(), ...this.unmatched];
		this.held.clear(); this.unmatched = [];
		for (const call of calls) this.host?.fail(call, `Tool call not completed: ${reason}`);
	}

	/**
	 * A held call whose turn ended and which pi never came back for would wedge
	 * the child forever, so it is bounded here rather than by the CLI.
	 */
	private armHeldTimer(): void {
		if (this.heldTimer) { clearTimeout(this.heldTimer); this.heldTimer = undefined; }
		if (!this.held.size) return;
		this.heldTimer = setTimeout(() => {
			this.heldTimer = undefined;
			if (this.turn || !this.held.size) return;
			void this.teardown("pi never returned results for the held tool calls");
		}, this.timings.heldCallTimeoutMs);
	}
}

interface TurnPlan {
	restart: boolean;
	reason: string;
	results: Extract<Message, { role: "toolResult" }>[];
	user: Message | undefined;
}

/** pi's tool result as an MCP `CallToolResult`. */
function toMcpResult(result: Extract<Message, { role: "toolResult" }>): McpToolResult {
	const content: McpContent[] = [];
	for (const block of result.content) {
		if (block.type === "text") content.push({ type: "text", text: block.text });
		// MCP images are flat (data + mimeType); the CLI converts to the Anthropic
		// source shape itself, so do not pre-wrap them here.
		else if (block.type === "image") content.push({ type: "image", data: block.data, mimeType: block.mimeType });
	}
	if (!content.length) content.push({ type: "text", text: "" });
	return result.isError ? { content, isError: true } : { content };
}

// ---------------------------------------------------------------------------
// The bridge, and the process-global registry behind it
// ---------------------------------------------------------------------------

export class SessionBridge implements ClaudeSessionBridge {
	private readonly sessions = new Map<string, CliSession>();
	private readonly options: SessionBridgeOptions;
	private readonly limits: SessionBridgeLimits;

	constructor(options: SessionBridgeOptions = {}) {
		this.options = options;
		this.limits = { ...LIMITS, ...options.limits };
	}

	runTurn(request: ClaudeTurnRequest, signal?: AbortSignal): AsyncIterable<ClaudeFrame> {
		const key = request.sessionId ?? "default";
		let session = this.sessions.get(key);
		if (!session) {
			session = new CliSession(key, this.options);
			this.sessions.set(key, session);
		}
		this.reapIdle(key);
		return session.runTurn(request, signal);
	}

	/** Called from the extension's `session_shutdown` hook. */
	async disposeSession(piSessionId: string, reason = "pi session shut down"): Promise<void> {
		const session = this.sessions.get(piSessionId);
		if (!session) return;
		this.sessions.delete(piSessionId);
		await session.teardown(reason);
	}

	async disposeAll(reason = "shutting down"): Promise<void> {
		const sessions = [...this.sessions.values()];
		this.sessions.clear();
		await Promise.all(sessions.map((session) => session.teardown(reason)));
	}

	/** Synchronous SIGKILL of every live child group; for the host's `exit` event only. */
	killAllNow(): void {
		for (const session of this.sessions.values()) session.killNow();
		this.sessions.clear();
	}

	/** Keep only a bounded number of idle children; a busy one is never reaped. */
	private reapIdle(keep: string): void {
		const idle = [...this.sessions.entries()]
			.filter(([key, session]) => key !== keep && !session.isBusy())
			.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
		const excess = this.sessions.size - this.limits.maxIdleSessions;
		for (let i = 0; i < excess && i < idle.length; i++) {
			const [key, session] = idle[i]!;
			this.sessions.delete(key);
			void session.teardown("idle session reaped");
		}
	}
}

/**
 * pi-web shares one `ModelRuntime` across sessions and `/reload` re-registers
 * every extension, so a module-level registry would be rebuilt while its CLI
 * children stayed running. The registry therefore lives on `globalThis`, and
 * the exit hooks are installed exactly once beside it.
 */
const REGISTRY = Symbol.for("pi-web.claude-code.session-bridge");

interface Registry { bridge: SessionBridge; hooked: boolean }

export function getSessionBridge(options: SessionBridgeOptions = {}): SessionBridge {
	const host = globalThis as unknown as Record<symbol, Registry | undefined>;
	let registry = host[REGISTRY];
	if (!registry) {
		registry = { bridge: new SessionBridge(options), hooked: false };
		host[REGISTRY] = registry;
	}
	if (!registry.hooked) {
		registry.hooked = true;
		const bridge = registry.bridge;
		// `exit` only: nothing asynchronous runs during it, so the children are
		// signalled directly. No SIGINT/SIGTERM listeners — any listener on those
		// disables Node's default exit, and a host without its own handler (the pi
		// TUI, a headless SDK script) would then swallow the first Ctrl-C. Hosts
		// reach the graceful path through session_shutdown -> disposeSession.
		process.once("exit", () => bridge.killAllNow());
	}
	return registry.bridge;
}

/** Drop the process-global registry, tearing every child down. For tests. */
export async function resetSessionBridge(): Promise<void> {
	const host = globalThis as unknown as Record<symbol, Registry | undefined>;
	const registry = host[REGISTRY];
	host[REGISTRY] = undefined;
	await registry?.bridge.disposeAll("registry reset");
}
