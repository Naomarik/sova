/**
 * Sova's own Claude model catalog: one entry per real model, with no aliases and no `[1m]` forms
 * (§app.claude-code-provider/catalog), and the frozen table that reads the ids older files hold
 * (§app.claude-code-provider/legacy-ids).
 *
 * Imported by this extension (the chat picker's models, `agent_models`, every `--model`), by the
 * subagents and mode extensions, by Sova's server (Settings lists, worker gauges, Usage rows, session
 * open) and by the web app (model names). Imports nothing: no pi runtime, no node builtins.
 *
 * Seeded from the CLI's own model table (claude 2.1.295: `id`, `display_name`, `context.window`,
 * `native_1m`, `max_output_tokens.default`, `provider_ids.first_party`, `latest_per_family`) and its
 * initialize list's effort levels. `pnpm run claude:catalog` prints how an installed CLI differs.
 * Checked with one-word turns on 2.1.289 (2026-10-07): `--model claude-haiku-4-5` answers as
 * claude-haiku-4-5-20251001 with result contextWindow 200,000 and maxOutputTokens 32,000;
 * `--model claude-sonnet-5-5` reports 1,000,000 and 128,000. On 2.1.295 (2026-10-09),
 * `--model claude-haiku-5-5` answers as claude-haiku-5-5 with 1,000,000 and 128,000.
 * This table is the starting point and what a machine without Claude Code gets; what Claude Code's
 * own table adds arrives through `mergeClaudeCatalog`, and every lookup below reads the merged view.
 */

export const CLAUDE_1M_WINDOW = 1_000_000;
export const CLAUDE_DEFAULT_WINDOW = 200_000;

/** The families code names by literal. */
export type KnownClaudeFamily = "opus" | "sonnet" | "fable" | "haiku";
/** Any family a standard id can carry; a brand-new one needs no edit here. */
export type ClaudeFamily = KnownClaudeFamily | (string & {});

export interface ClaudeModel {
	/** The CLI's catalog id, and what `--model` is given. */
	readonly id: string;
	/** Other ids the API answers with for this model (`responseModel`). */
	readonly apiIds: readonly string[];
	readonly family: ClaudeFamily;
	readonly version: string;
	/** The name rule's output (`parseClaudeId`): "Opus 5.5". */
	readonly name: string;
	/** Tokens: 1M where the CLI's table says native_1m, else 200k. */
	readonly window: number;
	/** The CLI's default output cap. */
	readonly maxOutput: number;
	/** `--effort` levels the model takes; none = no effort control. */
	readonly efforts: readonly string[];
	/** `current`: what built-in defaults use for its family (`latestClaude`), which a newer untested model doesn't take. `previous`: anything else. */
	readonly status: "current" | "previous";
	/** When it became its family's current model, where known (the legacy table's switch). */
	readonly released?: string;
	/** models.dev's `provider/model`. */
	readonly priceKey: string;
}

const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const NO_XHIGH = ["low", "medium", "high", "max"] as const;

const model = (m: Omit<ClaudeModel, "apiIds" | "priceKey"> & { apiIds?: readonly string[] }): ClaudeModel =>
	Object.freeze({ ...m, apiIds: Object.freeze([...(m.apiIds ?? [])]), efforts: Object.freeze([...m.efforts]), priceKey: `anthropic/${m.id}` });

