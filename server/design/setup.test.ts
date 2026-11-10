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

test("Setup keeps only the layouts it offered, and the combine choice and seed it can read", () => {
  const prev = { brief: "x", models: [], directions: [{ name: "Minimalist", on: true }], layouts: [{ name: "Bento", on: false }, { name: "Compact", on: false }], combine: "pair" as const };
  const ok = cleanSetup(prev, { brief: "x", models: [], directions: [], layouts: [{ name: "Bento", on: true }], combine: "every", pairSeed: 7 });
  assert.ok(typeof ok !== "string");
  assert.deepEqual(ok.layouts!.map((d) => [d.name, d.on]), [["Bento", true], ["Compact", false]]);
  assert.equal(ok.combine, "every");
  assert.equal(ok.pairSeed, 7);
  assert.equal(cleanSetup(prev, { brief: "x", models: [], directions: [], layouts: [{ name: "Hexagon", on: true }] }), "That layout isn't on this card.");
  assert.match(cleanSetup(prev, { brief: "x", models: [], directions: [], combine: "all" }) as string, /combine/);
  assert.match(cleanSetup(prev, { brief: "x", models: [], directions: [], pairSeed: -1 }) as string, /pairSeed/);
  // Change on the brief: the layouts and how they combine change with the models and styles.
  const open = cleanSetup(prev, { brief: "other", models: [], directions: [], layouts: [{ name: "Compact", on: true }], combine: "every" }, true);
  assert.ok(typeof open !== "string");
  assert.equal(open.brief, "x");
  assert.deepEqual(open.layouts!.filter((d) => d.on).map((d) => d.name), ["Compact"]);
  assert.equal(open.combine, "every");
  // A run made before layouts offers none, and stays without them.
  const old = cleanSetup({ brief: "x", models: [], directions: [] }, { brief: "x", models: [], directions: [], layouts: [{ name: "Bento", on: true }] });
  assert.equal(old, "That layout isn't on this card.");
  const oldPlain = cleanSetup({ brief: "x", models: [], directions: [] }, { brief: "x", models: [], directions: [] });
  assert.ok(typeof oldPlain !== "string" && oldPlain.layouts === undefined);
});

test("a bare model id ticks one model, never the same id under two providers", () => {
  const designing = (models: string[], chatModel?: string, extra: { modelGroups?: string[] } = {}) =>
    setupModels(LISTED, open, NONE, { models, ...extra }, chatModel ? { chatModel } : {}).filter((m) => m.design).map((m) => m.ref);
  // glm-5.3 is under both Z.ai and Ollama Cloud: the chat's own provider decides.
  assert.deepEqual(designing(["glm-5.3"], "zai/glm-5.3-flash"), ["zai/glm-5.3"]);
  assert.deepEqual(designing(["glm-5.3"], "ollama-cloud/kimi-k3"), ["ollama-cloud/glm-5.3"]);
  // A provider named in the same request leads the chat's own.
  assert.deepEqual(designing(["glm-5.3", "ollama-cloud/kimi-k3"], "zai/glm-5.3-flash").sort(), ["ollama-cloud/glm-5.3", "ollama-cloud/kimi-k3"]);
  // An exact provider/id wins over everything, and stays alone.
  assert.deepEqual(designing(["ollama-cloud/glm-5.3"], "zai/glm-5.3-flash"), ["ollama-cloud/glm-5.3"]);
  assert.deepEqual(designing(["zai/glm-5.3", "glm-5.3"], "ollama-cloud/kimi-k3"), ["zai/glm-5.3"], "the bare id is the model already named");
  // Over every chat provider, with or without one: each bare id ticks at most one model.
  for (const chat of [undefined, "zai/x", "ollama-cloud/x", "claude-code-cli/x", "ollama/x"])
    for (const id of ["glm-5.3", "kimi-k3", "glm-4.7", "nope"]) {
      const got = designing([id], chat);
      assert.ok(got.length <= 1 && got.every((r) => r.endsWith(`/${id}`)), `${id} from ${chat}: ${got}`);
      if (id !== "nope") assert.equal(got.length, 1, `${id} from ${chat}`);
    }
  // A whole group still ticks the whole section.
  assert.deepEqual(designing(["glm-5.3"], "zai/x", { modelGroups: ["ollama-cloud"] }).sort(), ["ollama-cloud/glm-5.3", "ollama-cloud/kimi-k3", "ollama-cloud/old-retired"]);
});

test("a bare coordinator id resolves the same way, to one model", () => {
  const coord = (coordinator: string, chatModel?: string) => setupModels(LISTED, open, NONE, { coordinator }, chatModel ? { chatModel } : {}).filter((m) => m.coordinator).map((m) => m.ref);
  assert.deepEqual(coord("glm-5.3", "ollama-cloud/kimi-k3"), ["ollama-cloud/glm-5.3"]);
  assert.deepEqual(coord("glm-5.3", "zai/x"), ["zai/glm-5.3"]);
  assert.deepEqual(coord("ollama-cloud/glm-5.3", "zai/x"), ["ollama-cloud/glm-5.3"]);
});
