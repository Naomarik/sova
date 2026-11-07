// Run: pnpm test -- server/shell-who.test.ts
// §chat.shell-mode/who, in-process: a chat socket (server/ws.ts handleChat, by its recordFrame door, which takes
// any caller) passes a `shell` or `shell_stop` frame to its chat only when it is the operator's page or a peer.
// A script's, a chat's, an extension's or the Overseer's socket gets `shell_refused` for a `shell`, and nothing
// for a `shell_stop`; the chat (a stand-in that records what it is sent) is sent neither. Nothing runs here.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ChatClientMessage } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-shell-who-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths

const { setChatRouter } = await import("./chat-handle");
type ChatHandle = import("./chat-handle").ChatHandle;
type ChatClient = import("./chat-handle").ChatClient;
const { recordFrame } = await import("./ws");
const { SHELL_NOT_PAGE_TEXT } = await import("./chat-shell");
type NotPage = import("./page-only").NotPage;

/** The stand-in chat: what it was sent. */
const got: ChatClientMessage[] = [];
const chat = {
  attach: (c: ChatClient) => c.send({ type: "hello", items: [], isStreaming: false, model: null, thinking: "off", context: null } as never),
  clientMessage: (_c: ChatClient, m: ChatClientMessage) => void got.push(m),
  detach: () => {},
  sandboxInfo: async () => null,
  branch: async () => [],
};
setChatRouter({ ready: async () => {}, get: () => undefined, all: () => [], acquire: async () => chat as unknown as ChatHandle, close: async () => false });
after(() => {
  setChatRouter(null);
  rmSync(agentDir, { recursive: true, force: true });
});

/** One frame over a chat socket that is `who`: what the socket heard back once the frame went over. */
async function send(who: NotPage | null, frame: ChatClientMessage, opts: { stopsCommand?: boolean } = {}): Promise<Record<string, unknown>[]> {
  const heard: Record<string, unknown>[] = [];
  let helloIn!: () => void;
  const hello = new Promise<void>((r) => (helloIn = r));
  const rec = recordFrame(join(agentDir, "s.jsonl"), frame, (m) => (heard.push(m), m.type === "hello" && helloIn()), () => {}, who, opts);
  await hello;
  assert.equal(rec.emit(), true);
  await new Promise((r) => setImmediate(r));
  rec.close();
  return heard.filter((m) => m.type !== "hello");
}

const shell = (clientId: string): ChatClientMessage => ({ type: "shell", command: "echo hi", clientId });

test("a script's, a chat's, an extension's or the Overseer's socket: a command is refused with why, a stop does nothing", async () => {
  for (const who of ["script", "chat", "extension", "overseer"] as const) {
    got.length = 0;
    assert.deepEqual(await send(who, shell(`c-${who}`)), [{ type: "shell_refused", clientId: `c-${who}`, reason: "unavailable", message: SHELL_NOT_PAGE_TEXT }], who);
    assert.deepEqual(await send(who, { type: "shell_stop", id: "sh_1" }), [], `${who}: a stop has no answer`);
    assert.deepEqual(got, [], `${who}: the chat was sent neither`);
  }
});

test("the page's socket and a peer's: both frames reach the chat, and a stop can't say it came from elsewhere", async () => {
  for (const who of [null, "local"] as const) {
    got.length = 0;
    assert.deepEqual(await send(who, shell("c-1")), [], String(who));
    await send(who, { type: "shell_stop", id: "sh_1", by: "other" } as ChatClientMessage);
    assert.deepEqual(got, [{ type: "shell", command: "echo hi", clientId: "c-1" }, { type: "shell_stop", id: "sh_1" }], String(who));
  }
});

test("the Stop Command entry's socket (chat.shell.stop): its stop reaches the chat as one from elsewhere; it still starts nothing", async () => {
  for (const who of ["script", "chat", "extension", "overseer"] as const) {
    got.length = 0;
    await send(who, { type: "shell_stop", id: "sh_1" }, { stopsCommand: true });
    assert.deepEqual(got, [{ type: "shell_stop", id: "sh_1", by: "other" }], who);
    got.length = 0;
    assert.equal((await send(who, shell(`s-${who}`), { stopsCommand: true }))[0]?.type, "shell_refused", `${who}: never a command`);
    assert.deepEqual(got, [], `${who}: the chat was sent nothing`);
  }
});
