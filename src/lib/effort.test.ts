import assert from "node:assert/strict";
import { test } from "node:test";
import { THINKING_LEVELS } from "../../shared/profiles";
import { effortArcLength, effortFill, effortMark, effortStep, modelSummaryLine } from "./effort";
import { RING_ARC } from "./waiting";

test("the arc fills on one seven-step scale: off empty, max the whole 270°", () => {
  assert.deepEqual(
    THINKING_LEVELS.map((l) => effortStep(l)),
    [0, 1, 2, 3, 4, 5, 6],
  );
  assert.equal(effortFill("off"), 0);
  assert.equal(effortFill("max"), 1);
  assert.equal(effortArcLength("max"), RING_ARC, "max is the full arc, no more");
  assert.equal(effortArcLength("off"), 0);
  assert.equal(effortFill("high"), 4 / 6);
  // Every step fills more than the one before it.
  const fills = THINKING_LEVELS.map((l) => effortFill(l));
  for (let i = 1; i < fills.length; i++) assert.ok(fills[i]! > fills[i - 1]!, `${THINKING_LEVELS[i]} fills more than ${THINKING_LEVELS[i - 1]}`);
});

test("a level the scale doesn't know has no step and fills nothing", () => {
  assert.equal(effortStep("turbo"), null);
  assert.equal(effortStep(null), null);
  assert.equal(effortFill("turbo"), 0);
  assert.deepEqual(effortMark("turbo"), { kind: "none" });
});

test("the mark: off none, minimal a dot, low L, medium M, high H, xhigh X, max a bolt", () => {
  assert.deepEqual(
    THINKING_LEVELS.map((l) => effortMark(l)),
    [
      { kind: "none" },
      { kind: "dot" },
      { kind: "letter", text: "L" },
      { kind: "letter", text: "M" },
      { kind: "letter", text: "H" },
      { kind: "letter", text: "X" },
      { kind: "bolt" },
    ],
  );
});

test("the model panel's summary spells the choice out: model · backend · effort", () => {
  assert.equal(modelSummaryLine("claude-code-cli/claude-opus-5-5", "high"), "Opus 5.5 · claude-code-cli · high");
  assert.equal(modelSummaryLine("zai/glm-5.3", null), "glm-5.3 · zai", "no effort choice: left out");
  assert.equal(modelSummaryLine("local-model", "low"), "local-model · low", "no provider: left out");
  assert.equal(modelSummaryLine(null, "high"), null);
});
