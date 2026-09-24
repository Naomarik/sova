/**
 * Registration is opt-in: with the flag off nothing reaches pi's model
 * registry. These tests use a fake ExtensionAPI, so no CLI and no pi session
 * are involved.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ClaudeSessionBridge } from "./types.ts";
import {
	CLAUDE_PROVIDER_API_KEY,
	CLAUDE_PROVIDER_FLAG,
	CLAUDE_PROVIDER_ID,
	REGISTERED_MARKER,
	refreshClaudeModels,
	registerProviderIfEnabled,
	STATIC_MODELS,
	contextWindowFor,
	toProviderModel,
} from "./index.ts";

// Registration is deliberately once-per-process; clear that marker per test.
beforeEach(() => {
	delete (globalThis as unknown as Record<symbol, boolean | undefined>)[REGISTERED_MARKER];
});

const bridge: ClaudeSessionBridge = {
	runTurn() {
		throw new Error("the bridge must not run during registration");
	},
};

/** Mirrors the loader: the flag value is only readable once a session starts. */
function fakePi(flagValue?: boolean) {
	const state = {
		flags: new Map<string, { type: string; default?: boolean }>(),
		registered: new Map<string, ProviderConfig>(),
		unregistered: [] as string[],
		sessionStart: [] as (() => void)[],
		values: new Map<string, boolean | string>(),
	};
	const pi = {
		registerFlag(name: string, options: { type: string; default?: boolean }) {
			state.flags.set(name, options);
			if (options.default !== undefined) state.values.set(name, options.default);
		},
		getFlag(name: string) {
			return state.flags.has(name) ? state.values.get(name) : undefined;
		},
		registerProvider(name: string, config: ProviderConfig) {
			state.registered.set(name, config);
		},
		unregisterProvider(name: string) {
			state.unregistered.push(name);
			state.registered.delete(name);
		},
		on(event: string, handler: () => void) {
			if (event === "session_start") state.sessionStart.push(handler);
		},
	} as unknown as ExtensionAPI;
	const startSession = () => {
		if (flagValue !== undefined) state.values.set(CLAUDE_PROVIDER_FLAG, flagValue);
		for (const handler of state.sessionStart) handler();
	};
	return { pi, state, startSession };
}

test("the flag is registered as an off-by-default boolean and registers nothing at load", () => {
	const { pi, state } = fakePi();
	registerProviderIfEnabled(pi, bridge);
	assert.deepEqual(state.flags.get(CLAUDE_PROVIDER_FLAG)?.default, false);
	assert.equal(state.registered.size, 0);
});

test("flag off registers no provider, even after session start", () => {
	const { pi, state, startSession } = fakePi(false);
	registerProviderIfEnabled(pi, bridge);
	startSession();
	assert.equal(state.registered.size, 0);
	assert.deepEqual(state.unregistered, []);
});

test("flag on registers the provider with a literal key and static models", () => {
	const { pi, state, startSession } = fakePi(true);
	registerProviderIfEnabled(pi, bridge);
	startSession();
	const config = state.registered.get(CLAUDE_PROVIDER_ID);
	assert.ok(config, "the provider must be registered when the flag is on");
	assert.equal(config.apiKey, CLAUDE_PROVIDER_API_KEY);
	assert.equal(config.apiKey?.startsWith("$"), false);
	assert.equal(config.apiKey?.startsWith("!"), false);
	assert.ok(config.baseUrl, "baseUrl is mandatory when models are given");
	assert.equal(config.api, CLAUDE_PROVIDER_ID);
	assert.equal(typeof config.streamSimple, "function");
	assert.deepEqual(config.models?.map((model) => model.id), ["claude-fable-5-1[1m]", "opus[1m]", "sonnet", "haiku"]);
});

test("registration happens once per process, and is never undone", () => {
	const { pi, state, startSession } = fakePi(true);
	registerProviderIfEnabled(pi, bridge);
	startSession();
	const first = state.registered.get(CLAUDE_PROVIDER_ID);
	assert.ok(first);
	state.registered.delete(CLAUDE_PROVIDER_ID);
	startSession();
	assert.equal(state.registered.size, 0, "a second session_start must not register again");
	// Sova shares one ModelRuntime: a later flag-off session must not
	// unregister a provider another session may be streaming through.
	const second = fakePi(false);
	registerProviderIfEnabled(second.pi, bridge);
	second.startSession();
	assert.deepEqual(second.state.unregistered, []);
	assert.deepEqual(state.unregistered, []);
});

test("static models are zero cost, cache-free, and sized by the [1m] suffix", () => {
	for (const model of STATIC_MODELS) {
		assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.equal(model.promptCache, undefined, "promptCache would turn on cache warming pi cannot address");
		assert.deepEqual(model.input, ["text", "image"]);
		assert.equal(model.contextWindow, model.id.endsWith("[1m]") ? 1_000_000 : 200_000);
		assert.ok(model.maxTokens > 0);
	}
	assert.equal(contextWindowFor("opus[1m]"), 1_000_000);
	assert.equal(contextWindowFor("sonnet"), 200_000);
	assert.equal(contextWindowFor("claude-fable-5-1"), 200_000);
});

test("thinking levels follow the CLI's effort list", () => {
	const sonnet = STATIC_MODELS.find((model) => model.id === "sonnet") as ProviderModelConfig;
	assert.equal(sonnet.reasoning, true);
	assert.deepEqual(sonnet.thinkingLevelMap, { minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
	const haiku = STATIC_MODELS.find((model) => model.id === "haiku") as ProviderModelConfig;
	assert.equal(haiku.reasoning, false, "the CLI reports no effort levels for haiku");
	assert.equal(haiku.thinkingLevelMap, undefined);
	const partial = toProviderModel({ id: "someday", name: "Someday", efforts: ["low", "high"] });
	assert.deepEqual(partial.thinkingLevelMap, { minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null });
});

test("refreshModels stays offline until pi allows network work", async () => {
	const models = await refreshClaudeModels({ allowNetwork: false, signal: new AbortController().signal });
	assert.equal(models, STATIC_MODELS);
});

test("refreshModels falls back to the static list when discovery fails", async () => {
	// An aborted signal makes discoverClaudeModels reject without spawning.
	const models = await refreshClaudeModels({ allowNetwork: true, signal: AbortSignal.abort() });
	assert.equal(models, STATIC_MODELS);
});
