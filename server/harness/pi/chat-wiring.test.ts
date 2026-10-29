// Run: pnpm test -- server/harness/pi/chat-wiring.test.ts. The chat's wiring onto its driving session
// (§app.harness/session) where only an end-to-end run shows it, each case proven by the mutation it names:
// - the foreign-write guard asks the driving session whether an appended line is ours (`hasEntry`);
// - a topic batch handed over inside pi's settle window (P5) keeps its mark until its turn delivers it;
// - an idle queued hand-off whose turn fails reports the failure into the pane, not as a hand-off failure;
// - the stream guard hears each event before the chat's own listener does;
// - a worker's keyed send keeps its key to the message the model gets, in pi's settle window too, and one
//   Stop drops is told as never run (§app.chat-processes/worker-instructions);
// - steers sent mid-turn land together: each its own message (with its key), all before the one reply.
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
const { METHODS } = await import("../../chat-runtime/methods");
const { WorkerFeed } = await import("../../chat-runtime/worker-feed");
const { drainQueueThenAbort, setWorkerSpec } = await import("../../chat-manager");
const { markOwned } = await import("../../write-guard");
const { addWebSession } = await import("../../web-sessions");
const { UserTurns } = await import("../../user-turns");

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

/** A chat on the scripted model with one client whose every message (wire 1) lands in `log`; `worker`: opened
    as a worker chat (its loadout only, as a worker's process opens it). */
