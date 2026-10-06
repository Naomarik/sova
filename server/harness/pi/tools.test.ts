// Run: pnpm test -- server/harness/pi/tools.test.ts. §app.harness/tools: a ToolSpec reaches pi unchanged
// (name, label, description, prompt snippet, parameters, execution mode, markers), its result, details,
// terminate and streamed updates come back unchanged, and its context is the session's own. A pi tool
// that Sova code calls gets its own pi context back. pi comes through testing/load-pi.ts, so the
// end-to-end cases run against PI_PACKAGE_DIR's pi too.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { StateKind, ToolCtx, ToolResult, ToolSpec } from "../../../shared/harness";
import { loadPi } from "./testing/load-pi.ts";
import { historyOf } from "./reader";
import { fromPiTool, toolCtx, toPiTool } from "./tools";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "sova-pi-tools-")));
after(() => rmSync(dir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = dir;
const pi = await loadPi();
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = pi.agent;
const { createFauxCore, fauxAssistantMessage, fauxToolCall } = pi.ai;

const MARK = Symbol.for("sova.test.mark");
/** A test-only state kind: any object body. */
const TEST_KIND: StateKind<object> = { type: "sova-test", owner: "sova", fold: "branch-list", parse: (d) => (d && typeof d === "object" ? d : null) };
const SCHEMA = { type: "object", properties: { text: { type: "string", description: "What to echo." } }, required: ["text"], additionalProperties: false };

/** A spec with every field Sova's tools use; `seen` records each call's arguments. */
function echoSpec(seen: { ctx?: ToolCtx; signal?: AbortSignal; params?: unknown }[] = []) {
  const spec: ToolSpec & { [MARK]: true } = {
    name: "sova_echo",
    label: "Echo",
    description: "Echo the text back.",
    promptSnippet: "sova_echo: echo a text",
    parameters: SCHEMA,
    executionMode: "sequential",
    [MARK]: true,
    async execute(_id, params: { text: string }, signal, onUpdate, ctx) {
      seen.push({ ctx, signal, params });
      onUpdate?.({ content: [{ type: "text", text: "working" }], details: { step: 1 } });
      return { content: [{ type: "text", text: params.text }], details: { echoed: params.text, nested: { b: 1, a: [2] } }, terminate: true };
    },
  };
  return spec;
}

describe("toPiTool", () => {
  test("every field reaches pi as written, the marker included; only execute is new", () => {
    const spec = echoSpec();
    const tool = toPiTool(spec) as any;
    for (const k of ["name", "label", "description", "promptSnippet", "parameters", "executionMode"] as const) assert.equal(tool[k], (spec as any)[k], k);
    assert.equal(tool[MARK], true);
    assert.deepEqual(Object.keys(tool).sort(), Object.keys(spec).sort());
    assert.equal(JSON.stringify(tool.parameters), JSON.stringify(SCHEMA));
    assert.notEqual(tool.execute, spec.execute);
  });

  test("result, details, terminate and an update pass through; no ctx stays no ctx", async () => {
    const seen: { ctx?: ToolCtx }[] = [];
    const updates: unknown[] = [];
    const result = await toPiTool(echoSpec(seen)).execute("call-1", { text: "hi" } as never, undefined, (p) => void updates.push(p), undefined as never);
    assert.deepEqual(result, { content: [{ type: "text", text: "hi" }], details: { echoed: "hi", nested: { b: 1, a: [2] } }, terminate: true });
    assert.equal(JSON.stringify(result.details), '{"echoed":"hi","nested":{"b":1,"a":[2]}}');
    assert.deepEqual(updates, [{ content: [{ type: "text", text: "working" }], details: { step: 1 } }]);
    assert.equal(seen[0]!.ctx, undefined);
  });

  test("the signal and params are the caller's; a thrown error comes out as the same object", async () => {
    const boom = new Error("nope");
    const seen: { signal?: AbortSignal; params?: unknown }[] = [];
    const ac = new AbortController();
    const params = { text: "x" };
    await toPiTool(echoSpec(seen)).execute("c", params as never, ac.signal, undefined, undefined as never);
    assert.equal(seen[0]!.signal, ac.signal);
    assert.equal(seen[0]!.params, params);
    const failing = { ...echoSpec(), execute: async () => Promise.reject(boom) } as ToolSpec;
    await assert.rejects(toPiTool(failing).execute("c", {} as never, undefined, undefined, undefined as never), (e) => e === boom);
  });
});

describe("toolCtx", () => {
  test("an in-memory session: id, cwd, leaf, state; no key; the name as recorded", () => {
    const cwd = join(dir, "mem");
    const sm = SessionManager.inMemory(cwd);
    const ctx = { sessionManager: sm, cwd } as never;
    const empty = toolCtx(ctx);
    assert.equal(empty.sessionId, sm.getSessionId());
    assert.equal(empty.cwd, cwd);
    assert.equal(empty.leafId(), null);
    assert.equal(empty.state().has(TEST_KIND), false);
    assert.equal(empty.key, null);
    assert.equal(empty.title(), undefined);
    const a = sm.appendCustomEntry("sova-test", { n: 1 });
    sm.appendSessionInfo("Named");
    const c = toolCtx(ctx);
    assert.equal(c.leafId(), sm.getLeafId());
    assert.notEqual(c.leafId(), a);
    assert.deepEqual(c.state().list(TEST_KIND), [{ id: a, parentId: null, at: (sm.getBranch()[0] as any).timestamp, data: { n: 1 } }]);
    assert.equal(c.title(), "Named");
    assert.equal(c.title(), sm.getSessionName());
    assert.equal(c.native, ctx, "the pi context rides along");
  });

  test("reads are live: leaf, branch and name follow the session after the ctx was made", () => {
    const sm = SessionManager.inMemory(dir);
    const c = toolCtx({ sessionManager: sm, cwd: dir } as never);
    const id = sm.appendCustomEntry("sova-test", null);
    sm.appendSessionInfo("Later");
    assert.equal(c.leafId(), sm.getLeafId());
    assert.equal(c.state().latest(TEST_KIND), null, "a null body doesn't parse");
    assert.equal(c.state().written(TEST_KIND)[0]!.id, id);
    assert.equal(c.title(), "Later");
    // The neutral branch reads the same entries, live too (§app.harness/reader).
    assert.deepEqual(c.branch().map((h) => [h.id, h.kind]), [[id, "state"], [sm.getLeafId(), "setting"]]);
    sm.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 });
    assert.deepEqual(c.branch().map((h) => h.id), sm.getBranch().map((e) => e.id));
    assert.equal(c.branch().at(-1)!.kind, "user");
  });

  test("a file session's key is its canonical path, through a symlinked folder too", () => {
    const real = join(dir, "sessions-real");
    mkdirSync(real, { recursive: true });
    const link = join(dir, "sessions-link");
    symlinkSync(real, link);
    const file = join(link, "s.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "key-session", timestamp: new Date().toISOString(), cwd: dir })}\n`);
    const sm = SessionManager.open(file);
    const c = toolCtx({ sessionManager: sm, cwd: dir } as never);
    assert.equal(c.key, join(real, "s.jsonl"));
    assert.equal(c.sessionId, "key-session");
  });
});

describe("fromPiTool", () => {
  test("a pi tool called by Sova code gets its own pi context back (identity), and its fields", async () => {
    const piCtx = { sessionManager: SessionManager.inMemory(dir), cwd: dir } as never;
    let got: unknown;
    const def = {
      name: "pi_native",
      label: "Native",
      description: "A pi tool.",
      parameters: SCHEMA,
      async execute(_id: string, _p: unknown, _s: unknown, _u: unknown, ctx: unknown) {
        got = ctx;
        return { content: [{ type: "text" as const, text: "ok" }], details: { d: 1 } };
      },
    };
    const spec = fromPiTool(def as never);
    assert.equal(spec.name, "pi_native");
    assert.equal(spec.parameters, SCHEMA);
    const r: ToolResult = await spec.execute("c", {}, undefined, undefined, toolCtx(piCtx));
    assert.equal(got, piCtx);
    assert.deepEqual(r, { content: [{ type: "text", text: "ok" }], details: { d: 1 } });
    // Round trip: a Sova tool registered with pi, then called back by Sova code, sees the same context.
    const seen: { ctx?: ToolCtx }[] = [];
    await fromPiTool(toPiTool(echoSpec(seen))).execute("c", { text: "t" }, undefined, undefined, toolCtx(piCtx));
    assert.equal(seen[0]!.ctx!.native, piCtx);
    assert.equal(seen[0]!.ctx!.sessionId, (piCtx as any).sessionManager.getSessionId());
  });
});

describe("end to end: an extension registers toPiTool(spec) and a run calls it", () => {
  test("pi lists the tool as written, and the run stores its result and details unchanged", async () => {
    const faux = createFauxCore({ provider: "faux", models: [{ id: "faux-1", input: ["text"] }] });
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerProvider("faux", {
      name: "Faux",
      baseUrl: "http://127.0.0.1:9",
      apiKey: "stub",
      api: faux.api,
      streamSimple: faux.streamSimple,
      models: [{ id: "faux-1", name: "Faux 1", input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 4_000 }],
    } as never);
    const cwd = join(dir, "e2e");
    mkdirSync(cwd, { recursive: true });
    const seen: { ctx?: ToolCtx }[] = [];
    const spec = echoSpec(seen);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: dir,
      noExtensions: true,
      extensionFactories: [(api: any) => api.registerTool(toPiTool(spec))],
    });
    await resourceLoader.reload();
    const sessionManager = SessionManager.inMemory(cwd);
    const { session } = await createAgentSession({
      cwd,
      agentDir: dir,
      modelRuntime: runtime,
      model: runtime.getModel("faux", "faux-1"),
      resourceLoader,
      sessionManager,
      settingsManager: SettingsManager.inMemory({ cacheWarming: "off" } as never),
      noTools: "builtin",
    });
    try {
      await session.bindExtensions({ mode: "rpc" } as never);
      const info = session.getAllTools().find((t: any) => t.name === "sova_echo") as any;
      assert.ok(info, "the tool is registered");
      assert.equal(info.description, spec.description);
      assert.equal(JSON.stringify(info.parameters), JSON.stringify(SCHEMA), "the same JSON schema");
      const def = session.getToolDefinition("sova_echo") as any;
      for (const k of ["label", "promptSnippet", "executionMode"] as const) assert.equal(def[k], (spec as any)[k], k);
      assert.ok(session.getActiveToolNames().includes("sova_echo"));

      const events: any[] = [];
      session.subscribe((e: any) => void events.push(e));
      faux.setResponses([fauxAssistantMessage([fauxToolCall("sova_echo", { text: "hello" })], { stopReason: "toolUse" }), fauxAssistantMessage("never")]);
      await session.prompt("go");
      await session.waitForIdle();

      assert.equal(seen.length, 1);
      const ctx = seen[0]!.ctx!;
      assert.equal(ctx.sessionId, sessionManager.getSessionId());
      assert.equal(ctx.cwd, cwd);
      assert.equal(ctx.leafId(), sessionManager.getLeafId());
      assert.deepEqual(ctx.branch(), historyOf(sessionManager.getBranch()));
      const update = events.find((e) => e.type === "tool_execution_update");
      assert.deepEqual(update.partialResult, { content: [{ type: "text", text: "working" }], details: { step: 1 } });
      const end = events.find((e) => e.type === "tool_execution_end");
      assert.equal(end.isError, false);
      const stored = sessionManager.getBranch().find((e: any) => e.type === "message" && e.message.role === "toolResult") as any;
      assert.deepEqual(stored.message.content, [{ type: "text", text: "hello" }]);
      assert.equal(JSON.stringify(stored.message.details), '{"echoed":"hello","nested":{"b":1,"a":[2]}}');
    } finally {
      session.dispose();
    }
  });
});

