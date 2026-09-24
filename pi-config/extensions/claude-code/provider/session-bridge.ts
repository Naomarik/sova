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
 *   - `initialize` with `sdkMcpServers: ["sova"]` works under `-p` stream-json.
 *   - `--allowedTools mcp__sova` is MANDATORY. Without it `--permission-mode
 *     dontAsk` auto-denies every MCP call and `tools/call` never reaches us.
 *   - A held `tools/call` blocks with no deadline of the CLI's own.
 */
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	buildClaudeArgv, ClaudeTransport,
	type ClaudeTransportLimits, type ClaudeTransportTimings, type SpawnImpl,
} from "../transport.ts";
import type { ImageContent, Message, TextContent, Tool } from "@earendil-works/pi-ai";
import { PiMcpHost, type HeldMcpCall, type McpContent, type McpToolResult } from "./mcp-host.ts";
import {
	parseClaudeFrame, MCP_SERVER_NAME, MCP_TOOL_PREFIX,
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
	 * How long a result pi already produced may wait for the CLI to dispatch
	 * the `tools/call` it answers. A CLI dispatching one call at a time asks for
	 * the next as soon as the previous is answered, so only a fault trips this.
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
	/**
	 * The same, for a subagent retrieval tool (`agent_transcript`, `agent_wait`):
	 * its result is a worker's report, and the report IS the deliverable.
	 */
	maxFoldedReportChars: number;
	/** Characters of the whole folded history message. */
	maxFoldedChars: number;
}

const TIMINGS: SessionBridgeTimings = {
	requestTimeoutMs: 30_000, eofGraceMs: 1_500, termGraceMs: 2_000, pipeDrainMs: 250,
	toolDispatchTimeoutMs: 30_000, heldCallTimeoutMs: 3_600_000, abortGraceMs: 5_000,
};
export const LIMITS: SessionBridgeLimits = {
	maxLineBytes: 4 * 1024 * 1024, maxIdleSessions: 4,
	maxFoldedResultChars: 8_000, maxFoldedReportChars: 48_000, maxFoldedChars: 512 * 1024,
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
	/** Diagnostics sink. Defaults to the opt-in log behind PI_CLAUDE_CODE_DEBUG=1. */
	onDebug?: (entry: Record<string, unknown>) => void;
}

