/**
 * Wire types for the Claude Code provider and the narrow seam between the
 * stream adapter (stream.ts, pure) and the session bridge (session-bridge.ts,
 * owns the persistent CLI process and the MCP facade).
 *
 * The frames below are the subset of the CLI's `--output-format stream-json`
 * protocol that one assistant message needs. `parseClaudeFrame` is the single
 * validation boundary: it accepts already-parsed JSON, returns `undefined` for
 * frames this layer ignores, and throws `ClaudeProtocolError` for a frame whose
 * shape is corrupt. Corruption is never silently smoothed over.
 */
import type { Message, Tool } from "@earendil-works/pi-ai";

/** Names the MCP facade uses for pi's tools: pi tool `read` is `mcp__sova__read`. */
export const MCP_SERVER_NAME = "sova";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

export class ClaudeProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ClaudeProtocolError";
	}
}

/** Per-message token counts as the CLI reports them (Anthropic field names normalized). */
export interface ClaudeUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export type ClaudeContentBlockStart =
	| { kind: "text" }
	| { kind: "thinking" }
	| { kind: "redacted_thinking"; data: string }
	| { kind: "tool_use"; id: string; name: string; input?: unknown };

export type ClaudeContentDelta =
	| { kind: "text"; text: string }
	| { kind: "thinking"; thinking: string }
	| { kind: "signature"; signature: string }
	| { kind: "input_json"; partialJson: string };

/** Anthropic passthrough events, carried by the CLI inside `stream_event` frames. */
export type ClaudeStreamEvent =
	| { type: "message_start"; usage?: ClaudeUsage }
	| { type: "content_block_start"; index: number; block: ClaudeContentBlockStart }
	| { type: "content_block_delta"; index: number; delta: ClaudeContentDelta }
	| { type: "content_block_stop"; index: number }
	| { type: "message_delta"; stopReason?: string; usage?: ClaudeUsage }
	| { type: "message_stop" };

export type ClaudeFrame =
	/** `system`/`init`: the CLI is up; carries the session it will keep using. */
	| { type: "init"; sessionId?: string }
	| { type: "stream"; event: ClaudeStreamEvent }
	/** Whole-message `assistant` frame; only used to backfill blocks partial streaming missed. */
	| { type: "assistant"; blocks: ClaudeAssistantBlock[]; stopReason?: string; usage?: ClaudeUsage }
	/** Terminal frame for the turn. `aborted` covers every `aborted*` terminal reason. */
	| { type: "result"; outcome: "success" | "error" | "aborted"; message?: string; usage?: ClaudeUsage };

export type ClaudeAssistantBlock =
	| { kind: "text"; text: string }
	| { kind: "thinking"; thinking: string; signature?: string }
	| { kind: "tool_use"; id: string; name: string; input: unknown };

/** One assistant turn as the bridge should run it against the CLI. */
export interface ClaudeTurnRequest {
	/** Model id as the CLI understands it — the pi model id is the CLI alias. */
	model: string;
	/** `--effort` value, already mapped from pi's thinking ladder. Absent means "off". */
	effort?: string;
	/** pi's session id, so the bridge can reuse one CLI process per pi session. */
	sessionId?: string;
	systemPrompt?: string;
	/** pi's tools, to be exposed through the MCP facade as `mcp__sova__<name>`. */
	tools: Tool[];
	/** The full normalized transcript for this turn. */
	messages: Message[];
	/**
	 * The model's context window and output cap, in tokens (pi's `Model`).
	 * They size the history folded into a restarted child; absent, the
	 * bridge falls back to a fixed cap.
	 */
	contextWindow?: number;
	maxTokens?: number;
}

/**
 * The only thing stream.ts needs from the process side: run one assistant
 * message and yield its frames in order. The bridge owns the CLI process, the
 * MCP facade, held tool calls and session reuse; it must honor `signal` by
 * ending the iteration (a final `result` frame with outcome `aborted`, or by
 * throwing an `AbortError`), and must stop the turn when the consumer stops
 * iterating (`return()` on the iterator).
 */
export interface ClaudeSessionBridge {
	runTurn(request: ClaudeTurnRequest, signal?: AbortSignal): AsyncIterable<ClaudeFrame>;
	/** Stop the CLI child that served one pi session, when pi closes it. */
	disposeSession?(sessionId: string, reason?: string): Promise<void>;
	/**
	 * Tell the bridge which directory a pi session runs in, so its CLI child is
	 * spawned there. A child's cwd is fixed at spawn, so a later change restarts
	 * it (cwd is part of the turn fingerprint).
	 */
	setSessionCwd?(sessionId: string, cwd: string): void;
}

/** The payload handed to `options.onPayload`; a returned replacement is applied. */
export interface ClaudeTurnPayload extends ClaudeTurnRequest {
	provider: "claude-code-cli";
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function requireRecord(value: unknown, what: string): Record<string, unknown> {
	if (!record(value)) throw new ClaudeProtocolError(`Claude ${what} is not an object`);
	return value;
}
function requireString(value: unknown, what: string): string {
	if (typeof value !== "string" || !value) throw new ClaudeProtocolError(`Claude ${what} is missing`);
	return value;
}
function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
function index(value: unknown, what: string): number {
	if (value === undefined) return 0; // The CLI omits index on single-block messages.
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new ClaudeProtocolError(`Claude ${what} has an invalid content index`);
	}
	return value;
}
function usage(value: unknown): ClaudeUsage | undefined {
	if (!record(value)) return undefined;
	return {
		input: count(value.input_tokens),
		output: count(value.output_tokens),
		cacheRead: count(value.cache_read_input_tokens),
		cacheWrite: count(value.cache_creation_input_tokens),
	};
}

