// Run: pnpm test -- src/lib/chat-wait.test.ts. A chat view waiting for its chat
// (§chat.transcript/instant-open): what the composer and the note say, and when what the pane sent
// goes back to the composer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONNECTING, errorHandsBack, NOT_CONNECTED, RECONNECTING, WAIT_START, waitOnHello, waitOnStatus, waitReason } from "./chat-wait";

test("waitReason: Send waits for this connection's hello, not just an open socket", () => {
  assert.equal(waitReason("connecting", WAIT_START), CONNECTING);
  assert.equal(waitReason("open", WAIT_START), CONNECTING, "open, the chat still starting");
  assert.equal(waitReason("open", waitOnHello()), null);
  assert.equal(waitReason("reconnecting", waitOnHello()), RECONNECTING);
  assert.equal(waitReason("failed", waitOnHello()), NOT_CONNECTED);
  assert.equal(waitReason("closed", WAIT_START), NOT_CONNECTED);
});

test("the connecting and reconnecting words are the note's: quiet in the composer; only the first connect's is held back", () => {
  assert.equal(CONNECTING.quiet, true);
  assert.equal(RECONNECTING.quiet, true);
  assert.equal(CONNECTING.soft, true);
  assert.equal(RECONNECTING.soft, undefined);
  assert.equal(NOT_CONNECTED.quiet, undefined, "giving up is said in the composer, as before");
});

test("a start that fails for now: the connection ends before its hello, what was sent goes back, the wait reads Reconnecting", () => {
  let w = WAIT_START;
  ({ next: w } = waitOnStatus(w, "open", true));
  const ended = waitOnStatus(w, "reconnecting", true);
  assert.equal(ended.handBack, true);
  w = ended.next;
  assert.equal(waitReason("open", w), RECONNECTING, "reopened, the chat not started yet");
  w = waitOnHello();
  assert.equal(waitReason("open", w), null);
});

test("a connection that ends after its hello hands nothing back (the chat had it), and waits again", () => {
  const ended = waitOnStatus(waitOnHello(), "reconnecting", true);
  assert.equal(ended.handBack, false);
  assert.deepEqual(ended.next, { ready: false, lost: true });
});

test("an internal error before the hello hands back; after it, it is a turn's error", () => {
  assert.equal(errorHandsBack(WAIT_START), true);
  assert.equal(errorHandsBack(waitOnHello()), false);
});

test("a first connect that never opened is still Connecting while it waits (nothing was lost)", () => {
  assert.deepEqual(waitOnStatus(WAIT_START, "connecting", false).next, { ready: false, lost: false });
  assert.equal(waitReason("connecting", waitOnStatus(WAIT_START, "connecting", false).next), CONNECTING);
});
