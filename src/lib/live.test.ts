// Run: npx tsx --test src/lib/live.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "solid-js/store";
import {
  addPendingPrompt,
  applyEvent,
  applyQueue,
  emptyLive,
  markDelivered,
  markQueued,
  markRemoved,
  newClientId,
  queuedText,
  runDetail,
  takeBackQueued,
  unsentRows,
  type LiveState,
  type QueuedItem,
} from "./live";

function store(): [LiveState, ReturnType<typeof createStore<LiveState>>[1]] {
  const [s, set] = createStore<LiveState>(emptyLive());
  return [s, set];
}

const messageStart = (provider?: string, model?: string) => ({
  type: "message_start",
  message: { role: "assistant", provider, model, content: [] },
});

test("message_start attributes the streaming message to its model", () => {
  const [s, set] = store();
  applyEvent(set, messageStart("zai", "glm-5.3"));
  assert.equal(s.entries[0]?.kind, "assistant");
  if (s.entries[0]?.kind === "assistant") assert.equal(s.entries[0].model, "zai/glm-5.3");
});

test("message_end is authoritative and can override the model", () => {
  const [s, set] = store();
  applyEvent(set, messageStart("zai", "glm-5.3"));
  applyEvent(set, {
    type: "message_end",
    message: {
      role: "assistant",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "text", text: "hi" }],
      stopReason: "stop",
    },
  });
  if (s.entries[0]?.kind === "assistant") {
    assert.equal(s.entries[0].model, "openai/gpt-5.5");
    assert.equal(s.entries[0].done, true);
  }
});

test("events without provider/model leave the entry's model unset", () => {
  const [s, set] = store();
  applyEvent(set, messageStart());
  if (s.entries[0]?.kind === "assistant") assert.equal(s.entries[0].model, undefined);
});

test("a pending prompt carries its uploads as available attachments until delivered", () => {
  const [s, set] = store();
  const path = "/tmp/sova-a58752a9-8229-46d3-a816-07ef24919b10.png";
  addPendingPrompt(set, `look at this\n${path}`, [], [{ path, name: path.slice(5), mimeType: "image/png", size: 1234 }]);
  const entry = s.entries[0];
  assert.equal(entry?.kind, "user");
  if (entry?.kind !== "user") return;
  assert.equal(entry.text, `look at this\n${path}`);
  assert.deepEqual(entry.images, []);
  assert.deepEqual(entry.attachments, [{ path, name: path.slice(5), mimeType: "image/png", size: 1234, available: true }]);
  applyEvent(set, { type: "message_start", message: { role: "user", content: [{ type: "text", text: entry.text }] } });
  assert.equal(s.entries.length, 1);
  if (s.entries[0]?.kind === "user") {
    assert.equal(s.entries[0].state, "delivered");
    assert.equal(s.entries[0].attachments?.length, 1);
  }
});

test("a pending prompt without uploads has no attachments", () => {
  const [s, set] = store();
  addPendingPrompt(set, "hi");
  if (s.entries[0]?.kind === "user") assert.equal(s.entries[0].attachments, undefined);
});

test("takeBackQueued drops the drained prompts' pending rows and hands their text back", () => {
  const [s, set] = store();
  addPendingPrompt(set, "first prompt");
  applyEvent(set, { type: "message_start", message: { role: "user", content: [{ type: "text", text: "first prompt" }] } });
  applyEvent(set, messageStart("zai", "glm-5.3"));
  addPendingPrompt(set, "so basically");
  addPendingPrompt(set, "and later");
  const text = takeBackQueued(set, ["so basically", "and later"]);
  assert.equal(text, "so basically\n\nand later");
  assert.deepEqual(
    s.entries.map((e) => e.kind),
    ["user", "assistant"],
  );
  if (s.entries[0]?.kind === "user") assert.equal(s.entries[0].state, "delivered"); // the delivered prompt stays
});

test("takeBackQueued keeps unrelated and already-delivered rows with the same text", () => {
  const [s, set] = store();
  addPendingPrompt(set, "same");
  applyEvent(set, { type: "message_start", message: { role: "user", content: [{ type: "text", text: "same" }] } });
  addPendingPrompt(set, "other");
  addPendingPrompt(set, "same");
  // An expanded skill/template queues different text: no row matches, the text still comes back.
  assert.equal(takeBackQueued(set, ["same", "<skill>expanded</skill>"]), "same\n\n<skill>expanded</skill>");
  assert.deepEqual(
    s.entries.map((e) => (e.kind === "user" ? [e.text, e.state === "delivered"] : e.kind)),
    [
      ["same", true],
      ["other", false],
    ],
  );
});