function blockStart(value: unknown): ClaudeContentBlockStart {
	const block = requireRecord(value, "content_block_start block");
	switch (block.type) {
		case "text":
			return { kind: "text" };
		case "thinking":
			return { kind: "thinking" };
		case "redacted_thinking":
			return { kind: "redacted_thinking", data: typeof block.data === "string" ? block.data : "" };
		case "tool_use":
			return {
				kind: "tool_use",
				id: requireString(block.id, "tool_use id"),
				name: requireString(block.name, "tool_use name"),
				input: block.input,
			};
		default:
			throw new ClaudeProtocolError(`Claude sent an unsupported content block "${String(block.type)}"`);
	}
}

function blockDelta(value: unknown): ClaudeContentDelta {
	const delta = requireRecord(value, "content_block_delta delta");
	switch (delta.type) {
		case "text_delta":
			return { kind: "text", text: typeof delta.text === "string" ? delta.text : "" };
		case "thinking_delta":
			return { kind: "thinking", thinking: typeof delta.thinking === "string" ? delta.thinking : "" };
		case "signature_delta":
			return { kind: "signature", signature: typeof delta.signature === "string" ? delta.signature : "" };
		case "input_json_delta":
			return { kind: "input_json", partialJson: typeof delta.partial_json === "string" ? delta.partial_json : "" };
		default:
			throw new ClaudeProtocolError(`Claude sent an unsupported content delta "${String(delta.type)}"`);
	}
}

function streamEvent(value: unknown): ClaudeStreamEvent | undefined {
	const event = requireRecord(value, "stream_event event");
	switch (event.type) {
		case "message_start":
			return { type: "message_start", usage: usage(record(event.message) ? event.message.usage : undefined) };
		case "content_block_start":
			return { type: "content_block_start", index: index(event.index, "content_block_start"), block: blockStart(event.content_block) };
		case "content_block_delta":
			return { type: "content_block_delta", index: index(event.index, "content_block_delta"), delta: blockDelta(event.delta) };
		case "content_block_stop":
			return { type: "content_block_stop", index: index(event.index, "content_block_stop") };
		case "message_delta": {
			const stopReason = record(event.delta) && typeof event.delta.stop_reason === "string" ? event.delta.stop_reason : undefined;
			return { type: "message_delta", stopReason, usage: usage(event.usage) };
		}
		case "message_stop":
			return { type: "message_stop" };
		default:
			return undefined; // Anthropic adds event types; unknown ones are not corruption.
	}
}

function assistantBlocks(value: unknown): ClaudeAssistantBlock[] {
	if (!Array.isArray(value)) throw new ClaudeProtocolError("Claude assistant message has no content list");
	const blocks: ClaudeAssistantBlock[] = [];
	for (const item of value) {
		const block = requireRecord(item, "assistant content block");
		if (block.type === "text") blocks.push({ kind: "text", text: typeof block.text === "string" ? block.text : "" });
		else if (block.type === "thinking") {
			blocks.push({
				kind: "thinking",
				thinking: typeof block.thinking === "string" ? block.thinking : "",
				signature: typeof block.signature === "string" ? block.signature : undefined,
			});
		} else if (block.type === "tool_use") {
			blocks.push({ kind: "tool_use", id: requireString(block.id, "tool_use id"), name: requireString(block.name, "tool_use name"), input: block.input ?? {} });
		}
		// Other block types (e.g. redacted thinking) carry nothing the partial stream missed.
	}
	return blocks;
}

/** `aborted_tools`, `aborted_streaming`, ... all mean the turn was cancelled. */
function resultOutcome(frame: Record<string, unknown>): "success" | "error" | "aborted" {
	const terminal = typeof frame.terminal_reason === "string" ? frame.terminal_reason : "";
	if (terminal.startsWith("aborted")) return "aborted";
	if (frame.is_error === true) return "error";
	const subtype = typeof frame.subtype === "string" ? frame.subtype : "";
	if (subtype && subtype !== "success") return "error";
	return "success";
}

/**
 * Validate one already-JSON-parsed CLI frame. Returns `undefined` for frames
 * this layer ignores (user replays, control traffic, unknown event types).
 */
export function parseClaudeFrame(value: unknown): ClaudeFrame | undefined {
	const frame = requireRecord(value, "stream-json frame");
	switch (frame.type) {
		case "system":
			if (frame.subtype !== "init") return undefined;
			return { type: "init", sessionId: typeof frame.session_id === "string" ? frame.session_id : undefined };
		case "stream_event": {
			const event = streamEvent(frame.event);
			return event ? { type: "stream", event } : undefined;
		}
		case "assistant": {
			const message = requireRecord(frame.message, "assistant frame message");
			return {
				type: "assistant",
				blocks: assistantBlocks(message.content),
				stopReason: typeof message.stop_reason === "string" ? message.stop_reason : undefined,
				usage: usage(message.usage),
			};
		}
		case "result": {
			const outcome = resultOutcome(frame);
			const message = typeof frame.result === "string" && outcome !== "success" ? frame.result : undefined;
			return { type: "result", outcome, message, usage: usage(frame.usage) };
		}
		default:
			return undefined;
	}
}

/** Map an MCP facade tool name back to the pi tool name pi will execute. */
export function toPiToolName(name: string, tools: readonly Tool[]): string {
	const bare = name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
	if (tools.some((tool) => tool.name === bare)) return bare;
	const lower = bare.toLowerCase();
	return tools.find((tool) => tool.name.toLowerCase() === lower)?.name ?? bare;
}
