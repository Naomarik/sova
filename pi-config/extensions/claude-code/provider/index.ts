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
 * Flag off registers nothing at all. Registration is never undone: Sova
 * shares one ModelRuntime across sessions, so unregistering for a later
 * flag-off session would break a session already streaming through it.
 */
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import { claudeContextWindow, claudeModel, claudeName, claudeRegistered, isClaudeIdShape, resolveClaude } from "../catalog.ts";
import { claudeStateRoot, loadClaudeModels, watchClaudeModelsFile } from "../catalog-store.ts";
import { CLAUDE_LOGIN_ENTRY, hostLogins, loginContextFromEnv, recordedLogin } from "../accounts.ts";
import { registerAutoCompact } from "./auto-compact.ts";
import { CLAUDE_LOGIN_COMMAND, pickChatLogin } from "./login-command.ts";
import { getSessionBridge } from "./session-bridge.ts";
import { createClaudeStreamSimple } from "./stream.ts";
import type { ClaudeSessionBridge } from "./types.ts";

export const CLAUDE_PROVIDER_FLAG = "claude-code-provider";
/**
 * One more model id to register beside the catalog: a Claude worker started on an id the catalog
 * doesn't know yet (§app.claude-code-provider/catalog: still used, never refused). Workers only.
 */
export const CLAUDE_MODEL_FLAG = "claude-code-model";
export const CLAUDE_PROVIDER_ID = "claude-code-cli";
/** Required by registerProvider, never dialled: the CLI is a local process. */
export const CLAUDE_PROVIDER_BASE_URL = "claude-code-cli://local";
/** registerProvider throws without a key; a literal resolves as configured. */
export const CLAUDE_PROVIDER_API_KEY = "unused";

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

/** The catalog's output cap; 64k for an id it doesn't know. */
function maxTokensFor(id: string): number {
	return resolveClaude(id)?.maxOutput ?? 64_000;
}

/** One model definition: a catalog entry's, or (tests) any id's. */
export function toProviderModel(model: { id: string; name: string; efforts?: readonly string[]; resolvedModel?: string }): ProviderModelConfig {
	const efforts = [...(model.efforts ?? claudeModel(model.id)?.efforts ?? [])];
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
		contextWindow: claudeContextWindow(model.id, model.resolvedModel),
		maxTokens: maxTokensFor(model.id),
	};
}

/**
 * What this process has registered, shared by every copy of this module (a chat's extension load and a
 * worker's are separate instances): the list as last registered, and the ids a worker named that the
 * catalog doesn't offer. Exported for tests, which delete it to start a fresh process.
 */
export const REGISTERED_MARKER = Symbol.for("sova.claude-code.provider-registered");
interface ProviderRegistration {
	/** The registered ids, joined: a session whose list differs registers again. */
	registered?: string;
	/** Shape-valid ids a worker asked for (CLAUDE_MODEL_FLAG), kept for the life of the process. */
	extras: Set<string>;
	/** Registers the provider through the newest session's API, when the list differs. */
	register?: () => void;
	/** The watch on the learned list, started once per process. */
	stopWatch?: () => void;
}
function registration(): ProviderRegistration {
	const host = globalThis as unknown as Record<symbol, ProviderRegistration | undefined>;
	return (host[REGISTERED_MARKER] ??= { extras: new Set() });
}

/**
 * The provider's models now: Sova's Claude catalog as this process knows it (catalog.ts,
 * §app.claude-code-provider/catalog), one model per real model, with no aliases and no `[1m]` forms,
 * a model Claude Code dropped (an old chat still opens on it; the pickers filter it out), plus any id
 * a worker named. Read on every call, so a model learned while the process runs is here
 * with no restart. No subprocess runs, ever.
 */
export function providerModels(): ProviderModelConfig[] {
	const models = claudeRegistered().map((m) => toProviderModel(m));
	for (const extra of registration().extras) {
		if (!models.some((m) => m.id === extra)) models.push(toProviderModel({ id: extra, name: claudeName(extra) ?? extra }));
	}
	return models;
}

/** Keep a worker's model id (CLAUDE_MODEL_FLAG): a shape-valid id the catalog doesn't offer. */
function noteExtraModel(extra: unknown): void {
	if (typeof extra === "string" && isClaudeIdShape(extra) && !claudeRegistered().some((m) => m.id === extra)) registration().extras.add(extra);
}

/** The catalog, for pi's refreshModels: the same list online and offline. */
export async function refreshClaudeModels(_context: { allowNetwork: boolean; signal: AbortSignal }): Promise<ProviderModelConfig[]> {
	return providerModels();
}

/**
 * Registration is process-wide, not per session: Sova shares one ModelRuntime across every hosted
 * session, so a later session whose flag is off must never rip the provider out from under a session
 * that is mid-turn on it. It stays registered until the process exits (a `/reload` rebuilds the
 * extension runtime anyway).
 *
 * A session registers again only when its list differs from the one registered: a chat process
 * warms the provider up before its first session, so a worker's own id (CLAUDE_MODEL_FLAG) always
 * arrives after that first registration. True when this session must register.
 */
