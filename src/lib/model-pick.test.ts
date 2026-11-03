import assert from "node:assert/strict";
import { test } from "node:test";
import { pickLabel, pickWithModel } from "./model-pick";

test("a pick reads as its model's name and its thinking level", () => {
  assert.equal(pickLabel({ model: "zai/glm-5.3", thinking: "high" }), "glm-5.3 · high");
  assert.equal(pickLabel({ model: "zai/glm-5.3" }), "glm-5.3");
  assert.equal(pickLabel(null), null);
});

test("a new model keeps the level only when its ladder has it", () => {
  assert.deepEqual(pickWithModel({ model: "a/x", thinking: "high" }, "b/y", ["off", "low", "high"]), { model: "b/y", thinking: "high" });
  assert.deepEqual(pickWithModel({ model: "a/x", thinking: "xhigh" }, "b/y", ["off", "low", "high"]), { model: "b/y" }, "a level the new model lacks is cleared");
  assert.deepEqual(pickWithModel({ model: "a/x", thinking: "high" }, "b/y", []), { model: "b/y", thinking: "high" }, "an unknown ladder keeps it");
  assert.deepEqual(pickWithModel(null, "b/y", ["off", "high"]), { model: "b/y" });
});
