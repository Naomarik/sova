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
	toProviderModel,
} from "./index.ts";
import { claudeContextWindow } from "../context-window.ts";

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
		commands: new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>(),
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
		registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
			state.commands.set(name, options);
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

test("the /claude-login command is registered at load, and refuses while Claude Code models are off", async () => {
	const { pi, state, startSession } = fakePi(false);
	registerProviderIfEnabled(pi, bridge);
	startSession();
	const command = state.commands.get("claude-login");
	assert.ok(command, "Sova's composer calls this handler to switch a chat's login");
	await assert.rejects(command.handler("l-0000000a", {}), /Claude Code models are off/);
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

test("static models are zero cost, cache-free, and sized by the shared window rule", () => {
	for (const model of STATIC_MODELS) {
		assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.equal(model.promptCache, undefined, "promptCache would turn on cache warming pi cannot address");
		assert.deepEqual(model.input, ["text", "image"]);
		assert.equal(model.contextWindow, claudeContextWindow(model.id));
		assert.ok(model.maxTokens > 0);
	}
	assert.equal(STATIC_MODELS.find((m) => m.id === "haiku")?.contextWindow, 200_000);
	assert.equal(STATIC_MODELS.find((m) => m.id === "opus[1m]")?.contextWindow, 1_000_000);
});

test("discovered models: natively 1M ids are 1M bare, resolvedModel decides an alias, and the [1m] forms are added back", async () => {
	const discovered = [
		{ id: "default", name: "Default", resolvedModel: "claude-opus-5-5" },
		{ id: "opus", name: "Opus 5.5", resolvedModel: "claude-opus-5-5", efforts: ["low", "max"] },
		{ id: "claude-fable-5-1", name: "Fable 5.1", resolvedModel: "claude-fable-5-1", efforts: ["high"] },
		{ id: "best", name: "Best", resolvedModel: "claude-fable-5-1" },
		{ id: "haiku", name: "Haiku 4.5", resolvedModel: "claude-haiku-4-5-20251001" },
		{ id: "claude-sonnet-4-6", name: "Sonnet 4.6", resolvedModel: "claude-sonnet-4-6" },
	];
	const models = await refreshClaudeModels({ allowNetwork: true, signal: new AbortController().signal }, async () => discovered);
	assert.deepEqual(models.map((m) => [m.id, m.name, m.contextWindow]), [
		["opus", "Opus 5.5", 1_000_000],
		["opus[1m]", "Opus 5.5 (1M context)", 1_000_000],
		["claude-fable-5-1", "Fable 5.1", 1_000_000],
		["claude-fable-5-1[1m]", "Fable 5.1 (1M context)", 1_000_000],
		["best", "Best", 1_000_000],
		["haiku", "Haiku 4.5", 200_000],
		["claude-sonnet-4-6", "Sonnet 4.6", 200_000],
	]);
	assert.deepEqual(models.find((m) => m.id === "opus[1m]")?.thinkingLevelMap, models.find((m) => m.id === "opus")?.thinkingLevelMap, "the variant keeps the base's efforts");
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
