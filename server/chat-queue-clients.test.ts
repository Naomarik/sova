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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { ChatServerMessage } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-queue-clients-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths
const sessionsDir = join(agentDir, "sessions", "--tmp-queueclients--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });

const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
const { playbookTurnText } = await import("../src/lib/playbooks");

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

const until = async (ready: () => boolean) => {
  for (let i = 0; i < 100 && !ready(); i++) await new Promise((r) => setTimeout(r, 10));
};
const types = (log: ChatServerMessage[]) => log.map((m) => m.type);

describe("the SDK surface this feature stands on, in the copy the repo actually resolves", () => {
  test("every queue member pi-web calls exists on a REAL session", async () => {
    // THIS TEST EXISTS BECAUSE THE OBVIOUS READING WAS WRONG. `Agent.peekQueuedMessages()` is
    // declared in the pi-agent-core shipped with the globally installed pi (0.87.0, the path
    // CLAUDE.md names) and is absent from the 0.86.1 copy nested under node_modules that pi-web
    // actually imports — .d.ts and .js alike. A design was built on it, and a typecheck happened
    // to catch it; nothing in the unit suites would have, because a fake answers whatever it is
    // told to. Reading a package proves what that copy says; only calling it through the repo's
    // own import proves what pi-web will run.
    const { chat } = await twoClients();
    const session = chat.session;
    for (const name of ["steer", "prompt", "clearQueue", "getSteeringMessages", "getFollowUpMessages", "abort"] as const) {
      assert.equal(typeof session[name], "function", `AgentSession.${name}`);
    }
    assert.equal(typeof session.agent?.hasQueuedMessages, "function", "Agent.hasQueuedMessages");
    // Called, not just counted: a member that exists but throws is the same outage.
    assert.equal(session.agent.hasQueuedMessages(), false, "an idle session holds nothing");
    assert.deepEqual([...session.getSteeringMessages()], []);
    assert.deepEqual([...session.getFollowUpMessages()], []);
    // And the one that is NOT there, pinned so a future pin bump that adds it is a decision
    // somebody makes rather than a silent change of meaning under the queue.
    assert.equal(
      (session.agent as unknown as Record<string, unknown>).peekQueuedMessages,
      undefined,
      "peekQueuedMessages is absent in the resolved 0.86.1; server/queue.ts must not depend on it",
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

  test("a SERVER-originated prompt mid-turn goes through pi-web's queue, not straight to the SDK", async () => {
    // The invariant clearQueue() depends on: AT MOST ONE pi-web item inside the SDK, across BOTH
    // kinds. `acceptPrompt` is the path a group batch prompt and a remote status probe take
    // (server/group-prompt.ts), and it used to hand a follow-up straight to `session.prompt()`
    // whenever the session was streaming — which would put a second item of ours in the SDK
    // beside a queued steer and make a removal of either one unable to use clearQueue at all.
    const { chat, mine } = await twoClients();
    Object.defineProperty(chat.session, "isStreaming", { get: () => true, configurable: true });
    mine.length = 0;

    const { queued } = chat.acceptPrompt("a group batch prompt");
    assert.equal(queued, true, "accepted into the queue, not sent");
    // Nothing reached the SDK: both of its mirrors are still empty, and so is its real queue.
    assert.deepEqual([...chat.session.getSteeringMessages()], []);
    assert.deepEqual([...chat.session.getFollowUpMessages()], []);
    assert.equal(chat.session.pendingMessageCount, 0, "the SDK holds nothing of ours");
    const snap = mine.find((m) => m.type === "queue") as Extract<ChatServerMessage, { type: "queue" }>;
    assert.deepEqual(snap.items.map((i) => [i.kind, i.state, i.origin]), [["followUp", "queued", "server"]]);
  });

  test("a playbook sent mid-turn is a FOLLOW-UP behind the turn, never a steer into it", async () => {
    // The Playbooks dialog sends through ChatView.send(text, false): a `prompt` frame even while
    // streaming, where the composer's own mid-turn send is a `steer`. The frame type is the whole
    // difference — the same text as a steer would be delivered INTO the running turn.
    const { chat, me, mine } = await twoClients();
    Object.defineProperty(chat.session, "isStreaming", { get: () => true, configurable: true });
    const text = playbookTurnText({ title: "Brandmaker", dir: "/abs/playbooks/brandmaker", body: "# Brandmaker\n/skill:x $1\n" }, "Acme");
    mine.length = 0;

    chat.handle(me, { type: "prompt", text, clientId: "pb1" });
    const ack = mine.find((m) => m.type === "send_ack") as Extract<ChatServerMessage, { type: "send_ack" }>;
    assert.deepEqual(ack, { type: "send_ack", clientId: "pb1", queued: true }, "queued, so the row is removable");
    const snap = mine.find((m) => m.type === "queue") as Extract<ChatServerMessage, { type: "queue" }>;
    assert.deepEqual(snap.items.map((i) => [i.id, i.kind, i.origin]), [["pb1", "followUp", "client"]]);
    assert.deepEqual([...chat.session.getSteeringMessages()], [], "nothing was steered into the turn");

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
    Object.defineProperty(chat.session, "isStreaming", { get: () => true, configurable: true });
    // Two items: the first is handed to the SDK, the second stays held and is the one B removes.
    chat.queue.enqueue({ kind: "steer", text: "first", origin: "client", id: "x1" });
    chat.queue.enqueue({ kind: "steer", text: "second", origin: "client", id: "x2" });
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
    Object.defineProperty(chat.session, "isStreaming", { get: () => true, configurable: true });
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
    const original = chat.session.prompt.bind(chat.session);
    (chat.session as unknown as { prompt: unknown }).prompt = async () => {}; // accepted, queues nothing
    try {
      Object.defineProperty(chat.session, "isStreaming", { get: () => true, configurable: true });
      mine.length = 0;
      theirs.length = 0;
      chat.queue.enqueue({ kind: "steer", text: "/nothing-registered", origin: "client", id: "d1" });
      await until(() => mine.some((m) => m.type === "queue_item_gone"));
      const gone = (log: ChatServerMessage[]) => log.find((m) => m.type === "queue_item_gone") as Extract<ChatServerMessage, { type: "queue_item_gone" }>;
      assert.deepEqual(gone(mine), { type: "queue_item_gone", itemId: "d1", reason: "dropped", text: "/nothing-registered" });
      assert.deepEqual(gone(theirs), gone(mine), "and the second tab is told the same thing");
    } finally {
      (chat.session as unknown as { prompt: unknown }).prompt = original;
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
    assert.deepEqual(types(theirs).slice(0, 2), ["hello", "mode"]);
    assert.deepEqual(types(mine).slice(0, 3), ["hello", "mode", "regenerated"]);
    assert.deepEqual(mine.find((m) => m.type === "regenerated"), { type: "regenerated", id: "g1", entryId: "a2", userEntryId: "u2" });
    assert.ok(!theirs.some((m) => m.type === "regenerated"), "the other tab is not told about a request it did not make");

    // The hello every client got is the NEW branch: the reply being redone, and the message that
    // produced it, are both off it.
    const hello = theirs[0] as Extract<ChatServerMessage, { type: "hello" }>;
    const rows = hello.items.map((i) => i.id);
    assert.deepEqual(rows.slice(0, 2), ["u1", "a1:0"], `rows were ${rows.join(", ")}`);
    // Stated as a collision, not as a list: the open-time model/thinking appends the rewind
    // flushes add rows of their own, and pinning the exact list would fail for the wrong reason.
    assert.ok(!rows.some((id) => id.startsWith("u2") || id.startsWith("a2")), "the redone turn is off the branch");
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
    // A wake nudge is a role:"user" entry pi-web's own scheduler wrote. Replaying it would put
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
