// Run: npx tsx --test server/model-policy.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Point BOTH the server module and (would it be loaded) the extensions' policy.ts at a scratch
// agent dir: getAgentDir() reads PI_CODING_AGENT_DIR per call, so no real file is touched.
const dir = mkdtempSync(join(tmpdir(), "pi-web-model-policy-"));
mkdirSync(join(dir, "subagents"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = dir;
const { EMPTY_POLICY, modelAllowed, modelDenial, readModelPolicy, writeModelPolicy } = await import("./model-policy");
const file = () => join(dir, "model-policy.json");
const legacy = () => join(dir, "subagents", "settings.json");

test.after(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(dir, { recursive: true, force: true });
});

test("read: missing, corrupt and foreign files disable nothing", () => {
  assert.deepEqual(readModelPolicy(), EMPTY_POLICY);
  writeFileSync(file(), "{corrupt");
  assert.deepEqual(readModelPolicy(), EMPTY_POLICY);
  writeFileSync(file(), JSON.stringify({ version: 2, disabledProviders: ["x"] }));
  assert.deepEqual(readModelPolicy(), EMPTY_POLICY);
  writeFileSync(file(), JSON.stringify({ version: 1, disabledProviders: "nope", subagentDisabledModels: [] }));
  assert.deepEqual(readModelPolicy(), EMPTY_POLICY);
  rmSync(file());
});

test("migration: the old Subagent models file becomes the subagent dimension, nothing global", () => {
  // Every model a user has today keeps working; only their worker restrictions carry over.
  writeFileSync(legacy(), JSON.stringify({ version: 1, disabledProviders: ["ollama-cloud"], disabledModels: ["openai/gpt-5.2"] }));
  assert.deepEqual(readModelPolicy(), {
    disabledProviders: [],
    disabledModels: [],
    subagentDisabledProviders: ["ollama-cloud"],
    subagentDisabledModels: ["openai/gpt-5.2"],
  });
  assert.equal(modelAllowed(readModelPolicy(), "ollama-cloud/deepseek-v4.1-flash"), true);
  // The unified file wins from the first save, and the old one is left alone.
  const wrote = writeModelPolicy({ ...EMPTY_POLICY, disabledProviders: ["zai"] });
  assert.ok(!("error" in wrote));
  assert.deepEqual(readModelPolicy().subagentDisabledProviders, []);
  assert.match(readFileSync(legacy(), "utf8"), /ollama-cloud/);
  rmSync(file());
  rmSync(legacy());
});

test("write: canonicalizes (lowercase, dedupe, sort), rejects bad shapes, reads back", () => {
  const wrote = writeModelPolicy({
    disabledProviders: ["ZAI", "zai", " anthropic "],
    disabledModels: ["OpenAI/GPT-5.2", "claude-code/opus"],
    subagentDisabledProviders: [],
    subagentDisabledModels: ["Ollama/qwen3"],
  });
  assert.ok(!("error" in wrote), "valid policy writes");
  assert.deepEqual(wrote, {
    disabledProviders: ["anthropic", "zai"],
    disabledModels: ["claude-code/opus", "openai/gpt-5.2"],
    subagentDisabledProviders: [],
    subagentDisabledModels: ["ollama/qwen3"],
  });
  assert.deepEqual(readModelPolicy(), wrote);
  // The file on disk is the extensions' contract shape (pi-config/extensions/model-policy).
  assert.deepEqual(JSON.parse(readFileSync(file(), "utf8")), { version: 1, ...wrote });
  // Bad shapes are rejected whole, and the last good write survives.
  for (const bad of [
    { disabledProviders: "nope" },
    { disabledProviders: ["ok"], disabledModels: ["no-slash"] },
    { disabledProviders: ["has/slash"] },
    { subagentDisabledModels: ["no-slash"] },
    null,
    [],
    { disabledProviders: Array.from({ length: 201 }, (_, i) => `p${i}`) },
  ]) {
    assert.equal("error" in writeModelPolicy(bad), true, JSON.stringify(bad));
  }
  assert.deepEqual(readModelPolicy(), wrote);
});

test("absent keys disable nothing, and an empty policy is the nothing-disabled file", () => {
  const wrote = writeModelPolicy({ disabledProviders: ["zai"] });
  assert.deepEqual(wrote, { ...EMPTY_POLICY, disabledProviders: ["zai"] });
  assert.deepEqual(writeModelPolicy(EMPTY_POLICY), EMPTY_POLICY);
  assert.deepEqual(readModelPolicy(), EMPTY_POLICY);
});

test("a denial names the switch that has to move; an allowed model has none", () => {
  writeModelPolicy({ disabledProviders: ["anthropic"], disabledModels: ["openai/gpt-5.2"], subagentDisabledProviders: ["zai"] });
  const policy = readModelPolicy();
  assert.equal(modelAllowed(policy, "anthropic/claude-sonnet-5"), false);
  assert.match(modelDenial(policy, "anthropic/claude-sonnet-5")!, /Provider anthropic is turned off.*another provider/s);
  assert.equal(modelAllowed(policy, "openai/gpt-5.2"), false);
  assert.match(modelDenial(policy, "OpenAI/GPT-5.2")!, /is turned off in Settings → Models/);
  // A subagent-only restriction is a different question: the model is still yours to drive.
  assert.equal(modelAllowed(policy, "zai/glm-5.3"), true);
  assert.equal(modelDenial(policy, "zai/glm-5.3"), null);
  assert.equal(modelDenial(policy, "openai/gpt-5.1"), null);
});
