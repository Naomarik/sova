import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	CACHE_FILE,
	LOCK_FILE,
	STALE_MS,
	applyModelLevels,
	fetchProvider,
	fromModelsDev,
	fromOllama,
	isStale,
	modelFetchEnabled,
	ollamaOrigin,
	overlayProvider,
	readCache,
	refreshStale,
	type CachedProvider,
	type ComposedModel,
	type RawProvider,
} from "./core.ts";

/** pi's level list rule (reasoning: the ladder minus nulls, xhigh/max only when mapped). */
function levels(m: { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null | undefined> }): string[] {
	if (!m.reasoning) return ["off"];
	return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].filter((l) => {
		const v = m.thinkingLevelMap?.[l];
		if (v === null) return false;
		if (l === "xhigh" || l === "max") return v !== undefined;
		return true;
	});
}

test("Ollama thinking values map onto pi's ladder", () => {
	const ds = fromOllama({ values: [false, "low", "high", "max"], capabilities: ["thinking"] })!;
	assert.deepEqual(levels(ds), ["off", "low", "high", "max"]);
	assert.equal(ds.thinkingLevelMap!.off, "none");
	assert.equal(ds.thinkingLevelMap!.max, "max");
	assert.equal(ds.supportsReasoningEffort, true);
	assert.deepEqual(levels(fromOllama({ values: ["low", "high", "max"] })!), ["low", "high", "max"]);
	assert.deepEqual(levels(fromOllama({ values: ["low", "medium", "high"] })!), ["low", "medium", "high"]);
	// Boolean toggle, default on (nemotron) or off (gemma4): off plus one "on" rung sent as high.
	const toggle = fromOllama({ values: [false, true] })!;
	assert.deepEqual(levels(toggle), ["off", "high"]);
	assert.equal(toggle.thinkingLevelMap!.high, "high");
	assert.equal(toggle.thinkingLevelMap!.off, "none");
	// Always on: one level, so the Thinking group hides.
	assert.deepEqual(levels(fromOllama({ values: [true] })!), ["high"]);
});

test("no thinking capability is not reasoning; no values with the capability is left open", () => {
	assert.deepEqual(fromOllama({ capabilities: ["completion", "tools"] }), { reasoning: false });
	assert.equal(fromOllama({ capabilities: ["completion", "thinking"] }), undefined);
	assert.equal(fromOllama({}), undefined);
	assert.equal(fromOllama({ values: ["budget"] }), undefined, "names pi has no level for map to nothing");
});

test("models.dev reasoning options: toggle, effort, budget", () => {
	assert.deepEqual(levels(fromModelsDev({ reasoning: true, options: [{ type: "toggle" }, { type: "effort", values: ["low", "medium", "high", "max"] }] })!), [
		"off",
		"low",
		"medium",
		"high",
		"max",
	]);
	assert.deepEqual(levels(fromModelsDev({ reasoning: true, options: [{ type: "toggle" }] })!), ["off", "high"]);
	assert.deepEqual(levels(fromModelsDev({ reasoning: true, options: [{ type: "effort", values: ["low", "medium", "high"] }] })!), ["low", "medium", "high"]);
	assert.equal(fromModelsDev({ reasoning: true, options: [{ type: "budget_tokens", min: 1024 }] }), undefined);
	assert.equal(fromModelsDev({ reasoning: true, options: [] }), undefined);
	assert.deepEqual(fromModelsDev({ reasoning: false }), { reasoning: false });
});

test("Ollama's own server: ollama.com and port 11434 only", () => {
	assert.equal(ollamaOrigin("https://ollama.com/v1"), "https://ollama.com");
	assert.equal(ollamaOrigin("http://localhost:11434/v1"), "http://localhost:11434");
	assert.equal(ollamaOrigin("https://api.example.com/v1"), undefined);
	assert.equal(ollamaOrigin(undefined), undefined);
});

const RAW: RawProvider = {
	baseUrl: "https://ollama.com/v1",
	api: "openai-completions",
	compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
	models: [
		{ id: "ds", reasoning: true },
		{ id: "glm" },
		{ id: "hand", thinkingLevelMap: { off: null, high: "high" }, compat: { supportsReasoningEffort: false } },
		{ id: "old", reasoning: true },
		{ id: "plain" },
		{ id: "unknown", reasoning: true },
	],
};
const composedOf = (raw: RawProvider, provider = "oc"): ComposedModel[] =>
	raw.models!.map((m) => ({
		id: m.id,
		provider,
		name: m.id,
		api: "openai-completions",
		baseUrl: raw.baseUrl,
		reasoning: (m.reasoning as boolean) ?? false,
		thinkingLevelMap: m.thinkingLevelMap as Record<string, string | null> | undefined,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
		compat: { ...raw.compat, ...(m.compat as object) },
	}));