test("takeBackQueued with nothing drained changes nothing", () => {
  const [s, set] = store();
  addPendingPrompt(set, "hi");
  assert.equal(takeBackQueued(set, []), "");
  assert.equal(s.entries.length, 1);
});

// ---- The outgoing queue --------------------------------------------

const queued = (id: string, text: string, over: Partial<QueuedItem> = {}): QueuedItem => ({ id, kind: "steer", text, ...over });
const userRows = (s: LiveState) => s.entries.flatMap((e) => (e.kind === "user" ? [{ id: e.id, text: e.text, state: e.state, handed: e.handed }] : []));

test("a snapshot turns our sent rows into queued ones, by id", () => {
  const [s, set] = store();
  addPendingPrompt(set, "one", [], [], "c1");
  addPendingPrompt(set, "two", [], [], "c2");
  applyQueue(set, [queued("c1", "one"), queued("c2", "two", { state: "sending" })]);
  assert.deepEqual(userRows(s), [
    { id: "c1", text: "one", state: "queued", handed: false },
    { id: "c2", text: "two", state: "queued", handed: true },
  ]);
});

test("a row the server never acknowledged stays sending, and is never offered as removable", () => {
  const [s, set] = store();
  addPendingPrompt(set, "one", [], [], "c1");
  applyQueue(set, []); // the server holds nothing of ours yet
  assert.deepEqual(userRows(s), [{ id: "c1", text: "one", state: "sending", handed: undefined }]);
});

test("a queued row missing from the next snapshot is NOT called delivered", () => {
  // Stop, another client's removal and a refusal all empty the queue too: only message_start,
  // queue_removed and queue_cleared may say which of them happened.
  const [s, set] = store();
  addPendingPrompt(set, "one", [], [], "c1");
  applyQueue(set, [queued("c1", "one")]);
  applyQueue(set, []);
  assert.deepEqual(userRows(s), [{ id: "c1", text: "one", state: "queued", handed: true }]);
  applyEvent(set, { type: "message_start", message: { role: "user", content: [{ type: "text", text: "one" }] } });
  assert.equal(userRows(s)[0]!.state, "delivered");
});

test("a removal reaches every client: the tab that didn't ask drops the row from the broadcast", () => {
  // Two clients of one chat, each with its own store. A removes; B only ever sees the broadcast.
  const [a, setA] = store();
  const [b, setB] = store();
  addPendingPrompt(setA, "one", [], [], "c1"); // authored in A
  const snapshot = [queued("c1", "one"), queued("c2", "two")];
  applyQueue(setA, snapshot);
  applyQueue(setB, snapshot); // B rebuilt both rows from the snapshot alone
  assert.deepEqual(userRows(b).map((r) => r.id), ["c1", "c2"]);
  markRemoved(setA, "c1");
  markRemoved(setB, "c1"); // the same broadcast, in the tab that didn't ask
  // Both tabs hold both rows (A authored c1; c2 came from the snapshot), and both drop c1.
  assert.deepEqual(userRows(a).map((r) => r.id), ["c2"]);
  assert.deepEqual(userRows(b).map((r) => r.id), ["c2"]);
});

test("a removal broadcast for a message this client never had changes nothing", () => {
  const [s, set] = store();
  applyQueue(set, [queued("c2", "two")]);
  markRemoved(set, "c1");
  assert.deepEqual(userRows(s).map((r) => r.id), ["c2"]);
});

test("a reconnect rebuilds the queue from the snapshot alone, this tab's rows and other clients'", () => {
  const [s, set] = store(); // hello reset the live state: no rows at all
  applyQueue(set, [queued("c1", "mine"), queued("s7", "status check", { kind: "followUp", origin: "server" })]);
  assert.deepEqual(userRows(s), [
    { id: "c1", text: "mine", state: "queued", handed: false },
    { id: "s7", text: "status check", state: "queued", handed: false },
  ]);
  const server = s.entries.find((e) => e.kind === "user" && e.id === "s7");
  if (server?.kind === "user") assert.equal(server.origin, "server");
});