describe("record_decision's quote entry over the branch (baton-loadout quoteEntryOf)", () => {
  /** The walk it replaced: from the leaf up its parents through getEntry, at most 200 entries. */
  const byParents = (sm: { getEntry(id: string): any }, id: string): string => {
    let cur = sm.getEntry(id);
    for (let hops = 0; cur && hops < 200; hops++) {
      if (cur.type === "message" && cur.message?.role === "user" && cur.id) return cur.id;
      cur = cur.parentId ? sm.getEntry(cur.parentId) : undefined;
    }
    return id;
  };
  const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
  const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });

  test("the same entry as the parent walk: null leaf, a near user message, one past the 200-entry cap, and a branch off an older leaf", async () => {
    const { quoteEntryOf } = await import("../../baton-loadout");
    const sm = SessionManager.inMemory(dir);
    const check = () => {
      const c = toolCtx({ sessionManager: sm, cwd: dir } as never);
      const marker = c.leafId() ?? "1700000000000";
      assert.equal(quoteEntryOf(c.branch(), marker), byParents(sm, marker));
      return quoteEntryOf(c.branch(), marker);
    };
    assert.equal(check(), "1700000000000", "no leaf: the marker itself");
    const u1 = sm.appendMessage(user("first") as never);
    sm.appendMessage(assistant("a") as never);
    sm.appendCustomEntry("sova-baton-decision", { v: 1 });
    assert.equal(check(), u1);
    for (let i = 0; i < 198; i++) sm.appendCustomEntry("sova-test", { i });
    assert.equal(check(), sm.getLeafId(), "past the cap: the leaf");
    const u2 = sm.appendMessage(user("second") as never);
    for (let i = 0; i < 199; i++) sm.appendCustomEntry("sova-test", { i });
    assert.equal(check(), u2, "the 200th entry up is still read");
    sm.branch(u1);
    sm.appendMessage(assistant("b") as never);
    assert.equal(check(), u1, "another branch: its own parents");
  });
});

