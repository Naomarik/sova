// Run: npx tsx --test server/decide-settings.test.ts — decisions.json, the Jev key file, the runtime
// wiring (chain order, key status) and the route handlers. PI_CODING_AGENT_DIR points at a
// throwaway dir (removed after); fetch and the model runtime are fakes; the real key is never read.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-decide-settings-")));
process.env.HOME = join(root, "home"); // the redactor reads credential files under HOME: never the real ones
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
delete process.env.SOVA_JEV_KEY;

const { decisionDefaults, decisionsFile, isExcluded, maySend, terminalSession, normalizeDecisionSettings, parseDecisionSettings, readDecisionSettings, writeDecisionSettings } = await import("./decide-settings");
const { cleanKey, deleteJevKey, jevKeyFile, readJevKey, writeJevKey } = await import("./decide-secret");
const { createDecisionRuntime } = await import("./decide-runtime");
const { decisionsInfo, deleteKey, probeDecisions, putJevKey, saveDecisions } = await import("./decide-routes");
const { serverRedactor, REDACTED } = await import("./overseer-redact");
const { disposeAllChats } = await import("./chat-manager");

after(async () => {
  await disposeAllChats();
  rmSync(root, { recursive: true, force: true });
});

const KEY = "tsk-test-" + "a1b2".repeat(15);
const OTHER = "tsk-other-" + "z9y8".repeat(15);

beforeEach(() => {
  rmSync(join(root, "agent"), { recursive: true, force: true });
  delete process.env.SOVA_JEV_KEY;
});

describe("decisions.json", () => {
  test("missing file → defaults: both features off, no fallback, Jev's switch on", () => {
    assert.deepEqual(readDecisionSettings(), decisionDefaults());
    assert.deepEqual(decisionDefaults().features, { attention: false, tags: false });
    assert.equal(decisionDefaults().fallback, null);
  });
  test("strict parse: each wrong field is refused with a sentence; exclusions normalized", () => {
    const ok = { ...decisionDefaults(), exclusions: ["/work/secret/", "~/private", "/work/secret"] };
    const parsed = parseDecisionSettings(ok);
    assert.ok(!("error" in parsed));
    assert.deepEqual(parsed.exclusions, ["/work/secret", "~/private"]);
    for (const bad of [
      { ...decisionDefaults(), version: 2 },
      { ...decisionDefaults(), jev: {} },
      { ...decisionDefaults(), fallback: { backend: "pi", model: "no-slash", effort: "off" } },
      { ...decisionDefaults(), features: { attention: "yes", tags: false } },
      { ...decisionDefaults(), exclusions: ["relative/dir"] },
      { ...decisionDefaults(), neverSendTui: 1 },
    ])
      assert.ok("error" in parseDecisionSettings(bad), JSON.stringify(bad));
  });
  test("tolerant read: a broken file is the defaults; a bad field costs only that field", () => {
    writeDecisionSettings(decisionDefaults());
    writeFileSync(decisionsFile(), "{ not json");
    assert.deepEqual(readDecisionSettings(), decisionDefaults());
    const n = normalizeDecisionSettings({ version: 1, jev: { enabled: false }, fallback: { backend: "x" }, features: { attention: true }, exclusions: ["/a", 5], neverSendTui: true });
    assert.deepEqual(n, { version: 1, jev: { enabled: false }, fallback: null, features: { attention: true, tags: false }, exclusions: ["/a"], neverSendTui: true });
  });
  test("atomic write round-trips", () => {
    const s = { ...decisionDefaults(), features: { attention: true, tags: false }, fallback: { backend: "claude-code" as const, model: "haiku", effort: "low" } };
    writeDecisionSettings(s);
    assert.deepEqual(readDecisionSettings(), s);
  });
});