test("removal is by id, so a middle duplicate goes and its twins stay", () => {
  const [s, set] = store();
  addPendingPrompt(set, "again", [], [], "c1");
  addPendingPrompt(set, "again", [], [], "c2");
  addPendingPrompt(set, "again", [], [], "c3");
  applyQueue(set, [queued("c1", "again"), queued("c2", "again"), queued("c3", "again")]);
  markRemoved(set, "c2");
  assert.deepEqual(userRows(s).map((r) => r.id), ["c1", "c3"]);
});

test("an image-only queued message is a row like any other, removable by its id", () => {
  const [s, set] = store();
  addPendingPrompt(set, "", [], [{ path: "/tmp/sova-x.png", name: "sova-x.png", mimeType: "image/png", size: 10 }], "c1");
  applyQueue(set, [queued("c1", "", { images: 1 })]);
  assert.equal(userRows(s)[0]!.state, "queued");
  markRemoved(set, "c1");
  assert.deepEqual(userRows(s), []);
});

test("a refused removal leaves the row in the state the refusal reports: already sent", () => {
  const [s, set] = store();
  addPendingPrompt(set, "one", [], [], "c1");
  applyQueue(set, [queued("c1", "one")]);
  markDelivered(set, "c1");
  assert.equal(userRows(s)[0]!.state, "delivered");
  // And the row is still there: a consumed message is on its way, not gone.
  assert.equal(s.entries.length, 1);
});

test("send_ack queues the row it names and leaves the others alone", () => {
  const [s, set] = store();
  addPendingPrompt(set, "one", [], [], "c1");
  addPendingPrompt(set, "two", [], [], "c2");
  markQueued(set, "c2");
  assert.deepEqual(userRows(s).map((r) => r.state), ["sending", "queued"]);
});

test("message_start delivers the row with THAT text, not whichever came first", () => {
  const [s, set] = store();
  addPendingPrompt(set, "follow up", [], [], "c1");
  addPendingPrompt(set, "steer me", [], [], "c2");
  applyQueue(set, [queued("c1", "follow up", { kind: "followUp" }), queued("c2", "steer me")]);
  // Steers go before follow-ups in the loop: the SECOND row is delivered first.
  applyEvent(set, { type: "message_start", message: { role: "user", content: [{ type: "text", text: "steer me" }] } });
  assert.deepEqual(userRows(s).map((r) => [r.id, r.state]), [
    ["c1", "queued"],
    ["c2", "delivered"],
  ]);
});

// ---- Delivery: the server's word by id, then the agent's own message_start ----------------------

const userStart = (text: string) => ({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });

/**
 * How a message sent mid-turn reaches its row when the agent takes it, in the order ChatView
 * applies it. The SDK takes the message off its queue BEFORE it emits that message's
 * `message_start` (`_handleAgentEvent`, agent-session.js), the server's queue reports the departure
 * from inside that step (`queue_item_gone{delivered}`, then the snapshot without it), and ChatView
 * applies both on receipt while SDK events wait for the next animation frame. So the row is
 * already "delivered" when its own start arrives — on every mid-turn send, not in a race.
 */
function deliverMidTurn(set: ReturnType<typeof store>[1], id: string, started: string, stillHeld: QueuedItem[] = []) {
  markDelivered(set, id); // queue_item_gone{delivered}
  applyQueue(set, stillHeld); // queue
  applyEvent(set, userStart(started)); // event{message_start}, a frame later
}

test("a message sent mid-turn is ONE row once delivered, in either order of its departure and its start", () => {
  const path = "/home/u/.pi/agent/sova/attachments/s1/sova-shot.png";
  const text = `what is this?\n${path}`;
  for (const departureFirst of [true, false]) {
    const [s, set] = store();
    applyEvent(set, messageStart("zai", "glm-5.3")); // the reply this message interrupts
    addPendingPrompt(set, text, [], [{ path, name: "sova-shot.png", mimeType: "image/png", size: 10 }], "c1");
    applyQueue(set, [queued("c1", text, { state: "sending" })]);
    markQueued(set, "c1");
    if (departureFirst) deliverMidTurn(set, "c1", text);
    else {
      applyEvent(set, userStart(text));
      markDelivered(set, "c1");
      applyQueue(set, []);
    }
    assert.deepEqual(userRows(s), [{ id: "c1", text, state: "delivered", handed: true }], `order departureFirst=${departureFirst}`);
    // The row that stays is the one that was sent, attachment chip and all — not one rebuilt from
    // the start's text, which renders the upload's path as prose.
    const row = s.entries.find((e) => e.kind === "user");
    assert.equal(row?.kind === "user" ? row.attachments?.length : 0, 1, `order departureFirst=${departureFirst}`);
  }
});

