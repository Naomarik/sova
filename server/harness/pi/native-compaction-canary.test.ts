// Offline SDK milestone only. No native feature, provider override, transport implementation,
// credentials, socket, or global fetch patch. Pi imports stay behind testing/load-pi.ts.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadPi } from "./testing/load-pi.ts";

const root = mkdtempSync(join(tmpdir(), "sova-native-compaction-canary-"));
after(() => rmSync(root, { recursive: true, force: true }));
const pi = await loadPi();
const { ModelRuntime, ModelRegistry, SessionManager, convertToLlm } = pi.agent;
const { getCurrentSystemMessage, getCurrentSystemPrompt, getCurrentTools } = pi.ai;

// Deliberately unsigned, synthetic and unusable as service credentials. The built-in Codex
// parser needs the account claim even when its public fetch seam never leaves this process.
const dummyToken = `e30.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "offline-fixture" },
})).toString("base64")}.unsigned`;
const artifact = { type: "compaction", id: "cmp_fixture", encrypted_content: "opaque-fixture", future_field: { retained: true } };
const usage = { input_tokens: 19, output_tokens: 7, total_tokens: 26, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } };

const authPath = join(root, "synthetic-auth.json");
writeFileSync(authPath, JSON.stringify({ "openai-codex": {
  type: "oauth", access: dummyToken, refresh: "unused-offline-refresh", expires: Number.MAX_SAFE_INTEGER,
} }), { mode: 0o600 });

async function registryFixture() {
  // Codex is OAuth-only: a runtime API key is deliberately not accepted by its auth
  // resolver. A never-expiring synthetic credential exercises the real OAuth derivation
  // without a refresh, login, network call, or provider/auth implementation replacement.
  const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
  await runtime.refresh({ providers: ["openai-codex"], allowNetwork: false });
  const registry = new ModelRegistry(runtime);
  const catalogModel = registry.getAll().find((m) => m.provider === "openai-codex" && m.api === "openai-codex-responses");
  assert.ok(catalogModel, "the installed SDK must expose its built-in Codex provider");
  // Disable mid-conversation capabilities for a deterministic checkpoint serialization canary;
  // do not register/replace a provider or claim this covers every catalog model's loadout.
  const model = { ...catalogModel, compat: { ...catalogModel.compat, supportsMidConvoSystemMessages: false, supportsAdditionalTools: false, supportsToolSearch: false } };
  assert.equal(registry.isUsingOAuth(model), true);
  return { runtime, registry, model };
}

type WireEvent = Record<string, any>;
function responseEvents(type = "response.completed", status = "completed"): WireEvent[] {
  return [
    { type: "response.created", response: { id: "resp_fixture", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...artifact } },
    { type: "response.output_item.done", output_index: 0, item: { ...artifact } },
    { type, response: { id: "resp_fixture", status, output: [{ ...artifact }], usage,
      ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}) } },
  ];
}

/** Real SDK SSE parser, fed by a public request-local fetch implementation (no actual fetch).
 * Small byte chunks also exercise parser buffering rather than returning parsed mock events. */
