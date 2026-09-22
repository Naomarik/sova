// Run: npx tsx --test src/lib/model-policy.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelInfo } from "../../shared/protocol";
import {
  EMPTY_POLICY,
  enabledCount,
  modelEnabled,
  modelSubagentEnabled,
  modelSubagentPreference,
  providerEnabled,
  providerOf,
  providerSubagentEnabled,
  providerSubagentPreference,
  setModelEnabled,
  setModelSubagents,
  setProviderEnabled,
  setProviderSubagents,
  type ModelPolicy,
} from "./model-policy";

const policy = (over: Partial<ModelPolicy> = {}): ModelPolicy => ({ ...EMPTY_POLICY, ...over });
const model = (ref: string): ModelInfo => ({
  ref,
  provider: ref.slice(0, ref.indexOf("/")),
  id: ref.slice(ref.indexOf("/") + 1),
  favorite: false,
  thinkingLevels: ["off"],
});

test("nothing disabled: every question answers yes", () => {
  const p = EMPTY_POLICY;
  assert.equal(providerEnabled(p, "zai"), true);
  assert.equal(providerSubagentEnabled(p, "zai"), true);
  assert.equal(modelEnabled(p, "zai/glm-5.3"), true);
  assert.equal(modelSubagentEnabled(p, "zai/glm-5.3"), true);
});

test("global off covers subagents; the subagent preference is remembered, not cleared", () => {
  const p = policy({ disabledModels: ["zai/glm-5.3"], subagentDisabledModels: ["zai/glm-5.3"] });
  assert.equal(modelEnabled(p, "zai/glm-5.3"), false);
  assert.equal(modelSubagentEnabled(p, "zai/glm-5.3"), false);
  assert.equal(modelSubagentPreference(p, "zai/glm-5.3"), false); // what the greyed switch shows
  // …and a model that is off globally but allowed for workers still shows its own switch on.
  const kept = policy({ disabledModels: ["zai/glm-5.3"] });
  assert.equal(modelSubagentEnabled(kept, "zai/glm-5.3"), false);
  assert.equal(modelSubagentPreference(kept, "zai/glm-5.3"), true);
  // Turning it back on returns exactly that preference.
  assert.equal(modelSubagentEnabled(setModelEnabled(kept, "zai/glm-5.3", true), "zai/glm-5.3"), true);
});

test("a subagent-only restriction leaves the model yours to drive", () => {
  const p = policy({ subagentDisabledProviders: ["anthropic"] });
  assert.equal(modelEnabled(p, "anthropic/claude-sonnet-5"), true);
  assert.equal(modelSubagentEnabled(p, "anthropic/claude-sonnet-5"), false);
  assert.equal(providerSubagentPreference(p, "anthropic"), false);
});

test("a provider covers its models, and turning it back on returns the list the screen showed", () => {
  const off = setProviderEnabled(policy({ disabledModels: ["zai/glm-5.3"] }), "zai", false);
  assert.deepEqual(off.disabledProviders, ["zai"]);
  assert.deepEqual(off.disabledModels, []); // the provider already says no
  assert.equal(modelEnabled(off, "zai/glm-5.3-flash"), false);
  const on = setProviderEnabled(off, "zai", true);
  assert.equal(modelEnabled(on, "zai/glm-5.3"), true);
  assert.equal(modelEnabled(on, "zai/glm-5.3-flash"), true);
  // The same rule one dimension down, and the two dimensions don't touch each other.
  const workersOff = setProviderSubagents(policy({ subagentDisabledModels: ["zai/glm-5.3"] }), "zai", false);
  assert.deepEqual(workersOff.subagentDisabledProviders, ["zai"]);
  assert.deepEqual(workersOff.subagentDisabledModels, []);
  assert.deepEqual(workersOff.disabledProviders, []);
});

test("switches are idempotent and case-insensitive", () => {
  let p = setModelEnabled(EMPTY_POLICY, "ZAI/GLM-5.3", false);
  assert.deepEqual(p.disabledModels, ["zai/glm-5.3"]);
  p = setModelEnabled(p, "zai/glm-5.3", false);
  assert.deepEqual(p.disabledModels, ["zai/glm-5.3"]); // one entry, not two
  assert.equal(modelEnabled(p, "ZAI/GLM-5.3"), false);
  p = setModelEnabled(p, "Zai/Glm-5.3", true);
  assert.deepEqual(p.disabledModels, []);
  const workers = setModelSubagents(EMPTY_POLICY, "zai/glm-5.3", false);
  assert.deepEqual(workers.subagentDisabledModels, ["zai/glm-5.3"]);
  assert.deepEqual(workers.disabledModels, []);
});

test("a provider row's count is how many of its models may be used at all", () => {
  const models = ["zai/glm-5.3", "zai/glm-5.3-flash", "zai/glm-4.7"].map(model);
  assert.equal(enabledCount(EMPTY_POLICY, models), 3);
  assert.equal(enabledCount(policy({ disabledModels: ["zai/glm-4.7"] }), models), 2);
  assert.equal(enabledCount(policy({ disabledProviders: ["zai"] }), models), 0);
  // A subagent restriction is a different question and never moves this count.
  assert.equal(enabledCount(policy({ subagentDisabledProviders: ["zai"] }), models), 3);
});

test("providerOf reads the prefix, and a ref without one has no provider", () => {
  assert.equal(providerOf("ollama-cloud/DeepSeek-V4.1"), "ollama-cloud");
  assert.equal(providerOf("sonnet"), "");
  assert.equal(providerOf("/leading"), "");
});
