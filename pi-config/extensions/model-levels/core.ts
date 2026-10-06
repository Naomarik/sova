/**
 * Thinking levels for models pi has no catalog for (README.md). Node builtins only: the extension
 * (index.ts) and Sova's pi adapter both import this file, so it never reaches the pi runtime.
 *
 * - Mapping: Ollama's `/api/show` thinking values (or models.dev's reasoning options) become pi's
 *   `reasoning`, `thinkingLevelMap` and `compat.supportsReasoningEffort`.
 * - Cache: what the sources answered, in `<agent dir>/model-levels.json`, fetched again in the
 *   background when a provider's copy is over a day old.
 * - Overlay: a covered provider's models as pi composed them (provider compat included), with only
 *   those three fields filled in, retired models left out, and the user's own fields kept.
 */
import fs from "node:fs";
import path from "node:path";

export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Level = (typeof LEVELS)[number];
export type LevelMap = Partial<Record<Level, string | null>>;

/** What one model's metadata says, in pi's words. Absent fields are left as pi has them. */
export interface ModelLevels {
	reasoning: boolean;
	thinkingLevelMap?: LevelMap;
	supportsReasoningEffort?: boolean;
}

export const CACHE_FILE = "model-levels.json";
export const LOCK_FILE = "model-levels.lock";
export const STALE_MS = 24 * 60 * 60 * 1000;
/** A failed fetch is not retried by the same process sooner than this. */
export const RETRY_MS = 60 * 60 * 1000;
/** A lock older than this belongs to a process that died mid-fetch. */
export const LOCK_STALE_MS = 2 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 4000;
export const MODELS_DEV_URL = "https://models.dev/api.json";

const EFFORTS = new Set<string>(LEVELS.filter((l) => l !== "off"));

/** Build the map: off → "none" when thinking can be turned off, each effort to itself, the rest null. */
function ladder(canOff: boolean, efforts: Set<string>, boolOn: boolean): ModelLevels {
	if (efforts.size === 0 && !boolOn) return { reasoning: false };
	const map: LevelMap = { off: canOff ? "none" : null };
	for (const level of LEVELS) {
		if (level === "off") continue;
		map[level] = efforts.has(level) ? level : null;
	}
	// A boolean-only model has one "on" rung; Ollama maps a recognized effort to true.
	if (efforts.size === 0 && boolOn) map.high = "high";
	return { reasoning: true, thinkingLevelMap: map, supportsReasoningEffort: true };
}

/** Ollama `/api/show`: `thinking.values` (false, true, named efforts) and `capabilities`. */
export function fromOllama(meta: { values?: unknown; capabilities?: unknown } | undefined): ModelLevels | undefined {
	if (!meta) return undefined;
	const values = Array.isArray(meta.values) ? meta.values : [];
	if (values.length > 0) {
		const efforts = new Set(values.filter((v): v is string => typeof v === "string" && EFFORTS.has(v)));
		const named = values.some((v) => typeof v === "string");
		// Only names pi has no level for (a budget, say): nothing to map.
		if (named && efforts.size === 0 && !values.includes(true)) return undefined;
		return ladder(values.includes(false), efforts, values.includes(true));
	}
	const caps = Array.isArray(meta.capabilities) ? meta.capabilities : undefined;
	if (caps && !caps.includes("thinking")) return { reasoning: false };
	return undefined;
}

/** models.dev: `reasoning` and `reasoning_options` ([{type: "toggle"}, {type: "effort", values}]). */
export function fromModelsDev(meta: { reasoning?: unknown; options?: unknown } | undefined): ModelLevels | undefined {
	if (!meta) return undefined;
	if (meta.reasoning === false) return { reasoning: false };
	const options = Array.isArray(meta.options) ? meta.options : [];
	let toggle = false;
	const efforts = new Set<string>();
	for (const o of options) {
		const type = (o as { type?: unknown } | null)?.type;
		if (type === "toggle") toggle = true;
		if (type === "effort") {
			const values = (o as { values?: unknown }).values;
			if (Array.isArray(values)) for (const v of values) if (typeof v === "string" && EFFORTS.has(v)) efforts.add(v);
		}
	}
	// Budget-only or empty: pi's own handling stays.
	if (!toggle && efforts.size === 0) return undefined;
	return ladder(toggle, efforts, toggle);
}

// ---------------------------------------------------------------- cache

