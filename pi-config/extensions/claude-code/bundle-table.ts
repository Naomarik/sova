/**
 * Claude Code's own model table, read out of its program file, and which of its rows Sova takes.
 * The file is minified code, so this is pattern work: a parse that doesn't hold together is "no
 * data", never "no models", and every caller keeps what it had. Pure: the text comes in as a string
 * (read as latin1), so tests and `pnpm run claude:catalog` share it with Sova's short child process.
 */

import { CLAUDE_1M_WINDOW, CLAUDE_DEFAULT_WINDOW, CLAUDE_MODELS, parseClaudeId, type ClaudeCatalogData, type ClaudeTableModel } from "./catalog.ts";

/** A row with no output cap in the table. */
const DEFAULT_MAX_OUTPUT = 64_000;
/** A row longer than this isn't a row: the closing brace was lost, or the shape changed. */
const MAX_ROW = 6000;

export interface ClaudeTableRow {
	id: string;
	family: string;
	/** The table's own display name. Only the dev script reads it, to check the name rule. */
	name: string;
	window: number;
	maxOutput: number;
	efforts: string[];
	firstParty?: string;
}

export interface ClaudeTable {
	rows: ClaudeTableRow[];
	/** `latest_per_family`, family to id; empty when the table has none Sova could read. */
	latest: Record<string, string>;
	cliVersion?: string;
}

export type ClaudeTableParse = { ok: true; table: ClaudeTable } | { ok: false; reason: string };

/** The JS number literal a minifier writes: `128000`, `1e6`, `1.5e5`. */
const NUMBER = "(\\d+(?:\\.\\d+)?(?:e\\d+)?)";
const WINDOW = new RegExp(`(?:^|,)window:${NUMBER}`);
const MAX_OUTPUT = new RegExp(`max_output_tokens:\\{default:${NUMBER}`);
const ROW_START = /\{id:"(claude-[a-z0-9-]+)",family:"([a-z]+)",display_name:"([^"]+)"/g;

/** The balanced `{…}` at `from`, strings respected; undefined when it doesn't close within MAX_ROW. */
function objectAt(text: string, from: number): string | undefined {
	let depth = 0;
	let quote: string | undefined;
	const end = Math.min(text.length, from + MAX_ROW);
	for (let i = from; i < end; i++) {
		const c = text[i]!;
		if (quote) {
			if (c === "\\") i++;
			else if (c === quote) quote = undefined;
		} else if (c === '"' || c === "'" || c === "`") quote = c;
		else if (c === "{" || c === "[") depth++;
		else if (c === "}" || c === "]") {
			if (--depth === 0) return text.slice(from, i + 1);
		}
	}
	return undefined;
}

const EFFORTS: readonly (readonly [string, readonly string[]])[] = [
	["effort", ["low", "medium", "high"]],
	["xhigh_effort", ["xhigh"]],
	["max_effort", ["max"]],
];

/** Whole quoted capabilities only: `per_turn_effort` and the like are not effort levels. */
function effortsOf(row: string): string[] {
	const list = /[,{]capabilities:\[([^\]]*)\]/.exec(row)?.[1];
	if (list === undefined) return [];
	const caps = new Set([...list.matchAll(/"([^"]*)"/g)].map((m) => m[1]!));
	return EFFORTS.flatMap(([cap, levels]) => (caps.has(cap) ? levels : []));
}

function rowOf(m: RegExpMatchArray, row: string): ClaudeTableRow | string {
	const id = m[1]!;
	const context = /[,{]context:\{([^{}]*)\}/.exec(row)?.[1];
	let window = CLAUDE_DEFAULT_WINDOW;
	if (context !== undefined) {
		const stated = WINDOW.exec(context);
		if (/(?:^|,)native_1m:!0/.test(context)) window = CLAUDE_1M_WINDOW;
		else if (stated) window = Number(stated[1]);
		else return `${id} has a context with no window`;
	}
	const cap = MAX_OUTPUT.exec(row);
	const maxOutput = cap ? Number(cap[1]) : DEFAULT_MAX_OUTPUT;
	if (!(window > 0) || !Number.isFinite(window)) return `${id} has an unusable window`;
	if (!(maxOutput > 0) || !Number.isFinite(maxOutput)) return `${id} has an unusable output cap`;
	const firstParty = /first_party:"([^"]+)"/.exec(row)?.[1];
	return { id, family: m[2]!, name: m[3]!, window, maxOutput, efforts: effortsOf(row), ...(firstParty ? { firstParty } : {}) };
}

