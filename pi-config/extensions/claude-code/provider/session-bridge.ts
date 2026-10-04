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
import { claudeProjectsRoot, claudeSessionId, nextFreeLaunch } from "./session-records.ts";
import { BRIDGE_REGISTRY, CLAUDE_FORK_ENV, decodeForkPoint, type ClaudeForkPoint } from "./fork-point.ts";
import {
	buildClaudeArgv, ClaudeFailureDetector, ClaudeTransport,
	type ClaudeTransportLimits, type ClaudeTransportTimings, type SpawnImpl,
} from "../transport.ts";
import {
	loginEntryFor, manualSwitchText, movedText, switchText,
	type ClaudeAccountFailure, type ClaudeLoginChoice, type ClaudeLoginEntry, type ClaudeLoginSwitch, type LoginUser,
} from "../accounts.ts";
import type { ImageContent, Message, TextContent, Tool } from "@earendil-works/pi-ai";
import { PiMcpHost, type HeldMcpCall, type McpContent, type McpToolResult } from "./mcp-host.ts";
import { createClaudeRequestObserver } from "../../llm-inflight/claude.ts";
import {
	parseClaudeFrame, parseToolInput, MCP_SERVER_NAME, MCP_TOOL_PREFIX,
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
	/**
	 * Characters of the whole folded history message, for a request that does
	 * not say how large its model's context window is (see foldBudgetChars).
	 */
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

/**
 * pi's default `compaction.reserveTokens`. The provider cannot read pi's
 * settings, so it mirrors the default rather than guess at an override.
 */
export const PI_RESERVE_TOKENS = 16_384;
/** Tokens the CLI adds around pi's system prompt and tools (its own preamble, request framing). */
const FOLD_OVERHEAD_TOKENS = 4_000;
/**
 * Characters per token of a fold, for every chars-to-tokens conversion here.
 * Measured, not the usual 4: a live restart of a real opus[1m] session sent a
 * 524,682-character fold and its first call reported 231,491 input tokens
 * (cache_creation_input_tokens), system prompt and tools included, so about
 * 2.3 characters per token. Tool output, JSON and code tokenize densely.
 * 2.2 rounds that toward safety.
 */
export const FOLD_CHARS_PER_TOKEN = 2.2;
/** Headroom under the window for what 2.2 still under-counts in a denser fold. */
const FOLD_SAFETY = 0.85;
/** The smallest fold budget, whatever the window arithmetic says. */
export const MIN_FOLD_CHARS = 64 * 1024;
/**
 * The largest fold budget. The folded history is ONE stream-json stdin line,
 * and the transport refuses a line over `maxLineBytes` (4 MiB); JSON escaping
 * and multi-byte text make bytes outrun characters. Images ride the same line
 * but are not counted here: they get their own byte budget, whatever of the
 * line the serialized text leaves (see foldHistory). Raise it only once a live
 * probe shows the CLI takes a bigger line.
 */
export const MAX_FOLD_CHARS = 2 * 1024 * 1024;
/**
 * Bytes of the stdin line a fold leaves unspent. The transport refuses a line
 * when it plus whatever is still queued on the pipe passes `maxLineBytes`, and
 * the image budget is set before the omission placeholders are written into
 * the text, so the fold aims this far under the limit. 64 KiB is under 2% of
 * the 4 MiB line, and holds hundreds of placeholders or a queued control request.
 */
export const FOLD_LINE_HEADROOM = 64 * 1024;

/** What sizes a fold: the model's window and output cap, and what else shares the window. */
export interface FoldBudgetInput {
	contextWindow?: number;
	maxTokens?: number;
	systemPrompt?: string;
	tools?: readonly Pick<Tool, "name" | "description" | "parameters">[];
}

/**
 * Characters of folded history a restarted child can take for this model:
 * the window, less pi's compaction reserve, the system prompt, the tool
 * declarations, the CLI's overhead and the output cap, scaled down by
 * FOLD_SAFETY, converted at FOLD_CHARS_PER_TOKEN and clamped to [MIN_FOLD_CHARS, MAX_FOLD_CHARS]. Without a
 * window it is `fallback`. The same number decides when the provider asks pi
 * to compact (see auto-compact.ts), so a restart never has to clip history
 * pi still holds in full.
 */
export function foldBudgetChars(input: FoldBudgetInput, fallback = LIMITS.maxFoldedChars): number {
	const window = input.contextWindow;
	if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) return fallback;
	const tools = !input.tools?.length ? "" : JSON.stringify(input.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters ?? {} })));
	const overhead = ((input.systemPrompt?.length ?? 0) + tools.length) / FOLD_CHARS_PER_TOKEN + FOLD_OVERHEAD_TOKENS;
	const tokens = (window - PI_RESERVE_TOKENS - overhead - (input.maxTokens ?? 0)) * FOLD_SAFETY;
	return Math.floor(Math.min(MAX_FOLD_CHARS, Math.max(MIN_FOLD_CHARS, tokens * FOLD_CHARS_PER_TOKEN)));
}

/**
 * Why a fresh child could never take `chars` of message, or undefined if it
 * might: the message and the system prompt at FOLD_CHARS_PER_TOKEN, plus the
 * reply's `maxTokens`, over the window less pi's compaction reserve. No safety
 * factor: this only refuses what certainly cannot fit, since the other side
 * is an API overflow after a full upload.
 */
export function windowOverflow(chars: number, request: Pick<ClaudeTurnRequest, "model" | "contextWindow" | "maxTokens" | "systemPrompt">): string | undefined {
	const window = request.contextWindow;
	if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) return undefined;
	const tokens = Math.ceil((chars + (request.systemPrompt?.length ?? 0)) / FOLD_CHARS_PER_TOKEN);
	const reply = request.maxTokens ?? 0;
	if (tokens + reply <= window - PI_RESERVE_TOKENS) return undefined;
	return `Claude Code cannot take this request: its input is about ${tokens} tokens, which with ${reply} for the reply exceeds ${request.model}'s ${window}-token context window`;
}

export interface SessionBridgeOptions {
	/** CLI executable. Resolved on PATH without a shell, so a shell alias cannot leak in. */
	executable?: string;
	/** Working directory for the CLI child. Defaults to the current process cwd. */
	cwd?: string;
	/**
	 * The CLI's projects directory, where each child's session record lands.
	 * Defaults to `$CLAUDE_CONFIG_DIR/projects` (from `env`, then this process)
	 * or `~/.claude/projects`.
	 */
	projectsRoot?: string;
	/** Extra child environment, merged after the nested-session markers are dropped. */
	env?: Record<string, string>;
	/**
	 * Resume this CLI session for the first conversation instead of folding it (fork-point.ts).
	 * Defaults to `CLAUDE_FORK_ENV` in `env`, then in this process's environment.
	 */
	forkFrom?: ClaudeForkPoint;
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
	/**
	 * The host's Claude logins (accounts.ts ClaudeLogins): which one each child runs on, and where a
	 * turn goes on a usage limit or a failed sign-in. Absent: every child inherits the environment,
	 * and a failure ends the turn (as before logins existed).
	 */
	logins?: ClaudeLoginSource;
}

