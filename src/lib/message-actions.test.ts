import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptItem } from "../../shared/protocol";
import {
  ACTION_LABEL,
  actionReason,
  actionsFor,
  copyable,
  messageStrips,
  queueRemoveReason,
  queueGoneEffect,
  REGENERATE_CONFIRM,
  REGENERATE_LINK_REASON,
  REGENERATE_WAKE_REASON,
  SHARED_QUEUE_REASON,
  queueRemoveRefusalText,
  stripsByRow,
  type ActionState,
} from "./message-actions";

const row = (id: string, kind: TranscriptItem["kind"], text?: string, extra: Partial<TranscriptItem> = {}): TranscriptItem => ({
  id,
  kind,
  text,
  raw: {},
  ...extra,
});
const user = (id: string, text?: string, images = 0): TranscriptItem =>
  row(id, "user", text, images ? { images: Array.from({ length: images }, () => "data:image/png;base64,") } : {});
/** One block of an assistant entry, as the server renders it: `<entryId>:<n>`. */
const block = (entryId: string, n: number, text: string, kind: TranscriptItem["kind"] = "assistant-text") => row(`${entryId}:${n}`, kind, text);

const state = (over: Partial<ActionState> = {}): ActionState => ({
  chat: true,
  live: false,
  streaming: false,
  compacting: false,
  pending: false,
  paused: null,
  ...over,
});

test("a reply rendered as several blocks gets ONE strip, on its last text block", () => {
  const rows = [user("u1", "hi"), block("a1", 0, "first"), block("a1", 1, "thinking", "thinking"), block("a1", 2, "second")];
  const strips = messageStrips(rows);
  // The collision is the point: three rows of one entry must not become three strips.
  assert.equal(strips.filter((s) => s.entryId === "a1").length, 1);
  const reply = strips.find((s) => s.entryId === "a1")!;
  assert.equal(reply.index, 3); // the last assistant-text row, not the thinking row after block 0
  assert.equal(reply.role, "assistant");
  assert.equal(reply.text, "first\n\nsecond");
});

test("a strip never hangs off a tool card, even when the tool call is the entry's last block", () => {
  const rows = [block("a1", 0, "on it"), block("a1", 1, "bash", "tool-call"), row("t1", "tool-result", "output")];
  const strips = messageStrips(rows);
  assert.deepEqual(strips.map((s) => s.index), [0]);
});

test("only user messages and assistant text get a strip", () => {
  const rows = [
    user("u1", "hi"),
    row("w1", "wake", "wake nudge n1", { wake: { id: "n1", reason: "check the build" } }),
    row("i1", "info", "Model changed"),
    row("r1", "report", "subagent done"),
    row("c1", "info", "compacted"),
    row("tc", "tool-call", "bash"),
    block("a1", 0, "reply"),
  ];
  assert.deepEqual(
    messageStrips(rows).map((s) => [s.entryId, s.role]),
    [
      ["u1", "user"],
      ["a1", "assistant"],
    ],
  );
});

test("stripsByRow keys the strips by the row they follow", () => {
  const rows = [user("u1", "hi"), block("a1", 0, "one"), block("a1", 1, "two")];
  const byRow = stripsByRow(rows);
  assert.deepEqual([...byRow.keys()].sort(), [0, 2]);
  assert.equal(byRow.get(2)!.entryId, "a1");
});

test("each role gets its own branch action, never the other's", () => {
  const u = actionsFor("user", { copyable: true });
  const a = actionsFor("assistant", { copyable: true });
  assert.ok(u.includes("rewind") && !u.includes("regenerate"));
  assert.ok(a.includes("regenerate") && !a.includes("rewind"));
  // Reply forks are fourth; they never appear on a user message or replace Regenerate.
  assert.deepEqual(u, ["copy", "share", "rewind"]);
  assert.deepEqual(a, ["copy", "share", "regenerate", "fork"]);
  assert.equal(a[3], "fork");
});

