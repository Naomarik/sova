import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { normalizeEntries } from "./transcript";
import { applyForkCacheRouting, FORK_CACHE_ENTRY, forkCacheData, forkCacheExtension, inheritedCacheKey, withForkCacheKey } from "./session-fork-cache";

const entry = (key: string, v = 1) => ({ type: "custom", customType: FORK_CACHE_ENTRY, data: { v, key } });

test("cache lineage chooses the newest valid record, otherwise the source identity", () => {
  assert.deepEqual(forkCacheData("source", []), { v: 1, key: "source" });
  const entries = [entry("root"), entry("later"), entry("", 1), entry("wrong-version", 2), { ...entry("ignored"), data: null }];
  assert.equal(inheritedCacheKey(entries), "later");
  assert.deepEqual(forkCacheData("child", entries), { v: 1, key: "later" });
  assert.equal(inheritedCacheKey([{ ...entry("ignored"), type: "custom_message" }]), undefined);
  assert.equal(inheritedCacheKey([{ ...entry("ignored"), data: [] }]), undefined);
});

test("cache keys use the SDK's 64 Unicode-character limit", () => {
  const long = "🦉".repeat(70);
  assert.equal(Array.from(forkCacheData(long, []).key).length, 64);
  assert.equal(inheritedCacheKey([entry(long)]), "🦉".repeat(64));
  assert.deepEqual(withForkCacheKey({ prompt_cache_key: "🦉".repeat(64) }, long, "root"), { prompt_cache_key: "root" });
});

test("only the automatically generated key changes; identity, content and transport fields do not", () => {
  const messages = [{ role: "user", content: "unchanged prefix" }];
  const tools = [{ name: "read", description: "unchanged tool" }];
  const body = { prompt_cache_key: "child", messages, tools, session_id: "child", previous_response_id: "child-response", unrelated: true };
  const rewritten = withForkCacheKey(body, "child", "root") as typeof body;
  assert.deepEqual(rewritten, { ...body, prompt_cache_key: "root" });
  assert.equal(rewritten.messages, messages);
  assert.equal(rewritten.tools, tools);
  assert.equal(body.prompt_cache_key, "child", "the incoming request is not mutated");
  assert.equal(withForkCacheKey({ prompt_cache_key: "explicit-override" }, "child", "root"), undefined);
  assert.equal(withForkCacheKey({ prompt_cache_key: "root" }, "child", "root"), undefined);
  assert.equal(withForkCacheKey({ messages }, "child", "root"), undefined, "no unsupported key is added to Zai");
  assert.equal(withForkCacheKey({ prompt_cache_key: undefined }, "child", "root"), undefined, "cache-disabled requests stay disabled");
  for (const body of [null, [], 1, "text"]) assert.equal(withForkCacheKey(body, "child", "root"), undefined);
  assert.equal(withForkCacheKey({ prompt_cache_key: "child" }, "child", undefined), undefined);
});

test("the extension registers only a payload hook and reads session lineage independently of rewinds", () => {
  let handler: ((event: { payload: unknown }, ctx: any) => unknown) | undefined;
  const registrations: string[] = [];
  forkCacheExtension({ on(name: string, fn: typeof handler) { registrations.push(name); handler = fn; } } as never);
  assert.deepEqual(registrations, ["before_provider_request"], "no prompt or tool declaration hook");
  const ctx = { sessionManager: { getSessionId: () => "child", getEntries: () => [entry("root")], getBranch: () => { throw new Error("branch-local lineage would break after rewind"); } } };
  assert.deepEqual(handler!({ payload: { prompt_cache_key: "child", input: [] } }, ctx), { prompt_cache_key: "root", input: [] });
  assert.equal(handler!({ payload: { input: [] } }, ctx), undefined);
  assert.equal(handler!({ payload: { prompt_cache_key: "ordinary" } }, { sessionManager: { getSessionId: () => "ordinary", getEntries: () => [] } }), undefined);
});