export interface CachedModel {
	source: "ollama" | "models.dev";
	values?: (string | boolean)[];
	default?: string | boolean;
	capabilities?: string[];
	retired?: true;
	reasoning?: boolean;
	options?: unknown[];
}
export interface CachedProvider {
	fetchedAt: number;
	baseUrl: string;
	models: Record<string, CachedModel>;
}
export interface LevelsCache {
	v: 1;
	providers: Record<string, CachedProvider>;
}

export function levelsOf(entry: CachedModel | undefined): ModelLevels | undefined {
	if (!entry || entry.retired) return undefined;
	return entry.source === "ollama"
		? fromOllama({ values: entry.values, capabilities: entry.capabilities })
		: fromModelsDev({ reasoning: entry.reasoning, options: entry.options });
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function readCache(agentDir: string): LevelsCache | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(agentDir, CACHE_FILE), "utf8"));
		if (!isRecord(parsed) || parsed.v !== 1 || !isRecord(parsed.providers)) return undefined;
		const providers: Record<string, CachedProvider> = {};
		for (const [id, p] of Object.entries(parsed.providers)) {
			if (!isRecord(p) || typeof p.fetchedAt !== "number" || typeof p.baseUrl !== "string" || !isRecord(p.models)) continue;
			const models: Record<string, CachedModel> = {};
			for (const [mid, m] of Object.entries(p.models)) {
				if (isRecord(m) && (m.source === "ollama" || m.source === "models.dev")) models[mid] = m as unknown as CachedModel;
			}
			providers[id] = { fetchedAt: p.fetchedAt, baseUrl: p.baseUrl, models };
		}
		return { v: 1, providers };
	} catch {
		return undefined;
	}
}

export function writeCache(agentDir: string, cache: LevelsCache): void {
	const file = path.join(agentDir, CACHE_FILE);
	const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(tmp, `${JSON.stringify(cache, null, "\t")}\n`);
	fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- models.json

export interface RawModel {
	id: string;
	[key: string]: unknown;
}
export interface RawProvider {
	baseUrl?: string;
	api?: string;
	compat?: Record<string, unknown>;
	models?: RawModel[];
	[key: string]: unknown;
}

/** The providers models.json defines with a `models` list; undefined when it can't be read. */
export function readModelsJson(file: string): Record<string, RawProvider> | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!isRecord(parsed) || !isRecord(parsed.providers)) return undefined;
		const out: Record<string, RawProvider> = {};
		for (const [id, p] of Object.entries(parsed.providers)) {
			if (!isRecord(p) || !Array.isArray(p.models)) continue;
			const models = p.models.filter((m): m is RawModel => isRecord(m) && typeof m.id === "string" && m.id.length > 0);
			if (models.length > 0) out[id] = { ...(p as RawProvider), models };
		}
		return out;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------- overlay

/** A model as the runtime composed it. Only these fields are read; every other one is carried over. */
export interface ComposedModel {
	id: string;
	provider: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null | undefined>;
	compat?: Record<string, unknown>;
	[key: string]: unknown;
}

/** The model as pi composed it before any overlay; spread copies keep it, so a re-overlay starts clean. */
const BASE = Symbol.for("sova:model-levels.base");
/** The overlay a model carries, to tell a registration that would change nothing. */
const SIG = Symbol.for("sova:model-levels.sig");
type Marked = ComposedModel & { [BASE]?: ComposedModel; [SIG]?: string };

const has = (o: unknown, key: string) => isRecord(o) && Object.prototype.hasOwnProperty.call(o, key);

/**
 * A models.json entry pi has not composed yet (added after this process registered the provider):
 * pi's own defaults for absent fields (provider-composer modelFromJson), provider compat merged
 * under the model's. Every model pi already lists is taken from pi instead.
 */
function fromRaw(raw: RawProvider, entry: RawModel, siblingApi: string | undefined): ComposedModel | undefined {
	const api = (entry.api as string | undefined) ?? raw.api ?? siblingApi;
	const baseUrl = (entry.baseUrl as string | undefined) ?? raw.baseUrl;
	if (!api || !baseUrl) return undefined;
	const compat = raw.compat || entry.compat ? { ...raw.compat, ...(entry.compat as Record<string, unknown> | undefined) } : undefined;
	const { headers: _headers, ...rest } = entry;
	return {
		...rest,
		id: entry.id,
		provider: "",
		name: (entry.name as string | undefined) ?? entry.id,
		api,
		baseUrl,
		reasoning: (entry.reasoning as boolean | undefined) ?? false,
		input: (entry.input as string[] | undefined) ?? ["text"],
		cost: entry.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: (entry.contextWindow as number | undefined) ?? 128000,
		maxTokens: (entry.maxTokens as number | undefined) ?? 16384,
		compat,
	};
}

