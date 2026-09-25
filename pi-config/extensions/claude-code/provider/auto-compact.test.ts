/**
 * The agent_settled compaction trigger, against a fake ExtensionAPI and
 * context: no CLI, no pi session.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { registerAutoCompact } from "./auto-compact.ts";
import { CLAUDE_PROVIDER_FLAG, CLAUDE_PROVIDER_ID, REGISTERED_MARKER, registerProviderIfEnabled, STATIC_MODELS } from "./index.ts";
import { foldBudgetChars, foldSizeEstimate } from "./session-bridge.ts";
import type { ClaudeSessionBridge } from "./types.ts";

beforeEach(() => {
	delete (globalThis as unknown as Record<symbol, boolean | undefined>)[REGISTERED_MARKER];
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function fakePi(flag = true) {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		registerFlag() {},
		getFlag: (name: string) => (name === CLAUDE_PROVIDER_FLAG ? flag : undefined),
		registerProvider() {},
		on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		getActiveTools: () => ["read"],
		getAllTools: () => [
			{ name: "read", description: "Read a file", parameters: { type: "object" } },
			{ name: "unused", description: "x".repeat(400_000), parameters: { type: "object" } },
		],
	} as unknown as ExtensionAPI;
	/** Emit agent_settled, then let the handler's deferred check run. */
	const settle = async (ctx: ExtensionContext, between?: () => void) => {
		for (const handler of handlers.get("agent_settled") ?? []) await handler({ type: "agent_settled" }, ctx);
		between?.();
		await new Promise((resolve) => setTimeout(resolve, 5));
	};
	return { pi, handlers, settle };
}

const text = (role: "user" | "assistant", body: string): Message => (role === "user"
	? { role, content: body, timestamp: 1 }
	: {
		role, content: [{ type: "text", text: body }], api: "claude-code-cli", provider: CLAUDE_PROVIDER_ID, model: "sonnet",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: 2,
	}) as Message;

/** `chars` of conversation, in 10K exchanges. */
function conversation(chars: number): Message[] {
	const out: Message[] = [];
	for (let used = 0; used < chars; used += 10_000) out.push(text("user", "u".repeat(5_000)), text("assistant", "a".repeat(5_000)));
	return out;
}

function model(id: string, provider = CLAUDE_PROVIDER_ID) {
	return { ...STATIC_MODELS.find((m) => m.id === id)!, provider, api: provider, baseUrl: "x" };
}

function fakeCtx(messages: Message[], options: { model?: ReturnType<typeof model>; leaf?: string; branchTypes?: string[]; idle?: boolean; pending?: boolean; session?: string } = {}) {
	const state = { idle: options.idle ?? true, pending: options.pending ?? false };
	const calls: { onComplete?: (r: unknown) => void; onError?: (e: Error) => void }[] = [];
	const notes: string[] = [];
	const ctx = {
		model: options.model ?? model("sonnet"),
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
		getSystemPrompt: () => "You are pi.",
		ui: { notify: (message: string) => { notes.push(message); } },
		sessionManager: {
			getSessionId: () => options.session ?? "pi-session-1",
			getLeafId: () => options.leaf ?? "leaf-1",
			getBranch: () => (options.branchTypes ?? ["message", "message"]).map((type, i) => ({ type, id: `e${i}` })),
			buildSessionProjection: () => ({ entries: [], messages, thinkingLevel: "off", model: null }),
		},
		compact: (opts: { onComplete?: (r: unknown) => void; onError?: (e: Error) => void } = {}) => { calls.push(opts); },
	} as unknown as ExtensionContext;
	return { ctx, calls, notes, state };
}

const budget200k = () => foldBudgetChars({ contextWindow: 200_000, maxTokens: 64_000, systemPrompt: "You are pi.", tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } as never }] });

test("the provider's registration installs the trigger: over budget on a claude-code-cli model compacts", async () => {
	const { pi, settle } = fakePi();
	registerProviderIfEnabled(pi, { runTurn() { throw new Error("unused"); } } as ClaudeSessionBridge);
	const messages = conversation(budget200k() + 20_000);
	assert.ok(foldSizeEstimate(messages) > budget200k());
	const { ctx, calls } = fakeCtx(messages);
	await settle(ctx);
	assert.equal(calls.length, 1);
});

