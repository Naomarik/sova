/**
 * The in-process MCP server pi's tools are served through.
 *
 * The CLI is launched with `--tools ''`, so it has no built-ins at all; every
 * tool the model can reach is one of pi's, published by this host as the
 * SDK-hosted server named in `initialize.sdkMcpServers`. There is no socket and
 * no child process: the CLI tunnels JSON-RPC over its own control channel as
 * `control_request` frames with `subtype: "mcp_message"`, and we answer each one
 * with a `control_response` carrying the server's reply under `mcp_response`.
 *
 * Two shapes here are not guesses; they were observed against CLI 2.1.278 and
 * are easy to get wrong:
 *   - A JSON-RPC *notification* (no `id`) still has to be answered. The CLI
 *     waits for the control_response, so a silent notification wedges the
 *     handshake. It is answered with a dummy `{jsonrpc, result: {}, id: 0}`.
 *   - `tools/call` arrives with a BARE tool name (`read`), while the model's
 *     `tool_use` block names the prefixed form (`mcp__pi__read`). So tools/list
 *     publishes bare names and the prefix only ever appears on the way back.
 *
 * `tools/call` is HELD: the reply is not sent when the call arrives. The bridge
 * surfaces it to pi as a tool call, pi executes it, and the result arrives on a
 * later provider call — see session-bridge.ts. That is why nothing in this file
 * has a timeout of its own; the bridge owns every held call's fate.
 */
import { toToolDeclaration, type Tool } from "@earendil-works/pi-ai";
import { PI_MCP_SERVER_NAME } from "./types.ts";

/** The protocol version echoed back when the CLI does not name one. */
export const MCP_FALLBACK_PROTOCOL_VERSION = "2025-11-25";
export const PI_MCP_SERVER_VERSION = "0.1.0";

/** MCP content blocks we produce. Image data is base64, as pi stores it. */
export type McpContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export interface McpToolResult {
	content: McpContent[];
	isError?: boolean;
}

/** A `tools/call` waiting for pi to run the tool. */
export interface HeldMcpCall {
	/** The CLI control_request id this call must be answered through. */
	requestId: string;
	/** The JSON-RPC id inside the MCP message; echoed in the reply. */
	rpcId: unknown;
	/** Bare pi tool name, as it arrived. */
	name: string;
	arguments: Record<string, unknown>;
}

export interface McpHostHooks {
	/** pi's tools for the current turn; re-read on every `tools/list`. */
	tools(): readonly Tool[];
	/** Send a success control_response. Returns false when the child is gone. */
	respond(requestId: string, response: unknown): boolean;
	/** Send an error control_response (protocol-level, not a tool failure). */
	respondError(requestId: string, error: string): boolean;
	/** A `tools/call` is now held and must eventually be settled. */
	onHeldCall(call: HeldMcpCall): void;
	/** The CLI sent something this host cannot make sense of. */
	onProtocolError(message: string): void;
}

interface JsonRpcMessage {
	jsonrpc?: unknown;
	id?: unknown;
	method?: unknown;
	params?: unknown;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** MCP's JSON-RPC error codes, the two this host can produce. */
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/**
 * A tool's JSON Schema as the model should see it.
 *
 * The `toToolDeclaration` round-trip is load-bearing rather than cosmetic: pi's
 * `Tool.parameters` is a typebox schema carrying symbol keys and `undefined`
 * fields, and serializing it directly leaks or drops them. `toToolDeclaration`
 * does the JSON round-trip that normalizes both away.
 */
function inputSchema(tool: Tool): Record<string, unknown> {
	const declared = toToolDeclaration(tool).parameters as unknown;
	if (record(declared)) return declared;
	// A tool with no usable schema still has to be callable.
	return { type: "object", properties: {} };
}

export class PiMcpHost {
	readonly serverName: string;
	private readonly hooks: McpHostHooks;
	/** Echoed back on `initialize`; the CLI rejects a version it did not offer. */
	private protocolVersion = MCP_FALLBACK_PROTOCOL_VERSION;
	private initialized = false;

	constructor(hooks: McpHostHooks, serverName: string = PI_MCP_SERVER_NAME) {
		this.hooks = hooks;
		this.serverName = serverName;
	}

	/** True once the CLI has completed the MCP handshake against this host. */
	isInitialized(): boolean { return this.initialized; }