export interface Overlay {
	/** Model definitions for the provider's registration (`models`). */
	models: Record<string | symbol, unknown>[];
	signature: string;
	/** False when the runtime already lists exactly this overlay. */
	changed: boolean;
}

/**
 * One provider's overlay, or undefined when it isn't covered: no metadata, or a provider with a
 * built-in base (pi lists a model models.json doesn't define).
 */
export function overlayProvider(raw: RawProvider, composed: ComposedModel[], cached: CachedProvider | undefined): Overlay | undefined {
	if (!cached || !raw.models?.length || composed.length === 0) return undefined;
	const rawIds = new Set(raw.models.map((m) => m.id));
	if (composed.some((m) => !rawIds.has(m.id))) return undefined;
	const byId = new Map(composed.map((m) => [m.id, ((m as Marked)[BASE] ?? m) as ComposedModel]));
	const siblingApi = composed.find((m) => typeof m.api === "string")?.api;
	const models: Record<string | symbol, unknown>[] = [];
	const sig: unknown[] = [];
	for (const entry of raw.models) {
		const meta = cached.models[entry.id];
		if (meta?.retired) continue;
		const base = byId.get(entry.id) ?? fromRaw(raw, entry, siblingApi);
		if (!base) continue;
		const { provider: _provider, headers: _headers, ...def } = base as Marked;
		const out: Record<string | symbol, unknown> = { ...def };
		delete out[BASE];
		delete out[SIG];
		const levels = levelsOf(meta);
		if (levels) {
			if (!has(entry, "reasoning")) out.reasoning = levels.reasoning;
			if (levels.thinkingLevelMap && !has(entry, "thinkingLevelMap")) out.thinkingLevelMap = { ...levels.thinkingLevelMap };
			if (levels.supportsReasoningEffort !== undefined && !has(entry.compat, "supportsReasoningEffort")) {
				out.compat = { ...(base.compat ?? {}), supportsReasoningEffort: levels.supportsReasoningEffort };
			}
		}
		out[BASE] = base;
		models.push(out);
		sig.push([entry.id, out.reasoning ?? null, out.thinkingLevelMap ?? null, (out.compat as Record<string, unknown> | undefined)?.supportsReasoningEffort ?? null]);
	}
	const signature = JSON.stringify(sig);
	for (const m of models) m[SIG] = signature;
	const changed = composed.length !== models.length || composed.some((m) => (m as Marked)[SIG] !== signature);
	return { models, signature, changed };
}

/** Where levels are applied: a model runtime, seen through what both pi versions offer. */
export interface LevelsTarget {
	/** Every model the runtime lists now. */
	models(): ComposedModel[];
	/** Register a provider's model list (pi's registerProvider with `{models}`). */
	register(provider: string, models: Record<string | symbol, unknown>[]): void;
}

export interface ApplyOptions {
	agentDir: string;
	/** Defaults to `<agentDir>/models.json`, as pi's model runtime reads it. */
	modelsPath?: string;
	/** The session's current model: re-registered even when unchanged if it still carries an older overlay, so the session picks the new one up. */
	current?: ComposedModel;
}

/** Apply the cached levels to every covered provider; returns the providers registered. */
export function applyModelLevels(target: LevelsTarget, opts: ApplyOptions): string[] {
	const raw = readModelsJson(opts.modelsPath ?? path.join(opts.agentDir, "models.json"));
	const cache = readCache(opts.agentDir);
	if (!raw || !cache) return [];
	const all = target.models();
	const done: string[] = [];
	for (const [provider, config] of Object.entries(raw)) {
		const overlay = overlayProvider(
			config,
			all.filter((m) => m.provider === provider),
			cache.providers[provider],
		);
		if (!overlay) continue;
		const current = opts.current?.provider === provider ? (opts.current as Marked) : undefined;
		const stale = current !== undefined && current[SIG] !== overlay.signature && overlay.models.some((m) => m.id === current.id);
		if (!overlay.changed && !stale) continue;
		try {
			target.register(provider, overlay.models);
			done.push(provider);
		} catch {
			// A registration pi refuses leaves the provider as models.json made it.
		}
	}
	return done;
}

// ---------------------------------------------------------------- fetching

/** Ollama's own server for a provider baseUrl (ollama.com, or anything on port 11434), else undefined. */
export function ollamaOrigin(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) return undefined;
	try {
		const u = new URL(baseUrl);
		if (u.hostname === "ollama.com" || u.hostname.endsWith(".ollama.com") || u.port === "11434") return u.origin;
	} catch {
		// Not a URL: no source.
	}
	return undefined;
}

