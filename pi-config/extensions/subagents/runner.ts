/**
 * The worker types and helpers every worker shares (al_3 stage 4): its status and outcome, its
 * transcript items and usage, the loadout its parent computes (SpawnOptions), and how a Claude
 * model is loaded. A worker is a chat process of its own (chat-worker.ts); its events are folded
 * in fold.ts.
 *
 * Lifecycle model (task outcome is deliberately separate from process state):
 *
 *   status        lifecycle: starting → running → waiting ⇄ running
 *                 stopping (teardown in progress) → killed
 *                 terminal: done | error | killed (the worker has ENDED)
 *   taskOutcome   outcome of the most recently COMPLETED task:
 *                 "success" | "error" | "aborted"; undefined while a task runs
 *
 *   `waiting` means: idle, steerable. A task that FAILED still parks in `waiting` with taskOutcome
 *   "error": the worker is fine, the work failed. Callers that care about the result read
 *   `taskOutcome`, callers that care about the worker read `isFinished()` / `processAlive`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeModel } from "../claude-code/catalog.ts";

/** Pi's built-in tool names. `--tools` and `--exclude-tools` also govern extension tools, so restriction must be phrased per case. */
export const BUILTIN_TOOLS: readonly string[] = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

/** "restored": rebuilt from the owner's durable record after a restart; no process (see restored.ts). */
export type AgentStatus = "starting" | "running" | "waiting" | "stopping" | "done" | "error" | "killed" | "restored";

/** Outcome of the most recently completed task. Undefined while a task is running. */
export type TaskOutcome = "success" | "error" | "aborted";

export type TranscriptKind = "task" | "steer" | "assistant" | "thinking" | "tool" | "tool-result" | "error" | "system";

export interface TranscriptItem {
	ts: number;
	kind: TranscriptKind;
	text: string;
	toolName?: string;
	/** Render-only one-line summary (write/edit +/− counts); never replaces `text`. */
	summary?: string;
}

export interface AgentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	contextTokens: number;
}

/**
 * Memory bounds. The child's own session file is the canonical full record.
 * maxTranscriptBytes is true UTF-8 bytes; maxItemChars is JavaScript string
 * characters (which bound the UTF-16 buffer memory).
 */
export interface RunnerLimits {
	/** In-memory transcript tail cap (UTF-8 bytes). Oldest items are trimmed. */
	maxTranscriptBytes: number;
	/** Per-transcript-item text cap (characters); longer items are truncated in memory. */
	maxItemChars: number;
}

/**
 * The claude-code extension's pi provider (claude-code/provider/index.ts: CLAUDE_PROVIDER_ID and
 * CLAUDE_PROVIDER_FLAG; the literals are repeated here so this extension loads without that one).
 * The provider is registered at the worker's session_start, and only under `--claude-code-provider`.
 */
export const CLAUDE_CODE_CLI_PROVIDER = "claude-code-cli";
export const CLAUDE_CODE_PROVIDER_FLAG = "claude-code-provider";
/**
 * The provider's flag naming one more model to register (claude-code/provider/index.ts
 * CLAUDE_MODEL_FLAG): a Claude id Sova's catalog doesn't know yet is still used.
 */
export const CLAUDE_CODE_MODEL_FLAG = "claude-code-model";
/** The provider/model of a `claude-code-cli/<id>` ref, or undefined for every other model (argv as today). */
export function rpcScopedModel(model: string | undefined): { provider: string; modelId: string } | undefined {
	if (!model) return undefined;
	const slash = model.indexOf("/");
	if (slash < 1 || slash === model.length - 1) return undefined;
	const provider = model.slice(0, slash);
	return provider === CLAUDE_CODE_CLI_PROVIDER ? { provider, modelId: model.slice(slash + 1) } : undefined;
}

/**
 * The claude-code extension (a sibling directory of subagents/), resolved through this file's real
 * path so the ~/.pi/agent/extensions symlinks find it in the checkout.
 */
