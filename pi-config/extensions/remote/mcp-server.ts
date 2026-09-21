/**
 * Stdio MCP server that gives a Claude Code worker the tools of a remote session: every
 * operation runs inside the target (ssh → SSM → docker exec), never on this machine. The
 * parent launches it through the worker's `--mcp-config` entry (server name "remote", so
 * Claude sees `mcp__remote__remote_bash` etc.) with the target identity in REMOTE_MCP_ENV.
 *
 * Hand-rolled JSON-RPC (initialize, ping, tools/list, tools/call and the two notifications)
 * exactly like subagents/member-mcp.ts, so the child needs no dependency beyond node: the
 * runtime runs this .ts file directly. It must never import ./index.ts: that is the pi
 * extension (pi runtime, tool registration, mount branches); only the pi-free modules
 * (workers/argv/far/connection, and channel/exec through them) may be loaded here.
 *
 * Fail closed: without a valid identity the process exits without serving, and a target that
 * cannot be reached produces tool errors naming it. Nothing here ever touches the local
 * filesystem except reading the credential-free targets.json.
 *
 * Two facts about the client shape everything below (measured against Claude Code 2.1.278):
 *  - `initialize` is bounded by MCP_TIMEOUT (30 s) and a cold channel costs ~9 s, so the
 *    handshake and tools/list are static: the connection is pinned lazily on the first call.
 *  - This process's stderr never reaches the user (it goes to Claude's own MCP log), so every
 *    diagnostic — ssh failure, far stderr, exit code — must travel in the tool result text.
 */
import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { shPath, shQuote } from "./argv.ts";
// Type-only: erased at runtime, so connection.ts is still loaded lazily, at the first call.
import type { ConnectionDeps } from "./connection.ts";
import {
	REMOTE_MCP_ENV,
	REMOTE_MCP_SERVER_NAME,
	decodeRemoteMcpIdentity,
	remoteWorkerInstructions,
	type RemoteMcpIdentity,
} from "./workers.ts";

export { REMOTE_MCP_ENV, REMOTE_MCP_SERVER_NAME } from "./workers.ts";
export const MCP_PROTOCOL_VERSION = "2025-06-18";
/** Claude 2.1.278 offers 2025-11-25; an unknown version falls back rather than echoing the client's. */
const KNOWN_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", MCP_PROTOCOL_VERSION, "2025-11-25"]);
/** How Claude addresses one of these tools. */
export const mcpToolName = (tool: string): string => `mcp__${REMOTE_MCP_SERVER_NAME}__${tool}`;

/** Far-side deadlines. A build outlives the file tools, so it gets its own, caller-settable. */
export const BASH_TIMEOUT_SEC = 120;
export const BASH_MAX_TIMEOUT_SEC = 600;
export const FILE_TIMEOUT_MS = 60_000;
/** Output an LLM gets before truncation; far-side read is capped tighter, on the box. */
export const MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_STDERR_BYTES = 8 * 1024;
export const MAX_READ_BYTES = 256 * 1024;
/** One far line an LLM gets whole: a minified bundle must not become the whole context. */
export const MAX_LINE_CHARS = 2000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
/** Far exit codes reserved by the read/edit guards (see far.ts). */
export const EXIT_NO_FILE = 66;
export const EXIT_UNREADABLE = 67;
export const EXIT_IS_DIRECTORY = 68;

/** What a tool needs of a remote connection. `Connection` (connection.ts) satisfies it; tests pass a fake. */
export interface RemoteTransport {
	/** The target as the user names it, for error text. */
	readonly label: string;
	/** Far `$HOME`, for `~` resolution; may require a round trip, so it is never called during the handshake. */
	home(signal?: AbortSignal): Promise<string | undefined>;
	/** One far command, stdout and stderr kept apart. Never called concurrently: the channel does not queue. */
	run(command: string, options: RunOptions): Promise<TransportResult>;
	/** A user command with the two streams merged, as a terminal would show it. Runs per call, off the channel. */
	bash(command: string, cwd: string | undefined, options: BashOptions): Promise<TransportResult>;
	dispose(): void;
}
export interface RunOptions {
	cwd?: string;
	input?: Buffer | string;
	timeoutMs?: number;
	signal?: AbortSignal;
}
export interface BashOptions {
	timeoutSec: number;
	signal?: AbortSignal;
	onData?: (chunk: Buffer) => void;
}
export interface TransportResult {
	exitCode: number | null;
	stdout: Buffer;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
}

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
const INTERNAL_ERROR = -32603;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
class ParamError extends Error {}