/** What the bridge needs of the host's logins; accounts.ts ClaudeLogins is the real one. */
export interface ClaudeLoginSource {
	select(current?: string): ClaudeLoginChoice;
	failover(from: ClaudeLoginChoice, failure: ClaudeAccountFailure): ClaudeLoginChoice | undefined;
	recordFailure(from: ClaudeLoginChoice, failure: ClaudeAccountFailure): void;
	forcedFailure?(id: string): ClaudeAccountFailure | undefined;
	/** `select`, borrowing from the pool first when nothing but `default` is usable here. */
	acquire?(current?: string): Promise<ClaudeLoginChoice>;
	/** `failover` in the pool: the failed login goes back, and the next one may be borrowed. */
	failoverAsync?(from: ClaudeLoginChoice, failure: ClaudeAccountFailure): Promise<ClaudeLoginChoice | undefined>;
	/** The login is on its way to another device: a child on it restarts on the next login. */
	leaving?(id: string): boolean;
	/** Record a child's use of a login (its lease) and how to release it when the login leaves. */
	track?(id: string, user: LoginUser): { done(): void; active(): void };
	/** Why the session's login can't run here now (undefined: it can), and whether the keeper has it free. */
	absence?(id: string): { label: string; cause: string; free: boolean } | undefined;
	/** Borrow `id` by name from the keeper (the pool only); resolves once it is here or the wait ends. */
	take?(id: string): Promise<void>;
	/** Mark (or drop) a session's hand-pick of a login (accounts.ts `.sova-picks/`). */
	markPick?(id: string, session: string): void;
	clearPick?(id: string, session: string): void;
}

/** A pi session's login bookkeeping (setSessionLogin). */
interface SessionLoginHooks {
	recorded?: string;
	onChange?: (entry: ClaudeLoginEntry) => void;
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
// CLI session ids, derived from the pi session (see session-records.ts)
// ---------------------------------------------------------------------------

export { claudeSessionId, uuidv5 } from "./session-records.ts";

/** stderr of a child that was handed a `--session-id` some earlier child took. */
const SESSION_ID_TAKEN_RE = /session id\b.*\bis already in use/i;
/** "Claude <why>" for that case; distinguished from a real handshake failure. */
const SESSION_ID_TAKEN = "was handed a session id already in use";
/**
 * How far past `launchAttempt` to probe for a free id. Each launch first skips
 * past the records already on disk (`nextFreeLaunch`), so a new process does
 * not re-probe the ids the previous one took; the probes are the safety net
 * for a record the scan could not see (another cwd, a record written between
 * the scan and the spawn). Each collision costs one fast-failing spawn (~150 ms).
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
	/** Messages left out to fit the budget; 0 when the history fits. */
	omitted: number;
	/** Images of kept messages left out to fit the stdin line, each replaced by a placeholder. */
	imagesDropped: number;
	/** Bytes of the stdin line this fold makes; undefined when no line limit applied. */
	bytes?: number;
	/** Why this fold can never be sent: the current message's own images are over the line. */
	overflow?: string;
}

/** A tool as the CLI names it: the model only knows `mcp__sova__<name>`. */
function cliToolName(name: string): string {
	return name.startsWith(MCP_TOOL_PREFIX) ? name : `${MCP_TOOL_PREFIX}${name}`;
}

/** An image in the Anthropic source shape: stream-json user messages are Anthropic messages, not MCP's flat one. */
function imageBlock(image: ImageContent): Record<string, unknown> {
	return { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } };
}

/** One stream-json user message: its text, then its images. */
function userFrame(text: string, images: readonly ImageContent[]): Record<string, unknown> {
	const content: Record<string, unknown>[] = [];
	if (text) content.push({ type: "text", text });
	for (const image of images) content.push(imageBlock(image));
	if (!content.length) content.push({ type: "text", text: "" });
	return { type: "user", message: { role: "user", content } };
}

/** Bytes of the stdin line the transport writes for a frame, measured as it measures them (newline included). */
function frameBytes(frame: unknown): number {
	return Buffer.byteLength(JSON.stringify(frame)) + 1;
}

/** What one image adds to a frame: its block and the comma before it. */
function imageBytes(image: ImageContent): number {
	return Buffer.byteLength(JSON.stringify(imageBlock(image))) + 1;
}

/** An image of a folded message, and what stands in its place if it has to go. */
interface FoldImage {
	image: ImageContent;
	placeholder: string;
}

/** One folded pi message: its rendered text, and the images it carried. */
interface FoldSegment {
	/** The message as it reads with every image kept: what fitFold sizes. */
	text: string;
	/** The message without its image note. */
	head: string;
	images: FoldImage[];
	/** Where the image note says the images came from. */
	origin: string;
	user: boolean;
}

/** Stands in for a dropped image whose origin is not known. */
const FOLD_IMAGE_OMITTED = "[image omitted to fit the resend]";

function imageNote(count: number, origin: string): string {
	return `[${count} image(s) ${origin}, included below]`;
}

function foldSegment(head: string, images: FoldImage[], origin: string, user: boolean): FoldSegment {
	return { text: images.length ? `${head}\n${imageNote(images.length, origin)}` : head, head, images, origin, user };
}

/**
 * A segment's text once `dropped` images are left out: each dropped one is a
 * placeholder line where the note would have counted it, and the note counts
 * only the images still included below.
 */
function segmentText(segment: FoldSegment, dropped: ReadonlySet<FoldImage>): string {
	if (!segment.images.some((image) => dropped.has(image))) return segment.text;
	const lines = [segment.head, ...segment.images.filter((image) => dropped.has(image)).map((image) => image.placeholder)];
	const kept = segment.images.length - lines.length + 1;
	if (kept) lines.push(imageNote(kept, segment.origin));
	return lines.join("\n");
}

/** Added to the header of a fold that had to leave messages out. */
const FOLD_CLIPPED = "The conversation is longer than fits: its oldest messages are left out, as marked below, so do not assume the replay starts at the beginning.";

/** Separator between folded messages. */
const FOLD_SEP = "\n\n";
/** Room kept for the omission markers when a history is clipped. */
const FOLD_MARKER_RESERVE = 256;

/**
 * Which messages fit in `budget` characters, dropping the OLDEST first; the
 * indices come back in order.
 *
 * The last user message is always kept whole: it is what the model has to
 * answer. The first user message (usually the task) is kept next if it takes
 * no more than a quarter of the budget. Then the newest messages, walking back
 * from the end until the next one would not fit.
 */
function fitFold(segments: readonly FoldSegment[], budget: number): { keep: number[]; omitted: number } {
	const total = segments.reduce((sum, segment) => sum + segment.text.length, 0) + FOLD_SEP.length * Math.max(0, segments.length - 1);
	if (total <= budget) return { keep: segments.map((_, i) => i), omitted: 0 };
	const keep = new Set<number>();
	let used = FOLD_MARKER_RESERVE;
	const take = (i: number) => { keep.add(i); used += segments[i]!.text.length + FOLD_SEP.length; };
	const fits = (i: number) => used + segments[i]!.text.length + FOLD_SEP.length <= budget;
	const lastUser = segments.findLastIndex((segment) => segment.user);
	if (lastUser >= 0) take(lastUser);
	const firstUser = segments.findIndex((segment) => segment.user);
	if (firstUser >= 0 && !keep.has(firstUser) && segments[firstUser]!.text.length <= budget / 4 && fits(firstUser)) take(firstUser);
	for (let i = segments.length - 1; i >= 0; i--) {
		if (keep.has(i)) continue;
		if (!fits(i)) break;
		take(i);
	}
	return { keep: [...keep].sort((x, y) => x - y), omitted: segments.length - keep.size };
}

/**
 * The body of a fold: the kept messages, and when some were left out, a
 * marker at the head saying how many and one for each gap in the middle.
 */
