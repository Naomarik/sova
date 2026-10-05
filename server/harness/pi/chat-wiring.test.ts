// Run: pnpm test -- server/harness/pi/chat-wiring.test.ts. The chat's wiring onto its driving session
// (§app.harness/session) where only an end-to-end run shows it, each case proven by the mutation it names:
// - the foreign-write guard asks the driving session whether an appended line is ours (`hasEntry`);
// - a topic batch handed over inside pi's settle window (P5) keeps its mark until its turn delivers it;
// - an idle queued hand-off whose turn fails reports the failure into the pane, not as a hand-off failure;
// - the stream guard hears each event before the chat's own listener does.
// Real pi with a ScriptedModel (testing/scripted-model.ts), one throwaway PI_CODING_AGENT_DIR; ~/.pi is never
// read or written and no real model is called.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { ChatServerMessage } from "../../../shared/protocol";
import { ScriptedModel, scriptedModelsJson } from "./testing/scripted-model";
import { piSession } from "./testing/handle";

for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];
const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-chat-wiring-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths
const sessionsDir = join(agentDir, "sessions", "--chat-wiring--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(root, "cwd");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(agentDir, "models.json"), JSON.stringify(scriptedModelsJson()));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "scripted", defaultModel: "scripted", retry: { enabled: false } }));

const { acquireChat, disposeAllChats } = await import("../../chat-manager");
type Chat = Awaited<ReturnType<typeof acquireChat>>;
type TopicBatchMark = import("../../chat-manager").TopicBatchMark;
const { canonicalPath } = await import("../../paths");
const { markOwned } = await import("../../write-guard");
const { addWebSession } = await import("../../web-sessions");

after(async () => {
  await disposeAllChats();
  rmSync(root, { recursive: true, force: true });
});

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let n = 0;
/** A web session file as Sova's creator writes it (marked ours), u1 → a1 after the header. */
function sessionFile(): string {
  const id = `0199eeee-0000-7000-8000-${String(++n).padStart(12, "0")}`;
  const path = canonicalPath(join(sessionsDir, `2026-10-05T00-00-${String(n).padStart(2, "0")}-000Z_${id}.jsonl`));
  const lines = [
    { type: "session", version: 3, id, timestamp: "2026-10-05T00:00:00.000Z", cwd },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-10-05T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "first ask" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-05T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "first answer" }], provider: "scripted", model: "scripted", usage: USAGE, stopReason: "stop" } },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  markOwned(path);
  addWebSession(id);
  return path;
}

/** A chat on the scripted model with one client whose every message (wire 1) lands in `log`. */
async function openChat(onMessage?: (m: ChatServerMessage) => void) {
  const path = sessionFile();
  const chat = await acquireChat(path, true);
  const model = new ScriptedModel().attach(piSession(chat));
  const log: ChatServerMessage[] = [];
  const take = (m: ChatServerMessage) => (log.push(m), onMessage?.(m));
  const client = { send: (m: ChatServerMessage) => take(m), sendRaw: (json: string) => take(JSON.parse(json)) };
  chat.attach(client as never);
  return { chat, path, model, client, log };
}

async function idle(chat: Chat): Promise<void> {
  const quiet = () => !chat.turnStarting && !chat.harness.isRunning() && chat.queue.size === 0 && !chat.harness.queue.hasQueued();
  await until(quiet, "idle");
  await piSession(chat).waitForIdle();
  await new Promise((r) => setTimeout(r, 5));
  await until(quiet, "idle");
}

const errors = (log: ChatServerMessage[]) => log.filter((m): m is Extract<ChatServerMessage, { type: "error" }> => m.type === "error");

