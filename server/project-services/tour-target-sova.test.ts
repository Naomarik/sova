import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parseDefinition } from "../../shared/project-contract";
import type { TourSource } from "../../shared/tour";
import { resolveTourTarget, TourTargetRefused } from "./tour-target";
import type { InstanceRecord, Registry } from "./store";

// The managed-Sova gate, on Sova's own service definition (.sova/project.json): slot 0 is the live
// install and is refused; a copy in slot 1+ is a test copy only with its own real .agent and no model
// credentials there. Every refusal happens at resolution, before any contact (nothing listens here).
const SOVA = parseDefinition(readFileSync(resolve(import.meta.dirname, "../../.sova/project.json"), "utf8"));
const PORT = 48_317;

function fixture(slot: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tour-sova-gate-")));
  const checkout = join(root, "copy");
  mkdirSync(join(checkout, ".agent", "sova"), { recursive: true });
  const rec: InstanceRecord = { id: "copy-s", project: root, checkout, branch: "feat/x", slot, generation: 1, createdBy: "operator", createdAt: "2026-01-02T03:04:05.000Z", cutWorktree: false, desired: { server: "running" }, prints: {}, data: {}, ports: { server: { http: PORT } } };
  const registry: Registry = { version: 1, instances: [rec], shared: [] };
  const source: TourSource = { kind: "project", projectId: "sova", instanceId: rec.id, checkout, serviceId: "server", endpoint: "http" };
  const deps = {
    registry: () => registry, projectRoot: () => root, definition: () => SOVA, unitOf: (i: string, s: string) => `unit-${i}-${s}`,
    driver: { status: async () => ({ state: "active", pid: 4242 }) as never, owns: () => true },
    portOwner: () => ({ pid: 4243, cwd: checkout }),
  };
  return { root, checkout, registry, deps, agent: join(checkout, ".agent"), resolve: () => resolveTourTarget(source, deps), close: () => rmSync(root, { recursive: true, force: true }) };
}
const refused = (pattern: RegExp) => (error: unknown) => error instanceof TourTargetRefused && pattern.test(error.message);

test("slot 0 of Sova's own server is the live install: refused before contact with the test-copy copy", async () => {
  const f = fixture(0);
  try { await assert.rejects(f.resolve(), refused(/^Tours of Sova use a test copy; start one for this branch\.$/)); }
  finally { f.close(); }
});

test("a short source naming slot 0 of the chat's own Sova is derived, then still refused by the Sova rule before contact", async () => {
  const { resolveTourContext, resolveTourSource } = await import("../tours/context");
  const { stateView } = await import("../harness/state-view");
  for (const slot of [0, 6]) {
    const f = fixture(slot);
    try {
      const d = {
        registry: () => f.registry, projects: async () => [{ id: "prj_sovasova", root: f.root }],
        snapshot: async () => ({ sessionId: "chat", sessionFile: join(f.root, "chat.jsonl"), cwd: f.checkout, agentDir: join(f.root, "agent"), state: stateView([]), held: { on: false, enforcement: "none" } }),
      };
      const context = await resolveTourContext({ sessionId: "chat", sessionFile: join(f.root, "chat.jsonl"), cwd: "/forged", state: stateView([]) }, d);
      const derived = await resolveTourSource(context, { kind: "project", instanceId: "copy-s", serviceId: "server", endpoint: "http" }, d);
      assert.deepEqual(derived, { kind: "project", projectId: "prj_sovasova", instanceId: "copy-s", checkout: f.checkout, serviceId: "server", endpoint: "http" });
      if (slot === 0) await assert.rejects(resolveTourTarget(derived, f.deps), refused(/^Tours of Sova use a test copy; start one for this branch\.$/));
      else assert.deepEqual((await resolveTourTarget(derived, f.deps)).sova, { agentDir: f.agent }, "control: slot 6 is a verified copy");
    } finally { f.close(); }
  }
});