const CLAUDE_CODE_DIR = realpathOr(path.join(path.dirname(realpathOr(fileURLToPath(import.meta.url))), "..", "claude-code"));
export const CLAUDE_CODE_EXTENSION = path.join(CLAUDE_CODE_DIR, "index.ts");
function realpathOr(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}
/**
 * A pi child on a `claude-code-cli/<id>` model loads the claude-code extension (last) with
 * `--claude-code-provider`, so the provider exists when the worker's model is set; an id
 * the catalog doesn't know is named with `--claude-code-model`, so the provider registers it too.
 * Every other model gets the inputs back unchanged.
 */
export function claudeCodeProviderLoad(
	model: string | undefined,
	extensions: string[],
	flags: Record<string, string | true> | undefined,
): { extensions: string[]; flags: Record<string, string | true> | undefined } {
	const scoped = rpcScopedModel(model);
	if (!scoped) return { extensions, flags };
	const unknown: Record<string, string> = claudeModel(scoped.modelId) ? {} : { [CLAUDE_CODE_MODEL_FLAG]: scoped.modelId };
	return { extensions: [...extensions, CLAUDE_CODE_EXTENSION], flags: { ...(flags ?? {}), [CLAUDE_CODE_PROVIDER_FLAG]: true, ...unknown } };
}

export interface SpawnOptions {
	backend?: string;
	backendOptions?: Record<string, unknown>;
	id: string;
	groupId: string;
	name: string;
	task: string;
	/** "provider/modelId"; a claude-code-cli ref loads the provider's extension (claudeCodeProviderLoad). */
	model?: string;
	effort?: string;
	tools?: string[];
	systemPrompt?: string;
	cwd: string;
	/** Trigger a parent turn when this worker settles while the parent is idle. Default true. */
	wake?: boolean;
	/** Extension sources (path, npm:, git:) the worker loads, and nothing else. */
	extensions?: string[];
	/**
	 * Extension CLI flags for the child (`--<name> <value>`, or `--<name>` for `true`), after the `-e`
	 * sources: pi matches them against the flags those extensions register (an unmatched flag is a
	 * startup error). The remote extension's `target` is the one use today.
	 */
	flags?: Record<string, string | true>;
	/** Parent session file to fork: the child starts with the parent's full message history. */
	forkSession?: string;
	/** Extra environment for the child, merged over the parent's (team member identity for member.ts). */
	env?: Record<string, string>;
	/** Where the worker's session file goes (a worker on another agent dir keeps it in the parent's). */
	sessionDir?: string;
	/**
	 * Continue this worker's own session after a restart (agent_resume): its chat opens that
	 * file and comes up IDLE — no task
	 * prompt is sent and no completion is announced; `task` is only the record's label.
	 * `startedAt` is its first spawn (ms), kept as the worker's `startedAt` across the resume.
	 */
	resume?: { sessionId?: string; sessionFile?: string; startedAt?: number };
	/** @internal Test overrides. */
	limits?: Partial<RunnerLimits>;
}

export interface SteerResult {
	ok: boolean;
	reason?: string;
	/** Not ok, but the message may have been delivered all the same (no answer came). */
	unknown?: true;
}

export function summarizeToolCall(name: string, args: Record<string, any>): string {
	const shorten = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};
	switch (name) {
		case "bash": {
			const command = String(args.command ?? "");
			return command.length > 120 ? `${command.slice(0, 120)}…` : command;
		}
		case "read":
		case "write":
		case "edit":
			return shorten(String(args.path ?? args.file_path ?? "?"));
		case "ls":
			return shorten(String(args.path ?? "."));
		case "grep":
			return `/${args.pattern ?? ""}/ in ${shorten(String(args.path ?? "."))}`;
		case "find":
			return `${args.pattern ?? "*"} in ${shorten(String(args.path ?? "."))}`;
		default: {
			const json = JSON.stringify(args ?? {});
			return json.length > 100 ? `${json.slice(0, 100)}…` : json;
		}
	}
}