const CACHED: CachedProvider = {
	fetchedAt: 1,
	baseUrl: "https://ollama.com/v1",
	models: {
		ds: { source: "ollama", values: [false, "low", "high", "max"] },
		glm: { source: "ollama", values: ["low", "high", "max"] },
		hand: { source: "ollama", values: [false, "low", "high", "max"] },
		old: { source: "ollama", retired: true },
		plain: { source: "ollama", capabilities: ["completion"] },
	},
};

test("overlay: only the three fields change, provider compat stays, retired drop, user fields win", () => {
	const o = overlayProvider(RAW, composedOf(RAW), CACHED)!;
	assert.ok(o.changed);
	const by = Object.fromEntries(o.models.map((m) => [m.id as string, m as Record<string, any>]));
	assert.deepEqual(Object.keys(by), ["ds", "glm", "hand", "plain", "unknown"], "retired 'old' is left out, models.json order kept");
	assert.equal(by.ds.compat.supportsDeveloperRole, false, "provider-level compat survives");
	assert.equal(by.ds.compat.supportsReasoningEffort, true);
	assert.deepEqual(levels(by.ds), ["off", "low", "high", "max"]);
	assert.equal(by.glm.reasoning, true, "Ollama says it thinks; models.json didn't say");
	assert.deepEqual(levels(by.glm), ["low", "high", "max"]);
	assert.deepEqual(by.hand.thinkingLevelMap, { off: null, high: "high" }, "a hand-written map is kept");
	assert.equal(by.hand.compat.supportsReasoningEffort, false, "a hand-written compat flag is kept");
	assert.equal(by.plain.reasoning, false);
	assert.equal(by.unknown.reasoning, true, "no metadata: as models.json has it");
	assert.equal(by.unknown.thinkingLevelMap, undefined);
	assert.equal(by.unknown.compat.supportsReasoningEffort, false);
	assert.equal(by.ds.provider, undefined, "pi sets provider itself");
	assert.equal(by.ds.contextWindow, 1000, "everything else carried over");
});

test("overlay: a provider pi lists models for beyond models.json is never touched", () => {
	const composed = [...composedOf(RAW), { id: "builtin-only", provider: "oc", api: "x", baseUrl: "y" }];
	assert.equal(overlayProvider(RAW, composed, CACHED), undefined);
	assert.equal(overlayProvider(RAW, composedOf(RAW), undefined), undefined, "no metadata: nothing");
});

test("overlay: re-applied over its own result it changes nothing, and starts from pi's model", () => {
	const first = overlayProvider(RAW, composedOf(RAW), CACHED)!;
	// pi spreads each definition into its model; the markers ride along.
	const registered = first.models.map((m) => ({ ...m, provider: "oc" })) as unknown as ComposedModel[];
	const again = overlayProvider(RAW, registered, CACHED)!;
	assert.equal(again.changed, false);
	// New metadata: glm loses its thinking. The base is pi's model, not the earlier overlay.
	const next = overlayProvider(RAW, registered, { ...CACHED, models: { ...CACHED.models, glm: { source: "ollama", capabilities: ["completion"] } } })!;
	assert.ok(next.changed);
	const glm = next.models.find((m) => m.id === "glm") as Record<string, any>;
	assert.equal(glm.reasoning, false);
	assert.equal(glm.compat.supportsReasoningEffort, false, "back to the provider's flag");
});

test("overlay: a model added to models.json after registration is built from its entry with provider compat", () => {
	const registered = overlayProvider(RAW, composedOf(RAW), CACHED)!.models.map((m) => ({ ...m, provider: "oc" })) as unknown as ComposedModel[];
	const raw = { ...RAW, models: [...RAW.models!, { id: "new", contextWindow: 5 }] };
	const o = overlayProvider(raw, registered, { ...CACHED, models: { ...CACHED.models, new: { source: "ollama", values: [false, true] } } })!;
	const m = o.models.find((x) => x.id === "new") as Record<string, any>;
	assert.equal(m.contextWindow, 5);
	assert.equal(m.compat.supportsDeveloperRole, false);
	assert.equal(m.api, "openai-completions");
	assert.deepEqual(levels(m), ["off", "high"]);
});

/** A TUI's environment: no switch, not a test process (this file itself runs as one). */
const TUI: Record<string, string> = {};
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "model-levels-"));
const writeJson = (file: string, v: unknown) => fs.writeFileSync(file, JSON.stringify(v));

