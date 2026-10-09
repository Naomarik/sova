// Settings → Memory (§chat.memory/summarizer), its routes, the Overseer's switch (§chat.memory/overseer) and the
// summarizer's call (usage purpose, fallback, policy). Files only under a temp agent dir; no CLI runs.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import type { MemorySettings, ModelPolicy, WorkerChoice } from "../../shared/protocol";
import type { DelegateSources } from "../delegate";

const agentDir = mkdtempSync(join(tmpdir(), "sova-memory-settings-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const settings = await import("./settings");
const { registerMemoryRoutes } = await import("./routes");
const { summarize, summaryClaudeArgs } = await import("./summarizer");
const { currentUsageContext } = await import("../../pi-config/extensions/llm-inflight/attribution.ts");

const EMPTY: ModelPolicy = { disabledProviders: [], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [] };
const sources: DelegateSources = {
  piModels: async () => [{ ref: "zai/glm-5.3", id: "glm-5.3", provider: "zai", thinkingLevels: ["off", "low", "medium", "high"] }],
  claudeModels: async () => [{ id: "claude-haiku-5-5", name: "Haiku", efforts: ["low", "medium", "high"] }],
  policy: () => EMPTY,
};
const haiku: WorkerChoice = { backend: "claude-code", model: "claude-haiku-5-5", effort: "low" };
const glm: WorkerChoice = { backend: "pi", model: "zai/glm-5.3", effort: "low" };

describe("the settings file (mode-memory.json)", () => {
  test("missing or corrupt: Haiku 5.5 at low effort, no fallback, UniiChat at 128 KB", () => {
    assert.equal(settings.memoryFile(), join(agentDir, "mode-memory.json"));
    assert.deepEqual(settings.loadMemorySettings(), { version: 1, summarizer: { primary: haiku, fallback: null } });
    assert.deepEqual(settings.defaultMemoryChoice(), { type: "uniichat", size: 128 });
    const f = join(agentDir, "corrupt.json");
    writeFileSync(f, "{ nope");
    assert.deepEqual(settings.loadMemorySettings(f), settings.memoryDefaults());
    assert.ok(!existsSync(settings.memoryFile()), "reading never writes");
  });

  test("a PUT body is strict; a stored file is read tolerantly", () => {
    assert.match((settings.parseMemorySettings({ version: 2 }) as { error: string }).error, /version: 1/);
    assert.match((settings.parseMemorySettings({ version: 1, summarizer: { primary: { backend: "nope" } } }) as { error: string }).error, /^summarizer\.primary:/);
    assert.match((settings.parseMemorySettings({ version: 1, summarizer: { primary: haiku }, default: { type: "uniichat", size: 7 } }) as { error: string }).error, /^default:/);
    const f = join(agentDir, "tolerant.json");
    writeFileSync(f, JSON.stringify({ version: 1, summarizer: { primary: { backend: "nope" }, fallback: glm }, default: { type: "zoomable", size: 9999 } }));
    assert.deepEqual(settings.loadMemorySettings(f), { version: 1, summarizer: { primary: haiku, fallback: glm } }, "a bad slot reads as its default");
  });

  test("a choice: a new type without a size takes that type's default size; a record without a size too", () => {
    assert.deepEqual(settings.applyMemoryPatch({ type: "uniichat", size: 64 }, { type: "zoomable" }), { type: "zoomable", size: 32 });
    assert.deepEqual(settings.applyMemoryPatch({ type: "uniichat", size: 64 }, { size: 256 }), { type: "uniichat", size: 256 });
    assert.deepEqual(settings.choiceOf({ type: "zoomable" }), { type: "zoomable", size: 32 });
    assert.ok("error" in settings.parseMemoryChoice({ size: 600 }, true), "over 512 KB");
    assert.ok("error" in settings.parseMemoryChoice({}, true));
  });
});

describe("the routes", () => {
  const overseerCalls: string[] = [];
  const app = new Hono();
  registerMemoryRoutes(app, {
    resolvePath: (raw) => (raw && raw.endsWith(".jsonl") && raw.startsWith(agentDir) ? raw : null),
    held: () => undefined,
    overseer: () => ({
      memory: { status: () => ({ state: "ready", messages: 0, background: 0 }), turnedOn: () => overseerCalls.push("on"), changed: () => overseerCalls.push("changed") },
      memorySwitched: () => overseerCalls.push("switched"),
    }),
    readBranch: async () => [],
    sources,
  });
  const req = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });

  test("GET /api/settings/memory: the file, its defaults, the backends and the types", async () => {
    const info = await (await req("GET", "/api/settings/memory")).json();
    assert.equal(info.file, settings.memoryFile());
    assert.deepEqual(info.defaults.summarizer.primary, haiku);
    assert.deepEqual(info.backends.map((b: { id: string }) => b.id), ["pi", "claude-code"]);
    assert.deepEqual(info.types.map((t: { id: string }) => t.id), ["uniichat", "zoomable"]);
  });

  test("PUT /api/settings/memory saves the summarizer and keeps a stored default it wasn't sent", async () => {
    settings.saveDefaultMemoryChoice({ type: "zoomable", size: 64 });
    const body: MemorySettings = { version: 1, summarizer: { primary: glm, fallback: haiku } };
    const r = await req("PUT", "/api/settings/memory", body);
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.deepEqual(out.warnings, []);
    const saved = JSON.parse(readFileSync(settings.memoryFile(), "utf8"));
    assert.deepEqual(saved, { version: 1, summarizer: { primary: glm, fallback: haiku }, default: { type: "zoomable", size: 64 } });
    assert.equal((await req("PUT", "/api/settings/memory", { version: 1 })).status, 400);
    assert.equal((await app.request("/api/settings/memory", { method: "PUT", body: "nope" })).status, 400);
  });

  test("the Overseer's switch: kept in overseer.json, told to its held chat, 400 on a bad body", async () => {
    const off = await (await req("GET", "/api/overseer/memory")).json();
    assert.equal(off.on, false);
    const on = await (await req("PUT", "/api/overseer/memory", { on: true, type: "uniichat" })).json();
    assert.deepEqual([on.on, on.type, on.size], [true, "uniichat", 128], "a new type takes its default size");
    assert.deepEqual(overseerCalls, ["on", "switched"]);
    const { readOverseerSettings } = await import("../overseer-store");
    assert.deepEqual(readOverseerSettings().memory, { on: true, type: "uniichat", size: 128 });
    for (const bad of [{ on: "yes" }, { size: 3 }, { type: "nope" }, []]) assert.equal((await req("PUT", "/api/overseer/memory", bad)).status, 400, JSON.stringify(bad));
  });

  test("the outline and open: 400 on a bad path or id/n, 404 when it isn't a session", async () => {
    assert.equal((await req("GET", "/api/memory")).status, 400);
    assert.equal((await req("GET", "/api/memory?path=/etc/x.jsonl")).status, 400);
    assert.equal((await req("GET", `/api/memory?path=${encodeURIComponent(join(agentDir, "nameless.jsonl"))}`)).status, 404);
    const p = encodeURIComponent(join(agentDir, "x.jsonl"));
    for (const q of ["id=1&n=2", "id=0&n=3", "id=-1&n=1", "id=0&n=0"]) assert.equal((await req("GET", `/api/memory/open?path=${p}&${q}`)).status, 400, q);
  });
});