test("a slot 1+ copy with its own real .agent and no credentials is a verified managed Sova copy", async () => {
  const f = fixture(6);
  try {
    const target = await f.resolve();
    assert.equal(target.origin, `http://127.0.0.1:${PORT}`);
    assert.deepEqual(target.sova, { agentDir: f.agent });
    await target.assertCurrent();
    // Credentials appearing mid-attempt stop it at the next contact.
    writeFileSync(join(f.agent, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fixture-not-a-key" } }));
    await assert.rejects(target.assertCurrent(), refused(/can call a model/));
  } finally { f.close(); }
});

test("an empty auth.json and a models.json without keys pass (slot 6 ships an empty auth.json)", async () => {
  const f = fixture(6);
  try {
    writeFileSync(join(f.agent, "auth.json"), "{}");
    writeFileSync(join(f.agent, "models.json"), JSON.stringify({ providers: { local: { baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "m" }] } } }));
    assert.deepEqual((await f.resolve()).sova, { agentDir: f.agent });
  } finally { f.close(); }
});

const models = (providers: unknown) => JSON.stringify({ providers });
test("a loopback provider's short literal placeholder key is not a credential; its catalogue may link inside the checkout", async () => {
  const admitted: [string, (f: ReturnType<typeof fixture>) => void][] = [
    ["placeholder on loopback", f => writeFileSync(join(f.agent, "models.json"), models({ ollama: { baseUrl: "http://localhost:11434/v1", api: "openai-completions", apiKey: "ollama", models: [{ id: "m" }] } }))],
    ["placeholder of exactly 16 characters on 127.0.0.1", f => writeFileSync(join(f.agent, "models.json"), models({ stub: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "x".repeat(16) } }))],
    ["a model's placeholder inheriting its provider's loopback baseUrl", f => writeFileSync(join(f.agent, "models.json"), models({ stub: { baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "m", apiKey: "local" }] } }))],
    ["a model's own placeholder on its own loopback baseUrl", f => writeFileSync(join(f.agent, "models.json"), models({ stub: { models: [{ id: "m", baseUrl: "http://[::1]:1/v1", apiKey: "local" }] } }))],
    // A managed copy's real layout: .agent/models.json links into the copy's own pi-config.
    ["the real pi-config/models.json through an in-checkout link", f => {
      mkdirSync(join(f.checkout, "pi-config"));
      writeFileSync(join(f.checkout, "pi-config", "models.json"), readFileSync(resolve(import.meta.dirname, "../../pi-config/models.json")));
      symlinkSync(join(f.checkout, "pi-config", "models.json"), join(f.agent, "models.json"));
    }],
    ["a relative in-checkout link to {}", f => { writeFileSync(join(f.checkout, "models.json"), "{}"); symlinkSync("../models.json", join(f.agent, "models.json")); }],
  ];
  for (const [name, arrange] of admitted) {
    const f = fixture(6);
    try { arrange(f); assert.deepEqual((await f.resolve()).sova, { agentDir: f.agent }, name); }
    finally { f.close(); }
  }
});

