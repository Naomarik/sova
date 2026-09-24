/**
 * Worker transcript adapter for the pi backend (any provider): the worker's own
 * pi session file.
 *
 * Usage is exact, with cost: every assistant message, tool result, compaction
 * and branch summary that carries a `usage`, plus pi's top-level `usage` entries
 * (cache_warm and friends), deduplicated by entry id and taken from the WHOLE
 * file — spend on a branch a rewind abandoned is still spend. A forked worker
 * (`--fork`, header `parentSession`) starts with a copy of its parent's
 * entries; only entries after its own `subagents-worker-session` marker count
 * (without a marker: entries stamped at or after the fork's header).
 *
 * Summary and items follow the active branch. Node builtins only.
 */
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
	addRow,
	checkRef,
	parseJsonLines,
	type TokenCounts,
	type WorkerTranscriptAdapter,
	type WorkerTranscriptCapabilities,
	type WorkerTranscriptItem,
	type WorkerTranscriptRef,
	type WorkerTranscriptSummary,
	type WorkerTurnOutcome,
	type WorkerUsage,
	type WorkerUsageRow,
} from "../worker-transcript.ts";

/** The child's own marker (worker-mark.ts). Duplicated as a string: worker-mark.ts imports the pi runtime's types. */
const WORKER_SESSION_ENTRY = "subagents-worker-session";
const RESULT_TEXT_MAX = 2000;

type Entry = Record<string, any>;

const amount = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
const epoch = (value: unknown): number | undefined => {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
};

export interface PiUsageOptions {
	/** Exclude entries a forked session copied from its parent. Default true (workers); Sova's main sessions pass false. */
	forkBoundary?: boolean;
}

/**
 * Incremental pi usage: feed parsed entries in file order, read the total any
 * time. Stateful so a caller tailing a file can add appended lines; `reset()`
 * when re-reading from the top.
 */
export interface PiUsageAccumulator {
	add(entries: readonly unknown[]): void;
	usage(): WorkerUsage;
	reset(): void;
}

export function piUsageAccumulator(options: PiUsageOptions = {}): PiUsageAccumulator {
	const boundary = options.forkBoundary !== false;
	let seen = new Set<string>();
	let rows = new Map<string, WorkerUsageRow>();
	let total: Required<Omit<TokenCounts, "cost">> & { cost: number } = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	/** Fork state: undefined until the header is seen; then whether copied entries are still being read. */
	let forkedAt: number | undefined;
	let inCopy = false;
	let model = "unknown";

	const count = (u: any, rowModel: string, turn: boolean): void => {
		if (!u || typeof u !== "object") return;
		const counts: TokenCounts = {
			input: amount(u.input), output: amount(u.output), cacheRead: amount(u.cacheRead), cacheWrite: amount(u.cacheWrite),
			cost: amount(u.cost?.total), turns: turn ? 1 : 0,
		};
		total.input += counts.input; total.output += counts.output; total.cacheRead += counts.cacheRead; total.cacheWrite += counts.cacheWrite;
		total.cost += counts.cost ?? 0; total.turns += counts.turns ?? 0;
		addRow(rows, rowModel, counts);
	};

	return {
		add(entries) {
			for (const raw of entries) {
				const e = raw as Entry;
				if (!e || typeof e !== "object") continue;
				if (e.type === "session") {
					if (boundary && typeof e.parentSession === "string" && e.parentSession) {
						forkedAt = epoch(e.timestamp);
						inCopy = true;
					}
					continue;
				}
				if (inCopy) {
					if (e.type === "custom" && e.customType === WORKER_SESSION_ENTRY) { inCopy = false; continue; }
					// No marker (yet): a copied entry keeps its original, older stamp.
					const at = epoch(e.timestamp);
					if (forkedAt === undefined || at === undefined || at < forkedAt) continue;
				}
				if (e.type === "model_change" && typeof e.modelId === "string") {
					model = typeof e.provider === "string" ? `${e.provider}/${e.modelId}` : e.modelId;
					continue;
				}
				let u: unknown;
				let rowModel = model;
				let turn = false;
				if (e.type === "usage") {
					u = e.usage;
					if (typeof e.model === "string") rowModel = typeof e.provider === "string" ? `${e.provider}/${e.model}` : e.model;
				} else if (e.type === "message" && e.message && typeof e.message === "object") {
					const m = e.message;
					if (m.role === "assistant") {
						u = m.usage;
						turn = true;
						if (typeof m.model === "string") rowModel = model = typeof m.provider === "string" ? `${m.provider}/${m.model}` : m.model;
					} else if (m.role === "toolResult") {
						u = m.usage; // a tool's own nested LLM work
					}
				} else if (e.type === "compaction" || e.type === "branch_summary") {
					u = e.usage;
				}
				if (!u) continue;
				if (typeof e.id === "string") {
					if (seen.has(e.id)) continue;
					seen.add(e.id);
				}
				count(u, rowModel, turn);
			}
		},
		usage() {
			const byModel = [...rows.values()].filter((r) => r.input + r.output + r.cacheRead + r.cacheWrite > 0 || (r.cost ?? 0) > 0).map((r) => ({ ...r }));
			return {
				...total,
				byModel,
				source: "transcript",
				policy: { cacheWarm: true, nestedAgents: true, forkBoundary: boundary && forkedAt !== undefined },
			};
		},
		reset() {
			seen = new Set();
			rows = new Map();
			total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
			forkedAt = undefined;
			inCopy = false;
			model = "unknown";
		},
	};
}

