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
/**
 * More than this share of Sova's built-in ids must be rows for a table to count as whole. An older
 * Claude Code legitimately lacks a few of the newest; a read that found far fewer found a fragment.
 */
export const MIN_BUILT_IN_SHARE = 0.5;

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
const CAPABILITIES = /[,{]capabilities:\[/;
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

/**
 * Why `table` isn't a whole table, or undefined when it is: only a whole table may take a model away.
 * It names a latest for at least one family, each one a row, and lists most of the built-in ids.
 */
export function partialTableProblem(table: ClaudeTable): string | undefined {
	const listed = new Set(table.rows.map((r) => r.id));
	const latest = Object.entries(table.latest);
	if (!latest.length) return "the table has no latest_per_family";
	for (const [family, id] of latest) if (!listed.has(id)) return `the latest ${family} model, ${id}, is not a row of the table`;
	const covered = CLAUDE_MODELS.filter((m) => listed.has(m.id)).length;
	if (covered <= CLAUDE_MODELS.length * MIN_BUILT_IN_SHARE) return `only ${covered} of Sova's ${CLAUDE_MODELS.length} built-in models are rows of the table`;
	return undefined;
}

/** The table in `text`, or why there is none to trust. Never throws. */
export function parseClaudeTable(text: string): ClaudeTableParse {
	const rows = new Map<string, ClaudeTableRow>();
	let anyCapabilities = false;
	let anyOutputCap = false;
	for (const m of text.matchAll(ROW_START)) {
		if (rows.has(m[1]!)) continue;
		const object = objectAt(text, m.index);
		if (object === undefined) return { ok: false, reason: `${m[1]} is not a complete row` };
		const row = rowOf(m, object);
		if (typeof row === "string") return { ok: false, reason: row };
		rows.set(row.id, row);
		anyCapabilities ||= CAPABILITIES.test(object);
		anyOutputCap ||= MAX_OUTPUT.test(object);
	}
	if (!rows.size) return { ok: false, reason: "no model rows found" };
	// One row may lack either; a whole table lacking one means the field was renamed.
	if (!anyCapabilities) return { ok: false, reason: "no row has a capabilities list" };
	if (!anyOutputCap) return { ok: false, reason: "no row has an output cap" };
	const body = /latest_per_family:\{([^{}]*)\}/.exec(text)?.[1] ?? "";
	const latest: Record<string, string> = {};
	for (const m of body.matchAll(/(\w+):"([^"]+)"/g)) {
		// A dated or `[1m]` spelling of a row is that row.
		const id = rows.has(m[2]!) ? m[2]! : parseClaudeId(m[2]!)?.id;
		if (!id || !rows.has(id)) return { ok: false, reason: `the latest ${m[1]} model, ${m[2]}, is not a row of the table` };
		latest[m[1]!] = id;
	}
	const cliVersion = /VERSION:"(\d+\.\d+\.\d+)"/.exec(text)?.[1];
	const table: ClaudeTable = { rows: [...rows.values()], latest, ...(cliVersion ? { cliVersion } : {}) };
	const partial = partialTableProblem(table);
	return partial ? { ok: false, reason: partial } : { ok: true, table };
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
 * newest of the built-in list and no newer than the table's own latest for its family (a row past
 * that may be unreleased); a family the built-in list lacks contributes its latest only. Only a
 * family `latest_per_family` names counts, and only under a standard id of that same family: an
 * old-order value names nothing. Mythos and old rows stay out, so an id typed by hand is unknown.
 * What Sova knows always stays known: a model a whole table no longer has is listed as dropped. A
 * table that isn't whole changes nothing, whoever hands it in.
 */
export function offerFromTable(table: ClaudeTable, prev?: ClaudeCatalogData | null): ClaudeCatalogData {
	if (partialTableProblem(table)) return { models: [...(prev?.models ?? [])], ...(prev?.dropped ? { dropped: [...prev.dropped] } : {}), ...(prev?.tested ? { tested: [...prev.tested] } : {}) };
	const rows = new Map(table.rows.filter((r) => parseClaudeId(r.id)?.id === r.id).map((r) => [r.id, r]));
	const kept = new Map((prev?.models ?? []).map((m) => [m.id, m]));
	const known = new Set([...CLAUDE_MODELS.map((m) => m.id), ...kept.keys()].filter((id) => parseClaudeId(id)));
	const newestBuiltIn = newestPerFamily(CLAUDE_MODELS.map((m) => m.id));

	const named = Object.entries(table.latest).filter(([family, id]) => rows.has(id) && parseClaudeId(id)!.family === family);

	const adopted = new Set<string>();
	for (const [family, latest] of named) {
		const floor = newestBuiltIn.get(family);
		if (!floor) {
			adopted.add(latest);
			continue;
		}
		for (const id of rows.keys()) {
			if (parseClaudeId(id)!.family === family && newer(id, floor) > 0 && newer(id, latest) <= 0) adopted.add(id);
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
