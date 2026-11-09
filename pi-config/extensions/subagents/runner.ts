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

export { CLAUDE_CODE_CLI_PROVIDER, CLAUDE_CODE_EXTENSION, CLAUDE_CODE_MODEL_FLAG, CLAUDE_CODE_PROVIDER_FLAG, claudeCodeProviderLoad, rpcScopedModel } from "./worker-load.ts";

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
	/** Its MCP servers: the list its parent's chat answered for `mcpServers`, opaque here. */
	mcp?: unknown;
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
