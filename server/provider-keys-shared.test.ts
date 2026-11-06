// Run: pnpm test -- server/provider-keys-shared.test.ts. Ollama Cloud's key check is one reading with Settings →
// Models' model list check (§app.provider-keys/key-tab, §app.model-levels/settings-line): Check Now records the
// key's outcome in its round, and the Accounts tab's Test runs that round, so both screens show one time and one
// result. The key is fake; every request (ollama.com, models.dev) is stubbed; the agent dir is a scratch one.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";

const root = mkdtempSync(join(tmpdir(), "sova-provider-keys-shared-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir; // before auth.ts computes its cookie name
process.env.SOVA_MODELS_FETCH = "on";
delete process.env.PI_OFFLINE;
delete process.env.SOVA_AUTH;
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "ollama-cloud": { baseUrl: "https://ollama.com/v1", api: "openai-completions", models: [{ id: "m1" }] } } }));
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ "ollama-cloud": { type: "api_key", key: "fake-ollama-key-0001" } }));

/** What ollama.com answers the key with, per request. */
let keyStatus = 401;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === "https://ollama.com/api/usage") return new Response(keyStatus === 200 ? "{}" : "", { status: keyStatus });
  if (url === "https://ollama.com/api/tags") return Response.json({ models: [{ name: "m1" }] });
  if (url.startsWith("https://ollama.com/")) return new Response("", { status: 404 });
  return Response.json({}); // models.dev
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
  rmSync(root, { recursive: true, force: true });
});

const { AUTH_COOKIE, sovaToken } = await import("./auth");
const { modelCheck, modelCheckStatus, setModelCheckKey } = await import("./harness/pi/model-sync");
const { linkOllamaReading, ProviderKeysService, registerProviderKeyRoutes } = await import("./provider-keys");
after(() => setModelCheckKey(null));

// The service as server/app.ts builds it.
const app = new Hono();
registerProviderKeyRoutes(app, linkOllamaReading(new ProviderKeysService({ signIns: async () => ({ claude: false, openai: false }) })));
const ask = (path: string, method = "GET") =>
  app.fetch(new Request(`http://127.0.0.1:4800${path}`, { method, headers: { cookie: `${AUTH_COOKIE}=${sovaToken()}` } }), { incoming: { socket: { remoteAddress: "127.0.0.1" }, headers: {} } });
const ollamaRow = async () => ((await (await ask("/api/settings/accounts/keys")).json()) as { rows: { provider: string; status: string; lastCheck?: { at: number; result: string } }[] }).rows.find((r) => r.provider === "ollama-cloud")!;

test("Settings → Models' Check Now with a refused key: the Ollama Cloud tab reads Key refused at the Models check's time", async () => {
  keyStatus = 401;
  const record = await modelCheck().checkNow();
  assert.ok(record?.ok, "the model list itself was read");
  const models = modelCheckStatus();
  assert.equal(models.last?.key?.result, "refused", "the round recorded the key's refusal");
  const row = await ollamaRow();
  assert.equal(row.status, "refused");
  assert.equal(row.lastCheck?.at, models.last?.at, "one time in both places");
  assert.equal(row.lastCheck?.result, "refused");
});

test("the tab's Test is that round: the Models line moves to the Test's time, with the same outcome", async () => {
  const before = modelCheckStatus().last!.at;
  while (Date.now() <= before) await new Promise((r) => setImmediate(r)); // a later clock reading than the last round
  keyStatus = 200;
  const res = await ask("/api/settings/accounts/keys/ollama-cloud/test", "POST");
  assert.equal(res.status, 200);
  const row = (await res.json()) as { status: string; lastCheck?: { at: number; result: string } };
  const models = modelCheckStatus();
  assert.ok(models.last!.at > before, "Settings → Models' line has a new time");
  assert.equal(row.lastCheck?.at, models.last!.at, "the tab's time is the Models line's");
  assert.deepEqual([row.status, row.lastCheck?.result, models.last?.key?.result], ["connected", "accepted", "accepted"]);
  assert.equal((await ollamaRow()).lastCheck?.at, models.last!.at, "and the list reads it the same");
});
