import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Session metadata only: never a model message or a new conversation/transport identity. */
export const FORK_CACHE_ENTRY = "sova-fork-cache";
export interface ForkCacheData { v: 1; key: string }
type Entry = { type?: string; customType?: string; data?: unknown };

// OpenAI-compatible cache keys have a 64-character limit. Count Unicode characters, not UTF-16
// units, just as the SDK does when generating a key from a session id.
const cacheKey = (key: string): string => Array.from(key).slice(0, 64).join("");

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

/** Replace only the SDK's default key, never an explicit different override. In particular,
 * do not add a field to providers that omit it, or alter WebSocket/session-affinity identity. */
export function withForkCacheKey(payload: unknown, ownId: string, inherited: string | undefined): unknown {
  if (!inherited || !payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const body = payload as Record<string, unknown>;
  if (body.prompt_cache_key !== cacheKey(ownId) || body.prompt_cache_key === inherited) return undefined;
  return { ...body, prompt_cache_key: inherited };
}

/** Codex also routes cache affinity through its final HTTP session-id header. Keep the Agent's
 * own id (including the SDK's cache-warmer ownership check), but use an isolated SSE request
 * with inherited HTTP affinity. Never share the parent's stateful WebSocket continuation. */
export function applyForkCacheRouting(session: AgentSession): void {
  const original = session.agent.streamFunction.bind(session.agent);
  session.agent.streamFunction = (model, context, options) => {
    if (model.api !== "openai-codex-responses" || options?.cacheRetention === "none" || options?.sessionId !== session.sessionId)
      return original(model, context, options);
    const key = inheritedCacheKey(session.sessionManager.getEntries());
    // A legacy/custom id can be valid in a JSON cache key but not an HTTP header. Do not
    // turn such a source into a failed request when the fork has its own valid id.
    if (!key || key === cacheKey(session.sessionId) || /[^\x20-\x7e]/.test(key)) return original(model, context, options);
    const fetch = options.fetch ?? globalThis.fetch;
    return original(model, context, {
      ...options,
      transport: "sse",
      fetch: (input, init) => {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        if (headers.get("session-id") === cacheKey(session.sessionId)) headers.set("session-id", key);
        return fetch(input, { ...init, headers });
      },
    });
  };
}

/** An ordinary hosted session's request hook; adds no tools and changes no prompt sections. */
export function forkCacheExtension(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event, ctx) => {
    const ownId = ctx.sessionManager.getSessionId();
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload) ||
        (event.payload as Record<string, unknown>).prompt_cache_key !== cacheKey(ownId)) return undefined;
    return withForkCacheKey(event.payload, ownId, inheritedCacheKey(ctx.sessionManager.getEntries()));
  });
}