/** The seed, in offer order: each family's newest first, then the rest, each family newest first. Lists read `claudeOffer()`. */
export const CLAUDE_MODELS: readonly ClaudeModel[] = Object.freeze([
	model({ id: "claude-opus-5-5", family: "opus", version: "5.5", name: "Opus 5.5", window: CLAUDE_1M_WINDOW, maxOutput: 128_000, efforts: ALL_EFFORTS, status: "current", released: "2026-09-21T18:00:00Z" }),
	model({ id: "claude-sonnet-5-5", family: "sonnet", version: "5.5", name: "Sonnet 5.5", window: CLAUDE_1M_WINDOW, maxOutput: 128_000, efforts: ALL_EFFORTS, status: "current", released: "2026-10-01T18:00:00Z" }),
	model({ id: "claude-fable-5-1", family: "fable", version: "5.1", name: "Fable 5.1", window: CLAUDE_1M_WINDOW, maxOutput: 64_000, efforts: ALL_EFFORTS, status: "current" }),
	model({ id: "claude-haiku-5-5", family: "haiku", version: "5.5", name: "Haiku 5.5", window: CLAUDE_1M_WINDOW, maxOutput: 128_000, efforts: ALL_EFFORTS, status: "current", released: "2026-10-07T00:00:00Z" }),
	model({ id: "claude-opus-5", family: "opus", version: "5", name: "Opus 5", window: CLAUDE_1M_WINDOW, maxOutput: 64_000, efforts: ALL_EFFORTS, status: "previous" }),
	model({ id: "claude-opus-4-8", family: "opus", version: "4.8", name: "Opus 4.8", window: CLAUDE_1M_WINDOW, maxOutput: 64_000, efforts: ALL_EFFORTS, status: "previous" }),
	model({ id: "claude-opus-4-7", family: "opus", version: "4.7", name: "Opus 4.7", window: CLAUDE_1M_WINDOW, maxOutput: 64_000, efforts: ALL_EFFORTS, status: "previous" }),
	model({ id: "claude-opus-4-6", family: "opus", version: "4.6", name: "Opus 4.6", window: CLAUDE_DEFAULT_WINDOW, maxOutput: 64_000, efforts: NO_XHIGH, status: "previous" }),
	model({ id: "claude-sonnet-5", family: "sonnet", version: "5", name: "Sonnet 5", window: CLAUDE_1M_WINDOW, maxOutput: 64_000, efforts: ALL_EFFORTS, status: "previous" }),
	model({ id: "claude-sonnet-4-6", family: "sonnet", version: "4.6", name: "Sonnet 4.6", window: CLAUDE_DEFAULT_WINDOW, maxOutput: 32_000, efforts: NO_XHIGH, status: "previous" }),
	model({ id: "claude-fable-5", family: "fable", version: "5", name: "Fable 5", window: CLAUDE_1M_WINDOW, maxOutput: 64_000, efforts: ALL_EFFORTS, status: "previous" }),
	model({ id: "claude-haiku-4-5", apiIds: ["claude-haiku-4-5-20251001"], family: "haiku", version: "4.5", name: "Haiku 4.5", window: CLAUDE_DEFAULT_WINDOW, maxOutput: 32_000, efforts: [], status: "previous" }),
]);

const norm = (id: string) => id.trim().toLowerCase();

/** The provider prefixes a Claude model ref may carry. */
const CLAUDE_PROVIDERS = ["claude-code-cli/", "claude-code/", "claude/", "anthropic/"];
/** `claude-code-cli/opus[1m]` → `opus[1m]`; an id without one of those prefixes is returned as it is. */
export function claudeBareId(ref: string): string {
	const r = ref.trim();
	for (const p of CLAUDE_PROVIDERS) if (r.toLowerCase().startsWith(p)) return r.slice(p.length);
	return r;
}
const strip1m = (id: string) => id.replace(/\[1m\]$/i, "");

/** What the name rule reads from a standard id. */
export interface ClaudeIdParts {
	/** The id with its provider prefix, `[1m]` and trailing 8-digit date dropped. */
	readonly id: string;
	readonly family: ClaudeFamily;
	readonly version: string;
	readonly name: string;
}

const STANDARD_ID = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?$/;
/**
 * The name rule: `claude-<family>-<major>[-<minor>]` reads as "Family major.minor", a minor of 0
 * dropped. A function of the id alone, so a name can't change between asks. Old-order ids
 * (`claude-3-5-sonnet`) aren't standard and stay unnamed.
 */
