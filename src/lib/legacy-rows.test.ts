// Run: pnpm exec tsx --test src/lib/legacy-rows.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptItem } from "../../shared/protocol";
import { isLegacy, upgradeLegacyRows } from "./legacy-rows";
import { toolCallArgs, toolResultView } from "./message";

const T = "2026-10-01T09:00:00.000Z";
const reply = {
  type: "message",
  id: "a1",
  timestamp: T,
  message: {
    role: "assistant",
    provider: "zai",
    model: "glm-5.3",
    usage: { input: 10, cacheRead: 5, cacheWrite: 0 },
    stopReason: "toolUse",
    content: [
      { type: "thinking", thinking: "hm", thinkingSignature: "SIG" },
      { type: "toolCall", id: "c1", name: "agent_spawn", arguments: { name: "scout", task: "look" } },
    ],
  },
};
const out = { type: "message", id: "r1", timestamp: T, message: { role: "toolResult", toolCallId: "c1", toolName: "edit", isError: true, content: [{ type: "text", text: "whole output" }], details: { patch: "@@ -1,1 +1,2 @@\n-a\n+b\n+c\n" } } };

test("an older peer's rows read as this build's: time, the entry's facts once, tool parts with their content", () => {
  const legacy = [
    { id: "a1:0", kind: "thinking", text: "hm", raw: reply },
    { id: "a1:1", kind: "tool-call", text: "agent_spawn", toolCallId: "c1", raw: JSON.parse(JSON.stringify(reply)) },
    { id: "r1", kind: "tool-result", text: "whole o…", toolCallId: "c1", raw: out },
    { id: "x1", kind: "unknown", raw: { type: "mystery", id: "x1", nested: [{ thinkingSignature: "SIG", keep: 1 }] } },
  ] as unknown as TranscriptItem[];
  assert.equal(isLegacy(legacy), true);
  const [think, call, result, unknown] = upgradeLegacyRows(legacy);
  assert.equal("raw" in think!, false);
  assert.equal(think!.at, T);
  assert.deepEqual(think!.meta, { type: "message", role: "assistant", provider: "zai", model: "glm-5.3", stopReason: "toolUse", usage: { input: 10, cacheRead: 5, cacheWrite: 0 } });
  assert.equal(call!.meta, undefined, "a reply's facts ride its first row only");
  assert.deepEqual(call!.tool, { summary: "scout", args: { name: "scout", task: "look" }, spawn: "scout" });
  assert.deepEqual(toolCallArgs(call), { name: "scout", task: "look" });
  assert.deepEqual(toolResultView(result!), { output: "whole output", isError: true });
  assert.deepEqual(result!.tool?.stats, { added: 2, removed: 1 });
  assert.equal(result!.tool?.lazy, undefined, "nothing to fetch from an older peer");
  assert.deepEqual(unknown!.entry, { type: "mystery", id: "x1", nested: [{ keep: 1 }] });
});

test("rows already in this build's shape pass through as the same list", () => {
  const rows: TranscriptItem[] = [{ id: "u1", kind: "user", text: "hi", at: T }];
  assert.equal(isLegacy(rows), false);
  assert.equal(upgradeLegacyRows(rows), rows);
  assert.deepEqual(upgradeLegacyRows([]), []);
});