	/**
	 * Offer one decoded CLI frame to the host. Returns true when the frame was an
	 * `mcp_message` for this server and has been dealt with, so the caller knows
	 * not to treat it as an unhandled control request.
	 */
	handleFrame(frame: Record<string, unknown>): boolean {
		if (frame.type !== "control_request") return false;
		const request = frame.request;
		if (!record(request) || request.subtype !== "mcp_message") return false;
		if (request.server_name !== this.serverName) return false;
		const requestId = frame.request_id;
		if (typeof requestId !== "string") {
			this.hooks.onProtocolError("Claude sent an mcp_message with no request_id");
			return true;
		}
		if (!record(request.message)) {
			this.hooks.respondError(requestId, "mcp_message carried no JSON-RPC message");
			return true;
		}
		this.dispatch(requestId, request.message as JsonRpcMessage);
		return true;
	}

	/** Settle a held call with pi's result. */
	answer(call: HeldMcpCall, result: McpToolResult): boolean {
		return this.reply(call.requestId, { jsonrpc: "2.0", id: call.rpcId, result });
	}

	/**
	 * Settle a held call as a tool failure. A failed tool is not a failed turn —
	 * the CLI reports `is_error` on the tool_result and lets the model continue —
	 * so this stays inside the JSON-RPC `result`, not its `error`.
	 */
	fail(call: HeldMcpCall, message: string): boolean {
		return this.answer(call, { content: [{ type: "text", text: message }], isError: true });
	}

	private dispatch(requestId: string, message: JsonRpcMessage): void {
		const method = typeof message.method === "string" ? message.method : undefined;
		// A notification has no id, but the CLI still blocks on the control
		// response, so it gets the dummy reply rather than silence.
		const isNotification = message.id === undefined || message.id === null;
		if (!method) {
			// A response to something we sent: we send no requests, so acknowledge.
			this.reply(requestId, this.dummy());
			return;
		}
		if (isNotification) {
			if (method === "notifications/initialized") this.initialized = true;
			this.reply(requestId, this.dummy());
			return;
		}
		switch (method) {
			case "initialize":
				this.reply(requestId, { jsonrpc: "2.0", id: message.id, result: this.initializeResult(message.params) });
				return;
			case "ping":
				this.reply(requestId, { jsonrpc: "2.0", id: message.id, result: {} });
				return;
			case "tools/list":
				this.reply(requestId, { jsonrpc: "2.0", id: message.id, result: { tools: this.toolList() } });
				return;
			case "tools/call":
				this.hold(requestId, message);
				return;
			default:
				this.reply(requestId, {
					jsonrpc: "2.0", id: message.id,
					error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` },
				});
				return;
		}
	}

	private initializeResult(params: unknown): Record<string, unknown> {
		// Echo the version the CLI offered: answering with a different one makes
		// it treat the server as incompatible.
		if (record(params) && typeof params.protocolVersion === "string" && params.protocolVersion) {
			this.protocolVersion = params.protocolVersion;
		}
		return {
			protocolVersion: this.protocolVersion,
			capabilities: { tools: { listChanged: false } },
			serverInfo: { name: this.serverName, version: PI_MCP_SERVER_VERSION },
		};
	}

	/**
	 * Generated fresh on every request, never cached: pi's tool set is per turn,
	 * and extension-registered tools appear here for free because they are
	 * already in what `getCurrentTools` resolved.
	 */
	private toolList(): Record<string, unknown>[] {
		return this.hooks.tools().map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: inputSchema(tool),
		}));
	}

	private hold(requestId: string, message: JsonRpcMessage): void {
		const params = record(message.params) ? message.params : undefined;
		const name = params && typeof params.name === "string" ? params.name : undefined;
		if (!name) {
			this.reply(requestId, {
				jsonrpc: "2.0", id: message.id,
				error: { code: INVALID_PARAMS, message: "tools/call has no tool name" },
			});
			return;
		}
		this.hooks.onHeldCall({
			requestId,
			rpcId: message.id,
			name,
			arguments: record(params?.arguments) ? (params!.arguments as Record<string, unknown>) : {},
		});
	}

	/** The acknowledgment shape the CLI expects for a message with no reply of its own. */
	private dummy(): Record<string, unknown> {
		return { jsonrpc: "2.0", result: {}, id: 0 };
	}

	private reply(requestId: string, mcpResponse: unknown): boolean {
		return this.hooks.respond(requestId, { mcp_response: mcpResponse });
	}
}
