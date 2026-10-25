// Run: pnpm test -- server/harness/pi/contract.test.ts. The pi contract (§app.harness/boundary): the pi
// behaviours Sova relies on, pinned so a pi upgrade that changes one fails here before it fails a feature.
// pi comes only through testing/load-pi.ts, so the same file proves the repo's pin or, with
// PI_PACKAGE_DIR=<a pi-coding-agent package dir>, another copy (see README.md here). Turns run on pi-ai's
// faux provider, registered through the public ModelRuntime API: no network, no private fields.
// C1 the session manager's append* methods (the entry union), C2 the custom entry's line, C3 the event
// names and fields chat-manager's bind() reads, C5 image content as prompt/steer take and store it.
// P1-P28 and T1 are the quirk canaries (QUIRKS.md, quirks.ts): each asserts that a pi behaviour a Sova
// workaround or assumption rests on still holds. Their turns run on testing/scripted-model.ts (a held
// reply makes the mid-turn windows deterministic). When one fails, triage it by its QUIRKS.md row.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { loadPi } from "./testing/load-pi.ts";
import { STANDIN_FILTER } from "./headless.ts";
import { packageFrom, patchResolve } from "./own-code.ts";
import { hearRequests } from "./session.ts";
import { ScriptedModel } from "./testing/scripted-model.ts";
import { PiHarnessSession } from "./session.ts";
import { SendKeys } from "../../send-keys.ts";
import { WebQueue } from "../../queue.ts";
import { steerAllAtOnce } from "./queue-modes.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "sova-pi-contract-")));
after(() => rmSync(dir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = dir;
const pi = await loadPi();
const { createAgentSession, defineTool, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager } = pi.agent;
const { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } = pi.ai;
const { Type } = pi.typebox;
console.log(`[pi contract] pi ${pi.version} at ${pi.dir}`);

/** A 1x1 PNG, so pi's image handling keeps it as it is. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const IMAGE = { type: "image", data: PNG, mimeType: "image/png" } as const;

/** A session on the faux provider with one `echo` tool; `events` records every event, in order. */
async function scriptedSession() {
  const faux = createFauxCore({ provider: "faux", models: [{ id: "faux-1", input: ["text", "image"] }] });
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider("faux", {
    name: "Faux",
    baseUrl: "http://127.0.0.1:9",
    apiKey: "stub",
    api: faux.api,
    streamSimple: faux.streamSimple,
    models: [{ id: "faux-1", name: "Faux 1", input: ["text", "image"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 4_000 }],
  } as never);
  const echo = defineTool({
    name: "echo",
    label: "Echo",
    description: "Echo the text back.",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id: string, p: { text: string }) {
      return { content: [{ type: "text" as const, text: p.text }], details: {} };
    },
  });
  const cwd = join(dir, `cwd-${Math.random().toString(36).slice(2)}`);
  mkdirSync(cwd, { recursive: true });
  const { session } = await createAgentSession({
    cwd,
    agentDir: dir,
    modelRuntime: runtime,
    model: runtime.getModel("faux", "faux-1"),
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({ cacheWarming: "off", retry: { baseDelayMs: 1 }, compaction: { keepRecentTokens: 1 } } as never),
    noTools: "builtin",
    customTools: [echo as never],
  });
  const events: any[] = [];
  session.subscribe((e: any) => void events.push(e));
  return { session, faux, events };
}

/** A model runtime that knows faux-1, faux-2 and the reasoning faux-r (authenticated, never called:
    the quirk canaries' turns run on a ScriptedModel). */
async function fauxRuntime() {
  const faux = createFauxCore({ provider: "faux", models: [{ id: "faux-1" }] });
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const model = (id: string, reasoning = false) => ({ id, name: id, input: ["text", "image"], reasoning, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 4_000 });
  runtime.registerProvider("faux", {
    name: "Faux",
    baseUrl: "http://127.0.0.1:9",
    apiKey: "stub",
    api: faux.api,
    streamSimple: faux.streamSimple,
    models: [model("faux-1"), model("faux-2"), model("faux-r", true)],
  } as never);
  return runtime;
}

interface QuirkSessionOptions {
  /** Open this session file (default: an in-memory session). */
  file?: string;
  /** The faux model id to build with; null leaves the choice to the SDK. Default faux-1. */
  model?: string | null;
  settings?: Record<string, unknown>;
  /** A settings manager of the test's own (instead of an in-memory one from `settings`). */
  settingsManager?: unknown;
  /** Inline extensions, and extension files loaded by path. */
  extensions?: ((api: any) => void)[];
  extensionPaths?: string[];
  appendSystemPrompt?: (base: string[]) => string[];
  /** Hand the session manager over before construction (P1 patches it there). */
  beforeBuild?: (sm: any) => void;
  /** Keep pi's built-in tools (default: none). */
  builtinTools?: boolean;
}

/** A real pi session the way Sova builds one (a resource loader, extensions bound), its turns on a
    ScriptedModel; `events` records every event, in order. */
async function quirkSession(o: QuirkSessionOptions = {}) {
  const runtime = await fauxRuntime();
  const cwd = join(dir, `cwd-${Math.random().toString(36).slice(2)}`);
  mkdirSync(cwd, { recursive: true });
  const settingsManager = (o.settingsManager as never) ?? SettingsManager.inMemory({ cacheWarming: "off", retry: { enabled: false }, compaction: { keepRecentTokens: 1 }, ...o.settings } as never);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: dir,
    settingsManager,
    extensionFactories: (o.extensions ?? []) as never,
    additionalExtensionPaths: o.extensionPaths ?? [],
    ...(o.appendSystemPrompt ? { appendSystemPromptOverride: o.appendSystemPrompt } : {}),
  });
  await resourceLoader.reload();
  const sessionManager = o.file ? SessionManager.open(o.file, undefined, cwd) : SessionManager.inMemory(cwd);
  o.beforeBuild?.(sessionManager);
  const modelId = o.model === undefined ? "faux-1" : o.model;
  const { session } = await createAgentSession({
    cwd,
    agentDir: dir,
    modelRuntime: runtime,
    ...(modelId ? { model: runtime.getModel("faux", modelId) } : {}),
    sessionManager,
    settingsManager,
    resourceLoader,
    ...(o.builtinTools ? {} : { noTools: "builtin" as const }),
  });
  await session.bindExtensions({});
  const model = new ScriptedModel().attach(session);
  const events: any[] = [];
  session.subscribe((e: any) => void events.push(e));
  return { session, model, events, runtime, sm: session.sessionManager as any };
}

/** Wait (a real wait, polled) until `cond` holds. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (const end = Date.now() + 5000; !cond(); ) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** A session file holding only its header (pi's own shape), so SessionManager.open writes appends at once. */
function headerFile(name: string): string {
  const file = join(dir, `${name}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: `${name}-session`, timestamp: new Date().toISOString(), cwd: dir })}\n`);
  return file;
}

