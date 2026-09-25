// Run: pnpm exec tsx --test src/lib/change-rows.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryKind, TranscriptItem } from "../../shared/protocol";
import { isChangeRow } from "./change-rows";

/** A real TranscriptItem: id, kind and raw are the required fields; text is the display line. */
const row = (id: string, kind: EntryKind, raw: unknown, text?: string): TranscriptItem =>
  text === undefined ? { id, kind, raw } : { id, kind, raw, text };

const change = (id: string, raw: unknown, text: string) => row(id, "info", raw, text);

test("change rows: model and thinking changes are settings history, not conversation", () => {
  assert.equal(isChangeRow(change("m1", { type: "model_change", provider: "anthropic", modelId: "claude-opus-5" }, "Model: anthropic/claude-opus-5")), true);
  assert.equal(isChangeRow(change("t1", { type: "thinking_level_change", thinkingLevel: "high" }, "Thinking: high")), true);
});

test("change rows: the mode extension's three markers all count", () => {
  const raw = (data: Record<string, unknown>) => ({ type: "custom", customType: "mode", data });
  assert.equal(isChangeRow(change("d1", raw({ mode: "delegate" }), "Mode → delegate")), true);
  assert.equal(isChangeRow(change("a1", raw({ minor: "align", on: true }), "Minor mode: align on")), true);
  assert.equal(isChangeRow(change("s1", raw({ strict: true }), "Strict mode on")), true);
  assert.equal(isChangeRow(change("s2", raw({ strict: false }), "Strict mode off")), true);
});

test("change rows: ordinary info items stay", () => {
  assert.equal(isChangeRow(change("c1", { type: "compaction", summary: "…" }, "Compacted (67,401 tokens): …")), false);
  assert.equal(isChangeRow(change("l1", { type: "label", label: "release", targetId: "m41" }, 'Label "release" on m41')), false);
  assert.equal(isChangeRow(change("cm1", { type: "custom_message", customType: "intercom_message" }, "Short note")), false);
  assert.equal(isChangeRow(row("i1", "info", { type: "session_info", name: "x" }, "Session name: x")), false);
});

test("change rows: other kinds that merely carry these raw shapes stay", () => {
  assert.equal(isChangeRow(row("r1", "report", { type: "custom_message", customType: "subagent-complete" }, "…")), false);
  assert.equal(isChangeRow(row("u1", "user", { type: "message", message: { role: "user" } }, "hi")), false);
  assert.equal(isChangeRow(row("th1", "thinking", { type: "model_change", provider: "anthropic", modelId: "claude" }, "hmm")), false);
});

test("change rows: an unknown or malformed raw is not one", () => {
  assert.equal(isChangeRow(change("n1", null, "x")), false);
  assert.equal(isChangeRow(change("n2", "model_change", "x")), false);
  assert.equal(isChangeRow(change("n3", { type: "mystery" }, "x")), false);
});
