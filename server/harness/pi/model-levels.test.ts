// Run: pnpm test -- server/harness/pi/model-levels.test.ts. The model-levels seam in Sova
// (§app.model-levels/sova-boot, /scope, /mapping): the shared runtime gets the cached levels at boot,
// over a copy of pi-config/models.json, keeping the provider's compat; what /api/models reports per
// model; and a hosted session (the extension loaded, on that same runtime) sends each level, its system
// prompt as `system`. pi comes through testing/load-pi.ts, so PI_PACKAGE_DIR's pi is proved the same way.
// A hosted session sending each level to a capture server on 127.0.0.1: model-levels.integration.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { supportedThinkingLevels } from "../../models";
import { applyModelLevelsAtBoot, modelFetchEnabled } from "./open";
import { loadPi } from "./testing/load-pi.ts";

const REPO = resolve(import.meta.dirname, "../../..");
const EXT = join(REPO, "pi-config/extensions/model-levels");
const dir = realpathSync(mkdtempSync(join(tmpdir(), "sova-model-levels-")));
after(() => rmSync(dir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = dir;
const pi = await loadPi();
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = pi.agent;

const PROVIDER = "ollama-cloud";
const UNMAPPED = "seam-unmapped";

// The provider points nowhere: nothing here sends a request (the hosted session that does is the integration file).
const baseUrl = "http://127.0.0.1:9/v1";

const models = JSON.parse(readFileSync(join(REPO, "pi-config/models.json"), "utf8"));
models.providers[PROVIDER].baseUrl = baseUrl;
models.providers[PROVIDER].apiKey = "test";
models.providers[PROVIDER].models.push({ id: UNMAPPED, reasoning: true });
writeFileSync(join(dir, "models.json"), JSON.stringify(models));

async function bootRuntime(withCache: boolean) {
  const cachePath = join(dir, "model-levels.json");
  rmSync(cachePath, { force: true });
  if (withCache) {
    const cache = JSON.parse(readFileSync(join(EXT, "tests/fixture-cache.json"), "utf8"));
    cache.providers[PROVIDER].baseUrl = baseUrl;
    cache.providers[PROVIDER].fetchedAt = Date.now();
    writeFileSync(cachePath, JSON.stringify(cache));
  }
  const runtime = await ModelRuntime.create({ modelsPath: join(dir, "models.json"), authPath: join(dir, "auth.json") });
  const registered = applyModelLevelsAtBoot(runtime as never, dir, false);
  return { runtime, registered };
}

test("no cache: nothing registered, every model as models.json makes it", async () => {
  const { runtime, registered } = await bootRuntime(false);
  assert.deepEqual(registered, []);
  assert.deepEqual(supportedThinkingLevels(runtime.getModel(PROVIDER, "deepseek-v4.1-flash") as never), ["off", "minimal", "low", "medium", "high"]);
  assert.ok(runtime.getModel(PROVIDER, "glm-5.1"), "nothing dropped without metadata");
});

test("boot: the cached levels over pi's composed models keep the provider's compat (a13)", async () => {
  const { runtime, registered } = await bootRuntime(true);
  assert.deepEqual(registered, [PROVIDER]);
  const glm = runtime.getModel(PROVIDER, "glm-5.3")!;
  assert.equal((glm.compat as any).supportsDeveloperRole, false);
  assert.equal((glm.compat as any).supportsReasoningEffort, true);
  const unmapped = runtime.getModel(PROVIDER, UNMAPPED)!;
  assert.equal((unmapped.compat as any).supportsReasoningEffort, false, "no metadata: the provider's flag stays");
  assert.equal(runtime.getModel(PROVIDER, "glm-5.1"), undefined, "retired: dropped");
  assert.equal(runtime.getModel(PROVIDER, "qwen3.5:397b"), undefined, "retired: dropped");
  // What GET /api/models reports (toModelInfo's thinkingLevels).
  const want: Record<string, string[]> = {
    "deepseek-v4.1-flash": ["off", "low", "high", "max"],
    "kimi-k3": ["off", "low", "high", "max"],
    "glm-5.3": ["low", "high", "max"],
    "gpt-oss:20b": ["low", "medium", "high"],
    "nemotron-3-super": ["off", "high"],
    "minimax-m2.7": ["high"],
  };
  for (const [id, levels] of Object.entries(want)) assert.deepEqual(supportedThinkingLevels(runtime.getModel(PROVIDER, id) as never), levels, id);
  assert.deepEqual(applyModelLevelsAtBoot(runtime as never, dir, false), [], "applied twice: nothing to change");
});

test("boot fetches follow PI_OFFLINE, SOVA_MODELS_FETCH and the test-process rule", () => {
  assert.equal(modelFetchEnabled({}), true);
  assert.equal(modelFetchEnabled({ PI_OFFLINE: "1", SOVA_MODELS_FETCH: "on" }), false);
  assert.equal(modelFetchEnabled({ SOVA_MODELS_FETCH: "off" }), false);
  assert.equal(modelFetchEnabled({ NODE_ENV: "test" }), false);
  assert.equal(modelFetchEnabled({ NODE_ENV: "test", SOVA_MODELS_FETCH: "1" }), true);
  assert.equal(modelFetchEnabled({ NODE_TEST_CONTEXT: "child" }), false);
});
