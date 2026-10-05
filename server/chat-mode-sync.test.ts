// Run: npx tsx --test server/chat-mode-sync.test.ts (or npm test). Uses a throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
//
// A hosted chat opened on a session with a pinned mode keeps that mode's prompt section on every
// request, whoever started the turn. pi builds a user turn's prompt in before_agent_start (where
// the mode extension adds its section), but a turn an extension's message starts (a worker
// settling) rebuilds its second request from pi's base prompt options, which only a command
// context reaches. bind() hands them to the extension with `/mode sync`; without it the wake
// turn's tool call patched the section out (`mode: null`) and the next user turn patched it back.
//
// Real SDK runs, the real mode extension; only the model is a stub (no credentials here).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import type { ChatServerMessage } from "../shared/protocol";
import { piSession } from "./harness/pi/testing/handle";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-mode-sync-")));
// A hosted runtime can still write here after after() ran (pi's catalogs, usage cache): exit is last.
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths
const sessionsDir = join(agentDir, "sessions", "--tmp-mode-sync--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });
// A stand-in for the subagents extension: a tool to call, and its API kept so the test can deliver
// a worker's completion the way that extension does (sendMessage with triggerTurn).
mkdirSync(join(agentDir, "extensions"), { recursive: true });
writeFileSync(
  join(agentDir, "extensions", "fake-worker.ts"),
  `export default function (pi) {
  globalThis.__modeSyncPi = pi;
  pi.registerTool({ name: "echo", label: "echo", description: "echo", parameters: { type: "object", properties: {}, additionalProperties: true }, execute: async () => ({ content: [{ type: "text", text: "pong" }], details: {} }) });
}
`,
);
// This repo's mode extension, by its real path so its imports of sibling extensions resolve. No
// mode.json: the default is normal with no minor modes, so only the session's pin turns align on.
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [resolve(dirname(fileURLToPath(import.meta.url)), "../pi-config/extensions/mode")] }));

const { acquireChat, disposeAllChats, disposeHeldChat } = await import("./chat-manager");
const { markOwned } = await import("./write-guard");

after(async () => {
  await disposeAllChats();
  rmSync(agentDir, { recursive: true, force: true });
});

type Chat = Awaited<ReturnType<typeof acquireChat>>;
const TEST_MODEL = {
  id: "stub", name: "stub", api: "stub", provider: "stub", baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000,
};
/** The system prompt of every request the stub got, in order: pi 0.87 carries it as sections on the context's system messages. */
const prompts: string[] = [];
/** Each request's reply: a tool call, or (when empty) a plain "ok". */
const replies: Array<"tool" | "text"> = [];

function systemOf(context: unknown): string {
  const messages = (context as { messages?: { role: string; sections?: Record<string, string | null> }[] }).messages ?? [];
  // The sections the model has at this request: every system message's patch, applied in order.
  const sections: Record<string, string> = {};
  for (const m of messages) {
    if (m.role !== "system") continue;
    for (const [k, v] of Object.entries(m.sections ?? {})) {
      if (v === null) delete sections[k];
      else sections[k] = v;
    }
  }
  return JSON.stringify(sections);
}

function fakeRuns(chat: Chat): void {
  const session = piSession(chat) as unknown as {
    _modelRuntime: { hasConfiguredAuth(p: string): boolean };
    agent: { state: { model: unknown }; getApiKey: unknown; streamFunction: unknown };
  };
  session._modelRuntime.hasConfiguredAuth = () => true;
  session.agent.state.model = TEST_MODEL;
  session.agent.getApiKey = async () => "stub";
  session.agent.streamFunction = async (_model: unknown, context: unknown) => {
    prompts.push(systemOf(context));
    const call = replies.shift() === "tool";
    const message = {
      role: "assistant", api: "stub", provider: "stub", model: "stub", timestamp: Date.now(),
      content: call ? [{ type: "toolCall", id: `tc-${prompts.length}`, name: "echo", arguments: {} }] : [{ type: "text", text: "ok" }],
      stopReason: call ? "toolUse" : "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const end = { type: "done", reason: call ? "toolUse" : "stop", message };
    return { async *[Symbol.asyncIterator]() { yield end; }, result: async () => message };
  };
}

const client = {
  send: (m: ChatServerMessage) => {
    if (m.type === "error") throw new Error(`chat error: ${m.message}`);
  },
};
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A user turn from the chat socket: a tool call, then a reply. */
async function userTurn(chat: Chat, text: string): Promise<void> {
  const n = prompts.length;
  replies.push("tool", "text");
  chat.handle(client, { type: "prompt", text });
  await until(() => prompts.length >= n + 2);
  await piSession(chat).waitForIdle();
}

/** A worker settling: the subagents extension's message starts a turn, which calls a tool, then replies. */
async function wakeTurn(chat: Chat): Promise<void> {
  const n = prompts.length;
  replies.push("tool", "text");
  const pi = (globalThis as { __modeSyncPi?: { sendMessage(m: unknown, o: unknown): Promise<void> } }).__modeSyncPi!;
  await pi.sendMessage({ customType: "subagent-complete", content: "worker done", display: true }, { triggerTurn: true, deliverAs: "followUp" });
  await until(() => prompts.length >= n + 2);
  await piSession(chat).waitForIdle();
}

const modeSections = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "message" && e.message.role === "system" && e.message.sections && "mode" in e.message.sections)
    .map((e) => e.message.sections.mode as string | null);

test("a chat opened on a pinned mode keeps the mode section, byte-identical, on every request of user and wake turns, and after a reopen", async () => {
  const path = join(sessionsDir, "2026-09-28T00-00-00-000Z_01234567-89ab-7cde-8f01-000000000001.jsonl");
  const pin = { mode: "normal", active: { version: 1, mode: "normal", strict: false, minorModes: ["align"] } };
  writeFileSync(
    path,
    [
      { type: "session", version: 3, id: "01234567-89ab-7cde-8f01-000000000001", timestamp: "2026-09-28T00:00:00.000Z", cwd },
      { type: "custom", id: "m1", parentId: null, timestamp: "2026-09-28T00:00:00.000Z", customType: "mode", data: pin },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  markOwned(path);

  let chat = await acquireChat(path);
  assert.deepEqual([...chat.modeState.minorModes], ["align"], "the chat opens on its pinned mode");
  fakeRuns(chat);
  await userTurn(chat, "first");
  await wakeTurn(chat);
  await userTurn(chat, "second");
  assert.equal(prompts.length, 6);
  assert.match(prompts[0] ?? "", /# Minor mode: align/, "the first request carries the pinned mode's section");
  for (let i = 1; i < prompts.length; i++) assert.equal(prompts[i], prompts[0], `request ${i + 1} has the first request's prompt, byte for byte`);
  let recorded = modeSections(path);
  assert.equal(recorded.length, 1, "one mode section written for the whole session, never patched");
  assert.equal(typeof recorded[0], "string");

  // Reopened, as after a server restart: a fresh runtime and extension, the same prompt.
  await disposeHeldChat(path, "reopen");
  markOwned(path);
  chat = await acquireChat(path);
  fakeRuns(chat);
  const before = prompts.length;
  await wakeTurn(chat);
  await userTurn(chat, "third");
  for (let i = before; i < prompts.length; i++) assert.equal(prompts[i], prompts[0], `after the reopen, request ${i + 1} has the same prompt`);
  recorded = modeSections(path);
  assert.ok(!recorded.includes(null), "no mode: null patch anywhere in the session");
  assert.equal(recorded.length, 1, "still a single mode section: the reopen changed no byte");
});
