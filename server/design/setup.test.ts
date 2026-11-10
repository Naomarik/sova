import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelInfo, ModelPolicy } from "../../shared/protocol";
import { cleanSetup, setupModels } from "./setup";

const open: ModelPolicy = { disabledProviders: [], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [] };
const info = (ref: string, favorite = false): ModelInfo => ({ ref, provider: ref.slice(0, ref.indexOf("/")), id: ref.slice(ref.indexOf("/") + 1), favorite, thinkingLevels: [] });
const LISTED = [
  "ollama/gemma3:270m",
  "ollama-cloud/glm-5.3",
  "ollama-cloud/kimi-k3",
  "ollama-cloud/old-retired",
  "zai/glm-4.7",
  "zai/glm-5.3",
  "openai-codex/gpt-5.3-codex-spark",
  "openai-codex/gpt-6-luna",
  "claude-code-cli/claude-opus-5",
  "claude-code-cli/claude-opus-5-5",
  "deepseek/deepseek-v4-pro",
].map((r) => info(r));
const NONE = new Set<string>();

test("never offered: claude-opus-5, Codex Spark on a ChatGPT sign-in, retired Ollama models, and what Settings turns off", () => {
  const policy: ModelPolicy = { ...open, disabledModels: ["deepseek/deepseek-v4-pro"], subagentDisabledModels: ["ollama-cloud/kimi-k3"] };
  const refs = setupModels(LISTED, policy, new Set(["ollama-cloud/old-retired"]), {}).map((m) => m.ref);
  for (const gone of ["claude-code-cli/claude-opus-5", "openai-codex/gpt-5.3-codex-spark", "ollama-cloud/old-retired", "deepseek/deepseek-v4-pro", "ollama-cloud/kimi-k3"]) assert.ok(!refs.includes(gone), gone);
  assert.ok(refs.includes("claude-code-cli/claude-opus-5-5"));
  const offProvider = setupModels(LISTED, { ...open, subagentDisabledProviders: ["zai"] }, NONE, {}).map((m) => m.ref);
  assert.ok(!offProvider.some((r) => r.startsWith("zai/")), "a provider turned off for helpers is gone");
});

test("the main chat asking for GLM models ticks Z.ai's, and only those", () => {
  const ticked = setupModels(LISTED, open, NONE, { modelGroups: ["GLM models"] }).filter((m) => m.design).map((m) => m.ref);
  assert.deepEqual(ticked, ["zai/glm-5.3", "zai/glm-4.7"]);
});

test("asking for Ollama Cloud never ticks a local Ollama model, and the word ollama alone ticks only local ones", () => {
  assert.deepEqual(setupModels(LISTED, open, NONE, { modelGroups: ["ollama-cloud"] }).filter((m) => m.design).map((m) => m.ref), ["ollama-cloud/kimi-k3", "ollama-cloud/glm-5.3", "ollama-cloud/old-retired"]);
  assert.deepEqual(setupModels(LISTED, open, NONE, { modelGroups: ["ollama"] }).filter((m) => m.design).map((m) => m.ref), ["ollama/gemma3:270m"]);
});

test("rows come best first per provider, favorites leading their own section", () => {
  const listed = [...LISTED.filter((m) => m.ref !== "zai/glm-4.7"), info("zai/glm-4.7", true)];
  const refs = setupModels(listed, open, NONE, {}).map((m) => m.ref);
  assert.deepEqual(refs.slice(0, 4), ["claude-code-cli/claude-opus-5-5", "openai-codex/gpt-6-luna", "zai/glm-4.7", "zai/glm-5.3"]);
  assert.equal(refs.at(-1), "ollama/gemma3:270m", "this computer's Ollama comes last");
  assert.equal(setupModels(listed, open, NONE, {}).find((m) => m.ref === "zai/glm-4.7")?.favorite, true);
});

test("exactly one coordinator, which need not design", () => {
  const models = setupModels(LISTED, open, NONE, { modelGroups: ["glm"], coordinator: "gpt-6-luna" });
  assert.deepEqual(models.filter((m) => m.coordinator).map((m) => [m.ref, m.design]), [["openai-codex/gpt-6-luna", false]]);
  const setup = { brief: "x", models, directions: [] };
  const two = { ...setup, models: models.map((m) => ({ ...m, coordinator: m.ref === "openai-codex/gpt-6-luna" || m.ref === "zai/glm-5.3" })) };
  assert.equal(cleanSetup(setup, two), "Only one model can be the coordinator.");
  const moved = { ...setup, models: models.map((m) => ({ ...m, coordinator: m.ref === "zai/glm-5.3" })) };
  const kept = cleanSetup(setup, moved);
  assert.ok(typeof kept !== "string");
  assert.deepEqual(kept.models.filter((m) => m.coordinator).map((m) => m.ref), ["zai/glm-5.3"]);
});
