// Run: pnpm test -- src/lib/chat-wait.test.ts. A chat view waiting for its chat
// (§chat.transcript/instant-open): what the composer and the note say, and when what the pane sent
// goes back to the composer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONNECTING, errorHandsBack, NOT_CONNECTED, RECONNECTING, WAIT_START, waitOnHello, waitOnOpen, waitOnStatus, waitReason, type ChatWait } from "./chat-wait";
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
