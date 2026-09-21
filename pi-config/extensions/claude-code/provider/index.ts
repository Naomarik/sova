/**
 * Opt-in registration of the Claude Code CLI as a first-class pi provider.
 *
 * Flag timing (verified against pi 0.86.1's extension loader): a caller's flag
 * values are written into the extension runtime AFTER every extension factory
 * has run — `createAgentSessionServices` flushes the factory's pending provider
 * registrations and only then calls `applyExtensionFlagValues`, and
 * `AgentSession._buildRuntime` applies `options.flagValues` just before the
 * extension runner is built. At factory time `pi.getFlag` therefore only ever
 * reports the registered default. Registration consequently happens from
 * `session_start`, which runs after both paths have written the real value.
 * Flag off registers nothing at all; a reload that turns it off unregisters.
 */
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import { discoverClaudeModels } from "../models.ts";
import type { BackendModel } from "../../subagents/contracts.ts";
import { createClaudeStreamSimple } from "./stream.ts";
import type { ClaudeSessionBridge } from "./types.ts";

export const CLAUDE_PROVIDER_FLAG = "claude-code-provider";
export const CLAUDE_PROVIDER_ID = "claude-code-cli";
/** Required by registerProvider, never dialled: the CLI is a local process. */
export const CLAUDE_PROVIDER_BASE_URL = "claude-code-cli://local";
/** registerProvider throws without a key; a literal resolves as configured. */
export const CLAUDE_PROVIDER_API_KEY = "unused";

/** The CLI's own `--effort` ladder, as reported by its initialize response. */
const CLI_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** pi's thinking ladder mapped onto `--effort`; unsupported levels are null. */
function thinkingLevelMap(efforts: readonly string[]): ThinkingLevelMap {
	const has = (effort: string) => (efforts.includes(effort) ? effort : null);
	return {
		// The CLI has no "minimal"; its lowest effort is "low".
		minimal: null,
		low: has("low"),
		medium: has("medium"),
		high: has("high"),
		xhigh: has("xhigh"),
		max: has("max"),
	};
}

/** `[1m]`-suffixed CLI aliases are the 1M-context variants. */
export function contextWindowFor(id: string): number {
	return id.endsWith("[1m]") ? 1_000_000 : 200_000;
}

function maxTokensFor(id: string): number {
	return id.startsWith("haiku") ? 32_000 : 64_000;
}

/** One model definition, shared by the static list and refreshModels. */
export function toProviderModel(model: { id: string; name: string; efforts?: string[] }): ProviderModelConfig {
	const efforts = model.efforts ?? [];
	return {
		id: model.id,
		name: model.name,
		// Only models whose initialize entry offers effort levels expose thinking.
		reasoning: efforts.length > 0,
		...(efforts.length > 0 ? { thinkingLevelMap: thinkingLevelMap(efforts) } : {}),
		input: ["text", "image"],
		// A subscription CLI turn has no per-token list price to report here.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// No promptCache on purpose: pi must not warm a cache it cannot address.
		contextWindow: contextWindowFor(model.id),
		maxTokens: maxTokensFor(model.id),
	};
}

/**
 * Baked-in catalog, matching the ids and names the installed CLI reports from
 * `initialize` (probed 2026-09-22, claude 2.1.276). No subprocess runs at load;
 * `refreshModels` replaces this with the live list when pi allows network work.
 * The `default` alias is deliberately left out: it silently changes model.
 */
export const STATIC_MODELS: ProviderModelConfig[] = [
	toProviderModel({ id: "claude-fable-5-1[1m]", name: "Fable", efforts: [...CLI_EFFORTS] }),
	toProviderModel({ id: "opus[1m]", name: "Opus (1M context)", efforts: [...CLI_EFFORTS] }),
	toProviderModel({ id: "sonnet", name: "Sonnet", efforts: [...CLI_EFFORTS] }),
	toProviderModel({ id: "haiku", name: "Haiku" }),
];

/** Live catalog from the installed CLI; falls back to the baked-in list. */
export async function refreshClaudeModels(context: { allowNetwork: boolean; signal: AbortSignal }): Promise<ProviderModelConfig[]> {
	// allowNetwork is false during offline startup; never spawn the CLI then.
	if (!context.allowNetwork) return STATIC_MODELS;
	let discovered: BackendModel[];
	try {
		discovered = await discoverClaudeModels(context.signal);
	} catch {
		return STATIC_MODELS; // Discovery failure must not empty the picker.
	}
	const models = discovered.filter((model) => model.id !== "default").map(toProviderModel);
	return models.length > 0 ? models : STATIC_MODELS;
}

/**
 * Register the provider when `--claude-code-provider` is on. Safe to call once
 * per extension load; the returned disposer unregisters (used on reload).
 */
export function registerProviderIfEnabled(pi: ExtensionAPI, bridge: ClaudeSessionBridge): void {
	pi.registerFlag(CLAUDE_PROVIDER_FLAG, {
		type: "boolean",
		default: false,
		description: "Expose the local Claude Code CLI as pi models (experimental)",
	});
	let registered = false;
	const sync = (): void => {
		const enabled = pi.getFlag(CLAUDE_PROVIDER_FLAG) === true;
		if (enabled === registered) return;
		if (!enabled) {
			pi.unregisterProvider(CLAUDE_PROVIDER_ID);
			registered = false;
			return;
		}
		pi.registerProvider(CLAUDE_PROVIDER_ID, {
			name: "Claude Code CLI",
			baseUrl: CLAUDE_PROVIDER_BASE_URL,
			apiKey: CLAUDE_PROVIDER_API_KEY,
			api: CLAUDE_PROVIDER_ID,
			models: STATIC_MODELS,
			refreshModels: (context) => refreshClaudeModels(context),
			streamSimple: createClaudeStreamSimple(bridge),
		});
		registered = true;
	};
	// session_start is the first point where the caller's flag value is visible.
	pi.on("session_start", () => {
		sync();
	});
}
