// Run: pnpm exec tsx --test src/lib/change-rows.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryKind, EntryMeta, TranscriptItem } from "../../shared/protocol";
import { isChangeRow } from "./change-rows";

/** The facts a row carries of its entry (`meta`), as the server takes them from the entry. */
const metaOf = (raw: unknown): EntryMeta | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const { type, customType } = raw as { type?: unknown; customType?: unknown };
  if (typeof type !== "string") return undefined;
  return typeof customType === "string" ? { type, customType } : { type };
};

/** A real TranscriptItem: id and kind are the required fields; text is the display line. */
const row = (id: string, kind: EntryKind, raw: unknown, text?: string): TranscriptItem => {
  const meta = metaOf(raw);
  return { id, kind, ...(meta ? { meta } : {}), ...(text === undefined ? {} : { text }) };
};

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

test("change rows: other kinds that merely carry these entry types stay", () => {
  assert.equal(isChangeRow(row("r1", "report", { type: "custom_message", customType: "subagent-complete" }, "…")), false);
  assert.equal(isChangeRow(row("u1", "user", { type: "message", message: { role: "user" } }, "hi")), false);
  assert.equal(isChangeRow(row("th1", "thinking", { type: "model_change", provider: "anthropic", modelId: "claude" }, "hmm")), false);
});

test("change rows: an unknown or missing entry type is not one", () => {
  assert.equal(isChangeRow(change("n1", null, "x")), false);
  assert.equal(isChangeRow(change("n2", "model_change", "x")), false);
  assert.equal(isChangeRow(change("n3", { type: "mystery" }, "x")), false);
});