test("an images-only message keeps Share and Rewind but offers no Copy", () => {
  const [strip] = messageStrips([user("u1", "", 2)]);
  assert.equal(copyable(strip!), false);
  assert.deepEqual(actionsFor(strip!.role, { copyable: copyable(strip!) }), ["share", "rewind"]);
});

test("a whitespace-only message is not copyable either", () => {
  const [strip] = messageStrips([user("u1", "   \n ")]);
  assert.equal(copyable(strip!), false);
});

test("Copy is never refused, watch mode included", () => {
  assert.equal(actionReason("copy", state({ chat: false, live: true, streaming: true })), null);
});

test("watch mode says which actions need a chat, in each action's own words", () => {
  const watching = state({ chat: false });
  assert.match(actionReason("rewind", watching)!, /Only a chat open in Sova can rewind\./);
  assert.match(actionReason("regenerate", watching)!, /Only a chat open in Sova can regenerate\./);
});

test("fork keeps a reason in unavailable views and needs no user-message replay", () => {
  assert.match(actionReason("fork", state({ chat: false }))!, /Open this session as a chat/);
  assert.match(actionReason("fork", state({ live: true }))!, /terminal/);
  assert.equal(actionReason("fork", state({ streaming: true })), "Stop the current turn first.");
  assert.equal(actionReason("fork", state({ compacting: true })), "Wait for the compaction to finish.");
  assert.match(actionReason("fork", state({ pending: true }))!, /already in progress/);
  assert.equal(actionReason("fork", state({ paused: "Connecting…" })), "Connecting…");
  assert.equal(actionReason("fork", state({ wake: true, link: true, topic: true })), null);
  assert.equal(ACTION_LABEL.fork, "Fork from here");
});