export function parseClaudeId(id: string | null | undefined): ClaudeIdParts | undefined {
	if (!id) return undefined;
	const standard = norm(strip1m(claudeBareId(id))).replace(/-\d{8}$/, "");
	const m = STANDARD_ID.exec(standard);
	if (!m) return undefined;
	const family = m[1]!;
	const minor = Number(m[3] ?? 0);
	const version = minor ? `${Number(m[2])}.${minor}` : `${Number(m[2])}`;
	return { id: standard, family, version, name: `${family[0]!.toUpperCase()}${family.slice(1)} ${version}` };
}

/** One row of Claude Code's table. Identity is never here: the name rule reads it from the id. */
export interface ClaudeTableModel {
	readonly id: string;
	readonly window?: number;
	readonly maxOutput?: number;
	readonly efforts?: readonly string[];
	readonly apiIds?: readonly string[];
}

/** What is known beyond the seed. Plain JSON: remembered on disk and carried to the web app as it is. */
export interface ClaudeCatalogData {
	/** Every model ever adopted, dropped ones included. A seed id here takes the row's fields. */
	readonly models: readonly ClaudeTableModel[];
	/** Ids (seed or adopted) a full table read no longer has: out of the lists, resolved as before. */
	readonly dropped?: readonly string[];
	/** Ids with a recorded one-word pass: the only learned models built-in defaults may follow. */
	readonly tested?: readonly string[];
}

interface SharedCatalog { data: ClaudeCatalogData; json: string; generation: number }
/**
 * On globalThis, not in this module: pi loads each extension with its own copy of this file, and one
 * merge has to reach them all. Each copy derives its view from this with its own seed.
 */
const SHARED_KEY = Symbol.for("sova.claude-catalog");
function sharedCatalog(): SharedCatalog {
	const slots = globalThis as unknown as Record<symbol, SharedCatalog | undefined>;
	return (slots[SHARED_KEY] ??= { data: { models: [] }, json: JSON.stringify({ models: [] }), generation: 0 });
}

const stringsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
/** Only what a lookup can use: this reads a file, and no lookup may throw over a damaged one. */
function cleanData(data: ClaudeCatalogData): ClaudeCatalogData {
	const models = (Array.isArray(data?.models) ? data.models : []).filter((m) => typeof m?.id === "string");
	const dropped = stringsOf(data?.dropped);
	const tested = stringsOf(data?.tested);
	return { models, ...(dropped.length ? { dropped } : {}), ...(tested.length ? { tested } : {}) };
}

/**
 * Sets what is known beyond the seed, replacing the last call's data: pass all of it. Every lookup in
 * every copy of this module reads it from the next call on. True when it differs from the last.
 */
export function mergeClaudeCatalog(data: ClaudeCatalogData): boolean {
	const shared = sharedCatalog();
	const clean = cleanData(data);
	const json = JSON.stringify(clean);
	if (json === shared.json) return false;
	shared.data = clean;
	shared.json = json;
	shared.generation++;
	return true;
}

/** Bumps with each merge that changed anything: a key for what is cached from this catalog. */
export function claudeCatalogGeneration(): number {
	return sharedCatalog().generation;
}

/** Above 0 when version `a` is the newer: "5.10" is newer than "5.2". */
export function compareClaudeVersions(a: string, b: string): number {
	const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
	return (x[0]! - y[0]!) || ((x[1] ?? 0) - (y[1] ?? 0));
}
const compareVersions = (a: ClaudeModel, b: ClaudeModel) => compareClaudeVersions(a.version, b.version);
const positive = (n: unknown, otherwise: number) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : otherwise);

/** A model the table lists: its fields are the table's, a seed entry's included; identity is the rule's. */
function adopted(row: ClaudeTableModel, parts: ClaudeIdParts, seed: ClaudeModel | undefined): ClaudeModel {
	return model({
		...seed,
		id: parts.id,
		family: parts.family,
		version: parts.version,
		name: parts.name,
		window: positive(row.window, CLAUDE_DEFAULT_WINDOW),
		maxOutput: positive(row.maxOutput, 64_000),
		efforts: stringsOf(row.efforts),
		status: "previous",
		apiIds: Array.isArray(row.apiIds) ? stringsOf(row.apiIds).map(norm).filter((a) => a !== parts.id) : seed?.apiIds ?? [],
	});
}

