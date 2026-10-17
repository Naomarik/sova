// Run: pnpm test -- src/lib/chat-wait.test.ts. A chat view waiting for its chat
// (§chat.transcript/instant-open): what the composer and the note say, and when what the pane sent
// goes back to the composer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONNECTING, errorHandsBack, heldWhileAsleep, NOT_CONNECTED, RECONNECTING, WAIT_START, WakeQueue, waitOnHello, waitOnOpen, waitOnSleep, waitOnStatus, waitOnWake, waitReason, type ChatWait } from "./chat-wait";
import { UnackedSends } from "./unacked-sends";

/** The first connection, open and helloed. */
const helloed = (): ChatWait => waitOnHello(waitOnOpen(WAIT_START));

test("waitReason: Send waits for this connection's hello, not just an open socket", () => {
  assert.equal(waitReason("connecting", WAIT_START), CONNECTING);
  assert.equal(waitReason("open", WAIT_START), CONNECTING, "open, the chat still starting");
  assert.equal(waitReason("open", helloed()), null);
  assert.equal(waitReason("reconnecting", helloed()), RECONNECTING);
  assert.equal(waitReason("failed", helloed()), NOT_CONNECTED);
  assert.equal(waitReason("closed", WAIT_START), NOT_CONNECTED);
});

test("the connecting and reconnecting words are the note's: quiet in the composer; only the first connect's is held back", () => {
  assert.equal(CONNECTING.quiet, true);
  assert.equal(RECONNECTING.quiet, true);
  assert.equal(CONNECTING.soft, true);
  assert.equal(RECONNECTING.soft, undefined);
  assert.equal(NOT_CONNECTED.quiet, undefined, "giving up is said in the composer, as before");
});

test("a start that fails for now: the connection ends before its hello, its own sends go back, the wait reads Reconnecting", () => {
  let w = waitOnOpen(WAIT_START);
  const ended = waitOnStatus(w, "reconnecting", true);
  assert.equal(ended.handBack, w.conn);
  w = waitOnOpen(ended.next);
  assert.equal(waitReason("open", w), RECONNECTING, "reopened, the chat not started yet");
  w = waitOnHello(w);
  assert.equal(waitReason("open", w), null);
});

test("a connection that ends after its hello hands nothing back (the chat had it), and waits again", () => {
  const ended = waitOnStatus(helloed(), "reconnecting", true);
  assert.equal(ended.handBack, null);
  assert.deepEqual(ended.next, { ready: false, lost: true, conn: 1, open: false });
});

test("an internal error before the hello hands back; after it, it is a turn's error", () => {
  assert.equal(errorHandsBack(waitOnOpen(WAIT_START)), 1);
  assert.equal(errorHandsBack(helloed()), null);
});

test("a first connect that never opened is still Connecting while it waits (nothing was lost)", () => {
  assert.deepEqual(waitOnStatus(WAIT_START, "connecting", false).next, { ready: false, lost: false, conn: 0, open: false });
  assert.equal(waitReason("connecting", waitOnStatus(WAIT_START, "connecting", false).next), CONNECTING);
});

/** What ChatView does on each step, with the composer's draft as a list of handed-back texts. */
function pane() {
  const unacked = new UnackedSends();
  const handedBack = new Set<string>();
  const draft: string[] = [];
  let w = WAIT_START;
  let n = 0;
  const handBack = (conn: number | null) => {
    if (conn !== null) draft.push(...unacked.takeFrom(conn, handedBack));
  };
  return {
    draft,
    open: () => void (w = waitOnOpen(w)),
    hello: () => void (w = waitOnHello(w)),
    send: (text: string) => unacked.sent(`c${++n}`, text, w.conn),
    error: () => handBack(errorHandsBack(w)),
    status: (s: Parameters<typeof waitOnStatus>[1]) => {
      const r = waitOnStatus(w, s, true);
      handBack(r.handBack);
      w = r.next;
    },
  };
}

