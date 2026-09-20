import assert from "node:assert/strict";
import { test } from "node:test";
import { compactModel, shortModel } from "./format";

test("shortModel drops the provider only", () => {
  assert.equal(shortModel("anthropic/claude-opus-5"), "claude-opus-5");
  assert.equal(shortModel("claude-opus-5"), "claude-opus-5");
  assert.equal(shortModel(null), null);
  assert.equal(shortModel(""), null);
});

test("compactModel drops the provider, the dated build and the claude- family", () => {
  assert.equal(compactModel("claude-haiku-4-5-20251001"), "haiku-4.5");
  assert.equal(compactModel("anthropic/claude-sonnet-4-5-20250929"), "sonnet-4.5");
  assert.equal(compactModel("claude-opus-5"), "opus-5");
});

test("compactModel spells out the context variant", () => {
  assert.equal(compactModel("claude-opus-5[1m]"), "opus-5 1M");
  assert.equal(compactModel("anthropic/claude-sonnet-4-5-20250929[1m]"), "sonnet-4.5 1M");
});

test("compactModel leaves ids it doesn't recognize alone", () => {
  assert.equal(compactModel("gpt-5-mini"), "gpt-5-mini");
  assert.equal(compactModel("deepseek/deepseek-chat"), "deepseek-chat");
  assert.equal(compactModel("openai/gpt-4-1"), "gpt-4.1");
  assert.equal(compactModel(null), null);
  assert.equal(compactModel(undefined), null);
});