test("model credentials in any form, or no real .agent of its own, refuse the copy", async () => {
  const cases: [string, (f: ReturnType<typeof fixture>) => void, RegExp][] = [
    ["auth.json with a provider entry", f => writeFileSync(join(f.agent, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "fixture-not-a-key" } })), /^This test copy can call a model; remove its auth\.json or record a copy without one\.$/],
    ["auth.json unparsable", f => writeFileSync(join(f.agent, "auth.json"), "{nope"), /can call a model/],
    ["auth.json not an object", f => writeFileSync(join(f.agent, "auth.json"), "[]"), /can call a model/],
    ["auth.json oversize", f => writeFileSync(join(f.agent, "auth.json"), " ".repeat(300 * 1024) + "{}"), /can call a model/],
    // A literal one character over the placeholder bound (16), on loopback.
    ["models.json with a 17-character literal apiKey", f => writeFileSync(join(f.agent, "models.json"), JSON.stringify({ providers: { stub: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k".repeat(17) } } })), /can call a model/],
    ["models.json placeholder on a non-loopback baseUrl", f => writeFileSync(join(f.agent, "models.json"), models({ ollama: { baseUrl: "https://api.example.test/v1", apiKey: "ollama" } })), /can call a model/],
    ["models.json placeholder on a built-in provider (no baseUrl)", f => writeFileSync(join(f.agent, "models.json"), models({ openai: { apiKey: "ollama" } })), /can call a model/],
    ["models.json env-reference key on loopback", f => writeFileSync(join(f.agent, "models.json"), models({ ollama: { baseUrl: "http://localhost:11434/v1", apiKey: "$OLLAMA_KEY" } })), /can call a model/],
    ["models.json braced env-reference key on loopback", f => writeFileSync(join(f.agent, "models.json"), models({ ollama: { baseUrl: "http://localhost:11434/v1", apiKey: "${K}" } })), /can call a model/],
    ["models.json command key on loopback", f => writeFileSync(join(f.agent, "models.json"), models({ ollama: { baseUrl: "http://localhost:11434/v1", apiKey: "!pass show x" } })), /can call a model/],
    ["models.json model-level key on a non-loopback model baseUrl", f => writeFileSync(join(f.agent, "models.json"), models({ stub: { baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "m", baseUrl: "https://api.example.test/v1", apiKey: "local" }] } })), /can call a model/],
    ["models.json model-level placeholder inheriting a non-loopback provider baseUrl", f => writeFileSync(join(f.agent, "models.json"), models({ stub: { baseUrl: "https://api.example.test/v1", models: [{ id: "m", apiKey: "local" }] } })), /can call a model/],
    ["models.json numeric apiKey on loopback", f => writeFileSync(join(f.agent, "models.json"), models({ stub: { baseUrl: "http://127.0.0.1:1/v1", apiKey: 12345 } })), /can call a model/],
    ["models.json object apiKey on loopback", f => writeFileSync(join(f.agent, "models.json"), models({ stub: { baseUrl: "http://127.0.0.1:1/v1", apiKey: { value: "x" } } })), /can call a model/],
    ["models.json string authHeader", f => writeFileSync(join(f.agent, "models.json"), models({ stub: { baseUrl: "http://127.0.0.1:1/v1", authHeader: "Bearer fixture" } })), /can call a model/],
    // Request headers carry a credential as well as apiKey does (a literal, $ENV or !command value).
    ["models.json with provider headers", f => writeFileSync(join(f.agent, "models.json"), JSON.stringify({ providers: { stub: { baseUrl: "http://127.0.0.1:1/v1", headers: { Authorization: "Bearer $FIXTURE_NOT_A_KEY" } } } })), /can call a model/],
    ["models.json with a model's own headers", f => writeFileSync(join(f.agent, "models.json"), JSON.stringify({ providers: { stub: { baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "m", headers: { "x-api-key": "!print-fixture-key" } }] } } })), /can call a model/],
    ["models.json link outside the checkout", f => { writeFileSync(join(f.root, "models.json"), "{}"); symlinkSync(join(f.root, "models.json"), join(f.agent, "models.json")); }, /can call a model/],
    ["models.json link through an in-checkout dir link pointing outside", f => { mkdirSync(join(f.root, "outside")); writeFileSync(join(f.root, "outside", "models.json"), "{}"); symlinkSync(join(f.root, "outside"), join(f.checkout, "cfg")); symlinkSync(join(f.checkout, "cfg", "models.json"), join(f.agent, "models.json")); }, /can call a model/],
    ["models.json link hopping outside and back", f => { writeFileSync(join(f.checkout, "models.json"), "{}"); symlinkSync(join(f.checkout, "models.json"), join(f.root, "hop.json")); symlinkSync(join(f.root, "hop.json"), join(f.agent, "models.json")); }, /can call a model/],
    ["models.json dangling in-checkout link", f => symlinkSync(join(f.checkout, "missing.json"), join(f.agent, "models.json")), /can call a model/],
    ["models.json in-checkout link to a keyed catalogue", f => { writeFileSync(join(f.checkout, "models.json"), models({ stub: { baseUrl: "https://api.example.test/v1", apiKey: "ollama" } })); symlinkSync(join(f.checkout, "models.json"), join(f.agent, "models.json")); }, /can call a model/],
    ["auth.json in-checkout link to {} (auth.json is never followed)", f => { writeFileSync(join(f.checkout, "auth.json"), "{}"); symlinkSync(join(f.checkout, "auth.json"), join(f.agent, "auth.json")); }, /can call a model/],
    ["auth.json dangling link (never followed)", f => symlinkSync(join(f.root, "missing.json"), join(f.agent, "auth.json")), /can call a model/],
    ["auth.json link to a real file", f => { writeFileSync(join(f.root, "real.json"), "{}"); symlinkSync(join(f.root, "real.json"), join(f.agent, "auth.json")); }, /can call a model/],
    ["auth.json directory", f => mkdirSync(join(f.agent, "auth.json")), /can call a model/],
    ["no .agent", f => rmSync(f.agent, { recursive: true }), /use a test copy/],
    [".agent is a link", f => { const real = join(f.root, "real-agent"); mkdirSync(real); rmSync(f.agent, { recursive: true }); symlinkSync(real, f.agent); }, /use a test copy/],
    [".agent is a file", f => { rmSync(f.agent, { recursive: true }); writeFileSync(f.agent, "x"); }, /use a test copy/],
  ];
  for (const [name, arrange, pattern] of cases) {
    const f = fixture(6);
    try { arrange(f); await assert.rejects(f.resolve(), refused(pattern), name); }
    finally { f.close(); }
  }
});

