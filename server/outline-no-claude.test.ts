// Run: pnpm test -- server/outline-no-claude.test.ts. §app.server-runtime/test-tiers ("No real Claude
// program"): a unit file's in-process chat, on this tree's pi-config extensions, summarizes its topic
// outline headless as Sova's chats do. With topic-outline's own settings, a settled turn reaches the
// Claude summarizer, which runs the Claude program from PATH: the test runner's stand-in, never the
// installed CLI. With the settings server/testing/agent-dir.ts writes, the outline's check runs at
// once after the turn and calls no model. Every Claude spawn is caught here, before the tier guard,
// and never runs. A throwaway PI_CODING_AGENT_DIR in the OS temp dir; the chat's model is a stub.
import assert from "node:assert/strict";
import * as cp from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import nodeModule from "node:module";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { claudeExecutable } from "../pi-config/extensions/claude-code/claude-executable.ts";
import { piSession } from "./harness/pi/testing/handle";
import { scratchRoot } from "./test-scratch";
import { linkPiConfigExtensions, UNIT_OUTLINE_SETTINGS } from "./testing/agent-dir";

const root = scratchRoot("sova-outline-guard-");
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
linkPiConfigExtensions(agentDir);

// Every `claude` a test here starts: recorded, refused (as a missing program is), never run.
const claudeSpawns: string[] = [];
const isClaude = (file: unknown) => typeof file === "string" && basename(file) === "claude";
const refuse = (file: string) => {
  claudeSpawns.push(file);
  throw Object.assign(new Error(`spawn ${file} ENOENT (caught by the test)`), { code: "ENOENT" });
};
// Node's ChildProcess#spawn (undeclared in its types), which every async spawn goes through.
const proto = cp.ChildProcess.prototype as unknown as { spawn: (this: unknown, options: { file?: string }) => unknown };
const protoSpawn = proto.spawn;
proto.spawn = function (options) {
  if (isClaude(options?.file)) refuse(options.file!);
  return protoSpawn.call(this, options);
};
const bun = (globalThis as { Bun?: { spawn: (...a: unknown[]) => unknown } }).Bun;
if (bun) {
  const bunSpawn = bun.spawn;
  bun.spawn = (...a: unknown[]) => {
    const cmd = Array.isArray(a[0]) ? a[0] : (a[0] as { cmd?: unknown[] } | undefined)?.cmd;
    if (isClaude(cmd?.[0])) refuse(String(cmd![0]));
    return bunSpawn(...a);
  };
}
nodeModule.syncBuiltinESMExports?.();

await import("./testing/in-process-chats"); // chats open in this process (the server hosts none)
const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
const { markOwned } = await import("./write-guard");

after(async () => {
  await disposeAllChats();
  rmSync(root, { recursive: true, force: true });
});

const STUB = {
  id: "stub", name: "stub", api: "stub", provider: "stub", baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000,
};
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** A chat on a session file of its own (its topic-outline settings read at its start), on a stub model. */
async function stubChat() {
  const id = randomUUID();
  const dir = join(agentDir, "sessions", "--guard--");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-10-14T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: root })}\n`);
  markOwned(canonicalPath(file));
  const path = canonicalPath(file);
  const s = piSession(await acquireChat(path)) as unknown as { _modelRuntime: { hasConfiguredAuth(p: string): boolean }; agent: { state: { model: unknown }; getApiKey: unknown; streamFunction: unknown } };
  s._modelRuntime.hasConfiguredAuth = () => true;
  s.agent.state.model = STUB;
  s.agent.getApiKey = async () => "stub";
  s.agent.streamFunction = async () => {
    const message = { role: "assistant", api: "stub", provider: "stub", model: "stub", timestamp: Date.now(), usage, content: [{ type: "text", text: "ok" }], stopReason: "stop" };
    return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; }, result: async () => message };
  };
  return { path, session: piSession(await acquireChat(path)) };
}
async function until(cond: () => boolean, what: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const outlineEntries = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "custom" && e.customType === "topic-outline");

test("the runner's PATH: the Claude program every spawn resolves is its stand-in, never the installed CLI", () => {
  const program = claudeExecutable();
  assert.equal(basename(dirname(program)), "fake-claude-bin", `resolved ${program}`);
  assert.match(readFileSync(program, "utf8"), /scripts\/fake-claude\.mjs/);
});

test("on topic-outline's own settings, a settled turn reaches the Claude summarizer, and it starts the stand-in", async () => {
  writeFileSync(join(agentDir, "topic-outline.json"), JSON.stringify({ trigger: { debounceMs: 0 } }));
  try {
    const before = claudeSpawns.length;
    const { session } = await stubChat();
    await session.prompt("Add a CSV export");
    await session.waitForIdle();
    await until(() => claudeSpawns.length > before, "the summarizer's claude spawn");
    assert.deepEqual(claudeSpawns.slice(before), [claudeExecutable()]);
  } finally {
    writeFileSync(join(agentDir, "topic-outline.json"), JSON.stringify(UNIT_OUTLINE_SETTINGS));
  }
});

test("on the unit settings (linkPiConfigExtensions), the outline's check runs at once after the turn and calls no model", async () => {
  await disposeAllChats();
  const before = claudeSpawns.length;
  const { path, session } = await stubChat();
  const headings = () => (outlineEntries(path).at(-1)?.data.topics ?? []).map((t: { heading: string }) => t.heading);
  await session.prompt("# Guard heading");
  await session.waitForIdle();
  await until(() => headings().length === 1, "the outline's check after the first turn");
  // Outline runs go one at a time: a summary the first check started (and its Claude spawn) ends
  // before the second turn's check writes its topic. So once both are in, any spawn has happened.
  await session.prompt("# Second heading");
  await session.waitForIdle();
  await until(() => headings().length === 2, "the outline's check after the second turn");
  assert.deepEqual(headings(), ["Guard heading", "Second heading"]);
  assert.deepEqual(claudeSpawns.slice(before), [], "no Claude summarizer ran");
});