function foldBody(segments: readonly FoldSegment[], keep: readonly number[], omitted: number, dropped: ReadonlySet<FoldImage>): string {
	if (!omitted) return keep.map((i) => segmentText(segments[i]!, dropped)).join(FOLD_SEP);
	const parts = [`[${omitted} earlier message(s) omitted to fit the context window]`];
	let previous = -1;
	for (const i of keep) {
		// A leading gap is what the opening marker already says.
		if (previous >= 0 && i - previous > 1) parts.push(`[… ${i - previous - 1} message(s) omitted here …]`);
		previous = i;
		parts.push(segmentText(segments[i]!, dropped));
	}
	return parts.join(FOLD_SEP);
}

/**
 * Keep what images fit in the one stdin line beside the text, NEWEST first.
 *
 * `images` run oldest to newest; `current` are the ones the model is being
 * asked about now, and are never dropped. The text is sized first, since it
 * is the history itself; the images get what its serialized bytes leave of
 * `lineBytes` less FOLD_LINE_HEADROOM, walking back from the newest until one
 * does not fit, and every older one goes with it. Then the real frame is
 * measured: placeholders lengthen the text, so while it is still over, the
 * oldest image still kept goes too. The images are the line's bulk (21
 * screenshots in one real session were 4.18 MB of base64 against 112K
 * characters of text), and without this every restart of such a session
 * failed on a line the transport refuses.
 */
function fitImages(
	images: readonly FoldImage[], current: ReadonlySet<FoldImage>, render: (dropped: ReadonlySet<FoldImage>) => string, lineBytes: number,
): { text: string; images: ImageContent[]; dropped: number; bytes?: number; overflow?: string } {
	const dropped = new Set<FoldImage>();
	const kept = () => images.filter((image) => !dropped.has(image)).map((image) => image.image);
	if (!Number.isFinite(lineBytes)) return { text: render(dropped), images: kept(), dropped: 0 };
	const target = lineBytes - FOLD_LINE_HEADROOM;
	let room = target - frameBytes(userFrame(render(dropped), []));
	for (const image of current) room -= imageBytes(image.image);
	let full = false;
	for (let i = images.length - 1; i >= 0; i--) {
		const image = images[i]!;
		if (current.has(image)) continue;
		const cost = imageBytes(image.image);
		if (!full && cost <= room) room -= cost;
		else { full = true; dropped.add(image); }
	}
	let text = render(dropped);
	let bytes = frameBytes(userFrame(text, kept()));
	while (bytes > target) {
		const oldest = images.find((image) => !current.has(image) && !dropped.has(image));
		if (!oldest) break;
		dropped.add(oldest);
		text = render(dropped);
		bytes = frameBytes(userFrame(text, kept()));
	}
	const result = { text, images: kept(), dropped: dropped.size, bytes };
	// Only the current message's images are left beside the text. If the text
	// alone would fit, they are what the line cannot take: say so, rather than
	// the transport's generic refusal. Text over the line alone is not an image
	// problem, and the transport says that as before.
	if (bytes > lineBytes && result.images.length) {
		const textBytes = frameBytes(userFrame(text, []));
		if (textBytes <= lineBytes) {
			return {
				...result,
				overflow: `Claude Code cannot take this request: the current message's ${result.images.length} image(s) are ${bytes - textBytes} bytes, `
					+ `too many for the ${lineBytes}-byte limit for one stdin line beside ${textBytes} bytes of text; send fewer or smaller images`,
			};
		}
	}
	return result;
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
 * their place in the narrative is marked inline. They share the one stdin line
 * of `lineBytes` with the text, so older ones may be left out, each marked
 * where it was (see fitImages); the current message's never are.
 */
export function foldHistory(
	messages: readonly Message[], limits: SessionBridgeLimits, mode: FoldMode = "restarted", budget = limits.maxFoldedChars,
	lineBytes = limits.maxLineBytes,
): FoldedHistory {
	const foldable = messages.filter((m) => m.role !== "system");
	if (mode === "first") {
		const only = foldable.length === 1 ? foldable[0]! : undefined;
		if (only?.role !== "user") mode = "joined";
		else {
			// The message being sent now: all its images are current.
			const images = imagesOf(only.content).map((image) => ({ image, placeholder: FOLD_IMAGE_OMITTED }));
			const segment = foldSegment(textOf(only.content), images, "attached to this message", true);
			const fitted = fitImages(images, new Set(images), () => segment.text, lineBytes);
			return { text: fitted.text, images: fitted.images, omitted: 0, imagesDropped: fitted.dropped, bytes: fitted.bytes, overflow: fitted.overflow };
		}
	}
	const segments: FoldSegment[] = [];
	const clip = (text: string, cap: number) =>
		text.length <= cap ? text : `${text.slice(0, cap)}… [truncated]`;
	/** Each tool call's arguments, so a dropped image can name the file it was read from. */
	const callArgs = new Map<string, Record<string, unknown>>();

	for (const message of messages) {
		if (message.role === "system") continue; // Re-sent as the system prompt, not as history.
		if (message.role === "user") {
			const images = imagesOf(message.content).map((image) => ({ image, placeholder: FOLD_IMAGE_OMITTED }));
			segments.push(foldSegment(`## User\n${textOf(message.content)}`, images, "attached to this message", true));
		} else if (message.role === "assistant") {
			const parts: string[] = [];
			const text = textOf(message.content);
			if (text) parts.push(`## Assistant\n${text}`);
			for (const block of message.content) {
				if (block.type === "toolCall") {
					callArgs.set(block.id, block.arguments ?? {});
					// The CLI's name, not pi's: a model that copies a bare name
					// from the replay gets "No such tool available".
					parts.push(`## Assistant tool call \`${cliToolName(block.name)}\` (id ${block.id})\n\`\`\`json\n${clip(JSON.stringify(block.arguments), limits.maxFoldedResultChars)}\n\`\`\``);
				}
			}
			if (parts.length) segments.push(foldSegment(parts.join(FOLD_SEP), [], "", false));
		} else if (message.role === "toolResult") {
			const path = callArgs.get(message.toolCallId)?.path;
			const placeholder = typeof path === "string" && path
				? `[image omitted to fit the resend: ${message.toolName} of ${path}]`
				: FOLD_IMAGE_OMITTED;
			const images = imagesOf(message.content).map((image) => ({ image, placeholder }));
			const label = message.isError ? "failed" : "returned";
			const cap = REPORT_TOOL_RE.test(message.toolName) ? limits.maxFoldedReportChars : limits.maxFoldedResultChars;
			segments.push(foldSegment(
				`## Tool \`${cliToolName(message.toolName)}\` (id ${message.toolCallId}) ${label}\n${clipResult(textOf(message.content), cap)}`,
				images, "returned by this tool", false,
			));
		}
	}

	const { keep, omitted } = fitFold(segments, budget);
	// Current: the last user message, which the model has to answer, and the
	// newest message, which this turn delivers (a tool result, after a restart
	// mid-loop). Their images are never dropped.
	const lastUser = segments.findLastIndex((segment) => segment.user);
	const current = new Set([lastUser, segments.length - 1].flatMap((i) => keep.includes(i) ? segments[i]!.images : []));
	const header = FOLD_HEADERS[mode];
	const render = (dropped: ReadonlySet<FoldImage>) => [
		"<conversation-history>",
		// The framing says so too, not only the marker in the body.
		omitted ? `${header} ${FOLD_CLIPPED}` : header,
		"",
		foldBody(segments, keep, omitted, dropped),
		"</conversation-history>",
		"",
		"Continue from here by answering the latest user message above.",
	].join("\n");
	const fitted = fitImages(keep.flatMap((i) => segments[i]!.images), current, render, lineBytes);
	return { text: fitted.text, images: fitted.images, omitted, imagesDropped: fitted.dropped, bytes: fitted.bytes, overflow: fitted.overflow };
}

/**
 * Characters a restart would fold this transcript into, before any clipping.
 * Images are not counted: they ride beside the text, not in it.
 */
export function foldSizeEstimate(messages: readonly Message[], limits: SessionBridgeLimits = LIMITS): number {
	return foldHistory(messages, limits, "restarted", Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY).text.length;
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
	/** The arguments: pi's parse of the streamed bytes once they are judged valid. */
	input: unknown;
	/**
	 * The CLI's own copy of the arguments, from its assistant frame. A `tools/call`
	 * carries the CLI's object, so the exact match also accepts this form, in case
	 * the CLI ever normalises what it parsed. Only a block judged valid keeps a slot,
	 * so this never makes a rejected call matchable.
	 */
	announced?: unknown;
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
	/** What pi asked for: a login switch sends it again. */
	request: ClaudeTurnRequest;
	/** The fold framing this turn's restart used (a switch before any answer is still first contact). */
	first: boolean;
	/** A frame reached pi: from here on a failure ends the turn rather than switching logins. */
	surfaced: boolean;
	/** Logins this turn already switched away from. */
	failovers: number;
	/** The current CLI message's tool calls whose arguments parsed, and the first one rejected. */
	accepted: number;
	rejected?: string;
	/** CLI messages in a row, in this pi message, whose tool calls were all rejected. */
	rejectedRun: number;
}

/**
 * CLI messages in a row whose tool calls were all rejected (invalid JSON arguments)
 * after which one pi message gives up: a model repeating the mistake would
 * otherwise spend quota on retries nobody sees.
 */
export const MAX_REJECTED_RUN = 3;

/** A held `tools/call` for a tool whose call pi rejected: it must never run. */
const REJECTED_CALL_REASON = "arguments were not valid JSON; nothing ran";

/** The pi tool name a `tools/call` carries, from the CLI's `mcp__sova__<name>`. */
function bareToolName(name: string): string {
	return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
}

/** JSON with every object's keys sorted: two parses of one value compare equal whatever their key order. */
function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) =>
		v !== null && typeof v === "object" && !Array.isArray(v)
			? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
			: v);
}