/** Usage of a whole pi session file's entries. */
export function piUsage(entries: readonly unknown[], options?: PiUsageOptions): WorkerUsage {
	const acc = piUsageAccumulator(options);
	acc.add(entries);
	return acc.usage();
}

/** Active branch: walk parentId from the last entry with an id. */
export function piActiveBranch(entries: readonly unknown[]): Entry[] {
	const byId = new Map<string, Entry>();
	let leaf: Entry | undefined;
	for (const raw of entries) {
		const e = raw as Entry;
		if (!e || typeof e !== "object" || typeof e.id !== "string" || e.type === "session") continue;
		byId.set(e.id, e);
		leaf = e;
	}
	const out: Entry[] = [];
	const guard = new Set<string>();
	for (let e = leaf; e && !guard.has(e.id); e = typeof e.parentId === "string" ? byId.get(e.parentId) : undefined) {
		guard.add(e.id);
		out.push(e);
	}
	return out.reverse();
}

/** Index of the first entry this worker wrote itself (after the fork boundary); 0 when not forked. */
function ownStart(branch: Entry[], header: Entry | undefined): number {
	if (typeof header?.parentSession !== "string" || !header.parentSession) return 0;
	const marker = branch.findIndex((e) => e.type === "custom" && e.customType === WORKER_SESSION_ENTRY);
	if (marker >= 0) return marker + 1;
	const forkedAt = epoch(header.timestamp);
	if (forkedAt === undefined) return 0;
	const first = branch.findIndex((e) => (epoch(e.timestamp) ?? 0) >= forkedAt);
	return first < 0 ? branch.length : first;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}

const clip = (s: string, max = RESULT_TEXT_MAX): string => (s.length > max ? `${s.slice(0, max)}…` : s);
const modelOf = (m: Entry): string | undefined => (typeof m.model === "string" ? (typeof m.provider === "string" ? `${m.provider}/${m.model}` : m.model) : undefined);

function outcomeOf(stopReason: unknown): WorkerTurnOutcome | undefined {
	if (stopReason === "error") return "error";
	if (stopReason === "aborted") return "aborted";
	if (stopReason === "stop" || stopReason === "length") return "success";
	return undefined;
}

/** Items of the worker's own part of the active branch. */
export function piItems(branch: readonly Entry[]): WorkerTranscriptItem[] {
	const out: WorkerTranscriptItem[] = [];
	for (const e of branch) {
		const at = epoch(e.timestamp);
		const stamp = at === undefined ? {} : { at };
		if (e.type === "compaction") { out.push({ kind: "system", text: "Compacted", ...stamp }); continue; }
		if (e.type !== "message" || !e.message) continue;
		const m = e.message;
		if (m.role === "user") {
			const text = textOf(m.content);
			if (text.trim()) out.push({ kind: "task", text, ...stamp });
		} else if (m.role === "assistant") {
			const model = modelOf(m);
			const tag = model ? { model } : {};
			for (const b of Array.isArray(m.content) ? m.content : []) {
				if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) out.push({ kind: "assistant", text: b.text, ...stamp, ...tag });
				else if (b?.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) out.push({ kind: "thinking", text: b.thinking, ...stamp, ...tag });
				else if (b?.type === "toolCall") out.push({ kind: "tool", text: clip(JSON.stringify(b.arguments ?? {})), toolName: String(b.name ?? "tool"), ...stamp, ...tag });
			}
			if (m.stopReason === "error" || m.errorMessage) out.push({ kind: "error", text: String(m.errorMessage ?? "assistant turn failed"), ...stamp, ...tag });
		} else if (m.role === "toolResult") {
			out.push({ kind: "tool-result", text: clip(textOf(m.content)), ...(typeof m.toolName === "string" ? { toolName: m.toolName } : {}), ...stamp });
		}
	}
	return out;
}

