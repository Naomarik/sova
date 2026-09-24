/**
 * Worker transcript adapter for the claude-code backend: the Claude CLI's own
 * session record, `<projects>/<cwd-slug>/<uuid>.jsonl`, found by UUID.
 *
 * Usage is tokens only (the CLI's JSONL carries no cost), per model. The CLI
 * repeats one assistant message (same `message.id`, same usage) on a line per
 * content block, so lines are deduplicated by message id — across every file
 * read, since a resumed or forked record may copy history. Nested Task agents
 * (sidechains) are the worker's own spend and are counted: inline
 * `isSidechain` lines (older CLIs) and `<uuid>/subagents/agent-*.jsonl`
 * (current CLIs) alike. Summary and items follow the main chain only.
 *
 * Node builtins only, and no pi runtime: Sova's server may import this file.
 * The projects root and slug rule are shared with the provider bridge
 * (provider/session-records.ts).
 */
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import {
	addRow,
	checkRef,
	parseJsonLines,
	type TokenCounts,
	type WorkerTranscriptAdapter,
	type WorkerTranscriptCapabilities,
	type WorkerTranscriptItem,
	type WorkerTranscriptLocation,
	type WorkerTranscriptRef,
	type WorkerTranscriptSummary,
	type WorkerUsage,
	type WorkerUsageRow,
} from "../subagents/worker-transcript.ts";
import { claudeProjectDirsFor, claudeProjectsRoot } from "./provider/session-records.ts";

type Entry = Record<string, any>;

/** Claude session ids are UUIDs; anything else never reaches the filesystem. */
export const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESULT_TEXT_MAX = 2000;
const SYNTHETIC_MODEL = "<synthetic>";

const amount = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
const epoch = (value: unknown): number | undefined => {
	if (typeof value !== "string") return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
};

function canonical(p: string): string | null {
	try {
		return realpathSync(p);
	} catch {
		return null;
	}
}

export interface LocateClaudeOptions {
	/** Try this cwd's project directory first. */
	cwd?: string;
	/** The projects root; defaults to claudeProjectsRoot(). */
	root?: string;
}

/**
 * The record file of a Claude session, or null. The id must be a UUID; the
 * cwd's own project directory is tried first, then every project directory.
 * The resolved file must still be inside the root after realpath, so a symlink
 * planted in a project directory cannot read anything else.
 */
export function locateClaudeSession(id: string, options: LocateClaudeOptions = {}): string | null {
	if (!CLAUDE_SESSION_ID_RE.test(id)) return null;
	const rootPath = options.root ?? claudeProjectsRoot();
	const base = canonical(rootPath);
	if (!base) return null;
	const name = `${id}.jsonl`;
	const inside = (file: string): string | null => {
		const real = canonical(file);
		return real && real.startsWith(base + sep) ? real : null;
	};
	if (options.cwd) {
		for (const dir of claudeProjectDirsFor(options.cwd, base)) {
			const hit = existsSync(join(dir, name)) ? inside(join(dir, name)) : null;
			if (hit) return hit;
		}
	}
	let projects: string[];
	try {
		projects = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
	} catch {
		return null;
	}
	for (const project of projects) {
		let names: string[];
		try {
			names = readdirSync(join(base, project));
		} catch {
			continue;
		}
		if (!names.includes(name)) continue;
		const hit = inside(join(base, project, name));
		if (hit) return hit;
	}
	return null;
}

/** Nested-agent records of a session: `<dir>/<uuid>/subagents/*.jsonl` beside `<dir>/<uuid>.jsonl`. */
export function claudeSidechainFiles(sessionFile: string): string[] {
	const dir = join(sessionFile.replace(/\.jsonl$/, ""), "subagents");
	try {
		return readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort().map((n) => join(dir, n));
	} catch {
		return [];
	}
}

const modelName = (model: unknown): string | undefined =>
	typeof model === "string" && model && model !== SYNTHETIC_MODEL ? `claude/${model}` : undefined;

/**
 * Incremental Claude usage: feed parsed lines of any number of files (main
 * record and sidechains), read the total any time; `reset()` to start over.
 */
export interface ClaudeUsageAccumulator {
	add(entries: readonly unknown[]): void;
	usage(): WorkerUsage;
	reset(): void;
}