test("a start whose row was already delivered doesn't take the queued message behind it", () => {
  const [s, set] = store();
  addPendingPrompt(set, "it has been working fine", [], [], "c1");
  addPendingPrompt(set, "*with* claude models", [], [], "c2");
  applyQueue(set, [queued("c1", "it has been working fine", { state: "sending" }), queued("c2", "*with* claude models")]);
  deliverMidTurn(set, "c1", "it has been working fine", [queued("c2", "*with* claude models")]);
  assert.deepEqual(userRows(s).map((r) => [r.id, r.state]), [
    ["c1", "delivered"],
    ["c2", "queued"], // still removable: nothing has taken it
  ]);
  deliverMidTurn(set, "c2", "*with* claude models");
  assert.deepEqual(userRows(s).map((r) => [r.id, r.state]), [
    ["c1", "delivered"],
    ["c2", "delivered"],
  ]);
});

test("the same words twice are two messages: one start per row, and a start no row is waiting for is a new message", () => {
  const [s, set] = store();
  addPendingPrompt(set, "ok", [], [], "c1");
  applyEvent(set, userStart("ok")); // sent idle: no queue, its start alone delivers it
  applyEvent(set, messageStart());
  addPendingPrompt(set, "ok", [], [], "c2"); // the same words again, mid-turn
  applyQueue(set, [queued("c2", "ok", { state: "sending" })]);
  deliverMidTurn(set, "c2", "ok");
  assert.deepEqual(userRows(s).map((r) => [r.id, r.state]), [
    ["c1", "delivered"],
    ["c2", "delivered"],
  ]);
  // A third "ok" that no row here was waiting for — another tab's send, a group prompt — is shown,
  // not taken for an echo of either: a row answers to one start, never to its words alone.
  applyEvent(set, userStart("ok"));
  assert.deepEqual(userRows(s).map((r) => [r.id, r.state]), [
    ["c1", "delivered"],
    ["c2", "delivered"],
    [undefined, "delivered"],
  ]);
});

test("a start whose text was rewritten on the way claims the row the server delivered, not the first one waiting", () => {
  // A vision description or a skill expansion changes the text between the send and the start,
  // so no row matches it. Here this tab's own message is on screen first but reached the server
  // second, behind another tab's — whose departure is the evidence of whose start this is.
  const [s, set] = store();
  addPendingPrompt(set, "mine", [], [], "c1");
  applyQueue(set, [queued("t2", "theirs", { state: "sending" }), queued("c1", "mine")]);
  deliverMidTurn(set, "t2", "theirs\n\n[image: a chart]", [queued("c1", "mine")]);
  assert.deepEqual(userRows(s).map((r) => [r.id, r.state]), [
    ["c1", "queued"],
    ["t2", "delivered"],
  ]);
});

test("a message sent while a reply streams doesn't split the reply in two", () => {
  const [s, set] = store();
  const update = (ev: Record<string, unknown>) => applyEvent(set, { type: "message_update", assistantMessageEvent: ev });
  applyEvent(set, messageStart("zai", "glm-5.3"));
  update({ type: "thinking_start", contentIndex: 0 });
  update({ type: "thinking_delta", contentIndex: 0, delta: "Definitive timeline" });
  addPendingPrompt(set, "this session is weird", [], [], "c1");
  // The row below the reply doesn't hide what the reply is doing.
  assert.equal(runDetail(s), "thinking");
  update({ type: "thinking_delta", contentIndex: 0, delta: " for today" });
  update({ type: "toolcall_start", contentIndex: 1, id: "t1", toolName: "bash" });
  applyEvent(set, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Definitive timeline for today" },
        { type: "toolCall", id: "t1", name: "bash", arguments: {} },
      ],
      stopReason: "toolUse",
    },
  });
  assert.deepEqual(s.entries.map((e) => e.kind), ["assistant", "user"]);
  const reply = s.entries[0];
  assert.ok(reply?.kind === "assistant");
  assert.equal(reply.done, true); // no half of it left streaming for ever
  assert.deepEqual(reply.blocks.map((b) => (b.type === "toolCall" ? b.name : b.text)), ["Definitive timeline for today", "bash"]);
});