test("applyModelLevels registers changed providers only, and a stale current model forces one", () => {
	const dir = scratch();
	writeJson(path.join(dir, "models.json"), { providers: { oc: RAW, builtin: { modelOverrides: {} } } });
	let models = composedOf(RAW);
	const calls: string[] = [];
	const target = {
		models: () => models,
		register: (id: string, defs: Record<string | symbol, unknown>[]) => {
			calls.push(id);
			models = defs.map((d) => ({ ...d, provider: id })) as unknown as ComposedModel[];
		},
	};
	assert.deepEqual(applyModelLevels(target, { agentDir: dir }), [], "no cache: today's behaviour");
	writeJson(path.join(dir, CACHE_FILE), { v: 1, providers: { oc: CACHED } });
	assert.deepEqual(applyModelLevels(target, { agentDir: dir }), ["oc"]);
	assert.deepEqual(applyModelLevels(target, { agentDir: dir }), [], "unchanged: no registration");
	const old = composedOf(RAW)[0];
	assert.deepEqual(applyModelLevels(target, { agentDir: dir, current: old }), ["oc"], "the session's model predates the overlay");
	assert.deepEqual(calls, ["oc", "oc"]);
});

function fakeFetch(answers: Record<string, { status: number; body: unknown }>, log: string[] = []) {
	return async (url: string, init?: { body?: string }) => {
		const key = init?.body ? `${url} ${JSON.parse(init.body).model}` : url;
		log.push(key);
		const a = answers[key];
		if (!a) throw new Error(`offline: ${key}`);
		return { ok: a.status < 300, status: a.status, json: async () => a.body, text: async () => JSON.stringify(a.body) };
	};
}

test("fetchProvider: /api/show first, models.dev for what it leaves open, retired marked", async () => {
	const raw: RawProvider = { baseUrl: "https://ollama.com/v1", models: [{ id: "ds" }, { id: "mm" }, { id: "gone" }, { id: "x" }] };
	const o = "https://ollama.com";
	const fetch = fakeFetch({
		[`${o}/api/tags`]: { status: 200, body: { models: [] } },
		[`${o}/api/show ds`]: { status: 200, body: { thinking: { values: [false, "low", "high", "max"], default: "high" }, capabilities: ["thinking"] } },
		[`${o}/api/show mm`]: { status: 200, body: { capabilities: ["completion", "thinking"] } },
		[`${o}/api/show gone`]: { status: 410, body: { error: "gone was retired at 2026-09-25" } },
	});
	const previous: CachedProvider = { fetchedAt: 0, baseUrl: raw.baseUrl!, models: { x: { source: "ollama", values: [true] } } };
	const modelsDev = async () => ({
		other: { api: "https://elsewhere/v1", models: {} },
		oc: { api: "https://ollama.com/v1/", models: { mm: { reasoning: true, reasoning_options: [{ type: "toggle" }] } } },
	});
	const got = await fetchProvider(raw, previous, { fetch, now: 42, modelsDev });
	assert.equal(got.fetchedAt, 42);
	assert.deepEqual(got.models.ds.values, [false, "low", "high", "max"]);
	assert.equal(got.models.ds.default, "high");
	assert.equal(got.models.mm.source, "models.dev");
	assert.equal(got.models.gone.retired, true);
	assert.deepEqual(got.models.x, previous.models.x, "no answer this time: keeps what it had");
});

test("fetchProvider: no source answering throws, so the last cache stays", async () => {
	const raw: RawProvider = { baseUrl: "http://localhost:11434/v1", models: [{ id: "q" }] };
	await assert.rejects(fetchProvider(raw, undefined, { fetch: fakeFetch({}), now: 1, modelsDev: async () => ({}) }));
});

test("isStale: age, another baseUrl, a model the cache lacks", () => {
	const raw: RawProvider = { baseUrl: "u", models: [{ id: "a" }] };
	const c: CachedProvider = { fetchedAt: 1000, baseUrl: "u", models: { a: { source: "ollama" } } };
	assert.equal(isStale(raw, c, 1000 + STALE_MS - 1), false);
	assert.equal(isStale(raw, c, 1000 + STALE_MS + 1), true);
	assert.equal(isStale({ ...raw, baseUrl: "v" }, c, 1000), true);
	assert.equal(isStale({ ...raw, models: [{ id: "a" }, { id: "b" }] }, c, 1000), true);
	assert.equal(isStale(raw, undefined, 1000), true);
});

