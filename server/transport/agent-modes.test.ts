// The Transport agent's chat runs with none of this device's default modes (§app.transport/agent "Its own brief
// only"): a REAL chat, opened in this process in a throwaway PI_CODING_AGENT_DIR whose mode.json turns Delegate and
// the align, spec and vis minor modes on for every new chat, is put on AGENT_MODES exactly as the agent's start does
// (agent-wire.ts startChat), and stays there on its next open whatever that default says. No model request is made.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "sova-agent-modes-")));
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sova-agent-modes-cwd-")));
// A hosted runtime can still write here after after() ran (pi's catalogs, usage cache): exit is last.
process.on("exit", () => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});
writeFileSync(join(dir, "settings.json"), JSON.stringify({}));
const DEVICE_DEFAULT = { version: 1, mode: "delegate", strict: false, minorModes: ["align", "spec", "vis"] };
writeFileSync(join(dir, "mode.json"), JSON.stringify(DEVICE_DEFAULT));
process.env.PI_CODING_AGENT_DIR = dir;
await import("../testing/in-process-chats"); // chats open in this process (the server hosts none)
const { buildApp } = await import("../app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const { acquireChat, disposeAllChats } = await import("../chat-manager");
const { acquireChatHandle, closeChat } = await import("../chat-handle");
const { AGENT_MODES, applyAgentModes } = await import("./agent-wire");
after(async () => {
  await disposeAllChats();
});

async function newChat(): Promise<string> {
  const res = await app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, link: true }) });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { path: string }).path;
}

/** The newest `mode` entry's snapshot in the chat's file: what every reopen restores. */
const pinned = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "custom" && e.customType === "mode")
    .map((e) => e.data.active)
    .at(-1);

test("a device whose default turns Delegate, align, spec and vis on still starts the Transport agent's chat with no mode, and it stays so", async () => {
  // The device's default reaches a new chat here: without the agent's own modes, it would run with all of them.
  const plainChat = await acquireChat(await newChat());
  const plain = await plainChat.modeResult();
  assert.equal(plain.mode, "delegate");
  assert.deepEqual(plain.minorModes, ["align", "spec", "vis"]);
  assert.ok(plainChat.harness.activeTools().includes("align"), "a plain new chat here has the align tool");

  const path = await newChat();
  const chat = await acquireChatHandle(path);
  await applyAgentModes(chat);
  const now = await chat.modeResult();
  assert.equal(now.mode, AGENT_MODES.mode);
  assert.deepEqual(now.minorModes, [], "no align, spec, vis or memory");
  assert.deepEqual(now.projectModes ?? [], [], "no project mode");
  assert.equal(now.strict, false);
  assert.ok(!(await acquireChat(path)).harness.activeTools().includes("align"), "no align tool to open an alignment with");
  assert.deepEqual(pinned(path), { version: 1, mode: "normal", strict: false, minorModes: [] }, "pinned in its own file");

  // Its next open reads its own pin, never the device's default.
  await closeChat(path, "test: reopen");
  const again = await (await acquireChatHandle(path)).modeResult();
  assert.equal(again.mode, "normal");
  assert.deepEqual(again.minorModes, []);
});

test("a chat that can't be left on those modes refuses, so the agent never starts on the device's", async () => {
  const stuck = {
    switchMode: async () => ({ mode: "normal", minorModes: ["align"], strict: false }) as never,
    pinMode: async () => true,
  };
  await assert.rejects(applyAgentModes(stuck), /still on normal, align, not plain normal mode/);
  const unpinned = { switchMode: async () => ({ mode: "normal", minorModes: [], strict: false }) as never, pinMode: async () => false };
  await assert.rejects(applyAgentModes(unpinned), /couldn't be pinned/);
});
