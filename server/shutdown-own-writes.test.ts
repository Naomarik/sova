// Run: npx tsx --test server/shutdown-own-writes.test.ts (or npm test). Uses a throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
//
// §chat.transcript/own-writes-across-restart: a reply a server stop cuts off is written by the stop's
// abort, and that entry is the server's own write, even when the process ends before the runtime's
// own dispose returns (the shutdown races the disposes against a few seconds, then exits). Without
// the record, the next server read the file as changed by a process it can't identify, and refused
// to auto-resume the chat (§app.overseer/auto-resume) for 120 s.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { piSession } from "./harness/pi/testing/handle";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-shutdown-own-writes-")));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
const { markOwned, recentForeignWriteAgeSec } = await import("./write-guard");
const { setProcStartForTest } = await import("./chat-runtime/writer-lock");

// A held chat takes its writer lock, which reads this process's start time: from a fake, so a unit
// test spawns no `ps` (macOS reads it there).
setProcStartForTest((pid) => (pid === process.pid ? 1 : null));
after(async () => {
  await Promise.race([disposeAllChats(), new Promise((r) => setTimeout(r, 1000))]);
  setProcStartForTest(null);
});

const TEST_MODEL = {
  id: "stub", name: "stub", api: "stub", provider: "stub", baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000,
};
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function until(cond: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("a reply the stop's abort ended is recorded as ours before the runtime's dispose returns", async () => {
  const dir = join(agentDir, "sessions", "--tmp-shutdown-own-writes--");
  mkdirSync(dir, { recursive: true });
  const path = canonicalPath(join(dir, "2026-10-12T00-00-00-000Z_s1.jsonl"));
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: new Date().toISOString(), cwd: agentDir })}\n`, { flag: "wx" });
  markOwned(path);
  const chat = await acquireChat(path);
  const session = piSession(chat) as unknown as {
    _modelRuntime: { hasConfiguredAuth(p: string): boolean };
    agent: { state: { model: unknown }; getApiKey: unknown; streamFunction: unknown };
  };
  session._modelRuntime.hasConfiguredAuth = () => true;
  session.agent.state.model = TEST_MODEL;
  session.agent.getApiKey = async () => "stub";
  // A reply that streams until it is aborted, then ends as aborted (the partial reply pi writes).
  session.agent.streamFunction = async (_m: unknown, _c: unknown, opts: { signal?: AbortSignal }) => {
    const partial = { role: "assistant", api: "stub", provider: "stub", model: "stub", timestamp: Date.now(), content: [{ type: "text", text: "so far" }], usage };
    await new Promise<void>((r) => (opts.signal?.aborted ? r() : opts.signal?.addEventListener("abort", () => r(), { once: true })));
    const message = { ...partial, stopReason: "aborted", errorMessage: "Request was aborted" };
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "error", reason: "aborted", error: message };
      },
      result: async () => message,
    };
  };
  void chat.acceptPrompt("a long reply", undefined, "server").turn.catch(() => {});
  await until(() => piSession(chat).isStreaming);
  const before = piSession(chat).sessionManager.getEntries().length;
  // The stop: abort the run (index.ts shutdown), then dispose with a runtime whose own dispose never
  // returns, as when the process exits first.
  await chat.harness.abort();
  assert.ok(piSession(chat).sessionManager.getEntries().length > before, "the abort wrote the cut-off reply");
  (chat as unknown as { host: { dispose(): Promise<void> } }).host.dispose = () => new Promise(() => {});
  void chat.dispose();
  await until(() => chat.disposed);
  assert.equal(recentForeignWriteAgeSec(path), null, "the cut-off reply is the server's own write");
});

test("an entry a reply appends is recorded as ours at once, after pi appends it: a process that dies before the guard's 3 s tick leaves no 'recent' behind", async () => {
  const dir = join(agentDir, "sessions", "--tmp-own-writes-at-message-end--");
  mkdirSync(dir, { recursive: true });
  const path = canonicalPath(join(dir, "2026-10-12T00-00-00-000Z_s2.jsonl"));
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: "s2", timestamp: new Date().toISOString(), cwd: agentDir })}\n`, { flag: "wx" });
  markOwned(path);
  // From before the chat is held: no guard tick (every 3 s from then on) can have run by the check.
  const started = Date.now();
  const chat = await acquireChat(path);
  const session = piSession(chat) as unknown as {
    _modelRuntime: { hasConfiguredAuth(p: string): boolean };
    agent: { state: { model: unknown }; getApiKey: unknown; streamFunction: unknown };
  };
  session._modelRuntime.hasConfiguredAuth = () => true;
  session.agent.state.model = TEST_MODEL;
  session.agent.getApiKey = async () => "stub";
  const reply = { role: "assistant", api: "stub", provider: "stub", model: "stub", timestamp: Date.now(), content: [{ type: "text", text: "done" }], usage, stopReason: "stop" };
  session.agent.streamFunction = async () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: "done", reason: "stop", message: reply };
    },
    result: async () => reply,
  });
  void chat.acceptPrompt("hello", undefined, "server").turn.catch(() => {});
  await until(() => piSession(chat).sessionManager.getEntries().some((e) => (e as { message?: { role?: string } }).message?.role === "assistant"));
  await new Promise((r) => setImmediate(r));
  assert.ok(Date.now() - started < 3000, "before the guard's 3 s tick");
  // The process dies here: the next server finds the file as this one left it. The record matches the
  // file with the reply on it, so it was taken after pi appended the reply, never before.
  assert.ok(readFileSync(path, "utf8").includes('"text":"done"'));
  assert.equal(recentForeignWriteAgeSec(path), null, "the reply is the server's own write");
});