describe("the send gate", () => {
  const s = { ...decisionDefaults(), features: { attention: true, tags: false }, exclusions: ["/work/secret", "~/private"], neverSendTui: true };
  test("path-boundary matching with ~ expanded", () => {
    assert.equal(isExcluded(s, "/work/secret", "/home/u"), true);
    assert.equal(isExcluded(s, "/work/secret/sub", "/home/u"), true);
    assert.equal(isExcluded(s, "/work/secrets", "/home/u"), false);
    assert.equal(isExcluded(s, "/home/u/private/x", "/home/u"), true);
    assert.equal(isExcluded(s, "/home/u/privately", "/home/u"), false);
  });
  test("a terminal session: open in a TUI now, or started outside Sova and not hosted here", () => {
    assert.equal(terminalSession({ live: { pid: 1 }, origin: "web" }), true);
    assert.equal(terminalSession({ live: null, origin: "external" }), true);
    assert.equal(terminalSession({ live: null, origin: "external" }, true), false);
    assert.equal(terminalSession({ live: null, origin: "web" }), false);
  });
  test("feature off, excluded, TUI — each refuses with its reason", () => {
    assert.deepEqual(maySend(s, "tags", { cwd: "/w", terminal: false }), { ok: false, reason: "feature-off" });
    assert.deepEqual(maySend(s, "attention", { cwd: "/work/secret/x", terminal: false }), { ok: false, reason: "excluded" });
    assert.deepEqual(maySend(s, "attention", { cwd: "/w", terminal: true }), { ok: false, reason: "tui" });
    assert.deepEqual(maySend({ ...s, neverSendTui: false }, "attention", { cwd: "/w", terminal: true }), { ok: true });
  });
});

describe("the key file", () => {
  test("written 0600 in a 0700 dir; read trimmed; env overrides; delete", () => {
    assert.equal(readJevKey(), null);
    writeJevKey(`  ${KEY}\n`);
    assert.equal(statSync(jevKeyFile()).mode & 0o777, 0o600);
    assert.equal(statSync(join(jevKeyFile(), "..")).mode & 0o777, 0o700);
    assert.deepEqual(readJevKey(), { key: KEY, source: "file" });
    assert.deepEqual(readJevKey({ SOVA_JEV_KEY: OTHER }), { key: OTHER, source: "env" });
    deleteJevKey();
    assert.equal(readJevKey(), null);
  });
  test("too short, too long, or with spaces is no key", () => {
    assert.equal(cleanKey("short"), null);
    assert.equal(cleanKey("x".repeat(513)), null);
    assert.equal(cleanKey("abc def ghi jkl mno pqr stu"), null);
    assert.throws(() => writeJevKey("short"));
  });
  test("the Overseer's redactor knows the stored key", () => {
    writeJevKey(KEY);
    assert.equal(serverRedactor().redact(`key=${KEY}`), `key=${REDACTED}`);
  });
});

