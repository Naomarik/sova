// Run: npx tsx --test server/input-source.test.ts (or npm test). Uses a throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
//
// §app.overseer/input-source: what a session's extensions are told about where a message came from.
// Real SDK runs up to the model call, with a recording `input` handler; only the model is a stub.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { ChatServerMessage } from "../shared/protocol";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-input-source-")));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;
// Records each input's text and source, as wake-nudge and vision-delegate read it.
mkdirSync(join(agentDir, "extensions"), { recursive: true });
writeFileSync(
  join(agentDir, "extensions", "record-input.ts"),
  `export default function (pi) {
  pi.on("input", (event) => {
    (globalThis.__inputs ??= []).push({ text: event.text, source: event.source });
  });
}
`,
);

const { inputSourceOf } = await import("./queue");
const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { canonicalPath } = await import("./paths");
const { markOwned } = await import("./write-guard");
const overseer = await import("./overseer");
const sessionPrompt = await import("./session-prompt");

after(async () => {
  await disposeAllChats();
});

const g = globalThis as unknown as { __inputs?: { text: string; source: string }[] };
const sourceOf = (text: string) => g.__inputs?.find((i) => i.text === text)?.source;

const TEST_MODEL = {
  id: "stub", name: "stub", api: "stub", provider: "stub", baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000,
};
/** Model calls wait on this while set, so a run stays mid-turn. */
let hold: Promise<void> | null = null;
type Chat = Awaited<ReturnType<typeof acquireChat>>;
function stubModel(chat: Chat): void {
  const session = chat.session as unknown as {
    _modelRuntime: { hasConfiguredAuth(p: string): boolean };
    agent: { state: { model: unknown }; getApiKey: unknown; streamFunction: unknown };
  };
  session._modelRuntime.hasConfiguredAuth = () => true;
  session.agent.state.model = TEST_MODEL;
  session.agent.getApiKey = async () => "stub";
  session.agent.streamFunction = async () => {
    if (hold) await hold;
    const message = {
      role: "assistant", api: "stub", provider: "stub", model: "stub", timestamp: Date.now(), content: [{ type: "text", text: "ok" }], stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; }, result: async () => message };
  };
}
/** A webapp-owned session, held, on the stub model. */
async function newChat(): Promise<{ chat: Chat; path: string }> {
  const sm = SessionManager.create(agentDir);
  writeFileSync(sm.getSessionFile()!, `${JSON.stringify(sm.getHeader())}\n`, { flag: "wx" });
  const path = canonicalPath(sm.getSessionFile()!);
  markOwned(path);
  const chat = await acquireChat(path);
  stubModel(chat);
  return { chat, path };
}
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const client = {
  send: (m: ChatServerMessage) => {
    if (m.type === "error") throw new Error(`chat error: ${m.message}`);
  },
};

describe("input source (§app.overseer/input-source)", () => {
  test("inputSourceOf: user (pi's interactive) only for what a person typed", () => {
    assert.equal(inputSourceOf({ origin: "client" }), "user");
    assert.equal(inputSourceOf({ origin: "server", byPerson: true }), "user", "a group batch");
    assert.equal(inputSourceOf({ origin: "server", baton: { by: "p1" } }), "user", "a baton participant");
    assert.equal(inputSourceOf({ origin: "server" }), "queued", "a brief, a schedule, another session");
    assert.equal(inputSourceOf({ origin: "server", overseer: {} }), "queued", "sova_send");
    assert.equal(inputSourceOf({ origin: "client", overseer: {} }), "queued", "a project overseer's prompt");
  });

  test("a server prompt (a brief, auto-resume's report), sova_send and a group batch reach the extensions as rpc, rpc and interactive; a typed one as interactive", async () => {
    const { chat, path } = await newChat();
    await chat.acceptPrompt("[overseer-brief] a brief", undefined, "server").turn;
    await until(() => sourceOf("[overseer-brief] a brief") !== undefined);
    await chat.session.waitForIdle();
    assert.equal(sourceOf("[overseer-brief] a brief"), "rpc");
    // sova_send's route, which auto-resume's prompts take too.
    const sent = await sessionPrompt.promptSession(path, "sent by the overseer");
    assert.ok(sent.ok);
    await until(() => sourceOf("sent by the overseer") !== undefined);
    await chat.session.waitForIdle();
    assert.equal(sourceOf("sent by the overseer"), "rpc");
    await chat.acceptPrompt("from the group composer", undefined, "server", undefined, { byPerson: true }).turn;
    await until(() => sourceOf("from the group composer") !== undefined);
    await chat.session.waitForIdle();
    assert.equal(sourceOf("from the group composer"), "interactive");
    chat.handle(client, { type: "prompt", text: "typed here" });
    await until(() => sourceOf("typed here") !== undefined);
    await chat.session.waitForIdle();
    assert.equal(sourceOf("typed here"), "interactive");
    assert.ok(!g.__inputs!.some((i) => i.source === "extension"), "never extension: vision-delegate skips that");
  });

  test("queued behind a running turn, a server prompt is still rpc at its hand-off", async () => {
    const { chat } = await newChat();
    let release!: () => void;
    hold = new Promise((r) => (release = r));
    chat.handle(client, { type: "prompt", text: "a long turn" });
    await until(() => chat.session.isStreaming);
    const r = chat.acceptPrompt("queued brief", undefined, "server");
    assert.equal(r.queued, true);
    hold = null;
    release();
    await until(() => sourceOf("queued brief") !== undefined, 5000);
    await chat.session.waitForIdle();
    assert.equal(sourceOf("a long turn"), "interactive");
    assert.equal(sourceOf("queued brief"), "rpc");
  });
});