test("Codex routing preserves the SDK ownership id, isolates transport, and rewrites only HTTP cache affinity", async () => {
  let seen: any;
  let captured: Headers | undefined;
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    captured = new Headers(init?.headers);
    return new Response("ok");
  };
  const session = {
    sessionId: "child",
    sessionManager: { getEntries: () => [entry("root")] },
    agent: { sessionId: "child", transport: "auto", streamFunction: (model: any, context: any, options: any) => { seen = { model, context, options }; return {} as never; } },
  };
  applyForkCacheRouting(session as never);
  const context = { messages: [{ role: "user", content: "own conversation" }] };
  const options = { sessionId: "child", transport: "auto", fetch };
  session.agent.streamFunction({ api: "openai-codex-responses" }, context, options);
  assert.equal(seen.context, context);
  assert.equal(seen.options.sessionId, "child", "the SDK cache-warmer ownership check still matches this session");
  assert.equal(seen.options.transport, "sse", "no parent WebSocket or continuation state is shared");
  assert.equal(session.agent.sessionId, "child");
  assert.equal(session.agent.transport, "auto", "the Agent's configured transport is not overwritten");
  assert.equal(options.transport, "auto", "incoming options are unchanged");
  const inputHeaders = new Headers({ "session-id": "child", "x-client-request-id": "child", authorization: "synthetic-test-auth" });
  await seen.options.fetch("https://example.invalid", { headers: inputHeaders });
  assert.equal(captured!.get("session-id"), "root");
  assert.equal(captured!.get("x-client-request-id"), "child", "request tracing identity stays independent");
  assert.equal(captured!.get("authorization"), "synthetic-test-auth");
  assert.equal(inputHeaders.get("session-id"), "child", "final incoming headers are not mutated");
  await seen.options.fetch("https://example.invalid", { headers: { "session-id": "explicit-other" } });
  assert.equal(captured!.get("session-id"), "explicit-other");
});

test("non-Codex, ordinary, cache-disabled and explicitly routed requests retain their original stream options", () => {
  let entries = [entry("root")];
  let seen: any;
  const session = { sessionId: "child", sessionManager: { getEntries: () => entries }, agent: { streamFunction: (_model: any, _context: any, options: any) => { seen = options; return {} as never; } } };
  applyForkCacheRouting(session as never);
  const opts = { sessionId: "child", transport: "auto" };
  session.agent.streamFunction({ api: "openai-completions" }, {}, opts);
  assert.equal(seen, opts, "Zai gets no additional routing or transport fields");
  const disabled = { ...opts, cacheRetention: "none" };
  session.agent.streamFunction({ api: "openai-codex-responses" }, {}, disabled);
  assert.equal(seen, disabled);
  const explicit = { ...opts, sessionId: "explicit-other" };
  session.agent.streamFunction({ api: "openai-codex-responses" }, {}, explicit);
  assert.equal(seen, explicit);
  entries = [entry("invalid\nheader")];
  session.agent.streamFunction({ api: "openai-codex-responses" }, {}, opts);
  assert.equal(seen, opts, "a JSON-only legacy cache key cannot cause an HTTP header exception");
  entries = [];
  session.agent.streamFunction({ api: "openai-codex-responses" }, {}, opts);
  assert.equal(seen, opts, "parent requests retain their own WebSocket routing");
});

test("cache metadata creates neither model context nor a transcript notice", () => {
  const entries: any[] = [
    { type: "session", version: 3, id: "child", timestamp: new Date(0).toISOString(), cwd: "/tmp/fork" },
    { type: "message", id: "u1", parentId: null, timestamp: new Date(0).toISOString(), message: { role: "user", content: "hello", timestamp: 0 } },
    { ...entry("root"), id: "cache", parentId: "u1", timestamp: new Date(0).toISOString() },
  ];
  const manager = SessionManager.inMemory("/tmp/fork", undefined, entries);
  assert.deepEqual(manager.buildSessionProjection().messages.map(m => m.role), ["user"]);
  assert.deepEqual(normalizeEntries(entries).map(row => row.kind), ["user"]);
  assert.equal(manager.getSessionId(), "child", "cache affinity is not the conversation id");
});