export function claudeUsageAccumulator(): ClaudeUsageAccumulator {
	let seen = new Set<string>();
	let rows = new Map<string, WorkerUsageRow>();
	let total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
	let nested = false;
	return {
		add(entries) {
			for (const raw of entries) {
				const e = raw as Entry;
				if (!e || e.type !== "assistant") continue;
				const message = e.message;
				const u = message?.usage;
				if (!u || typeof u !== "object") continue;
				const id = typeof message.id === "string" ? message.id : typeof e.uuid === "string" ? e.uuid : undefined;
				if (id) {
					if (seen.has(id)) continue;
					seen.add(id);
				}
				if (e.isSidechain === true) nested = true;
				const counts: TokenCounts = {
					input: amount(u.input_tokens), output: amount(u.output_tokens),
					cacheRead: amount(u.cache_read_input_tokens), cacheWrite: amount(u.cache_creation_input_tokens), turns: 1,
				};
				total.input += counts.input; total.output += counts.output; total.cacheRead += counts.cacheRead; total.cacheWrite += counts.cacheWrite;
				total.turns++;
				if (counts.input + counts.output + counts.cacheRead + counts.cacheWrite > 0) addRow(rows, modelName(message.model) ?? "claude/unknown", counts);
			}
		},
		usage() {
			return {
				...total,
				byModel: [...rows.values()].map((r) => ({ ...r })),
				source: "transcript",
				policy: { cacheWarm: false, nestedAgents: nested, forkBoundary: false },
			};
		},
		reset() {
			seen = new Set();
			rows = new Map();
			total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
			nested = false;
		},
	};
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}

const clip = (s: string, max = RESULT_TEXT_MAX): string => (s.length > max ? `${s.slice(0, max)}…` : s);
const INTERRUPTED_RE = /^\[Request interrupted by user/;

/** Lines of the worker's own conversation: not nested agents, not injected context, not CLI bookkeeping. */
const mainChain = (entries: readonly unknown[]): Entry[] =>
	(entries as Entry[]).filter((e) => e && typeof e === "object" && e.isSidechain !== true && (e.type === "user" || e.type === "assistant" || e.type === "system") && !(e.type === "user" && e.isMeta === true));

export function claudeItems(entries: readonly unknown[]): WorkerTranscriptItem[] {
	const out: WorkerTranscriptItem[] = [];
	for (const e of mainChain(entries)) {
		const at = epoch(e.timestamp);
		const stamp = at === undefined ? {} : { at };
		if (e.type === "system") {
			if (e.subtype === "compact_boundary") out.push({ kind: "system", text: "Compacted", ...stamp });
			continue;
		}
		const content = e.message?.content;
		if (e.type === "user") {
			const blocks: any[] = Array.isArray(content) ? content : [];
			const results = blocks.filter((b) => b?.type === "tool_result");
			if (results.length) {
				for (const b of results) out.push({ kind: "tool-result", text: clip(contentText(b.content)), ...stamp });
				continue;
			}
			const text = contentText(content);
			if (text.trim()) out.push({ kind: INTERRUPTED_RE.test(text) ? "system" : "task", text, ...stamp });
			continue;
		}
		const model = modelName(e.message?.model);
		const tag = model ? { model } : {};
		if (e.isApiErrorMessage === true || e.message?.model === SYNTHETIC_MODEL) {
			const text = contentText(content) || String(e.message?.stop_details?.explanation ?? "assistant turn failed");
			out.push({ kind: "error", text, ...stamp });
			continue;
		}
		for (const b of Array.isArray(content) ? content : []) {
			if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) out.push({ kind: "assistant", text: b.text, ...stamp, ...tag });
			else if (b?.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) out.push({ kind: "thinking", text: b.thinking, ...stamp, ...tag });
			else if (b?.type === "tool_use") out.push({ kind: "tool", text: clip(JSON.stringify(b.input ?? {})), toolName: String(b.name ?? "tool"), ...stamp, ...tag });
		}
	}
	return out;
}

/**
 * Summary of a Claude record: `main` is the session file's lines, `nested`
 * the sidechain files' lines (usage only).
 */
