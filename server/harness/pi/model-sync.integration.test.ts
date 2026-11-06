// Run: node scripts/run-tests.mjs --integration server/harness/pi/model-sync.integration.test.ts
// §app.model-levels/sova-boot (F2): the real server (server/index.ts) on a throwaway
// PI_CODING_AGENT_DIR and an ephemeral port. Another process writes a newer model-levels.json, one
// whose check found a model models.json lacks; GET /api/models lists it, with no restart, and a
// retired one stays out. The status route reports the check. Nothing reaches the network: the
// provider points at a closed local port and the test process never checks (NODE_ENV=test).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import type { ModelCheckStatus, ModelInfo } from "../../../shared/protocol";

const REPO = resolve(import.meta.dirname, "../../..");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-model-sync-")));
const agentDir = join(tmp, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PORT = "0";
for (const name of ["SOVA_TOKEN", "SOVA_AUTH", "HOST", "SOVA_ALLOWED_HOSTS", "SOVA_ALLOWED_ORIGINS", "SOVA_MODELS_FETCH"]) delete process.env[name];
process.env.SOVA_USAGE_POLL = "off";
process.env.SOVA_PRICES_FETCH = "off";
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const PROVIDER = "ollama-cloud";
const NEW_ID = "glm-9-sync";
const baseUrl = "http://127.0.0.1:9/v1";
const models = JSON.parse(readFileSync(join(REPO, "pi-config/models.json"), "utf8"));
models.providers = { [PROVIDER]: { ...models.providers[PROVIDER], baseUrl, apiKey: "test" } };
writeFileSync(join(agentDir, "models.json"), JSON.stringify(models));

/** What another process's check leaves: written to a temp name and renamed over, as writeCache does. */
function writeLevelsFromOutside(cache: unknown) {
  const file = join(agentDir, "model-levels.json");
  const part = `${file}.outside.tmp`;
  writeFileSync(part, JSON.stringify(cache));
  renameSync(part, file);
}
const fixture = JSON.parse(readFileSync(join(REPO, "pi-config/extensions/model-levels/tests/fixture-cache.json"), "utf8"));
fixture.providers = { [PROVIDER]: { ...fixture.providers[PROVIDER], baseUrl, fetchedAt: Date.now() } };
writeLevelsFromOutside(fixture);

const { server } = await import("../../index");
const { AUTH_COOKIE, sovaToken } = await import("../../auth");
const AUTH = { Cookie: `${AUTH_COOKIE}=${sovaToken()}` };
if (!server.listening) await new Promise((r) => server.once("listening", r));
const port = (server.address() as AddressInfo).port;
after(() => {
  server.close();
  server.closeAllConnections();
  rmSync(tmp, { recursive: true, force: true });
});

const get = async <T>(path: string): Promise<T> => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: AUTH });
  assert.equal(res.status, 200, `${path}: ${res.status}`);
  return (await res.json()) as T;
};
const ids = async () => new Set((await get<ModelInfo[]>("/api/models")).filter((m) => m.provider === PROVIDER).map((m) => m.id));

/** Poll a condition the server reaches on its own (its file watch), up to a deadline. */
async function until<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("a newer model-levels.json written by another process reaches GET /api/models with no restart", async () => {
  const before = await ids();
  assert.ok(before.has("glm-5.3"), "models.json's models are listed");
  assert.ok(!before.has("glm-5.1"), "retired: hidden");
  assert.ok(!before.has(NEW_ID));

  const at = Date.now();
  const next = structuredClone(fixture);
  next.providers[PROVIDER].models[NEW_ID] = { source: "ollama", values: [false, "low", "high"], capabilities: ["completion", "thinking"] };
  next.providers[PROVIDER].discovered = { [NEW_ID]: { firstSeenAt: at, contextWindow: 131072, maxTokens: 32768, input: ["text"] } };
  next.checks = { [PROVIDER]: { at, ok: true, added: [NEW_ID], retired: [] } };
  writeLevelsFromOutside(next);

  const after = await until("the new model in /api/models", ids, (s) => s.has(NEW_ID));
  assert.ok(!after.has("glm-5.1"), "retired: still hidden");
  const info = (await get<ModelInfo[]>("/api/models")).find((m) => m.ref === `${PROVIDER}/${NEW_ID}`)!;
  assert.deepEqual(info.thinkingLevels, ["off", "low", "high"]);
  assert.equal(info.contextWindow, 131072);

  const status = await get<ModelCheckStatus>("/api/settings/models/check");
  assert.equal(status.provider, PROVIDER);
  assert.equal(status.enabled, false, "a test process never checks");
  assert.deepEqual(status.last, { at, ok: true, added: [NEW_ID], retired: [] });
  assert.deepEqual(status.newModels, [{ ref: `${PROVIDER}/${NEW_ID}`, firstSeenAt: at }]);
  const run = await fetch(`http://127.0.0.1:${port}/api/settings/models/check`, { method: "POST", headers: AUTH });
  assert.equal(run.status, 409, "checks off: Check now runs nothing");
});