/** Everything but usage and file facts, from parsed entries. */
export function summarizePiEntries(entries: readonly unknown[], ref: WorkerTranscriptRef, opts: { items?: "none" | "tail" | "all"; limit?: number } = {}): WorkerTranscriptSummary {
	const all = entries as Entry[];
	const header = all.find((e) => e?.type === "session");
	const branch = piActiveBranch(all);
	const own = branch.slice(ownStart(branch, header));
	const summary: WorkerTranscriptSummary = {
		ref, found: true, state: "unknown", compactions: 0, partialTurn: false,
		usage: piUsage(all),
	};
	const started = epoch(header?.timestamp);
	if (started !== undefined) summary.startedAt = started;
	let last: number | undefined;
	for (const e of all) { const at = epoch(e?.timestamp); if (at !== undefined && (last === undefined || at > last)) last = at; }
	if (last !== undefined) summary.lastActivityAt = last;
	const mine = new Set(own);
	let lastMessage: Entry | undefined;
	for (const e of branch) {
		if (e.type === "compaction") summary.compactions++;
		else if (e.type === "model_change" && typeof e.modelId === "string") summary.model = typeof e.provider === "string" ? `${e.provider}/${e.modelId}` : e.modelId;
		else if (e.type === "thinking_level_change" && typeof e.thinkingLevel === "string") summary.effort = e.thinkingLevel;
		else if (e.type === "message" && e.message) {
			lastMessage = e.message;
			if (e.message.role === "assistant") {
				const model = modelOf(e.message);
				if (model) summary.model = model;
				const text = textOf(e.message.content).trim();
				if (text && mine.has(e)) summary.lastAssistantText = text;
			}
		}
	}
	if (lastMessage && own.some((e) => e.message === lastMessage)) {
		if (lastMessage.role === "assistant") {
			const outcome = outcomeOf(lastMessage.stopReason);
			if (outcome) { summary.state = "settled"; summary.lastOutcome = outcome; }
			else { summary.state = "in-progress"; summary.partialTurn = true; }
		} else if (lastMessage.role === "user" || lastMessage.role === "toolResult") {
			summary.state = "in-progress";
			summary.partialTurn = true;
		}
	}
	if (opts.items === "all" || opts.items === "tail") {
		const items = piItems(own);
		summary.items = opts.items === "tail" ? items.slice(-Math.max(0, opts.limit ?? 50)) : items;
	}
	return summary;
}

const CAPABILITIES: WorkerTranscriptCapabilities = { read: true, usage: "exact", perModel: true, cost: true, items: true, resume: "native" };

export function createPiTranscriptAdapter(): WorkerTranscriptAdapter {
	const backend = "pi";
	const locate = (ref: WorkerTranscriptRef) => {
		checkRef(ref);
		if (ref.kind !== "pi-session-file") return { file: null, reason: `pi cannot read a "${ref.kind}" ref` };
		if (!isAbsolute(ref.locator)) return { file: null, reason: "session file path is not absolute" };
		if (!existsSync(ref.locator)) return { file: null, reason: "session file not found" };
		return { file: ref.locator };
	};
	return {
		protocol: 1,
		backend,
		capabilities: () => ({ ...CAPABILITIES }),
		locate,
		async read(ref, opts = {}) {
			const where = locate(ref);
			const none = (reason: string): WorkerTranscriptSummary => ({
				ref, found: false, reason, state: "unknown", compactions: 0, partialTurn: false,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, byModel: [], source: "none" },
			});
			if (!where.file) return none(where.reason ?? "not found");
			let text: string;
			let info;
			try {
				[text, info] = await Promise.all([readFile(where.file, "utf8"), stat(where.file)]);
			} catch (error) {
				return none(error instanceof Error ? error.message : String(error));
			}
			const summary = summarizePiEntries(parseJsonLines(text), ref, opts);
			return { ...summary, file: where.file, sizeBytes: info.size, mtimeMs: info.mtimeMs };
		},
	};
}
