// Run: pnpm test -- server/sova-modes-owner.test.ts. Who runs a chat's modes (§chat.mode-menu/sova-runs-modes):
// the Experimental switch "Sova runs chat modes" (experimental.sovaModes, on by default) picks exactly one
// owner per chat at its open: Sova's engine, loaded in the slot the pi mode extension had, or the extension
// itself. Real chats built by the chat manager with the mode extension discovered as the agent dir lists it;
// the model is a script. A throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import type { ChatServerMessage } from "../shared/protocol";
import { piSession } from "./harness/pi/testing/handle";
import { ScriptedModel } from "./harness/pi/testing/scripted-model";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-modes-owner-")));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths
const sessionsDir = join(agentDir, "sessions", "--tmp-smo--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });
const MODE_EXT = resolve(dirname(fileURLToPath(import.meta.url)), "../pi-config/extensions/mode");
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [MODE_EXT] }));
const SETTINGS = join(agentDir, "sova", "settings.json");
mkdirSync(dirname(SETTINGS), { recursive: true });
/** The saved switch: undefined = no file (the default). */
const saveSwitch = (on: boolean | undefined) => {
  if (on === undefined) rmSync(SETTINGS, { force: true });
  else writeFileSync(SETTINGS, JSON.stringify({ version: 1, experimental: { sovaModes: on } }));
};

await import("./testing/in-process-chats"); // chats open in this process (the server hosts none)
const { acquireChat, disposeAllChats, disposeHeldChat } = await import("./chat-manager");
const { markOwned } = await import("./write-guard");
const { MODE } = await import("./harness/state-kinds");

after(async () => {
  await disposeAllChats();
  saveSwitch(undefined);
});

type Chat = Awaited<ReturnType<typeof acquireChat>>;
const client = {
  send: (m: ChatServerMessage) => {
    if (m.type === "error") throw new Error(`chat error: ${m.message}`);
  },
};
async function until(cond: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

let seq = 0;
function sessionFile(): string {
  const id = `01234567-89ab-7cde-8f03-${String(++seq).padStart(12, "0")}`;
  const path = join(sessionsDir, `2026-11-05T00-00-0${seq}-000Z_${id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-05T00:00:00.000Z", cwd })}\n`);
  markOwned(path);
  return path;
}

/** The extension files the chat's runtime loaded, by name: "mode" (the pi extension) or "modes-entry" (Sova's). */
const modeOwners = (chat: Chat) =>
  piSession(chat)
    .resourceLoader.getExtensions()
    .extensions.map((e) => e.path)
    .flatMap((p) => (basename(p) === "modes-entry.ts" ? ["sova"] : p.startsWith(MODE_EXT) ? ["extension"] : []));
const commands = (chat: Chat) => chat.commands();
const set = (chat: Chat, patch: { mode?: "normal" | "delegate"; minorModes?: string[] }) => chat.applyMode({ ...chat.modeState, ...patch } as never);

for (const saved of [undefined, true, false] as const) {
  const sova = saved !== false;
  const label = saved === undefined ? "no saved switch (on by default)" : `switch ${saved ? "on" : "off"}`;
  test(`${label}: exactly one owner loads, and the menu's switch, typed /mode and the slash menu go to it`, async () => {
    saveSwitch(saved);
    const path = sessionFile();
    const chat = await acquireChat(path);
    try {
      assert.equal(chat.sovaModes, sova);
      assert.deepEqual(modeOwners(chat), [sova ? "sova" : "extension"], "one owner, never both, never neither");
      // The slash menu lists the owner's commands, whoever it is (/review only with adversarial review on).
      const listed = commands(chat);
      assert.equal(listed.type, "commands");
      if (listed.type === "commands") for (const name of ["mode", "align"]) assert.equal(listed.commands.filter((c) => c.name === name).length, 1, `/${name} once`);
      // The menu's switch: vis on, then off, with its tool following at once.
      await set(chat, { minorModes: ["vis"] });
      assert.deepEqual(chat.modeState.minorModes, ["vis"]);
      assert.ok(chat.harness.activeTools().includes("vis_guide"), "vis_guide active");
      assert.ok(chat.harness.state.branch().latest(MODE), "the switch is saved as a mode entry");
      // Typed /mode strict on: the owner answers it, and the menu reads it back.
      const model = new ScriptedModel().attach(piSession(chat));
      chat.handle(client, { type: "prompt", text: "/mode strict on" });
      await until(() => chat.modeState.strict === true);
      assert.equal(model.calls.length, 0, "nothing reached the model");
      await set(chat, { minorModes: [] });
      assert.ok(!chat.harness.activeTools().includes("vis_guide"));
    } finally {
      await disposeHeldChat(path, "test done");
    }
  });

  test(`${label}: with spec on, the mode section is in the prompt exactly once`, async () => {
    saveSwitch(saved);
    const path = sessionFile();
    const chat = await acquireChat(path);
    try {
      await set(chat, { minorModes: ["spec"] });
      const model = new ScriptedModel().attach(piSession(chat));
      model.reply(async () => ({ text: "ok" }));
      chat.handle(client, { type: "prompt", text: "hello" });
      await until(() => model.calls.length > 0 && !chat.harness.isRunning());
      await piSession(chat).waitForIdle();
      assert.deepEqual(chat.modeState.minorModes, ["spec"], "spec is on");
      const prompt = piSession(chat).systemPrompt;
      assert.equal(prompt.split("# Minor mode: spec").length - 1, 1, "the spec block once");
    } finally {
      await disposeHeldChat(path, "test done");
    }
  });
}

test("a chat keeps the owner its open found when the switch flips; its next open takes the new one", async () => {
  saveSwitch(true);
  const path = sessionFile();
  const chat = await acquireChat(path);
  saveSwitch(false);
  await set(chat, { minorModes: ["vis"] });
  assert.deepEqual(modeOwners(chat), ["sova"], "still Sova's until it reopens");
  await disposeHeldChat(path, "test done");
  const again = await acquireChat(path);
  try {
    assert.deepEqual(modeOwners(again), ["extension"]);
    assert.deepEqual(again.modeState.minorModes, ["vis"], "flipping lost nothing: vis is still on");
  } finally {
    await disposeHeldChat(path, "test done");
    saveSwitch(undefined);
  }
});
