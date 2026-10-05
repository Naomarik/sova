// Run: pnpm test -- shared/wire-v1.test.ts. Wire 1 → wire 2: the fromV1 table, one
// row per v1 event the live view reads and each fallback it keeps, the events it ignores mapping to
// none; and factsFromMeta, one row per fact a row predicate reads. The corpus checks (faux streams,
// every fixture row, the neutral reader's entries) are server/harness/pi/wire-v1-corpus.test.ts.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RowFacts, SovaEvent } from "./harness-wire";
import type { EntryMeta } from "./protocol";
import { factsFromMeta, fromV1, rowFacts } from "./wire-v1";

const v1 = (event: unknown, entryId?: string) => fromV1(entryId === undefined ? { event } : { event, entryId });
const update = (ame: Record<string, unknown>) => v1({ type: "message_update", usage: { input: 1 }, assistantMessageEvent: ame });
const PNG = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
const PNG_URL = "data:image/png;base64,iVBORw0KGgo=";

describe("fromV1: the table", () => {
  const rows: [string, unknown, SovaEvent[]][] = [
    ["agent_start", { type: "agent_start" }, [{ type: "run.start" }]],
    ["agent_settled", { type: "agent_settled" }, [{ type: "run.settled" }]],
    [
      "assistant start, provider and model",
      { type: "message_start", message: { role: "assistant", provider: "zai", model: "glm-5.3", content: [] } },
      [{ type: "message.start", role: "assistant", model: "zai/glm-5.3", parts: [] }],
    ],
    [
      "assistant start without a provider names no model",
      { type: "message_start", message: { role: "assistant", model: "glm-5.3", content: [{ type: "text", text: "hi" }] } },
      [{ type: "message.start", role: "assistant", parts: [{ kind: "text", text: "hi" }] }],
    ],
    [
      "assistant parts: text, thinking, a tool call with its defaults; images and unknown blocks dropped",
      {
        type: "message_start",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "hmm", thinkingSignature: "x" }, { type: "text" }, { type: "toolCall", arguments: { a: 1 } }, PNG, { type: "redacted" }, "junk"],
        },
      },
      [{ type: "message.start", role: "assistant", parts: [{ kind: "thinking", text: "hmm" }, { kind: "text", text: "" }, { kind: "toolCall", id: "", name: "tool", args: { a: 1 } }] }],
    ],
    [
      "user start: text joined, images as data URLs",
      { type: "message_start", message: { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }, PNG] } },
      [{ type: "message.start", role: "user", text: "a\nb", images: [PNG_URL] }],
    ],
    [
      "user start: pi 0.87's image resize note stripped",
      {
        type: "message_start",
        message: {
          role: "user",
          content: [{ type: "text", text: "look\n\n[Image: original 2560x1600, displayed at 2000x1250. Multiply coordinates by 1.28 to map to original image.]" }, PNG],
        },
      },
      [{ type: "message.start", role: "user", text: "look", images: [PNG_URL] }],
    ],
    ["user start: string content", { type: "message_start", message: { role: "user", content: "plain" } }, [{ type: "message.start", role: "user", text: "plain", images: [] }]],
    ["a start of another role maps to none", { type: "message_start", message: { role: "toolResult", content: [] } }, []],
    ["a start with no message maps to none", { type: "message_start" }, []],
  ];
  for (const [name, event, want] of rows) test(name, () => assert.deepEqual(v1(event), want));

  test("message_update: each part event, with and without an index", () => {
    assert.deepEqual(update({ type: "text_start", contentIndex: 0, partial: {} }), [{ type: "part.start", index: 0, kind: "text" }]);
    assert.deepEqual(update({ type: "text_delta", contentIndex: 0, delta: "he" }), [{ type: "part.delta", index: 0, kind: "text", delta: "he" }]);
    assert.deepEqual(update({ type: "text_end", contentIndex: 0, content: "hello" }), [{ type: "part.end", index: 0, kind: "text", text: "hello" }]);
    assert.deepEqual(update({ type: "thinking_start" }), [{ type: "part.start", kind: "thinking" }]);
    assert.deepEqual(update({ type: "thinking_delta", delta: "x" }), [{ type: "part.delta", kind: "thinking", delta: "x" }]);
    assert.deepEqual(update({ type: "thinking_end", contentIndex: 1, content: "xy" }), [{ type: "part.end", index: 1, kind: "thinking", text: "xy" }]);
    assert.deepEqual(update({ type: "toolcall_start", contentIndex: 2, id: "c1", toolName: "read" }), [{ type: "part.start", index: 2, kind: "toolCall", id: "c1", name: "read" }]);
    assert.deepEqual(update({ type: "toolcall_delta", contentIndex: 2, delta: '{"p' }), [{ type: "part.delta", index: 2, kind: "toolCall", delta: '{"p' }]);
    assert.deepEqual(update({ type: "toolcall_end", contentIndex: 2, toolCall: { type: "toolCall", id: "c1", name: "read", arguments: { p: 1 } } }), [
      { type: "part.end", index: 2, kind: "toolCall", id: "c1", name: "read", args: { p: 1 } },
    ]);
  });

  test("message_update: the reducer's fallbacks survive (no index, no delta, no end text, no call id or name)", () => {
    assert.deepEqual(update({ type: "text_delta" }), [{ type: "part.delta", kind: "text", delta: "" }]);
    assert.deepEqual(update({ type: "text_end", contentIndex: 0 }), [{ type: "part.end", index: 0, kind: "text" }]);
    assert.deepEqual(update({ type: "thinking_end", content: 7 }), [{ type: "part.end", kind: "thinking" }]);
    assert.deepEqual(update({ type: "toolcall_start", contentIndex: "0" }), [{ type: "part.start", kind: "toolCall" }]);
    assert.deepEqual(update({ type: "toolcall_end", contentIndex: 0 }), [{ type: "part.end", index: 0, kind: "toolCall", args: undefined }]);
  });

  test("message_update: the stream's own start, done and error, and an update with no assistant event, map to none", () => {
    for (const type of ["start", "done", "error", "something_new"]) assert.deepEqual(update({ type }), [], type);
    assert.deepEqual(v1({ type: "message_update" }), []);
    assert.deepEqual(v1({ type: "message_update", assistantMessageEvent: "text_delta" }), []);
  });

  test("message_end, user: the entry it was written as, from the frame, else the event", () => {
    const end = { type: "message_end", message: { role: "user", content: "x" } };
    assert.deepEqual(v1(end, "e1"), [{ type: "message.end", role: "user", entryId: "e1" }]);
    assert.deepEqual(v1(end), [{ type: "message.end", role: "user" }]);
    assert.deepEqual(v1({ ...end, entryId: "e0" }), [{ type: "message.end", role: "user", entryId: "e0" }]);
    assert.deepEqual(v1({ ...end, entryId: "e0" }, "e1"), [{ type: "message.end", role: "user", entryId: "e1" }]);
    assert.deepEqual(v1({ ...end, entryId: "e0" }, ""), [{ type: "message.end", role: "user", entryId: "e0" }]);
    assert.deepEqual(v1(end, ""), [{ type: "message.end", role: "user" }]);
  });

  test("message_end, assistant: model, parts, stop, error and the context fill it reports", () => {
    const msg = { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text: "done" }], usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 3 }, stopReason: "stop" };
    assert.deepEqual(v1({ type: "message_end", message: msg }, "a1"), [
      { type: "message.end", role: "assistant", entryId: "a1", model: "p/m", parts: [{ kind: "text", text: "done" }], stop: "ok", contextTokens: 33 },
    ]);
    // A tool use is an ordinary stop.
    assert.equal((v1({ type: "message_end", message: { ...msg, stopReason: "toolUse" } })[0] as { stop: string }).stop, "ok");
    // Error: its message (the default text is the browser's), no fill.
    assert.deepEqual(v1({ type: "message_end", message: { role: "assistant", content: [], usage: msg.usage, stopReason: "error", errorMessage: "boom" } }), [
      { type: "message.end", role: "assistant", parts: [], stop: "error", error: "boom" },
    ]);
    assert.deepEqual(v1({ type: "message_end", message: { role: "assistant", stopReason: "error" } }), [{ type: "message.end", role: "assistant", parts: [], stop: "error" }]);
    // Aborted: no error text, no fill (the stop time is the browser's).
    assert.deepEqual(v1({ type: "message_end", message: { role: "assistant", content: [], usage: msg.usage, stopReason: "aborted", errorMessage: "x" } }), [
      { type: "message.end", role: "assistant", parts: [], stop: "aborted" },
    ]);
    // A zero usage, a non-number field, no usage: the fill as the browser counts it.
    assert.equal("contextTokens" in v1({ type: "message_end", message: { role: "assistant", usage: { input: 0, output: 9 } } })[0]!, false);
    assert.equal((v1({ type: "message_end", message: { role: "assistant", usage: { input: "5", cacheRead: 2 } } })[0] as { contextTokens?: number }).contextTokens, 2);
    assert.equal("contextTokens" in v1({ type: "message_end", message: { role: "assistant" } })[0]!, false);
  });

  test("message_end of another role maps to none", () => {
    assert.deepEqual(v1({ type: "message_end", message: { role: "toolResult", toolCallId: "c" } }, "e"), []);
    assert.deepEqual(v1({ type: "message_end", message: { role: "custom" } }), []);
  });

  test("tool execution: start, update, end; no call id maps to none, except an end", () => {
    const result = { content: [{ type: "text", text: "out" }, { type: "text", text: "put" }, PNG], details: { diff: "d" } };
    assert.deepEqual(v1({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { cmd: "ls" } }), [{ type: "tool.start", callId: "c1", name: "bash", args: { cmd: "ls" } }]);
    assert.deepEqual(v1({ type: "tool_execution_start", toolCallId: "c1" }), [{ type: "tool.start", callId: "c1", name: "tool", args: undefined }]);
    assert.deepEqual(v1({ type: "tool_execution_update", toolCallId: "c1", partialResult: result }), [{ type: "tool.update", callId: "c1", output: "out\nput", images: [PNG_URL] }]);
    assert.deepEqual(v1({ type: "tool_execution_update", toolCallId: "c1", partialResult: "raw" }), [{ type: "tool.update", callId: "c1", output: "raw", images: [] }]);
    assert.deepEqual(v1({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", args: { cmd: "ls" }, result, isError: false }), [
      { type: "tool.end", callId: "c1", name: "bash", args: { cmd: "ls" }, isError: false, output: "out\nput", images: [PNG_URL], details: { diff: "d" } },
    ]);
    // No name: the started one stands; isError only when true; no details key without details.
    assert.deepEqual(v1({ type: "tool_execution_end", toolCallId: "c1", result: { content: [] }, isError: "yes" }), [
      { type: "tool.end", callId: "c1", args: undefined, isError: false, output: "", images: [] },
    ]);
    for (const type of ["tool_execution_start", "tool_execution_update"]) assert.deepEqual(v1({ type, toolName: "bash" }), [], type);
    // An end without a call id still ends a tool: its effects (the Overseer's navigate) don't need one.
    assert.deepEqual(v1({ type: "tool_execution_end", toolName: "bash" }), [{ type: "tool.end", callId: "", name: "bash", args: undefined, isError: false, output: "", images: [] }]);
  });

  test("retry and compaction activity; a compaction that wrote one says so", () => {
    assert.deepEqual(v1({ type: "auto_retry_start", attempt: 1 }), [{ type: "activity", what: "retry", phase: "start" }]);
    assert.deepEqual(v1({ type: "auto_retry_end", success: true }), [{ type: "activity", what: "retry", phase: "end" }]);
    assert.deepEqual(v1({ type: "compaction_start", reason: "manual" }), [{ type: "activity", what: "compaction", phase: "start" }]);
    assert.deepEqual(v1({ type: "compaction_end", result: { summary: "s" }, aborted: false }), [{ type: "activity", what: "compaction", phase: "end", wrote: true }]);
    assert.deepEqual(v1({ type: "compaction_end", aborted: true }), [{ type: "activity", what: "compaction", phase: "end", wrote: false }]);
  });

  test("events the live view ignores map to none", () => {
    for (const type of ["turn_start", "turn_end", "agent_end", "queue_update", "entry_appended", "session_info", "sova_baton_sent", "whatever"])
      assert.deepEqual(v1({ type, message: { role: "assistant" } }), [], type);
    for (const event of [null, undefined, "agent_start", 7, [], [{ type: "agent_start" }], {}]) assert.deepEqual(v1(event), []);
  });

  test("pure: the frame is not touched, and the same frame maps the same", () => {
    const frame = { event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x" }], usage: { input: 1 } } }, entryId: "e" };
    const before = JSON.stringify(frame);
    assert.deepEqual(fromV1(frame), fromV1(frame));
    assert.equal(JSON.stringify(frame), before);
  });
});

