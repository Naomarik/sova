// Run: pnpm test -- src/lib/live.test.ts
// Every test runs on the three paths a live event takes to the reducer: an older server's wire-1 frame
// (ChatView's unwrapping), a wire-2 server's frames, and `fromV1` on the event alone (the shim).
import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";
import { createStore, type SetStoreFunction } from "solid-js/store";
import { parseTopicBatch, formatTopicBatch } from "../../shared/topic-message";
import type { V1EventFrame } from "../../shared/protocol";
import { fromV1 } from "../../shared/wire-v1";
import {
  addPendingPrompt,
  applyEvent,
  applyQueue,
  BATON_SENT_EVENT,
  blockStreams,
  emptyLive,
  liveEventsOf,
  liveInputCount,
  markDelivered,
  markQueued,
  markRemoved,
  newClientId,
  offersRemove,
  queuedText,
  runDetail,
  seedLive,
  shownUserState,
  takeBackQueued,
  unsentRows,
  type LiveEvent,
  type LiveState,
  type QueuedItem,
} from "./live";

const PATHS = ["v1", "v2", "shim"] as const;
let path: (typeof PATHS)[number] = "v1";

/** node:test's `test`, once per path. The tests are synchronous, so `path` holds for the whole body. */
function test(name: string, fn: () => void): void {
  for (const p of PATHS)
    nodeTest(`${name} [${p}]`, () => {
      path = p;
      fn();
    });
}

/** A pi event (with a message_end's `entryId` on it, where ChatView used to put it), applied on the
    current path; the baton sender marker is client-local, so it is applied as it is on every path. */
function feed(set: SetStoreFunction<LiveState>, ev: Record<string, unknown>): void {
  if (ev.type === BATON_SENT_EVENT) {
    applyEvent(set, ev as LiveEvent);
    return;
  }
  const { entryId, reply, ...event } = ev;
  // As the server sends it: the entry id and a measured reply's timing on the frame, through JSON.
  const v1: V1EventFrame = JSON.parse(JSON.stringify({ type: "event", event, ...(typeof entryId === "string" ? { entryId } : {}), ...(reply ? { reply } : {}) }));
  const events =
    path === "v1"
      ? liveEventsOf(v1)
      : path === "v2"
        ? fromV1(v1).flatMap((e) => liveEventsOf(JSON.parse(JSON.stringify({ type: "event", v: 2, event: e }))))
        : fromV1({ event: { ...event, ...(entryId !== undefined ? { entryId } : {}) }, ...(reply ? { reply: reply as V1EventFrame["reply"] } : {}) });
  for (const e of events) applyEvent(set, e);
}

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
  feed(set, messageStart("zai", "glm-5.3"));
  assert.equal(s.entries[0]?.kind, "assistant");
  if (s.entries[0]?.kind === "assistant") assert.equal(s.entries[0].model, "zai/glm-5.3");
});

