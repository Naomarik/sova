import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVis } from "../../parse";
import type { SequenceSpec } from "./parse";

const ok = <T>(kind: string, body: string): T => {
  const r = parseVis(kind, body);
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}`);
  return r.spec as T;
};
const err = (kind: string, body: string) => {
  const r = parseVis(kind, body);
  assert.equal(r.ok, false, `expected an error for:\n${body}`);
  return r as { ok: false; line: number; message: string };
};

test("sequence: actors in order of first use, messages, notes, dividers", () => {
  const s = ok<SequenceSpec>(
    "sequence",
    `actor c "Client"
participant s "Server" accent
c -> s "SYN"
s --> c "SYN-ACK"
== TLS ==
note c s "keys derived"
c -> c "verify cert"`,
  );
  assert.deepEqual(s.actors, [{ id: "c", label: "Client" }, { id: "s", label: "Server", tone: "accent" }]);
  assert.deepEqual(s.steps[1], { type: "msg", from: "s", to: "c", label: "SYN-ACK", dashed: true });
  assert.deepEqual(s.steps[2], { type: "divider", label: "TLS" });
  assert.deepEqual(s.steps[3], { type: "note", over: ["c", "s"], text: "keys derived" });
  assert.match(err("sequence", "a -> b\na <-> b").message, /a -> b or a --> b/);
  assert.match(err("sequence", "a -> a").message, /at least 2 actors/);
});