async function openChat(onMessage?: (m: ChatServerMessage) => void, o: { worker?: boolean } = {}) {
  const path = sessionFile();
  if (o.worker)
    setWorkerSpec(path, { kind: "worker", parent: { sessionId: "parent", path: "/parent.jsonl", workerId: "ag_01" }, cwd, model: null, thinking: null, builtins: null, extensions: [], flags: {}, appendSystemPrompt: null, env: {}, agentDir: null, lowered: true });
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

describe("an idle composer steer starts a turn exactly as an idle prompt does", () => {
  /** Two messages typed back to back on an idle chat, as `type` frames: what the server made of them. */
  async function twoTyped(type: "prompt" | "steer") {
    const { chat, model, client, log } = await openChat();
    const turns = new UserTurns();
    turns.watch(chat.harness);
    chat.harness.subscribe((e) => void turns.observe(e));
    chat.userTurns = turns;
    let attended: boolean | undefined;
    const release = model.hold();
    model.reply(() => void (attended = turns.attended()));
    chat.handle(client as never, { type, text: "first", clientId: "c1" });
    const starting = chat.turnStarting;
    // The second leaves before the first's run has begun (pi still awaiting its input handlers).
    chat.handle(client as never, { type, text: "second", clientId: "c2" });
    await until(() => model.calls.length >= 1, "the first turn's call");
    release();
    await idle(chat);
    const users = model.calls.flatMap((c) => ((c.context as { messages: { role: string; content: unknown }[] }).messages).filter((m) => m.role === "user"));
    const texts = [...new Set(users.map((m) => (Array.isArray(m.content) ? (m.content as { text?: string }[]).map((b) => b.text ?? "").join("") : String(m.content))))];
    return {
      acks: log.filter((m) => m.type === "send_ack").map((m) => [(m as { clientId: string }).clientId, (m as { queued: boolean }).queued]),
      starting,
      attended,
      errors: errors(log).map((e) => e.message),
      reached: ["first", "second"].filter((t) => texts.includes(t)),
    };
  }

  test("the same accept path: acked, held while the turn starts, the user's turn, nothing refused", async () => {
    const prompt = await twoTyped("prompt");
    assert.deepEqual(prompt, { acks: [["c1", false], ["c2", true]], starting: true, attended: true, errors: [], reached: ["first", "second"] });
    assert.deepEqual(await twoTyped("steer"), prompt);
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

describe("a worker's keyed sends (§app.chat-processes/worker-instructions)", () => {
  /** The worker host's send (chat-workers.ts deliver): the chat method, with its key. */
  const send = (chat: Chat, text: string, key: string, delivery?: "steer" | "followUp") =>
    METHODS.send(chat, { text, key, origin: "server", report: false, ...(delivery ? { delivery } : {}) }, { turns: new Map() });
  /** A worker chat's feed over the chat, as its process attaches one (host.ts). */
  const feedOf = (chat: Chat) => {
    const events: { type: string; sendKey?: string; message?: { role?: string } }[] = [];
    const feed = new WorkerFeed((f) => events.push(f.event as never));
    const off = feed.attach(chat.harness, chat.sendKeys);
    return { events, off };
  };

  for (const as of ["chat", "worker"] as const) {
  test(`${as}: a keyed send made inside pi's settle window is queued, then delivered labelled with its key, once`, async () => {
    const { chat, model } = await openChat(undefined, { worker: as === "worker" });
    const { events, off } = feedOf(chat);
    let receipt: unknown;
    let inWindow: boolean | undefined;
    let fired = false;
    const offSettle = piSession(chat).subscribe((event) => {
      if (event.type !== "agent_settled" || fired) return;
      fired = true;
      inWindow = chat.harness.inSettleWindow();
      receipt = send(chat, "keyed in the window", "w:s1", "followUp");
    });
    model.reply({ text: "first" }, { text: "second" });
    await chat.harness.send("one");
    await until(() => model.calls.length >= 2, "the keyed turn");
    await idle(chat);
    offSettle();
    off();
    assert.equal(inWindow, true);
    assert.deepEqual(receipt, { queued: true, turnId: null }, "held in Sova's queue, not deferred by pi");
    const users = events.filter((e) => e.type === "message_start" && e.message?.role === "user");
    assert.deepEqual(users.map((e) => e.sendKey ?? null), [null, "w:s1"], "the keyed message names its key, once; the unkeyed none");
    assert.ok(!events.some((e) => e.type === "send_dropped"));
  });

  test(`${as}: a keyed steer delivered mid-run names its key; one Stop drains is told as never run, before the settle`, async () => {
    const { chat, model } = await openChat(undefined, { worker: as === "worker" });
    const { events, off } = feedOf(chat);
    const gate = () => {
      let open!: () => void;
      const shut = new Promise<void>((r) => (open = r));
      return { open, step: async () => (await shut, { text: "reply" }) };
    };
    const [a, b] = [gate(), gate()];
    model.reply(a.step, b.step);
    const run = chat.harness.send("long task");
    await until(() => model.calls.length === 1, "the first reply, held");
    await send(chat, "steer one", "w:s1", "steer");
    await until(() => chat.harness.queue.hasQueued(), "the steer handed to pi");
    a.open();
    await until(() => model.calls.length === 2, "the steer's turn, held");
    // A second steer goes in behind the held reply; then Stop drains it and aborts.
    await send(chat, "steer two", "w:s2", "steer");
    await until(() => chat.harness.queue.hasQueued(), "the second steer handed to pi");
    await drainQueueThenAbort(chat.harness, () => {}, chat.queue);
    b.open();
    await run.catch(() => {});
    await idle(chat);
    off();
    const users = events.filter((e) => e.type === "message_start" && e.message?.role === "user");
    assert.deepEqual(users.map((e) => e.sendKey ?? null), [null, "w:s1"], "the delivered steer names its key");
    const tail = events.map((e) => (e.type === "send_dropped" ? `dropped ${e.sendKey}` : e.type)).filter((t) => t === "agent_settled" || t.startsWith("dropped"));
    assert.deepEqual(tail, ["dropped w:s2", "agent_settled"], "told once, before the settle");
});

  test(`${as}: two steers sent mid-turn land together: both user messages, each with its key, before the one reply`, async () => {
    const { chat, model, client } = await openChat(undefined, { worker: as === "worker" });
    const { events, off } = feedOf(chat);
    const release = model.hold();
    model.reply({ text: "working" }, { text: "one reply to both" });
    const run = chat.harness.send("long task");
    await until(() => model.calls.length === 1, "the first reply, held");
    if (as === "chat") {
      // The composer's mid-turn sends: `steer` frames.
      chat.handle(client as never, { type: "steer", text: "steer one", clientId: "c1" });
      chat.handle(client as never, { type: "steer", text: "steer two", clientId: "c2" });
    } else {
      await send(chat, "steer one", "w:s1", "steer");
      await send(chat, "steer two", "w:s2", "steer");
    }
    await until(() => piSession(chat).getSteeringMessages().length === 2, "both steers handed to pi");
    release();
    await run;
    await idle(chat);
    off();
    assert.equal(model.calls.length, 2, "one model call after the steers, for both");
    const users = ((model.calls[1]!.context as { messages: { role: string; content: unknown }[] }).messages).filter((m) => m.role === "user");
    const text = (m: { content: unknown }) => (Array.isArray(m.content) ? m.content.filter((c: { type?: string }) => c.type === "text").map((c: { text?: string }) => c.text).join("") : String(m.content));
    assert.deepEqual(users.slice(-2).map(text), ["steer one", "steer two"], "each its own message, in the order sent");
    const order = events.filter((e) => e.type === "message_start" && (e.message?.role === "user" || e.message?.role === "assistant")).map((e) => (e.message?.role === "user" ? `user ${e.sendKey ?? "-"}` : e.message?.role));
    const keys = as === "worker" ? ["w:s1", "w:s2"] : ["-", "-"];
    assert.deepEqual(order, ["user -", "assistant", `user ${keys[0]}`, `user ${keys[1]}`, "assistant"], "both before the one reply");
    assert.equal(chat.queue.size, 0);
  });

  test(`${as}: of three steers handed to pi mid-turn, the middle one is removed; the agent's next step gets the other two, together`, async () => {
    const { chat, model, client, log } = await openChat(undefined, { worker: as === "worker" });
    const { events, off } = feedOf(chat);
    const release = model.hold();
    model.reply({ text: "working" }, { text: "one reply to both" });
    const run = chat.harness.send("long task");
    await until(() => model.calls.length === 1, "the first reply, held");
    const texts = ["one", "two", "three"];
    if (as === "chat") for (const [i, t] of texts.entries()) chat.handle(client as never, { type: "steer", text: t, clientId: `c${i + 1}` });
    else for (const [i, t] of texts.entries()) await send(chat, t, `w:s${i + 1}`, "steer");
    await until(() => piSession(chat).getSteeringMessages().length === 3, "all three handed to pi");
    assert.deepEqual(chat.queue.snapshot().map((i) => [i.text, i.state]), [["one", "queued"], ["two", "queued"], ["three", "queued"]], "handed, each still Queued");
    const two = chat.queue.snapshot().find((i) => i.text === "two")!;
    log.length = 0;
    if (as === "chat") {
      chat.handle(client as never, { type: "queue_remove", id: "r1", itemId: two.id });
      await until(() => log.some((m) => m.type === "queue_removed" || m.type === "queue_remove_refused"), "the removal's answer");
      assert.ok(log.some((m) => m.type === "queue_removed"), `removed: ${JSON.stringify(log.filter((m) => m.type.startsWith("queue")))}`);
    } else assert.equal((await chat.queue.remove(two.id)).ok, true);
    assert.ok(log.some((m) => m.type === "queue_item_gone" && m.itemId === two.id && m.reason === "removed"), "the client is told it was removed");
    assert.deepEqual([...piSession(chat).getSteeringMessages()], ["one", "three"], "out of pi's mirror");
    assert.equal(piSession(chat).agent.peekQueuedMessages().length, 2, "and out of its real queue");
    release();
    await run;
    await idle(chat);
    off();
    assert.equal(model.calls.length, 2, "one model call after the steers");
    const users = ((model.calls[1]!.context as { messages: { role: string; content: unknown }[] }).messages).filter((m) => m.role === "user");
    const text = (m: { content: unknown }) => (Array.isArray(m.content) ? m.content.filter((c: { type?: string }) => c.type === "text").map((c: { text?: string }) => c.text).join("") : String(m.content));
    assert.deepEqual(users.map(text), ["first ask", "long task", "one", "three"], "the removed steer never reached the model");
    if (as === "worker") {
      // The feed tells a never-run send at the run's settle, before it (as Stop's are).
      const told = events
        .filter((e) => e.type === "send_dropped" || e.type === "agent_settled" || (e.type === "message_start" && e.message?.role === "user" && e.sendKey))
        .map((e) => (e.type === "send_dropped" ? `dropped ${e.sendKey}` : e.type === "agent_settled" ? e.type : `ran ${e.sendKey}`));
      assert.deepEqual(told, ["ran w:s1", "ran w:s3", "dropped w:s2", "agent_settled"], "the worker's feed is told the removed one never runs");
    }
    assert.equal(chat.queue.size, 0);
  });

  if (as === "worker")
    test("worker: Stop with two keyed steers handed to pi: each is told as never run, before the settle", async () => {
      const { chat, model } = await openChat(undefined, { worker: true });
      const { events, off } = feedOf(chat);
      const release = model.hold();
      const run = chat.harness.send("long task");
      await until(() => model.calls.length === 1, "the first reply, held");
      await send(chat, "steer one", "w:s1", "steer");
      await send(chat, "steer two", "w:s2", "steer");
      await until(() => piSession(chat).getSteeringMessages().length === 2, "both steers handed to pi");
      await drainQueueThenAbort(chat.harness, () => {}, chat.queue);
      release();
      await run.catch(() => {});
      await idle(chat);
      off();
      const tail = events.map((e) => (e.type === "send_dropped" ? `dropped ${e.sendKey}` : e.type)).filter((t) => t === "agent_settled" || t.startsWith("dropped"));
      assert.deepEqual(tail, ["dropped w:s1", "dropped w:s2", "agent_settled"], "one each, in order, before the settle");
      assert.ok(!events.some((e) => e.type === "message_start" && e.sendKey), "neither ran");
    });
  }
});
