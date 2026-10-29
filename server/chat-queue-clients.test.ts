// Run: npx tsx --test server/chat-queue-clients.test.ts (or npm test). Uses a throwaway
// PI_CODING_AGENT_DIR and cwd in the OS temp dir; ~/.pi is never read or written, and with no
// credentials in that dir no model is ever called.
//
// WHAT THIS FILE IS FOR, and why the fakes in queue.test.ts do not cover it: queue.test.ts proves
// the queue calls its deps once per departure; this proves ChatSession WIRES those deps to
// `broadcast` rather than to the one client that asked. That is a one-line decision, invisible to
// every other test, and getting it wrong gives a second tab a thread that silently disagrees with
// the first — pending rows that never resolve, or removals nobody else sees.
import assert from "node:assert/strict";
import { until as waitUntil } from "./test-wait";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { ChatServerMessage } from "../shared/protocol";
import { piSession } from "./harness/pi/testing/handle";

const agentDir = mkdtempSync(join(tmpdir(), "sova-queue-clients-test-"));
// A hosted runtime can still write here after after() ran (pi's catalogs, usage cache): exit is last.
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths
const sessionsDir = join(agentDir, "sessions", "--tmp-queueclients--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });

const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
const { playbookTurnText } = await import("../src/lib/playbooks");
const { HANDED_REFUSAL } = await import("./queue");
const { sendFrame } = await import("../src/lib/send-frame");

after(async () => {
  await disposeAllChats();
  rmSync(agentDir, { recursive: true, force: true });
});

let n = 0;
/** A two-turn session on disk: u1 → a1 → u2 → a2. */
function session(): string {
  const path = join(sessionsDir, `2026-09-22T00-00-0${n}-000Z_01a0-qc${n++}.jsonl`);
  const lines = [
    { type: "session", version: 3, id: `01a0-qc${n}`, timestamp: "2026-09-22T00:00:00.000Z", cwd },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-09-22T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "first ask" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-22T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "first answer" }], provider: "anthropic", model: "claude-opus-5", stopReason: "stop" } },
    { type: "message", id: "u2", parentId: "a1", timestamp: "2026-09-22T00:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "second ask" }] } },
    { type: "message", id: "a2", parentId: "u2", timestamp: "2026-09-22T00:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "second answer" }], provider: "anthropic", model: "claude-opus-5", stopReason: "stop" } },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return canonicalPath(path);
}

/** u1 → a1 → WAKE NUDGE → a2: the shape server/transcript.ts renders as a `wake` card. The tag
    format is shared/wake.ts's, not an invented one — a fixture with a made-up tag would prove the
    opposite of what it claims. */
function wakeSession(): string {
  const path = join(sessionsDir, `2026-09-22T00-00-1${n}-000Z_01a0-wake${n++}.jsonl`);
  const nudge = ["[wake_nudge n1] Scheduled wakeup fired (set 4m17s ago).", "Reason: check the build", "Look at CI and report."].join("\n");
  const lines = [
    { type: "session", version: 3, id: `01a0-wake${n}`, timestamp: "2026-09-22T00:00:00.000Z", cwd },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-09-22T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-22T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }], provider: "anthropic", model: "claude-opus-5", stopReason: "stop" } },
    { type: "message", id: "w1", parentId: "a1", timestamp: "2026-09-22T00:00:03.000Z", message: { role: "user", content: [{ type: "text", text: nudge }] } },
    { type: "message", id: "a2", parentId: "w1", timestamp: "2026-09-22T00:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "build is green" }], provider: "anthropic", model: "claude-opus-5", stopReason: "stop" } },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return canonicalPath(path);
}

/** A chat with two clients attached, each with its own log. */
async function twoClients() {
  const path = session();
  const chat = await acquireChat(path, true);
  const mine: ChatServerMessage[] = [];
  const theirs: ChatServerMessage[] = [];
  const me = { send: (m: ChatServerMessage) => void mine.push(m) };
  const them = { send: (m: ChatServerMessage) => void theirs.push(m) };
  chat.attach(me);
  chat.attach(them);
  return { chat, path, me, them, mine, theirs };
}