describe("factsFromMeta: one fact per predicate", () => {
  const rows: [string, EntryMeta | undefined, RowFacts | undefined][] = [
    ["no meta: no facts (the row reads its entry's first)", undefined, undefined],
    ["a user message: none apply", { type: "message", role: "user" }, {}],
    ["model_change", { type: "model_change" }, { setting: "model" }],
    ["thinking_level_change", { type: "thinking_level_change" }, { setting: "thinking" }],
    ["the mode marker", { type: "custom", customType: "mode" }, { setting: "mode" }],
    ["another custom entry", { type: "custom", customType: "minor-mode" }, {}],
    ["a custom message named mode is no setting", { type: "message", role: "custom", customType: "mode" }, {}],
    ["a custom_message named mode is no setting", { type: "custom_message", customType: "mode" }, {}],
    [
      "compaction: reset and figures",
      { type: "compaction", tokensBefore: 120_000, summary: "s", details: { readFiles: [] } },
      { resetsContext: true, compaction: { tokensBefore: 120_000, summary: "s", details: { readFiles: [] } } },
    ],
    ["compaction without figures still is one", { type: "compaction" }, { resetsContext: true, compaction: {} }],
    ["a compaction's summary message resets, with no figures", { type: "message", role: "compactionSummary", summary: "s" }, { resetsContext: true }],
    [
      "an assistant reply's fill",
      { type: "message", role: "assistant", provider: "p", model: "m", usage: { input: 1, cacheRead: 2, cacheWrite: 3, output: 9 }, stopReason: "stop" },
      { contextTokens: 6 },
    ],
    ["an error reply reports none", { type: "message", role: "assistant", usage: { input: 5 }, stopReason: "error", errorMessage: "x" }, {}],
    ["an aborted reply reports none", { type: "message", role: "assistant", usage: { input: 5 }, stopReason: "aborted" }, {}],
    ["a zero usage reports none", { type: "message", role: "assistant", usage: { input: 0, output: 4 } }, {}],
    ["no usage reports none", { type: "message", role: "assistant" }, {}],
    ["a fill counts only on a message entry", { type: "custom_message", role: "assistant", usage: { input: 5 } }, {}],
    ["a tool result", { type: "message", role: "toolResult", toolName: "sova_card", toolCallId: "c1", isError: false }, { tool: { name: "sova_card", callId: "c1", isError: false } }],
    ["a failed tool result", { type: "message", role: "toolResult", toolName: "bash", isError: true }, { tool: { name: "bash", isError: true } }],
    ["a tool result with nothing named", { type: "message", role: "toolResult" }, { tool: {} }],
    ["isError on another role is no tool fact", { type: "message", role: "bashExecution", isError: true }, {}],
  ];
  for (const [name, meta, want] of rows) test(name, () => assert.deepEqual(factsFromMeta(meta), want));

  test("rowFacts: a row's own facts first, else its meta mapped, else none", () => {
    assert.deepEqual(rowFacts({ facts: { setting: "model" }, meta: { type: "thinking_level_change" } }), { setting: "model" });
    assert.deepEqual(rowFacts({ facts: {} }), {});
    assert.deepEqual(rowFacts({ meta: { type: "thinking_level_change" } }), { setting: "thinking" });
    assert.equal(rowFacts({}), undefined);
  });
});