test("another project's service is never treated as a Sova copy", async () => {
  const f = fixture(0);
  try {
    const other = { ...SOVA, services: SOVA.services.map(s => ({ ...s, adopt: undefined })) };
    const target = await resolveTourTarget({ kind: "project", projectId: "p", instanceId: "copy-s", checkout: f.checkout, serviceId: "server", endpoint: "http" }, {
      registry: () => ({ version: 1, shared: [], instances: [{ id: "copy-s", project: f.root, checkout: f.checkout, branch: null, slot: 2, generation: 1, createdBy: "operator", createdAt: "2026-01-02T03:04:05.000Z", cutWorktree: false, desired: { server: "running" }, prints: {}, data: {}, ports: { server: { http: PORT } } }] }),
      projectRoot: () => f.root, definition: () => other, unitOf: (i, s) => `unit-${i}-${s}`,
      driver: { status: async () => ({ state: "active", pid: 4242 }) as never, owns: () => true }, portOwner: () => ({ pid: 4243, cwd: f.checkout }),
    });
    assert.equal(target.sova, undefined, "no managed-Sova allowance for an ordinary service");
  } finally { f.close(); }
});

test("a provider key in the copy's own service environment refuses it", async () => {
  const f = fixture(6);
  try {
    const keyed = { ...SOVA, services: SOVA.services.map(s => s.adopt ? { ...s, env: { ...s.env, OPENAI_API_KEY: "fixture-not-a-key" } } : s) };
    const refusal = await resolveTourTarget({ kind: "project", projectId: "sova", instanceId: "copy-s", checkout: f.checkout, serviceId: "server", endpoint: "http" }, {
      registry: () => ({ version: 1, shared: [], instances: [{ id: "copy-s", project: f.root, checkout: f.checkout, branch: null, slot: 6, generation: 1, createdBy: "operator", createdAt: "2026-01-02T03:04:05.000Z", cutWorktree: false, desired: { server: "running" }, prints: {}, data: {}, ports: { server: { http: PORT } } }] }),
      projectRoot: () => f.root, definition: () => keyed, unitOf: (i, s) => `unit-${i}-${s}`,
      driver: { status: async () => ({ state: "active", pid: 4242 }) as never, owns: () => true }, portOwner: () => ({ pid: 4243, cwd: f.checkout }),
    }).then(() => null, (e: Error) => e.message);
    assert.equal(refusal, "This test copy can call a model; remove its auth.json or record a copy without one.");
    assert.equal(String(refusal).includes("fixture-not-a-key"), false, "never quotes a credential");
  } finally { f.close(); }
});

test("the default live-port set includes this server's own listen port", async () => {
  const { authListenPort, setAuthPort } = await import("../auth");
  const before = authListenPort();
  const none: Registry = { version: 1, instances: [], shared: [] };
  const port = 48_731;
  setAuthPort(port);
  try {
    // No sovaPorts seam: the production set (project previews' ports ∪ this server's listen port).
    await assert.rejects(resolveTourTarget({ kind: "site", origin: `http://127.0.0.1:${port}` }, { registry: () => none }), refused(/^Tours of Sova use a test copy; start one for this branch\.$/));
    // Control: the next port is not one of this server's.
    assert.equal((await resolveTourTarget({ kind: "site", origin: `http://127.0.0.1:${port + 1}` }, { registry: () => none })).origin, `http://127.0.0.1:${port + 1}`);
  } finally { setAuthPort(before); }
});
