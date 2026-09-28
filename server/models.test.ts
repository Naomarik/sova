// Run: npx tsx --test server/models.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAUDE_CODE_PROVIDER, contextWindow, supportedThinkingLevels, toModelInfo } from "./models";

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
  const favorites = (provider: string, id: string) => provider === "anthropic" && id === "claude-opus-5";
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
  const favorites = () => false;
  assert.equal(toModelInfo({ provider: "anthropic", id: "claude-opus-5" }, favorites, 200_000).contextWindow, 200_000);
  // Absent, not 0 or null: a cost preview must be able to say "unknown" (same rule as ContextInfo.window).
  for (const unknown of [null, undefined, 0]) {
    const info = toModelInfo({ provider: "ollama-cloud", id: "kimi-k3" }, favorites, unknown);
    assert.ok(!("contextWindow" in info), `window ${String(unknown)} is left out`);
  }
});

test("a Claude Code model's window comes from the extension's rule, which the shared registry never holds", () => {
  const runtime = { getModel: () => undefined } as unknown as Parameters<typeof contextWindow>[1];
  assert.equal(contextWindow(`${CLAUDE_CODE_PROVIDER}/opus[1m]`, runtime), 1_000_000);
  assert.equal(contextWindow(`${CLAUDE_CODE_PROVIDER}/haiku`, runtime), 200_000);
  // Any other provider the registry doesn't know stays unknown: never a guess.
  assert.equal(contextWindow("some-provider/opus[1m]", runtime), null);
  // The registry still wins where it has the model.
  const known = { getModel: (p: string, id: string) => (p === CLAUDE_CODE_PROVIDER && id === "sonnet" ? { contextWindow: 123_000 } : undefined) } as unknown as Parameters<typeof contextWindow>[1];
  assert.equal(contextWindow(`${CLAUDE_CODE_PROVIDER}/sonnet`, known), 123_000);
});