interface CatalogView {
	readonly generation: number;
	readonly byId: ReadonlyMap<string, ClaudeModel>;
	readonly byAnswer: ReadonlyMap<string, ClaudeModel>;
	readonly offer: readonly ClaudeModel[];
	/** The offer, then the dropped models. */
	readonly registered: readonly ClaudeModel[];
	/** What built-in defaults follow, by family. */
	readonly defaults: ReadonlyMap<string, ClaudeModel>;
}

function seedCurrent(family: string): ClaudeModel | undefined {
	return CLAUDE_MODELS.find((m) => m.family === family && m.status === "current");
}

function buildView(data: ClaudeCatalogData, generation: number): CatalogView {
	const known = new Map(CLAUDE_MODELS.map((m) => [m.id, m]));
	for (const row of data.models) {
		const parts = parseClaudeId(row.id);
		if (parts) known.set(parts.id, adopted(row, parts, known.get(parts.id)));
	}
	const idOf = (id: string) => parseClaudeId(id)?.id ?? norm(id);
	const dropped = new Set((data.dropped ?? []).map(idOf));
	const tested = new Set((data.tested ?? []).map(idOf));

	const builtIn = new Set(CLAUDE_MODELS.map((m) => m.id));
	const offeredByFamily = new Map<string, ClaudeModel[]>();
	for (const m of known.values()) if (!dropped.has(m.id)) offeredByFamily.set(m.family, [...(offeredByFamily.get(m.family) ?? []), m]);
	const newestIds = new Set<string>();
	const defaults = new Map<string, ClaudeModel>();
	for (const [family, models] of offeredByFamily) {
		models.sort((a, b) => compareVersions(b, a));
		newestIds.add(models[0]!.id);
		const current = models.find((m) => builtIn.has(m.id) || tested.has(m.id));
		if (current) defaults.set(family, current);
	}

	const withStatus = (m: ClaudeModel): ClaudeModel => {
		const status = defaults.get(m.family)?.id === m.id ? "current" : "previous";
		return m.status === status ? m : Object.freeze({ ...m, status });
	};
	const byId = new Map([...known.values()].map((m) => [m.id, withStatus(m)]));
	const byAnswer = new Map<string, ClaudeModel>();
	for (const m of byId.values()) for (const a of m.apiIds) byAnswer.set(a, m);
	for (const m of byId.values()) byAnswer.set(m.id, m);
	for (const [family, m] of defaults) defaults.set(family, byId.get(m.id)!);

	const seedFamilies = [...new Set(CLAUDE_MODELS.map((m) => m.family as string))];
	const familyRank = (f: string) => (seedFamilies.includes(f) ? seedFamilies.indexOf(f) : seedFamilies.length);
	const offer = [...byId.values()].filter((m) => !dropped.has(m.id)).sort((a, b) =>
		(Number(newestIds.has(b.id)) - Number(newestIds.has(a.id))) ||
		(familyRank(a.family) - familyRank(b.family)) ||
		(a.family < b.family ? -1 : a.family > b.family ? 1 : 0) ||
		compareVersions(b, a));
	const registered = [...offer, ...[...byId.values()].filter((m) => dropped.has(m.id))];
	return { generation, byId, byAnswer, offer: Object.freeze(offer), registered: Object.freeze(registered), defaults };
}

let view: CatalogView | undefined;
function catalog(): CatalogView {
	const shared = sharedCatalog();
	if (view?.generation !== shared.generation) view = buildView(shared.data, shared.generation);
	return view;
}

