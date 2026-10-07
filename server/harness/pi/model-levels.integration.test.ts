// Run: pnpm test -- server/harness/pi/model-levels.integration.test.ts. The model-levels seam in Sova
// (§app.model-levels/sova-boot, /scope, /mapping): the shared runtime gets the cached levels at boot,
// over a copy of pi-config/models.json, keeping the provider's compat; what /api/models reports per
// model; and a hosted session (the extension loaded, on that same runtime) sends each level, its system
// prompt as `system`. pi comes through testing/load-pi.ts, so PI_PACKAGE_DIR's pi is proved the same way.
// A hosted session sending each level to a capture server; boot and the fetch rules in-process are model-levels.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
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

// A capture server standing in for ollama.com: every body, one short streamed reply.
const bodies: any[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    bodies.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "x", object: "chat.completion.chunk", created: 0, model: "m" };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;

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

test("a hosted session on the shared runtime sends each level; the system prompt stays `system`", async () => {
  const { runtime } = await bootRuntime(true);
  const cwd = join(dir, "cwd");
  mkdirSync(cwd, { recursive: true });
  const settingsManager = SettingsManager.inMemory({ cacheWarming: "off", retry: { enabled: false } } as never);
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: dir, settingsManager, additionalExtensionPaths: [join(EXT, "index.ts")] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir: dir, modelRuntime: runtime, sessionManager: SessionManager.inMemory(cwd), settingsManager, resourceLoader, noTools: "builtin" });
  await session.bindExtensions({});
  const sent: Record<string, unknown> = {};
  for (const [id, level] of [
    ["deepseek-v4.1-flash", "off"],
    ["deepseek-v4.1-flash", "low"],
    ["deepseek-v4.1-flash", "max"],
    ["glm-5.3", "high"],
    ["nemotron-3-super", "off"],
    [UNMAPPED, "high"],
  ] as const) {
    await session.setModel(runtime.getModel(PROVIDER, id)!);
    session.setThinkingLevel(level);
    assert.equal(session.thinkingLevel, level);
    await session.prompt(`hi ${id} ${level}`);
    const body = bodies.at(-1);
    assert.equal(body.messages[0].role, "system", `${id}: never developer`);
    sent[`${id} ${level}`] = body.reasoning_effort ?? null;
  }
  session.dispose();
  assert.deepEqual(sent, {
    "deepseek-v4.1-flash off": "none",
    "deepseek-v4.1-flash low": "low",
    "deepseek-v4.1-flash max": "max",
    "glm-5.3 high": "high",
    "nemotron-3-super off": "none",
    [`${UNMAPPED} high`]: null,
  });
});
