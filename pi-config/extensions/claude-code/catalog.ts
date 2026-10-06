/**
 * Sova's own Claude model catalog: one entry per real model, with no aliases and no `[1m]` forms
 * (§app.claude-code-provider/catalog), and the frozen table that reads the ids older files hold
 * (§app.claude-code-provider/legacy-ids).
 *
 * Imported by this extension (the chat picker's models, `agent_models`, every `--model`), by the
 * subagents and mode extensions, by Sova's server (Settings lists, worker gauges, Usage rows, session
 * open) and by the web app (model names). Imports nothing: no pi runtime, no node builtins.
 *
 * Seeded from the CLI's own model table (claude 2.1.289: `id`, `display_name`, `context.window`,
 * `native_1m`, `max_output_tokens.default`, `provider_ids.first_party`, `latest_per_family`) and its
 * initialize list's effort levels. `pnpm run claude:catalog` prints how an installed CLI differs.
 * Checked with one-word turns on 2.1.289 (2026-10-07): `--model claude-haiku-4-5` answers as
 * claude-haiku-4-5-20251001 with result contextWindow 200,000 and maxOutputTokens 32,000;
 * `--model claude-sonnet-5-5` reports 1,000,000 and 128,000.
 * The CLI's list never changes this table at runtime: adopting a model is an edit here.
 */

export const CLAUDE_1M_WINDOW = 1_000_000;
export const CLAUDE_DEFAULT_WINDOW = 200_000;

export type ClaudeFamily = "opus" | "sonnet" | "fable" | "haiku";

export interface ClaudeModel {
	/** The CLI's catalog id, and what `--model` is given. */
	readonly id: string;
	/** Other ids the API answers with for this model (`responseModel`). */
	readonly apiIds: readonly string[];
	readonly family: ClaudeFamily;
	readonly version: string;
	/** The CLI's display name: "Opus 5.5". */
	readonly name: string;
	/** Tokens: 1M where the CLI's table says native_1m, else 200k. */
	readonly window: number;
	/** The CLI's default output cap. */
	readonly maxOutput: number;
	/** `--effort` levels the model takes; none = no effort control. */
	readonly efforts: readonly string[];
	/** `current`: its family's latest (latest_per_family). `previous`: still offered. */
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

/** Current entries first, each family newest first: the order every list offers them in. */
export const CLAUDE_MODELS: readonly ClaudeModel[] = Object.freeze([
	model({ id: "claude-opus-5-5", family: "opus", version: "5.5", name: "Opus 5.5", window: CLAUDE_1M_WINDOW, maxOutput: 128_000, efforts: ALL_EFFORTS, status: "current", released: "2026-09-21T18:00:00Z" }),
	model({ id: "claude-sonnet-5-5", family: "sonnet", version: "5.5", name: "Sonnet 5.5", window: CLAUDE_1M_WINDOW, maxOutput: 128_000, efforts: ALL_EFFORTS, status: "current", released: "2026-10-01T18:00:00Z" }),
	model({ id: "claude-fable-5-1", family: "fable", version: "5.1", name: "Fable 5.1", window: CLAUDE_1M_WINDOW, maxOutput: 64_000, efforts: ALL_EFFORTS, status: "current" }),
	model({ id: "claude-haiku-4-5", apiIds: ["claude-haiku-4-5-20251001"], family: "haiku", version: "4.5", name: "Haiku 4.5", window: CLAUDE_DEFAULT_WINDOW, maxOutput: 32_000, efforts: [], status: "current" }),
	model({ id: "claude-opus-5", family: "opus", version: "5", name: "Opus 5", window: CLAUDE_1M_WINDOW, maxOutput: 64_000, efforts: ALL_EFFORTS, status: "previous" }),
	model({ id: "claude-opus-4-8", family: "opus", version: "4.8", name: "Opus 4.8", window: CLAUDE_1M_WINDOW, maxOutput: 64_000, efforts: ALL_EFFORTS, status: "previous" }),
	model({ id: "claude-opus-4-7", family: "opus", version: "4.7", name: "Opus 4.7", window: CLAUDE_1M_WINDOW, maxOutput: 64_000, efforts: ALL_EFFORTS, status: "previous" }),
	model({ id: "claude-opus-4-6", family: "opus", version: "4.6", name: "Opus 4.6", window: CLAUDE_DEFAULT_WINDOW, maxOutput: 64_000, efforts: NO_XHIGH, status: "previous" }),
	model({ id: "claude-sonnet-5", family: "sonnet", version: "5", name: "Sonnet 5", window: CLAUDE_1M_WINDOW, maxOutput: 64_000, efforts: ALL_EFFORTS, status: "previous" }),
	model({ id: "claude-sonnet-4-6", family: "sonnet", version: "4.6", name: "Sonnet 4.6", window: CLAUDE_DEFAULT_WINDOW, maxOutput: 32_000, efforts: NO_XHIGH, status: "previous" }),
	model({ id: "claude-fable-5", family: "fable", version: "5", name: "Fable 5", window: CLAUDE_1M_WINDOW, maxOutput: 64_000, efforts: ALL_EFFORTS, status: "previous" }),
]);

const norm = (id: string) => id.trim().toLowerCase();
const BY_ID = new Map(CLAUDE_MODELS.map((m) => [m.id, m]));
const BY_ANSWER = new Map(CLAUDE_MODELS.flatMap((m) => [[m.id, m] as const, ...m.apiIds.map((a) => [a, m] as const)]));

/** The provider prefixes a Claude model ref may carry. */
const CLAUDE_PROVIDERS = ["claude-code-cli/", "claude-code/", "claude/", "anthropic/"];
/** `claude-code-cli/opus[1m]` → `opus[1m]`; an id without one of those prefixes is returned as it is. */
export function claudeBareId(ref: string): string {
	const r = ref.trim();
	for (const p of CLAUDE_PROVIDERS) if (r.toLowerCase().startsWith(p)) return r.slice(p.length);
	return r;
}
const strip1m = (id: string) => id.replace(/\[1m\]$/i, "");

/** The catalog entry with exactly this id. */
export function claudeModel(id: string | null | undefined): ClaudeModel | undefined {
	return id ? BY_ID.get(norm(id)) : undefined;
}
/** The catalog model an API answer (`responseModel`) names: its id or one of its apiIds, `[1m]` dropped. */
export function claudeByAnswer(answer: string | null | undefined): ClaudeModel | undefined {
	return answer ? BY_ANSWER.get(norm(strip1m(claudeBareId(answer)))) : undefined;
}
/** What every list offers: the catalog, current entries first. */
export function claudeOffer(): readonly ClaudeModel[] {
	return CLAUDE_MODELS;
}
/** The family's current model. */
export function latestClaude(family: ClaudeFamily): ClaudeModel {
	return CLAUDE_MODELS.find((m) => m.family === family && m.status === "current")!;
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

/** A Claude id's name ("Opus 5.5"), or undefined for one the catalog and the legacy table don't know. */
export function claudeName(id: string | null | undefined, o: { at?: number | string; answered?: string | null } = {}): string | undefined {
	return resolveClaude(id, o)?.name;
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
