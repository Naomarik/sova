// Run: pnpm test:int -- server/sova-modes-flip.integration.test.ts. A save that flips "Sova runs chat modes"
// (§chat.mode-menu/sova-runs-modes) reaches a chat already open at its next quiet moment, so switching it off is
// a real rollback: the chat is rebuilt then (in this process: disposed as a reload and opened anew, re-reading
// the switch), never mid-run, and the workers it spawns afterwards follow its new owner. A flip back before
// that moment cancels it. Real chats built by the chat manager with the mode and subagents extensions as the
// agent dir lists them; the model is a script; workers start through a recording worker host.
// A throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import type { WorkerStart } from "../shared/chat-runtime";
import { piSession } from "./harness/pi/testing/handle";
import { ScriptedModel, scriptedModelsJson } from "./harness/pi/testing/scripted-model";

for (const k of Object.keys(process.env)) if (/^(SPEC_AGREE_|SOVA_SPEC_|PI_SPEC_)/.test(k) || /_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];
const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-modes-flip-")));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODE_EXT = join(REPO, "pi-config/extensions/mode");
const sessionsDir = join(agentDir, "sessions", "--tmp-flip--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(agentDir, "models.json"), JSON.stringify(scriptedModelsJson()));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [MODE_EXT, join(REPO, "pi-config/extensions/subagents")] }));
const SETTINGS = join(agentDir, "sova", "settings.json");
mkdirSync(dirname(SETTINGS), { recursive: true });
writeFileSync(SETTINGS, JSON.stringify({ version: 1, experimental: { sovaModes: true } }));

await import("./testing/in-process-chats"); // chats open in this process (the server hosts none)
const { buildApp } = await import("./app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const cm = await import("./chat-manager");
const { markOwned } = await import("./write-guard");

const starts: WorkerStart[] = [];
cm.setWorkerHostSource(() => ({
  async start(req) {
    starts.push(req);
    return { chatId: `w${starts.length}`, sessionId: `w${starts.length}`, sessionFile: "", workerId: req.spec.parent.workerId, kind: "worker", pid: null, state: "open" };
  },
  async send() {
    return { queued: false };
  },
  async abort() {},
  async stop() {},
  watch: () => () => {},
  list: async () => [],
}));

after(async () => {
  cm.setWorkerHostSource(null);
  await cm.disposeAllChats();
});

type Chat = Awaited<ReturnType<typeof cm.acquireChat>>;

let seq = 0;
function sessionFile(): string {
  const id = `01234567-89ab-7cde-8f04-${String(++seq).padStart(12, "0")}`;
  const path = join(sessionsDir, `2026-11-05T00-00-0${seq}-000Z_${id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-05T00:00:00.000Z", cwd })}\n`);
  markOwned(path);
  return path;
}

/** Who fills the chat's mode slot: Sova's entry or the pi extension, by the files its runtime loaded. */
const slot = (chat: Chat) =>
  piSession(chat)
    .resourceLoader.getExtensions()
    .extensions.map((e) => e.path)
    .flatMap((p) => (basename(p) === "modes-entry.ts" ? ["sova"] : p.startsWith(MODE_EXT + "/index.ts") || p === MODE_EXT ? ["extension"] : []));

const save = async (on: boolean) => {
  const res = await app.request("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ experimental: { sovaModes: on } }) });
  assert.equal(res.status, 200, await res.clone().text());
};

/** Resolves when the chat of `path` closes (its lifecycle event), never by polling a clock. */
const closed = (path: string) =>
  new Promise<void>((done) => {
    const off = cm.onChatEvent((e) => {
      if (e.chatId === path && e.type === "closed") {
        off();
        done();
      }
    });
  });

/** One turn whose model spawns a worker; returns the worker host's start. */
async function spawnOne(chat: Chat): Promise<WorkerStart> {
  const from = starts.length;
  const model = new ScriptedModel().attach(piSession(chat));
  model.reply({ toolCall: { name: "agent_spawn", arguments: { prompt: "do it", name: "w", model: "scripted/scripted", wake: false } } }, { text: "ok" });
  const settled = new Promise<void>((done) => {
    const off = cm.onChatEvent((e) => {
      if (e.chatId === chat.path && e.type === "settled") {
        off();
        done();
      }
    });
  });
  chat.handle({ send: () => {} }, { type: "prompt", text: "spawn" });
  await settled;
  assert.equal(starts.length, from + 1, "one worker started");
  return starts[from]!;
}

test("on → off: a chat mid-run keeps Sova until it settles, then reopens on the extension, and its new workers carry no stamp", async () => {
  const path = sessionFile();
  const chat = await cm.acquireChat(path);
  assert.deepEqual(slot(chat), ["sova"]);
  assert.equal((await spawnOne(chat)).spec.modes, "sova", "a worker of a Sova-owned chat is stamped");

  // A run in progress: the flip waits for it.
  const model = new ScriptedModel().attach(piSession(chat));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let saidDuring!: (disposed: boolean) => void;
  const during = new Promise<boolean>((r) => (saidDuring = r));
  model.reply(async () => {
    await save(false);
    saidDuring(chat.disposed);
    await gate;
    return { text: "done" };
  });
  const gone = closed(path);
  chat.handle({ send: () => {} }, { type: "prompt", text: "work" });
  // The save happens inside the model call; the chat must still be open then.
  const duringRun = await during;
  assert.equal(duringRun, false, "not reloaded mid-run");
  assert.equal(chat.disposed, false);
  release();
  await gone; // its next quiet moment
  assert.equal(chat.disposed, true);

  const again = await cm.acquireChat(path);
  assert.deepEqual(slot(again), ["extension"], "the pi mode extension fills the slot");
  assert.equal(again.sovaModes, false);
  assert.equal(again.modesOwner, "extension");
  const w = await spawnOne(again);
  assert.equal("modes" in w.spec, false, "a worker spawned after the reload carries no modes stamp");
  await cm.disposeHeldChat(path, "test done");
});

test("off → on: the chat reopens on Sova's slot, and the mode block is in its prompt once", async () => {
  writeFileSync(SETTINGS, JSON.stringify({ version: 1, experimental: { sovaModes: false } }));
  const path = sessionFile();
  const chat = await cm.acquireChat(path);
  assert.deepEqual(slot(chat), ["extension"]);
  await chat.applyMode({ ...chat.modeState, minorModes: ["spec"] } as never);
  const gone = closed(path);
  await save(true);
  await gone; // idle already: at once
  const again = await cm.acquireChat(path);
  assert.deepEqual(slot(again), ["sova"]);
  assert.deepEqual(again.modeState.minorModes, ["spec"], "nothing lost in the flip");
  const model = new ScriptedModel().attach(piSession(again));
  model.reply({ text: "ok" });
  const settled = new Promise<void>((done) => {
    const off = cm.onChatEvent((e) => {
      if (e.chatId === path && e.type === "settled") {
        off();
        done();
      }
    });
  });
  again.handle({ send: () => {} }, { type: "prompt", text: "hello" });
  await settled;
  const prompt = piSession(again).systemPrompt;
  assert.equal(prompt.split("# Minor mode: spec").length - 1, 1, "the spec block once");
  await cm.disposeHeldChat(path, "test done");
});

test("a flip back before the quiet moment cancels it: nothing reloads", async () => {
  writeFileSync(SETTINGS, JSON.stringify({ version: 1, experimental: { sovaModes: true } }));
  const path = sessionFile();
  const chat = await cm.acquireChat(path);
  const model = new ScriptedModel().attach(piSession(chat));
  model.reply(async () => {
    await save(false);
    await save(true);
    return { text: "done" };
  });
  let closedSeen = false;
  const off = cm.onChatEvent((e) => {
    if (e.chatId === path && e.type === "closed") closedSeen = true;
  });
  const settled = new Promise<void>((done) => {
    const o = cm.onChatEvent((e) => {
      if (e.chatId === path && e.type === "settled") {
        o();
        // Past the settle's deferred check (a macrotask): the reload would have run by now.
        setTimeout(done, 0);
      }
    });
  });
  chat.handle({ send: () => {} }, { type: "prompt", text: "work" });
  await settled;
  await new Promise((r) => setTimeout(r, 0));
  off();
  assert.equal(closedSeen, false, "no reload");
  assert.equal(chat.disposed, false);
  assert.deepEqual(slot(chat), ["sova"]);
  await cm.disposeHeldChat(path, "test done");
});