function offlineFetch(events: WireEvent[], onRequest: (input: unknown, init: RequestInit | undefined) => void): typeof fetch {
  return (async (input, init) => {
    onRequest(input, init);
    const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 13) controller.enqueue(bytes.slice(i, i + 13));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

async function nestedStream(registry: InstanceType<typeof ModelRegistry>, model: any, messages: any[], events: WireEvent[], patch?: (body: any) => any) {
  let requests = 0;
  let payload: any;
  const raw: WireEvent[] = [];
  const order: string[] = [];
  const stream = registry.streamSimple(model, { messages }, {
    transport: "sse",
    maxRetries: 0,
    fetch: offlineFetch(events, (_input, init) => {
      requests++;
      assert.equal(init?.method, "POST");
      assert.ok(payload, "onPayload must run before the injected request");
      order.push("fetch");
    }),
    onPayload(body: any, requestModel: any) {
      assert.equal(requestModel.provider, "openai-codex");
      order.push("payload");
      payload = structuredClone(patch ? patch(body) : body);
      return payload;
    },
    async onProviderStreamEvent(event: any, requestModel: any) {
      assert.equal(requestModel.api, "openai-codex-responses");
      raw.push(structuredClone(event));
      order.push(event.type);
    },
  });
  const normalized: any[] = [];
  for await (const event of stream) normalized.push(event);
  const result = await stream.result();
  const diagnostic = String(result.errorMessage ?? "no provider error")
    .replaceAll(dummyToken, "[synthetic token]")
    .replaceAll(artifact.encrypted_content, "[synthetic artifact]");
  assert.equal(requests, 1, `offline request seam was not reached exactly once: ${diagnostic}`);
  assert.deepEqual(order.slice(0, 2), ["payload", "fetch"]);
  return { payload, raw, normalized, result };
}

const textOf = (m: any): string => typeof m.content === "string" ? m.content : (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
const tool = (name: string, description: string) => ({ name, description, parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } });

function projectionFixture() {
  const sm = SessionManager.inMemory(root);
  const obsolete = tool("obsolete", "Removed tool");
  const active = tool("active", "Effective declaration, not registered-tool metadata");
  sm.appendMessage({ role: "system", content: "", sections: { preamble: "Old instructions", policy: "Keep policy" }, toolsAdded: [obsolete], timestamp: 1 } as never);
  const old = sm.appendMessage({ role: "user", content: "OLD PREFIX ONLY", timestamp: 2 });
  const omitted = sm.appendMessage({ role: "user", content: "OMITTED ATTEMPT", timestamp: 3 });
  const boundary = sm.appendMessage({ role: "user", content: "RAW KEPT INPUT", timestamp: 4 });
  sm.appendMessage({ role: "system", content: "", sections: { preamble: "Effective instructions" }, toolsRemoved: [{ name: "obsolete" }], toolsAdded: [active], timestamp: 5 } as never);
  sm.appendContextEdit(omitted, null);
  sm.appendContextEdit(boundary, { content: "EDITED KEPT INPUT" });
  const summary = "## Offline checkpoint cmp-fixture\nThe old prefix established a portable fact.";
  const checkpoint = sm.appendCompaction(summary, boundary, 1234, { fixture: true }, true);
  const tail = sm.appendMessage({ role: "user", content: "CURRENT INPUT MUST SURVIVE", timestamp: 6 });
  return { sm, old, omitted, boundary, checkpoint, tail, active, summary };
}

test("public nested ModelRegistry stream captures opaque output before normalization, with no visible content", async () => {
  const { registry, model } = await registryFixture();
  const sm = SessionManager.inMemory(root);
  sm.appendMessage({ role: "user", content: "Prefix fact", timestamp: 1 });
  const before = structuredClone(sm.getEntries());
  const call = await nestedStream(registry, model, convertToLlm(sm.buildSessionProjection().messages), responseEvents(), (body) => ({
    ...body, input: [...body.input, { type: "compaction_trigger" }], store: false,
  }));
  assert.deepEqual(call.payload.input.at(-1), { type: "compaction_trigger" });
  assert.equal(call.payload.input.filter((item: any) => item.type === "compaction_trigger").length, 1);
  assert.equal(call.payload.store, false);
  assert.equal(call.payload.stream, true);
  assert.deepEqual(call.raw, responseEvents());
  assert.deepEqual(call.raw.filter((e) => e.type === "response.output_item.done").map((e) => e.item), [artifact]);
  assert.equal(call.raw.at(-1)?.response.status, "completed");
  assert.equal(call.result.stopReason, "stop");
  assert.deepEqual(call.result.content, [], "opaque output is not visible assistant text/thinking");
  assert.equal(call.result.responseId, "resp_fixture");
  assert.equal(call.result.usage.input, 16);
  assert.equal(call.result.usage.cacheRead, 3);
  assert.equal(call.result.usage.output, 7);
  assert.equal(call.result.usage.totalTokens, 26);
  assert.equal(call.normalized.at(-1)?.type, "done");
  assert.ok(!call.normalized.some((e) => /^(text|thinking|toolcall)_/.test(e.type)));
  assert.deepEqual(sm.getEntries(), before, "nested stream must not persist an assistant response");
});

test("raw terminal event and status distinguish completed, incomplete, ambiguous done, and early EOF", async () => {
  const { registry, model } = await registryFixture();
  const messages = [{ role: "user", content: "Offline prefix", timestamp: 1 }];
  const cases = [
    { type: "response.completed", status: "completed", stop: "stop", acceptable: true },
    { type: "response.incomplete", status: "incomplete", stop: "length", acceptable: false },
    // An incomplete event with absent/contradictory status can normalize to success. Never
    // infer native completion from stopReason alone, or from the artifact's mere presence.
    { type: "response.incomplete", status: "completed", stop: "stop", acceptable: false },
    { type: "response.done", status: "completed", stop: "stop", acceptable: false },
    { type: "response.done", status: "incomplete", stop: "length", acceptable: false },
  ];
  for (const c of cases) {
    const call = await nestedStream(registry, model, messages, responseEvents(c.type, c.status));
    assert.equal(call.result.stopReason, c.stop, `${c.type}/${c.status}`);
    assert.deepEqual(call.result.content, []);
    assert.equal(call.raw.at(-1)?.type, c.type, "raw callback must precede Codex terminal-event remapping");
    assert.equal(call.raw.at(-1)?.response.status, c.status);
    const completed = call.raw.filter((e) => e.type === "response.completed" && e.response?.status === "completed");
    assert.equal(completed.length === 1, c.acceptable);
  }
  const eof = await nestedStream(registry, model, messages, responseEvents().slice(0, -1));
  assert.equal(eof.result.stopReason, "error");
  assert.equal(eof.normalized.at(-1)?.type, "error");
  assert.equal(eof.raw.filter((e) => e.type === "response.completed").length, 0);
});

test("canonical firstKept projection, effective system/tools and convertToLlm identify the exact serialized summary slot", async () => {
  const { registry, model } = await registryFixture();
  const f = projectionFixture();
  const projection = f.sm.buildSessionProjection();
  const ids = projection.entries.map((e) => e.sourceEntry.id);
  assert.ok(!ids.includes(f.old), "old prefix must not leak back into compacted context");
  assert.ok(!projection.messages.some((m) => textOf(m).includes("OMITTED ATTEMPT")));
  const keptMessage = projection.entries.find((e) => e.sourceEntry.id === f.boundary)?.messages[0];
  assert.ok(keptMessage?.role === "user");
  assert.equal(keptMessage.content, "EDITED KEPT INPUT");
  assert.equal(f.sm.getEntry(f.boundary)?.type, "message");
  assert.equal(textOf((f.sm.getEntry(f.boundary) as any).message), "RAW KEPT INPUT", "edits do not mutate stored history");
  const cmp = projection.entries.find((e) => e.sourceEntry.id === f.checkpoint)!;
  assert.deepEqual(cmp.messages.map((m) => m.role), ["system", "compactionSummary"]);
  assert.deepEqual(projection.messages.filter((m) => m.role !== "system").map((m) => m.role), ["compactionSummary", "user", "user"]);
  assert.ok(ids.indexOf(f.checkpoint) < ids.indexOf(f.boundary));
  assert.ok(ids.indexOf(f.boundary) < ids.indexOf(f.tail));
  const effective = getCurrentSystemMessage(projection.messages);
  assert.ok(effective);
  assert.deepEqual(getCurrentTools(projection.messages), [f.active]);
  assert.equal(getCurrentSystemPrompt(projection.messages), "Effective instructions\n\nKeep policy");
  assert.deepEqual(getCurrentTools([effective]), [f.active]);
  const llm = convertToLlm(projection.messages);
  const summaryLlm = convertToLlm(cmp.messages.filter((m) => m.role === "compactionSummary"))[0];
  assert.ok(summaryLlm);
  assert.equal(summaryLlm.role, "user");
  assert.deepEqual(summaryLlm.content, [{ type: "text", text: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${f.summary}\n</summary>` }]);
  const summaryText = textOf(summaryLlm);
  const before = structuredClone(f.sm.getEntries());
  const call = await nestedStream(registry, model, llm, responseEvents());
  assert.equal(call.payload.instructions, getCurrentSystemPrompt(projection.messages));
  assert.deepEqual(call.payload.tools, [{ type: "function", ...f.active, strict: null }]);
  const slot = { role: "user", content: [{ type: "input_text", text: summaryText }] };
  assert.deepEqual(call.payload.input.filter((item: any) => JSON.stringify(item) === JSON.stringify(slot)), [slot]);
  assert.ok(JSON.stringify(call.payload.input).includes("EDITED KEPT INPUT"));
  assert.ok(JSON.stringify(call.payload.input).includes("CURRENT INPUT MUST SURVIVE"));
  assert.ok(!JSON.stringify(call.payload.input).includes("RAW KEPT INPUT"));
  assert.ok(!JSON.stringify(call.payload.input).includes("OLD PREFIX ONLY"));
  // A user can quote the complete serialized summary: exact text matching alone is NOT
  // collision-safe. Pin this negative case so production must fail closed on ambiguity.
  f.sm.appendMessage({ role: "user", content: summaryText, timestamp: 7 });
  const collision = await nestedStream(registry, model, convertToLlm(f.sm.buildSessionProjection().messages), responseEvents());
  assert.equal(collision.payload.input.filter((item: any) => JSON.stringify(item) === JSON.stringify(slot)).length, 2);
  assert.deepEqual(f.sm.getEntries().slice(0, before.length), before);
});

for (const splitTurn of [false, true]) test(`session_before_compact public nested registry and ${splitTurn ? "split-turn" : "user-turn"} canonical boundary`, async () => {
  const { runtime, model } = await registryFixture();
  const cwd = join(root, `nested-hook-cwd-${splitTurn}`);
  mkdirSync(cwd);
  const sm = SessionManager.inMemory(cwd);
  sm.appendMessage({ role: "user", content: "Older prefix ".repeat(80), timestamp: 1 });
  const turnStart = sm.appendMessage({ role: "user", content: "Recent kept input ".repeat(80), timestamp: 2 });
  const kept = splitTurn ? sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "Recent answer ".repeat(80) }], provider: model.provider, api: model.api, model: model.id, stopReason: "stop", timestamp: 3,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }) : turnStart;
  const settings = pi.agent.SettingsManager.inMemory({ cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 } });
  let calls = 0;
  let hookFailure: unknown;
  const loader = new pi.agent.DefaultResourceLoader({ cwd, agentDir: root, settingsManager: settings,
    extensionFactories: [(api) => {
      api.on("session_before_compact", async (event, ctx) => {
        try {
          calls++;
          assert.equal(event.preparation.firstKeptEntryId, kept);
          const canonical = ctx.sessionManager.buildSessionProjection();
          const cut = canonical.entries.findIndex((e) => e.sourceEntry.id === kept);
          assert.ok(cut >= 0);
          const prefix = canonical.entries.slice(0, cut).flatMap((e) => e.messages);
          assert.equal(event.preparation.isSplitTurn, splitTurn);
          assert.deepEqual([...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages], prefix.filter((m) => m.role !== "system"));
          assert.equal(event.preparation.turnPrefixMessages.length, splitTurn ? 1 : 0);
          if (splitTurn) assert.equal(textOf(event.preparation.turnPrefixMessages[0]), "Recent kept input ".repeat(80));
          const call = await nestedStream(ctx.modelRegistry, model, convertToLlm(prefix), responseEvents(), (body) => ({ ...body, input: [...body.input, { type: "compaction_trigger" }] }));
          assert.equal(call.result.stopReason, "stop");
          assert.equal(ctx.sessionManager.getBranch().filter((e) => e.type === "compaction").length, 0);
          return { compaction: { summary: "Portable offline checkpoint", firstKeptEntryId: kept, tokensBefore: event.preparation.tokensBefore, details: { offlineArtifact: artifact }, usage: call.result.usage } };
        } catch (error) {
          // SDK reports/swallow hook errors; surface assertions to the outer test instead.
          hookFailure = error;
          return { cancel: true };
        }
      });
    }],
  });
  await loader.reload();
  const { session } = await pi.agent.createAgentSession({ cwd, agentDir: root, modelRuntime: runtime, model, sessionManager: sm, settingsManager: settings, resourceLoader: loader, noTools: "builtin" });
  try {
    await session.bindExtensions({});
    try { await session.compact(); } catch (error) { if (!hookFailure) throw error; }
    if (hookFailure) throw hookFailure;
    assert.equal(calls, 1);
    const checkpoints = sm.getBranch().filter((e) => e.type === "compaction");
    assert.equal(checkpoints.length, 1);
    const checkpoint = checkpoints[0];
    assert.ok(checkpoint);
    assert.equal(checkpoint.firstKeptEntryId, kept);
    assert.deepEqual(checkpoint.details, { offlineArtifact: artifact });
    assert.equal(sm.getBranch().filter((e) => e.type === "message" && e.message.role === "assistant").length, splitTurn ? 1 : 0, "nested response is not an extra conversation turn");
  } finally { session.dispose(); }
});

test("repeated compaction replaces the prior summary slot without replaying its retained prefix twice", async () => {
  const { registry, model } = await registryFixture();
  const f = projectionFixture();
  const previous = f.sm.buildSessionProjection();
  assert.ok(previous.entries.some((e) => e.sourceEntry.id === f.boundary));
  const second = f.sm.appendCompaction("## Second offline checkpoint\nBoth earlier facts preserved.", f.tail, 800, { second: true }, true);
  f.sm.appendMessage({ role: "user", content: "AFTER SECOND CHECKPOINT", timestamp: 8 });
  const projection = f.sm.buildSessionProjection();
  const summaries = projection.messages.filter((m) => m.role === "compactionSummary");
  assert.equal(summaries.length, 1);
  const current = projection.entries.find((e) => e.sourceEntry.id === second);
  assert.ok(current);
  assert.deepEqual(current.messages.map((m) => m.role), ["system", "compactionSummary"]);
  assert.ok(!projection.messages.some((m) => textOf(m).includes("EDITED KEPT INPUT")));
  assert.deepEqual(getCurrentTools(projection.messages), [f.active]);
  assert.equal(getCurrentSystemPrompt(projection.messages), getCurrentSystemPrompt(previous.messages));
  const call = await nestedStream(registry, model, convertToLlm(projection.messages), responseEvents());
  const inputs = call.payload.input.map((item: any) => JSON.stringify(item));
  assert.equal(inputs.filter((s: string) => s.includes("Second offline checkpoint")).length, 1);
  assert.equal(inputs.filter((s: string) => s.includes("CURRENT INPUT MUST SURVIVE")).length, 1);
  assert.equal(inputs.filter((s: string) => s.includes("AFTER SECOND CHECKPOINT")).length, 1);
  assert.ok(!inputs.some((s: string) => s.includes(f.summary) || s.includes("EDITED KEPT INPUT")));
  assert.ok(f.sm.getEntry(f.checkpoint), "older checkpoint remains in raw history");
});

test("effective grammar declaration and same-model tool-call namespace survive checkpoint conversion", async () => {
  const { registry, model: baseModel } = await registryFixture();
  const model = { ...baseModel, compat: { ...baseModel.compat, supportsOpenAIGrammarTools: true } };
  const grammarTool = { ...tool("grammar_fixture", "Grammar tool declaration"), constrainedSampling: { type: "grammar", variants: { openai_regex: "[a-z]+" } } };
  const sm = SessionManager.inMemory(root);
  sm.appendMessage({ role: "system", content: "Grammar instructions", toolsAdded: [grammarTool], timestamp: 1 } as never);
  sm.appendMessage({ role: "user", content: "Old input", timestamp: 2 });
  const kept = sm.appendMessage({ role: "user", content: "Keep grammar tool interaction", timestamp: 3 });
  sm.appendCompaction("Portable grammar checkpoint", kept, 100);
  sm.appendMessage({ role: "assistant", provider: model.provider, api: model.api, model: model.id, stopReason: "toolUse", timestamp: 4,
    content: [{ type: "toolCall", id: "call_grammar|ctc_fixture", name: grammarTool.name, namespace: "fixture_namespace", arguments: { value: "abc" } }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  sm.appendMessage({ role: "toolResult", toolCallId: "call_grammar|ctc_fixture", toolName: grammarTool.name, content: [{ type: "text", text: "Grammar result" }], isError: false, timestamp: 5 });
  const projection = sm.buildSessionProjection();
  assert.deepEqual(getCurrentTools(projection.messages), [grammarTool]);
  const call = await nestedStream(registry, model, convertToLlm(projection.messages), responseEvents());
  assert.deepEqual(call.payload.tools, [{ type: "custom", name: grammarTool.name, description: grammarTool.description, format: { type: "grammar", syntax: "regex", definition: "[a-z]+" } }]);
  const toolCall = call.payload.input.find((item: any) => item.type === "custom_tool_call");
  assert.ok(toolCall);
  assert.equal(toolCall.namespace, "fixture_namespace");
  assert.equal(toolCall.input, "abc");
  assert.equal(toolCall.call_id, "call_grammar");
  assert.ok(call.payload.input.some((item: any) => item.type === "custom_tool_call_output" && item.call_id === toolCall.call_id));
  // This pins public transcript declarations and call namespace replay, not Sova's live
  // codemode prepareLoadout or additional_tools/tool_search namespace exposure parity.
});
