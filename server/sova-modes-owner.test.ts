// Run: pnpm test -- server/sova-modes-owner.test.ts. Sova's engine is the only mode owner, whatever the pi folder
// links (§chat.mode-menu/sova-runs-modes): with no mode folder in it (as install.sh links it now), or an older
// install's mode link left there, every ordinary chat runs exactly one owner, Sova's engine, and the menu's
// switch, typed /mode and the slash menu go to it; an old saved "off" switch changes nothing. Real chats built by
// the chat manager; the model is a script. A throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const SETTINGS = join(agentDir, "sova", "settings.json");
mkdirSync(dirname(SETTINGS), { recursive: true });
mkdirSync(join(agentDir, "extensions"), { recursive: true });
/** The pi folder each case starts its chats on. */
const PI_FOLDERS = {
  "no mode folder anywhere in the pi folder": () => writeFileSync(join(agentDir, "settings.json"), JSON.stringify({})),
  // An older install linked the mode folder; it is no pi extension now (no index.ts), so pi skips it.
  "an older install's mode link left in the pi folder": () => {
    rmSync(join(agentDir, "extensions", "mode"), { force: true });
    symlinkSync(MODE_EXT, join(agentDir, "extensions", "mode"));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({}));
  },
  // A file saved before the switch was retired, with it off: ignored.
  "no mode folder, and an old saved \"Sova runs chat modes\" off": () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({}));
    writeFileSync(SETTINGS, JSON.stringify({ version: 1, experimental: { sovaModes: false } }));
  },
};
const resetPiFolder = () => {
  rmSync(join(agentDir, "extensions", "mode"), { force: true });
  rmSync(SETTINGS, { force: true });
};

await import("./testing/in-process-chats"); // chats open in this process (the server hosts none)
const { acquireChat, disposeAllChats, disposeHeldChat } = await import("./chat-manager");
const { markOwned } = await import("./write-guard");
const { MODE } = await import("./harness/state-kinds");

after(async () => {
  await disposeAllChats();
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

/** The extension files the chat's runtime loaded that own modes: "sova" (modes-entry.ts) or "extension" (any mode folder's own file). */
const modeOwners = (chat: Chat) =>
  piSession(chat)
    .resourceLoader.getExtensions()
    .extensions.map((e) => e.path)
    .flatMap((p) => (basename(p) === "modes-entry.ts" ? ["sova"] : p.startsWith(MODE_EXT) || /[/\\]extensions[/\\]mode([/\\]|$)/.test(p) ? ["extension"] : []));
const commands = (chat: Chat) => chat.commands();
const set = (chat: Chat, patch: { mode?: "normal" | "delegate"; minorModes?: string[] }) => chat.applyMode({ ...chat.modeState, ...patch } as never);

for (const [label, piFolder] of Object.entries(PI_FOLDERS)) {
  test(`${label}: exactly one owner, Sova's engine, and the menu's switch, typed /mode and the slash menu go to it`, async () => {
    resetPiFolder();
    piFolder();
    const path = sessionFile();
    const chat = await acquireChat(path);
    try {
      assert.deepEqual(modeOwners(chat), ["sova"], "one owner, Sova's engine, never the extension, never none");
      // The slash menu lists the engine's commands (/review only with adversarial review on).
      const listed = commands(chat);
      assert.equal(listed.type, "commands");
      if (listed.type === "commands") for (const name of ["mode", "align"]) assert.equal(listed.commands.filter((c) => c.name === name).length, 1, `/${name} once`);
      // The menu's switch: vis on, then off, with its tool following at once.
      await set(chat, { minorModes: ["vis"] });
      assert.deepEqual(chat.modeState.minorModes, ["vis"]);
      assert.ok(chat.harness.activeTools().includes("vis_guide"), "vis_guide active");
      assert.ok(chat.harness.state.branch().latest(MODE), "the switch is saved as a mode entry");
      // Typed /mode strict on: the engine answers it, and the menu reads it back.
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
    resetPiFolder();
    piFolder();
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

test("a chat reopened on another pi folder keeps its modes: Sova's engine reads the same saved state", async () => {
  resetPiFolder();
  PI_FOLDERS["an older install's mode link left in the pi folder"]();
  const path = sessionFile();
  const chat = await acquireChat(path);
  await set(chat, { minorModes: ["vis"] });
  await disposeHeldChat(path, "test done");
  resetPiFolder();
  PI_FOLDERS["no mode folder anywhere in the pi folder"]();
  const again = await acquireChat(path);
  try {
    assert.deepEqual(modeOwners(again), ["sova"]);
    assert.deepEqual(again.modeState.minorModes, ["vis"], "vis is still on");
  } finally {
    await disposeHeldChat(path, "test done");
  }
});
