// Run: npx tsx --test src/lib/models-ladders.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelInfo } from "../../shared/protocol";

/** This browser's storage, as an earlier page left it: the ladders it last loaded. */
const store = new Map<string, string>([["sova:model-ladders", JSON.stringify({ "": { "a/think": ["off", "low", "high"] }, peer: { "p/x": ["off", "high"] } })]]);
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
const { loadModels, modelList, thinkingLevelsFor } = await import("./models");

const model = (ref: string, thinkingLevels: string[]): ModelInfo => ({ ref, provider: "a", id: ref.slice(2), favorite: false, thinkingLevels });

test("before this page's list loads, a model's ladder is the one this browser last saw; after, the list's alone", async () => {
  assert.equal(modelList(), null);
  assert.deepEqual(thinkingLevelsFor("a/think"), ["off", "low", "high"], "the indicator's level shows from the first frame");
  assert.deepEqual(thinkingLevelsFor("a/unknown"), []);
  assert.deepEqual(thinkingLevelsFor("p/x", "peer"), ["off", "high"], "per host");
  assert.deepEqual(thinkingLevelsFor("p/x"), [], "never another host's");
  await loadModels(async () => [model("a/think", ["off", "medium"]), model("a/flat", ["off"])]);
  assert.deepEqual(thinkingLevelsFor("a/think"), ["off", "medium"]);
  assert.deepEqual(thinkingLevelsFor("a/gone"), [], "the list says what it knows: a model not in it has no ladder");
  // The next page starts from what this one loaded: models with a choice only.
  assert.deepEqual(JSON.parse(store.get("sova:model-ladders")!)[""], { "a/think": ["off", "medium"] });
  assert.deepEqual(JSON.parse(store.get("sova:model-ladders")!).peer, { "p/x": ["off", "high"] }, "another host's are kept");
});
