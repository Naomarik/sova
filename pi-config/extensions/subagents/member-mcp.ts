/**
 * Stdio MCP server that gives non-Pi team members (Claude Code workers) the
 * same member tools member.ts registers in Pi children. The parent launches it
 * through the worker's `--mcp-config` entry (server name "team", so Claude sees
 * the tools as mcp__team__team_msg etc.) with the member identity in
 * MEMBER_ENV. Every tool writes a request into this member's own mailbox
 * directory and waits for the parent's response; the parent performs the
 * delivery, steer or question surfacing and validates scope. Nothing here can
 * spawn, add or stop workers, and nothing here reaches another member's process.
 *
 * Hand-rolled JSON-RPC (initialize, ping, tools/list, tools/call and the two
 * notifications) so the child needs no dependency beyond node: the runtime
 * runs this .ts file directly. It must never import index.ts: a child that
 * loaded the manager could delegate recursively. Without a valid identity the
 * process exits without serving anything.
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
	MAX_MESSAGE_CHARS,
	MEMBER_ENV,
	REPORT_KINDS,
	awaitResponse,
	decodeMemberContext,
	memberToolNames,
	memberToolText,
	readInbox,
	requestId,
	writeRequest,
	type MailboxRequest,
	type MemberContext,
	type ReportKind,
} from "./mailbox.ts";

/** Server name in the worker's mcp.json; Claude prefixes every tool with `mcp__<name>__`. */
export const MCP_SERVER_NAME = "team";
export const MCP_PROTOCOL_VERSION = "2025-06-18";
const KNOWN_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", MCP_PROTOCOL_VERSION]);
export { MEMBER_TOOLS, ORCHESTRATOR_TOOLS, COORDINATOR_TOOLS, MONITOR_TOOLS, SUCCESSOR_TOOLS } from "./mailbox.ts";
/** How Claude addresses a member tool. */
export const mcpToolName = (tool: string): string => `mcp__${MCP_SERVER_NAME}__${tool}`;

export interface MemberMcpOptions {
	/** How long a tool waits for the parent's response; the parent's own deadlines are shorter. */
	timeoutMs?: number;
	pollMs?: number;
}
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_INBOX_LIMIT = 200;

export interface McpTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}
type JsonRpcId = string | number | null;
export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result?: unknown;
	error?: { code: number; message: string };
}
interface ToolResult {
	content: { type: "text"; text: string }[];
	isError?: boolean;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const message = (description: string) => ({ type: "string", minLength: 1, maxLength: MAX_MESSAGE_CHARS, description });

/** The tool surface this member really has (memberToolNames), with member.ts's texts. */
export function memberMcpTools(me: MemberContext): McpTool[] {
	const text = memberToolText(me);
	const schemas: Record<string, Record<string, unknown>> = {
		team_msg: {
			type: "object",
			properties: {
				to: { type: "string", minLength: 1, description: "Recipient role, worker ID (ag_NN), or \"all\"." },
				message: message("Message text."),
				...(me.duty === "monitor" ? { notice: { type: "string", enum: ["wrap-up", "pause", "resume"] } } : {}),
			},
			required: ["to", "message"],
			additionalProperties: false,
		},
		team_inbox: {
			type: "object",
			properties: { limit: { type: "integer", minimum: 1, maximum: MAX_INBOX_LIMIT, default: 50 } },
			additionalProperties: false,
		},
		team_ask: { type: "object", properties: { question: message(me.coordinated ? "The question for your team's coordinator." : "The question for the operator.") }, required: ["question"], additionalProperties: false },
		team_roster: { type: "object", properties: {}, additionalProperties: false },
		team_steer: {
			type: "object",
			properties: {
				to: { type: "string", minLength: 1, description: "Sibling role or worker ID (not yourself, not \"all\")." },
				message: message("Instructions for the sibling."),
				mode: { type: "string", enum: ["redirect", "followUp"] },
			},
			required: ["to", "message"],
			additionalProperties: false,
		},
		team_report: {
			type: "object",
			properties: { report: message("The milestone or concern."), kind: { type: "string", enum: [...REPORT_KINDS], description: "milestone or concern" } },
			required: ["report"],
			additionalProperties: false,
		},
		team_succeed: { type: "object", properties: { role: { type: "string", minLength: 1, description: "Role (or worker ID) of the member to succeed." } }, required: ["role"], additionalProperties: false },
		team_ready: { type: "object", properties: {}, additionalProperties: false },
		wake_nudge: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["schedule", "list", "cancel"], description: "What to do" },
				delay: { type: "string", description: "Relative delay, e.g. 5m" },
				at: { type: "string", description: "Absolute ISO-8601 fire time" },
				reason: { type: "string", description: "What to do on wake" },
				id: { type: "string", description: "Nudge id to cancel" },
			},
			required: ["action"],
			additionalProperties: false,
		},
	};
	// The order Claude lists them in: the common tools, then each duty's additions.
	const order = ["team_msg", "team_inbox", "team_ask", "team_roster", "team_steer", "team_report", "team_succeed", "team_ready", "wake_nudge"];
	const names = new Set(memberToolNames(me));
	return order.filter((name) => names.has(name)).map((name) => ({ name, description: text[name as keyof typeof text], inputSchema: schemas[name] }));
}