export function summarizeClaudeEntries(main: readonly unknown[], nested: readonly unknown[], ref: WorkerTranscriptRef, opts: { items?: "none" | "tail" | "all"; limit?: number } = {}): WorkerTranscriptSummary {
	const acc = claudeUsageAccumulator();
	acc.add(main);
	acc.add(nested);
	const summary: WorkerTranscriptSummary = { ref, found: true, state: "unknown", compactions: 0, partialTurn: false, usage: acc.usage() };
	let first: number | undefined;
	let last: number | undefined;
	for (const e of main as Entry[]) {
		const at = epoch(e?.timestamp);
		if (at === undefined) continue;
		if (first === undefined || at < first) first = at;
		if (last === undefined || at > last) last = at;
	}
	if (first !== undefined) summary.startedAt = first;
	if (last !== undefined) summary.lastActivityAt = last;
	let lastTurn: Entry | undefined;
	for (const e of mainChain(main)) {
		if (e.type === "system") { if (e.subtype === "compact_boundary") summary.compactions++; continue; }
		lastTurn = e;
		if (e.type !== "assistant") continue;
		const model = modelName(e.message?.model);
		if (model) summary.model = model;
		if (typeof e.effort === "string") summary.effort = e.effort;
		const text = contentText(e.message?.content).trim();
		if (text && e.isApiErrorMessage !== true && e.message?.model !== SYNTHETIC_MODEL) summary.lastAssistantText = text;
	}
	if (lastTurn?.type === "assistant") {
		const stop = lastTurn.message?.stop_reason;
		if (lastTurn.isApiErrorMessage === true || lastTurn.message?.model === SYNTHETIC_MODEL || stop === "refusal") {
			summary.state = "settled";
			summary.lastOutcome = "error";
		} else if (stop === "end_turn" || stop === "stop_sequence" || stop === "max_tokens") {
			summary.state = "settled";
			summary.lastOutcome = "success";
		} else {
			summary.state = "in-progress"; // tool_use awaiting its result, or a reply cut mid-stream
			summary.partialTurn = true;
		}
	} else if (lastTurn?.type === "user") {
		if (INTERRUPTED_RE.test(contentText(lastTurn.message?.content))) {
			summary.state = "settled";
			summary.lastOutcome = "aborted";
		} else {
			summary.state = "in-progress";
			summary.partialTurn = true;
		}
	}
	if (opts.items === "all" || opts.items === "tail") {
		const items = claudeItems(main);
		summary.items = opts.items === "tail" ? items.slice(-Math.max(0, opts.limit ?? 50)) : items;
	}
	return summary;
}

const CAPABILITIES: WorkerTranscriptCapabilities = { read: true, usage: "tokens-only", perModel: true, cost: false, items: true, resume: "native" };

export interface ClaudeTranscriptAdapterOptions {
	/** The projects root; defaults to claudeProjectsRoot() at each call (tests set CLAUDE_CONFIG_DIR). */
	root?: string;
}

export function createClaudeTranscriptAdapter(options: ClaudeTranscriptAdapterOptions = {}): WorkerTranscriptAdapter {
	const backend = "claude-code";
	const locate = (ref: WorkerTranscriptRef): WorkerTranscriptLocation => {
		checkRef(ref);
		if (ref.kind !== "claude-session-id") return { file: null, reason: `claude-code cannot read a "${ref.kind}" ref` };
		if (!CLAUDE_SESSION_ID_RE.test(ref.locator)) return { file: null, reason: "not a Claude session id" };
		const file = locateClaudeSession(ref.locator, { ...(ref.cwd ? { cwd: ref.cwd } : {}), ...(options.root ? { root: options.root } : {}) });
		return file ? { file } : { file: null, reason: "Claude session record not found" };
	};
	return {
		protocol: 1,
		backend,
		capabilities: () => ({ ...CAPABILITIES }),
		locate,
		async read(ref, opts = {}) {
			const where = locate(ref);
			if (!where.file) {
				return {
					ref, found: false, reason: where.reason ?? "not found", state: "unknown", compactions: 0, partialTurn: false,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, byModel: [], source: "none" },
				};
			}
			const file = where.file;
			let text: string;
			let info;
			try {
				[text, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
			} catch (error) {
				return {
					ref, found: false, reason: error instanceof Error ? error.message : String(error), state: "unknown", compactions: 0, partialTurn: false,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, byModel: [], source: "none" },
				};
			}
			const nested: unknown[] = [];
			for (const side of claudeSidechainFiles(file)) {
				try {
					nested.push(...parseJsonLines(await readFile(side, "utf8")));
				} catch {
					/* a vanished sidechain file: its spend is simply not counted */
				}
			}
			const summary = summarizeClaudeEntries(parseJsonLines(text), nested, ref, opts);
			return { ...summary, file, sizeBytes: info.size, mtimeMs: info.mtimeMs };
		},
	};
}
