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
/** A fence that still draws: its first warning (parse.ts). */
const warning = (kind: string, body: string) => {
  const r = parseVis(kind, body);
  if (!r.ok) assert.fail(`expected a drawing with a warning, got line ${r.line}: ${r.message}`);
  assert.ok(r.warnings.length, `expected a warning for:\n${body}`);
  assert.deepEqual(r.spec.warnings, r.warnings, "the spec carries the same warnings");
  return r.warnings[0]!;
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

test("sequence: mark an actor by id or label, a message by its number", () => {
  const s = ok<SequenceSpec>(
    "sequence",
    `c -> s "SYN"
== TLS ==
s --> c "SYN-ACK"
note c "ok"
c -> s "ACK"
mark 2 warn "commits here"
mark s
mark "c" muted`,
  );
  assert.deepEqual(s.emphasis, [
    { key: "step:2", tone: "warn", note: "commits here", n: 1 },
    { key: "actor:s", tone: "accent" },
    { key: "actor:c", tone: "muted" },
  ]);
  assert.deepEqual(warning("sequence", 'a -> b "x"\nmark 2'), { line: 2, message: "mark: no actor or message 2, dropped" });
  assert.deepEqual(warning("sequence", 'a -> b "x"\nmark zed'), { line: 2, message: "mark: no actor or message zed, dropped" });
});

test("sequence: mark a message by its exact label; numbers still count messages only", () => {
  const body = `actor d "Store"
actor r "Repo"
d -> r "writes note"
note d "remembers"
r --> d "no: it changed"
d -> d "marks it drafted"
mark "no: it changed" error "compares the whole note"
mark 3 warn
mark 9 "past the end"`;
  const r = parseVis("sequence", body);
  assert.ok(r.ok);
  // Steps: 0 msg, 1 note, 2 msg, 3 msg. The label finds step 2; number 3 is the third message, step 3.
  assert.deepEqual(r.spec.emphasis, [
    { key: "step:2", tone: "error", note: "compares the whole note", n: 1 },
    { key: "step:3", tone: "warn" },
  ]);
  assert.deepEqual(r.warnings, [{ line: 9, message: "mark: no actor or message 9, dropped" }]);
  // An actor's label wins over a message with the same text.
  assert.deepEqual(ok<SequenceSpec>("sequence", 'actor a "Ping"\na -> b "Ping"\nmark "Ping"').emphasis, [{ key: "actor:a", tone: "accent" }]);
});