/** The catalog entry with exactly this id. */
export function claudeModel(id: string | null | undefined): ClaudeModel | undefined {
	return id ? catalog().byId.get(norm(id)) : undefined;
}
/** The catalog model an API answer (`responseModel`) names: its id, one of its apiIds, or either with a date on the end; `[1m]` dropped. */
export function claudeByAnswer(answer: string | null | undefined): ClaudeModel | undefined {
	if (!answer) return undefined;
	const { byAnswer } = catalog();
	const bare = norm(strip1m(claudeBareId(answer)));
	return byAnswer.get(bare) ?? byAnswer.get(bare.replace(/-\d{8}$/, ""));
}
/** What every list offers: each family's newest first, then the rest, each family newest first; never a dropped model. */
export function claudeOffer(): readonly ClaudeModel[] {
	return catalog().offer;
}
/**
 * The family's current entry, what built-in defaults use: its newest offered model that is built in or
 * has a recorded one-word pass, however new the untested ones are. Every model dropped: the seed's.
 */
export function latestClaude(family: KnownClaudeFamily): ClaudeModel;
export function latestClaude(family: ClaudeFamily): ClaudeModel | undefined;
export function latestClaude(family: ClaudeFamily): ClaudeModel | undefined {
	return catalog().defaults.get(family) ?? claudeModel(seedCurrent(family)?.id);
}

/** Every model an id can resolve to: the offer, then what the table dropped (an old chat still opens on one). */
export function claudeRegistered(): readonly ClaudeModel[] {
	return catalog().registered;
}

/** A Claude Code `--model` value's shape: no `/`, no leading `-`, no whitespace or NUL. */
export function isClaudeIdShape(id: string): boolean {
	return !!id.trim() && !id.startsWith("-") && !/[\s/\0]/.test(id);
}

interface LegacyTarget { readonly until?: string; readonly id: string }
const OPUS: readonly LegacyTarget[] = [{ until: "2026-09-21T18:00:00Z", id: "claude-opus-5" }, { id: "claude-opus-5-5" }];
const SONNET: readonly LegacyTarget[] = [{ until: "2026-10-01T18:00:00Z", id: "claude-sonnet-5" }, { id: "claude-sonnet-5-5" }];
const HAIKU: readonly LegacyTarget[] = [{ id: "claude-haiku-4-5" }];
const FABLE: readonly LegacyTarget[] = [{ id: "claude-fable-5-1" }];
/**
 * Frozen: the CLI aliases files written before the catalog hold, and the catalog models they meant
 * (the alias moved with the CLI's version, so a recorded answer decides; the date is for a record
 * with none). Never listed, offered, written or passed to `--model`.
 */
export const LEGACY_CLAUDE_IDS: Readonly<Record<string, readonly LegacyTarget[]>> = Object.freeze({
	opus: OPUS, "opus[1m]": OPUS, default: OPUS,
	sonnet: SONNET, "sonnet[1m]": SONNET,
	haiku: HAIKU, "haiku[1m]": HAIKU,
	fable: FABLE, "fable[1m]": FABLE,
});

/** An id only the legacy table knows: a CLI alias, or a catalog id with `[1m]`. */
export function isLegacyClaudeId(id: string | null | undefined): boolean {
	if (!id) return false;
	const bare = norm(claudeBareId(id));
	return bare in LEGACY_CLAUDE_IDS || (bare.endsWith("[1m]") && !!claudeByAnswer(bare));
}

/**
 * The catalog model an old id meant (§app.claude-code-provider/legacy-ids). `answered`: the model the
 * record says answered, which decides when it is one of the alias's models; `at`: the record's time,
 * else today's target. A catalog id with `[1m]` (or an apiId) is that model.
 */
export function resolveLegacyClaude(id: string, o: { at?: number | string; answered?: string | null } = {}): ClaudeModel | undefined {
	const bare = norm(claudeBareId(id));
	const targets = LEGACY_CLAUDE_IDS[bare];
	if (!targets) return bare.endsWith("[1m]") ? claudeByAnswer(bare) : undefined;
	const answered = claudeByAnswer(o.answered);
	if (answered && targets.some((t) => t.id === answered.id)) return answered;
	const at = o.at === undefined ? undefined : typeof o.at === "number" ? o.at : Date.parse(o.at);
	const pick = at === undefined || !Number.isFinite(at) ? targets[targets.length - 1]! : targets.find((t) => !t.until || at < Date.parse(t.until)) ?? targets[targets.length - 1]!;
	return claudeModel(pick.id);
}