/** A fake Jev: /v1/models answers by key, /v1/systemone answers `asks`/`outcome`. */
function fakeJev(opts: { goodKey?: string; decideStatus?: number } = {}) {
  const calls: string[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push(url);
    const auth = (init.headers as Record<string, string>).authorization ?? "";
    if (url.endsWith("/v1/models")) return new Response(JSON.stringify(auth === `Bearer ${opts.goodKey ?? KEY}` ? { data: [] } : { detail: { error_type: "authentication_error", message: "Cannot authenticate" } }), { status: auth === `Bearer ${opts.goodKey ?? KEY}` ? 200 : 401 });
    if (opts.decideStatus && opts.decideStatus !== 200) return new Response(JSON.stringify({ detail: "nope" }), { status: opts.decideStatus });
    const body = JSON.parse(String(init.body));
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(body.questions as Record<string, { type: string; criteria?: Record<string, unknown> }>))
      answers[id] = q.type === "noul" ? { type: "noul", noul: 0.9 } : { type: "choice", choice: Object.keys(q.criteria ?? {})[0], probabilities: Object.fromEntries(Object.keys(q.criteria ?? {}).map((k, i) => [k, i === 0 ? 1 : 0])), confidence: 1 };
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const noLlm = { runtime: async () => { throw new Error("no runtime in tests"); } };
const sources = {
  piModels: async () => [{ ref: "prov/m", id: "m", provider: "prov", thinkingLevels: ["off", "low"] }],
  claudeModels: async () => [{ id: "haiku", name: "Haiku", efforts: ["low", "medium"] }],
  policy: () => ({ disabledProviders: [], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [] }),
} as unknown as import("./delegate").DelegateSources;

describe("runtime: the chain order follows Jev's switch and the key (decision 3)", () => {
  test("Jev on + key → [jev, fallback]; Jev off → [fallback]; neither → not ready", () => {
    writeJevKey(KEY);
    const fb = { backend: "pi" as const, model: "prov/m", effort: "off" };
    let s: ReturnType<typeof decisionDefaults> = { ...decisionDefaults(), fallback: fb };
    const rt = createDecisionRuntime({ settings: () => s, fetch: fakeJev().f, llm: noLlm });
    assert.deepEqual(rt.chain.status().providers.map((p) => p.id), ["jev", "pi"]);
    s = { ...s, jev: { enabled: false } };
    assert.deepEqual(rt.chain.status().providers.map((p) => p.id), ["pi"]);
    s = { ...s, fallback: null };
    assert.deepEqual(rt.chain.status(), { ready: false, providers: [], reason: "Jev is off and no fallback model is set." });
    s = { ...s, jev: { enabled: true } };
    deleteJevKey();
    assert.equal(rt.chain.status().reason, "No Jev key is stored and no fallback model is set.");
  });

  test("the key's status: unverified → ok after a call → rejected after a 401; a new key starts unverified", async () => {
    writeJevKey(KEY);
    let status = 200;
    const f = (async (url: string, init: RequestInit) => (status === 200 ? fakeJev().f(url, init) : new Response(JSON.stringify({ detail: { error_type: "authentication_error" } }), { status }))) as unknown as typeof fetch;
    const rt = createDecisionRuntime({ settings: () => decisionDefaults(), fetch: f, llm: noLlm });
    assert.equal(rt.keyInfo().status, "unverified");
    assert.equal(rt.keyInfo().last4, KEY.slice(-4));
    const r = await rt.provider.decide({ purpose: "probe", state: "s", questions: { a: { type: "boolean", instructions: "x" } } });
    assert.equal(r.provider, "jev");
    assert.equal(rt.keyInfo().status, "ok");
    status = 401;
    await assert.rejects(rt.provider.decide({ purpose: "probe", state: "s", questions: { a: { type: "boolean", instructions: "x" } } }));
    assert.equal(rt.keyInfo().status, "rejected");
    writeJevKey(OTHER);
    assert.equal(rt.keyInfo().status, "unverified");
    assert.equal(rt.chain.status().providers[0]?.state, "ok", "a new key resets Jev's breaker");
  });

  test("state is redacted before any provider sees it; oversized state never leaves", async () => {
    writeJevKey(KEY);
    const seen: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push(String(init.body));
      return fakeJev().f(url, init);
    }) as unknown as typeof fetch;
    const rt = createDecisionRuntime({ settings: () => decisionDefaults(), fetch: f, llm: noLlm });
    await rt.provider.decide({ purpose: "probe", state: { text: `the key is ${KEY}` }, questions: { a: { type: "boolean", instructions: "x" } } });
    assert.equal(seen[0]!.includes(KEY), false);
    assert.ok(seen[0]!.includes(REDACTED));
    await assert.rejects(rt.provider.decide({ purpose: "probe", state: "x".repeat(40_000), questions: { a: { type: "boolean", instructions: "x" } } }), /too-large|characters/);
    assert.equal(seen.length, 1);
  });
});