test("a send made after a hello never comes back when a later connection fails before its own hello (the chat may have run it)", () => {
  const p = pane();
  p.open();
  p.hello();
  p.send("M"); // taken by the chat, but the connection drops before its ack
  p.status("reconnecting");
  p.status("connecting");
  p.open();
  p.error(); // the chat fails to start on this connection
  p.status("reconnecting");
  p.open();
  p.error(); // and again
  p.status("reconnecting");
  assert.deepEqual(p.draft, [], "M is not put back: it would be sent twice");
});

test("a send made on the connection that fails before its hello comes back, once (the 4500 open failure)", () => {
  const p = pane();
  p.open();
  p.hello();
  p.send("M");
  p.status("reconnecting");
  p.open();
  p.send("P"); // on the new connection, before its hello
  p.error();
  p.status("reconnecting");
  assert.deepEqual(p.draft, ["P"]);
});

// A chat closed while its tab is open (§chat.transcript/instant-open, §app.chat-processes/idle-stop).

test("asleep: the view closed its socket and waits for nothing; Send is usable and no note shows", () => {
  let w = waitOnSleep(helloed());
  // The view's own close of its socket: still asleep, never Reconnecting, nothing handed back.
  const closed = waitOnStatus(w, "closed", true);
  assert.equal(closed.handBack, null);
  w = closed.next;
  assert.equal(w.asleep, true);
  assert.equal(waitReason("closed", w), null, "Send usable");
  assert.equal(waitReason("connecting", w), null);
});

test("waking: Connecting (never Reconnecting) until the woken connection's hello; then ready, nothing of it asleep", () => {
  let w = waitOnStatus(waitOnSleep(helloed()), "closed", true).next;
  w = waitOnWake(w);
  w = waitOnStatus(w, "connecting", true).next;
  assert.equal(waitReason("connecting", w), CONNECTING);
  w = waitOnOpen(w);
  assert.equal(waitReason("open", w), CONNECTING);
  assert.equal(w.conn, 2, "its sends are the new connection's");
  w = waitOnHello(w);
  assert.equal(waitReason("open", w), null);
  assert.deepEqual(w, { ready: true, lost: false, conn: 2, open: true });
});

test("waking: a woken connection that drops after it opened is a reconnect, and hands back its own unacknowledged sends", () => {
  let w = waitOnOpen(waitOnWake(waitOnSleep(helloed())));
  const ended = waitOnStatus(w, "reconnecting", true);
  assert.equal(ended.handBack, w.conn);
  w = ended.next;
  assert.equal(waitReason("reconnecting", w), RECONNECTING);
});

test("WakeQueue: what the tab asked runs once, in order, at the woken chat's hello; never again at a later hello", () => {
  const q = new WakeQueue();
  const sent: string[] = [];
  q.hold(() => sent.push("set_model"));
  q.hold(() => sent.push("prompt: hi"), { id: "c1" });
  assert.equal(q.size, 2);
  assert.deepEqual(sent, [], "nothing goes before the hello");
  q.flush();
  assert.deepEqual(sent, ["set_model", "prompt: hi"]);
  q.flush(); // a reconnect's hello
  assert.deepEqual(sent, ["set_model", "prompt: hi"], "each once");
  assert.equal(q.size, 0);
});

test("WakeQueue: giving up runs nothing and names each held send once", () => {
  const q = new WakeQueue();
  let ran = 0;
  let told = 0;
  q.hold(() => ran++, { id: "c1" });
  q.hold(() => ran++, { dropped: () => told++ });
  q.hold(() => ran++, { id: "c2" });
  assert.deepEqual(q.drop(), ["c1", "c2"]);
  assert.equal(told, 1, "a waiting act is told it won't run");
  assert.deepEqual(q.drop(), []);
  q.flush();
  assert.equal(ran, 0);
});

test("heldWhileAsleep: the closed process still listed never wakes the tab; held again after it was seen gone, the tab connects", () => {
  let seen = false;
  let r = heldWhileAsleep(seen, true);
  assert.deepEqual(r, { sawGone: false, connect: false }, "the list not yet refreshed: the old process");
  r = heldWhileAsleep(r.sawGone, false);
  assert.deepEqual(r, { sawGone: true, connect: false });
  seen = r.sawGone;
  r = heldWhileAsleep(seen, true);
  assert.deepEqual(r, { sawGone: true, connect: true }, "someone else opened it");
});
