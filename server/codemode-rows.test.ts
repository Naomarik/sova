// Run: pnpm test -- server/codemode-rows.test.ts. A pi 1.0 session with a codemode call as the transcript reads
// it (§chat.transcript/codemode-card, §chat.transcript/transcript-items): one call row and one result row (the
// script's own calls are no rows), a store entry that draws nothing, the folded line's script head and calls
// on the slim rows, and no context fill from the result's merged usage.
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeEntries, slimRows } from "./transcript";
import { contextForBranch } from "./harness/pi/usage";

const T = "2026-10-06T00:00:00.000Z";
const SCRIPT = `// @options: {"max_output_tokens": 2000}
const words = await Promise.all(["a", "b"].map((word) => tools.echo({ word })));
return words.join(",");`;

/** As pi 1.0.3 writes it: the call, the result with its record of the nested calls and merged usage, the store entry. */
const entries = [
  { type: "message", id: "u1", parentId: null, timestamp: T, message: { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 } },
  {
    type: "message", id: "a1", parentId: "u1", timestamp: T,
    message: { role: "assistant", provider: "zai", model: "glm-5.3", api: "openai-completions", stopReason: "toolUse", timestamp: 2,
      usage: { input: 900, output: 10, cacheRead: 100, cacheWrite: 0, totalTokens: 1010, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: [{ type: "toolCall", id: "call_1", name: "codemode", arguments: { code: SCRIPT } }] },
  },
  {
    type: "message", id: "r1", parentId: "a1", timestamp: T,
    message: {
      role: "toolResult", toolCallId: "call_1", toolName: "codemode", isError: false, timestamp: 3,
      content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }, { type: "text", text: "echo:a,echo:b" }],
      details: { calls: [
        { id: "call_1/1", name: "echo", args: '{"word":"a"}', status: "ok", durationMs: 3 },
        { id: "call_1/2", name: "echo", args: '{"word":"b"}', status: "error", durationMs: 4, error: "boom" },
        { id: "call_1/models.classify/1", name: "models.classify", args: "cls/cls-1", status: "ok", durationMs: 9, cost: 0.001 },
      ] },
      // The script's model calls, merged: never a context fill.
      usage: { input: 50000, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 50005, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } },
      nestedCalls: [{ id: "call_1/1", name: "echo" }, { id: "call_1/2", name: "echo" }],
    },
  },
  { type: "custom", id: "s1", parentId: "r1", timestamp: T, customType: "codemode-store", data: { set: { cursor: 3 }, delete: [] } },
  { type: "custom_message", id: "n1", parentId: "s1", timestamp: T, customType: "mode-note", content: "Mode change: the user turned the vis minor mode off.", display: false, details: { v: 1, minorModes: [], guides: [] } },
];

test("one call row and one result row; the store entry and the hidden note draw nothing", () => {
  const rows = normalizeEntries(entries as never);
  assert.deepEqual(rows.map((r) => r.kind), ["user", "tool-call", "tool-result"], "the script's calls are no rows");
  assert.ok(!rows.some((r) => r.kind === "unknown" || r.kind === "info"), "codemode-store is not an unknown or info row, nor is the hidden note");
});

test("the slim rows carry the script's head (never the whole script) and its calls tally", () => {
  const rows = slimRows(normalizeEntries(entries as never));
  const call = rows.find((r) => r.kind === "tool-call")!;
  assert.equal(call.tool?.summary, 'const words = await Promise.all(["a", "b"].map((word) => tools.echo({ word })));');
  assert.equal(call.tool?.lazy, true, "the script itself loads with the card's content");
  const result = rows.find((r) => r.kind === "tool-result")!;
  assert.deepEqual(result.tool?.calls, { total: 3, failed: 1, running: 0 });
  assert.equal(result.tool?.lazy, true);
  assert.equal(result.tool?.details, undefined, "the details stay off the row");
});

test("the result's merged usage never moves the context fill", () => {
  const context = contextForBranch(entries as never);
  assert.deepEqual(context, { tokens: 1000, model: "zai/glm-5.3" }, "the fill is the last reply's");
});