function deepEqual(a: unknown, b: unknown): boolean {
	try { return canonicalJson(a) === canonicalJson(b); } catch { return false; }
}

/** A held call's arguments are exactly this block's, in pi's parse or the CLI's announced copy. */
function sameArguments(slot: PendingToolUse, args: unknown): boolean {
	return deepEqual(slot.input, args) || (slot.announced !== undefined && deepEqual(slot.announced, args));
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
	/** The current CLI message's open tool_use blocks by content index, with their input_json so far. */
	private openInputs = new Map<number, { id: string; name: string; json: string; input: unknown }>();
	/**
	 * The current CLI message's tool calls whose arguments were not valid JSON
	 * (parseToolInput, the rule stream.ts applies too). The CLI answers each
	 * itself and calls the model again; pi never sees nor runs them.
	 */
	private rejected: { id: string; name: string }[] = [];
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
	/** The CLI session id of the live child, once its handshake succeeded. */
	private claudeId?: string;
	/**
	 * A forked pi session's way into its parent's CLI session (fork-point.ts): tried once, for
	 * the first child, and dropped either way.
	 */
	private forkSeed?: ClaudeForkPoint;
	/** The login the live (or next) child runs on; chosen at each spawn. */
	private login?: ClaudeLoginChoice;
	/** The login the session last recorded (undefined: none yet); read from the hooks once. */
	private recordedLogin?: string;
	/** The last login announced, with its label: what a `moved` note names as left. */
	private lastLogin?: ClaudeLoginChoice;
	private recordedRead = false;
	private readonly detector = new ClaudeFailureDetector();
	private readonly loginHooks: () => SessionLoginHooks | undefined;
	/** The live child's lease on its login (accounts.ts LoginUsers), while it runs on an added one. */
	private lease?: { done(): void; active(): void };

	constructor(piSessionId: string, options: SessionBridgeOptions, cwd: string, forkSeed?: ClaudeForkPoint, loginHooks: () => SessionLoginHooks | undefined = () => undefined) {
		this.piSessionId = piSessionId;
		this.options = options;
		this.cwd = cwd;
		this.forkSeed = forkSeed;
		this.loginHooks = loginHooks;
		this.timings = { ...TIMINGS, ...options.timings };
		this.limits = { ...LIMITS, ...options.limits };
	}

	isBusy(): boolean { return !!this.turn || this.calls.length > 0 || this.restarting; }

	/**
	 * Where a fork of this pi session can resume this child's CLI session, or undefined unless
	 * the child is live, idle and in step with pi: a record mid-turn ends in a tool call the
	 * fork could never answer, and a desynced one is not the conversation pi holds.
	 */
	forkPoint(): ClaudeForkPoint | undefined {
		if (!this.started || !this.claudeId || !this.transport || this.transport.isClosed() || this.transport.hasExited()) return undefined;
		if (this.isBusy() || this.desynced || this.abortPending || this.recorded.length === 0) return undefined;
		return { v: 1, claudeSessionId: this.claudeId, messages: this.recorded.length, prefix: this.recorded[this.recorded.length - 1]!, cwd: this.cwd };
	}

	// -- turn ---------------------------------------------------------------

	async *runTurn(request: ClaudeTurnRequest, signal?: AbortSignal): AsyncGenerator<ClaudeFrame> {
		this.lastUsed = Date.now();
		this.currentTools = request.tools;
		if (signal?.aborted) return;

		const next = transcriptFingerprint(request.messages);
		let plan = this.plan(request, next);

		// The restart finishes before the turn exists, so no frame from the
		// dying child can reach it, whatever the timing of its death. Nothing is
		// written to the new child until the turn is registered below, so
		// nothing it says in reply can fall on the floor either.
		if (plan.restart && plan.resume) {
			try {
				await this.restart(request, plan.reason, plan.resume);
			} catch (error) {
				// The parent's record could not be resumed (gone, or refused): fold, as without a seed.
				debugLog({ event: "fork-resume-failed", session: this.piSessionId, error: error instanceof Error ? error.message : String(error) });
				plan = { restart: true, reason: "no live CLI process", results: [], users: [], first: !this.everStarted };
			}
		}
		if (plan.restart && !plan.resume) await this.restart(request, plan.reason);
		if (plan.restart && signal?.aborted) {
			// The fresh child never got the history (or, resumed, the new messages); reusing it would drop them.
			this.markDesynced("the turn was aborted before the restarted child was sent the history");
			return;
		}

		const queue = new FrameQueue();
		const turn: TurnState = {
			queue, messageComplete: false, wantsTools: false, streaming: false, signal,
			request, first: !!(plan.restart && plan.first), surfaced: false, failovers: 0,
			accepted: 0, rejectedRun: 0,
		};
		this.turn = turn;
		this.detector.reset();
		this.lease?.active();

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
			this.lease?.active();
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
			const fork = this.forkPlan(request, next);
			if (fork) return fork;
			return { restart: true, reason: "no live CLI process", results: [], users: [], first: !this.everStarted };
		}
		if (this.desynced) {
			return { restart: true, reason: `the CLI fell out of step with pi: ${this.desynced}`, results: [], users: [] };
		}
		if (this.login && this.options.logins?.leaving?.(this.login.id)) {
			// Its login is going to another device: nothing may keep running on it (a refresh here
			// would rotate the copy that moves). The restart takes the next login.
			return { restart: true, reason: `Claude login ${this.login.label} is leaving this device`, results: [], users: [] };
		}
		if (this.abortPending) {
			// Its late result would otherwise end this turn.
			return { restart: true, reason: "an interrupted turn has not settled", results: [], users: [] };
		}
		if (this.meta !== undefined && this.meta !== turnMeta(request, this.cwd)) {
			return { restart: true, reason: "model, effort, system prompt, tool set or cwd changed", results: [], users: [] };
		}
		if (!isPrefix(this.recorded, next)) {
			return { restart: true, reason: "transcript diverged (rewind, branch, compaction or foreign append)", results: [], users: [] };
		}
		const tail = request.messages.slice(this.recorded.length);
		const results = tail.filter((m): m is Extract<Message, { role: "toolResult" }> => m.role === "toolResult");
		// Every user message pi appended since the last turn, in order: steering
		// and follow-ups queued in one tail must all reach the CLI.
		const users = tail.filter((m) => m.role === "user");
		if (this.calls.length && results.length !== this.calls.length) {
			return { restart: true, reason: "pi answered only some of the CLI's tool calls", results: [], users: [] };
		}
		if (results.some((result) => !this.calls.some((call) => call.id === result.toolCallId))) {
			return { restart: true, reason: "a tool result did not match a held call", results: [], users: [] };
		}
		if (!results.length && !users.length) {
			return { restart: true, reason: "nothing new to send", results: [], users: [] };
		}
		return { restart: false, reason: "", results, users };
	}

	/**
	 * The first child of a forked pi session: resume the parent's CLI session (`forkSeed`) if
	 * this transcript starts with exactly the prefix that session heard, and what follows it is
	 * new user messages only (the parent's final reply after that prefix came from the CLI, so it
	 * is in the record already). Anything else folds, as for any first child.
	 */
	private forkPlan(request: ClaudeTurnRequest, next: string[]): TurnPlan | undefined {
		const seed = this.forkSeed;
		this.forkSeed = undefined;
		if (!seed || this.everStarted || seed.cwd !== this.cwd) return undefined;
		if (next.length <= seed.messages || next[seed.messages - 1] !== seed.prefix) return undefined;
		const tail = request.messages.slice(seed.messages);
		if (tail.some((m) => m.role === "toolResult")) return undefined;
		const users = tail.filter((m) => m.role === "user");
		if (!users.length) return undefined;
		return { restart: true, reason: "forked from the parent's Claude session", results: [], users, resume: seed.claudeSessionId };
	}

	/**
	 * Answer the CLI's tool calls first, then send any newly arrived user
	 * messages (steering, follow-ups). A call the CLI has not dispatched yet
	 * keeps its result until it does.
	 */
	private deliver(request: ClaudeTurnRequest, plan: TurnPlan): void {
		if (plan.restart && plan.resume) {
			// The resumed record already holds the history; send only what is new to it.
			this.sendUsers(plan.users);
			return;
		}
		if (plan.restart) {
			const budget = foldBudgetChars(request, this.limits.maxFoldedChars);
			const folded = foldHistory(request.messages, this.limits, plan.first ? "first" : "restarted", budget);
			// Tuning data, not an anomaly, so never the onDebug sink: compare
			// `chars` with the next message_start's input tokens to check the
			// budget's chars/4 guess against the real fold size.
			debugLog({
				event: "fold", session: this.piSessionId, chars: folded.text.length, budget, omitted: folded.omitted,
				imagesKept: folded.images.length, imagesDropped: folded.imagesDropped, bytes: folded.bytes,
			});
			// A fresh child's whole context is this one message. Over the
			// model's window it can only fail, after a full upload; say so now.
			// A first-contact message (pi's summary request) is never shortened:
			// a summary of part of the history would read as one of all of it.
			const overflow = windowOverflow(folded.text.length, request);
			if (overflow) {
				this.failTurn(overflow);
				return;
			}
			// Everything older that could go already has; what is left is the
			// current message's images, which the line cannot take.
			if (folded.overflow) {
				this.failTurn(folded.overflow);
				return;
			}
			this.sendUserMessage(folded.text, folded.images);
			return;
		}
		for (const result of plan.results) {
			const slot = this.calls.find((call) => call.id === result.toolCallId);
			if (slot) slot.result = toMcpResult(result);
		}
		this.settleCalls();
		this.sendUsers(plan.users);
	}

	private sendUsers(users: readonly Message[]): void {
		if (!users.length) return;
		// One stream-json message, not one per pi message: a second raw user
		// message is folded into the CLI's active turn as a steer rather than
		// read as part of the same prompt.
		const text = users.map((m) => textOf(m.content)).filter((t) => t.length > 0).join("\n\n");
		this.sendUserMessage(text, users.flatMap((m) => imagesOf(m.content)));
	}

	/**
	 * Write one user message to the child. A message the transport refuses (over
	 * its stdin line limit, or a pipe that is gone) fails the turn at once:
	 * the child never heard it, so waiting for its answer would hang forever.
	 */
	private sendUserMessage(text: string, images: readonly ImageContent[]): void {
		const frame = userFrame(text, images);
		if (this.transport?.send(frame)) return;
		const bytes = frameBytes(frame);
		this.failTurn(bytes > this.limits.maxLineBytes
			? `Claude Code cannot take this request: the message is ${bytes} bytes, over the ${this.limits.maxLineBytes}-byte limit for one stdin line`
			: "Claude Code cannot take this request: the CLI's stdin refused the message");
	}

	/** End the open turn with an error, and never reuse this child's conversation. */
	private failTurn(message: string): void {
		this.markDesynced(message);
		const turn = this.turn;
		if (turn && !turn.queue.isEnded()) {
			turn.queue.push({ type: "result", outcome: "error", message });
			turn.queue.end();
		}
	}

	// -- lifecycle ----------------------------------------------------------

	private async restart(request: ClaudeTurnRequest, reason: string, resume?: string): Promise<void> {
		this.restarting = true;
		try {
			await this.spawnFresh(request, reason, resume);
		} finally {
			this.restarting = false;
		}
	}

	private async spawnFresh(request: ClaudeTurnRequest, reason: string, resume?: string): Promise<void> {
		if (this.started) await this.teardown(`restarting: ${reason}`);
		await this.chooseLogin();
		this.failure = undefined;
		this.recorded = [];
		this.meta = undefined;

		// Start past every record on disk: the counter is only in memory, so
		// after a process restart it would otherwise re-probe ids already taken.
		this.launchAttempt = this.firstFreeLaunch();
		// Walk forward until the CLI accepts an id: a collision is survivable and
		// costs one fast-failing spawn, whereas reusing an id is fatal for good.
		for (let probe = 0; probe <= SESSION_ID_PROBES; probe++) {
			const why = await this.launchChild(request, claudeSessionId(this.piSessionId, this.launchAttempt), resume);
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

	/** `launchAttempt`, or the launch after the last record on disk if that is later. Never throws. */
	private firstFreeLaunch(): number {
		try {
			const projectsRoot = this.options.projectsRoot
				?? claudeProjectsRoot({ CLAUDE_CONFIG_DIR: this.options.env?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR });
			return nextFreeLaunch(this.piSessionId, { cwd: this.cwd, projectsRoot, from: this.launchAttempt });
		} catch {
			return this.launchAttempt; // the probes still cover it
		}
	}

	/**
	 * Spawn one child and run the `initialize` handshake. Returns undefined once
	 * the child is live, or the "Claude <why>" tail for a child already torn down.
	 */
	private async launchChild(request: ClaudeTurnRequest, sessionId: string, resume?: string): Promise<string | undefined> {
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
			// A fork resumes its parent's record into a new one, named like any other launch.
			...(resume ? { resume, forkSession: true } : {}),
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
			...(this.login && this.options.logins?.forcedFailure?.(this.login.id) ? { simulateFailure: this.options.logins.forcedFailure(this.login.id) } : {}),
			// The pi runtime counts this provider's calls (llm-inflight); the CLI's running turns, whose
			// internal calls nothing sees, are reported from here.
			requestObserver: createClaudeRequestObserver({ countRequests: false }),
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
				// The login this child runs on: CLAUDE_CONFIG_DIR, or nothing for `default`.
				...this.login?.env,
				MCP_TOOL_TIMEOUT: String(this.options.mcpToolTimeoutMs ?? DEFAULT_MCP_TOOL_TIMEOUT_MS),
				// pi owns compaction. A child compacting on its own would answer
				// from a summary pi never saw, and the next restart would re-fold
				// pi's history over it. (Not DISABLE_COMPACT: that also removes
				// the manual /compact.) CLI 2.1.282 reads it as a boolean env.
				DISABLE_AUTO_COMPACT: "1",
			},
		});
		this.started = true;
		this.trackLogin(transport);

		const fields: Record<string, unknown> = { sdkMcpServers: [MCP_SERVER_NAME] };
		if (this.options.sendSystemPrompt !== false && request.systemPrompt) {
			fields.systemPrompt = [request.systemPrompt];
			fields.systemPromptSnapshot = false;
		}
		const ack = await transport.control("initialize", fields);
		if (ack === true) { this.everStarted = true; this.claudeId = sessionId; return undefined; }
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
		// The child replaced its history with its own summary (auto-compact is
		// off, so a `/compact` text got through). pi still holds the full
		// transcript; the next turn restarts onto pi's view.
		if (event.type === "system" && event.subtype === "compact_boundary") {
			this.markDesynced("Claude compacted its own context");
			return;
		}
		if (this.options.logins && this.accountEvent(event)) return;

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
		if (frame.type !== "init") turn.surfaced = true;
		turn.queue.push(frame);
		if (frame.type === "result") {
			turn.queue.end();
			return;
		}
		this.checkBoundary();
		if (turn.rejectedRun >= MAX_REJECTED_RUN) this.giveUpRejected(turn);
	}

	/**
	 * The model sent only invalid tool arguments MAX_REJECTED_RUN messages in a
	 * row: stop the CLI turn, as an abort does, and end the pi message with an
	 * error. The child's conversation now holds attempts pi never kept, so the
	 * next turn restarts it with folded history.
	 */
	private giveUpRejected(turn: TurnState): void {
		if (turn.queue.isEnded()) return;
		const message = `Claude sent invalid JSON arguments for tool "${turn.rejected ?? "unknown"}" ${MAX_REJECTED_RUN} times in a row`;
		this.markDesynced(message);
		turn.queue.push({ type: "result", outcome: "error", message });
		turn.queue.end();
		const transport = this.transport;
		if (!transport || transport.isClosed()) return;
		this.rejectHeld(message);
		// What the CLI says until its aborted result is the interrupt winding down.
		this.abortPending = true;
		void transport.interrupt().catch(() => { /* the restart next turn replaces the child anyway */ });
	}

	// -- logins -------------------------------------------------------------

	/**
	 * The login for the next child: the current one while usable, else the session's recorded one,
	 * else this host's first usable (ClaudeLoginSource.select). A change from what the session
	 * recorded is reported, so the session records it. A session whose login is no longer usable
	 * here first takes it back when the keeper has it free; else the change names why (`moved`).
	 */
	private async chooseLogin(): Promise<void> {
		const logins = this.options.logins;
		if (!logins) return;
		// Only a real entry pins the session; one never recorded takes the order's first usable
		// login, and records it: the session's login is known from its first turn, `default` too.
		const recorded = this.loginHooks()?.recorded;
		if (!this.recordedRead) { this.recordedLogin = recorded; this.recordedRead = true; }
		const current = this.login?.id ?? recorded;
		let gone: { label: string; cause: string; free: boolean } | undefined;
		try { gone = current !== undefined ? logins.absence?.(current) : undefined; } catch { gone = undefined; }
		if (gone?.free && logins.take) {
			try { await logins.take(current!); } catch { /* selection below falls back */ }
		}
		// In the pool, a device with nothing but `default` borrows a login first (accounts.ts acquire).
		let to: ClaudeLoginChoice;
		try { to = logins.acquire ? await logins.acquire(current) : logins.select(current); }
		catch (error) { debugLog({ event: "login-select-failed", session: this.piSessionId, error: String(error) }); return; }
		this.login = to;
		if (current === undefined || to.id === current || this.recordedLogin === undefined) { this.announce(to); return; }
		// Never a silent change: the note names the login the session left and why.
		try { gone = logins.absence?.(current) ?? gone; } catch { /* the first answer stands */ }
		const from: ClaudeLoginChoice = this.lastLogin?.id === current ? this.lastLogin : { id: current, label: gone?.label ?? current, env: {} };
		const cause = gone?.cause ?? "is not usable on this device";
		debugLog({ event: "login-switch", session: this.piSessionId, from: current, to: to.id, kind: "moved" });
		this.announce(to, { from, to, reason: "moved", text: movedText(from, to, cause) });
	}

	/**
	 * Lease the child's login while the child lives: the pool sees it in use, and a login that
	 * starts leaving gets this child torn down once it is idle (its next turn restarts elsewhere).
	 */
	private trackLogin(transport: ClaudeTransport): void {
		const logins = this.options.logins;
		const login = this.login;
		if (!logins?.track || !login) return;
		let lease: { done(): void; active(): void } | undefined;
		try {
			lease = logins.track(login.id, {
				busy: () => this.transport === transport && this.isBusy(),
				release: async () => { if (this.transport === transport && !this.isBusy()) await this.teardown(`Claude login ${login.label} is leaving this device`); },
				pid: () => transport.pid,
			});
		} catch { return; }
		this.lease?.done();
		this.lease = lease;
		void transport.whenClosed.then(() => { lease?.done(); if (this.lease === lease) this.lease = undefined; });
	}

	/**
	 * Report the session's login to the extension (a `claude-login` entry), when it changed. The
	 * session's hand-pick mark follows: written on the user's pick, dropped when it leaves that login.
	 */
	private announce(to: ClaudeLoginChoice, change?: ClaudeLoginSwitch): void {
		this.lastLogin = to;
		if (!change && to.id === this.recordedLogin) return;
		const was = this.recordedLogin;
		this.recordedLogin = to.id;
		const logins = this.options.logins;
		try {
			if (was !== undefined && was !== to.id) logins?.clearPick?.(was, this.piSessionId);
			if (change && !change.failure && !change.reason) logins?.markPick?.(to.id, this.piSessionId);
		} catch { /* the mark is plumbing */ }
		const hooks = this.loginHooks();
		// A child built later for this session (after an idle reap) starts from what was recorded last.
		if (hooks) hooks.recorded = to.id;
		try { hooks?.onChange?.(loginEntryFor(to, change)); } catch { /* the record is plumbing */ }
	}

	/**
	 * The user's pick (§app.claude-logins/switch-login): the session moves to `to` now. Refused while
	 * a turn or its held tool calls are open. The pick is recorded (the note row), and an idle child
	 * stops, so the next turn starts on `to` with the history folded, as after a model change.
	 * `from` names the session's login when this child has not chosen one yet.
	 */
	pickLogin(to: ClaudeLoginChoice, from: ClaudeLoginChoice): "switched" | "same" | "busy" {
		if (this.isBusy()) return "busy";
		if (!this.recordedRead) { this.recordedLogin = this.loginHooks()?.recorded; this.recordedRead = true; }
		const was = this.login ?? from;
		if (was.id === to.id) return "same";
		this.login = to;
		this.announce(to, { from: was, to, text: manualSwitchText(was, to) });
		debugLog({ event: "login-switch", session: this.piSessionId, from: was.id, to: to.id, kind: "manual" });
		if (this.started) void this.teardown(`Claude login switched to ${to.label} (chosen by you)`);
		return "switched";
	}

	/**
	 * Watch the turn's events for an account failure (transport.ts ClaudeFailureDetector). Returns
	 * true when the event is consumed: the synthetic message that carries the failure is not an
	 * answer, and the failed result is replaced by a switch of login when one is possible.
	 */
	private accountEvent(event: Record<string, unknown>): boolean {
		const turn = this.turn;
		if (!turn || turn.queue.isEnded()) return false;
		const early = this.detector.observe(event);
		if (early) { this.onAccountFailure(turn, early); return true; }
		if (this.detector.isFailureMessage(event)) return true;
		if (event.type !== "result") return false;
		const failure = this.detector.settle(event);
		if (!failure) return false;
		this.abortPending = false;
		this.onAccountFailure(turn, failure);
		return true;
	}

	private onAccountFailure(turn: TurnState, failure: ClaudeAccountFailure): void {
		const logins = this.options.logins!;
		const from = this.login ?? logins.select();
		(this.options.onDebug ?? debugLog)({ event: "account-failure", session: this.piSessionId, login: from.id, kind: failure.kind, surfaced: turn.surfaced });
		const fail = () => {
			// The child's conversation now ends in a failed exchange pi keeps as an error; the next
			// turn starts a fresh child, on whichever login is usable then.
			this.markDesynced(`Claude login ${from.label} failed (${failure.kind})`);
			if (this.turn === turn && !turn.queue.isEnded()) {
				turn.queue.push({ type: "result", outcome: "error", message: failure.message ?? (failure.kind === "limit" ? "Claude usage limit reached" : "Claude sign-in failed") });
				turn.queue.end();
			}
		};
		// Once pi has part of the answer, sending the turn again would duplicate it.
		if (turn.surfaced || turn.failovers >= 16) { logins.recordFailure(from, failure); fail(); return; }
		if (logins.failoverAsync) {
			// The pool: `from` goes back to the keeper, and the next login may have to be borrowed
			// first. The turn waits; nothing of it reached pi yet.
			turn.failovers++;
			void logins.failoverAsync(from, failure).catch(() => undefined).then((to) => {
				if (this.turn !== turn || turn.queue.isEnded()) return;
				if (!to) { fail(); return; }
				void this.switchLogin(turn, from, to, failure);
			});
			return;
		}
		let to: ClaudeLoginChoice | undefined;
		try { to = logins.failover(from, failure); } catch { to = undefined; }
		if (!to) { fail(); return; }
		turn.failovers++;
		void this.switchLogin(turn, from, to, failure);
	}

	/** Restart the child on `to` the way a model change does, and send the turn again. */
	private async switchLogin(turn: TurnState, from: ClaudeLoginChoice, to: ClaudeLoginChoice, failure: ClaudeAccountFailure): Promise<void> {
		const change: ClaudeLoginSwitch = { from, to, failure, text: switchText(from, to, failure) };
		this.login = to;
		this.announce(to, change);
		debugLog({ event: "login-switch", session: this.piSessionId, from: from.id, to: to.id, kind: failure.kind });
		try {
			await this.restart(turn.request, change.text);
		} catch (error) {
			if (this.turn === turn && !turn.queue.isEnded()) {
				turn.queue.push({ type: "result", outcome: "error", message: error instanceof Error ? error.message : String(error) });
				turn.queue.end();
			}
			return;
		}
		if (this.turn !== turn || turn.queue.isEnded()) return;
		if (turn.signal?.aborted) { this.markDesynced("the turn was aborted while Claude switched logins"); turn.queue.end(); return; }
		this.detector.reset();
		this.deliver(turn.request, { restart: true, reason: change.text, results: [], users: [], first: turn.first });
		this.recorded = transcriptFingerprint(turn.request.messages);
		this.meta = turnMeta(turn.request, this.cwd);
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
				// The CLI answered the last message's rejected calls itself; this is
				// its retry (or whatever the model said instead).
				this.openInputs.clear(); this.rejected = [];
				turn.accepted = 0; turn.rejected = undefined;
				turn.messageComplete = false; turn.wantsTools = false; turn.streaming = true;
			} else if (event.type === "content_block_start" && event.block.kind === "tool_use") {
				this.openInputs.set(event.index, { id: event.block.id, name: bareToolName(event.block.name), json: "", input: event.block.input });
				this.addPending(turn, event.block.id, event.block.name, event.block.input);
			} else if (event.type === "content_block_delta" && event.delta.kind === "input_json") {
				const open = this.openInputs.get(event.index);
				if (open) open.json += event.delta.partialJson;
			} else if (event.type === "content_block_stop") {
				// The block's arguments are complete now: judge them, then re-try any
				// held call that arrived before we had the block to match it against.
				const open = this.openInputs.get(event.index);
				if (open) {
					this.openInputs.delete(event.index);
					this.judgeInput(turn, open);
				}
				this.rematch();
			} else if (event.type === "message_delta") {
				// Not the end: ending here would leave the message_stop that
				// follows it to arrive with no turn open.
				if (event.stopReason === "tool_use") turn.wantsTools = true;
			} else if (event.type === "message_stop") {
				turn.messageComplete = true; turn.streaming = false;
				turn.rejectedRun = turn.rejected !== undefined && turn.accepted === 0 ? turn.rejectedRun + 1 : 0;
			}
			return;
		}
		if (frame.type === "assistant") {
			for (const block of frame.blocks) {
				if (block.kind !== "tool_use") continue;
				// A rejected call stays rejected, whatever a later frame says of it.
				if (this.rejected.some((r) => r.id === block.id)) continue;
				this.addPending(turn, block.id, block.name, block.input);
				// A streamed tool_use starts with empty input; this frame carries
				// the final arguments, which the tools/call matching compares.
				const slot = this.calls.find((call) => call.id === block.id);
				if (slot) { slot.input = block.input; slot.announced = block.input; }
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
		this.calls.push({ id, name: bareToolName(name), input });
		turn.wantsTools = true;
		this.rematch();
	}

	/**
	 * A tool_use block's arguments are complete. Valid ones become what the
	 * exact-arguments match compares a `tools/call` against. An invalid one leaves
	 * pi's calls: stream.ts drops it from the pi message by the same rule, so
	 * pi never answers it, and a message left with no call does not end the pi
	 * message (checkBoundary), which stays open for the CLI's retry.
	 */
	private judgeInput(turn: TurnState, open: { id: string; name: string; json: string; input: unknown }): void {
		// The block-start input untouched, as stream.ts judges it.
		const verdict = parseToolInput(open.json, open.input);
		const slot = this.calls.find((call) => call.id === open.id);
		if (verdict.ok) {
			turn.accepted++;
			// pi's own parse of the bytes; the CLI's announced copy (assistant frame) stays as `announced`.
			if (slot) slot.input = verdict.args;
			return;
		}
		this.calls = this.calls.filter((call) => call !== slot);
		// A call matched to it by name alone was some other block's: match it again.
		if (slot?.held) this.unmatched.push(slot.held);
		this.rejected.push({ id: open.id, name: open.name });
		turn.rejected ??= open.name;
		// Never the arguments themselves: their length and where parsing failed.
		(this.options.onDebug ?? debugLog)({
			event: "tool-input-rejected", session: this.piSessionId, tool: open.name, id: open.id, bytes: verdict.bytes, error: verdict.error,
			...(verdict.position === undefined ? {} : { position: verdict.position }),
		});
	}

	/**
	 * A held `tools/call` names its tool but carries no `tool_use` id, so it is
	 * matched against the announced blocks: same name, and same arguments when
	 * that distinguishes two calls of one tool. Arrival order breaks the tie.
	 * While a call of that tool was rejected, only an exact match counts: a call
	 * matching no valid block is failed, so a rejected call never runs under a
	 * valid one's id.
	 */
	private rematch(): void {
		if (!this.unmatched.length) return;
		const rest: HeldMcpCall[] = [];
		for (const call of this.unmatched) {
			const exact = this.calls.find((p) => !p.held && p.name === call.name && sameArguments(p, call.arguments));
			if (!exact && this.rejected.some((r) => r.name === call.name)) {
				// A block of that tool still streaming may yet match it exactly.
				if ([...this.openInputs.values()].some((open) => open.name === call.name)) { rest.push(call); continue; }
				(this.options.onDebug ?? debugLog)({ event: "rejected-call-failed", session: this.piSessionId, tool: call.name });
				this.host?.fail(call, REJECTED_CALL_REASON);
				continue;
			}
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
		this.calls = []; this.unmatched = []; this.rejected = []; this.openInputs.clear();
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
	/** New user messages since the last turn, oldest first. */
	users: Message[];
	/** No child has ever run for this pi session; the fold is first contact. */
	first?: boolean;
	/** Resume (and fork) this CLI session instead of folding: `users` is all it has not heard. */
	resume?: string;
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
	/** pi session id -> its login record and change sink (setSessionLogin). */
	private readonly logins = new Map<string, SessionLoginHooks>();
	private readonly options: SessionBridgeOptions;
	private readonly limits: SessionBridgeLimits;
	/** This process's fork seed (`CLAUDE_FORK_ENV`), for its first conversation's child only. */
	private forkSeed?: ClaudeForkPoint;
	/** pi session id -> the fork point it was seeded with, and its source (seedFork). */
	private readonly seeds = new Map<string, { point: ClaudeForkPoint; from: string }>();

	constructor(options: SessionBridgeOptions = {}) {
		this.options = options;
		this.limits = { ...LIMITS, ...options.limits };
		this.forkSeed = options.forkFrom ?? decodeForkPoint((options.env?.[CLAUDE_FORK_ENV] ?? process.env[CLAUDE_FORK_ENV]));
	}

	/** See CliSession.forkPoint; undefined for a session with no child here. */
	forkPoint(piSessionId: string): ClaudeForkPoint | undefined {
		return this.sessions.get(piSessionId)?.forkPoint();
	}

	/**
	 * Seed one pi session (a fork created in this process, fork-point.ts `seedForkPoint`) with its
	 * source's fork point, for that session's first conversation child. Unlike the process seed,
	 * it may be taken long after: see takeSeed.
	 */
	seedFork(piSessionId: string, point: ClaudeForkPoint, fromPiSessionId: string): void {
		this.seeds.set(piSessionId, { point, from: fromPiSessionId });
	}

	/**
	 * The fork point a new conversation child starts from: its own seed, only while the source's
	 * CLI is still exactly there (live, idle, same record and prefix) — resuming a record that has
	 * moved on would hand the fork the source's later turns — else this process's seed, once.
	 */
	private takeSeed(key: string): ClaudeForkPoint | undefined {
		const seeded = this.seeds.get(key);
		if (seeded) {
			this.seeds.delete(key);
			const now = this.forkPoint(seeded.from);
			const same = now && now.claudeSessionId === seeded.point.claudeSessionId && now.messages === seeded.point.messages && now.prefix === seeded.point.prefix && now.cwd === seeded.point.cwd;
			return same ? seeded.point : undefined;
		}
		const seed = this.forkSeed;
		this.forkSeed = undefined;
		return seed;
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

	/**
	 * Record the login a pi session last ran on (its newest `claude-login` entry) and where a
	 * change is reported. Called from the extension's session_start handler.
	 */
	setSessionLogin(sessionId: string, recorded: string | undefined, onChange: (entry: ClaudeLoginEntry) => void): void {
		if (!sessionId) return;
		this.logins.set(sessionId, { recorded, onChange });
	}

	/**
	 * Move a pi session to the login the user picked (§app.claude-logins/switch-login). With a child,
	 * see CliSession.pickLogin; without one, only the pick is recorded and the first child starts
	 * there. `from` is the session's login as recorded (or the one it would start on). "unknown": the
	 * session never announced itself (the provider is off for it).
	 */
	switchSessionLogin(sessionId: string, to: ClaudeLoginChoice, from: ClaudeLoginChoice): "switched" | "same" | "busy" | "unknown" {
		const session = this.sessions.get(sessionId);
		if (session) return session.pickLogin(to, from);
		const hooks = this.logins.get(sessionId);
		if (!hooks) return "unknown";
		if (from.id === to.id) return "same";
		const logins = this.options.logins;
		try {
			if (hooks.recorded !== undefined && hooks.recorded !== to.id) logins?.clearPick?.(hooks.recorded, sessionId);
			logins?.markPick?.(to.id, sessionId);
		} catch { /* the mark is plumbing */ }
		hooks.recorded = to.id;
		try { hooks.onChange?.(loginEntryFor(to, { from, to, text: manualSwitchText(from, to) })); } catch { /* the record is plumbing */ }
		return "switched";
	}

	/** The cwd a session's child should run in, best known to worst. */
	private cwdFor(sessionId: string): string {
		return this.cwds.get(sessionId) ?? this.options.cwd ?? process.cwd();
	}

	runTurn(request: ClaudeTurnRequest, signal?: AbortSignal): AsyncIterable<ClaudeFrame> {
		const key = request.sessionId ?? "default";
		let session = this.sessions.get(key);
		// A one-shot request: no tools, and a session id no pi session ever
		// announced. pi's compaction and branch summaries arrive like this, each
		// under a fresh uuid, so their child would otherwise idle until reaped.
		const oneShot = !session && request.tools.length === 0 && !this.cwds.has(key);
		if (!session) {
			// A pi child forked from a Claude session (a background fork) or a fork Sova seeded gets
			// the seed for its conversation; one-shot requests (compaction, branch summaries) never do.
			const seed = oneShot ? undefined : this.takeSeed(key);
			session = new CliSession(key, this.options, this.cwdFor(key), seed, () => this.logins.get(key));
			this.sessions.set(key, session);
		}
		this.reapIdle(key);
		return oneShot ? this.runOneShot(key, session, request, signal) : session.runTurn(request, signal);
	}

	/** Run a one-shot request, then dispose of its child whatever the outcome. */
	private async *runOneShot(key: string, session: CliSession, request: ClaudeTurnRequest, signal?: AbortSignal): AsyncGenerator<ClaudeFrame> {
		try {
			yield* session.runTurn(request, signal);
		} finally {
			if (this.sessions.get(key) === session) this.sessions.delete(key);
			// Not awaited: the answer is complete, and the child's exit ladder
			// should not delay the caller.
			void session.teardown("one-shot request finished");
		}
	}

	/**
	 * pi session ids with a live CLI child, for diagnostics and the live smoke
	 * test. Reading it must never be load-bearing for behaviour.
	 */
	activeSessionIds(): string[] { return [...this.sessions.keys()]; }

	/** Called from the extension's `session_shutdown` hook. */
	async disposeSession(piSessionId: string, reason = "pi session shut down"): Promise<void> {
		this.cwds.delete(piSessionId);
		this.logins.delete(piSessionId);
		this.seeds.delete(piSessionId);
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
const REGISTRY = BRIDGE_REGISTRY;

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
