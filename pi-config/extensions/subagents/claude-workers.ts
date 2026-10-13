/**
 * A `backend: "claude-code"` spawn, as the pi worker it now runs as: a Claude model on Sova's
 * tools, through the claude-code extension's provider (`claude-code-cli/<catalog id>`), the same
 * path a Claude Code chat runs on. The parameter stays for every caller (agent_spawn, team
 * members, coordinators and monitors, Delegate); this module maps what it asks for onto the pi
 * worker, and refuses what has no meaning there. A worker recorded before, which ran the Claude
 * Code CLI's own tools, is continued the same way by a resume (`continuation*`, below).
 *
 * Builtins only, plus claude-code's catalog (which imports nothing).
 */
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalClaudeId, claudeBareId, isClaudeIdShape, latestClaude } from "../claude-code/catalog.ts";

export const CLAUDE_CODE_BACKEND = "claude-code";
/** The claude-code extension's provider id (claude-code/provider/index.ts CLAUDE_PROVIDER_ID). */
const PROVIDER = "claude-code-cli";
export const CLAUDE_WORKER_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** Claude Code's tool names → Sova's (pi's) tools. */
export const CLAUDE_TOOL_NAMES: Readonly<Record<string, string>> = Object.freeze({
	Read: "read", Bash: "bash", Edit: "edit", Write: "write", Grep: "grep", Glob: "find", LS: "ls",
});
/** Sova's tools a Claude worker gets when its spawn names none. */
export const CLAUDE_WORKER_TOOLS: readonly string[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const READ_ONLY_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];
const OPTION_KEYS = ["permissionMode", "allowedTools", "maxBudgetUsd"];

export interface ClaudeWorkerSpec {
	backend?: string;
	model?: string;
	effort?: string;
	tools?: string[];
	backendOptions?: Record<string, unknown>;
}

/** The pi model ref a Claude spawn's model runs as; Sonnet's current id when none is given. */
export function claudeWorkerModel(model: string | undefined): string {
	const bare = claudeBareId(model?.trim() ? model : latestClaude("sonnet").id);
	if (!isClaudeIdShape(bare)) throw new Error("Claude model must be a Claude model ID (agent_models lists them), not a Pi provider/model ID.");
	return `${PROVIDER}/${canonicalClaudeId(bare)}`;
}

/** Claude or Sova tool names → Sova's; any other name is refused with the list. */
export function claudeWorkerTools(tools: readonly string[] | undefined): string[] {
	if (tools === undefined) return [...CLAUDE_WORKER_TOOLS];
	const out: string[] = [];
	for (const name of tools) {
		const mapped = CLAUDE_TOOL_NAMES[name] ?? (CLAUDE_WORKER_TOOLS.includes(name) ? name : undefined);
		if (!mapped) {
			throw new Error(`Claude workers run on Sova's tools: ${CLAUDE_WORKER_TOOLS.join(", ")} (Claude's ${Object.entries(CLAUDE_TOOL_NAMES).map(([c, p]) => `${c} → ${p}`).join(", ")}). ${JSON.stringify(name)} has no equivalent.`);
		}
		if (!out.includes(mapped)) out.push(mapped);
	}
	return out;
}

/**
 * backendOptions on Sova's tools: `permissionMode` bypassPermissions/dontAsk change nothing (the
 * worker has exactly its tools, with no approval step), `plan` keeps only the read-only tools.
 * acceptEdits/manual (per-call approval), allowedTools (CLI permission rules) and maxBudgetUsd
 * (a CLI spend ceiling) have no equivalent and are refused rather than silently dropped.
 */
export function claudeWorkerOptions(options: unknown, tools: string[]): string[] {
	if (options === undefined) return tools;
	if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("claude-code backendOptions must be an object.");
	const raw = options as Record<string, unknown>;
	for (const key of Object.keys(raw)) if (!OPTION_KEYS.includes(key)) throw new Error(`Unknown claude-code backend option: ${key}`);
	if (raw.allowedTools !== undefined) throw new Error("backendOptions.allowedTools is not supported: Claude workers run on Sova's tools, which take no permission rules. Restrict the worker with tools instead.");
	if (raw.maxBudgetUsd !== undefined) throw new Error("backendOptions.maxBudgetUsd is not supported: Claude workers run on Sova's tools, which have no spend ceiling.");
	const mode = raw.permissionMode;
	if (mode === undefined || mode === "bypassPermissions" || mode === "dontAsk") return tools;
	if (mode === "plan") return tools.filter((t) => READ_ONLY_TOOLS.includes(t));
	if (mode === "acceptEdits" || mode === "manual") throw new Error(`permissionMode ${mode} is not supported: Claude workers run on Sova's tools, which have no per-call approval. Restrict the worker with tools instead (plan keeps only read, grep, find and ls).`);
	throw new Error("Claude permissionMode must be bypassPermissions, dontAsk or plan.");
}

/**
 * A claude-code spec as a pi spec (backend dropped, so it records as `pi`): its model as the
 * provider's ref, its effort (medium by default) as the worker's thinking level, its tools as
 * Sova's. Every other spec is returned as it is.
 */
export function claudeOnPi<T extends ClaudeWorkerSpec>(spec: T): T {
	if (spec.backend !== CLAUDE_CODE_BACKEND) return spec;
	const effort = spec.effort ?? "medium";
	if (!(CLAUDE_WORKER_EFFORTS as readonly string[]).includes(effort)) throw new Error("Claude effort must be low, medium, high, xhigh, or max.");
	const { backend: _backend, backendOptions, ...rest } = spec;
	return { ...rest, model: claudeWorkerModel(spec.model), effort, tools: claudeWorkerOptions(backendOptions, claudeWorkerTools(spec.tools)) } as T;
}

// ── Continuing a native Claude Code worker ──────────────────────────────────
// A worker recorded before Claude Code workers became pi workers ran the CLI's own tools, so its
// Claude session can't be reopened. A resume starts it as today's Claude worker under the same id,
// in a new pi session seeded with one message that hands its work over.

/** How much of the old worker's last answer the handoff carries. */
export const CONTINUATION_OUTPUT_CHARS = 2_000;

/** Its recorded tools as Sova's: a name with no equivalent is dropped, never refused (it already ran). */
export function continuationTools(tools: readonly string[] | undefined): string[] | undefined {
	if (tools === undefined) return undefined;
	const out: string[] = [];
	for (const name of tools) {
		const mapped = CLAUDE_TOOL_NAMES[name] ?? (CLAUDE_WORKER_TOOLS.includes(name) ? name : undefined);
		if (mapped && !out.includes(mapped)) out.push(mapped);
	}
	// Tools were recorded but none maps: keep read, which the handoff needs to open the old transcript.
	if (tools.length > 0 && out.length === 0) out.push("read");
	return out;
}

/** Its recorded backendOptions: only `permissionMode: "plan"` still means something (read-only tools). */
export function continuationOptions(options: unknown): Record<string, unknown> | undefined {
	return options && typeof options === "object" && (options as Record<string, unknown>).permissionMode === "plan" ? { permissionMode: "plan" } : undefined;
}

export interface ContinuationFacts {
	id: string;
	name: string;
	role?: string;
	/** The old Claude transcript's absolute path, when one was found. */
	transcript?: string;
	task?: string;
	lastOutput?: string;
}

/** The new session's first message: what it continues, where that transcript is, and its last answer. */
export function continuationMessage(f: ContinuationFacts): string {
	const who = f.role && f.role !== f.name ? `${f.name}, ${f.role}` : f.name;
	const tail = (f.lastOutput ?? "").trim();
	const clipped = tail.length > CONTINUATION_OUTPUT_CHARS ? `…${tail.slice(-CONTINUATION_OUTPUT_CHARS)}` : tail;
	return [
		`[Continuing an earlier Claude Code worker: ${f.id} (${who})]`,
		`You continue the work of ${f.id}, a Claude Code worker whose run ended. It ran the Claude Code CLI's own tools, which Sova no longer runs; you run on Sova's tools, in a new session.`,
		f.transcript
			? `Its transcript is ${f.transcript} (read-only: read it with your read tool when you need more than what is below; never write it).`
			: "No transcript of its run was found.",
		...(f.task?.trim() ? ["", "Its task:", f.task.trim()] : []),
		...(clipped ? ["", "Its last answer:", clipped] : []),
		"",
		"Wait for your next instruction; do not start work on your own.",
	].join("\n");
}

/**
 * Write the new pi session file a continuation resumes into: pi's session header and the handoff as
 * its one user message (pi itself writes a session only once a reply exists). `dir` is where a
 * worker in `cwd` keeps its sessions. Returns the file; throws when it can't be written.
 */
export function seedContinuationSession(dir: string, cwd: string, text: string, version: number, now = new Date()): string {
	const id = randomUUID();
	const stamp = now.toISOString();
	const file = path.join(dir, `${stamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
	const header = { type: "session", version, id, timestamp: stamp, cwd };
	const message = {
		type: "message", id: randomBytes(4).toString("hex"), parentId: null, timestamp: stamp,
		message: { role: "user", content: [{ type: "text", text }], timestamp: now.getTime() },
	};
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`, { mode: 0o600, flag: "wx" });
	return file;
}
