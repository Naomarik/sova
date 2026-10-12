// Run: npx tsx --test server/chat-joins.test.ts (or npm test). Uses a throwaway PI_CODING_AGENT_DIR in
// the OS temp dir; ~/.pi is never read or written.
//
// A pane that joins a chat mid-reply (§chat.transcript/streaming, "Joining mid-reply"): a wire-2 hello
// carries the reply so far; a dialog still open is sent to it again with the time it has left
// (§app.harness/session-open); a chat whose server dropped keeps its panes as orphans, so its dialogs
// stay open (§app.chat-processes/survives-restart); one writer lock per session file.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ChatServerMessage } from "../shared/protocol";
import { piSession } from "./harness/pi/testing/handle";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-chat-joins-")));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { acquireChat, BusyError, disposeAllChats } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
const { markOwned } = await import("./write-guard");
const { takeWriterLock } = await import("./chat-runtime/writer-lock");

after(async () => {
  await Promise.race([disposeAllChats(), new Promise((r) => setTimeout(r, 1000))]);
});

const TEST_MODEL = {
  id: "stub", name: "stub", api: "stub", provider: "stub", baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000,
};
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

let n = 0;
async function newChat() {
  const dir = join(agentDir, "sessions", "--tmp-chat-joins--");
  mkdirSync(dir, { recursive: true });
  const path = canonicalPath(join(dir, `2026-10-12T00-00-0${n}-000Z_j${n}.jsonl`));
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: `j${n++}`, timestamp: new Date().toISOString(), cwd: agentDir })}\n`, { flag: "wx" });
  markOwned(path);
  const chat = await acquireChat(path);
  return { chat, path };
}
async function until(cond: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const recorder = (wire?: 2) => {
  const got: unknown[] = [];
  return { got, client: { send: (m: unknown) => void got.push(m), ...(wire ? { wire } : {}) } as { send(m: ChatServerMessage): void; wire?: 2 } };
};

test("a wire-2 pane that joins mid-reply gets the reply so far in its hello", async () => {
  const { chat } = await newChat();
  const session = piSession(chat) as unknown as {
    _modelRuntime: { hasConfiguredAuth(p: string): boolean };
    agent: { state: { model: unknown }; getApiKey: unknown; streamFunction: unknown };
  };
  session._modelRuntime.hasConfiguredAuth = () => true;
  session.agent.state.model = TEST_MODEL;
  session.agent.getApiKey = async () => "stub";
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  session.agent.streamFunction = async () => {
    const at = Date.now();
    const partial = (text: string) => ({ role: "assistant", api: "stub", provider: "stub", model: "stub", timestamp: at, content: [{ type: "text", text }], usage, stopReason: "stop" });
    const done = partial("hello world");
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "start", partial: partial("") };
        yield { type: "text_start", contentIndex: 0, partial: partial("") };
        yield { type: "text_delta", contentIndex: 0, delta: "hello ", partial: partial("hello ") };
        await held;
        yield { type: "text_delta", contentIndex: 0, delta: "world", partial: done };
        yield { type: "text_end", contentIndex: 0, content: "hello world", partial: done };
        yield { type: "done", reason: "stop", message: done };
      },
      result: async () => done,
    };
  };
  const first = recorder(2);
  chat.attach(first.client);
  void chat.acceptPrompt("say hello", undefined, "server").turn.catch(() => {});
  await until(() => first.got.some((m) => JSON.stringify(m).includes("hello ")));
  const late = recorder(2);
  chat.attach(late.client);
  const hello = late.got.find((m) => (m as { type?: string }).type === "hello") as { live?: { message?: { parts: { text?: string }[] } } };
  assert.equal(hello.live?.message?.parts.map((p) => p.text ?? "").join(""), "hello ");
  const v1 = recorder();
  chat.attach(v1.client);
  assert.equal((v1.got.find((m) => (m as { type?: string }).type === "hello") as { live?: unknown }).live, undefined, "wire 1 never gets it");
  release();
  await piSession(chat).waitForIdle();
  const after1 = recorder(2);
  chat.attach(after1.client);
  assert.equal((after1.got.find((m) => (m as { type?: string }).type === "hello") as { live?: unknown }).live, undefined, "nothing streams: no live");
});

test("a second open of a file another process holds the writer lock of is refused as another writer", async () => {
  const { chat, path } = await newChat();
  await chat.dispose();
  // Another holder: this process can't hold it twice, which stands in for another live process.
  const lock = takeWriterLock(path);
  try {
    await assert.rejects(acquireChat(path), (err: unknown) => err instanceof BusyError && err.code === "recent");
  } finally {
    lock.release();
  }
  const again = await acquireChat(path);
  assert.ok(!again.disposed, "free again: it opens");
});
