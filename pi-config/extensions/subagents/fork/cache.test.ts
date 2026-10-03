/**
 * The fork cache identity every fork uses (cache.ts): Sova's "Fork from here" in the server and
 * the background forks' pi children. Run with the subagents runner (`node tests/run.mjs`).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	affinityKey,
	applyForkCacheRouting,
	FORK_CACHE_ENTRY,
	forkCacheData,
	forkCacheExtension,
	inheritedCacheKey,
	routeProcessForkCache,
	withAffinityHeader,
	withForkCacheKey,
} from "./cache.ts";
import { copyForFork } from "./copy.ts";

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
	forkCacheExtension({
		on(name: string, fn: typeof handler) {
			registrations.push(name);
			handler = fn;
		},
	} as never);
	assert.deepEqual(registrations, ["before_provider_request"], "no prompt or tool declaration hook");
	const ctx = {
		sessionManager: {
			getSessionId: () => "child",
			getEntries: () => [entry("root")],
			getBranch: () => {
				throw new Error("branch-local lineage would break after rewind");
			},
		},
	};
	assert.deepEqual(handler!({ payload: { prompt_cache_key: "child", input: [] } }, ctx), { prompt_cache_key: "root", input: [] });
	assert.equal(handler!({ payload: { input: [] } }, ctx), undefined);
	assert.equal(handler!({ payload: { prompt_cache_key: "ordinary" } }, { sessionManager: { getSessionId: () => "ordinary", getEntries: () => [] } }), undefined);
});

test("the affinity key is the inherited one, never the fork's own, and never one HTTP cannot carry", () => {
	assert.equal(affinityKey([entry("root")], "child"), "root");
	assert.equal(affinityKey([], "child"), undefined);
	assert.equal(affinityKey([entry("child")], "child"), undefined);
	assert.equal(affinityKey([entry("invalid\nheader")], "child"), undefined);
	assert.equal(affinityKey([entry("🦉")], "child"), undefined);
	assert.equal(withAffinityHeader({ "session-id": "child", "x-client-request-id": "child" }, "child", "root")?.get("session-id"), "root");
	assert.equal(withAffinityHeader({ "session-id": "child", "x-client-request-id": "child" }, "child", "root")?.get("x-client-request-id"), "child");
	assert.equal(withAffinityHeader({ "session-id": "explicit-other" }, "child", "root"), undefined);
	assert.equal(withAffinityHeader(undefined, "child", "root"), undefined);
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
		agent: {
			sessionId: "child",
			transport: "auto",
			streamFunction: (model: any, context: any, options: any) => {
				seen = { model, context, options };
				return {} as never;
			},
		},
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
	const session = {
		sessionId: "child",
		sessionManager: { getEntries: () => entries },
		agent: {
			streamFunction: (_model: any, _context: any, options: any) => {
				seen = options;
				return {} as never;
			},
		},
	};
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

test("a fork's own process routes its Codex requests on both transports, and only its own session's", async () => {
	const fetched: Headers[] = [];
	const sockets: { url: string; options: any }[] = [];
	class FakeSocket {
		constructor(url: string, options?: any) {
			sockets.push({ url, options });
		}
	}
	const scope = {
		fetch: async (_input: unknown, init?: RequestInit) => {
			fetched.push(new Headers(init?.headers));
			return new Response("ok");
		},
		WebSocket: FakeSocket,
	} as unknown as typeof globalThis;
	let state: { ownId: string; entries: any[] } | undefined;
	routeProcessForkCache(() => state, scope);
	const originalFetch = scope.fetch;
	routeProcessForkCache(() => undefined, scope);
	assert.equal(scope.fetch, originalFetch, "installs once per process");

	await scope.fetch("https://example.invalid", { headers: { "session-id": "child" } });
	assert.equal(fetched.at(-1)!.get("session-id"), "child", "before session_start nothing is known, nothing changes");
	state = { ownId: "child", entries: [entry("root")] };
	await scope.fetch("https://example.invalid", { headers: { "session-id": "child", "x-client-request-id": "child" } });
	assert.equal(fetched.at(-1)!.get("session-id"), "root");
	assert.equal(fetched.at(-1)!.get("x-client-request-id"), "child");
	await scope.fetch("https://example.invalid", { headers: { "session-id": "someone-else" } });
	assert.equal(fetched.at(-1)!.get("session-id"), "someone-else");
	await scope.fetch("https://example.invalid");
	assert.equal(fetched.at(-1)!.get("session-id"), null, "a request without the header gets none");

	new scope.WebSocket("wss://example.invalid", { headers: new Headers({ "session-id": "child", "x-client-request-id": "child" }) } as never);
	assert.equal(new Headers(sockets.at(-1)!.options.headers).get("session-id"), "root");
	assert.equal(new Headers(sockets.at(-1)!.options.headers).get("x-client-request-id"), "child");
	new scope.WebSocket("wss://example.invalid", ["protocol"] as never);
	assert.deepEqual(sockets.at(-1)!.options, ["protocol"], "subprotocol arguments pass through");
	state = { ownId: "child", entries: [] };
	new scope.WebSocket("wss://example.invalid", { headers: { "session-id": "child" } } as never);
	assert.equal(new Headers(sockets.at(-1)!.options.headers).get("session-id"), "child", "an unforked child keeps its own affinity");
});

test("a background fork's copy records the parent's cache identity as a UI fork does, on the parent's branch", () => {
	const root = mkdtempSync(join(tmpdir(), "fork-cache-"));
	try {
		const source = join(root, "parent.jsonl");
		const lines = [
			{ type: "session", version: 3, id: "parent-id", timestamp: "t", cwd: "/repo" },
			{ type: "message", id: "u1", parentId: null, message: { role: "user", content: "hi" } },
			{ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [] } },
		];
		writeFileSync(source, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n{"type":"mess`);
		const copy = join(root, "copy.jsonl");
		assert.equal(copyForFork(source, copy), true);
		const copied = readFileSync(copy, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		assert.deepEqual(copied.slice(0, 3), lines, "the complete lines are copied verbatim; the torn tail is left out");
		const added = copied[3];
		assert.equal(copied.length, 4);
		assert.equal(added.customType, FORK_CACHE_ENTRY);
		assert.equal(added.parentId, "a1", "parented on the leaf: the active branch is unchanged");
		assert.equal(inheritedCacheKey(copied), "parent-id");

		// A parent that is itself a fork passes its lineage on, not its own id.
		const nested = join(root, "nested.jsonl");
		writeFileSync(nested, `${[...lines, { ...entry("grandparent"), id: "c1", parentId: "a1" }].map((l) => JSON.stringify(l)).join("\n")}\n`);
		const nestedCopy = join(root, "nested-copy.jsonl");
		assert.equal(copyForFork(nested, nestedCopy), true);
		assert.equal(inheritedCacheKey(readFileSync(nestedCopy, "utf8").trim().split("\n").map((l) => JSON.parse(l))), "grandparent");

		// A copy that cannot carry the entry (no header id) is still a plain copy.
		writeFileSync(source, '{"type":"session"}\n{"type":"message","id":"a"}\n');
		assert.equal(copyForFork(source, copy), true);
		assert.equal(readFileSync(copy, "utf8"), '{"type":"session"}\n{"type":"message","id":"a"}\n');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