test("under budget, nothing happens", async () => {
	const { pi, settle } = fakePi();
	registerAutoCompact(pi, CLAUDE_PROVIDER_ID, () => true);
	const messages = conversation(budget200k() - 40_000);
	assert.ok(foldSizeEstimate(messages) < budget200k());
	const { ctx, calls } = fakeCtx(messages);
	await settle(ctx);
	assert.equal(calls.length, 0);
});

test("the budget follows the model's window: what compacts a 200K model does not compact a 1M one", async () => {
	const { pi, settle } = fakePi();
	registerAutoCompact(pi, CLAUDE_PROVIDER_ID, () => true);
	const messages = conversation(600_000);
	const large = fakeCtx(messages, { model: model("opus[1m]") });
	await settle(large.ctx);
	assert.equal(large.calls.length, 0);
	const small = fakeCtx(messages, { model: model("sonnet"), leaf: "leaf-2" });
	await settle(small.ctx);
	assert.equal(small.calls.length, 1);
});

test("only active tools count against the window", async () => {
	// The inactive tool's 400K description would push the budget to its floor.
	const { pi, settle } = fakePi();
	registerAutoCompact(pi, CLAUDE_PROVIDER_ID, () => true);
	const { ctx, calls } = fakeCtx(conversation(200_000));
	await settle(ctx);
	assert.equal(calls.length, 0);
});

test("never for another provider, with the flag off, mid-run, with queued messages, or right after a compaction", async () => {
	const messages = conversation(budget200k() + 20_000);
	const cases: [string, boolean, Parameters<typeof fakeCtx>[1]][] = [
		["other provider", true, { model: model("sonnet", "anthropic") }],
		["flag off", false, {}],
		["not idle", true, { idle: false }],
		["queued messages", true, { pending: true }],
		["leaf is a compaction", true, { branchTypes: ["message", "compaction"] }],
		["compaction followed only by non-context entries", true, { branchTypes: ["message", "compaction", "label", "model_change", "usage"] }],
	];
	for (const [label, flag, options] of cases) {
		const { pi, settle } = fakePi(flag);
		registerAutoCompact(pi, CLAUDE_PROVIDER_ID, () => pi.getFlag(CLAUDE_PROVIDER_FLAG) === true);
		const { ctx, calls } = fakeCtx(messages, options);
		await settle(ctx);
		assert.equal(calls.length, 0, label);
	}
});

test("one request per leaf, and a failure is retried only once the history has grown", async () => {
	const { pi, settle } = fakePi();
	registerAutoCompact(pi, CLAUDE_PROVIDER_ID, () => true);
	const over = conversation(budget200k() + 20_000);
	const first = fakeCtx(over);
	await settle(first.ctx);
	await settle(first.ctx);
	assert.equal(first.calls.length, 1, "the same leaf is not asked twice");

	first.calls[0]!.onError?.(new Error("Summarization failed"));
	assert.match(first.notes[0]!, /Automatic compaction failed: Summarization failed/);
	const slightly = fakeCtx([...over, ...conversation(10_000)], { leaf: "leaf-2" });
	await settle(slightly.ctx);
	assert.equal(slightly.calls.length, 0, "a failure is not retried on every settle");
	const grown = fakeCtx(conversation(Math.ceil((budget200k() + 20_000) * 1.3)), { leaf: "leaf-3" });
	await settle(grown.ctx);
	assert.equal(grown.calls.length, 1);

	// Sessions are independent.
	const other = fakeCtx(over, { session: "pi-session-2" });
	await settle(other.ctx);
	assert.equal(other.calls.length, 1);
});

test("a compaction further back does not block a new one once messages follow it", async () => {
	const { pi, settle } = fakePi();
	registerAutoCompact(pi, CLAUDE_PROVIDER_ID, () => true);
	const { ctx, calls } = fakeCtx(conversation(budget200k() + 20_000), { branchTypes: ["compaction", "message", "label"] });
	await settle(ctx);
	assert.equal(calls.length, 1);
});

test("the check waits a tick: a prompt the host hands off on settle wins, and no compaction starts", async () => {
	const { pi, settle } = fakePi();
	registerAutoCompact(pi, CLAUDE_PROVIDER_ID, () => true);
	const { ctx, calls, state } = fakeCtx(conversation(budget200k() + 20_000));
	let synchronous = -1;
	// What Sova does on the session's agent_settled: start the next queued prompt at once.
	await settle(ctx, () => { synchronous = calls.length; state.idle = false; });
	assert.equal(synchronous, 0, "nothing is decided inside the event itself");
	assert.equal(calls.length, 0, "the handed-off prompt is not aborted by a compaction");
});