/** Opt-in (PI_CLAUDE_CODE_DEBUG=1) bridge diagnostics; never includes message text. */
function debugLog(entry: Record<string, unknown>): void {
	if (process.env.PI_CLAUDE_CODE_DEBUG !== "1") return;
	try { appendFileSync(join(homedir(), ".pi", "agent", "claude-code-debug.log"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`); }
	catch { /* diagnostics are best-effort */ }
}

/** A frame's shape for diagnostics: its kind and block index, never its content. */
function describeFrame(frame: ClaudeFrame): string {
	if (frame.type === "stream") return "index" in frame.event ? `${frame.event.type}[${frame.event.index}]` : frame.event.type;
	if (frame.type === "assistant") return `assistant(${frame.blocks.map((block) => block.kind).join(",")})`;
	return frame.type;
}

// ---------------------------------------------------------------------------
// uuid5, for a CLI session id derived from the pi session
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

/**
 * The CLI `--session-id` for the `launch`-th child of a pi session.
 *
 * `--session-id` CREATES a record; it never re-attaches to one. Handed an id
 * that already exists the CLI prints `Session ID <id> is already in use.` on
 * stderr and exits 1 before answering `initialize`, so a *stable* id would make
 * every relaunch after the first child's death fail forever. Each launch
 * therefore gets its own id, still derived from the pi session id so the
 * records stay attributable to it. Launch 0 keeps the bare `pi:<id>` name, so
 * an existing session's first child is unchanged.
 */
export function claudeSessionId(piSessionId: string, launch = 0): string {
	return uuidv5(NAMESPACE_URL, launch === 0 ? `pi:${piSessionId}` : `pi:${piSessionId}#${launch}`);
}

/** stderr of a child that was handed a `--session-id` some earlier child took. */
const SESSION_ID_TAKEN_RE = /session id\b.*\bis already in use/i;
/** "Claude <why>" for that case; distinguished from a real handshake failure. */
const SESSION_ID_TAKEN = "was handed a session id already in use";
/**
 * How far past `launchAttempt` to probe for a free id. The counter lives in
 * memory, so a new Sova process starts back at 0 and has to walk past the
 * records the previous one left on disk; each collision costs one fast-failing
 * spawn (~150 ms).
 */
const SESSION_ID_PROBES = 32;

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

/**
 * Identity of everything outside the message list that would invalidate the
 * CLI's state. `cwd` is in here because a child's working directory is fixed at
 * spawn: there is no control request that moves a running CLI, so the only
 * honest response to a session that changed directory is a restart.
 */
function turnMeta(request: ClaudeTurnRequest, cwd: string): string {
	const tools = request.tools.map((tool) => `${tool.name}\u0001${tool.description}\u0001${JSON.stringify(tool.parameters ?? {})}`).join("\u0002");
	return sha(request.model, request.effort ?? "", request.systemPrompt ?? "", tools, cwd);
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

/** A subagent retrieval tool, under pi's name or the CLI's `mcp__<server>__` one. */
const REPORT_TOOL_RE = /(?:^|__)agent_(?:transcript|wait)$/;

/**
 * Clip one folded tool result to `cap` characters, keeping its head AND tail:
 * a report's conclusion is at its end, so a head-only clip loses what matters.
 */
function clipResult(text: string, cap: number): string {
	if (text.length <= cap) return text;
	const head = Math.ceil(cap * 0.6);
	return `${text.slice(0, head)}\n… [truncated: ${text.length - cap} chars omitted]\n${text.slice(text.length - (cap - head))}`;
}

export interface FoldedHistory {
	text: string;
	images: ImageContent[];
}

/**
 * How a folded transcript is framed for the child that receives it.
 *
 * - `first`: this pi session has never had a CLI child. If the transcript
 *   (system messages aside) is exactly one user message, that message is sent
 *   as-is: nothing came before it, so there is nothing to disclaim. Anything
 *   else falls back to `joined`.
 * - `joined`: the first child for a conversation that already has history
 *   (a model switch mid-conversation, a reopened or forked session). No Claude
 *   child ever ran for it, so the header says the conversation predates this
 *   one rather than that anything restarted.
 * - `restarted`: a live child was replaced (model/effort/system prompt change,
 *   rewind, aborted turn, crash) and the conversation carries on across it.
 */
export type FoldMode = "first" | "joined" | "restarted";

const FOLD_HEADERS: Record<Exclude<FoldMode, "first">, string> = {
	joined: "This conversation started before you joined it, possibly with a different model. What follows is a condensed transcript, not a verbatim record: reasoning is omitted and tool output may be truncated. Treat it as context you are being told about, not as your own memory.",
	restarted: "Your session was restarted, so this is a condensed, lossy replay of the conversation so far: reasoning is omitted and tool output may be truncated. Treat it as context you are being told about, not as your own verbatim memory.",
};

/**
 * Collapse a transcript into ONE user message for a fresh CLI child; `mode`
 * picks the framing (see FoldMode).
 *
 * Lossy on purpose, and the prose says so to the model: thinking blocks and
 * their signatures are gone, long tool results keep only their head and tail,
 * and the CLI's own prompt cache and tool bookkeeping start over. Images cannot
 * be folded into text, so they ride the same message as real image blocks;
 * their place in the narrative is marked inline.
 */
export function foldHistory(messages: readonly Message[], limits: SessionBridgeLimits, mode: FoldMode = "restarted"): FoldedHistory {
	const foldable = messages.filter((m) => m.role !== "system");
	if (mode === "first") {
		const only = foldable.length === 1 ? foldable[0]! : undefined;
		if (only?.role !== "user") mode = "joined";
		else {
			const found = imagesOf(only.content);
			const suffix = found.length ? `\n[${found.length} image(s) attached to this message, included below]` : "";
			return { text: `${textOf(only.content)}${suffix}`, images: found };
		}
	}
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
			const cap = REPORT_TOOL_RE.test(message.toolName) ? limits.maxFoldedReportChars : limits.maxFoldedResultChars;
			parts.push(`## Tool \`${message.toolName}\` (id ${message.toolCallId}) ${label}\n${clipResult(textOf(message.content), cap)}${suffix}`);
		}
	}

	const body = clip(parts.join("\n\n"), limits.maxFoldedChars);
	const text = [
		"<conversation-history>",
		FOLD_HEADERS[mode],
		"",
		body,
		"</conversation-history>",
		"",
		"Continue from here by answering the latest user message above.",
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

/** A tool_use block of the CLI's current message that pi has not answered yet. */
interface PendingToolUse {
	id: string;
	/** Bare pi tool name, as `tools/call` will name it. */
	name: string;
	input: unknown;
	/** The CLI's `tools/call` for this block, once dispatched. */
	held?: HeldMcpCall;
	/** pi's answer, when it came before the CLI dispatched the call. */
	result?: McpToolResult;
}

interface TurnState {
	queue: FrameQueue;
	/** The assistant message announced it is finished (see track()). */
	messageComplete: boolean;
	/** Whether the finished message ended in tool_use. */
	wantsTools: boolean;
	/** Between a message_start and its message_stop: the message is being streamed. */
	streaming: boolean;
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
	/** The pi session's working directory; the child is spawned in it. */
	cwd: string;
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
	/**
	 * The current CLI message's tool_use blocks, from announcement until pi's
	 * result reaches the CLI. Session state, not turn state: the pi message
	 * ends at the CLI message's end, and a `tools/call` may come later — the
	 * CLI 2.1.280 dispatches an MCP tool not marked read-only only after the
	 * previous call's result, so a message's second call is not even asked for
	 * until pi has answered the first.
	 */
	private calls: PendingToolUse[] = [];
	/** Held calls whose tool_use block has not been seen yet (dispatch can race). */
	private unmatched: HeldMcpCall[] = [];
	/** Bounds pi results waiting on a `tools/call` the CLI has yet to send. */
	private dispatchTimer?: ReturnType<typeof setTimeout>;
	private heldTimer?: ReturnType<typeof setTimeout>;
	private recorded: string[] = [];
	private meta?: string;
	private currentTools: readonly Tool[] = [];
	private started = false;
	/** A child has ever completed its handshake: later folds are restarts, not first contact. */
	private everStarted = false;
	private disposing = false;
	/** True while a child is being replaced: the turn outlives the old process. */
	private restarting = false;
	/** Children this bridge has launched; each one needs its own --session-id. */
	private launchAttempt = 0;
	private failure?: string;
	/**
	 * Why the child's conversation no longer matches what pi saw, if it does
	 * not: pi abandoned a turn mid-message, or the child spoke with no turn to
	 * hear it. Such a child is never reused; the next turn restarts it.
	 */
	private desynced?: string;
	/** An interrupt was sent; the CLI still owes that turn's `result` frame. */
	private abortPending = false;

	constructor(piSessionId: string, options: SessionBridgeOptions, cwd: string) {
		this.piSessionId = piSessionId;
		this.options = options;
		this.cwd = cwd;
		this.timings = { ...TIMINGS, ...options.timings };
		this.limits = { ...LIMITS, ...options.limits };
	}

	isBusy(): boolean { return !!this.turn || this.calls.length > 0 || this.restarting; }

	// -- turn ---------------------------------------------------------------

	async *runTurn(request: ClaudeTurnRequest, signal?: AbortSignal): AsyncGenerator<ClaudeFrame> {
		this.lastUsed = Date.now();
		this.currentTools = request.tools;
		if (signal?.aborted) return;

		const next = transcriptFingerprint(request.messages);
		const plan = this.plan(request, next);

		// The restart finishes before the turn exists, so no frame from the
		// dying child can reach it, whatever the timing of its death. Nothing is
		// written to the new child until the turn is registered below, so
		// nothing it says in reply can fall on the floor either.
		if (plan.restart) {
			await this.restart(request, plan.reason);
			if (signal?.aborted) {
				// The fresh child never got the history; reusing it would drop it.
				this.markDesynced("the turn was aborted before the restarted child was sent the history");
				return;
			}
		}

		const queue = new FrameQueue();
		const turn: TurnState = { queue, messageComplete: false, wantsTools: false, streaming: false, signal };
		this.turn = turn;

		if (signal) {
			turn.onAbort = () => { void this.abortTurn(); };
			signal.addEventListener("abort", turn.onAbort, { once: true });
		}

		let drained = false;
		try {
			this.deliver(request, plan);
			this.recorded = next;
			this.meta = turnMeta(request, this.cwd);
			yield* queue.drain();
			drained = true;
		} finally {
			if (turn.onAbort && signal) signal.removeEventListener("abort", turn.onAbort);
			if (this.turn === turn) this.turn = undefined;
			// pi stopped reading before the turn's end (stream.ts rejected a
			// frame as a protocol error): the child is now ahead of pi's
			// transcript by whatever it went on to say. An abort is not this;
			// abortTurn() already asked the CLI to settle.
			if (!drained && !signal?.aborted) this.markDesynced("pi abandoned the turn mid-message");
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
			return { restart: true, reason: "no live CLI process", results: [], user: undefined, first: !this.everStarted };
		}
		if (this.desynced) {
			return { restart: true, reason: `the CLI fell out of step with pi: ${this.desynced}`, results: [], user: undefined };
		}
		if (this.abortPending) {
			// Its late result would otherwise end this turn.
			return { restart: true, reason: "an interrupted turn has not settled", results: [], user: undefined };
		}
		if (this.meta !== undefined && this.meta !== turnMeta(request, this.cwd)) {
			return { restart: true, reason: "model, effort, system prompt, tool set or cwd changed", results: [], user: undefined };
		}
		if (!isPrefix(this.recorded, next)) {
			return { restart: true, reason: "transcript diverged (rewind, branch, compaction or foreign append)", results: [], user: undefined };
		}
		const tail = request.messages.slice(this.recorded.length);
		const results = tail.filter((m): m is Extract<Message, { role: "toolResult" }> => m.role === "toolResult");
		const user = [...tail].reverse().find((m) => m.role === "user");
		if (this.calls.length && results.length !== this.calls.length) {
			return { restart: true, reason: "pi answered only some of the CLI's tool calls", results: [], user: undefined };
		}
		if (results.some((result) => !this.calls.some((call) => call.id === result.toolCallId))) {
			return { restart: true, reason: "a tool result did not match a held call", results: [], user: undefined };
		}
		if (!results.length && !user) {
			return { restart: true, reason: "nothing new to send", results: [], user: undefined };
		}
		return { restart: false, reason: "", results, user };
	}

	/**
	 * Answer the CLI's tool calls first, then send any newly arrived user
	 * message (steering). A call the CLI has not dispatched yet keeps its result
	 * until it does.
	 */
	private deliver(request: ClaudeTurnRequest, plan: TurnPlan): void {
		if (plan.restart) {
			const folded = foldHistory(request.messages, this.limits, plan.first ? "first" : "restarted");
			this.sendUserMessage(folded.text, folded.images);
			return;
		}
		for (const result of plan.results) {
			const slot = this.calls.find((call) => call.id === result.toolCallId);
			if (slot) slot.result = toMcpResult(result);
		}
		this.settleCalls();
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

		// Walk forward until the CLI accepts an id: a collision is survivable and
		// costs one fast-failing spawn, whereas reusing an id is fatal for good.
		for (let probe = 0; probe <= SESSION_ID_PROBES; probe++) {
			const why = await this.launchChild(request, claudeSessionId(this.piSessionId, this.launchAttempt));
			this.launchAttempt++;
			if (why === undefined) {
				// A fresh child has heard nothing yet; runTurn() sends the history.
				this.desynced = undefined;
				this.abortPending = false;
				return;
			}
			if (why !== SESSION_ID_TAKEN) throw new Error(`Claude ${why}`);
		}
		throw new Error(`Claude ${SESSION_ID_TAKEN}, for ${SESSION_ID_PROBES + 1} ids in a row`);
	}

	/**
	 * Spawn one child and run the `initialize` handshake. Returns undefined once
	 * the child is live, or the "Claude <why>" tail for a child already torn down.
	 */
	private async launchChild(request: ClaudeTurnRequest, sessionId: string): Promise<string | undefined> {
		const built = buildClaudeArgv({
			permissionMode: "dontAsk",
			permissionModes: ["dontAsk"],
			hostPermissions: false,
			model: request.model,
			effort: request.effort,
			tools: [], // No built-ins: every tool the model can reach is pi's.
			// MANDATORY. Under dontAsk an unlisted MCP server is auto-denied and
			// the held tools/call never reaches this host at all.
			allowedTools: [`mcp__${MCP_SERVER_NAME}`],
			sessionId,
		});
		if ("error" in built) throw new Error(`Claude argv rejected: ${built.error}`);
		const args = built.args;

		const host = new PiMcpHost({
			tools: () => this.currentTools,
			// A host only ever answers its own child.
			respond: (id, response) => transport.respond(id, response),
			respondError: (id, error) => transport.respondError(id, error),
			onHeldCall: (call) => this.onHeldCall(call),
			onProtocolError: (message) => this.protocolError(message),
		});
		this.host = host;

		// Only read when the handshake fails: a child that refuses its session id
		// says so here and nowhere else.
		let stderr = "";
		// Hooks are bound to their own child. A child being torn down keeps
		// streaming until the signal lands (the real CLI retries a failed held
		// call), and none of that may reach the turn or host of its replacement.
		// Output is dropped as soon as teardown detaches the child; its death is
		// only ignored once a newer child has taken over.
		const current = (): boolean => this.transport === transport;
		const superseded = (): boolean => this.transport !== undefined && !current();
		const transport = new ClaudeTransport({
			timings: this.transportTimings(),
			limits: { maxLineBytes: this.limits.maxLineBytes } satisfies ClaudeTransportLimits,
			spawnImpl: this.options.spawnImpl,
			signalGroupImpl: this.options.signalGroupImpl,
			hooks: {
				onEvent: (event) => { if (current()) this.onEvent(event as unknown as Record<string, unknown>); },
				onStderr: (text) => { if (stderr.length < 4096) stderr += text; },
				// The MCP facade rides the control channel; returning false lets the
				// transport refuse anything else as unsupported, including a
				// detached child's tools/call, which is never held.
				onControlRequest: (request) => current() && (this.host?.handleFrame(request.frame as unknown as Record<string, unknown>) ?? false),
				onProtocolError: (message) => { if (!superseded()) this.protocolError(message); },
				onStdinError: (message) => { if (!superseded()) this.protocolError(message); },
				onProcessError: (message) => { if (!superseded()) this.protocolError(message); },
				onClose: (code, signal) => { if (!superseded()) this.onClose(code, signal); },
			},
		});
		this.transport = transport;

		transport.launch(this.options.executable ?? "claude", args, {
			cwd: this.cwd,
			env: {
				...this.options.env,
				MCP_TOOL_TIMEOUT: String(this.options.mcpToolTimeoutMs ?? DEFAULT_MCP_TOOL_TIMEOUT_MS),
			},
		});
		this.started = true;

		const fields: Record<string, unknown> = { sdkMcpServers: [MCP_SERVER_NAME] };
		if (this.options.sendSystemPrompt !== false && request.systemPrompt) {
			fields.systemPrompt = [request.systemPrompt];
			fields.systemPromptSnapshot = false;
		}
		const ack = await transport.control("initialize", fields);
		if (ack === true) { this.everStarted = true; return undefined; }
		// Tear down before reading stderr: the child's last words arrive before
		// its close, and teardown is what waits for that close.
		await this.teardown("Claude failed the initialize handshake");
		return SESSION_ID_TAKEN_RE.test(stderr) ? SESSION_ID_TAKEN
			: ack === undefined ? "did not answer initialize" : "rejected initialize";
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
			// Detach first: failing a held call makes the child retry, and that
			// output must already find itself disowned.
			const transport = this.transport;
			const host = this.host;
			const turn = this.turn;
			this.transport = undefined; this.host = undefined; this.started = false;
			this.rejectHeld(reason, host);
			if (this.heldTimer) { clearTimeout(this.heldTimer); this.heldTimer = undefined; }
			if (transport && !transport.isClosed()) {
				await transport.shutdown();
				await transport.whenClosed;
			}
			// A turn registered while the child was dying belongs to its replacement.
			if (!this.restarting && this.turn === turn) {
				turn?.queue.end();
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
		// pi stops reading at once; what the CLI says until its result is expected.
		this.abortPending = true;
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
		// An interrupted turn settles with its result frame.
		const settling = this.abortPending;
		if (frame.type === "result") this.abortPending = false;
		const turn = this.turn;
		if (!turn || turn.queue.isEnded()) {
			this.dropped(frame, settling);
			return;
		}
		this.track(frame);
		turn.queue.push(frame);
		if (frame.type === "result") {
			turn.queue.end();
			return;
		}
		this.checkBoundary();
	}

	/**
	 * A frame no turn will ever see. Outside an interrupt's wind-down this means
	 * pi's transcript and the child's conversation have parted, and every later
	 * turn on this child would inherit the gap (and its stray deltas).
	 */
	private dropped(frame: ClaudeFrame, settling: boolean): void {
		if (frame.type === "init") return; // Not conversation.
		const shape = describeFrame(frame);
		(this.options.onDebug ?? debugLog)({ event: "frame-dropped", session: this.piSessionId, frame: shape, settling });
		if (settling) return;
		this.markDesynced(`Claude sent ${shape} with no pi turn open`);
	}

	private markDesynced(reason: string): void {
		if (this.desynced) return;
		this.desynced = reason;
		(this.options.onDebug ?? debugLog)({ event: "desynced", session: this.piSessionId, reason });
	}

	/** Follow the current assistant message's tool_use blocks and completion. */
	private track(frame: ClaudeFrame): void {
		const turn = this.turn;
		if (!turn) return;
		if (frame.type === "stream") {
			const event = frame.event;
			if (event.type === "message_start") {
				// The CLI calls the model again only once every tool call of the
				// last message has its result; one it answered itself instead (it
				// never asked pi) leaves the child's history differing from pi's.
				if (this.calls.length) {
					this.markDesynced("Claude moved on without dispatching a tool call pi answered");
					this.rejectHeld("Claude started a new message");
				}
				turn.messageComplete = false; turn.wantsTools = false; turn.streaming = true;
			} else if (event.type === "content_block_start" && event.block.kind === "tool_use") {
				this.addPending(turn, event.block.id, event.block.name, event.block.input);
			} else if (event.type === "content_block_stop") {
				// The block's arguments are complete now; re-try any held call that
				// arrived before we had the block to match it against.
				this.rematch();
			} else if (event.type === "message_delta") {
				// Not the end: ending here would leave the message_stop that
				// follows it to arrive with no turn open.
				if (event.stopReason === "tool_use") turn.wantsTools = true;
			} else if (event.type === "message_stop") {
				turn.messageComplete = true; turn.streaming = false;
			}
			return;
		}
		if (frame.type === "assistant") {
			for (const block of frame.blocks) {
				if (block.kind !== "tool_use") continue;
				this.addPending(turn, block.id, block.name, block.input);
				// A streamed tool_use starts with empty input; this frame carries
				// the final arguments, which the tools/call matching compares.
				const slot = this.calls.find((call) => call.id === block.id);
				if (slot) slot.input = block.input;
			}
			// Under --include-partial-messages the CLI sends one assistant frame
			// PER CONTENT BLOCK, just before that block's content_block_stop
			// (2.1.280 on stdout: stop_reason null; the on-disk transcript later
			// shows tool_use on each). Inside a streamed message it therefore says
			// nothing about completion: taking it as the end handed pi the first
			// tool call alone and dropped the rest of the message. Only a message
			// that was never streamed (no message_start) ends here.
			if (!turn.streaming) {
				if (frame.stopReason === "tool_use") turn.wantsTools = true;
				turn.messageComplete = true;
			}
			this.rematch();
		}
	}

	private addPending(turn: TurnState, id: string, name: string, input: unknown): void {
		if (this.calls.some((p) => p.id === id)) return;
		const bare = name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
		this.calls.push({ id, name: bare, input });
		turn.wantsTools = true;
		this.rematch();
	}

	/**
	 * A held `tools/call` names its tool but carries no `tool_use` id, so it is
	 * matched against the announced blocks: same name, and same arguments when
	 * that distinguishes two calls of one tool. Arrival order breaks the tie.
	 */
	private rematch(): void {
		if (!this.unmatched.length) return;
		const rest: HeldMcpCall[] = [];
		for (const call of this.unmatched) {
			const exact = this.calls.find((p) => !p.held && p.name === call.name && deepEqual(p.input, call.arguments));
			const slot = exact ?? this.calls.find((p) => !p.held && p.name === call.name);
			if (!slot) { rest.push(call); continue; }
			slot.held = call;
		}
		this.unmatched = rest;
		this.settleCalls();
	}

	/** Answer every dispatched call pi has a result for; bound the ones still owed a dispatch. */
	private settleCalls(): void {
		const host = this.host;
		this.calls = this.calls.filter((slot) => {
			if (!slot.held || !slot.result) return true;
			host?.answer(slot.held, slot.result);
			return false;
		});
		const owed = this.calls.some((slot) => slot.result);
		if (!owed) {
			if (this.dispatchTimer) { clearTimeout(this.dispatchTimer); this.dispatchTimer = undefined; }
			return;
		}
		if (this.dispatchTimer) return;
		this.dispatchTimer = setTimeout(() => {
			this.dispatchTimer = undefined;
			if (!this.calls.some((slot) => slot.result)) return;
			this.markDesynced("Claude announced a tool call it never dispatched");
			const turn = this.turn;
			if (turn && !turn.queue.isEnded()) {
				turn.queue.push({ type: "result", outcome: "error", message: "Claude announced a tool call it never dispatched" });
				turn.queue.end();
			}
		}, this.timings.toolDispatchTimeoutMs);
	}

	private onHeldCall(call: HeldMcpCall): void {
		this.lastUsed = Date.now();
		this.unmatched.push(call);
		this.rematch();
		if (this.turn || !this.unmatched.includes(call)) {
			// Dispatch may trail the message pi was handed; the call is pi's to answer.
			if (!this.turn) this.armHeldTimer();
			return;
		}
		// No turn is listening and pi never saw this call: nothing will ever
		// answer it, so fail it fast rather than leave the CLI blocked forever.
		this.unmatched = this.unmatched.filter((c) => c !== call);
		this.host?.fail(call, "pi is not running a turn for this session");
		if (!this.abortPending) this.markDesynced(`Claude called ${call.name} with no pi turn open`);
	}

	/**
	 * End the pi message when the CLI's assistant message ends in tool_use. Not
	 * before: its per-block frames are not the end, and ending on the first
	 * would hand pi a partial batch. And not later, waiting for every
	 * `tools/call`: a CLI that dispatches one call at a time asks for the next
	 * only once pi has answered the last, which pi does only after this message
	 * ends. Calls dispatched afterwards are matched and answered by deliver().
	 */
	private checkBoundary(): void {
		const turn = this.turn;
		if (!turn || turn.queue.isEnded()) return;
		if (!turn.messageComplete || !turn.wantsTools) return;
		if (!this.calls.length) return;
		turn.queue.end();
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

	private rejectHeld(reason: string, host = this.host): void {
		const calls = [...this.calls.flatMap((slot) => slot.held ? [slot.held] : []), ...this.unmatched];
		this.calls = []; this.unmatched = [];
		if (this.dispatchTimer) { clearTimeout(this.dispatchTimer); this.dispatchTimer = undefined; }
		for (const call of calls) host?.fail(call, `Tool call not completed: ${reason}`);
	}

	/**
	 * A held call whose turn ended and which pi never came back for would wedge
	 * the child forever, so it is bounded here rather than by the CLI.
	 */
	private armHeldTimer(): void {
		if (this.heldTimer) { clearTimeout(this.heldTimer); this.heldTimer = undefined; }
		if (!this.calls.length) return;
		this.heldTimer = setTimeout(() => {
			this.heldTimer = undefined;
			if (this.turn || !this.calls.length) return;
			void this.teardown("pi never returned results for the held tool calls");
		}, this.timings.heldCallTimeoutMs);
	}
}

interface TurnPlan {
	restart: boolean;
	reason: string;
	results: Extract<Message, { role: "toolResult" }>[];
	user: Message | undefined;
	/** No child has ever run for this pi session; the fold is first contact. */
	first?: boolean;
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
	/**
	 * pi session id -> that session's working directory, recorded by the
	 * extension at session_start. Kept beside the session map rather than on the
	 * request because `ClaudeTurnRequest` has no cwd and one process serves many
	 * sessions with different directories.
	 */
	private readonly cwds = new Map<string, string>();
	private readonly options: SessionBridgeOptions;
	private readonly limits: SessionBridgeLimits;

	constructor(options: SessionBridgeOptions = {}) {
		this.options = options;
		this.limits = { ...LIMITS, ...options.limits };
	}

	/**
	 * Record a pi session's working directory. Called from the extension's
	 * session_start handler; without it the child would fall back to the host
	 * process's cwd, which is only right by accident.
	 */
	setSessionCwd(sessionId: string, cwd: string): void {
		if (!sessionId || !cwd) return;
		this.cwds.set(sessionId, cwd);
		const session = this.sessions.get(sessionId);
		// A live session adopts it now; the change restarts the child on its next
		// turn, because cwd is part of the turn fingerprint.
		if (session) session.cwd = cwd;
	}

	/** The cwd a session's child should run in, best known to worst. */
	private cwdFor(sessionId: string): string {
		return this.cwds.get(sessionId) ?? this.options.cwd ?? process.cwd();
	}

	runTurn(request: ClaudeTurnRequest, signal?: AbortSignal): AsyncIterable<ClaudeFrame> {
		const key = request.sessionId ?? "default";
		let session = this.sessions.get(key);
		if (!session) {
			session = new CliSession(key, this.options, this.cwdFor(key));
			this.sessions.set(key, session);
		}
		this.reapIdle(key);
		return session.runTurn(request, signal);
	}

	/**
	 * pi session ids with a live CLI child, for diagnostics and the live smoke
	 * test. Reading it must never be load-bearing for behaviour.
	 */
	activeSessionIds(): string[] { return [...this.sessions.keys()]; }

	/** Called from the extension's `session_shutdown` hook. */
	async disposeSession(piSessionId: string, reason = "pi session shut down"): Promise<void> {
		this.cwds.delete(piSessionId);
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
 * Sova shares one `ModelRuntime` across sessions and `/reload` re-registers
 * every extension, so a module-level registry would be rebuilt while its CLI
 * children stayed running. The registry therefore lives on `globalThis`, and
 * the exit hooks are installed exactly once beside it.
 */
const REGISTRY = Symbol.for("sova.claude-code.session-bridge");

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