test("client ids are unique, and exist without a secure context", () => {
  const secure: unknown = globalThis.crypto?.randomUUID;
  try {
    // Plain http on the LAN: no crypto.randomUUID at all. Sending must still work.
    Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
    const ids = new Set(Array.from({ length: 500 }, () => newClientId()));
    assert.equal(ids.size, 500);
  } finally {
    Object.defineProperty(globalThis.crypto, "randomUUID", { value: secure, configurable: true });
  }
});

test("Stop returns the drained text exactly once, whichever order its two messages arrive in", () => {
  // The server sends `queue_item_gone {reason:"cleared"}` per item AND `queue_cleared` with the
  // texts. Only the second restores; the first must not double it, and neither ordering may drop
  // the row or the text.
  for (const goneFirst of [true, false]) {
    const [s, set] = store();
    addPendingPrompt(set, "so basically", [], [], "c1");
    applyQueue(set, [queued("c1", "so basically")]);
    let text = "";
    if (goneFirst) {
      markRemoved(set, "c1");
      text = takeBackQueued(set, ["so basically"]);
    } else {
      text = takeBackQueued(set, ["so basically"]);
      markRemoved(set, "c1");
    }
    assert.equal(text, "so basically", `order goneFirst=${goneFirst}`);
    assert.deepEqual(userRows(s), [], `order goneFirst=${goneFirst}`);
  }
});

test("a departure that arrives twice removes the row once and stays idempotent", () => {
  const [s, set] = store();
  addPendingPrompt(set, "one", [], [], "c1");
  addPendingPrompt(set, "two", [], [], "c2");
  applyQueue(set, [queued("c1", "one"), queued("c2", "two")]);
  markRemoved(set, "c1");
  markRemoved(set, "c1"); // a reconnect replay, or the ack behind the broadcast
  assert.deepEqual(userRows(s).map((r) => r.id), ["c2"]);
});

test("a queued row knows its own text, so a departure can hand it back without a body", () => {
  // "dropped" has no other carrier: no message_start, no queue_cleared, no ack. If the broadcast
  // ever stops carrying the text, this is what keeps the user's words.
  const [s, set] = store();
  addPendingPrompt(set, "the words I typed", [], [], "c1");
  applyQueue(set, [queued("c1", "the words I typed")]);
  assert.equal(queuedText(s, "c1"), "the words I typed");
  // Another tab's message, or one already gone: nothing to hand back, and no guess made.
  assert.equal(queuedText(s, "c2"), "");
  markRemoved(set, "c1");
  assert.equal(queuedText(s, "c1"), "");
});

test("a failed hand-off returns its text ONCE, in either order of its two messages", () => {
  // The server broadcasts `queue_item_gone{failed, text}` AND an `error` whose code ("busy" /
  // "recent") reaches restoreUnsent — and it does NOT close the socket, so both are processed.
  // Whichever arrives first, the user must find one copy in the draft, not two.
  for (const departureFirst of [true, false]) {
    const [s, set] = store();
    const claimed = new Set<string>();
    addPendingPrompt(set, "cancel me", [], [], "c1");
    applyQueue(set, [queued("c1", "cancel me")]);
    const restored: string[] = [];
    // The two paths as ChatView runs them, sharing one "already handed back" set.
    const departure = () => {
      if (!claimed.has("c1")) restored.push(queuedText(s, "c1")); // queue_item_gone{failed, text}
      claimed.add("c1");
      markRemoved(set, "c1");
    };
    const refusal = () => {
      const rows = unsentRows(s, claimed); // restoreUnsent, on the accompanying error
      for (const r of rows) if (r.id) claimed.add(r.id);
      restored.push(...rows.map((r) => r.text));
    };
    if (departureFirst) {
      departure();
      refusal();
    } else {
      refusal();
      departure();
    }
    assert.deepEqual(restored.filter(Boolean), ["cancel me"], `order departureFirst=${departureFirst}`);
  }
});

test("a chat-wide refusal still returns every message no departure spoke for", () => {
  const [s, set] = store();
  addPendingPrompt(set, "first", [], [], "c1");
  addPendingPrompt(set, "second", [], [], "c2");
  applyQueue(set, [queued("c1", "first"), queued("c2", "second")]);
  // Only c1 failed; a "busy" refusal must still hand back c2, which nothing else will.
  assert.deepEqual(unsentRows(s, new Set(["c1"])).map((r) => r.text), ["second"]);
  // With nothing handed back — the ordinary busy/recent/config case — everything comes back.
  assert.deepEqual(unsentRows(s).map((r) => r.text), ["first", "second"]);
});
