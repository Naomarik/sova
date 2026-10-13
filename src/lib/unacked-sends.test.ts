// Run: pnpm test -- src/lib/unacked-sends.test.ts. What a pane hands back when its chat goes from under it (F14).
import assert from "node:assert/strict";
import { test } from "node:test";
import { UnackedSends } from "./unacked-sends";

test("an unacknowledged /btw comes back once when the chat reloads; an acknowledged send never does", () => {
  const u = new UnackedSends();
  const handedBack = new Set<string>();
  u.sent("c1", "/btw x");
  u.sent("c2", "say hi");
  u.settled("c2"); // its send_ack
  assert.deepEqual(u.takeAll(handedBack), ["/btw x"]);
  assert.deepEqual(u.takeAll(handedBack), [], "once");
  // A refusal that still arrives later pastes nothing a second time.
  assert.equal(u.take("c1", handedBack), null);
});

test("a refusal naming a send hands its text back once, and the reconnect then has nothing more", () => {
  const u = new UnackedSends();
  const handedBack = new Set<string>();
  u.sent("c1", "/btw y");
  assert.equal(u.take("c1", handedBack), "/btw y");
  assert.deepEqual(u.takeAll(handedBack), []);
  // Something else already handed it back (a queue departure): never twice.
  u.sent("c2", "z");
  handedBack.add("c2");
  assert.deepEqual(u.takeAll(handedBack), []);
});
