import { test } from "node:test";
import assert from "node:assert/strict";
import { DESIGN_MODEL_RANK, DESIGN_NEVER_IDS, DESIGN_NEVER_REFS, designInGroup, designModelOrder, designSectionOf, designSectionOfWord } from "./design-models";

const refs = (ms: { ref: string }[]) => ms.map((x) => x.ref);

test("within a section: favorites first, then the ranked list, then unknown models newest version first", () => {
  const models = [
    { ref: "zai/glm-4.7" },
    { ref: "zai/aurora-2" },
    { ref: "zai/glm-5.2" },
    { ref: "zai/borealis-3.1" },
    { ref: "zai/borealis-3" },
    { ref: "zai/glm-5.3-flash", favorite: true },
    { ref: "zai/glm-5.3" },
    { ref: "zai/zeta" },
  ];
  assert.deepEqual(refs(designModelOrder(models)), ["zai/glm-5.3-flash", "zai/glm-5.3", "zai/glm-5.2", "zai/glm-4.7", "zai/borealis-3.1", "zai/borealis-3", "zai/aurora-2", "zai/zeta"]);
});

test("favorites lead only their own section, which keeps its place among the sections", () => {
  const models = [{ ref: "ollama/gemma3:1b", favorite: true }, { ref: "ollama-cloud/kimi-k3" }, { ref: "zai/glm-5.3" }, { ref: "openai-codex/gpt-6-luna" }, { ref: "openai-codex/gpt-6-astra" }, { ref: "claude-code-cli/claude-haiku-4-5" }, { ref: "claude-code-cli/claude-opus-5-5" }, { ref: "deepseek/deepseek-flash" }];
  assert.deepEqual(refs(designModelOrder(models)), ["claude-code-cli/claude-opus-5-5", "claude-code-cli/claude-haiku-4-5", "openai-codex/gpt-6-astra", "openai-codex/gpt-6-luna", "zai/glm-5.3", "deepseek/deepseek-flash", "ollama-cloud/kimi-k3", "ollama/gemma3:1b"]);
});

test("the ranked lists name each model once", () => {
  for (const [section, list] of Object.entries(DESIGN_MODEL_RANK)) assert.equal(new Set(list).size, list.length, section);
});

test("each group word the main chat says names exactly one section", () => {
  const cases: [string, string | null][] = [["GLM", "zai"], ["glm models", "zai"], ["Z.ai", "zai"], ["zai", "zai"], ["ollama-cloud", "ollama-cloud"], ["Ollama Cloud", "ollama-cloud"], ["ollama", "ollama"], ["claude", "claude"], ["GPT", "gpt"], ["openai", "gpt"], ["mistral", null]];
  for (const [word, section] of cases) assert.equal(designSectionOfWord(word), section, word);
});

test("a group takes in its section's models and no other's", () => {
  const all = ["zai/glm-5.3", "ollama-cloud/glm-5.3", "ollama/gemma3:270m", "openai-codex/gpt-6-luna", "claude-code-cli/claude-opus-5-5", "anthropic/claude-sonnet-5-5"];
  const take = (word: string) => all.filter((r) => designInGroup(r, word));
  assert.deepEqual(take("GLM"), ["zai/glm-5.3"], "GLM is Z.ai, never Ollama Cloud's GLM");
  assert.deepEqual(take("ollama-cloud"), ["ollama-cloud/glm-5.3"], "Ollama Cloud never ticks a local model");
  assert.deepEqual(take("ollama"), ["ollama/gemma3:270m"]);
  assert.deepEqual(take("claude"), ["claude-code-cli/claude-opus-5-5", "anthropic/claude-sonnet-5-5"]);
  assert.deepEqual(take("gpt"), ["openai-codex/gpt-6-luna"]);
});

test("Ollama on this computer and Ollama Cloud are separate sections", () => {
  assert.notEqual(designSectionOf("ollama/qwen3:4b").id, designSectionOf("ollama-cloud/qwen3:4b").id);
});

test("what the picker never offers", () => {
  assert.ok(DESIGN_NEVER_IDS.has("claude-opus-5"));
  assert.ok(DESIGN_NEVER_REFS.has("openai-codex/gpt-5.3-codex-spark"));
});
