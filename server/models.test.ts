// Run: npx tsx --test server/models.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { supportedThinkingLevels, toModelInfo } from "./models";

test("non-reasoning models support only off", () => {
  assert.deepEqual(supportedThinkingLevels({ reasoning: false }), ["off"]);
  assert.deepEqual(supportedThinkingLevels({}), ["off"]);
});

test("no map means the ladder minus xhigh/max, which need an explicit entry", () => {
  assert.deepEqual(supportedThinkingLevels({ reasoning: true }), [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
  ]);
});

test("null entries drop their level; absent keys stay supported", () => {
  // claude-opus-5 shape: off explicitly unavailable, xhigh/max explicit, the middle implied.
  assert.deepEqual(
    supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } }),
    ["minimal", "low", "medium", "high", "xhigh", "max"],
  );
});

test("xhigh and max need an explicit non-null map entry", () => {
  // glm-5.3 shape: only low/high/max are mapped non-null.
  assert.deepEqual(
    supportedThinkingLevels({
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
    }),
    ["low", "high", "max"],
  );
  // A map without xhigh/max keeps them out even though every other level is implied.
  assert.deepEqual(supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { off: null } }), [
    "minimal",
    "low",
    "medium",
    "high",
  ]);
});

test("input passes through verbatim; a model without one has no input key", () => {
  const favorites = new Set(["anthropic/claude-opus-5"]);
  const vision = toModelInfo({ provider: "anthropic", id: "claude-opus-5", input: ["text", "image"] }, favorites);
  assert.deepEqual(vision.input, ["text", "image"]);
  assert.equal(vision.favorite, true);

  const textOnly = toModelInfo({ provider: "openai", id: "gpt-5", input: ["text"] }, favorites);
  assert.deepEqual(textOnly.input, ["text"]);

  // A custom models.json provider that omits it: absent stays absent, not [] and not ["text"].
  const unknown = toModelInfo({ provider: "ollama-cloud", id: "kimi-k3" }, favorites);
  assert.equal("input" in unknown, false);
  assert.equal(unknown.favorite, false);
  assert.equal(JSON.stringify(unknown).includes("input"), false);
});

test("toModelInfo carries the context window, and leaves it out when nothing knows it", () => {
  const favorites = new Set<string>();
  assert.equal(toModelInfo({ provider: "anthropic", id: "claude-opus-5" }, favorites, 200_000).contextWindow, 200_000);
  // Absent, not 0 or null: a cost preview must be able to say "unknown" (same rule as ContextInfo.window).
  for (const unknown of [null, undefined, 0]) {
    const info = toModelInfo({ provider: "ollama-cloud", id: "kimi-k3" }, favorites, unknown);
    assert.ok(!("contextWindow" in info), `window ${String(unknown)} is left out`);
  }
});
