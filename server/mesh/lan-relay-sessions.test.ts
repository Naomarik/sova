import assert from "node:assert/strict";
import { test } from "node:test";
import { CLONE_FLAG_MS, RelaySessions } from "./lan-relay-sessions";

const sess = () => {
  const s = { closed: 0, close() { s.closed++; } };
  return s;
};

test("one live connection per host: a newer one closes and replaces the older", () => {
  const events: string[] = [];
  const r = new RelaySessions({ replaced: (_id, label) => events.push(`replaced ${label}`) });
  const a = sess(), b = sess(), other = sess();
  assert.deepEqual(r.admit("mac", "Laptop", a, 0), { replaced: false });
  assert.deepEqual(r.admit("pi", "Pi", other, 0), { replaced: false });
  assert.deepEqual(r.admit("mac", "Laptop", b, 10), { replaced: true });
  assert.equal(a.closed, 1);
  assert.equal(b.closed, 0);
  assert.equal(other.closed, 0);
  assert.equal(r.get("mac"), b);
  assert.deepEqual(events, ["replaced Laptop"]);
});

test("an old connection ending after its replacement doesn't drop the new one", () => {
  const r = new RelaySessions();
  const a = sess(), b = sess();
  r.admit("mac", "Laptop", a, 0);
  r.admit("mac", "Laptop", b, 1);
  r.ended("mac", a);
  assert.equal(r.get("mac"), b);
  r.ended("mac", b);
  assert.equal(r.get("mac"), null);
  assert.equal(r.status("mac", 2).connected, false);
});

test("3 replacements within 60 s flag a possible clone for 10 minutes, once", () => {
  const flagged: string[] = [];
  const r = new RelaySessions({ cloneSuspected: (_id, label) => flagged.push(label) });
  r.admit("mac", "Laptop", sess(), 0);
  r.admit("mac", "Laptop", sess(), 10_000);
  r.admit("mac", "Laptop", sess(), 20_000);
  assert.equal(r.status("mac", 20_000).cloneSuspected, false);
  r.admit("mac", "Laptop", sess(), 30_000);
  assert.equal(r.status("mac", 30_000).cloneSuspected, true);
  r.admit("mac", "Laptop", sess(), 40_000); // still flapping: no second alert, the flag runs on
  assert.deepEqual(flagged, ["Laptop"]);
  assert.equal(r.status("mac", 40_000 + CLONE_FLAG_MS - 1).cloneSuspected, true);
  assert.equal(r.status("mac", 40_000 + CLONE_FLAG_MS).cloneSuspected, false);
});

test("replacements spread wider than 60 s never flag", () => {
  const r = new RelaySessions({ cloneSuspected: () => assert.fail("flagged") });
  for (let i = 0; i < 10; i++) r.admit("mac", "Laptop", sess(), i * 31_000);
  assert.equal(r.status("mac", 400_000).cloneSuspected, false);
});

test("unpairing closes the host's connection at once; keepOnly drops the rest", () => {
  const r = new RelaySessions();
  const a = sess(), b = sess(), c = sess();
  r.admit("mac", "Laptop", a, 0);
  r.admit("pi", "Pi", b, 0);
  r.admit("vm", "VM", c, 0);
  r.drop("mac");
  assert.equal(a.closed, 1);
  assert.equal(r.get("mac"), null);
  r.keepOnly(["pi"]);
  assert.equal(b.closed, 0);
  assert.equal(c.closed, 1);
  r.closeAll();
  assert.equal(b.closed, 1);
});

test("Stop Relaying (closeAll) ends every host's connection in the same step: closed and not connected before it returns", () => {
  // The mechanism behind lan-mesh.integration.test.ts's M2 ("at once"), with no clock: nothing is
  // left for a keepalive or a timeout to end later.
  const r = new RelaySessions();
  const held = [sess(), sess(), sess()];
  held.forEach((s, i) => r.admit(`h${i}`, `H${i}`, s, 0));
  r.closeAll();
  assert.deepEqual(held.map((s) => s.closed), [1, 1, 1]);
  assert.deepEqual(held.map((_, i) => r.status(`h${i}`, 0).connected), [false, false, false]);
  assert.deepEqual(held.map((_, i) => r.get(`h${i}`)), [null, null, null]);
});

test("re-admitting the same connection is not a replacement", () => {
  const r = new RelaySessions();
  const a = sess();
  r.admit("mac", "Laptop", a, 0);
  assert.deepEqual(r.admit("mac", "Laptop", a, 1), { replaced: false });
  assert.equal(a.closed, 0);
});
