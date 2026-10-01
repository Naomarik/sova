// Run: npx tsx --test src/lib/model-picker.test.ts
// The provider-first model picker's rows: groups, search, the one-provider skip, the start position.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelInfo } from "../../shared/protocol";
import { initialActive, matchModels, modelCount, onlyProvider, pickerGroups, providersOf, type PickerGroup } from "./model-picker";

const m = (ref: string, favorite = false): ModelInfo => {
  const [provider, id] = [ref.slice(0, ref.indexOf("/")), ref.slice(ref.indexOf("/") + 1)];
  return { ref, provider: provider!, id: id!, favorite, thinkingLevels: ["off"] };
};
const MODELS = [m("zai/glm-5"), m("openai-codex/gpt-6.1-sol", true), m("ollama-cloud/kimi-k3"), m("zai/glm-4.7", true), m("openai-codex/gpt-5.5"), m("anthropic/claude-opus-5")];
const keys = (groups: PickerGroup[]) => groups.map((g) => [g.label, g.items.map((i) => i.key)]);

test("step 1 shows Favorites by ref, then every provider by name with its count", () => {
  const groups = pickerGroups(MODELS, { kind: "providers" }, "", "openai-codex/gpt-5.5");
  assert.deepEqual(keys(groups), [
    ["Favorites", ["m:openai-codex/gpt-6.1-sol", "m:zai/glm-4.7"]],
    ["Providers", ["p:anthropic", "p:ollama-cloud", "p:openai-codex", "p:zai"]],
  ]);
  const fav = groups[0]!.items[0]!;
  assert.ok(fav.kind === "model" && fav.caption, "a favorite names its provider: the group doesn't");
  const providers = groups[1]!.items.filter((i) => i.kind === "provider");
  assert.deepEqual(
    providers.map((p) => [p.provider, p.count, p.current]),
    [
      ["anthropic", 1, false],
      ["ollama-cloud", 1, false],
      ["openai-codex", 2, true],
      ["zai", 2, false],
    ],
  );
});

test("with no favorites step 1 is the Providers group alone", () => {
  const groups = pickerGroups(MODELS.map((x) => ({ ...x, favorite: false })), { kind: "providers" }, "", null);
  assert.deepEqual(groups.map((g) => g.label), ["Providers"]);
});

test("a provider whose models are all filtered out has no row", () => {
  const usable = MODELS.filter((x) => x.provider !== "anthropic"); // the caller passes usableModels()
  const groups = pickerGroups(usable, { kind: "providers" }, "", null);
  assert.ok(!groups.at(-1)!.items.some((i) => i.key === "p:anthropic"));
});

test("step 2 lists one provider's models by id, without a caption or label", () => {
  const groups = pickerGroups(MODELS, { kind: "provider", provider: "zai" }, "", null);
  assert.deepEqual(keys(groups), [[null, ["m:zai/glm-4.7", "m:zai/glm-5"]]]);
  assert.ok(groups[0]!.items.every((i) => i.kind === "model" && !i.caption));
});

test("a query on step 2 searches only that provider", () => {
  assert.deepEqual(keys(pickerGroups(MODELS, { kind: "provider", provider: "openai-codex" }, "sol", null)), [[null, ["m:openai-codex/gpt-6.1-sol"]]]);
  assert.deepEqual(pickerGroups(MODELS, { kind: "provider", provider: "openai-codex" }, "glm", null), []);
});

test("a query on step 1 searches every model, grouped under its provider", () => {
  assert.deepEqual(keys(pickerGroups(MODELS, { kind: "providers" }, "gl", null)), [["zai", ["m:zai/glm-4.7", "m:zai/glm-5"]]]);
  assert.deepEqual(keys(pickerGroups(MODELS, { kind: "providers" }, "  5 ", null)), [
    ["anthropic", ["m:anthropic/claude-opus-5"]],
    ["openai-codex", ["m:openai-codex/gpt-5.5"]],
    ["zai", ["m:zai/glm-5"]],
  ]);
  assert.deepEqual(keys(pickerGroups(MODELS, { kind: "providers" }, "ZAI", null)), [["zai", ["m:zai/glm-4.7", "m:zai/glm-5"]]], "a provider's name finds its models");
  assert.deepEqual(pickerGroups(MODELS, { kind: "providers" }, "nothing", null), []);
});

test("tokens are ANDed over provider/id, case-insensitively", () => {
  assert.deepEqual(matchModels(MODELS, "anth OPUS").map((x) => x.ref), ["anthropic/claude-opus-5"]);
  assert.deepEqual(matchModels(MODELS, "anth gpt"), []);
});

test("the picker skips step 1 only when exactly 1 provider has models", () => {
  assert.equal(onlyProvider(MODELS), null);
  assert.equal(onlyProvider(MODELS.filter((x) => x.provider === "zai")), "zai");
  assert.equal(onlyProvider([]), null);
  assert.deepEqual(providersOf([]), []);
});

test("a step starts on the current provider or model, else its first row", () => {
  const step1 = pickerGroups(MODELS, { kind: "providers" }, "", "zai/glm-5");
  assert.equal(initialActive(step1, { kind: "providers" }, "zai/glm-5"), "p:zai", "the provider row, even when the current model is a favorite elsewhere");
  const step2 = pickerGroups(MODELS, { kind: "provider", provider: "zai" }, "", "zai/glm-5");
  assert.equal(initialActive(step2, { kind: "provider", provider: "zai" }, "zai/glm-5"), "m:zai/glm-5");
  const other = pickerGroups(MODELS, { kind: "provider", provider: "openai-codex" }, "", "zai/glm-5");
  assert.equal(initialActive(other, { kind: "provider", provider: "openai-codex" }, "zai/glm-5"), "m:openai-codex/gpt-5.5");
  assert.equal(initialActive([], { kind: "providers" }, null), null);
});

test("counts read as words", () => {
  assert.equal(modelCount(1), "1 model");
  assert.equal(modelCount(20), "20 models");
});