describe("routes", () => {
  test("GET info never carries the key", () => {
    writeJevKey(KEY);
    const rt = createDecisionRuntime({ fetch: fakeJev().f, llm: noLlm });
    const info = decisionsInfo(rt);
    assert.equal(JSON.stringify(info).includes(KEY), false);
    assert.equal(info.key.present, true);
    assert.deepEqual(info.suggestions.map((s) => s.model), ["haiku", "ollama-cloud/deepseek-v4.1-flash"]);
    assert.equal(info.settings.fallback, null);
  });
  test("PUT key: a rejected key is not stored (422, DecisionKeyInfo body); a good one is, status ok", async () => {
    const rt = createDecisionRuntime({ fetch: fakeJev({ goodKey: KEY }).f, llm: noLlm });
    const bad = await putJevKey({ key: OTHER }, rt);
    assert.equal(bad.status, 422);
    assert.equal((bad.body as { status: string }).status, "rejected");
    assert.equal(readJevKey(), null);
    const good = await putJevKey({ key: KEY }, rt);
    assert.equal(good.status, 200);
    assert.equal((good.body as { status: string }).status, "ok");
    assert.equal(JSON.stringify(good.body).includes(KEY), false);
    assert.equal(readFileSync(jevKeyFile(), "utf8").trim(), KEY);
    assert.equal((await putJevKey({ key: "short" }, rt)).status, 400);
    assert.equal(deleteKey(rt).status, 200);
    assert.equal(readJevKey(), null);
  });
  test("PUT key while SOVA_JEV_KEY is set → 409", async () => {
    process.env.SOVA_JEV_KEY = OTHER;
    const rt = createDecisionRuntime({ fetch: fakeJev().f, llm: noLlm });
    assert.equal((await putJevKey({ key: KEY }, rt)).status, 409);
    assert.equal(deleteKey(rt).status, 409);
  });
  test("PUT settings: bad shape 400; a fallback the backend doesn't offer 400; features on with no provider → saved with a warning", async () => {
    const rt = createDecisionRuntime({ fetch: fakeJev().f, llm: noLlm });
    assert.equal((await saveDecisions({ version: 1 }, sources, rt)).status, 400);
    assert.equal((await saveDecisions({ ...decisionDefaults(), fallback: { backend: "pi", model: "prov/gone", effort: "off" } }, sources, rt)).status, 400);
    const r = await saveDecisions({ ...decisionDefaults(), features: { attention: true, tags: false } }, sources, rt);
    assert.equal(r.status, 200);
    assert.match((r.body as { warnings: string[] }).warnings.join(" "), /No Jev key is stored/);
    const ok = await saveDecisions({ ...decisionDefaults(), fallback: { backend: "pi", model: "prov/m", effort: "low" } }, sources, rt);
    assert.equal(ok.status, 200);
    assert.deepEqual(readDecisionSettings().fallback, { backend: "pi", model: "prov/m", effort: "low" });
  });
  test("probe: ok through Jev; a failing chain answers ok:false with the failure (never throws)", async () => {
    writeJevKey(KEY);
    const ok = await probeDecisions(createDecisionRuntime({ settings: () => decisionDefaults(), fetch: fakeJev().f, llm: noLlm }));
    assert.equal(ok.ok, true);
    assert.equal(ok.provider, "jev");
    assert.equal(ok.model, "jev-1.13.0");
    const bad = await probeDecisions(createDecisionRuntime({ settings: () => decisionDefaults(), fetch: fakeJev({ decideStatus: 529 }).f, llm: noLlm }));
    assert.equal(bad.ok, false);
    assert.equal(bad.failure, "overloaded");
    const none = await probeDecisions(createDecisionRuntime({ settings: () => ({ ...decisionDefaults(), jev: { enabled: false } }), fetch: fakeJev().f, llm: noLlm }));
    assert.equal(none.failure, "unavailable");
    assert.equal(none.chain.ready, false);
  });
});