const until = (ready: () => boolean) => waitUntil(ready);
const types = (log: ChatServerMessage[]) => log.map((m) => m.type);

describe("the SDK surface this feature stands on, in the copy the repo actually resolves", () => {
  test("every queue member Sova calls exists on a REAL session", async () => {
    // THIS TEST EXISTS BECAUSE THE OBVIOUS READING WAS WRONG. `Agent.peekQueuedMessages()` was
    // declared in the pi-agent-core shipped with the globally installed pi (0.87.0) while the
    // 0.86.1 copy Sova actually imported had none — .d.ts and .js alike. A design was built on
    // it, and a typecheck happened to catch it; nothing in the unit suites would have, because a
    // fake answers whatever it is told to. Reading a package proves what that copy says; only
    // calling it through the repo's own import proves what Sova will run.
    const { chat } = await twoClients();
    const session = piSession(chat);
    for (const name of ["steer", "prompt", "clearQueue", "getSteeringMessages", "getFollowUpMessages", "abort"] as const) {
      assert.equal(typeof session[name], "function", `AgentSession.${name}`);
    }
    assert.equal(typeof session.agent?.hasQueuedMessages, "function", "Agent.hasQueuedMessages");
    // Called, not just counted: a member that exists but throws is the same outage.
    assert.equal(session.agent.hasQueuedMessages(), false, "an idle session holds nothing");
    assert.deepEqual([...session.getSteeringMessages()], []);
    assert.deepEqual([...session.getFollowUpMessages()], []);
    // And the one that arrived with the 0.87.1 pin, pinned so its presence stays a decision
    // somebody made: the bump adopted nothing, and server/queue.ts still reads the queue through
    // the members above only.
    assert.equal(
      typeof (session.agent as unknown as Record<string, unknown>).peekQueuedMessages,
      "function",
      "peekQueuedMessages is present in the resolved pi (0.87.0+); server/queue.ts does not use it",
    );
  });
});