describe("the summarizer's call", () => {
  /** A fake `claude` that answers `result`, recording the usage context it ran in. */
  function fakeClaude(result: string, contexts: unknown[]) {
    return ((_bin: string, _args: string[]) => {
      contexts.push(currentUsageContext());
      const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => void };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      child.stdin.on("finish", () => {
        child.stdout.end(JSON.stringify({ type: "result", is_error: false, result, usage: { input_tokens: 10, output_tokens: 5 } }));
        setImmediate(() => child.emit("close", 0));
      });
      child.stdin.resume();
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
  }
  const call = { system: "guide", prompt: "summarize message 3", sessionId: "s-1", cwd: "/w" };

  test("runs as the chat's own spend with purpose \"memory\", on the primary", async () => {
    const contexts: unknown[] = [];
    const out = await summarize(call, { settings: () => settings.memoryDefaults(), denied: () => null, spawn: fakeClaude("A line.", contexts), agentDir: () => agentDir });
    assert.deepEqual(out, { text: "A line.", model: "claude-haiku-5-5" });
    assert.deepEqual(contexts, [{ owner: "s-1", cwd: "/w", purpose: "memory", kind: "oneshot" }]);
  });

  test("a policy-denied primary falls to the fallback; both denied throws the last reason", async () => {
    const contexts: unknown[] = [];
    const both: MemorySettings = { version: 1, summarizer: { primary: glm, fallback: haiku } };
    const out = await summarize(call, { settings: () => both, denied: (c) => (c.backend === "pi" ? "zai is turned off" : null), spawn: fakeClaude("B.", contexts), agentDir: () => agentDir });
    assert.equal(out.model, "claude-haiku-5-5");
    await assert.rejects(summarize(call, { settings: () => both, denied: () => "turned off", spawn: fakeClaude("x", []), agentDir: () => agentDir }), /turned off/);
  });

  test("the argv: no tools, no settings sources, no session, the effort and the system prompt", () => {
    const a = summaryClaudeArgs(haiku, "SYS");
    assert.equal(a[a.indexOf("--tools") + 1], "");
    assert.equal(a[a.indexOf("--setting-sources") + 1], "");
    assert.ok(a.includes("--no-session-persistence"));
    assert.equal(a[a.indexOf("--effort") + 1], "low");
    assert.equal(a[a.indexOf("--system-prompt") + 1], "SYS");
  });
});