describe("exposure (§chat.mode-menu/codemode)", () => {
  test("a model-only ToolSpec reaches pi model-only: declared to the model, never among the tools another tool may call", async () => {
    const spec: ToolSpec = { ...echoSpec(), name: "sova_card_like", exposure: "model-only" };
    assert.equal((toPiTool(spec) as any).exposure, "model-only");
    assert.equal("exposure" in (toPiTool(echoSpec()) as any), false, "none given, none passed: a direct tool");
    const faux = createFauxCore({ provider: "faux", models: [{ id: "faux-1", input: ["text"] }] });
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerProvider("faux", { name: "Faux", baseUrl: "http://127.0.0.1:9", apiKey: "stub", api: faux.api, streamSimple: faux.streamSimple, models: [{ id: "faux-1", name: "Faux 1", input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 4_000 }] } as never);
    const cwd = join(dir, "exposure");
    mkdirSync(cwd, { recursive: true });
    let callable: string[] = [];
    const probe = { name: "probe", label: "probe", description: "probe", parameters: { type: "object", properties: {} }, execute: async (_i: string, _p: unknown, _s: unknown, _u: unknown, ctx: any) => { callable = ctx.tools.map((t: any) => t.name); return { content: [{ type: "text", text: "ok" }], details: {} }; } };
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: dir, noExtensions: true, extensionFactories: [(api: any) => { api.registerTool(toPiTool(spec)); api.registerTool(toPiTool(echoSpec())); api.registerTool(probe); }] });
    await resourceLoader.reload();
    const { session } = await createAgentSession({ cwd, agentDir: dir, modelRuntime: runtime, model: runtime.getModel("faux", "faux-1"), resourceLoader, sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory({ cacheWarming: "off" } as never), noTools: "builtin" });
    try {
      await session.bindExtensions({ mode: "rpc" } as never);
      assert.ok(session.getActiveToolNames().includes("sova_card_like"), "declared: active like any tool");
      faux.setResponses([fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
      await session.prompt("go");
      await session.waitForIdle();
      assert.ok(callable.includes("sova_echo"), "a direct tool is callable from another tool");
      assert.ok(!callable.includes("sova_card_like"), "a model-only one is not");
    } finally {
      session.dispose();
    }
  });
});