function str(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || !value.trim()) throw new ParamError(`${key} must be a non-blank string.`);
	return value;
}
function optionalStr(params: Record<string, unknown>, key: string): string | undefined {
	const value = params[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) throw new ParamError(`${key} must be a non-blank string.`);
	return value;
}
function content(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string") throw new ParamError(`${key} must be a string.`);
	return value;
}
function int(params: Record<string, unknown>, key: string, min: number, max: number, fallback?: number): number | undefined {
	const value = params[key];
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
		throw new ParamError(`${key} must be an integer from ${min} to ${max}.`);
	}
	return value as number;
}
function bool(params: Record<string, unknown>, key: string): boolean | undefined {
	const value = params[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new ParamError(`${key} must be true or false.`);
	return value;
}

/**
 * The tool surface, in the order Claude lists it. Descriptions say where the tools run: the
 * worker's own cwd is an empty placeholder, and a model that forgets reaches for a local path.
 */
export function remoteMcpTools(id: Pick<RemoteMcpIdentity, "target" | "farCwd" | "label">): McpTool[] {
	const where = `on the remote target ${id.label ? `${id.label} (${id.target})` : id.target}`;
	const paths = `Paths are the target's: relative to ${id.farCwd}, and ~ is the target's home.`;
	const object = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> =>
		({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
	const path = (what: string) => ({ type: "string", description: `Far path to ${what}. ${paths}` });
	const limit = { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `Maximum entries to return (default ${DEFAULT_LIMIT}).` };
	return [
		{
			name: "remote_bash",
			description: `Run a shell command ${where}. This worker has NO local shell; everything runs inside the target. `
				+ `Output is stdout and stderr merged, as a terminal shows them. ${paths}`,
			inputSchema: object({
				command: { type: "string", description: "Shell command to run on the target." },
				cwd: { type: "string", description: `Far directory to run in (default ${id.farCwd}).` },
				timeout: { type: "integer", minimum: 1, maximum: BASH_MAX_TIMEOUT_SEC, description: `Seconds before the command is killed (default ${BASH_TIMEOUT_SEC}, max ${BASH_MAX_TIMEOUT_SEC}). Background anything longer.` },
			}, ["command"]),
		},
		{
			name: "remote_read",
			description: `Read a file ${where}. This worker has NO local file tools. Output is line-numbered, so line numbers can be quoted back. ${paths}`,
			inputSchema: object({
				path: path("read"),
				offset: { type: "integer", minimum: 1, description: "First line to read (1-based)." },
				limit: { type: "integer", minimum: 1, description: "How many lines to read." },
			}, ["path"]),
		},
		{
			name: "remote_write",
			description: `Create or overwrite a file ${where}, making parent directories as needed. ${paths}`,
			inputSchema: object({
				path: path("write"),
				content: { type: "string", description: "Full new contents of the file." },
			}, ["path", "content"]),
		},
		{
			name: "remote_edit",
			description: `Replace exact text in a file ${where}. oldText must appear exactly once unless replaceAll is set. ${paths}`,
			inputSchema: object({
				path: path("edit"),
				oldText: { type: "string", description: "Exact text to replace, with enough context to be unique." },
				newText: { type: "string", description: "Replacement text." },
				replaceAll: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one." },
			}, ["path", "oldText", "newText"]),
		},
		{
			name: "remote_ls",
			description: `List a directory ${where}. ${paths}`,
			inputSchema: object({ path: { type: "string", description: `Far directory (default ${id.farCwd}). ${paths}` }, limit }),
		},
		{
			name: "remote_find",
			description: `Find files by glob ${where} (.git and node_modules are skipped). ${paths}`,
			inputSchema: object({
				pattern: { type: "string", description: 'Glob such as "**/*.ts" or "Dockerfile".' },
				path: { type: "string", description: `Far directory to search (default ${id.farCwd}). ${paths}` },
				limit,
			}, ["pattern"]),
		},
		{
			name: "remote_grep",
			description: `Search file contents ${where} (ripgrep when present, else grep). ${paths}`,
			inputSchema: object({
				pattern: { type: "string", description: "Regular expression, or literal text with literal set." },
				path: { type: "string", description: `Far file or directory to search (default ${id.farCwd}). ${paths}` },
				glob: { type: "string", description: 'Only search files matching this glob, e.g. "*.ts".' },
				ignoreCase: { type: "boolean", description: "Case-insensitive search." },
				literal: { type: "boolean", description: "Treat the pattern as literal text, not a regex." },
				context: { type: "integer", minimum: 1, maximum: 20, description: "Lines of context around each match." },
				filesOnly: { type: "boolean", description: "List matching file names only." },
				limit,
			}, ["pattern"]),
		},
	];
}

/** Keep the start: a file or a listing is read top-down. */
function clipHead(text: string, max = MAX_OUTPUT_BYTES): { text: string; truncated: boolean } {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= max) return { text, truncated: false };
	return { text: bytes.subarray(0, max).toString("utf8"), truncated: true };
}
/** Keep the end: a failing build says why on its last lines. */
function clipTail(text: string, max = MAX_OUTPUT_BYTES): { text: string; truncated: boolean } {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= max) return { text, truncated: false };
	return { text: bytes.subarray(bytes.length - max).toString("utf8"), truncated: true };
}
/** One 300 KB minified line would swamp the context even under the byte cap. */
function clipLines(text: string): { text: string; truncated: boolean } {
	let truncated = false;
	const lines = text.split("\n").map((line) => {
		if (line.length <= MAX_LINE_CHARS) return line;
		truncated = true;
		return `${line.slice(0, MAX_LINE_CHARS)}… [line truncated, ${line.length} chars]`;
	});
	return { text: lines.join("\n"), truncated };
}
/** Replacement characters in place of a file's bytes only mislead; say what it is instead. */
const looksBinary = (bytes: Buffer): boolean => bytes.includes(0);

/**
 * stdout, then stderr kept apart and labelled (an LLM misreads merged streams), then one
 * bracketed trailer for exit code, truncation and reconnection. `isError` on anything the
 * model must react to, since it cannot see this process's stderr.
 */
function formatResult(result: TransportResult, options: { label?: string; keepTail?: boolean } = {}): ToolResult {
	const clip = options.keepTail ? clipTail : clipHead;
	const out = clip(result.stdout.toString("utf8").replace(/\n$/, ""));
	const lines = clipLines(out.text);
	const err = clipHead(result.stderr.trim(), MAX_STDERR_BYTES);
	const parts: string[] = [];
	if (lines.text) parts.push(lines.text);
	if (err.text) parts.push(`[stderr]\n${err.text}`);
	const notes: string[] = [];
	if (result.timedOut) notes.push("timed out");
	if (result.aborted) notes.push("cancelled");
	if (result.exitCode !== 0) notes.push(`exit code ${result.exitCode ?? "none (killed)"}`);
	if (out.truncated || err.truncated) notes.push(`output truncated to ${MAX_OUTPUT_BYTES / 1024} KB (${options.keepTail ? "start" : "end"} dropped)`);
	if (lines.truncated) notes.push("long lines truncated");
	if (!parts.length && !notes.length) notes.push("no output, exit code 0");
	const prefix = options.label ? `${options.label}: ` : "";
	const trailer = notes.length ? `\n\n[${prefix}${notes.join("; ")}]` : "";
	// Only the end is tidied: read's line numbers are leading whitespace that must survive.
	return {
		content: [{ type: "text", text: `${parts.join("\n")}${trailer}`.replace(/\s+$/, "") }],
		...(result.exitCode !== 0 || result.timedOut || result.aborted ? { isError: true } : {}),
	};
}
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const failed = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** Far exit codes the read guard reserves, turned into the prose pi's own tools use. */
function guardMessage(result: TransportResult, path: string, label: string): ToolResult | undefined {
	if (result.exitCode === EXIT_NO_FILE) return failed(`${label}: no such file on the target: ${path}`);
	if (result.exitCode === EXIT_UNREADABLE) return failed(`${label}: not readable on the target: ${path}`);
	if (result.exitCode === EXIT_IS_DIRECTORY) return failed(`${label}: is a directory on the target: ${path}`);
	return undefined;
}

/**
 * Far scripts. The read/write/edit guards mirror remote/index.ts's operations (same exit codes,
 * same prose) so both backends behave alike; listing and search are composed here because their
 * shape is the MCP tool's, not the pi operation's.
 */
const readScript = (far: string, offset: number, limit: number | undefined): string => {
	const slice = limit ? `sed -n '${offset},${offset + limit - 1}p'` : offset > 1 ? `tail -n +${offset}` : "cat";
	const f = shPath(far);
	return `f=${f}; [ -e "$f" ] || exit ${EXIT_NO_FILE}; [ -d "$f" ] && exit ${EXIT_IS_DIRECTORY}; [ -r "$f" ] || exit ${EXIT_UNREADABLE}; `
		+ `<"$f" ${slice} | head -c ${MAX_READ_BYTES}`;
};
/** Whole-file read for edit: the server does the replacement, so no far-side interpreter is needed. */
const slurpScript = (far: string): string => {
	const f = shPath(far);
	return `f=${f}; [ -e "$f" ] || exit ${EXIT_NO_FILE}; [ -d "$f" ] && exit ${EXIT_IS_DIRECTORY}; [ -r "$f" ] || exit ${EXIT_UNREADABLE}; cat -- "$f"`;
};
/** Content arrives on stdin, never inside the script: no size limit and nothing to quote. */
const writeScript = (far: string): string => {
	const f = shPath(far);
	return `f=${f}; d=$(dirname -- "$f"); mkdir -p -- "$d" || exit 1; cat > "$f" || exit 1; wc -c < "$f"`;
};
const lsScript = (far: string, limit: number): string =>
	`p=${shPath(far)}; [ -e "$p" ] || exit ${EXIT_NO_FILE}; [ -d "$p" ] || exit ${EXIT_IS_DIRECTORY}; `
	+ `cd -- "$p" || exit ${EXIT_UNREADABLE}; ls -Ap | head -n ${limit + 1}`;
const findScript = (far: string, pattern: string, limit: number): string =>
	`p=${shPath(far)}; [ -d "$p" ] || exit ${EXIT_NO_FILE}; cd -- "$p" || exit ${EXIT_UNREADABLE}; `
	+ `find . \\( -name .git -o -name node_modules \\) -prune -o -type f -path ${shQuote(pattern.startsWith("/") ? pattern : `./${pattern.replace(/^\.\//, "")}`)} -print `
	+ `| sed 's|^\\./||' | head -n ${limit + 1}`;
function grepScript(far: string, p: { pattern: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; filesOnly?: boolean }, limit: number): string {
	const rg = ["rg", "--color=never", "--hidden", "-g", "'!.git'", "-g", "'!node_modules'"];
	const gr = ["grep", "-rI", "--exclude-dir=.git", "--exclude-dir=node_modules"];
	if (p.filesOnly) { rg.push("-l"); gr.push("-l"); }
	else {
		rg.push("-n", "-H", "--no-heading"); gr.push("-n", "-H");
		if (p.context) { rg.push("-C", String(p.context)); gr.push("-C", String(p.context)); }
	}
	if (p.ignoreCase) { rg.push("-i"); gr.push("-i"); }
	if (p.literal) { rg.push("-F"); gr.push("-F"); } else { gr.push("-E"); }
	if (p.glob) { rg.push("--glob", shQuote(p.glob)); gr.push(`--include=${shQuote(p.glob.replace(/^(\*\*\/)+/, ""))}`); }
	const tail = `-- ${shQuote(p.pattern)} "$@"`;
	return `p=${shPath(far)}; if [ -d "$p" ]; then cd -- "$p" || exit ${EXIT_UNREADABLE}; set -- .; `
		+ `else [ -e "$p" ] || exit ${EXIT_NO_FILE}; cd -- "$(dirname -- "$p")" || exit ${EXIT_UNREADABLE}; set -- "$(basename -- "$p")"; fi; `
		+ `if command -v rg >/dev/null 2>&1; then ${rg.join(" ")} ${tail}; else ${gr.join(" ")} ${tail}; fi | head -n ${limit + 1}`;
}

/** `~` is the target's home, a relative path is relative to the session's far cwd. */
export function resolveFarPath(arg: string | undefined, farCwd: string, farHome: string | undefined): string {
	const value = arg?.trim() || ".";
	if (value === "~" || value.startsWith("~/")) {
		if (!farHome) throw new ParamError("The target's home directory is not known yet; use an absolute path.");
		return value === "~" ? farHome : `${farHome.replace(/\/$/, "")}/${value.slice(2)}`;
	}
	if (value.startsWith("/")) return value;
	return `${farCwd.replace(/\/$/, "")}/${value === "." ? "" : value}`.replace(/\/$/, "") || "/";
}

export interface RemoteMcpDeps {
	/** Built lazily on the first call when absent, so `initialize` never touches the network. */
	connection?: RemoteTransport;
	connect?: () => RemoteTransport | Promise<RemoteTransport>;
	/** Hands the caller the server `serveRemoteMcp` created, so a signal handler can dispose it. */
	onServer?: (server: RemoteMcpServer) => void;
}

/**
 * The protocol core, independent of any transport. `handle` answers one parsed request (or
 * nothing, for a notification); `handleLine` takes one newline-delimited line.
 */
export function createRemoteMcpServer(id: RemoteMcpIdentity, deps: RemoteMcpDeps = {}) {
	const tools = remoteMcpTools(id);
	const inFlight = new Map<string, AbortController>();
	const keyOf = (rpcId: JsonRpcId) => `${typeof rpcId}:${String(rpcId)}`;
	let transport: Promise<RemoteTransport> | undefined = deps.connection ? Promise.resolve(deps.connection) : undefined;
	let opened: RemoteTransport | undefined = deps.connection;
	/** The channel serves one command at a time and never queues, so far calls are serialized here. */
	let chain: Promise<unknown> = Promise.resolve();
	/** A file must not be read and written by two edits at once. */
	const perPath = new Map<string, Promise<unknown>>();

	const connection = async (): Promise<RemoteTransport> => {
		if (!transport) {
			const connect = deps.connect;
			if (!connect) throw new Error(`no connection to ${id.label ?? id.target} is configured`);
			// A failed open must not be cached: the next call gets a fresh attempt.
			transport = Promise.resolve().then(connect).catch((error) => { transport = undefined; throw error; });
		}
		opened = await transport;
		return opened;
	};
	const serialize = <T>(work: () => Promise<T>): Promise<T> => {
		const next = chain.then(work, work);
		chain = next.then(() => undefined, () => undefined);
		return next;
	};
	const serializePath = <T>(path: string, work: () => Promise<T>): Promise<T> => {
		const previous = perPath.get(path) ?? Promise.resolve();
		const next = previous.then(work, work);
		perPath.set(path, next.then(() => undefined, () => undefined));
		void next.catch(() => undefined).then(() => { if (perPath.get(path) === undefined) perPath.delete(path); });
		return next;
	};
	/** Every failure the transport can raise becomes prose naming the target: this stderr is invisible. */
	const describeFailure = (error: unknown): string => {
		const message = error instanceof Error ? error.message : String(error);
		// A failed probe is cached for 15s and `ready()` — the first thing every tool does —
		// rethrows it verbatim, so an immediate retry returns this same text in milliseconds.
		// Unsaid, that reads as flakiness and invites a retry loop. Only the unreachable case
		// holds: a refused login backs the channel off while per-call ssh keeps working.
		if (message.includes("is unreachable:")) {
			return `${message} (this target is held down for up to 15s after a failed probe; retrying sooner returns this same error — wait, or tell the user)`;
		}
		return `Could not reach ${id.label ?? id.target}: ${message}`;
	};
	const run = (command: string, options: RunOptions): Promise<TransportResult> =>
		serialize(async () => (await connection()).run(command, { timeoutMs: FILE_TIMEOUT_MS, ...options }));

	const far = async (arg: string | undefined, signal: AbortSignal): Promise<string> =>
		resolveFarPath(arg, id.farCwd, arg?.trim().startsWith("~") ? await (await connection()).home(signal) : undefined);

	const call = async (name: string, params: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> => {
		switch (name) {
			case "remote_bash": {
				const command = str(params, "command");
				const cwd = optionalStr(params, "cwd");
				const timeoutSec = int(params, "timeout", 1, BASH_MAX_TIMEOUT_SEC, BASH_TIMEOUT_SEC)!;
				const chunks: Buffer[] = [];
				let bytes = 0;
				// Merged mode: the far side's stderr is the command's, and a build's tail is the
				// part that matters, so we buffer everything and drop the start if it overflows.
				const result = await (await connection()).bash(command, cwd ? await far(cwd, signal) : id.farCwd, {
					timeoutSec, signal,
					onData: (chunk) => { chunks.push(chunk); bytes += chunk.length; while (bytes > MAX_OUTPUT_BYTES * 2 && chunks.length > 1) bytes -= chunks.shift()!.length; },
				});
				return formatResult({ ...result, stdout: Buffer.concat(chunks), stderr: "" }, { keepTail: true });
			}
			case "remote_read": {
				const path = await far(str(params, "path"), signal);
				const offset = int(params, "offset", 1, Number.MAX_SAFE_INTEGER, 1)!;
				const limit = int(params, "limit", 1, Number.MAX_SAFE_INTEGER);
				const result = await run(readScript(path, offset, limit), { signal });
				const guard = guardMessage(result, path, "read");
				if (guard) return guard;
				if (result.exitCode !== 0) return formatResult(result, { label: "read" });
				if (looksBinary(result.stdout)) return failed(`read: ${path} looks like a binary file (${result.stdout.length} bytes read); use remote_bash if you need to inspect it.`);
				const body = result.stdout.toString("utf8");
				if (!body) return ok(`${path} is empty.`);
				const numbered = body.replace(/\n$/, "").split("\n").map((line, i) => `${String(offset + i).padStart(5)}\t${line}`).join("\n");
				return formatResult({ ...result, stdout: Buffer.from(numbered, "utf8"), stderr: "" }, { label: "read" });
			}
			case "remote_write": {
				const path = await far(str(params, "path"), signal);
				const body = content(params, "content");
				return serializePath(path, async () => {
					const result = await run(writeScript(path), { input: body, signal });
					if (result.exitCode !== 0) return formatResult(result, { label: "write" });
					return ok(`Wrote ${path} on ${id.label ?? id.target} (${result.stdout.toString().trim()} bytes).`);
				});
			}
			case "remote_edit": {
				const path = await far(str(params, "path"), signal);
				const oldText = content(params, "oldText");
				const newText = content(params, "newText");
				const replaceAll = bool(params, "replaceAll") ?? false;
				if (!oldText) throw new ParamError("oldText must not be empty; use remote_write to create a file.");
				// Read, replace here, write back: no far-side interpreter is assumed to exist.
				return serializePath(path, async () => {
					const current = await run(slurpScript(path), { signal });
					const guard = guardMessage(current, path, "edit");
					if (guard) return guard;
					if (current.exitCode !== 0) return formatResult(current, { label: "edit" });
					if (looksBinary(current.stdout)) return failed(`edit: ${path} looks like a binary file; refusing to rewrite it.`);
					const before = current.stdout.toString("utf8");
					const occurrences = before.split(oldText).length - 1;
					if (occurrences === 0) return failed(`edit: oldText not found in ${path}. Read the file and copy the exact text, including indentation.`);
					if (occurrences > 1 && !replaceAll) return failed(`edit: oldText appears ${occurrences} times in ${path}. Add surrounding context to make it unique, or set replaceAll.`);
					const after = replaceAll ? before.split(oldText).join(newText) : before.replace(oldText, newText);
					const written = await run(writeScript(path), { input: after, signal });
					if (written.exitCode !== 0) return formatResult(written, { label: "edit" });
					return ok(`Edited ${path} on ${id.label ?? id.target} (${replaceAll ? occurrences : 1} replacement${(replaceAll ? occurrences : 1) === 1 ? "" : "s"}).`);
				});
			}
			case "remote_ls": {
				const path = await far(optionalStr(params, "path"), signal);
				const limit = int(params, "limit", 1, MAX_LIMIT, DEFAULT_LIMIT)!;
				const result = await run(lsScript(path, limit), { signal });
				const guard = guardMessage(result, path, "ls");
				if (guard) return guard;
				if (result.exitCode !== 0) return formatResult(result, { label: "ls" });
				return listing(result, limit, `${path} is empty.`, "entry limit reached");
			}
			case "remote_find": {
				const pattern = str(params, "pattern");
				const path = await far(optionalStr(params, "path"), signal);
				const limit = int(params, "limit", 1, MAX_LIMIT, DEFAULT_LIMIT)!;
				const result = await run(findScript(path, pattern, limit), { signal });
				const guard = guardMessage(result, path, "find");
				if (guard) return guard;
				if (result.exitCode !== 0) return formatResult(result, { label: "find" });
				return listing(result, limit, `No file under ${path} matches ${pattern}.`, "file limit reached; narrow the pattern");
			}
			case "remote_grep": {
				const pattern = str(params, "pattern");
				const path = await far(optionalStr(params, "path"), signal);
				const limit = int(params, "limit", 1, MAX_LIMIT, DEFAULT_LIMIT)!;
				const result = await run(grepScript(path, {
					pattern,
					glob: optionalStr(params, "glob"),
					ignoreCase: bool(params, "ignoreCase"),
					literal: bool(params, "literal"),
					context: int(params, "context", 1, 20),
					filesOnly: bool(params, "filesOnly"),
				}, limit), { signal });
				const guard = guardMessage(result, path, "grep");
				if (guard) return guard;
				// grep and rg exit 1 when nothing matched: not an error for a search tool.
				if (result.exitCode !== 0 && result.exitCode !== 1) return formatResult(result, { label: "grep" });
				return listing(result, limit, `No match for ${pattern} in ${path}.`, "match limit reached; refine the pattern");
			}
			default:
				throw new ParamError(`Unknown tool: ${name}`);
		}
	};
	/** A capped list: one extra line was requested, so its presence proves the limit was hit. */
	function listing(result: TransportResult, limit: number, empty: string, overflow: string): ToolResult {
		const lines = result.stdout.toString("utf8").split("\n").filter(Boolean);
		if (!lines.length) return ok(empty);
		const over = lines.length > limit;
		const body = clipLines(clipHead(lines.slice(0, limit).join("\n")).text);
		const notes = [...(over ? [`${limit} ${overflow}`] : []), ...(body.truncated ? ["long lines truncated"] : [])];
		return ok(`${body.text}${notes.length ? `\n\n[${notes.join("; ")}]` : ""}`);
	}

	const toolsCall = async (rpcId: JsonRpcId, params: unknown): Promise<ToolResult> => {
		if (!isRecord(params) || typeof params.name !== "string") throw new ParamError("tools/call needs a tool name.");
		if (!tools.some((t) => t.name === params.name)) return failed(`Unknown tool: ${params.name}`);
		const args = params.arguments ?? {};
		if (!isRecord(args)) throw new ParamError("tools/call arguments must be an object.");
		const controller = new AbortController();
		const key = keyOf(rpcId);
		inFlight.set(key, controller);
		try {
			return await call(params.name, args, controller.signal);
		} catch (error) {
			// Never a stack trace and never a throw out of a tool: the model must be able to act on it.
			if (error instanceof ParamError) return failed(error.message);
			return failed(controller.signal.aborted ? `Cancelled while running on ${id.label ?? id.target}.` : describeFailure(error));
		} finally {
			if (inFlight.get(key) === controller) inFlight.delete(key);
		}
	};

	const handle = async (value: unknown): Promise<JsonRpcResponse | undefined> => {
		if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") {
			const rpcId = isRecord(value) && (typeof value.id === "string" || typeof value.id === "number") ? value.id : null;
			return { jsonrpc: "2.0", id: rpcId, error: { code: INVALID_REQUEST, message: "Invalid JSON-RPC request." } };
		}
		const { method, params } = value;
		const hasId = typeof value.id === "string" || typeof value.id === "number";
		const rpcId = hasId ? (value.id as string | number) : null;
		if (!hasId) {
			// Notifications never get a response. Claude sends cancelled both when the user
			// interrupts and when MCP_TOOL_TIMEOUT fires, always with the call's request id.
			if (method === "notifications/cancelled" && isRecord(params) && (typeof params.requestId === "string" || typeof params.requestId === "number"))
				inFlight.get(keyOf(params.requestId))?.abort();
			return undefined;
		}
		try {
			switch (method) {
				case "initialize": {
					// No network here: the client bounds this handshake at 30 s and a cold channel
					// costs most of it. The connection is pinned on the first tools/call instead.
					const requested = isRecord(params) && typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
					return {
						jsonrpc: "2.0", id: rpcId,
						result: {
							protocolVersion: requested && KNOWN_PROTOCOL_VERSIONS.has(requested) ? requested : MCP_PROTOCOL_VERSION,
							capabilities: { tools: {} },
							serverInfo: { name: "pi-remote", version: "1.0.0" },
							instructions: remoteWorkerInstructions(id),
						},
					};
				}
				case "ping":
					return { jsonrpc: "2.0", id: rpcId, result: {} };
				case "tools/list":
					return { jsonrpc: "2.0", id: rpcId, result: { tools } };
				case "tools/call":
					return { jsonrpc: "2.0", id: rpcId, result: await toolsCall(rpcId, params) };
				default:
					return { jsonrpc: "2.0", id: rpcId, error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` } };
			}
		} catch (error) {
			return { jsonrpc: "2.0", id: rpcId, error: { code: error instanceof ParamError ? INVALID_PARAMS : INTERNAL_ERROR, message: error instanceof Error ? error.message : String(error) } };
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
	/** Idempotent: stdin EOF and a signal routinely arrive together, and both tear down. */
	const dispose = () => {
		for (const controller of inFlight.values()) controller.abort();
		inFlight.clear();
		const open = opened;
		opened = undefined; transport = undefined;
		open?.dispose();
	};
	return { tools, handle, handleLine, dispose, pending: () => inFlight.size };
}
export type RemoteMcpServer = ReturnType<typeof createRemoteMcpServer>;

/** Serve newline-delimited JSON-RPC over the given streams; resolves when the input ends. */
export function serveRemoteMcp(id: RemoteMcpIdentity, input: NodeJS.ReadableStream, output: NodeJS.WritableStream, deps: RemoteMcpDeps = {}): Promise<void> {
	const server = createRemoteMcpServer(id, deps);
	deps.onServer?.(server);
	let buffer = "";
	const write = (response: JsonRpcResponse | undefined) => {
		// Only JSON-RPC ever reaches stdout: ssh's own noise goes to the channel child's stderr.
		if (response) output.write(`${JSON.stringify(response)}\n`);
	};
	return new Promise<void>((resolve) => {
		const finish = () => { server.dispose(); resolve(); };
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
			finish();
		});
		input.on("error", () => finish());
	});
}

/**
 * Adapt the shared `Connection` (connection.ts — the session's own channel policy: lazy pin,
 * per-call fallback while the channel is busy, hold after a teardown, login backoff) to the
 * transport the tools above use. Imported dynamically so the protocol core stays loadable, and
 * testable, without a channel: nothing here runs until the first tools/call.
 *
 * `deps` is the test seam index.test.ts uses for the extension: an `exec` that runs the composed
 * far command under a local shell. Production passes none.
 */
export async function connectRemote(id: RemoteMcpIdentity, deps: ConnectionDeps = {}): Promise<RemoteTransport> {
	const [{ Connection }, { parseTargetsFile, targetsFilePath }] = await Promise.all([import("./connection.ts"), import("./argv.ts")]);
	// pi's getAgentDir() lives in the runtime this process must not load, so the default is spelled out.
	const agentDir = id.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const { targets } = parseTargetsFile(fs.readFileSync(targetsFilePath(agentDir), "utf8"));
	const target = targets.find((t) => t.name === id.target);
	if (!target) throw new Error(`target "${id.target}" is not in ${targetsFilePath(agentDir)}`);
	// `channel: false` is the session's --no-channel: every call gets its own ssh over the
	// parent's ControlMaster, exactly as the extension behaves under that flag.
	const connection = new Connection(target, targets, id.farCwd, { agentDir, ...(id.channel === false ? { channel: false } : {}), ...deps });
	// 0 = never idle-close. A worker thinks for minutes between calls and the extension's 120 s
	// would make it pay the ~9 s cold start again; this process dies with the worker anyway.
	connection.idleClose(0);
	const empty = { stdout: Buffer.alloc(0), stderr: "", timedOut: false, aborted: false };
	/**
	 * `Connection` throws where the tools want a result: abort and timeout are outcomes a model
	 * must be told about, with whatever ran, not exceptions. Everything else still throws and
	 * becomes "Could not reach <target>: …" one level up.
	 */
	const outcome = (error: unknown, partial: Partial<TransportResult> = {}): TransportResult => {
		const message = error instanceof Error ? error.message : String(error);
		if (/^aborted$|^Operation aborted$/.test(message)) return { ...empty, exitCode: null, aborted: true, ...partial };
		const timeout = /^timeout:(\d+)$/.exec(message) ?? /: timed out after/.exec(message);
		if (timeout) return { ...empty, exitCode: null, timedOut: true, ...partial };
		throw error;
	};
	return {
		label: id.label ?? connection.label,
		async home(signal) {
			return (await connection.ready(signal)).home;
		},
		async run(command, options) {
			// allowFail: a non-zero far exit is the tool's own result (read guards, grep's 1), not a throw.
			try {
				return await connection.run(command, { ...options, allowFail: true });
			} catch (error) {
				return outcome(error);
			}
		},
		async bash(command, cwd, options) {
			// bash only reports its exit code: its output already went to `onData`, which the
			// tool buffers, so a killed command still returns what it managed to print.
			try {
				return { ...empty, ...(await connection.bash(command, cwd, options)) };
			} catch (error) {
				return outcome(error);
			}
		},
		dispose() { connection.dispose(); },
	};
}

function isEntryScript(): boolean {
	try {
		return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isEntryScript()) {
	const id = decodeRemoteMcpIdentity(process.env[REMOTE_MCP_ENV]);
	if (!id) {
		process.stderr.write(`${REMOTE_MCP_ENV} is missing or malformed; this server only runs as a worker of a remote Pi session.\n`);
		process.exit(1);
	}
	let server: RemoteMcpServer | undefined;
	const done = serveRemoteMcp(id, process.stdin, process.stdout, { connect: () => connectRemote(id), onServer: (s) => { server = s; } });
	/**
	 * Claude owns this process: SIGINT (it exited cleanly) and stdin EOF (it exited or was
	 * killed) both end us — measured, a SIGKILLed Claude sends no signal at all, only EOF.
	 * Tear the channel down before leaving rather than letting the pipe close do it later:
	 * dispose kills the ssh child, so the far loop and any command still running inside the
	 * target die now. Idempotent: EOF and a signal routinely arrive together.
	 */
	let leaving = false;
	const shutdown = () => {
		if (leaving) return;
		leaving = true;
		try { server?.dispose(); } catch { /* we are leaving either way */ }
		process.exit(0);
	};
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, shutdown);
	void done.then(shutdown);
}
