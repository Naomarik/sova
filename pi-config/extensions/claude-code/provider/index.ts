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
import { claudeContextWindow, claudeModel, claudeOffer, resolveClaude } from "../catalog.ts";
import { CLAUDE_LOGIN_ENTRY, hostLogins, recordedLogin } from "../accounts.ts";
import { registerAutoCompact } from "./auto-compact.ts";
import { CLAUDE_LOGIN_COMMAND, pickChatLogin } from "./login-command.ts";
import { getSessionBridge } from "./session-bridge.ts";
import { createClaudeStreamSimple } from "./stream.ts";
import type { ClaudeSessionBridge } from "./types.ts";

export const CLAUDE_PROVIDER_FLAG = "claude-code-provider";
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
 * Sova's Claude catalog (catalog.ts, §app.claude-code-provider/catalog): one model per real model,
 * named as the CLI names it, with no aliases and no `[1m]` forms. No subprocess runs, ever: the CLI's
 * own list never adds, removes or renames one.
 */
export const STATIC_MODELS: ProviderModelConfig[] = claudeOffer().map((m) => toProviderModel(m));

/** The catalog, for pi's refreshModels: the same list online and offline. */
export async function refreshClaudeModels(_context: { allowNetwork: boolean; signal: AbortSignal }): Promise<ProviderModelConfig[]> {
	return STATIC_MODELS;
}

/**
 * Registration is process-wide, not per session: Sova shares one
 * ModelRuntime across every hosted session, so a later session whose flag is
 * off must never rip the provider out from under a session that is mid-turn
 * on it. Once registered it stays registered until the process exits (a
 * `/reload` rebuilds the extension runtime anyway). Exported for tests.
 */
export const REGISTERED_MARKER = Symbol.for("sova.claude-code.provider-registered");

function alreadyRegistered(): boolean {
	const host = globalThis as unknown as Record<symbol, boolean | undefined>;
	if (host[REGISTERED_MARKER]) return true;
	host[REGISTERED_MARKER] = true;
	return false;
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
		if (alreadyRegistered()) return;
		pi.registerProvider(CLAUDE_PROVIDER_ID, {
			name: "Claude Code CLI",
			baseUrl: CLAUDE_PROVIDER_BASE_URL,
			apiKey: CLAUDE_PROVIDER_API_KEY,
			api: CLAUDE_PROVIDER_ID,
			models: STATIC_MODELS,
			refreshModels: (context) => refreshClaudeModels(context),
			streamSimple: createClaudeStreamSimple(bridge),
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
	registerProviderIfEnabled(pi, getSessionBridge({ logins: hostLogins() }));
}