/** The table in `text`, or why there is none to trust. Never throws. */
export function parseClaudeTable(text: string): ClaudeTableParse {
	const rows = new Map<string, ClaudeTableRow>();
	for (const m of text.matchAll(ROW_START)) {
		if (rows.has(m[1]!)) continue;
		const object = objectAt(text, m.index);
		if (object === undefined) return { ok: false, reason: `${m[1]} is not a complete row` };
		const row = rowOf(m, object);
		if (typeof row === "string") return { ok: false, reason: row };
		rows.set(row.id, row);
	}
	if (!rows.size) return { ok: false, reason: "no model rows found" };
	const body = /latest_per_family:\{([^{}]*)\}/.exec(text)?.[1] ?? "";
	const latest: Record<string, string> = {};
	for (const m of body.matchAll(/(\w+):"([^"]+)"/g)) {
		if (!rows.has(m[2]!)) return { ok: false, reason: `the latest ${m[1]} model, ${m[2]}, is not a row of the table` };
		latest[m[1]!] = m[2]!;
	}
	const cliVersion = /VERSION:"(\d+\.\d+\.\d+)"/.exec(text)?.[1];
	return { ok: true, table: { rows: [...rows.values()], latest, ...(cliVersion ? { cliVersion } : {}) } };
}

const versionOf = (id: string) => (parseClaudeId(id)?.version ?? "0").split(".").map(Number);
/** Above 0 when `a`'s version is newer. Both ids standard. */
function newer(a: string, b: string): number {
	const [x, y] = [versionOf(a), versionOf(b)];
	return (x[0]! - y[0]!) || ((x[1] ?? 0) - (y[1] ?? 0));
}

const rowModel = (row: ClaudeTableRow): ClaudeTableModel => ({
	id: row.id,
	window: row.window,
	maxOutput: row.maxOutput,
	efforts: row.efforts,
	apiIds: row.firstParty && row.firstParty !== row.id ? [row.firstParty] : [],
});

/** The newest id per family among `ids`. */
function newestPerFamily(ids: Iterable<string>): Map<string, string> {
	const out = new Map<string, string>();
	for (const id of ids) {
		const family = parseClaudeId(id)?.family;
		if (!family) continue;
		const best = out.get(family);
		if (!best || newer(id, best) > 0) out.set(family, id);
	}
	return out;
}

/**
 * What Sova takes from a table it trusts, over what it had. Comes in: a standard id newer than the
 * newest of the built-in list in a family the table names current; a family the built-in list lacks
 * contributes its latest only. Mythos and old rows stay out, so an id typed by hand is simply unknown.
 * With no `latest_per_family`, each known family's highest row is its latest and no family is added.
 * What Sova knows always stays known: a model a full table no longer has is listed as dropped.
 */
export function offerFromTable(table: ClaudeTable, prev?: ClaudeCatalogData | null): ClaudeCatalogData {
	const rows = new Map(table.rows.filter((r) => parseClaudeId(r.id)?.id === r.id).map((r) => [r.id, r]));
	const kept = new Map((prev?.models ?? []).map((m) => [m.id, m]));
	const known = new Set([...CLAUDE_MODELS.map((m) => m.id), ...kept.keys()].filter((id) => parseClaudeId(id)));
	const newestBuiltIn = newestPerFamily(CLAUDE_MODELS.map((m) => m.id));

	const named = new Map(Object.entries(table.latest).filter(([, id]) => rows.has(id)));
	if (!Object.keys(table.latest).length) {
		const highest = newestPerFamily(rows.keys());
		for (const family of newestBuiltIn.keys()) {
			const id = highest.get(family);
			if (id) named.set(family, id);
		}
	}

	const adopted = new Set<string>();
	for (const [family, latest] of named) {
		const floor = newestBuiltIn.get(family);
		if (!floor) {
			adopted.add(latest);
			continue;
		}
		for (const id of rows.keys()) {
			if (parseClaudeId(id)!.family === family && newer(id, floor) > 0) adopted.add(id);
		}
	}

	const all = new Set([...known, ...adopted]);
	const models = [...all]
		.flatMap((id) => {
			const row = rows.get(id);
			const held = kept.get(id);
			return row ? [rowModel(row)] : held ? [held] : [];
		})
		.sort((a, b) => (a.id < b.id ? -1 : 1));

	const dropped = [...all].filter((id) => !rows.has(id)).sort();

	return {
		models,
		...(dropped.length ? { dropped } : {}),
		...(prev?.tested?.length ? { tested: [...prev.tested] } : {}),
	};
}