/** Any Claude id or ref (catalog id, apiId, `[1m]` form, old alias) → its catalog model. */
export function resolveClaude(id: string | null | undefined, o: { at?: number | string; answered?: string | null } = {}): ClaudeModel | undefined {
	if (!id) return undefined;
	return claudeByAnswer(id) ?? resolveLegacyClaude(id, o);
}

/**
 * The id to store or pass for a Claude choice: an old id becomes today's catalog id, a catalog id or
 * apiId the catalog id, and an id the catalog doesn't know stays as given. Keeps a provider prefix.
 */
export function canonicalClaudeId(id: string): string {
	const bare = claudeBareId(id);
	const m = resolveClaude(bare);
	if (!m) return id;
	return id.slice(0, id.length - bare.length) + m.id;
}
/** `--model` for a Claude spawn (§app.claude-code-provider/pinned-model). */
export const claudeCliId = canonicalClaudeId;

/** A Claude id's name ("Opus 5.5"): the name rule's for a standard id, so no list can change it; else the model an old alias meant. */
export function claudeName(id: string | null | undefined, o: { at?: number | string; answered?: string | null } = {}): string | undefined {
	return parseClaudeId(id)?.name ?? resolveClaude(id, o)?.name;
}

/**
 * The context window of a Claude Code model id (`resolvedModel`: what the CLI said an alias resolves
 * to). The catalog's window. An old `[1m]` id ran at 1M whatever its model (the CLI's 1M beta), and an
 * id the catalog doesn't know is 200k without one.
 */
export function claudeContextWindow(id: string, resolvedModel?: string): number {
	if (id.trim().endsWith("[1m]")) return CLAUDE_1M_WINDOW;
	const m = claudeByAnswer(resolvedModel) ?? resolveClaude(id);
	return m ? m.window : CLAUDE_DEFAULT_WINDOW;
}

/** The note for an id the catalog doesn't know (§app.claude-code-provider/catalog). */
export function unverifiedClaudeNote(id: string): string | undefined {
	return resolveClaude(id) ? undefined : `Not verified: ${id} is not in Sova's Claude catalog. It will still be used.`;
}

/** What the CLI's initialize list says that the catalog doesn't (§app.claude-code-provider/catalog-drift). */
export interface ClaudeDrift {
	/** Listed models the catalog doesn't know. */
	unknown: { id: string; name?: string }[];
	/** A family alias the CLI resolves to another model than the catalog's current one. */
	moved: { family: ClaudeFamily; id: string; current: string }[];
}
export function claudeDrift(listed: readonly { id: string; name?: string; resolvedModel?: string }[]): ClaudeDrift {
	const unknown: ClaudeDrift["unknown"] = [];
	const moved: ClaudeDrift["moved"] = [];
	const seen = new Set<string>();
	for (const l of listed) {
		const id = norm(l.id);
		const resolved = l.resolvedModel ? norm(strip1m(l.resolvedModel)) : undefined;
		if (id === "default") continue;
		const family = (["opus", "sonnet", "fable", "haiku"] as const).find((f) => id === f || id === `${f}[1m]`);
		if (family) {
			const current = latestClaude(family);
			if (resolved && claudeByAnswer(resolved)?.id !== current.id && !seen.has(`m:${family}`)) {
				seen.add(`m:${family}`);
				moved.push({ family, id: resolved, current: current.id });
			}
			continue;
		}
		const target = resolved ?? strip1m(id);
		if (claudeByAnswer(target) || seen.has(target)) continue;
		seen.add(target);
		unknown.push({ id: target, ...(l.name ? { name: l.name } : {}) });
	}
	return { unknown, moved };
}