describe("the foreign-write guard asks the driving session (hasEntry)", () => {
  test("hasEntry: true for an entry pi's session holds, false for an id it never wrote", async () => {
    const { chat } = await openChat();
    assert.equal(chat.harness.hasEntry("a1"), true);
    assert.equal(chat.harness.hasEntry("not-ours-1"), false);
  });

  for (const type of ["prompt", "steer"] as const) {
    test(`a line another writer appends to the held file makes the next ${type} refuse (recent), nothing sent`, async () => {
      const { chat, client, log, model } = await openChat();
      // The control first: a line whose id our SessionManager knows is ours, so the guard passes it.
      appendFileSync(chat.path, `${JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-05T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "first answer" }], provider: "scripted", model: "scripted", usage: USAGE, stopReason: "stop" } })}\n`);
      chat.assertNoForeignWrites();
      assert.equal(chat.foreignWrite, null, "a line with an id pi's session holds is not foreign");
      // A headless pi appends an entry our session never wrote.
      appendFileSync(chat.path, `${JSON.stringify({ type: "message", id: "f0reign1", parentId: "a1", timestamp: "2026-10-05T00:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "from elsewhere" }] } })}\n`);
      log.length = 0;
      chat.handle(client, { type, text: "mine", clientId: "c1" });
      await until(() => errors(log).length > 0, "the refusal");
      const err = errors(log).find((m) => m.code === "recent");
      assert.ok(err, `refused as recent: ${JSON.stringify(errors(log))}`);
      assert.match(err.message, /modified by another process while open here/);
      assert.ok(chat.foreignWrite, "the chat is marked foreign");
      assert.equal(model.calls.length, 0, "nothing reached the model");
    });
  }
});

describe("a topic batch handed over inside pi's settle window (P5 settle-window)", () => {
  test("its prompt resolves at once, deferred, and the mark stays until the deferred turn's user entry enters", async () => {
    const { chat, model } = await openChat();
    const seen: string[] = [];
    let got: string | undefined;
    let inWindow: boolean | undefined;
    const mark: TopicBatchMark = { text: "[topic wiring] a note", topic: "wiring", batch: "b1", items: [], entered: () => seen.push("entered"), gone: () => seen.push("gone") };
    let fired = false;
    // After Sova's own listeners (subscribed at bind), as a later subscriber is.
    const off = piSession(chat).subscribe((event) => {
      if (event.type !== "agent_settled" || fired) return;
      fired = true;
      inWindow = chat.harness.inSettleWindow();
      got = chat.deliverTopicBatch(mark);
    });
    model.reply({ text: "first" }, { text: "second" });
    await chat.harness.send("one");
    await until(() => fired, "agent_settled");
    await until(() => model.calls.length >= 2, "the deferred turn");
    await idle(chat);
    off();
    assert.equal(got, "started");
    assert.deepEqual(seen, ["entered"], "delivered once, never reported gone");
    assert.equal(inWindow, true, "the driving session reports pi's settle window");
  });
});

describe("an idle queued hand-off whose turn fails", () => {
  test("reports the failure into the pane, and the item departs delivered, not failed", async () => {
    const { chat, log } = await openChat();
    // pi refuses the turn before any model call, as it does with no key for the session's model.
    const refusal = "No API key found for the selected model.";
    (piSession(chat) as unknown as { prompt(): Promise<void> }).prompt = () => Promise.reject(new Error(refusal));
    log.length = 0;
    chat.queue.enqueue({ kind: "followUp", text: "queued while idle", origin: "client", id: "q1" });
    await until(() => errors(log).length > 0, "the turn's failure");
    await idle(chat);
    const err = errors(log);
    assert.equal(err.length, 1, JSON.stringify(err));
    assert.equal(err[0]!.message, refusal);
    assert.equal(err[0]!.clientId, undefined, "a turn failure, not a hand-off failure naming the send");
    assert.ok(!log.some((m) => m.type === "queue_item_gone" && m.reason === "failed"), "the item was handed over: no failed departure");
  });
});

describe("the stream guard's listener runs before the chat's", () => {
  test("a run's start clears the last trip before the chat forwards agent_start", async () => {
    let tripAtStart: unknown = "unseen";
    let chatRef: Chat | null = null;
    const { chat, model } = await openChat((m) => {
      const frame = m as { type: string; event?: { type?: string } };
      if (frame.type === "event" && frame.event?.type === "agent_start" && tripAtStart === "unseen") tripAtStart = chatRef!.lastStreamTrip;
    });
    chatRef = chat;
    chat.lastStreamTrip = { kind: "output", detail: "a previous run's trip", chars: 1, at: "2026-10-05T00:00:00.000Z" };
    model.reply({ text: "ok" });
    await chat.harness.send("go");
    await idle(chat);
    assert.equal(tripAtStart, null, "the guard (registered first) had already reset the trip");
  });
});
