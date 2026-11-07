// Run: node scripts/run-tests.mjs server/message-labels-chat.test.ts. A message that waited in Sova's queue
// (§app.message-labels/labelling): the press time reaches the store beside the session through a real chat, with the
// real queue. A throwaway PI_CODING_AGENT_DIR; a scripted model answers.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { piSession } from "./harness/pi/testing/handle";
import { ScriptedModel, scriptedModelsJson } from "./harness/pi/testing/scripted-model";
import { until } from "./test-wait";
import type { ChatServerMessage, DecisionSettings } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-labels-chat-"));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
mkdirSync(join(agentDir, "sova"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });

writeFileSync(join(agentDir, "models.json"), JSON.stringify(scriptedModelsJson()));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "scripted", defaultModel: "scripted", retry: { enabled: false } }));

const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { buildApp } = await import("./app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const { idOf } = await import("./sessions-index");
const { MessageLabelStore, messageLabelStore } = await import("./message-labels");
const { sessionOwnMessages } = await import("./message-input");
const { attributeMessages, withPresses } = await import("./time-spent-messages");

after(async () => {
  await disposeAllChats();
});
const realNow = Date.now;
const TYPED = "typed while it worked";
afterEach(() => {
  Date.now = realNow;
});

async function session(): Promise<{ path: string; id: string }> {
  const res = await app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd }) });
  assert.equal(res.status, 201, await res.clone().text());
  const path = ((await res.json()) as { path: string }).path;
  return { path, id: idOf(path) };
}
const switchTo = (on: boolean) =>
  writeFileSync(join(agentDir, "sova", "decisions.json"), JSON.stringify({ version: 1, jev: { enabled: true }, fallback: null, features: { attention: false, tags: false, messageLabels: on }, exclusions: [], neverSendTui: false } satisfies DecisionSettings));

/** A real turn on a scripted model: a follow-up typed while it runs waits in Sova's queue, `wait` ms pass, the turn ends and the follow-up enters. */
async function heldThenEntered(path: string, wait: number) {
  const chat = await acquireChat(path);
  const model = new ScriptedModel();
  model.attach(piSession(chat));
  const heard: ChatServerMessage[] = [];
  const me = { send: (m: ChatServerMessage) => void heard.push(m) };
  chat.attach(me);
  const release = model.hold();
  chat.handle(me, { type: "prompt", text: "start the turn", clientId: "go" });
  await until(() => model.calls.length >= 1, `the turn to reach the model; heard ${JSON.stringify(heard.map((m) => (m.type === "error" ? m : m.type)).slice(-8))}`);
  const pressed = realNow();
  chat.handle(me, { type: "prompt", text: TYPED, clientId: "held-1" });
  await until(() => heard.some((m) => m.type === "queue" && m.items.some((i) => i.id === "held-1")), "the message to wait in the queue");
  Date.now = () => realNow() + wait;
  release();
  await until(() => readFileSync(path, "utf8").includes(TYPED), "the message to enter the file");
  // A second reply answers it: by then the entry is written and the press noted.
  await until(() => model.calls.length >= 2 && chat.quietForReload, "the second reply");
  return { pressed };
}

test("a message held two minutes keeps its press, and the time after the press isn't its", async () => {
  switchTo(true);
  const s = await session();
  const { pressed } = await heldThenEntered(s.path, 120_000);
  const store = messageLabelStore();
  const labels = store.read(s.id);
  const id = [...labels.presses.keys()][0]!;
  assert.ok(id, "a press was kept");
  const held = labels.presses.get(id)!;
  assert.ok(Math.abs(held - pressed) < 5_000, `kept the press, not the hand-off: ${held - pressed} ms off`);
  Date.now = realNow;
  // Which entry time pi writes depends on when the queue handed it over; the press decides either way.
  const own = (await sessionOwnMessages(s.path)).filter((m) => m.id === id);
  assert.equal(own.length, 1);
  assert.equal(own[0]!.text, TYPED, "the press is on the message that waited");
  const start = Math.floor(pressed / 1000) - 10;
  const r = attributeMessages([{ s: start, e: start + 100, r: "typing" }], own, labels);
  assert.equal(r.messages.rows[0]!.seconds, Math.floor(held / 1000) - start, "credited up to the press");
  assert.equal(r.messages.sinceLast, 100 - (Math.floor(held / 1000) - start));
});

test("with the switch off nothing is kept beside the session", async () => {
  switchTo(false);
  const s = await session();
  await heldThenEntered(s.path, 120_000);
  assert.equal(messageLabelStore().read(s.id).presses.size, 0);
});

test("what a program sends is noted beside the session, idle or queued; what you type isn't", async () => {
  switchTo(true);
  const s = await session();
  const chat = await acquireChat(s.path);
  const model = new ScriptedModel();
  model.attach(piSession(chat));
  const heard: ChatServerMessage[] = [];
  const me = { send: (m: ChatServerMessage) => void heard.push(m) };
  chat.attach(me);
  const release = model.hold();
  chat.acceptPrompt("hello there");
  await until(() => model.calls.length >= 1, "the program's turn");
  chat.handle(me, { type: "prompt", text: "typed by me", clientId: "me-1" });
  chat.acceptPrompt("a release step");
  release();
  await until(() => ["hello there", "typed by me", "a release step"].every((t) => readFileSync(s.path, "utf8").includes(t)) && chat.quietForReload, "all three to enter");
  // A restart: only the file and the store.
  const labels = new MessageLabelStore(messageLabelStore().dir).read(s.id);
  const own = await sessionOwnMessages(s.path);
  assert.deepEqual(withPresses(own, labels).map((m) => m.text), ["typed by me"]);
  assert.equal(labels.program.size, 2);
});
