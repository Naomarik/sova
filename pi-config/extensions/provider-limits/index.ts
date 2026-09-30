/**
 * Per-provider request limits (README.md). Every provider with a limit in
 * `<agent dir>/provider-limits.json` (defaults: zai 5, ollama-cloud 10) has its `streamSimple`
 * re-registered as a gated one (stream.ts): each model request claims one of the provider's slots on
 * this device before it is sent, and waits in the provider's queue while it is full. The limit
 * `claude-code` gates the Claude Code provider's streams (`claude-code-cli`).
 *
 * Registered at session_start and re-checked before each turn, so a limit set in Settings reaches
 * a provider this process had not gated yet. The limit itself is read at each request (gate.ts).
 *
 * A session's own turns are interactive; a pi worker's (worker-mark answers the subagents role
 * event) and every request not made by a registered session are background. While a session's
 * request waits, its status bar says so.
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getApiProvider, type Api, type Model } from "@earendil-works/pi-ai";
import { WORKER_ROLE_DISCOVER_EVENT, WORKER_ROLE_EVENT } from "../mode/events.ts";
import { limitsInEffect, registerSession, unregisterSession, validProviderId, waitingText, type RequestKind } from "./gate.ts";
import { gateStreamSimple, type StreamSimple } from "./stream.ts";

export const STATUS_KEY = "provider-limits";
/** The limit key `claude-code` covers the pi provider the claude-code extension registers. */
export const CLAUDE_LIMIT_KEY = "claude-code";
export const CLAUDE_PI_PROVIDER = "claude-code-cli";

const GATED = Symbol.for("sova.provider-limits.gated");
type Gated = StreamSimple & { [GATED]?: string };

interface Registry {
	getAll(): Model<Api>[];
	getRegisteredProviderConfig(provider: string): { api?: Api; streamSimple?: StreamSimple } | undefined;
}

/** The pi provider a limit key gates. */
export const piProviderOf = (limitKey: string): string => (limitKey === CLAUDE_LIMIT_KEY ? CLAUDE_PI_PROVIDER : limitKey);

/** The api most of the provider's models use (the one a registered streamSimple serves). */
function mainApi(models: Model<Api>[]): Api | undefined {
	const counts = new Map<Api, number>();
	for (const m of models) counts.set(m.api, (counts.get(m.api) ?? 0) + 1);
	return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * Wrap every limited provider this runtime knows that isn't wrapped yet. Returns the pi providers
 * it (re)registered. A provider another extension registered a stream for keeps that stream, gated.
 */
export function applyGates(pi: Pick<ExtensionAPI, "registerProvider">, registry: Registry, agentDir: () => string): string[] {
	const done: string[] = [];
	const limits = limitsInEffect(agentDir());
	let models: Model<Api>[] | null = null;
	for (const limitKey of Object.keys(limits)) {
		if (!validProviderId(limitKey)) continue;
		const provider = piProviderOf(limitKey);
		let existing: ReturnType<Registry["getRegisteredProviderConfig"]>;
		try {
			existing = registry.getRegisteredProviderConfig(provider);
		} catch {
			existing = undefined;
		}
		if ((existing?.streamSimple as Gated | undefined)?.[GATED]) continue;
		models ??= registry.getAll();
		const own = models.filter((m) => m.provider === provider);
		const api = existing?.api ?? mainApi(own);
		if (!api || own.length === 0) continue;
		const inner: StreamSimple =
			existing?.streamSimple && existing.api === api
				? existing.streamSimple
				: (model, context, options) => {
						const streams = getApiProvider(model.api);
						if (!streams) throw new Error(`No API provider registered for api: ${model.api}`);
						return streams.streamSimple(model, context, options);
					};
		const gated: Gated = gateStreamSimple(inner, { provider: limitKey, agentDir, retry: limitKey !== CLAUDE_LIMIT_KEY });
		gated[GATED] = limitKey;
		try {
			pi.registerProvider(provider, { api, streamSimple: gated });
			done.push(provider);
		} catch {
			// A provider pi won't let us re-register stays ungated rather than broken.
		}
	}
	return done;
}

export default function providerLimitsExtension(pi: ExtensionAPI): void {
	const agentDir = () => getAgentDir();
	let kind: RequestKind = "interactive";
	try {
		// worker-mark loads first in every pi worker and answers this at once.
		pi.events?.on(WORKER_ROLE_EVENT, (data: unknown) => {
			if ((data as { version?: unknown } | null)?.version === 1) kind = "background";
		});
		pi.events?.emit(WORKER_ROLE_DISCOVER_EVENT, { version: 1 });
	} catch {
		// No event bus: a session of its own.
	}

	const register = (ctx: ExtensionContext) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return;
		registerSession(sessionId, kind, (info) => {
			try {
				ctx.ui.setStatus(STATUS_KEY, info ? waitingText(info) : undefined);
			} catch {
				// No UI (print mode): nothing to say it on.
			}
		});
	};
	const gate = (ctx: ExtensionContext) => {
		try {
			applyGates(pi, ctx.modelRegistry as unknown as Registry, agentDir);
		} catch {
			// Best effort: an ungated provider behaves as it always did.
		}
	};

	pi.on("session_start", (_event, ctx) => {
		register(ctx);
		gate(ctx);
	});
	pi.on("before_agent_start", (_event, ctx) => {
		register(ctx);
		gate(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		const sessionId = ctx?.sessionManager?.getSessionId?.();
		if (sessionId) unregisterSession(sessionId);
	});
}