const sameUrl = (a: unknown, b: string) => typeof a === "string" && a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

type Fetch = (url: string, init?: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

async function timed<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	try {
		return await run(controller.signal);
	} finally {
		clearTimeout(timer);
	}
}

/** One model's `/api/show`: its record, `retired`, or undefined when the answer says nothing usable. */
async function showModel(fetchFn: Fetch, origin: string, id: string): Promise<CachedModel | undefined> {
	return timed(FETCH_TIMEOUT_MS, async (signal) => {
		const res = await fetchFn(`${origin}/api/show`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: id }),
			signal,
		});
		const body = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
		if (!res.ok) {
			const error = typeof body?.error === "string" ? body.error : "";
			return /\bretired\b/i.test(error) ? { source: "ollama", retired: true } : undefined;
		}
		if (!isRecord(body)) return undefined;
		const thinking = isRecord(body.thinking) ? body.thinking : undefined;
		const out: CachedModel = { source: "ollama" };
		if (Array.isArray(thinking?.values)) out.values = thinking.values.filter((v) => typeof v === "string" || typeof v === "boolean");
		if (typeof thinking?.default === "string" || typeof thinking?.default === "boolean") out.default = thinking.default;
		if (Array.isArray(body.capabilities)) out.capabilities = body.capabilities.filter((c): c is string => typeof c === "string");
		return out;
	});
}

async function inBatches<T>(items: T[], width: number, run: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(width, items.length) }, async () => {
			while (next < items.length) await run(items[next++] as T);
		}),
	);
}

/** Has the provider's cached metadata gone stale (old, another baseUrl, or a model it lacks)? */
export function isStale(raw: RawProvider, cached: CachedProvider | undefined, now: number): boolean {
	if (!cached) return true;
	if (cached.baseUrl !== (raw.baseUrl ?? "")) return true;
	if (now - cached.fetchedAt > STALE_MS) return true;
	return (raw.models ?? []).some((m) => !(m.id in cached.models));
}

/**
 * Fetch one provider's metadata. Ollama's server first; models.dev for what it leaves open. Throws
 * when no source answered, so the caller keeps the last cache.
 */
export async function fetchProvider(
	raw: RawProvider,
	previous: CachedProvider | undefined,
	deps: { fetch: Fetch; now: number; modelsDev: () => Promise<unknown> },
): Promise<CachedProvider> {
	const ids = (raw.models ?? []).map((m) => m.id);
	const baseUrl = raw.baseUrl ?? "";
	const models: Record<string, CachedModel> = {};
	const origin = ollamaOrigin(baseUrl);
	let answered = false;
	if (origin) {
		// Is the server there at all? One quick call rather than a timeout per model.
		const tags = await timed(FETCH_TIMEOUT_MS, (signal) => deps.fetch(`${origin}/api/tags`, { signal })).catch(() => undefined);
		if (tags?.ok) {
			answered = true;
			await inBatches(ids, 4, async (id) => {
				const got = await showModel(deps.fetch, origin, id).catch(() => undefined);
				if (got) models[id] = got;
			});
		}
	}
	const open = ids.filter((id) => {
		const m = models[id];
		return !m || (!m.retired && !m.values?.length && (!m.capabilities || m.capabilities.includes("thinking")));
	});
	if (open.length > 0) {
		const catalog = await deps.modelsDev().catch(() => undefined);
		if (isRecord(catalog)) {
			const provider = Object.values(catalog).find((p) => isRecord(p) && sameUrl(p.api, baseUrl)) as Record<string, unknown> | undefined;
			const listed = isRecord(provider?.models) ? provider.models : undefined;
			if (listed) answered = true;
			for (const id of open) {
				const m = listed?.[id];
				if (!isRecord(m)) continue;
				models[id] = {
					source: "models.dev",
					...(typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {}),
					...(Array.isArray(m.reasoning_options) ? { options: m.reasoning_options } : {}),
				};
			}
		}
	}
	if (!answered) throw new Error("no metadata source answered");
	// A model no source answered for this time keeps what it had.
	for (const id of ids) if (!models[id] && previous?.models[id]) models[id] = previous.models[id];
	return { fetchedAt: deps.now, baseUrl, models };
}

// ---------------------------------------------------------------- background refresh

interface State {
	inflight: Promise<string[]> | null;
	failedAt: Map<string, number>;
	listeners: Set<() => void>;
}
const STATE = Symbol.for("sova:model-levels");
function state(): State {
	const g = globalThis as unknown as Record<symbol, State | undefined>;
	return (g[STATE] ??= { inflight: null, failedAt: new Map(), listeners: new Set() });
}

