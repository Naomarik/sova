/**
 * A fork's prompt-cache identity: the one place that decides which cache a fork asks for, used by
 * every fork there is — Sova's "Fork from here" (a new visible session, hosted in the server) and
 * the background forks (`./background.ts`: /explain's worker, a separate pi process).
 *
 * A fork has its own session id, and pi keys a request's cache by it (`prompt_cache_key`, and on
 * Codex the `session-id` affinity header). Left alone, a fork's first request lands in a cold cache
 * shard even though its prefix is byte-identical to the parent's warm one. So a fork records the
 * key it inherits as non-context session metadata (`FORK_CACHE_ENTRY`, in the fork only), and its
 * requests ask for that key instead of their own:
 *
 *  - every OpenAI-style provider: `forkCacheExtension` replaces the SDK's default key;
 *  - Codex also routes by the `session-id` header, which the provider sets after every header
 *    hook, so it is rewritten at the request itself: in a hosted session by
 *    `applyForkCacheRouting` (an isolated SSE request, never the parent's WebSocket in the same
 *    process), in a dedicated child process by `routeProcessForkCache` (its own fetch and
 *    WebSocket, which no other session shares).
 *
 * Builtins only at runtime (the pi imports are types): Sova's server imports this file.
 */
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Session metadata only: never a model message or a new conversation/transport identity. */
export const FORK_CACHE_ENTRY = "sova-fork-cache";
export interface ForkCacheData {
	v: 1;
	key: string;
}
type Entry = { type?: string; customType?: string; data?: unknown };

// OpenAI-compatible cache keys have a 64-character limit. Count Unicode characters, not UTF-16
// units, just as the SDK does when generating a key from a session id.
export const cacheKey = (key: string): string => Array.from(key).slice(0, 64).join("");

/** Read immutable session lineage from the whole file, not the current branch: a rewind does
 * not turn this conversation into a different cache shard. No filesystem access is needed. */
export function inheritedCacheKey(entries: readonly Entry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.customType !== FORK_CACHE_ENTRY) continue;
		const data = entry.data;
		if (!data || typeof data !== "object" || Array.isArray(data)) continue;
		const value = data as Partial<ForkCacheData>;
		if (value.v === 1 && typeof value.key === "string" && value.key.length > 0) return cacheKey(value.key);
	}
	return undefined;
}

export function forkCacheData(sourceId: string, entries: readonly Entry[]): ForkCacheData {
	return { v: 1, key: inheritedCacheKey(entries) ?? cacheKey(sourceId) };
}

/** The metadata entry a fork records, parented on the fork's last copied entry. */
export function forkCacheEntry(id: string, parentId: string | null, sourceId: string, sourceEntries: readonly Entry[], now = new Date()) {
	return { type: "custom", id, parentId, timestamp: now.toISOString(), customType: FORK_CACHE_ENTRY, data: forkCacheData(sourceId, sourceEntries) };
}

/** Replace only the SDK's default key, never an explicit different override. In particular,
 * do not add a field to providers that omit it, or alter WebSocket/session-affinity identity. */
export function withForkCacheKey(payload: unknown, ownId: string, inherited: string | undefined): unknown {
	if (!inherited || !payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const body = payload as Record<string, unknown>;
	if (body.prompt_cache_key !== cacheKey(ownId) || body.prompt_cache_key === inherited) return undefined;
	return { ...body, prompt_cache_key: inherited };
}

/** A session's request hook; adds no tools and changes no prompt sections. */
export function forkCacheExtension(pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event, ctx) => {
		const ownId = ctx.sessionManager.getSessionId();
		if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload) ||
			(event.payload as Record<string, unknown>).prompt_cache_key !== cacheKey(ownId)) return undefined;
		return withForkCacheKey(event.payload, ownId, inheritedCacheKey(ctx.sessionManager.getEntries()));
	});
}

/**
 * The key a fork's Codex requests route under, or undefined: nothing inherited, the fork's own
 * key, or a legacy/custom id that is valid in a JSON cache key but not as an HTTP header value
 * (such a source must not turn into a failed request when the fork has its own valid id).
 */