test("a terminal-owned session refuses every mutation", () => {
  assert.match(actionReason("rewind", state({ live: true }))!, /won't write to it/);
});

test("a streaming turn is never auto-aborted: it becomes the reason", () => {
  const streaming = state({ streaming: true });
  assert.equal(actionReason("rewind", streaming), "Stop the current turn first.");
  assert.equal(actionReason("regenerate", streaming), "Stop the current turn first.");
});

test("compaction and a request in flight each have their own sentence", () => {
  assert.equal(actionReason("regenerate", state({ compacting: true })), "Wait for the compaction to finish.");
  assert.equal(actionReason("regenerate", state({ pending: true })), "A regenerate is already in progress.");
  assert.equal(actionReason("rewind", state({ pending: true })), "A rewind is already in progress.");
});

test("a paused chat (archived, reconnecting, switching model) hands its own sentence through", () => {
  const paused = "Switching model…";
  assert.equal(actionReason("rewind", state({ paused })), paused);
});

test("every action has an accessible name, and no two share one", () => {
  const labels = Object.values(ACTION_LABEL);
  assert.equal(new Set(labels).size, labels.length);
  assert.ok(labels.every((l) => l.trim().length > 0));
});

test("a queued row may only be removed once the server holds it", () => {
  assert.match(queueRemoveReason({ state: "sending", pending: false, chat: true })!, /Not queued yet/);
  assert.equal(queueRemoveReason({ state: "queued", pending: false, chat: true }), null);
  assert.match(queueRemoveReason({ state: "queued", pending: true, chat: true })!, /Removing/);
  assert.match(queueRemoveReason({ state: "delivered", pending: false, chat: true })!, /Already sent/);
  assert.match(queueRemoveReason({ state: "queued", pending: false, chat: false })!, /Only a chat/);
});

test("the synthetic <id>:stop row is not part of the reply, and never of its Copy", () => {
  // A turn that errored or was aborted appends an info row sharing the entry id
  // (server/transcript.ts): "Aborted" is not something the user asked to copy.
  const rows = [block("a1", 0, "half an answer"), row("a1:stop", "info", "Aborted")];
  const strips = messageStrips(rows);
  assert.equal(strips.length, 1);
  assert.equal(strips[0]!.index, 0);
  assert.equal(strips[0]!.text, "half an answer");
});

test("with thinking hidden, the entry still gets exactly one strip, on its last SHOWN text", () => {
  // What HistoryItems renders when hideThinking is on: splitHidden has already taken the
  // thinking block out, so the rows here are the shown ones and nothing else.
  const shown = [block("a1", 0, "first"), block("a1", 2, "second")];
  const strips = messageStrips(shown);
  assert.equal(strips.length, 1);
  assert.equal(strips[0]!.index, 1);
  assert.equal(strips[0]!.text, "first\n\nsecond");
});

test("an entry with nothing shown gets no strip at all", () => {
  // hideTools on, and the entry is only tool calls: there is no bubble to hang a strip under,
  // and the hidden disclosure gets no strips (HistoryItems passes no provider down).
  assert.deepEqual(messageStrips([row("a1:0", "tool-call", "bash")]), []);
});

test("a refused removal says which kind of no it was, and never invents one", () => {
  assert.match(queueRemoveRefusalText("consumed", ""), /Already sent/);
  assert.match(queueRemoveRefusalText("unknown", ""), /isn't in the queue anymore/);
  assert.match(queueRemoveRefusalText("shared_queue", ""), /queued work of its own/);
  assert.match(queueRemoveRefusalText("internal", "Disk error."), /Disk error\./);
  assert.match(queueRemoveRefusalText("internal", ""), /^Couldn't remove it from the queue\.$/);
});

test("each way out of the queue moves the row its own way, and returns text exactly once", () => {
  assert.deepEqual(queueGoneEffect("delivered"), { row: "delivered", restore: false });
  // Delete is a DISCARD: the row goes and the text does NOT come back — not here, and not from
  // the requester's own ack either. Only Stop takes a queued message back to be re-sent.
  assert.deepEqual(queueGoneEffect("removed"), { row: "gone", restore: false });
  // Stop already hands the text back through queue_cleared.
  assert.deepEqual(queueGoneEffect("cleared"), { row: "gone", restore: false });
  // The two nothing else answers: without these the row hangs on "Sending…" forever.
  assert.deepEqual(queueGoneEffect("dropped"), { row: "gone", restore: true });
  assert.deepEqual(queueGoneEffect("failed"), { row: "gone", restore: true });
  // A reason a newer server invents is still a departure: the row never stays as a live queued
  // message we would offer to remove.
  assert.equal(queueGoneEffect("something-new").row, "gone");
});

test("a reply to a wake nudge is marked as such, and its neighbours are not", () => {
  const rows = [
    user("u1", "a message I sent"),
    block("a1", 0, "answering the user"),
    row("w1", "wake", "wake nudge n1", { wake: { id: "n1", reason: "check the build" } }),
    block("a2", 0, "answering the nudge"),
    user("u2", "another message"),
    block("a3", 0, "answering the user again"),
  ];
  const byEntry = new Map(messageStrips(rows).map((s) => [s.entryId, s]));
  assert.equal(byEntry.get("a1")!.fromWake, undefined, "before the nudge");
  assert.equal(byEntry.get("a2")!.fromWake, true, "the nudge's own reply");
  assert.equal(byEntry.get("a3")!.fromWake, undefined, "a user message starts a turn again");
});

test("Regenerate is off for a wake reply, and the reason outlives every transient state", () => {
  const idle = state({ wake: true });
  assert.equal(actionReason("regenerate", idle), REGENERATE_WAKE_REASON);
  // Waiting, stopping or reconnecting never turns a nudge into a message you sent: the permanent
  // reason wins over the ones that clear on their own.
  for (const over of [{ streaming: true }, { compacting: true }, { pending: true }, { paused: "Switching model…" }])
    assert.equal(actionReason("regenerate", state({ wake: true, ...over })), REGENERATE_WAKE_REASON);
  // And it says nothing about rewinding or copying that message.
  assert.equal(actionReason("rewind", state({ wake: true })), null);
  assert.equal(actionReason("copy", state({ wake: true })), null);
});

test("the regenerate confirm names the message that started this REPLY, not the turn", () => {
  // A mid-turn steer is a user message, so the boundary can be a steer and an untouched reply
  // before it can leave the branch. "this turn" and "this reply and everything after it" both
  // understate that.
  assert.match(REGENERATE_CONFIRM.note, /started this reply/);
  assert.doesNotMatch(REGENERATE_CONFIRM.note, /this turn/);
  assert.match(REGENERATE_CONFIRM.note, /session file keeps them/);
});

test("a shared queue is permanent: the copy offers Stop and never invites a retry", () => {
  assert.equal(queueRemoveRefusalText("shared_queue", ""), SHARED_QUEUE_REASON);
  assert.match(SHARED_QUEUE_REASON, /Press Stop/);
  assert.doesNotMatch(SHARED_QUEUE_REASON, /again in a moment|try again/i);
  // And the row's Remove stays off from then on, whatever else is true of it.
  assert.equal(queueRemoveReason({ state: "queued", pending: false, chat: true, sharedQueue: true }), SHARED_QUEUE_REASON);
  assert.equal(queueRemoveReason({ state: "queued", pending: false, chat: true }), null);
});

test("a STEER inside a wake turn makes the replies after it regenerable again", () => {
  // The server walks back to the nearest USER MESSAGE OF ANY KIND, and a mid-turn steer is one.
  // So in `wake w1 → a1 → steer s1 → a2` it refuses a1 ("wake" — the only message behind it is the
  // nudge) and ALLOWS a2, whose message is the user's own steer. If this tracked "the row that
  // began the agent run" instead, a2 would be disabled with a sentence telling the user their own
  // steer answered a scheduled wake-up: a wrong refusal AND wrong copy.
  const rows = [
    row("w1", "wake", "wake nudge n1", { wake: { id: "n1", reason: "nightly check" } }),
    block("a1", 0, "answering the nudge"),
    user("s1", "actually check main"),
    block("a2", 0, "answering the steer"),
  ];
  const byEntry = new Map(messageStrips(rows).map((s) => [s.entryId, s]));
  assert.equal(byEntry.get("a1")!.fromWake, true, "the nudge's own reply has no message of yours behind it");
  assert.equal(byEntry.get("a2")!.fromWake, undefined, "but the steer is a message you sent");
  // And that difference is what the strip shows: refused vs offered.
  assert.equal(actionReason("regenerate", state({ wake: !!byEntry.get("a1")!.fromWake })), REGENERATE_WAKE_REASON);
  assert.equal(actionReason("regenerate", state({ wake: !!byEntry.get("a2")!.fromWake })), null);
});

test("a reply to a link message is refused Regenerate; the user's next message starts a turn of theirs again", () => {
  const rows = [
    user("u1", "a message I sent"),
    row("l1", "link", "[link_msg lk_0123456789abcdef lm_0123456789abcdef] from x (h/s)\nhi"),
    block("a1", 0, "answering the partner"),
    user("u2", "another message"),
    block("a2", 0, "answering the user"),
  ];
  const strips = messageStrips(rows);
  const byEntry = new Map(strips.map((s) => [s.entryId, s]));
  assert.equal(strips.some((s) => s.entryId === "l1"), false, "no strip on the link message itself");
  assert.equal(byEntry.get("a1")!.fromLink, true);
  assert.equal(byEntry.get("a1")!.fromWake, undefined);
  assert.equal(byEntry.get("a2")!.fromLink, undefined);
  assert.equal(actionReason("regenerate", state({ link: true, streaming: true })), REGENERATE_LINK_REASON);
  assert.equal(actionReason("regenerate", state({ link: false })), null);
});

test("Share from here only opens the share page, so nothing refuses it, a watch or a live terminal included", () => {
  const busy = { chat: false, live: true, streaming: true, compacting: true, pending: true, paused: "Archived." };
  assert.equal(actionReason("share", busy), null);
  assert.equal(ACTION_LABEL.share, "Share from here");
});