test("message_end is authoritative and can override the model", () => {
  const [s, set] = store();
  feed(set, messageStart("zai", "glm-5.3"));
  feed(set, {
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
  feed(set, messageStart());
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
  feed(set, { type: "message_start", message: { role: "user", content: [{ type: "text", text: entry.text }] } });
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
  feed(set, { type: "message_start", message: { role: "user", content: [{ type: "text", text: "first prompt" }] } });
  feed(set, messageStart("zai", "glm-5.3"));
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
  feed(set, { type: "message_start", message: { role: "user", content: [{ type: "text", text: "same" }] } });
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

test("a row the server has handed to the agent shows Sending again: no longer removable on its own", () => {
  const [s, set] = store();
  addPendingPrompt(set, "one", [], [], "c1");
  addPendingPrompt(set, "two", [], [], "c2");
  applyQueue(set, [queued("c1", "one", { state: "sending" }), queued("c2", "two")]);
  const shown = s.entries.flatMap((e) => (e.kind === "user" ? [[e.id, shownUserState(e)]] : []));
  assert.deepEqual(shown, [["c1", "sending"], ["c2", "queued"]], "handed: Sending (no Remove); held: Queued");
  assert.equal(shownUserState({ state: "delivered", handed: true }), "delivered");
  assert.equal(shownUserState({ state: "sending" }), "sending");
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
  feed(set, { type: "message_start", message: { role: "user", content: [{ type: "text", text: "one" }] } });
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

test("a queued message the Overseer sent is flagged as the Overseer's; a server row without the flag is not", () => {
  const [s, set] = store();
  applyQueue(set, [queued("o1", "run the tests", { kind: "followUp", origin: "server", overseer: true }), queued("s7", "status check", { kind: "followUp", origin: "server" })]);
  const row = (id: string) => s.entries.find((e) => e.kind === "user" && e.id === id);
  const o1 = row("o1");
  const s7 = row("s7");
  assert.deepEqual(o1?.kind === "user" && [o1.origin, o1.overseer], ["server", true]);
  assert.deepEqual(s7?.kind === "user" && [s7.origin, s7.overseer], ["server", undefined]);
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
  // Steers go before follow-ups in the loop: the SECOND row is delivered first, and moves above the
  // one still waiting, as the session file has them.
  feed(set, { type: "message_start", message: { role: "user", content: [{ type: "text", text: "steer me" }] } });
  assert.deepEqual(userRows(s).map((r) => [r.id, r.state]), [
    ["c2", "delivered"],
    ["c1", "queued"],
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
  feed(set, userStart(started)); // event{message_start}, a frame later
}

test("a message sent mid-turn is ONE row once delivered, in either order of its departure and its start", () => {
  const path = "/home/u/.pi/agent/sova/attachments/s1/sova-shot.png";
  const text = `what is this?\n${path}`;
  for (const departureFirst of [true, false]) {
    const [s, set] = store();
    feed(set, messageStart("zai", "glm-5.3")); // the reply this message interrupts
    addPendingPrompt(set, text, [], [{ path, name: "sova-shot.png", mimeType: "image/png", size: 10 }], "c1");
    applyQueue(set, [queued("c1", text, { state: "sending" })]);
    markQueued(set, "c1");
    if (departureFirst) deliverMidTurn(set, "c1", text);
    else {
      feed(set, userStart(text));
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
  feed(set, userStart("ok")); // sent idle: no queue, its start alone delivers it
  feed(set, messageStart());
  addPendingPrompt(set, "ok", [], [], "c2"); // the same words again, mid-turn
  applyQueue(set, [queued("c2", "ok", { state: "sending" })]);
  deliverMidTurn(set, "c2", "ok");
  assert.deepEqual(userRows(s).map((r) => [r.id, r.state]), [
    ["c1", "delivered"],
    ["c2", "delivered"],
  ]);
  // A third "ok" that no row here was waiting for — another tab's send, a group prompt — is shown,
  // not taken for an echo of either: a row answers to one start, never to its words alone.
  feed(set, userStart("ok"));
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
    ["t2", "delivered"],
    ["c1", "queued"],
  ]);
});

test("a message sent while a reply streams doesn't split the reply in two", () => {
  const [s, set] = store();
  const update = (ev: Record<string, unknown>) => feed(set, { type: "message_update", assistantMessageEvent: ev });
  feed(set, messageStart("zai", "glm-5.3"));
  update({ type: "thinking_start", contentIndex: 0 });
  update({ type: "thinking_delta", contentIndex: 0, delta: "Definitive timeline" });
  addPendingPrompt(set, "this session is weird", [], [], "c1");
  // The row below the reply doesn't hide what the reply is doing.
  assert.deepEqual(runDetail(s), { step: "thinking", text: "thinking" });
  update({ type: "thinking_delta", contentIndex: 0, delta: " for today" });
  update({ type: "toolcall_start", contentIndex: 1, id: "t1", toolName: "bash" });
  feed(set, {
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

/** The live rows in drawn order: a user row by its id (or text), an assistant entry by its blocks. */
const drawn = (s: LiveState) =>
  s.entries.map((e) => (e.kind === "user" ? `you:${e.id ?? e.text}` : `agent:${e.blocks.map((b) => (b.type === "toolCall" ? b.name : b.type)).join("+")}`));

test("steers sent before the reply's first step are drawn where they land: after that step, as the file has them", () => {
  const [s, set] = store();
  addPendingPrompt(set, "go", [], [], "c0");
  feed(set, userStart("go"));
  feed(set, { type: "agent_start" });
  // Both steers go out before the reply's first message_start (the model is still connecting).
  addPendingPrompt(set, "s1", [], [], "c1");
  addPendingPrompt(set, "s2", [], [], "c2");
  applyQueue(set, [queued("c1", "s1", { state: "sending" }), queued("c2", "s2", { state: "sending" })]);
  feed(set, messageStart("zai", "glm-5.3"));
  // The waiting rows sit below the step that is running, not above it.
  assert.deepEqual(drawn(s), ["you:c0", "agent:", "you:c1", "you:c2"]);
  feed(set, {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "plan" }, { type: "toolCall", id: "t1", name: "bash", arguments: {} }], stopReason: "toolUse" },
  });
  feed(set, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
  feed(set, { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [] } });
  assert.deepEqual(drawn(s), ["you:c0", "agent:thinking+bash", "you:c1", "you:c2"]);
  // They land together at the next step, then the agent goes on.
  deliverMidTurn(set, "c1", "s1", [queued("c2", "s2", { state: "sending" })]);
  deliverMidTurn(set, "c2", "s2");
  feed(set, messageStart("zai", "glm-5.3"));
  feed(set, { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "t2", toolName: "read" } });
  // The session file's order: prompt, first step, both steers, the steps after them.
  assert.deepEqual(drawn(s), ["you:c0", "agent:thinking+bash", "you:c1", "you:c2", "agent:read"]);
});

test("a row the agent takes ahead of an older waiting one moves above it; the waiting one stays last", () => {
  const [s, set] = store();
  feed(set, messageStart());
  addPendingPrompt(set, "follow up", [], [], "c1");
  addPendingPrompt(set, "steer me", [], [], "c2");
  applyQueue(set, [queued("c1", "follow up", { kind: "followUp" }), queued("c2", "steer me", { state: "sending" })]);
  deliverMidTurn(set, "c2", "steer me", [queued("c1", "follow up", { kind: "followUp" })]);
  assert.deepEqual(drawn(s), ["agent:", "you:c2", "you:c1"]);
  // A start that claims no row (a topic batch) lands above the waiting row too.
  const batch = formatTopicBatch({
    topic: "merge-k7m4qz",
    batch: "tb_0123456789ab",
    notes: [{ id: "qi_0123456789ab", from: { sessionId: "s1", title: "Fix login" }, at: "2026-10-01T10:00:00.000Z", text: "READY feat/x 0123456" }],
  });
  feed(set, userStart(batch));
  assert.deepEqual(drawn(s), ["agent:", "you:c2", `you:${batch}`, "you:c1"]);
});

test("only a row the server holds offers Remove: never one still Sending, before the server's answer or after the hand-off", () => {
  const [s, set] = store();
  addPendingPrompt(set, "typed", [], [], "c1");
  const row = () => s.entries.find((e) => e.kind === "user" && e.id === "c1") as Extract<LiveState["entries"][number], { kind: "user" }>;
  assert.equal(shownUserState(row()), "sending");
  assert.equal(offersRemove(row()), false, "Sending… before the server answers: no Remove, not even a disabled one");
  applyQueue(set, [queued("c1", "typed", { kind: "followUp" })]);
  assert.equal(offersRemove(row()), true, "held behind the turn: Queued, with its Remove");
  applyQueue(set, [queued("c1", "typed", { kind: "followUp", state: "sending" })]);
  assert.equal(offersRemove(row()), false, "handed to the agent: Sending… again, no Remove");
  markDelivered(set, "c1");
  assert.equal(offersRemove(row()), false);
  assert.equal(offersRemove({ state: "queued" }), false, "a row with no id can't be named to the server");
});

test("the live inputs: each message the agent took in this turn, never one still waiting nor a topic batch", () => {
  const [s, set] = store();
  addPendingPrompt(set, "go", [], [], "c0");
  assert.equal(liveInputCount(s), 0, "not on the branch until the agent takes it");
  feed(set, userStart("go"));
  feed(set, messageStart());
  addPendingPrompt(set, "s1", [], [], "c1");
  addPendingPrompt(set, "s2", [], [], "c2");
  assert.equal(liveInputCount(s), 1);
  deliverMidTurn(set, "c1", "s1", [queued("c2", "s2", { state: "sending" })]);
  deliverMidTurn(set, "c2", "s2");
  assert.equal(liveInputCount(s), 3, "both steers count the moment they land");
  const batch = formatTopicBatch({
    topic: "merge-k7m4qz",
    batch: "tb_0123456789ab",
    notes: [{ id: "qi_0123456789ab", from: { sessionId: "s1", title: "Fix login" }, at: "2026-10-01T10:00:00.000Z", text: "READY feat/x 0123456" }],
  });
  assert.ok(parseTopicBatch(batch));
  feed(set, userStart(batch));
  assert.equal(liveInputCount(s), 3, "a topic batch is a turn start, not an input");
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

// pi 0.87 appends a resize note to a user message's stored text (shared/image-note.ts); these are
// the verbatim text blocks pi 0.87.1 wrote in a hermetic session.
const NOTED = "Two images. Reply with just OK.\n\n[Image: original 2560x1600, displayed at 2000x1250. Multiply coordinates by 1.28 to map to original image.]\n[Image: original 3000x1000, displayed at 2000x667. Multiply coordinates by 1.50 to map to original image.]";
const PNG = { type: "image", data: "AAAA", mimeType: "image/png" };

test("a user message_start no row waits for shows the text without pi's image resize notes", () => {
  const [s, set] = store();
  feed(set, { type: "message_start", message: { role: "user", content: [{ type: "text", text: NOTED }, PNG, PNG] } });
  const row = s.entries[0];
  assert.equal(row?.kind, "user");
  if (row?.kind === "user") {
    assert.equal(row.text, "Two images. Reply with just OK.");
    assert.equal(row.images?.length, 2);
  }
  // Only on a message carrying the images: a typed look-alike is shown as written.
  feed(set, { type: "message_start", message: { role: "user", content: [{ type: "text", text: NOTED }] } });
  const plain = s.entries[1];
  if (plain?.kind === "user") assert.equal(plain.text, NOTED);
  else assert.fail("expected a user row");
});

test("a noted message_start claims the row whose typed text it carries, not the first open one", () => {
  const [s, set] = store();
  addPendingPrompt(set, "earlier words");
  addPendingPrompt(set, "Two images. Reply with just OK.");
  feed(set, { type: "message_start", message: { role: "user", content: [{ type: "text", text: NOTED }, PNG, PNG] } });
  assert.deepEqual(
    s.entries.map((e) => (e.kind === "user" ? [e.text, !!e.started] : e.kind)),
    [["Two images. Reply with just OK.", true], ["earlier words", false]], // the taken row above the waiting one
  );
});

test("a Stop pressed during a /compact (no turn) clears at compaction_end; inside a turn the turn's settle still owns it", () => {
  const [s, set] = store();
  feed(set, { type: "compaction_start", reason: "manual" });
  set("stopping", true);
  assert.equal(s.activity, "Compacting context");
  feed(set, { type: "compaction_end", reason: "manual", aborted: true });
  assert.equal(s.activity, null);
  assert.equal(s.stopping, false);

  // pi's automatic compaction runs inside a turn: Stop still waits for that turn's agent_settled.
  feed(set, { type: "agent_start" });
  feed(set, { type: "compaction_start", reason: "threshold" });
  set("stopping", true);
  feed(set, { type: "compaction_end", reason: "threshold", aborted: true });
  assert.equal(s.stopping, true);
  feed(set, { type: "agent_settled" });
  assert.equal(s.stopping, false);
});

test("a topic batch's start claims none of this tab's pending rows and adds its own", () => {
  const [s, set] = store();
  addPendingPrompt(set, "my own");
  const batch = formatTopicBatch({
    topic: "merge-k7m4qz",
    batch: "tb_0123456789ab",
    notes: [{ id: "qi_0123456789ab", from: { sessionId: "s1", title: "Fix login" }, at: "2026-10-01T10:00:00.000Z", text: "READY feat/x 0123456" }],
  });
  feed(set, { type: "message_start", message: { role: "user", content: [{ type: "text", text: batch }] } });
  const users = s.entries.filter((e) => e.kind === "user") as { text: string; started?: boolean }[];
  assert.equal(users.length, 2, "the batch is its own row, never a claim");
  // The batch is in the file; the pending row still waits, below it.
  assert.equal(users[1]!.text, "my own");
  assert.notEqual(users[1]!.started, true, "still waiting for its own start");
  assert.equal(users[0]!.text, batch);
  assert.equal(users[0]!.started, true);
  assert.ok(parseTopicBatch(users[0]!.text), "the live row still parses as a batch, so the thread draws the Queue card");
});

test("a link message's start draws no row and claims none of this tab's pending rows", () => {
  const [s, set] = store();
  addPendingPrompt(set, "my own");
  const link = "[link_msg lk_0123456789abcdef lm_0123456789abcdef] from Partner (box/abc)\nhello\n\nReply with link_send (to: \"abc\").";
  feed(set, { type: "message_start", message: { role: "user", content: [{ type: "text", text: link }] } });
  assert.equal(s.entries.length, 1);
  if (s.entries[0]?.kind === "user") {
    assert.equal(s.entries[0].text, "my own");
    assert.notEqual(s.entries[0].started, true, "still waiting for its own start");
  }
});

test("a baton sender marker names the live row it follows: the newest started row no marker has named", () => {
  const [s, set] = store();
  const userStart = (text: string) => ({ type: "message_start", message: { role: "user", content: text } });
  feed(set, userStart("from the operator"));
  feed(set, { type: BATON_SENT_EVENT, by: "operator" });
  feed(set, userStart("from Bob"));
  feed(set, { type: BATON_SENT_EVENT, by: "p_bob00001" });
  const users = s.entries.filter((e) => e.kind === "user") as { text: string; by?: string }[];
  assert.deepEqual(users.map((u) => [u.text, u.by]), [["from the operator", "operator"], ["from Bob", "p_bob00001"]]);
  // A marker with no live row waiting for one names nothing (the row is history already).
  feed(set, { type: BATON_SENT_EVENT, by: "p_other001" });
  assert.deepEqual((s.entries.filter((e) => e.kind === "user") as { by?: string }[]).map((u) => u.by), ["operator", "p_bob00001"]);
});

test("runDetail names the step the run-status row draws as an icon, with its words", () => {
  const [s, set] = store();
  const update = (ev: Record<string, unknown>) => feed(set, { type: "message_update", assistantMessageEvent: ev });
  assert.equal(runDetail(s), null);
  feed(set, messageStart("zai", "glm-5.3"));
  assert.equal(runDetail(s), null, "between blocks: no step");
  update({ type: "thinking_start", contentIndex: 0 });
  assert.deepEqual(runDetail(s), { step: "thinking", text: "thinking" });
  update({ type: "toolcall_start", contentIndex: 1, id: "t1", toolName: "read" });
  assert.deepEqual(runDetail(s), { step: "tool", text: "running read" });
  feed(set, { type: "tool_execution_start", toolCallId: "t9", toolName: "agent_spawn", args: {} });
  assert.deepEqual(runDetail(s), { step: "tool", text: "running agent_spawn" }, "a running tool wins over the last block");
  feed(set, { type: "tool_execution_end", toolCallId: "t9", toolName: "agent_spawn", result: { content: [] } });
  update({ type: "text_start", contentIndex: 2 });
  assert.deepEqual(runDetail(s), { step: "writing", text: "writing" });
});

test("a thinking block stops streaming once a later block starts, so only the reply's head pulses", () => {
  const [s, set] = store();
  const update = (ev: Record<string, unknown>) => feed(set, { type: "message_update", assistantMessageEvent: ev });
  const reply = () => s.entries[0] as Extract<LiveState["entries"][number], { kind: "assistant" }>;
  const streams = () => reply().blocks.map((_, i) => blockStreams(reply(), i));
  feed(set, messageStart("zai", "glm-5.3"));
  update({ type: "thinking_start", contentIndex: 0 });
  update({ type: "thinking_delta", contentIndex: 0, delta: "Let me plan" });
  assert.deepEqual(streams(), [true]);
  update({ type: "text_start", contentIndex: 1 });
  update({ type: "text_delta", contentIndex: 1, delta: "Here" });
  assert.deepEqual(streams(), [false, true], "the text streams; the thinking before it is done");
  // A later block past a hole (contentIndex skipped) still ends the thinking.
  update({ type: "thinking_start", contentIndex: 2 });
  update({ type: "toolcall_start", contentIndex: 4, id: "t1", toolName: "bash" });
  assert.equal(blockStreams(reply(), 2), false);
  assert.equal(blockStreams(reply(), 4), true, "a tool call keeps its message's streaming state");
  feed(set, { type: "message_end", message: { role: "assistant", content: [] } });
  assert.deepEqual(reply().blocks.map((_, i) => blockStreams(reply(), i)).filter(Boolean), [], "nothing streams once the message is done");
});

test("a message_end's entry id names the live row it becomes: the reply, and the prompt its start claimed, never a queued one", () => {
  const [s, set] = store();
  addPendingPrompt(set, "first", [], [], "c1");
  addPendingPrompt(set, "second", [], [], "c2");
  feed(set, { type: "message_start", message: { role: "user", content: "first" } });
  feed(set, { type: "message_end", message: { role: "user", content: "first" }, entryId: "u1" });
  feed(set, messageStart("zai", "glm-5.3"));
  feed(set, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop" }, entryId: "a1" });
  // The waiting prompt stays below the reply that ran before it was taken.
  const [first, reply, second] = s.entries;
  assert.equal(first?.kind === "user" && first.entryId, "u1");
  assert.equal(second?.kind === "user" && second.entryId, undefined, "the prompt no start has taken stays unnamed");
  assert.equal(reply?.kind === "assistant" && reply.entryId, "a1");
  // An end with no id (an older server) names nothing.
  feed(set, { type: "message_start", message: { role: "user", content: "second" } });
  feed(set, { type: "message_end", message: { role: "user", content: "second" } });
  assert.equal(s.entries[2]?.kind === "user" && s.entries[2].text === "second" && s.entries[2].entryId, undefined);
});

test("a measured reply's end carries its timing to the live row, with the time it ended; an unmeasured one carries neither", () => {
  const [s, set] = store();
  const timing = { effort: "high", ttftMs: 900, thinkingMs: 0, replyMs: 2000, output: 300 };
  feed(set, messageStart("zai", "glm-5.3"));
  feed(set, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop" }, entryId: "a1", reply: timing });
  const measured = s.entries.at(-1);
  assert.deepEqual(measured?.kind === "assistant" && measured.reply, timing);
  assert.ok(measured?.kind === "assistant" && measured.endedAt && !Number.isNaN(Date.parse(measured.endedAt)));
  feed(set, messageStart("zai", "glm-5.3"));
  feed(set, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "again" }], stopReason: "stop" }, entryId: "a2" });
  const plain = s.entries.at(-1);
  assert.equal(plain?.kind === "assistant" && (plain.reply ?? plain.endedAt), undefined);
});

test("a codemode script's own calls are no live tools; the script's updates carry its calls as details", () => {
  const [s, set] = store();
  feed(set, { type: "tool_execution_start", toolCallId: "c1", toolName: "codemode", args: { code: "return 1" } });
  feed(set, { type: "tool_execution_start", toolCallId: "c1/1", toolName: "read", parentToolCallId: "c1", args: { path: "a" } });
  const calls = { calls: [{ id: "c1/1", name: "read", args: "{\"path\":\"a\"}", status: "running" }] };
  feed(set, { type: "tool_execution_update", toolCallId: "c1", toolName: "codemode", partialResult: { content: [], details: calls } });
  feed(set, { type: "tool_execution_update", toolCallId: "c1/1", toolName: "read", parentToolCallId: "c1", partialResult: { content: [{ type: "text", text: "partial" }] } });
  feed(set, { type: "tool_execution_end", toolCallId: "c1/1", toolName: "read", parentToolCallId: "c1", result: { content: [{ type: "text", text: "x" }] }, isError: false });
  assert.deepEqual(Object.keys(s.tools), ["c1"], "the nested call never becomes a live tool");
  assert.equal(s.tools.c1?.status, "running", "and its end ends nothing of the script's");
  assert.deepEqual(JSON.parse(JSON.stringify(s.tools.c1?.details)), calls, "the script's calls so far, live");
  feed(set, { type: "tool_execution_end", toolCallId: "c1", toolName: "codemode", result: { content: [{ type: "text", text: "Script completed" }], details: { calls: [] } }, isError: false });
  assert.equal(s.tools.c1?.status, "done");
});

// A hello's `live` snapshot is wire 2 only, so these run once, on SovaEvents.
nodeTest("seedLive shows the reply so far, and the deltas after the hello continue it by index", () => {
  const [s, set] = store();
  seedLive(set, {
    message: {
      model: "zai/glm-5.3",
      parts: [
        { kind: "thinking", text: "Look at the file" },
        { kind: "text", text: "The bug is in " },
      ],
    },
  });
  applyEvent(set, { type: "part.delta", index: 1, kind: "text", delta: "parse.ts" });
  applyEvent(set, { type: "part.start", index: 2, kind: "toolCall", id: "t1", name: "read" });
  assert.equal(s.entries.length, 1, "one reply, not a second one for the deltas");
  const e = s.entries[0]!;
  assert.equal(e.kind, "assistant");
  if (e.kind !== "assistant") return;
  assert.equal(e.model, "zai/glm-5.3");
  assert.equal(e.done, false);
  assert.deepEqual({ ...e.blocks[0] }, { type: "thinking", text: "Look at the file" });
  assert.deepEqual({ ...e.blocks[1] }, { type: "text", text: "The bug is in parse.ts" }, "the text so far, then the new delta, once");
  assert.equal(e.blocks[2]?.type, "toolCall");
  assert.deepEqual(runDetail(s), { step: "tool", text: "running read" });
});

nodeTest("seedLive carries the running tools' output, and their end replaces it", () => {
  const [s, set] = store();
  seedLive(set, {
    message: { parts: [{ kind: "toolCall", id: "b1", name: "bash", args: { command: "pnpm test" } }] },
    tools: [
      { callId: "b1", name: "bash", args: { command: "pnpm test" }, output: "38 of 214", images: [] },
      { callId: "c1", name: "read", output: "inner", images: [], parentCallId: "b1" },
    ],
  });
  assert.deepEqual(Object.keys(s.tools), ["b1"], "a call another tool made has no live tool of its own");
  assert.equal(s.tools.b1?.status, "running");
  assert.equal(s.tools.b1?.output, "38 of 214");
  const e = s.entries[0];
  assert.equal(e?.kind, "assistant");
  if (e?.kind === "assistant") assert.deepEqual(JSON.parse(JSON.stringify(e.blocks[0])), { type: "toolCall", id: "b1", name: "bash", argsText: "", args: { command: "pnpm test" } });
  applyEvent(set, { type: "tool.end", callId: "b1", isError: false, output: "214 passed", images: [] });
  assert.equal(s.tools.b1?.status, "done");
  assert.equal(s.tools.b1?.output, "214 passed");
});

nodeTest("a tool call joined mid-arguments shows no argument tail, and its end brings them whole", () => {
  const [s, set] = store();
  seedLive(set, { message: { parts: [{ kind: "text", text: "Running it." }, { kind: "toolCall", id: "b1", name: "bash" }] } });
  applyEvent(set, { type: "part.delta", index: 1, kind: "toolCall", delta: 'test"}' });
  const e = s.entries[0];
  assert.equal(e?.kind, "assistant");
  if (e?.kind !== "assistant") return;
  const b = e.blocks[1];
  assert.equal(b?.type === "toolCall" && b.argsText, "", "the tail of JSON whose head the hello never had is left out");
  applyEvent(set, { type: "part.end", index: 1, kind: "toolCall", id: "b1", name: "bash", args: { command: "pnpm test" } });
  const end = e.blocks[1];
  assert.equal(end?.type, "toolCall");
  if (end?.type === "toolCall") {
    assert.deepEqual({ ...(end.args as object) }, { command: "pnpm test" });
    assert.equal(end.joined, undefined);
  }
});

nodeTest("seedLive with tools only, or nothing, draws no reply", () => {
  const [s, set] = store();
  seedLive(set, undefined);
  seedLive(set, {});
  assert.equal(s.entries.length, 0);
  seedLive(set, { tools: [{ callId: "b1", name: "bash", output: "", images: [] }] });
  assert.equal(s.entries.length, 0, "a tool between messages draws no empty reply");
  assert.equal(s.tools.b1?.status, "running");
});