export function affinityKey(entries: readonly Entry[], ownId: string): string | undefined {
	const key = inheritedCacheKey(entries);
	if (!key || key === cacheKey(ownId) || /[^\x20-\x7e]/.test(key)) return undefined;
	return key;
}

/** The request's headers with the fork's own `session-id` replaced by `key`; undefined when the
 * request carries some other session id (or none), which is left exactly as it is. */
export function withAffinityHeader(headers: HeadersInit | undefined, ownId: string, key: string): Headers | undefined {
	const out = new Headers(headers);
	if (out.get("session-id") !== cacheKey(ownId)) return undefined;
	out.set("session-id", key);
	return out;
}

/** Codex also routes cache affinity through its final HTTP session-id header. Keep the Agent's
 * own id (including the SDK's cache-warmer ownership check), but use an isolated SSE request
 * with inherited HTTP affinity. Never share the parent's stateful WebSocket continuation: in a
 * hosted session the parent may live in the same process. */
export function applyForkCacheRouting(session: AgentSession): void {
	const original = session.agent.streamFunction.bind(session.agent);
	session.agent.streamFunction = (model, context, options) => {
		if (model.api !== "openai-codex-responses" || options?.cacheRetention === "none" || options?.sessionId !== session.sessionId)
			return original(model, context, options);
		const key = affinityKey(session.sessionManager.getEntries(), session.sessionId);
		if (!key) return original(model, context, options);
		const fetch = options.fetch ?? globalThis.fetch;
		return original(model, context, {
			...options,
			transport: "sse",
			fetch: (input, init) => {
				const headers = withAffinityHeader(init?.headers ?? (input instanceof Request ? input.headers : undefined), session.sessionId, key);
				return fetch(input, headers ? { ...init, headers } : init);
			},
		});
	};
}

/** What `routeProcessForkCache` needs to know about the process's one session, read per request. */
export interface ForkProcessState {
	ownId: string;
	entries: readonly Entry[];
}

const PROCESS_ROUTED = Symbol.for("sova.fork-cache.process-routed");

/**
 * `applyForkCacheRouting` for a process that runs one fork and nothing else (a background fork's
 * pi child), where no extension can reach the Agent's stream function: the same header rewrite,
 * applied to the process's own `fetch` (Codex over SSE) and `WebSocket` (Codex's default
 * transport). Nothing is shared with the parent: the WebSocket and any continuation on it belong
 * to this process. Only a request already carrying this session's own `session-id` changes, so
 * every other request is untouched. Installs once per process.
 */
export function routeProcessForkCache(state: () => ForkProcessState | undefined, scope: typeof globalThis = globalThis): void {
	const host = scope as typeof globalThis & { [PROCESS_ROUTED]?: true };
	if (host[PROCESS_ROUTED]) return;
	host[PROCESS_ROUTED] = true;
	const rewrite = (headers: HeadersInit | undefined): Headers | undefined => {
		const current = state();
		const key = current && affinityKey(current.entries, current.ownId);
		return key ? withAffinityHeader(headers, current.ownId, key) : undefined;
	};
	const fetch = host.fetch;
	if (typeof fetch === "function") {
		host.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const headers = rewrite(init?.headers ?? (input instanceof Request ? input.headers : undefined));
			return fetch(input, headers ? { ...init, headers } : init);
		}) as typeof fetch;
	}
	const WebSocket = host.WebSocket as unknown as (new (url: string | URL, options?: unknown) => object) | undefined;
	if (typeof WebSocket === "function") {
		host.WebSocket = class extends WebSocket {
			constructor(url: string | URL, options?: unknown) {
				const init = options && typeof options === "object" && !Array.isArray(options) ? (options as { headers?: HeadersInit }) : undefined;
				const headers = init?.headers ? rewrite(init.headers) : undefined;
				super(url, headers ? { ...init, headers: Object.fromEntries(headers) } : options);
			}
		} as unknown as typeof globalThis.WebSocket;
	}
}
