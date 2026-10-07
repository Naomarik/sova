// Run: pnpm test -- server/vis-tools-sync.test.ts. The vis minor mode's two tools follow a switch made between
// runs at once (§chat.mode-menu/minor-toggle-keeps-prompt), so a new session's setup card lists them before
// the first message (§chat.transcript/setup-card-tools): vis_guide (the mode extension's) and vis_check
// (Sova's, synced by ChatSession.applyMode after both /mode handlers ran). A switch during a run waits for
// it to settle. Real chats built by the chat manager with the real mode extension; the model is a script.
// A throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import type { ChatServerMessage } from "../shared/protocol";
import { piSession } from "./harness/pi/testing/handle";
import { ScriptedModel } from "./harness/pi/testing/scripted-model";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-vts-")));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths
const sessionsDir = join(agentDir, "sessions", "--tmp-vts--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [resolve(dirname(fileURLToPath(import.meta.url)), "../pi-config/extensions/mode")] }));

const { acquireChat, disposeAllChats, disposeHeldChat } = await import("./chat-manager");
const { markOwned } = await import("./write-guard");
const { getSessionTools } = await import("./session-tools");

after(async () => {
  await disposeAllChats();
});

type Chat = Awaited<ReturnType<typeof acquireChat>>;
const VIS = ["vis_check", "vis_guide"];
const visTools = (chat: Chat) => chat.harness.activeTools().filter((t) => VIS.includes(t)).sort();
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
/** A session file with only its header, and a mode entry when `strict` (the triple Sova restores). */
function sessionFile(strict = false): string {
  const id = `01234567-89ab-7cde-8f02-${String(++seq).padStart(12, "0")}`;
  const path = join(sessionsDir, `2026-10-06T00-00-0${seq}-000Z_${id}.jsonl`);
  const entries: unknown[] = [{ type: "session", version: 3, id, timestamp: "2026-10-06T00:00:00.000Z", cwd }];
  if (strict) entries.push({ type: "custom", id: "m1", parentId: null, timestamp: "2026-10-06T00:00:00.000Z", customType: "mode", data: { strict: true, active: { version: 1, mode: "normal", strict: true, minorModes: [] } } });
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  markOwned(path);
  return path;
}

const set = (chat: Chat, patch: { mode?: "normal" | "delegate"; minorModes?: string[] }) => chat.applyMode({ ...chat.modeState, ...patch } as never);

test("vis on between runs: vis_check and vis_guide are active at once, before any prompt, and the card's read lists them", async () => {
  const path = sessionFile();
  const chat = await acquireChat(path);
  assert.deepEqual(visTools(chat), [], "off: neither");
  await set(chat, { minorModes: ["vis"] });
  assert.deepEqual(visTools(chat), VIS, "on: both, with no prompt sent");
  const read = await getSessionTools(path);
  assert.equal(read.state, "ok");
  if (read.state === "ok") for (const name of VIS) assert.ok(read.tools.some((t) => t.name === name), `${name} listed`);
  await set(chat, { minorModes: [] });
  assert.deepEqual(visTools(chat), [], "off again: neither, at once");
  await disposeHeldChat(path, "test done");
});

test("a switch during a run waits for it to settle; the run keeps its tools", async () => {
  const path = sessionFile();
  const chat = await acquireChat(path);
  const model = new ScriptedModel().attach(piSession(chat));
  let during: string[] | null = null;
  model.reply(async () => {
    await set(chat, { minorModes: ["vis"] });
    during = visTools(chat);
    return { text: "ok" };
  });
  chat.handle(client, { type: "prompt", text: "go" });
  await until(() => during !== null);
  assert.deepEqual(during, [], "mid-run the switch changes no tool");
  await until(() => !chat.harness.isRunning());
  await piSession(chat).waitForIdle();
  await until(() => visTools(chat).length === 2);
  assert.deepEqual(visTools(chat), VIS, "settled: both follow");
  await disposeHeldChat(path, "test done");
});

test("strict on, delegate, vis on, normal: both vis tools are active (leaving strict delegate keeps them)", async () => {
  const path = sessionFile(true);
  const chat = await acquireChat(path);
  assert.equal(chat.modeState.strict, true);
  await set(chat, { mode: "delegate" });
  await set(chat, { minorModes: ["vis"] });
  assert.deepEqual(visTools(chat), VIS, "on in strict delegate");
  await set(chat, { mode: "normal" });
  assert.deepEqual(visTools(chat), VIS, "back in normal: both still there");
  await disposeHeldChat(path, "test done");
});

test("strict on, vis on, delegate, vis off, normal: neither vis tool comes back with the restored set", async () => {
  const path = sessionFile(true);
  const chat = await acquireChat(path);
  await set(chat, { minorModes: ["vis"] });
  assert.deepEqual(visTools(chat), VIS);
  await set(chat, { mode: "delegate" });
  await set(chat, { minorModes: [] });
  assert.deepEqual(visTools(chat), [], "off in strict delegate");
  await set(chat, { mode: "normal" });
  assert.deepEqual(visTools(chat), [], "back in normal: neither");
  await disposeHeldChat(path, "test done");
});