class ParamError extends Error {}
function line(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || !value.trim()) throw new ParamError(`${key} must be a non-blank string.`);
	return value;
}
function text(params: Record<string, unknown>, key: string): string {
	const value = line(params, key);
	if (value.length > MAX_MESSAGE_CHARS) throw new ParamError(`${key} exceeds ${MAX_MESSAGE_CHARS} characters.`);
	return value;
}

/**
 * Protocol core, separated from stdio so tests drive it with plain objects.
 * `handle` returns the response for a request, or undefined for a notification.
 */
export function createMemberMcpServer(me: MemberContext, options: MemberMcpOptions = {}) {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const tools = memberMcpTools(me);
	const inFlight = new Map<string, AbortController>();
	const keyOf = (id: JsonRpcId) => `${typeof id}:${String(id)}`;
	const send = async (request: Omit<MailboxRequest, "version" | "id" | "at">, signal: AbortSignal): Promise<string> => {
		signal.throwIfAborted();
		const full: MailboxRequest = { version: 1, id: requestId(), at: Date.now(), ...request };
		writeRequest(me.dir, full);
		const response = await awaitResponse(me.dir, full.id, timeoutMs, signal, options.pollMs);
		if (!response) {
			throw new Error(signal.aborted
				? "Cancelled while waiting for the parent session; the request may still be handled."
				: `No response from the parent session within ${Math.round(timeoutMs / 1000)}s; it may be shutting down. The request may still be handled; check team_inbox or retry once.`);
		}
		if (!response.ok) throw new Error(response.text);
		return response.text;
	};
	const call = async (name: string, params: Record<string, unknown>, signal: AbortSignal): Promise<string> => {
		switch (name) {
			case "team_msg": {
				const notice = params.notice;
				if (notice !== undefined && (me.duty !== "monitor" || !["wrap-up", "pause", "resume"].includes(notice as string))) throw new ParamError("notice must be wrap-up, pause or resume (monitor only).");
				return send({ type: "message", to: line(params, "to").trim(), message: text(params, "message"), ...(notice ? { notice: notice as "wrap-up" | "pause" | "resume" } : {}) }, signal);
			}
			case "team_inbox": {
				const limit = params.limit ?? 50;
				if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_INBOX_LIMIT) throw new ParamError(`limit must be an integer from 1 to ${MAX_INBOX_LIMIT}.`);
				const records = readInbox(me.dir, limit as number);
				return records.length
					? records.map((r) => `[${new Date(r.at).toISOString()}] ${r.kind} from ${r.from} (${r.fromId}):\n${r.text}`).join("\n\n")
					: "No messages delivered to you yet.";
			}
			case "team_ask":
				return send({ type: "question", message: text(params, "question") }, signal);
			case "team_roster":
				return send({ type: "roster" }, signal);
			case "team_steer": {
				const mode = params.mode;
				if (mode !== undefined && mode !== "redirect" && mode !== "followUp") throw new ParamError("mode must be redirect or followUp.");
				return send({ type: "steer", to: line(params, "to").trim(), message: text(params, "message"), ...(mode ? { mode } : {}) }, signal);
			}
			case "team_report": {
				const kind = params.kind;
				if (kind !== undefined && !REPORT_KINDS.includes(kind as ReportKind)) throw new ParamError("kind must be milestone or concern.");
				return send({ type: "report", message: text(params, "report"), ...(kind ? { reportKind: kind as ReportKind } : {}) }, signal);
			}
			case "team_succeed":
				return send({ type: "succeed", to: line(params, "role").trim() }, signal);
			case "team_ready":
				return send({ type: "ready" }, signal);
			case "wake_nudge": {
				const action = params.action;
				if (action !== "schedule" && action !== "list" && action !== "cancel") throw new ParamError("action must be schedule, list or cancel.");
				const opt = (key: string) => {
					const v = params[key];
					if (v === undefined) return {};
					if (typeof v !== "string") throw new ParamError(`${key} must be a string.`);
					return v.trim() ? { [key]: v } : {};
				};
				return send({ type: "nudge", nudge: { action, ...opt("delay"), ...opt("at"), ...opt("reason"), ...opt("id") } }, signal);
			}
			default:
				throw new ParamError(`Unknown tool: ${name}`);
		}
	};
	const toolsCall = async (id: JsonRpcId, params: unknown): Promise<ToolResult> => {
		if (!isRecord(params) || typeof params.name !== "string") throw new ParamError("tools/call needs a tool name.");
		if (!tools.some((t) => t.name === params.name)) return { content: [{ type: "text", text: `Unknown tool: ${params.name}` }], isError: true };
		const args = params.arguments ?? {};
		if (!isRecord(args)) throw new ParamError("tools/call arguments must be an object.");
		const controller = new AbortController();
		const key = keyOf(id);
		inFlight.set(key, controller);
		try {
			return { content: [{ type: "text", text: await call(params.name, args, controller.signal) }] };
		} catch (error) {
			return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
		} finally {
			if (inFlight.get(key) === controller) inFlight.delete(key);
		}
	};
	const handle = async (value: unknown): Promise<JsonRpcResponse | undefined> => {
		if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") {
			const id = isRecord(value) && (typeof value.id === "string" || typeof value.id === "number") ? value.id : null;
			return { jsonrpc: "2.0", id, error: { code: INVALID_REQUEST, message: "Invalid JSON-RPC request." } };
		}
		const { method, params } = value;
		const hasId = typeof value.id === "string" || typeof value.id === "number";
		const id = hasId ? (value.id as string | number) : null;
		if (!hasId) {
			// Notifications never get a response.
			if (method === "notifications/cancelled" && isRecord(params) && (typeof params.requestId === "string" || typeof params.requestId === "number"))
				inFlight.get(keyOf(params.requestId))?.abort();
			return undefined;
		}
		try {
			switch (method) {
				case "initialize": {
					const requested = isRecord(params) && typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
					return {
						jsonrpc: "2.0", id,
						result: {
							protocolVersion: requested && KNOWN_PROTOCOL_VERSIONS.has(requested) ? requested : MCP_PROTOCOL_VERSION,
							capabilities: { tools: {} },
							serverInfo: { name: "pi-subagents-team", version: "1.0.0" },
							instructions: `Team member tools for ${me.role} (${me.workerId}) in ${me.teamId}; every action is performed and scoped by the parent Pi session.`,
						},
					};
				}
				case "ping":
					return { jsonrpc: "2.0", id, result: {} };
				case "tools/list":
					return { jsonrpc: "2.0", id, result: { tools } };
				case "tools/call":
					return { jsonrpc: "2.0", id, result: await toolsCall(id, params) };
				default:
					return { jsonrpc: "2.0", id, error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` } };
			}
		} catch (error) {
			return { jsonrpc: "2.0", id, error: { code: error instanceof ParamError ? INVALID_PARAMS : -32603, message: error instanceof Error ? error.message : String(error) } };
		}
	};
	/** One newline-delimited line from the client. */
	const handleLine = async (raw: string): Promise<JsonRpcResponse | undefined> => {
		if (!raw.trim()) return undefined;
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			return { jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error." } };
		}
		return handle(value);
	};
	return { tools, handle, handleLine, pending: () => inFlight.size };
}

/** Serve newline-delimited JSON-RPC over the given streams; resolves when the input ends. */
export function serveMemberMcp(me: MemberContext, input: NodeJS.ReadableStream, output: NodeJS.WritableStream, options: MemberMcpOptions = {}): Promise<void> {
	const server = createMemberMcpServer(me, options);
	let buffer = "";
	const write = (response: JsonRpcResponse | undefined) => {
		if (response) output.write(`${JSON.stringify(response)}\n`);
	};
	return new Promise<void>((resolve) => {
		input.setEncoding?.("utf8");
		input.on("data", (chunk: string | Buffer) => {
			buffer += String(chunk);
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const raw = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				void server.handleLine(raw).then(write);
				newline = buffer.indexOf("\n");
			}
		});
		input.on("end", () => {
			if (buffer.trim()) void server.handleLine(buffer).then(write);
			buffer = "";
			resolve();
		});
		input.on("error", () => resolve());
	});
}

function isEntryScript(): boolean {
	try {
		return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isEntryScript()) {
	const me = decodeMemberContext(process.env[MEMBER_ENV]);
	if (!me) {
		process.stderr.write(`${MEMBER_ENV} is missing or malformed; this server only runs as a team member launched by the parent Pi session.\n`);
		process.exit(1);
	}
	// Claude (the client) owns this process: its EOF ends the server.
	void serveMemberMcp(me, process.stdin, process.stdout).then(() => process.exit(0));
}
