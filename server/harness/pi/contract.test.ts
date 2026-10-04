// Run: pnpm test -- server/harness/pi/contract.test.ts. The pi contract (§app.harness/boundary): the pi
// behaviours Sova relies on, pinned so a pi upgrade that changes one fails here before it fails a feature.
// pi comes only through testing/load-pi.ts, so the same file proves the repo's pin or, with
// PI_PACKAGE_DIR=<a pi-coding-agent package dir>, another copy (see README.md here). Turns run on pi-ai's
// faux provider, registered through the public ModelRuntime API: no network, no private fields.
// C1 the session manager's append* methods (the entry union), C2 the custom entry's line, C3 the event
// names and fields chat-manager's bind() reads, C5 image content as prompt/steer take and store it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { loadPi } from "./testing/load-pi.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "sova-pi-contract-")));
after(() => rmSync(dir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = dir;
const pi = await loadPi();
const { createAgentSession, defineTool, ModelRuntime, SessionManager, SettingsManager } = pi.agent;
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
});