/** Called after fresh metadata lands; returns the unsubscribe. Shared by every copy of this module in the process. */
export function onLevelsUpdated(fn: () => void): () => void {
	const s = state();
	s.listeners.add(fn);
	return () => s.listeners.delete(fn);
}

/** The device-wide claim on a fetch: a lock file, taken over when its writer is long gone. */
function claimLock(agentDir: string, now: number): (() => void) | undefined {
	const file = path.join(agentDir, LOCK_FILE);
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			fs.mkdirSync(agentDir, { recursive: true });
			const fd = fs.openSync(file, "wx");
			fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: now }));
			fs.closeSync(fd);
			return () => fs.rmSync(file, { force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
			try {
				if (now - fs.statSync(file).mtimeMs < LOCK_STALE_MS) return undefined;
				fs.rmSync(file, { force: true });
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}

/**
 * Whether model metadata may be fetched: never with PI_OFFLINE or `SOVA_MODELS_FETCH=off|0|false`;
 * `on|1|true` always may; unset, a test process (NODE_TEST_CONTEXT, or bun test's NODE_ENV=test)
 * never does. The TUI (no switch, not a test) fetches. Sova's boot fetches follow the same rule.
 */
export function modelFetchEnabled(env: Record<string, string | undefined>): boolean {
	if (env.PI_OFFLINE) return false;
	const v = (env.SOVA_MODELS_FETCH ?? "").toLowerCase();
	if (["off", "0", "false"].includes(v)) return false;
	if (["on", "1", "true"].includes(v)) return true;
	return !env.NODE_TEST_CONTEXT && env.NODE_ENV !== "test";
}

export interface RefreshOptions {
	agentDir: string;
	modelsPath?: string;
	now?: () => number;
	fetch?: Fetch;
	modelsDev?: () => Promise<unknown>;
	/** The environment modelFetchEnabled reads; defaults to process.env. */
	env?: Record<string, string | undefined>;
}

/**
 * Fetch every provider whose metadata is stale, write the cache and tell the listeners. Resolves to
 * the providers it updated. Never throws; when modelFetchEnabled says no, it fetches nothing.
 */
export function refreshStale(opts: RefreshOptions): Promise<string[]> {
	const s = state();
	if (s.inflight) return s.inflight;
	const run = async (): Promise<string[]> => {
		if (!modelFetchEnabled(opts.env ?? process.env)) return [];
		const now = (opts.now ?? Date.now)();
		const raw = readModelsJson(opts.modelsPath ?? path.join(opts.agentDir, "models.json"));
		if (!raw) return [];
		const cache = readCache(opts.agentDir) ?? { v: 1, providers: {} };
		const due = Object.entries(raw).filter(([id, p]) => {
			if (now - (s.failedAt.get(id) ?? -Infinity) < RETRY_MS) return false;
			return typeof p.baseUrl === "string" && isStale(p, cache.providers[id], now);
		});
		if (due.length === 0) return [];
		const release = claimLock(opts.agentDir, now);
		if (!release) return [];
		try {
			const fetchFn = opts.fetch ?? (globalThis.fetch as unknown as Fetch);
			let catalog: Promise<unknown> | undefined;
			const modelsDev =
				opts.modelsDev ??
				(() =>
					(catalog ??= timed(10_000, async (signal) => {
						const res = await fetchFn(MODELS_DEV_URL, { signal });
						if (!res.ok) throw new Error(`models.dev ${res.status}`);
						return res.json();
					})));
			const updated: Record<string, CachedProvider> = {};
			for (const [id, p] of due) {
				try {
					updated[id] = await fetchProvider(p, cache.providers[id], { fetch: fetchFn, now, modelsDev });
					s.failedAt.delete(id);
				} catch {
					s.failedAt.set(id, now);
				}
			}
			const names = Object.keys(updated);
			if (names.length === 0) return [];
			// Another process may have written other providers meanwhile: merge over the newest file.
			const latest = readCache(opts.agentDir) ?? { v: 1, providers: {} };
			writeCache(opts.agentDir, { v: 1, providers: { ...latest.providers, ...updated } });
			return names;
		} finally {
			release();
		}
	};
	s.inflight = run()
		.catch(() => [] as string[])
		.then((names) => {
			s.inflight = null;
			if (names.length > 0) for (const fn of [...s.listeners]) {
				try {
					fn();
				} catch {
					// One listener's failure never stops the others.
				}
			}
			return names;
		});
	return s.inflight;
}