test("refreshStale: fetches stale providers, writes the cache, tells listeners; offline and locked fetch nothing", async () => {
	const dir = scratch();
	writeJson(path.join(dir, "models.json"), { providers: { oc: { baseUrl: "https://ollama.com/v1", models: [{ id: "g" }] } } });
	const log: string[] = [];
	const fetch = fakeFetch(
		{
			"https://ollama.com/api/tags": { status: 200, body: {} },
			"https://ollama.com/api/show g": { status: 200, body: { thinking: { values: ["low", "high"] }, capabilities: ["thinking"] } },
		},
		log,
	);
	const { onLevelsUpdated } = await import("./core.ts");
	let told = 0;
	const off = onLevelsUpdated(() => told++);
	try {
		assert.deepEqual(await refreshStale({ agentDir: dir, env: { PI_OFFLINE: "1" }, fetch, now: () => 5 }), []);
		assert.equal(log.length, 0);

		fs.writeFileSync(path.join(dir, LOCK_FILE), "{}");
		assert.deepEqual(await refreshStale({ agentDir: dir, env: TUI, fetch, now: () => Date.now() }), [], "another process holds the fetch");
		fs.rmSync(path.join(dir, LOCK_FILE));

		assert.deepEqual(await refreshStale({ agentDir: dir, env: TUI, fetch, now: () => 5 }), ["oc"]);
		assert.equal(told, 1);
		assert.deepEqual(readCache(dir)!.providers.oc.models.g.values, ["low", "high"]);
		assert.equal(fs.existsSync(path.join(dir, LOCK_FILE)), false, "the lock is released");
		log.length = 0;
		assert.deepEqual(await refreshStale({ agentDir: dir, env: TUI, fetch, now: () => 6 }), [], "fresh: no fetch");
		assert.equal(log.length, 0);
	} finally {
		off();
	}
});

test("SOVA_MODELS_FETCH=off: a stale Ollama provider is never fetched", async () => {
	const dir = scratch();
	writeJson(path.join(dir, "models.json"), { providers: { oc: { baseUrl: "https://ollama.com/v1", models: [{ id: "g" }] } } });
	writeJson(path.join(dir, CACHE_FILE), { v: 1, providers: { oc: { fetchedAt: 0, baseUrl: "https://ollama.com/v1", models: { g: { source: "ollama", values: [true] } } } } });
	let calls = 0;
	const fetch = async () => {
		calls++;
		throw new Error("must not be called");
	};
	for (const v of ["off", "0", "false"]) {
		assert.deepEqual(await refreshStale({ agentDir: dir, env: { SOVA_MODELS_FETCH: v }, fetch, now: () => STALE_MS * 3, modelsDev: async () => ({}) }), []);
	}
	assert.equal(calls, 0);
});

test("modelFetchEnabled: one rule for the extension and Sova's boot", () => {
	assert.equal(modelFetchEnabled({}), true, "the TUI fetches");
	assert.equal(modelFetchEnabled({ PI_OFFLINE: "1", SOVA_MODELS_FETCH: "on" }), false);
	assert.equal(modelFetchEnabled({ SOVA_MODELS_FETCH: "off" }), false);
	assert.equal(modelFetchEnabled({ NODE_ENV: "test" }), false);
	assert.equal(modelFetchEnabled({ NODE_TEST_CONTEXT: "child" }), false);
	assert.equal(modelFetchEnabled({ NODE_ENV: "test", SOVA_MODELS_FETCH: "1" }), true);
});

test("refreshStale: a failed fetch keeps the last cache and isn't retried at once", async () => {
	const dir = scratch();
	writeJson(path.join(dir, "models.json"), { providers: { lo: { baseUrl: "http://localhost:11434/v1", models: [{ id: "q" }] } } });
	const kept = { v: 1, providers: { lo: { fetchedAt: 0, baseUrl: "http://localhost:11434/v1", models: { q: { source: "ollama", values: [false, true] } } } } };
	writeJson(path.join(dir, CACHE_FILE), kept);
	const log: string[] = [];
	const fetch = fakeFetch({}, log);
	assert.deepEqual(await refreshStale({ agentDir: dir, env: TUI, fetch, now: () => STALE_MS * 2, modelsDev: async () => ({}) }), []);
	assert.deepEqual(readCache(dir), kept);
	const tries = log.length;
	assert.ok(tries > 0);
	assert.deepEqual(await refreshStale({ agentDir: dir, env: TUI, fetch, now: () => STALE_MS * 2 + 1000, modelsDev: async () => ({}) }), []);
	assert.equal(log.length, tries, "backed off");
});