function needsRegistering(): boolean {
	const state = registration();
	const ids = providerModels().map((m) => m.id).join("\n");
	if (state.registered === ids) return false;
	state.registered = ids;
	return true;
}

/**
 * Register the flag at load and the provider at session_start, but only when
 * `--claude-code-provider` is on. Flag off registers nothing at all.
 */
export function registerProviderIfEnabled(pi: ExtensionAPI, bridge: ClaudeSessionBridge): void {
	pi.registerFlag(CLAUDE_PROVIDER_FLAG, {
		type: "boolean",
		default: false,
		description: "Expose the local Claude Code CLI as pi models (experimental)",
	});
	pi.registerFlag(CLAUDE_MODEL_FLAG, {
		type: "string",
		description: "A Claude model id to offer beside Sova's catalog (a worker's id the catalog doesn't know yet)",
	});
	// session_start is the first point where the caller's flag value is visible.
	pi.on("session_start", (_event, ctx) => {
		if (pi.getFlag(CLAUDE_PROVIDER_FLAG) !== true) return;
		// Before the registration guard on purpose: registration happens once per
		// process, but every session must record its own directory, and later
		// sessions would be skipped by the early return below.
		const sessionId = ctx?.sessionManager?.getSessionId?.();
		if (sessionId && ctx?.cwd) bridge.setSessionCwd?.(sessionId, ctx.cwd);
		// The login this session last ran on (so a restarted child keeps it), and where a change of
		// login is recorded: a hidden `claude-login` entry, which Sova shows as a note on a switch.
		if (sessionId) {
			let branch: readonly unknown[] = [];
			try { branch = ctx?.sessionManager?.getBranch?.() ?? []; } catch { /* no branch yet */ }
			bridge.setSessionLogin?.(sessionId, recordedLogin(branch), (entry) => {
				try { pi.appendEntry(CLAUDE_LOGIN_ENTRY, entry); } catch { /* plumbing: the next spawn still selects */ }
				// A failover warns; the user's own pick is its note row only.
				if (entry.text && entry.reason !== "manual") { try { ctx?.ui?.notify?.(entry.text, "warning"); } catch { /* no UI */ } }
			});
		}
		noteExtraModel(pi.getFlag(CLAUDE_MODEL_FLAG));
		const state = registration();
		const root = claudeStateRoot();
		loadClaudeModels(root);
		state.register = () => {
			if (!needsRegistering()) return;
			try {
				pi.registerProvider(CLAUDE_PROVIDER_ID, {
					name: "Claude Code CLI",
					baseUrl: CLAUDE_PROVIDER_BASE_URL,
					apiKey: CLAUDE_PROVIDER_API_KEY,
					api: CLAUDE_PROVIDER_ID,
					models: providerModels(),
					refreshModels: refreshClaudeModels,
					streamSimple: createClaudeStreamSimple(bridge),
				});
			} catch (err) {
				// This session's API has gone (a throwaway warm-up): the next session registers, and a
				// host's own watch refreshes the runtime meanwhile.
				state.registered = undefined;
				if (!state.stopWatch) throw err;
			}
		};
		state.register();
		// A model learned while this process runs (a host's own watch does the same for its runtime).
		state.stopWatch ??= watchClaudeModelsFile(root, () => {
			loadClaudeModels(root);
			state.register?.();
		});
	});
	// Move this chat to another Claude login (§app.claude-logins/switch-login). Sova's composer calls
	// the handler directly; its argument is a login id. A host with no commands (a test double)
	// gets the provider alone.
	if (typeof pi.registerCommand === "function") pi.registerCommand(CLAUDE_LOGIN_COMMAND, {
		description: "Move this chat to another Claude login: /claude-login <login id>",
		handler: async (args, ctx) => {
			if (pi.getFlag(CLAUDE_PROVIDER_FLAG) !== true) throw new Error("Claude Code models are off: this pi runs without --claude-code-provider.");
			let branch: readonly unknown[] = [];
			try { branch = ctx.sessionManager.getBranch(); } catch { /* no branch yet */ }
			await pickChatLogin(args, { id: ctx.sessionManager.getSessionId(), branch }, { bridge, logins: hostLogins() });
		},
	});
	// The provider stays registered, but this session's CLI child must not.
	pi.on("session_shutdown", (_event, ctx) => {
		// Hosts and test harnesses may call the hook without a session context.
		const sessionId = ctx?.sessionManager?.getSessionId?.();
		if (sessionId) void bridge.disposeSession?.(sessionId);
	});
	// Compact before a restart would have to clip history (auto-compact.ts).
	registerAutoCompact(pi, CLAUDE_PROVIDER_ID, () => pi.getFlag(CLAUDE_PROVIDER_FLAG) === true);
}

/**
 * The extension's single entry point: one import and one call in index.ts.
 * The bridge is the process-global one; constructing it only creates the
 * registry and its exit hooks, so no CLI process starts at extension load.
 */
export function registerClaudeCodeProvider(pi: ExtensionAPI): void {
	// A Sova chat process carries its project's login (SOVA_CLAUDE_LOGIN_CONTEXT); a terminal session carries none.
	registerProviderIfEnabled(pi, getSessionBridge({ logins: hostLogins(), loginContext: () => loginContextFromEnv() }));
}