describe("the queue, seen by two tabs on one chat", () => {
  test("attach sends a queue snapshot — empty is still a message, right after commands", async () => {
    const { mine, theirs } = await twoClients();
    // Absence of a `queue` would be indistinguishable from "not told yet", and a reconnecting
    // client resets its live rows to nothing: it has to hear "the queue is empty" out loud.
    assert.deepEqual(types(mine).slice(0, 4), ["hello", "commands", "queue", "mode"]);
    assert.deepEqual(types(theirs).slice(0, 4), ["hello", "commands", "queue", "mode"]);
    const snap = mine.find((m) => m.type === "queue") as Extract<ChatServerMessage, { type: "queue" }>;
    assert.deepEqual(snap.items, []);
  });

  test("a queued message, and then its departure, reach BOTH tabs", async () => {
    const { chat, mine, theirs } = await twoClients();
    // A foreign writer makes the hand-off refuse, which is a departure with a reason ("failed")
    // and no model call — the lifecycle broadcast observed end to end through the real wiring.
    chat.foreignWrite = "another process appended to it";
    mine.length = 0;
    theirs.length = 0;

    chat.queue.enqueue({ kind: "steer", text: "hold this", origin: "client", id: "c1" });
    // The snapshot goes out before anything is awaited, so both tabs show the row immediately.
    const firstSnap = (log: ChatServerMessage[]) => log.find((m) => m.type === "queue") as Extract<ChatServerMessage, { type: "queue" }>;
    assert.deepEqual(firstSnap(mine).items.map((i) => [i.id, i.state]), [["c1", "queued"]]);
    assert.deepEqual(firstSnap(theirs).items, firstSnap(mine).items, "the other tab sees the same row");

    await until(() => mine.some((m) => m.type === "queue_item_gone"));
    const gone = (log: ChatServerMessage[]) => log.find((m) => m.type === "queue_item_gone") as Extract<ChatServerMessage, { type: "queue_item_gone" }>;
    assert.deepEqual(gone(mine), { type: "queue_item_gone", itemId: "c1", reason: "failed", text: "hold this" });
    assert.deepEqual(gone(theirs), gone(mine), "and the same departure, with the same reason");
    // EXACTLY ONE CARRIER OF THE TEXT, observed on the real ChatSession rather than reasoned about.
    // A synthetic `queue_cleared` used to go out beside `queue_item_gone`; the client restores on
    // both, and the composer PREPENDS each restore, so the user's message landed in the draft
    // twice. `queue_item_gone{failed, text}` is now the only carrier — which also makes "failed"
    // and "dropped" symmetric and leaves `queue_cleared` meaning Stop alone.
    assert.equal(gone(mine).text, "hold this", "the departure carries the text, so the restore still works");
    assert.ok(!mine.some((m) => m.type === "queue_cleared"), `no synthetic queue_cleared: ${types(mine).join(", ")}`);
    assert.ok(!theirs.some((m) => m.type === "queue_cleared"));
    assert.equal(mine.filter((m) => m.type === "queue_item_gone" && m.itemId === "c1").length, 1, "and the departure itself is announced once");
    // The reason still reaches the sender, named to it, so the right composer can restore.
    const err = mine.find((m) => m.type === "error") as Extract<ChatServerMessage, { type: "error" }>;
    assert.equal(err?.clientId, "c1", "the failure names the send it belongs to");
    assert.deepEqual(types(theirs), types(mine), "neither tab has a story the other lacks");
  });

  test("a SERVER-originated prompt mid-turn goes through Sova's queue, not straight to the SDK", async () => {
    // Every mid-turn message goes through the queue, whatever its sender: `acceptPrompt` is the
    // path a group batch prompt and a remote status probe take (server/group-prompt.ts), and it
    // used to hand a follow-up straight to `session.prompt()` whenever the session was streaming,
    // past the order the queue keeps (no follow-up of ours beside our steers, server/queue.ts).
    const { chat, mine } = await twoClients();
    Object.defineProperty(piSession(chat), "isStreaming", { get: () => true, configurable: true });
    mine.length = 0;

    const { queued } = chat.acceptPrompt("a group batch prompt");
    assert.equal(queued, true, "accepted into the queue, not sent");
    // Nothing reached the SDK: both of its mirrors are still empty, and so is its real queue.
    assert.deepEqual([...piSession(chat).getSteeringMessages()], []);
    assert.deepEqual([...piSession(chat).getFollowUpMessages()], []);
    assert.equal(piSession(chat).pendingMessageCount, 0, "the SDK holds nothing of ours");
    const snap = mine.find((m) => m.type === "queue") as Extract<ChatServerMessage, { type: "queue" }>;
    assert.deepEqual(snap.items.map((i) => [i.kind, i.state, i.origin]), [["followUp", "queued", "server"]]);
  });

  test("the composer's mid-turn messages are steers that land together in pi, each its own; a follow-up waits behind them", async () => {
    // What the SDK holds of ours is ONE KIND at a time, in the order sent: every waiting steer goes
    // in behind the steers pi still holds (they reach the model at its next step together), and a
    // follow-up is never handed in beside them.
    const { chat, me, mine } = await twoClients();
    Object.defineProperty(piSession(chat), "isStreaming", { get: () => true, configurable: true });
    mine.length = 0;
    chat.handle(me, { type: "steer", text: "one more thing", clientId: "k1" });
    chat.handle(me, { type: "steer", text: "and another", clientId: "k2" });
    chat.acceptPrompt("a group batch prompt");
    await until(() => piSession(chat).getSteeringMessages().length === 2);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual([...piSession(chat).getSteeringMessages()], ["one more thing", "and another"], "both steers are in pi, in order");
    assert.deepEqual([...piSession(chat).getFollowUpMessages()], [], "the follow-up is still Sova's");
    // Handed to pi, a steer still reads Queued: it can be taken back until the agent takes it.
    assert.deepEqual(chat.queue.snapshot().map((i) => [i.id.startsWith("k") ? i.id : "batch", i.kind, i.state]), [["k1", "steer", "queued"], ["k2", "steer", "queued"], ["batch", "followUp", "queued"]]);
  });

  test("a steer handed to pi is removed on its own, out of pi's real queue and its mirror, and every client hears it", async () => {
    const { chat, me, mine, theirs } = await twoClients();
    Object.defineProperty(piSession(chat), "isStreaming", { get: () => true, configurable: true });
    for (const k of ["k1", "k2", "k3"]) chat.handle(me, { type: "steer", text: "same words", clientId: k });
    await until(() => piSession(chat).getSteeringMessages().length === 3);
    const lane = piSession(chat).agent.peekQueuedMessages();
    assert.equal(lane.length, 3, "all three are in pi's real queue");
    mine.length = 0;
    theirs.length = 0;
    chat.handle(me, { type: "queue_remove", id: "r1", itemId: "k2" });
    await until(() => mine.some((m) => m.type === "queue_removed"));
    for (const log of [mine, theirs]) {
      const gone = log.find((m) => m.type === "queue_item_gone") as Extract<ChatServerMessage, { type: "queue_item_gone" }>;
      assert.deepEqual([gone?.itemId, gone?.reason], ["k2", "removed"], "both tabs learn it was removed");
    }
    assert.ok(!theirs.some((m) => m.type === "queue_removed"), "the ack is the requester's alone");
    assert.deepEqual(piSession(chat).agent.peekQueuedMessages(), [lane[0], lane[2]], "exactly k2's message left pi; its twins stay, in order");
    assert.deepEqual([...piSession(chat).getSteeringMessages()], ["same words", "same words"]);
    assert.deepEqual(chat.queue.snapshot().map((i) => [i.id, i.state]), [["k1", "queued"], ["k3", "queued"]]);
    // Stop after the removal: only the survivors come back.
    mine.length = 0;
    chat.handle(me, { type: "abort" });
    await until(() => mine.some((m) => m.type === "queue_cleared"));
    const cleared = mine.find((m) => m.type === "queue_cleared") as Extract<ChatServerMessage, { type: "queue_cleared" }>;
    assert.deepEqual(cleared.steering, ["same words", "same words"], "the removed one never comes back");
  });

  test("a follow-up handed to pi is still refused on its own: Stop takes it back", async () => {
    const { chat, me, mine } = await twoClients();
    Object.defineProperty(piSession(chat), "isStreaming", { get: () => true, configurable: true });
    chat.handle(me, { type: "prompt", text: "after the turn", clientId: "f1" });
    await until(() => piSession(chat).getFollowUpMessages().length === 1);
    assert.deepEqual(chat.queue.snapshot().map((i) => [i.id, i.state]), [["f1", "sending"]]);
    mine.length = 0;
    chat.handle(me, { type: "queue_remove", id: "r1", itemId: "f1" });
    await until(() => mine.some((m) => m.type === "queue_remove_refused"));
    const refused = mine.find((m) => m.type === "queue_remove_refused") as Extract<ChatServerMessage, { type: "queue_remove_refused" }>;
    assert.deepEqual([refused.reason, refused.message], ["internal", HANDED_REFUSAL]);
    assert.deepEqual([...piSession(chat).getFollowUpMessages()], ["after the turn"], "nothing was taken out of pi");
  });

  test("a composer message sent while this tab still shows the chat idle, the server already busy, is a STEER (the quick second message)", async () => {
    // The tab learns a run started from the run's own events, so a second message typed right after
    // the first can leave while it still shows idle. The composer's frame never depends on that.
    const { chat, me, mine } = await twoClients();
    Object.defineProperty(piSession(chat), "isStreaming", { get: () => true, configurable: true });
    mine.length = 0;
    chat.handle(me, sendFrame("and one more thing", "q2", { typed: true }));
    const ack = mine.find((m) => m.type === "send_ack") as Extract<ChatServerMessage, { type: "send_ack" }>;
    assert.deepEqual(ack, { type: "send_ack", clientId: "q2", queued: true });
    assert.deepEqual(chat.queue.snapshot().map((i) => [i.id, i.kind]), [["q2", "steer"]], "a steer, landing with the others at the agent's next step");
  });

  test("a playbook (or a card's confirm click) sent while busy is still a follow-up: only the composer's typed message steers", async () => {
    const { chat, me } = await twoClients();
    Object.defineProperty(piSession(chat), "isStreaming", { get: () => true, configurable: true });
    const text = playbookTurnText({ title: "Brandmaker", dir: "/abs/playbooks/brandmaker", body: "# Brandmaker\n/skill:x $1\n" }, "Acme");
    chat.handle(me, sendFrame(text, "pb", { typed: false }));
    assert.deepEqual(sendFrame("c_1 a: Start", "cf", { typed: true, confirm: "c_1" }), { type: "prompt", text: "c_1 a: Start", clientId: "cf", confirm: "c_1" });
    await until(() => chat.queue.snapshot().some((i) => i.id === "pb"));
    assert.equal(chat.queue.snapshot().find((i) => i.id === "pb")?.kind, "followUp");
  });

  test("a playbook sent mid-turn is a FOLLOW-UP behind the turn, never a steer into it", async () => {
    // The Playbooks dialog sends through ChatView.send(text, false): a `prompt` frame even while
    // streaming, where the composer's own mid-turn send is a `steer`. The frame type is the whole
    // difference — the same text as a steer would be delivered INTO the running turn.
    const { chat, me, mine } = await twoClients();
    Object.defineProperty(piSession(chat), "isStreaming", { get: () => true, configurable: true });
    const text = playbookTurnText({ title: "Brandmaker", dir: "/abs/playbooks/brandmaker", body: "# Brandmaker\n/skill:x $1\n" }, "Acme");
    mine.length = 0;

    chat.handle(me, { type: "prompt", text, clientId: "pb1" });
    const ack = mine.find((m) => m.type === "send_ack") as Extract<ChatServerMessage, { type: "send_ack" }>;
    assert.deepEqual(ack, { type: "send_ack", clientId: "pb1", queued: true }, "queued, so the row is removable");
    const snap = mine.find((m) => m.type === "queue") as Extract<ChatServerMessage, { type: "queue" }>;
    assert.deepEqual(snap.items.map((i) => [i.id, i.kind, i.origin]), [["pb1", "followUp", "client"]]);
    assert.deepEqual([...piSession(chat).getSteeringMessages()], [], "nothing was steered into the turn");

    // The collision check: the same text as a steer frame DOES become a steer, so the assertion
    // above is about the frame type, not about something every mid-turn send does.
    mine.length = 0;
    chat.handle(me, { type: "steer", text, clientId: "pb2" });
    const snap2 = [...mine].reverse().find((m) => m.type === "queue") as Extract<ChatServerMessage, { type: "queue" }>;
    assert.deepEqual(snap2.items.find((i) => i.id === "pb2")?.kind, "steer");
  });

  test("tab B removes; tab A learns it was REMOVED, never infers delivered", async () => {
    // The multi-client failure this whole lifecycle exists to prevent: tab A sees the row vanish
    // from the next snapshot and, with nothing else to go on, calls it DELIVERED — telling the
    // user the model received a message that was discarded, and dropping Remove for good. The
    // snapshot alone cannot carry that difference, so the REASON is broadcast, not addressed.
    const { chat, them, mine, theirs } = await twoClients();
    Object.defineProperty(piSession(chat), "isStreaming", { get: () => true, configurable: true });
    // Two follow-ups: the first is handed to the SDK, the second stays held and is the one B removes.
    chat.queue.enqueue({ kind: "followUp", text: "first", origin: "client", id: "x1" });
    chat.queue.enqueue({ kind: "followUp", text: "second", origin: "client", id: "x2" });
    await until(() => chat.queue.snapshot().some((i) => i.id === "x2"));
    mine.length = 0;
    theirs.length = 0;

    // `them` is tab B. `mine` is tab A, which asked for nothing.
    chat.handle(them, { type: "queue_remove", id: "rb", itemId: "x2" });
    await until(() => theirs.some((m) => m.type === "queue_removed"));

    const goneForA = mine.find((m) => m.type === "queue_item_gone") as Extract<ChatServerMessage, { type: "queue_item_gone" }>;
    assert.ok(goneForA, `tab A must be told the row left: ${types(mine).join(", ")}`);
    assert.equal(goneForA.itemId, "x2");
    assert.equal(goneForA.reason, "removed", "REMOVED — not left to be inferred as delivered");
    // The text rides along, and the ID is what keeps tab A from pasting it: `itemId` IS the
    // sender's own clientId, so only the tab that typed the message recognises it as its own.
    assert.equal(goneForA.text, "second");
    // And A's snapshot no longer carries the row at all.
    const lastForA = mine.filter((m) => m.type === "queue").at(-1) as Extract<ChatServerMessage, { type: "queue" }>;
    assert.ok(!lastForA.items.some((i) => i.id === "x2"), "the row is gone from A's snapshot too");
    // The correlated ack is B's alone; A is told WHAT happened, not that B asked.
    assert.ok(!mine.some((m) => m.type === "queue_removed"), "A gets no request ack");
    assert.ok(theirs.some((m) => m.type === "queue_removed"), "B gets its own");
  });

  test("Stop is the only thing that sends queue_cleared, and it still does", async () => {
    // The other half of removing the synthetic one: `queue_cleared` must not have gone missing
    // along with it, or Stop would silently stop returning text to the composer.
    const { chat, me, mine } = await twoClients();
    Object.defineProperty(piSession(chat), "isStreaming", { get: () => true, configurable: true });
    chat.queue.enqueue({ kind: "steer", text: "held one", origin: "client", id: "s1" });
    chat.queue.enqueue({ kind: "steer", text: "held two", origin: "client", id: "s2" });
    await until(() => chat.queue.snapshot().some((i) => i.id === "s2"));
    mine.length = 0;

    chat.handle(me, { type: "abort" });
    await until(() => mine.some((m) => m.type === "queue_cleared"));
    const cleared = mine.find((m) => m.type === "queue_cleared") as Extract<ChatServerMessage, { type: "queue_cleared" }>;
    assert.ok(cleared.steering.includes("held two"), `the held text comes back: ${JSON.stringify(cleared)}`);
    // And every row is told it left, with the reason, so no client infers delivery from absence.
    const clearedIds = mine.filter((m) => m.type === "queue_item_gone" && m.reason === "cleared").map((m) => (m as { itemId: string }).itemId);
    assert.deepEqual(clearedIds.sort(), ["s1", "s2"]);
  });

  test("a removal answers the requester alone, while the departure is public", async () => {
    const { chat, me, mine, theirs } = await twoClients();
    mine.length = 0;
    theirs.length = 0;
    chat.handle(me, { type: "queue_remove", id: "r1", itemId: "never-queued" });
    await until(() => mine.some((m) => m.type === "queue_remove_refused"));
    assert.deepEqual(mine, [{ type: "queue_remove_refused", id: "r1", itemId: "never-queued", reason: "unknown", message: "That message is not in the queue anymore." }]);
    assert.deepEqual(theirs, [], "a refusal is nobody else's business: nothing changed");
  });

  test("a DROPPED departure reaches both tabs, so neither waits for a message_start", async () => {
    // An extension `input` handler that answers {action:"handled"} swallows the message: nothing
    // is queued and no message_start will ever come. A client that inferred delivery from the row
    // vanishing would show it as sent; one waiting for message_start would wait for ever.
    const { chat, mine, theirs } = await twoClients();
    // An extension command is the same shape and needs no extension: prompt() executes it and
    // queues nothing. "/help" is not registered in this runtime, so nothing runs either.
    const original = piSession(chat).prompt.bind(piSession(chat));
    (piSession(chat) as unknown as { prompt: unknown }).prompt = async () => {}; // accepted, queues nothing
    try {
      Object.defineProperty(piSession(chat), "isStreaming", { get: () => true, configurable: true });
      mine.length = 0;
      theirs.length = 0;
      chat.queue.enqueue({ kind: "steer", text: "/nothing-registered", origin: "client", id: "d1" });
      await until(() => mine.some((m) => m.type === "queue_item_gone"));
      const gone = (log: ChatServerMessage[]) => log.find((m) => m.type === "queue_item_gone") as Extract<ChatServerMessage, { type: "queue_item_gone" }>;
      assert.deepEqual(gone(mine), { type: "queue_item_gone", itemId: "d1", reason: "dropped", text: "/nothing-registered" });
      assert.deepEqual(gone(theirs), gone(mine), "and the second tab is told the same thing");
    } finally {
      (piSession(chat) as unknown as { prompt: unknown }).prompt = original;
    }
  });
});

