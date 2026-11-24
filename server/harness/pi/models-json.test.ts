// Run: pnpm test -- server/harness/pi/models-json.test.ts. The models.json Sova ships (pi-config/models.json)
// loads in the pinned pi: its added openai-codex model joins the built-in list and runs on the provider's
// own sign-in. Everything runs in a temp agent dir with a fake credential: no network, no ~/.pi.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadPi } from "./testing/load-pi.ts";

const pi = await loadPi();
const { ModelRuntime } = pi.agent;
const MODELS_JSON = fileURLToPath(new URL("../../../pi-config/models.json", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "sova-models-json-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("pi-config/models.json: openai-codex/gpt-6.2-sol is listed beside gpt-6.1-sol and is available on the Codex sign-in", async () => {
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ "openai-codex": { type: "oauth", access: "fake-access", refresh: "fake-refresh", expires: Date.now() + 3_600_000, accountId: "fake-account" } }));
  const runtime = await ModelRuntime.create({ authPath, modelsPath: MODELS_JSON, allowModelNetwork: false, refreshOnCreate: false });
  const all = runtime.getModels() as any[];
  const codex = all.filter((m) => m.provider === "openai-codex").map((m) => m.id);
  assert.ok(codex.includes("gpt-6.1-sol"), `the built-in list stays: ${codex.join(", ")}`);
  assert.ok(codex.includes("gpt-6.2-sol"), `the added model joins it: ${codex.join(", ")}`);
  const sol62 = all.find((m) => m.provider === "openai-codex" && m.id === "gpt-6.2-sol");
  const sol61 = all.find((m) => m.provider === "openai-codex" && m.id === "gpt-6.1-sol");
  assert.equal(sol62.name, "GPT-6.2 Sol");
  assert.equal(sol62.contextWindow, 1_050_000);
  assert.deepEqual(sol62.input, ["text", "image"]);
  for (const key of ["api", "baseUrl", "reasoning", "maxTokens", "cost"]) assert.deepEqual(sol62[key], sol61[key], key);
  const available = ((await runtime.getAvailable()) as any[]).filter((m) => m.provider === "openai-codex").map((m) => m.id);
  assert.ok(available.includes("gpt-6.2-sol"), `the Codex sign-in covers it: ${available.join(", ")}`);
  const signedOut = await ModelRuntime.create({ authPath: join(dir, "none.json"), modelsPath: MODELS_JSON, allowModelNetwork: false, refreshOnCreate: false });
  const none = ((await signedOut.getAvailable()) as any[]).filter((m) => m.provider === "openai-codex");
  assert.deepEqual(none, [], "without the sign-in it isn't offered: it carries no key of its own");
});
