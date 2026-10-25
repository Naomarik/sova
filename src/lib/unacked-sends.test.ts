// Run: pnpm test -- src/lib/unacked-sends.test.ts. What a pane hands back when its chat goes from under it (F14).
import assert from "node:assert/strict";
import { test } from "node:test";
import { UnackedSends } from "./unacked-sends";

const texts = (sends: { text: string }[]) => sends.map((u) => u.text);

test("an unacknowledged /btw comes back once when the chat reloads; an acknowledged send never does", () => {
  const u = new UnackedSends();
  const handedBack = new Set<string>();
  u.sent("c1", "/btw x");
  u.sent("c2", "say hi");
  u.settled("c2"); // its send_ack
  assert.deepEqual(u.takeAll(handedBack), [{ id: "c1", text: "/btw x" }]);
  assert.deepEqual(u.takeAll(handedBack), [], "once");
  // A refusal that still arrives later pastes nothing a second time.
  assert.equal(u.take("c1", handedBack), null);
});

test("a refusal naming a send hands its text back once, and the reconnect then has nothing more", () => {
  const u = new UnackedSends();
  const handedBack = new Set<string>();
  u.sent("c1", "/btw y");
  assert.deepEqual(u.take("c1", handedBack), { id: "c1", text: "/btw y" });
  assert.deepEqual(u.takeAll(handedBack), []);
  // Something else already handed it back (a queue departure): never twice.
  u.sent("c2", "z");
  handedBack.add("c2");
  assert.deepEqual(u.takeAll(handedBack), []);
});

test("takeFrom: only the sends of the connection named, oldest first, each once; the rest stay", () => {
  const u = new UnackedSends();
  const handedBack = new Set<string>();
  u.sent("a", "on the first connection", 1);
  u.sent("b", "on the second", 2);
  u.sent("c", "also on the second", 2);
  assert.deepEqual(texts(u.takeFrom(2, handedBack)), ["on the second", "also on the second"]);
  assert.deepEqual(u.takeFrom(2, handedBack), []);
  assert.deepEqual(texts(u.takeAll(handedBack)), ["on the first connection"]);
});

test("of: the sends of one connection still unanswered, by id, oldest first, kept (a closing view hands them to a courier)", () => {
  const u = new UnackedSends();
  u.sent("a", "first", 1);
  u.sent("b", "second", 2);
  u.sent("c", "third", 2);
  u.settled("c");
  assert.deepEqual([...u.of(2)], [["b", "second"]]);
  assert.deepEqual([...u.of(2)], [["b", "second"]], "kept");
  assert.deepEqual([...u.of(3)], []);
});