describe("regenerate, seen by two tabs on one chat", () => {
  test("the branch move is broadcast and only the requester is told it landed", async () => {
    const { chat, me, mine, theirs } = await twoClients();
    mine.length = 0;
    theirs.length = 0;

    chat.handle(me, { type: "regenerate", id: "g1", entryId: "a2" });
    await until(() => mine.some((m) => m.type === "regenerated" || m.type === "regenerate_refused"));

    // Same order as a rewind, and for the same reason: every client's hello handler blanks its
    // worker list, so the mode (and workers, when there are any) must follow it.
    assert.deepEqual(types(theirs).slice(0, 3), ["hello", "mode", "claude_login"]);
    assert.deepEqual(types(mine).slice(0, 4), ["hello", "mode", "claude_login", "regenerated"]);
    assert.deepEqual(mine.find((m) => m.type === "regenerated"), { type: "regenerated", id: "g1", entryId: "a2", userEntryId: "u2" });
    assert.ok(!theirs.some((m) => m.type === "regenerated"), "the other tab is not told about a request it did not make");

    // The hello every client got is the NEW branch: the reply being redone, and the message that
    // produced it, are both off it.
    const hello = theirs[0] as Extract<ChatServerMessage, { type: "hello" }>;
    const rows = hello.items.map((i) => i.id);
    assert.deepEqual(rows.slice(0, 2), ["u1", "a1:0"], `rows were ${rows.join(", ")}`);
    // Stated as a collision, not as a list: the open-time model/thinking appends the rewind
    // flushes add rows of their own, and pinning the exact list would fail for the wrong reason.
    // Matched as ids, not prefixes: pi mints 8-hex ids, so a fresh row starts with "a2" one time
    // in 256 and a prefix test failed the suite at random.
    const redone = (id: string) => ["u2", "a2"].some((old) => id === old || id.startsWith(`${old}:`));
    assert.ok(!rows.some(redone), `the redone turn is off the branch (rows: ${rows.join(", ")})`);
  });

  test("a Retry replays the message with no confirm card mark: a click's approval is never carried (§app.overseer/org-people-facing)", async () => {
    const { chat, me, mine } = await twoClients();
    const c = chat as any;
    const marks: unknown[] = [];
    const toSdk = c.toSdk.bind(c);
    c.toSdk = (origin: unknown, send: () => unknown, confirm?: string) => {
      marks.push([origin, confirm ?? null]);
      return toSdk(origin, send, confirm);
    };
    try {
      mine.length = 0;
      chat.handle(me, { type: "regenerate", id: "g3", entryId: "a2" });
      await until(() => mine.some((m) => m.type === "regenerated" || m.type === "regenerate_refused"));
      await until(() => marks.length > 0);
      assert.deepEqual(marks[0], ["client", null], "the user's own replay, carrying no card");
    } finally {
      c.toSdk = toSdk;
    }
  });

  test("a card's click carries its mark in the Overseer and a project overseer, never in another chat (§app.overseer/copies)", async () => {
    const { chat } = await twoClients();
    const c = chat as any;
    const marks: (string | null)[] = [];
    const { userTurns, special } = c;
    c.userTurns = { send: (send: () => unknown, confirm?: string) => (marks.push(confirm ?? null), send()) };
    try {
      for (const kind of [null, "baton", "project-assistant", "project-overseer", "overseer"]) {
        c.special = kind;
        c.toSdk("client", () => undefined, "c_1");
        c.toSdk("client", () => undefined);
      }
      assert.deepEqual(marks, [null, null, null, null, null, null, "c_1", null, "c_1", null], "only the two overseers' clicks are marked; typed text never is");
    } finally {
      c.userTurns = userTurns;
      c.special = special;
    }
  });

  test("a refusal goes to the requester alone and moves nothing", async () => {
    const { chat, me, mine, theirs } = await twoClients();
    mine.length = 0;
    theirs.length = 0;
    chat.handle(me, { type: "regenerate", id: "g2", entryId: "u2" }); // a user row: rewind is that gesture
    await until(() => mine.some((m) => m.type === "regenerate_refused"));
    assert.deepEqual(types(mine), ["regenerate_refused"]);
    assert.deepEqual(theirs, [], "no hello, no mode: the branch did not move");
    const refused = mine[0] as Extract<ChatServerMessage, { type: "regenerate_refused" }>;
    assert.equal(refused.reason, "not_on_branch");
  });

  test("regenerate is REFUSED while a message is still queued, so nothing resurrects", async () => {
    // The end-to-end half of the rewindSession unit test: a queued message and an IDLE session is
    // a reachable state (steer() awaits the input handlers before queueing), and a regenerate
    // allowed there would deliver the queued message into the branch it just rewound to.
    const { chat, me, mine, theirs } = await twoClients();
    chat.queue.enqueue({ kind: "steer", text: "still going out", origin: "client", id: "q1" });
    mine.length = 0;
    theirs.length = 0;

    chat.handle(me, { type: "regenerate", id: "g3", entryId: "a2" });
    await until(() => mine.some((m) => m.type === "regenerate_refused" || m.type === "regenerated"));
    const refused = mine.find((m) => m.type === "regenerate_refused") as Extract<ChatServerMessage, { type: "regenerate_refused" }>;
    assert.ok(refused, `expected a refusal, got ${types(mine).join(", ")}`);
    assert.equal(refused.reason, "queued");
    assert.ok(!types(theirs).includes("hello"), "and the branch did not move for anyone");
  });

  test("the branch move is broadcast BEFORE the re-prompt, never after the turn", async () => {
    // AgentSession.prompt() resolves at TURN COMPLETION, so awaiting it before broadcasting would
    // leave every pane receiving the new turn's events for a branch it has not been told about.
    // The ordering is asserted as a sequence, which is the only form that can catch a reorder.
    const { chat, me, mine } = await twoClients();
    mine.length = 0;
    chat.handle(me, { type: "regenerate", id: "g4", entryId: "a2" });
    await until(() => mine.some((m) => m.type === "regenerated"));
    const order = types(mine);
    assert.ok(order.indexOf("hello") < order.indexOf("regenerated"), `hello must precede regenerated: ${order.join(", ")}`);
    assert.ok(order.indexOf("mode") < order.indexOf("regenerated"), `mode must precede regenerated: ${order.join(", ")}`);
  });

  test("a reply to a WAKE NUDGE is refused, and NOTHING is written", async () => {
    // A wake nudge is a role:"user" entry Sova's own scheduler wrote. Replaying it would put
    // "[wake_nudge …] Scheduled wakeup fired (set 4m17s ago)" back on the branch as if the user had
    // typed it, with an elapsed time that is now a lie.
    const path = wakeSession();
    const chat = await acquireChat(path, true);
    const mine: ChatServerMessage[] = [];
    const me = { send: (m: ChatServerMessage) => void mine.push(m) };
    chat.attach(me);
    const before = readFileSync(path, "utf8");
    mine.length = 0;

    chat.handle(me, { type: "regenerate", id: "w1", entryId: "a2" });
    await until(() => mine.some((m) => m.type === "regenerate_refused" || m.type === "regenerated"));

    const refused = mine.find((m) => m.type === "regenerate_refused") as Extract<ChatServerMessage, { type: "regenerate_refused" }>;
    assert.ok(refused, `expected a refusal, got ${types(mine).join(", ")}`);
    assert.equal(refused.reason, "wake");
    // The refusal is only worth anything if it happened BEFORE the branch moved: no rewind marker,
    // no navigate, no prompt. The file is the evidence.
    assert.equal(readFileSync(path, "utf8"), before, "not one byte was written");
    assert.ok(!types(mine).includes("hello"), "and no client was told the branch moved");
  });
});
