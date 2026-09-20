// Run: npx tsx --test server/models.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { supportedThinkingLevels } from "./models";

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