const userText = (m: any): string =>
  typeof m?.content === "string" ? m.content : (m?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
const lastUser = (call: { context: unknown }): string => userText((call.context as any).messages.filter((m: any) => m.role === "user").at(-1));
/** The system prompt a request carried: pi 0.87 sends it as system messages of diffed sections. */
const systemPromptOf = (call: { context: unknown }): string =>
  JSON.stringify([(call.context as any).systemPrompt ?? null, ...(call.context as any).messages.filter((m: any) => m.role === "system")]);

/** A fixture extension answering session_before_compact (pi then writes the compaction with no model call). */
const compactor = (respond: (event: any) => unknown) => (api: any) => api.on("session_before_compact", (event: any) => respond(event));
const summaryOf = (event: any) => ({ compaction: { summary: "## Summary\nthe contract so far", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: 1 } });

describe("pi contract", () => {
  test("C1: the session manager's append* methods are the ones Sova's reader knows", () => {
    const appends = Object.getOwnPropertyNames(SessionManager.prototype).filter((n) => /^append/.test(n)).sort();
    // A new append* is a new entry type: the transcript reader (M2: server/harness/pi/reader.ts) needs a review.
    assert.deepEqual(appends, [
      "appendCompaction", "appendContextEdit", "appendCustomEntry", "appendCustomMessageEntry", "appendLabelChange", "appendMessage",
      "appendModelChange", "appendSessionInfo", "appendThinkingLevelChange", "appendUsage",
    ]);
  });

  test("C2: a custom entry is one line {type, customType, data, id, parentId, timestamp}, data as passed", () => {
    const file = join(dir, "c2.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "c2-session", timestamp: new Date().toISOString(), cwd: dir })}\n`);
    const sm = SessionManager.open(file);
    const first = sm.appendCustomEntry("sova-contract", { b: 1, a: { z: 2, y: [3] } });
    const second = sm.appendCustomEntry("sova-contract", null);
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 3, "an opened file writes each append at once");
    const one = JSON.parse(lines[1]!);
    assert.deepEqual(Object.keys(one), ["type", "customType", "data", "id", "parentId", "timestamp"]);
    assert.equal(one.type, "custom");
    assert.equal(one.customType, "sova-contract");
    assert.equal(JSON.stringify(one.data), '{"b":1,"a":{"z":2,"y":[3]}}', "data keeps the caller's key order");
    assert.equal(one.id, first);
    assert.match(one.id, /^[0-9a-f]{8}$/);
    assert.equal(one.parentId, null);
    assert.match(one.timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const two = JSON.parse(lines[2]!);
    assert.equal(two.id, second);
    assert.equal(two.parentId, first, "the next entry is parented on the leaf");
    assert.equal(two.data, null);
  });

  test("C3: a run, a steer, a retry and a compaction emit the events and fields bind() reads", async () => {
    const { session, faux, events } = await scriptedSession();
    let steered = false;
    session.subscribe((e: any) => {
      if (e.type === "tool_execution_start" && !steered) {
        steered = true;
        void session.steer("and then this");
      }
    });
    faux.setResponses([
      fauxAssistantMessage([fauxText("calling"), fauxToolCall("echo", { text: "hi" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 Service Unavailable: the server is overloaded" }),
      fauxAssistantMessage("done"),
      fauxAssistantMessage("after the steer"),
    ]);
    await session.prompt("go");
    await session.waitForIdle();
    const summary = () => fauxAssistantMessage("## Summary\nthe conversation so far");
    faux.setResponses([summary(), summary(), summary()]);
    await session.compact();
    const types = new Set(events.map((e) => e.type));
    for (const t of [
      "agent_start", "agent_end", "agent_settled", "turn_end", "message_start", "message_update", "message_end", "tool_execution_start",
      "tool_execution_end", "queue_update", "compaction_start", "compaction_end", "entry_appended", "auto_retry_start", "auto_retry_end",
    ])
      assert.ok(types.has(t), `no ${t} event (saw ${[...types].join(", ")})`);
    const parts = new Set(events.filter((e) => e.type === "message_update").map((e) => e.assistantMessageEvent?.type));
    for (const t of ["text_start", "text_delta", "text_end", "toolcall_start", "toolcall_end"]) assert.ok(parts.has(t), `no message_update ${t}`);
    const end = events.find((e) => e.type === "message_end" && e.message?.role === "assistant");
    assert.ok(end.message.content && end.message.stopReason, "message_end carries the message");
    const tool = events.find((e) => e.type === "tool_execution_end");
    assert.equal(tool.toolName, "echo");
    assert.equal(typeof tool.toolCallId, "string");
    assert.equal(tool.isError, false);
    assert.ok(tool.result);
    const queue = events.find((e) => e.type === "queue_update");
    assert.ok(Array.isArray(queue.steering) && Array.isArray(queue.followUp), "queue_update has steering and followUp");
    const appended = events.find((e) => e.type === "entry_appended");
    assert.ok(appended.entry?.id && appended.entry?.type, "entry_appended carries the entry");
    const compacted = events.find((e) => e.type === "compaction_end");
    assert.ok(compacted.result, `compaction_end carries its result (${compacted.errorMessage ?? ""})`);
    assert.equal(compacted.willRetry, false);
    assert.equal(compacted.aborted, false);
    session.dispose();
  });

  test("C5: prompt and steer take image content {type, data, mimeType} and store it as such", async () => {
    const { session, faux } = await scriptedSession();
    let steered = false;
    session.subscribe((e: any) => {
      if (e.type === "tool_execution_start" && !steered) {
        steered = true;
        void session.steer("and this one", [IMAGE]);
      }
    });
    faux.setResponses([fauxAssistantMessage([fauxToolCall("echo", { text: "x" })], { stopReason: "toolUse" }), fauxAssistantMessage("ok"), fauxAssistantMessage("ok again")]);
    await session.prompt("look", { images: [IMAGE] });
    await session.waitForIdle();
    const users = session.sessionManager.getEntries().filter((e: any) => e.type === "message" && e.message.role === "user") as any[];
    assert.equal(users.length, 2);
    for (const u of users) assert.deepEqual(u.message.content.find((c: any) => c.type === "image"), IMAGE);
    session.dispose();
  });

  // ---- The quirk canaries (QUIRKS.md). A failure means pi changed under a Sova workaround: find the row. ----

  test("P1 open-writes-nothing: building a session on a message-less file appends model and thinking through the manager's instance methods", async () => {
    const recorded = (name: string) => {
      const file = headerFile(name);
      SessionManager.open(file).appendModelChange("faux", "faux-1");
      return file;
    };
    // Unpatched, the SDK writes at construction, restating the recorded model.
    const plain = recorded("p1-plain");
    const before = readFileSync(plain, "utf8");
    const a = await quirkSession({ file: plain });
    const grown = readFileSync(plain, "utf8").slice(before.length).trimEnd().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(grown.map((e) => e.type), ["model_change", "thinking_level_change"], "fixed: construction no longer writes; Sova's deferral (openSession) may go");
    assert.deepEqual([grown[0].provider, grown[0].modelId], ["faux", "faux-1"], "the first append restates the recorded model (restatesRecordedModel drops it)");
    a.session.dispose();
    // Patched as openSession does, before construction: the instance properties take both calls, the file is untouched.
    const patched = recorded("p1-patched");
    const bytes = readFileSync(patched, "utf8");
    const calls: string[] = [];
    const b = await quirkSession({
      file: patched,
      beforeBuild(sm) {
        sm.appendModelChange = (provider: string, modelId: string) => (calls.push(`model ${provider}/${modelId}`), "");
        sm.appendThinkingLevelChange = (level: string) => (calls.push(`thinking ${level}`), "");
      },
    });
    assert.equal(readFileSync(patched, "utf8"), bytes, "opening through the patch writes nothing");
    assert.equal(calls.length, 2);
    assert.equal(calls[0], "model faux/faux-1");
    assert.match(calls[1]!, /^thinking \w+$/);
    b.session.dispose();
  });

  test("P2 compaction-write-wrap: compact() writes through the session manager's appendCompaction instance property", async () => {
    const { session, sm } = await quirkSession({ extensions: [compactor(summaryOf)] });
    await session.prompt("one");
    await session.prompt("two");
    const append = sm.appendCompaction;
    const ids: string[] = [];
    sm.appendCompaction = (...args: unknown[]) => {
      const id = append.apply(sm, args);
      ids.push(id);
      return id;
    };
    try {
      await session.compact();
    } finally {
      sm.appendCompaction = append;
    }
    assert.equal(ids.length, 1, "fixed or moved: compact() no longer writes through sm.appendCompaction; compactSession's wrap sees nothing");
    assert.equal(sm.getBranch().at(-1)?.id, ids[0]);
    assert.equal(sm.getBranch().at(-1)?.type, "compaction");
    session.dispose();
  });

  test("P3 compaction-error-text: pi's compaction refusals and its prompt-while-compacting error read as Sova matches them", async () => {
    const empty = await quirkSession();
    await assert.rejects(empty.session.compact(), (e: Error) => e.message.startsWith("Nothing to compact"));
    empty.session.dispose();
    let respond: (event: any) => unknown = summaryOf;
    const { session, model } = await quirkSession({ extensions: [compactor((e) => respond(e))] });
    model.reply({ text: "a longer reply, so there is something before the kept tail" }, { text: "and another" });
    await session.prompt("one");
    await session.prompt("two");
    await session.compact();
    await assert.rejects(session.compact(), (e: Error) => e.message === "Already compacted");
    await session.prompt("three");
    await session.prompt("four");
    respond = () => ({ cancel: true });
    await assert.rejects(session.compact(), (e: Error) => e.message === "Compaction cancelled");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    respond = async (e) => (await gate, summaryOf(e));
    const compacting = session.compact();
    await until(() => session.isCompacting, "the held compaction");
    await assert.rejects(session.prompt("during"), (e: Error) => e.message.startsWith("Cannot submit a prompt while compaction is in progress"));
    release();
    await compacting;
    session.dispose();
  });

  test("P4 already-processing: a prompt mid-run without streamingBehavior, and the agent's own prompt mid-run, fail /already processing/i", async () => {
    const { session, model } = await quirkSession();
    const release = model.hold();
    const run = session.prompt("one");
    await until(() => model.calls.length === 1, "the model call");
    await assert.rejects(session.prompt("two"), /already processing/i);
    // linkToSdk's race: the streaming check passed, then another run won; the agent refuses in the same words.
    await assert.rejects(Promise.resolve().then(() => session.agent.prompt({ role: "user", content: [{ type: "text", text: "three" }], timestamp: Date.now() })), /already processing/i);
    release();
    await run;
    session.dispose();
  });

  test("P5 settle-window: inside an agent_settled emit _isEmittingAgentSettled is true and a prompt resolves at once, its turn running after", async () => {
    const { session, model } = await quirkSession();
    const order: string[] = [];
    let inside: unknown;
    let deferred: Promise<void> | undefined;
    session.subscribe((e: any) => {
      if (e.type === "agent_end") order.push("agent_end");
      if (e.type !== "agent_settled" || deferred) return;
      inside = (session as any)._isEmittingAgentSettled;
      deferred = session.prompt("deferred");
      void deferred.then(() => order.push("resolved"));
    });
    await session.prompt("first");
    await until(() => order.filter((o) => o === "agent_end").length === 2, "the deferred turn");
    assert.equal(inside, true, "the private flag deliverTopicBatch reads is set inside the settle emit");
    assert.equal((session as any)._isEmittingAgentSettled, false, "and cleared after it");
    assert.deepEqual(order, ["agent_end", "resolved", "agent_end"], "fixed: the prompt is no longer deferred (or no longer resolves at once)");
    assert.equal(lastUser(model.calls[1]!), "deferred");
    session.dispose();

    // What Sova builds on it (§app.chat-processes/worker-instructions): a deferred prompt runs outside the
    // async context of the call that made it, so a keyed send labels nothing there (send-keys.ts); a keyed
    // item handed off from the queue during agent_settled waits the window out (queue.ts `settling`) and
    // its delivered user message carries exactly that key, once.
    const two = await quirkSession();
    const harness = new PiHarnessSession({ session: two.session } as never);
    const keys = new SendKeys();
    keys.watch(harness);
    let fired = false;
    const queue = new WebQueue({
      sdk: { hasQueued: () => harness.queue.hasQueued(), mirrorTotal: () => harness.queue.mirrorTotal(), mirrorFor: (k) => harness.queue.mirrorFor(k), mirrorHas: (k, t) => harness.queue.mirrorHas(k, t) },
      streaming: () => harness.isRunning(),
      settling: () => harness.inSettleWindow(),
      clearSdkQueue: () => harness.queue.clear(),
      guard() {},
      wake() {},
      // As ChatSession.handOffQueued: the SDK call inside the key's send; an idle one starts a turn, not awaited.
      handOff: async (item, streaming) => {
        const turn = keys.run(item.key, () => harness.send(item.text, streaming ? { delivery: item.kind } : undefined));
        if (streaming) await turn;
        else void turn.catch(() => {});
      },
      onGone() {},
      onChange() {},
      onHandOffError() {},
    });
    let unkeyedTwin: Promise<void> | undefined;
    two.session.subscribe((e: any) => {
      if (e.type !== "agent_settled" || fired) return;
      fired = true;
      // The control: a keyed send made straight into the window (no queue) is deferred and labels nothing.
      unkeyedTwin = keys.run("w:direct", () => harness.send("direct in the window"));
      queue.enqueue({ kind: "followUp", text: "keyed in the window", origin: "server", id: "q1", key: "w:s1" });
    });
    await two.session.prompt("first");
    await until(() => two.model.calls.length >= 3, "the deferred and the held turns");
    await unkeyedTwin;
    await two.session.waitForIdle?.();
    const userStarts = two.events.filter((e) => e.type === "message_start" && e.message?.role === "user");
    const keyedOnes = userStarts.filter((e) => keys.keyOf(e.message) === "w:s1");
    assert.equal(keyedOnes.length, 1, "the keyed hand-off's message carries its key, once");
    assert.equal(userText(keyedOnes[0].message), "keyed in the window");
    const direct = userStarts.find((e) => userText(e.message) === "direct in the window");
    assert.ok(direct, "the deferred prompt ran");
    assert.equal(keys.keyOf(direct.message), undefined, "fixed: a prompt deferred past the settle window now runs inside its sender's context");
    queue.close();
    two.session.dispose();
  });

  test("P6 refresh-context: a user entry appended outside a run reaches the agent's context after refreshContext()", async () => {
    const { session, model, sm } = await quirkSession();
    await session.prompt("first");
    const inContext = (t: string) => session.agent.state.messages.some((m: any) => m.role === "user" && userText(m) === t);
    const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
    sm.appendMessage(user("queued one"));
    assert.equal(inContext("queued one"), false, "an append alone leaves the agent's context as it was");
    sm.appendMessage(user("queued two"));
    assert.equal(inContext("queued two"), false);
    session.refreshContext();
    assert.ok(inContext("queued one") && inContext("queued two"), "refreshContext() re-reads both, as PiHarnessSession.refreshContext relies on");
    await session.prompt("next");
    const users = (model.calls[1]!.context as any).messages.filter((m: any) => m.role === "user").map(userText);
    assert.deepEqual(users.slice(-3), ["queued one", "queued two", "next"]);
    session.dispose();
  });

  test("P7 user-turns-wrap: prompt, steer and followUp reach the agent by property lookup, and the object passed is the one message_start carries", async () => {
    const { session, model, events } = await quirkSession();
    const agent = session.agent as any;
    const claimed = new Map<string, unknown>();
    for (const name of ["prompt", "steer", "followUp"]) {
      const inner = agent[name];
      agent[name] = (...args: unknown[]) => {
        const input = args[0];
        const m = (Array.isArray(input) ? input : [input]).find((x: any) => x?.role === "user");
        if (m) claimed.set(name, m);
        return inner.apply(agent, args);
      };
    }
    const release = model.hold();
    const run = session.prompt("by prompt");
    await until(() => model.calls.length === 1, "the model call");
    await session.steer("by steer");
    await session.followUp("by followUp");
    release();
    await run;
    await until(() => model.calls.length === 3, "the steer and the follow-up");
    assert.deepEqual([...claimed.keys()].sort(), ["followUp", "prompt", "steer"], "each input reaches the agent through its own property");
    for (const [name, m] of claimed) {
      const start = events.find((e) => e.type === "message_start" && e.message?.role === "user" && userText(e.message) === `by ${name}`);
      assert.ok(start, `no message_start for ${name}`);
      assert.equal(start.message, m, `${name}: message_start carries the very object the agent was handed`);
    }
    session.dispose();
  });

  test("P8 stream-function: agent.streamFunction is read at each request, so one assigned after construction answers the next turn", async () => {
    const { session } = await quirkSession();
    await session.prompt("first");
    const seen: string[] = [];
    const inner = session.agent.streamFunction;
    session.agent.streamFunction = ((m: unknown, context: unknown, o: unknown) => (seen.push(lastUser({ context })), (inner as any)(m, context, o))) as never;
    await session.prompt("second");
    assert.deepEqual(seen, ["second"]);
    session.dispose();
  });

  test("P9 queue-one-bit: an image-only steer stays in the mirror after delivery while the agent's queue is empty; clearQueue() returns both kinds; continue() takes steering first", async () => {
    const { session, model } = await quirkSession();
    let release = model.hold();
    let run = session.prompt("first");
    await until(() => model.calls.length === 1, "the model call");
    await session.steer("", [IMAGE]);
    assert.deepEqual([...session.getSteeringMessages()], [""]);
    assert.equal(session.agent.hasQueuedMessages(), true);
    release();
    await run;
    assert.equal(lastUser(model.calls[1]!), "", "the image-only steer was delivered");
    assert.equal(session.agent.hasQueuedMessages(), false, "the agent's real queue is empty");
    assert.deepEqual([...session.getSteeringMessages()], [""], "fixed: the mirror now drops a delivered image-only steer; queue.ts's sdkHolds can trust it");
    assert.deepEqual(session.clearQueue(), { steering: [""], followUp: [] });
    release = model.hold();
    run = session.prompt("second");
    await until(() => model.calls.length === 3, "the model call");
    await session.steer("s");
    await session.followUp("f");
    assert.deepEqual(session.clearQueue(), { steering: ["s"], followUp: ["f"] });
    assert.equal(session.agent.hasQueuedMessages(), false, "clearQueue() empties the agent's queues too");
    release();
    await run;
    const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }) as never;
    session.agent.followUp(user("follow"));
    session.agent.steer(user("steer"));
    await session.agent.continue();
    assert.deepEqual(model.calls.slice(-2).map(lastUser), ["steer", "follow"], "continue() drains steering before follow-ups");
    assert.equal(typeof session.agent.peekQueuedMessages, "function", "peekQueuedMessages, which Sova does not use yet, is still there");
    session.dispose();
  });

  test("P10 leaf-is-last-line: navigateTree({summarize:false}) writes nothing and moves only the in-memory leaf; open() takes the last line as the leaf", async () => {
    const file = headerFile("p10");
    const { session, sm } = await quirkSession({ file });
    await session.prompt("one");
    await session.prompt("two");
    const u2 = sm.getBranch().find((e: any) => e.type === "message" && e.message.role === "user" && userText(e.message) === "two");
    const bytes = readFileSync(file, "utf8");
    const last = sm.getLeafId();
    const result = await session.navigateTree(u2.id, { summarize: false });
    assert.equal(result.cancelled, false);
    assert.equal(readFileSync(file, "utf8"), bytes, "navigating writes nothing");
    assert.equal(sm.getLeafId(), u2.parentId, "the in-memory leaf moved to before the input");
    assert.equal(SessionManager.open(file).getLeafId(), last, "fixed: pi persists the leaf; rewindSession's marker may be unneeded");
    const marker = sm.appendCustomEntry("sova-contract-marker", {});
    const reopened = SessionManager.open(file);
    assert.equal(reopened.getLeafId(), marker, "an append after the move holds the leaf on reopen");
    assert.equal(reopened.getEntry(marker)?.parentId, u2.parentId);
    session.dispose();
  });

  test("P11 create-defers / open-flushed: a created session's appends stay unwritten until a user or assistant message; an opened header-only file writes each append at once", () => {
    const created = SessionManager.create(dir, join(dir, "p11-sessions"));
    created.appendCustomEntry("sova-contract", { n: 1 });
    const file = created.getSessionFile();
    assert.ok(file);
    assert.equal(existsSync(file), false, "a created file stays unwritten (Sova's creators write [header, ...seed] themselves)");
    const opened = headerFile("p11");
    SessionManager.open(opened).appendCustomEntry("sova-contract", { n: 2 });
    assert.equal(readFileSync(opened, "utf8").trimEnd().split("\n").length, 2, "an opened file takes the append at once");
  });

  test("P12 message-end-before-persist: message_end listeners run before the entry is appended; one microtask later it is the leaf", async () => {
    const { session, sm } = await quirkSession();
    const seen: { before: boolean; after?: boolean }[] = [];
    session.subscribe((e: any) => {
      if (e.type !== "message_end" || e.message?.role !== "user") return;
      const leafHolds = () => {
        const leaf = sm.getLeafId();
        return !!leaf && sm.getEntry(leaf)?.message === e.message;
      };
      const s: { before: boolean; after?: boolean } = { before: leafHolds() };
      seen.push(s);
      queueMicrotask(() => (s.after = leafHolds()));
    });
    await session.prompt("one");
    assert.deepEqual(seen, [{ before: false, after: true }], "fixed: pi now emits after persisting; markSend/markTopic/holdForEntryId's microtask may go");
    session.dispose();
  });

  test("P13 no-entry-appended: setThinkingLevel and a compaction write without entry_appended; an extension's appendEntry emits it", async () => {
    let ext: any;
    const { session, sm, events } = await quirkSession({ model: "faux-r", extensions: [compactor(summaryOf), (api) => void (ext = api)] });
    const appended = () => events.filter((e) => e.type === "entry_appended");
    const n0 = appended().length;
    session.setThinkingLevel(session.thinkingLevel === "low" ? "high" : "low");
    assert.equal(sm.getEntries().at(-1)?.type, "thinking_level_change");
    assert.equal(appended().length, n0, "fixed: setThinkingLevel emits entry_appended; setThinking's synthesized row may go");
    await session.prompt("one");
    await session.prompt("two");
    const n1 = appended().length;
    await session.compact();
    assert.equal(sm.getBranch().at(-1)?.type, "compaction");
    assert.equal(appended().length, n1, "fixed: a compaction emits entry_appended; refreshAfterCompaction's re-read may go");
    ext.appendEntry("sova-contract", { n: 1 });
    assert.equal(appended().length, n1 + 1);
    assert.equal(appended().at(-1).entry.customType, "sova-contract");
    session.dispose();
  });

  test("P14 command-direct-call: getCommand finds an extension's command with its source path, and its handler runs outside prompt() with createCommandContext()'s ctx", async () => {
    const extDir = join(dir, "p14", "extensions", "mode");
    mkdirSync(extDir, { recursive: true });
    const path = join(extDir, "index.ts");
    writeFileSync(
      path,
      'export default function (pi) {\n  pi.registerCommand("mode", { description: "contract fixture", handler: async (args, ctx) => {\n    globalThis.__sovaContractP14 = { args, branch: typeof ctx.sessionManager?.getBranch };\n  } });\n}\n',
    );
    const { session } = await quirkSession({ extensionPaths: [path] });
    const cmd = session.extensionRunner.getCommand("mode");
    assert.ok(cmd, "the command is found by name");
    assert.equal(typeof cmd.handler, "function");
    assert.match(cmd.sourceInfo?.path ?? "", /[\\/]extensions[\\/]mode[\\/]index\.ts$/, "the owner check (modeCommand) reads sourceInfo.path");
    await cmd.handler("sync", session.extensionRunner.createCommandContext());
    assert.deepEqual((globalThis as any).__sovaContractP14, { args: "sync", branch: "function" });
    session.dispose();
  });

  test("P15 accept-vs-complete: prompt() resolves at turn end while preflightResult(\"started\") fires at acceptance (\"handled\" for a handled command, no call for a refused prompt)", async () => {
    const { session, model, events } = await quirkSession({ extensions: [(api) => api.registerCommand("contract", { description: "fixture", handler: async () => {} })] });
    const order: string[] = [];
    const release = model.hold();
    const run = session.prompt("one", { preflightResult: (d) => void order.push(`preflight ${d}`) }).then(() => void order.push("resolved"));
    await until(() => model.calls.length === 1, "the model call");
    assert.deepEqual(order, ["preflight started"], "accepted, not yet complete");
    assert.equal(events.some((e) => e.type === "agent_end"), false);
    const refused: string[] = [];
    await assert.rejects(session.prompt("two", { preflightResult: (d) => void refused.push(d) }), /already processing/);
    assert.deepEqual(refused, [], "a refused prompt gets no preflight call (0.87.1: false); linkToSdk settles on the rejection");
    release();
    await run;
    assert.deepEqual(order, ["preflight started", "resolved"]);
    const handled: string[] = [];
    await session.prompt("/contract", { preflightResult: (d) => void handled.push(d) });
    assert.deepEqual(handled, ["handled"]);
    assert.equal(model.calls.length, 1, "a handled command makes no model call");
    session.dispose();
  });

  test("P16 custom-message-idle: sendCustomMessage with triggerTurn:false on an idle session appends at once and emits message_start then message_end", async () => {
    const { session, sm, events, model } = await quirkSession();
    const n = events.length;
    await session.sendCustomMessage({ customType: "sova-contract-note", content: "a note", display: true }, { triggerTurn: false });
    const last = sm.getEntries().at(-1);
    assert.equal(last?.type, "custom_message");
    assert.equal(last?.customType, "sova-contract-note");
    assert.deepEqual(events.slice(n).map((e) => `${e.type} ${e.message?.role}`), ["message_start custom", "message_end custom"]);
    assert.equal(model.calls.length, 0, "no turn");
    session.dispose();
  });

  test("P17 theme-global: initTheme registers the theme on globalThis under pi's Symbol.for key", () => {
    initTheme(undefined, false);
    const theme = (globalThis as any)[Symbol.for("@earendil-works/pi-coding-agent:theme")];
    assert.equal(typeof theme, "object", "fixed or renamed: currentTheme (harness/pi/ui-bridge.ts) reads this key");
    assert.ok(theme);
  });

  test("P18 warmup-shutdown: bindExtensions emits session_start; a bare dispose() skips session_shutdown, which the runner's emit delivers", async () => {
    const counter = (seen: string[]) => (api: any) => {
      api.on("session_start", () => void seen.push("start"));
      api.on("session_shutdown", () => void seen.push("shutdown"));
    };
    const bare: string[] = [];
    const a = await quirkSession({ extensions: [counter(bare)] });
    assert.deepEqual(bare, ["start"], "bindExtensions emits session_start");
    a.session.dispose();
    assert.deepEqual(bare, ["start"], "fixed: dispose() now emits session_shutdown; warmClaudeCodeProvider's own emit would double it");
    const warm: string[] = [];
    const b = await quirkSession({ extensions: [counter(warm)] });
    assert.equal(b.session.extensionRunner.hasHandlers("session_shutdown"), true);
    await b.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" } as never);
    b.session.dispose();
    assert.deepEqual(warm, ["start", "shutdown"]);
  });

  test("P19 rebuild-prompt: setActiveToolsByName(getActiveToolNames()) re-reads the loader's appendSystemPrompt parts", async () => {
    const parts: string[] = [];
    const { session, model } = await quirkSession({
      appendSystemPrompt: (base) => (parts.splice(0, parts.length, ...base, "CONTRACT-PART-ONE"), parts),
    });
    await session.prompt("one");
    assert.match(systemPromptOf(model.calls[0]!), /CONTRACT-PART-ONE/);
    parts.splice(parts.length - 1, 1, "CONTRACT-PART-TWO");
    await session.prompt("two");
    assert.match(systemPromptOf(model.calls[1]!), /CONTRACT-PART-ONE/, "fixed: a run re-reads the parts itself; LivePrompt.rebase's rebuild may go");
    assert.doesNotMatch(systemPromptOf(model.calls[1]!), /CONTRACT-PART-TWO/);
    session.setActiveToolsByName(session.getActiveToolNames());
    assert.match(session.systemPrompt, /CONTRACT-PART-TWO/);
    assert.doesNotMatch(session.systemPrompt, /CONTRACT-PART-ONE/);
    await session.prompt("three");
    assert.match(systemPromptOf(model.calls[2]!), /CONTRACT-PART-TWO/, "the next request carries the new part");
    session.dispose();
  });

  test("P20 model-restore-gate: the SDK restores a recorded model only when the branch has messages", async () => {
    const settings = { defaultProvider: "faux", defaultModel: "faux-1" };
    const empty = headerFile("p20-empty");
    SessionManager.open(empty).appendModelChange("faux", "faux-2");
    const a = await quirkSession({ file: empty, model: null, settings });
    assert.equal(a.session.model?.id, "faux-1", "fixed: a message-less file's recorded model is restored; recordedModelForEmptyBranch may go");
    a.session.dispose();
    const used = headerFile("p20-used");
    const sm = SessionManager.open(used);
    sm.appendModelChange("faux", "faux-2");
    sm.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() } as never);
    const b = await quirkSession({ file: used, model: null, settings });
    assert.equal(b.session.model?.id, "faux-2", "with messages the recorded model is restored");
    b.session.dispose();
  });

  test("P21 codemode-definition: the factory registers one inactive codemode tool, its models.* reach ctx.modelRegistry, nested calls carry parentToolCallId", async () => {
    const registered: any[] = [];
    let registryAsked = 0;
    const capture = (api: any) => {
      const caught = new Proxy(api, { get: (t, k) => (k === "registerTool" ? (def: any) => void registered.push(def) : Reflect.get(t, k)) });
      pi.agent.createCodemodeExtension()(caught);
      const def = registered[0];
      // As Sova's scriptRegistry does: the context's registry, seen through a wrapper.
      api.registerTool({
        ...def,
        execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: any) =>
          def.execute(id, params, signal, onUpdate, new Proxy(ctx, {
            get: (t, k) => {
              // Members as they are (a Proxy must return pi's read-only executeTool unchanged).
              if (k !== "modelRegistry") return Reflect.get(t, k);
              return new Proxy(t.modelRegistry, { get: (r, m) => { if (m === "classify") registryAsked++; const v = Reflect.get(r, m); return typeof v === "function" ? v.bind(r) : v; } });
            },
          })),
      });
      api.registerTool({ name: "echo", label: "echo", description: "echo", parameters: Type.Object({ word: Type.String() }), execute: async (_id: string, p: { word: string }) => ({ content: [{ type: "text", text: p.word }], details: {} }) });
    };
    const { session, model, events, runtime, sm } = await quirkSession({ extensions: [capture] });
    assert.deepEqual(registered.map((d) => [d.name, d.defaultActive]), [["codemode", false]], "one tool, codemode, registered inactive");
    assert.ok(!session.getActiveToolNames().includes("codemode"), "inactive after the build");
    session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
    assert.ok(session.getActiveToolNames().includes("codemode"), "setActiveTools activates it");
    (runtime as any).registerProvider("cls", {
      apiKey: "test",
      models: [{ type: "classifier", id: "cls-1", name: "cls-1", api: "test-classifier", baseUrl: "http://127.0.0.1:9", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000 }],
      classifiers: { "test-classifier": { classify: async () => ({ provider: "cls", model: "cls-1", answers: { q: { type: "bool", probability: 1 } }, stopReason: "stop" }) } },
    });
    const code = `const w = await tools.echo({ word: "hi" });
const r = await models.classify({ provider: "cls", id: "cls-1" }, { state: {}, questions: { q: { type: "bool", instructions: "?", criteria: { true: "y", false: "n" } } } });
return w + ":" + r.stopReason;`;
    model.reply({ toolCall: { name: "codemode", arguments: { code } } }, { text: "done" });
    await session.prompt("go");
    const nested = events.filter((e) => e.type?.startsWith("tool_execution_") && e.parentToolCallId);
    assert.ok(nested.length >= 2, "the nested call's events carry parentToolCallId");
    assert.ok(nested.every((e) => e.parentToolCallId === "call-1" && e.toolCallId === "call-1/1"), "and the id <parent>/<n>");
    assert.equal(registryAsked, 1, "the script's models.classify went through ctx.modelRegistry");
    const results = sm.getEntries().filter((e: any) => e.type === "message" && e.message.role === "toolResult");
    assert.deepEqual(results.map((e: any) => e.message.toolName), ["codemode"], "nested calls write no entries");
    assert.match(results[0].message.content.map((b: any) => b.text ?? "").join(""), /hi:stop/);
    assert.deepEqual(results[0].message.details.calls.map((c: any) => c.name), ["echo", "models.classify"]);
    session.dispose();
  });

  test("P22 declared-tools: agent.state.tools is the declared set with the loadout's descriptions, _hiddenDeclarations what requests leave out, sourceInfo.path names the source", async () => {
    /** The tools a request declared: its system messages' toolsAdded, less toolsRemoved, in order. */
    const declaredIn = (call: { context: unknown }) => {
      const tools = new Map<string, string>();
      for (const m of (call.context as { messages: any[] }).messages) {
        if (m.role !== "system") continue;
        for (const r of m.toolsRemoved ?? []) tools.delete(typeof r === "string" ? r : r.name);
        for (const t of m.toolsAdded ?? []) tools.set(t.name, t.description);
      }
      return tools;
    };
    for (const mode of ["on", "only"] as const) {
      const tools = (api: any) => {
        pi.agent.createCodemodeExtension({ mode })(api);
        api.registerTool({ name: "echo", label: "echo", description: "Echo a word.", parameters: Type.Object({ word: Type.String() }), execute: async () => ({ content: [], details: {} }) });
      };
      const { session, model } = await quirkSession({ extensions: [{ name: "contract-tools", factory: tools } as never], builtinTools: true });
      const s = session as any;
      session.setActiveToolsByName(["read", "echo", "codemode"]);
      const state = s.agent.state.tools as { name: string; description: string }[];
      assert.deepEqual(state.map((t) => t.name), ["read", "echo", "codemode"], "the active tools, in order");
      const registry = new Map(session.getAllTools().map((t: any) => [t.name, t]));
      const echo = state.find((t) => t.name === "echo")!;
      if (mode === "on") {
        assert.equal((registry.get("echo") as any).description, "Echo a word.", "the registry keeps the tool's own description");
        assert.match(echo.description, /^Echo a word\.\n\nCodemode: `tools\.echo\(args\)`/, "the loadout's description is on agent.state.tools");
      }
      assert.ok(s._hiddenDeclarations instanceof Set, "_hiddenDeclarations is a Set");
      assert.equal(s._hiddenDeclarations.has("echo"), mode === "only", "codemode's only mode hides direct tools' declarations");
      assert.equal((registry.get("read") as any).sourceInfo.path, "builtin:read");
      assert.equal((registry.get("echo") as any).sourceInfo.path, "<inline:contract-tools>");
      model.reply({ text: "ok" });
      await session.prompt("go");
      const sent = declaredIn(model.calls[0]!);
      const expected = state.filter((t) => !s._hiddenDeclarations.has(t.name));
      assert.deepEqual([...sent.keys()].sort(), expected.map((t) => t.name).sort(), "the request declares agent.state.tools less the hidden ones");
      for (const t of expected) assert.equal(sent.get(t.name), t.description, `${t.name}: the request's description is agent.state.tools'`);
      session.dispose();
    }
  });

  test("P23 turn-end-loadout: a tool registered at turn_end is declared in the next request of the same run, beside the steered message; one registered at turn_start is not", async () => {
    /** The tools a request declared: its system messages' toolsAdded, less toolsRemoved. */
    const declaredIn = (call: { context: unknown }) => {
      const tools = new Set<string>();
      for (const m of (call.context as { messages: any[] }).messages) {
        if (m.role !== "system") continue;
        for (const r of m.toolsRemoved ?? []) tools.delete(typeof r === "string" ? r : r.name);
        for (const t of m.toolsAdded ?? []) tools.add(t.name);
      }
      return tools;
    };
    const tool = (name: string) => ({ name, label: name, description: `The ${name} tool.`, parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: name }], details: {} }) });
    let turnEnds = 0;
    let turnStarts = 0;
    const late = (api: any) => {
      api.registerTool(tool("echo"));
      // The first step's end and the second step's start, both inside the one run.
      api.on("turn_end", () => {
        if (++turnEnds === 1) api.registerTool(tool("at_turn_end"));
      });
      api.on("turn_start", () => {
        if (++turnStarts === 2) api.registerTool(tool("at_turn_start"));
      });
    };
    const { session, model } = await quirkSession({ extensions: [{ name: "contract-late", factory: late } as never] });
    model.reply(
      async () => {
        await session.steer("steered while the tool ran");
        return { toolCall: { name: "echo", arguments: {} } };
      },
      { toolCall: { name: "echo", arguments: {} } },
      { text: "done" },
    );
    await session.prompt("go");
    assert.equal(model.calls.length, 3, "one run, three requests");
    const [first, second, third] = model.calls.map(declaredIn);
    assert.ok(first!.has("echo") && !first!.has("at_turn_end"), "the first request: the tools from the start");
    assert.ok(second!.has("at_turn_end"), "registered at turn_end: declared in the next request of the same run");
    assert.ok(JSON.stringify((model.calls[1]!.context as { messages: unknown[] }).messages).includes("steered while the tool ran"), "the request that carries the steered message");
    assert.ok(!second!.has("at_turn_start"), "registered at turn_start: too late for that request (fixed: pi builds the loadout after turn_start)");
    assert.ok(third!.has("at_turn_start"), "the control: it is declared in the request after");
    session.dispose();
  });

  test("P24 own-code-discovery: resolve() is the loader's only source of discovered extension paths: patched, the same extensions load, Sova's from the copy", async () => {
    const { createAgentSessionServices, DefaultPackageManager } = pi.agent;
    const t = join(dir, "p24");
    const ext = (file: string, name: string) => {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, `export default (pi) => { pi.registerCommand(${JSON.stringify(name)}, { description: "p24", handler: async () => {} }); };\n`);
    };
    // A Sova checkout and its copy; the agent dir links into the checkout.
    ext(join(t, "live", "pi-config", "extensions", "linked", "index.ts"), "linked");
    ext(join(t, "own", "pi-config", "extensions", "linked", "index.ts"), "linked");
    const agentDir = join(t, "agent");
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    symlinkSync(join(t, "live", "pi-config", "extensions", "linked"), join(agentDir, "extensions", "linked"));
    ext(join(agentDir, "extensions", "plain.ts"), "plain");
    ext(join(agentDir, "extensions", "off.ts"), "off");
    // A package with an extensions filter, and a project's own extension.
    ext(join(t, "pkg", "a.ts"), "pkg-a");
    ext(join(t, "pkg", "b.ts"), "pkg-b");
    writeFileSync(join(t, "pkg", "package.json"), JSON.stringify({ name: "p24-pkg", pi: { extensions: ["./a.ts", "./b.ts"] } }));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["!off.ts"], packages: [{ source: join(t, "pkg"), extensions: ["a.ts"] }] }));
    const cwd = join(t, "proj");
    ext(join(cwd, ".pi", "extensions", "proj.ts"), "proj");

    const modelRuntime = await ModelRuntime.create({ authPath: join(t, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const loaded = async () => {
      const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime });
      return new Map<string, string>(services.resourceLoader.getExtensions().extensions.flatMap((e: any) => [...e.commands.keys()].map((k: string) => [k, realpathSync(e.resolvedPath ?? e.path)])));
    };
    const before = await loaded();
    assert.deepEqual([...before.keys()].sort(), ["linked", "pkg-a", "plain", "proj"], "the control: the linked, plain, filtered-package and project extensions load, the disabled one doesn't");
    assert.equal(before.get("linked"), realpathSync(join(t, "live", "pi-config", "extensions", "linked", "index.ts")));
    const unpatch = patchResolve(DefaultPackageManager, { own: realpathSync(join(t, "own")), live: realpathSync(join(t, "live")) });
    try {
      const after = await loaded();
      assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), "the same extensions");
      assert.equal(after.get("linked"), realpathSync(join(t, "own", "pi-config", "extensions", "linked", "index.ts")), "fixed?: pi's loader no longer takes discovered extensions from its package manager's resolve()");
      for (const k of ["pkg-a", "plain", "proj"]) assert.equal(after.get(k), before.get(k), k);
    } finally {
      unpatch();
    }
  });

  test("P25 request-start: the agent hands its stream function options whose onPayload the provider calls once per request, before the reply starts; a wrapped one hears it", async () => {
    const faux = createFauxCore({ provider: "probe", models: [{ id: "probe-1" }] });
    faux.setResponses([fauxAssistantMessage([fauxText("one")]), fauxAssistantMessage([fauxText("two")])]);
    const order: string[] = [];
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerProvider("probe", {
      name: "Probe",
      baseUrl: "http://127.0.0.1:9",
      apiKey: "stub",
      api: faux.api,
      // A real provider calls options.onPayload just before it sends (pi-ai's api/*.js; the claude-code provider).
      streamSimple: (model: any, context: any, options: any) => {
        order.push(typeof options?.onPayload === "function" ? "provider: onPayload given" : "provider: no onPayload");
        void options?.onPayload?.({}, model);
        return faux.streamSimple(model, context, options);
      },
      models: [{ id: "probe-1", name: "Probe 1", input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 4_000 }],
    } as never);
    const cwd = join(dir, `cwd-${Math.random().toString(36).slice(2)}`);
    mkdirSync(cwd, { recursive: true });
    const { session } = await createAgentSession({
      cwd,
      agentDir: dir,
      modelRuntime: runtime,
      model: runtime.getModel("probe", "probe-1"),
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({ cacheWarming: "off", retry: { enabled: false } } as never),
      noTools: "builtin",
    });
    session.subscribe((e: any) => {
      if (e.type === "message_start" && e.message?.role === "assistant") order.push("message_start");
    });
    const off = hearRequests(session.agent as never, () => order.push("heard"));
    await session.prompt("first");
    assert.deepEqual(order, ["provider: onPayload given", "heard", "message_start"], "fixed?: the agent no longer passes its onPayload through its stream function");
    off();
    order.length = 0;
    await session.prompt("second");
    assert.deepEqual(order, ["provider: onPayload given", "message_start"], "a removed listener hears nothing; the request still goes out");
    session.dispose();
  });

  test("P26 native-extension-load: under Bun pi's loader imports an extension natively first: two whose imports resolve share one instance of a common file with a direct import; one whose don't is translated, with its own", async () => {
    const { discoverAndLoadExtensions } = pi.agent as any;
    const t = join(dir, "p26");
    mkdirSync(join(t, "agent"), { recursive: true });
    writeFileSync(join(t, "shared.ts"), "export const box = {};\n");
    // a and b import only the shared file; c also imports pi-tui, which nothing resolves from this
    // folder but pi's aliases, so a native import of it throws.
    const ext = (name: string, extra = "") =>
      writeFileSync(join(t, `${name}.ts`), `${extra}import { box } from "./shared.ts";\n(globalThis.__sovaP26 ??= {})[${JSON.stringify(name)}] = box;\nexport default () => {};\n`);
    ext("a");
    ext("b");
    ext("c", 'import { visibleWidth } from "@earendil-works/pi-tui";\nif (typeof visibleWidth !== "function") throw new Error("no pi-tui");\n');
    const seen = ((globalThis as any).__sovaP26 = {}) as Record<string, object>;
    const r = await discoverAndLoadExtensions(["a", "b", "c"].map((n) => join(t, `${n}.ts`)), t, join(t, "agent"));
    assert.deepEqual(r.errors, [], "all three load");
    const direct = (await import(join(t, "shared.ts"))).box;
    assert.ok(seen.a && seen.b && seen.c);
    assert.equal(seen.a, seen.b, "fixed?: pi no longer imports extensions natively first under Bun (each one translated, with its own copy)");
    assert.equal(seen.a, direct, "the extensions' instance is the one a plain import gets");
    assert.notEqual(seen.c, seen.a, "the control: one that can't load natively is translated, with its own copy");
    delete (globalThis as any).__sovaP26;
  });

  test("P27 headless-standins: pi-tui keeps its text, key and colour helpers apart from its drawing modules, pi's theme takes only the highlighter, and outside its terminal mode pi takes a drawing module only in renderers, its CLI and its entry", () => {
    const piDist = join(pi.dir, "dist");
    const tuiDist = join(packageFrom(pi.dir, "@earendil-works/pi-tui")!, "dist");
    // The filter matches by these path tails, as they sit under any node_modules.
    const piKey = (rel: string) => `/@earendil-works/pi-coding-agent/dist/${rel}`;
    const tuiKey = (rel: string) => `/@earendil-works/pi-tui/dist/${rel}`;
    const names = (list: string) => list.split(",").map((s) => s.trim()).filter((s) => s && !s.startsWith("type ")).map((s) => s.split(/\s+as\s+/).at(-1)!);
    // pi-tui's index: each export name and the module it comes from; nothing but `export {…} from`.
    const index = readFileSync(join(tuiDist, "index.js"), "utf8");
    const from = new Map<string, string>();
    for (const m of index.matchAll(/^export \{([^}]*)\} from "([^"]+)";/gm))
      for (const n of names(m[1]!)) from.set(n, m[2]!.startsWith("./") ? tuiKey(m[2]!.slice(2)) : `/${m[2]}/lib/marked.esm.js`);
    assert.doesNotMatch(index.replace(/^export \{[^}]*\} from "[^"]+";/gm, ""), /^export /m, "pi-tui's index re-exports by name only");
    // 1. The helpers extensions and pi's theme use for text stay real.
    const theme = ["theme.js", "system-theme.js"].map((f) => readFileSync(join(piDist, "modes", "interactive", "theme", f), "utf8"));
    const themeNames = theme.flatMap((s) => [...s.matchAll(/import \{([^}]*)\} from "@earendil-works\/pi-tui"/g)].flatMap((m) => names(m[1]!)));
    const helpers = ["visibleWidth", "truncateToWidth", "wrapTextWithAnsi", "sliceByColumn", "stripTerminalSequences", "matchesKey", "Key", "KeybindingsManager", "TUI_KEYBINDINGS", "getKeybindings", "setKeybindings", "fuzzyFilter", "fuzzyMatch", ...themeNames];
    assert.ok(themeNames.length > 0, "the theme's own pi-tui names were read");
    for (const n of helpers) {
      assert.ok(from.has(n), `pi-tui exports ${n}`);
      assert.doesNotMatch(from.get(n)!, STANDIN_FILTER, `${n} lives in a module the stand-ins replace (fixed?: pi-tui moved a text helper into a drawing module)`);
    }
    // 2 and 3. Who outside pi's terminal mode takes a drawing module: a relative import, or a pi-tui name.
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".js") ? [join(d, e.name)] : []));
    const takers: string[] = [];
    for (const file of walk(piDist)) {
      const rel = relative(piDist, file);
      if (rel.startsWith("bundle/") || STANDIN_FILTER.test(piKey(rel))) continue;
      const code = readFileSync(file, "utf8");
      const taken = [
        ...[...code.matchAll(/^(?:import|export) [^;]*? from "(\.[^"]+)";/gm)].map((m) => piKey(relative(piDist, resolve(dirname(file), m[1]!)))),
        ...[...code.matchAll(/^import \{([^}]*)\} from "@earendil-works\/pi-tui";/gm)].flatMap((m) => names(m[1]!).map((n) => from.get(n) ?? "")),
      ].filter((k) => STANDIN_FILTER.test(k));
      if (taken.length) takers.push(`${rel} <- ${[...new Set(taken.map((k) => k.replace(/^.*\/dist\//, "")))].join(" ")}`);
    }
    const allowed = /^(?:core\/tools\/renderers\/[^/]+|extensions\/[^/]+\/(?:renderer|ui|tools)|cli\/[^/]+|package-manager-cli|index|modes\/index|utils\/image-convert)\.js <- /;
    const themeTakes = "modes/interactive/theme/theme.js <- utils/syntax-highlight.js";
    assert.ok(takers.includes(themeTakes), `the theme takes the highlighter:\n${takers.join("\n")}`);
    assert.deepEqual(takers.filter((t) => t !== themeTakes && !allowed.test(t)), [], "outside pi's terminal mode, a drawing module taken by code a Sova chat may run: triage by QUIRKS.md P27");
  });

  test("P28 steer-all: with the getter replaced, every queued steer lands in one step, the mode survives reload(), and settings.json holds no steeringMode", async () => {
    // A settings file pi really reads (and would write), in an agent dir of its own.
    const agentDir = join(dir, "p26-agent");
    mkdirSync(agentDir, { recursive: true });
    const settingsFile = join(agentDir, "settings.json");
    writeFileSync(settingsFile, `${JSON.stringify({ cacheWarming: "off", retry: { enabled: false } }, null, 2)}\n`);
    const before = readFileSync(settingsFile, "utf8");
    const settingsManager = SettingsManager.create(dir, agentDir);
    assert.equal(settingsManager.getSteeringMode(), "one-at-a-time", "pi's own default, which the getter replaces");
    steerAllAtOnce(settingsManager);
    const { session, model } = await quirkSession({ settingsManager });
    assert.equal(session.agent.steeringMode, "all", "createAgentSession builds the agent's mode from the getter");
    assert.equal(session.agent.followUpMode, "one-at-a-time", "follow-ups keep pi's one at a time");
    /** Two steers queued behind a held reply: the calls the run made, and the user messages of its second. */
    const twoSteers = async (a: string, b: string) => {
      const from = model.calls.length;
      const release = model.hold();
      const run = session.prompt(`go ${a}`);
      await until(() => model.calls.length === from + 1, "the held reply");
      await session.steer(a);
      await session.steer(b);
      release();
      await run;
      const users = ((model.calls[from + 1]!.context as any).messages as any[]).filter((m) => m.role === "user").map(userText);
      return { calls: model.calls.length - from, last: users.slice(-2) };
    };
    assert.deepEqual(await twoSteers("s1", "s2"), { calls: 2, last: ["s1", "s2"] }, "both steers in the step after the held reply: one call for the pair");
    await session.reload();
    assert.equal(session.agent.steeringMode, "all", "reload() re-read settings.json and kept the getter's mode");
    assert.deepEqual(await twoSteers("s3", "s4"), { calls: 2, last: ["s3", "s4"] }, "and still lands them together");
    assert.equal(readFileSync(settingsFile, "utf8"), before, "settings.json is untouched");
    assert.equal("steeringMode" in JSON.parse(readFileSync(settingsFile, "utf8")), false, "no steeringMode in settings.json");
    session.dispose();
  });

  test("T1 scripted-model: the members the test double replaces exist, and it runs a turn", async () => {
    const { session } = await scriptedSession();
    const s = session as any;
    assert.equal(typeof s._modelRuntime?.hasConfiguredAuth, "function", "ScriptedModel.attach stubs _modelRuntime.hasConfiguredAuth");
    assert.equal(typeof s.agent.streamFunction, "function");
    assert.ok("getApiKey" in s.agent);
    const model = new ScriptedModel().attach(session).reply({ text: "scripted reply" });
    await session.prompt("hello");
    assert.equal(model.calls.length, 1);
    const reply = session.agent.state.messages.at(-1) as any;
    assert.equal(reply.role, "assistant");
    assert.deepEqual(reply.content, [{ type: "text", text: "scripted reply" }]);
    session.dispose();
  });
});
