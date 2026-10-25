// Ids shown whole (§chat.memory/full-ids). Pure: synthetic UUIDs only.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { expandIds, uuidsIn } from "./ids";

const A = "0190f3a2-1b2c-7d4e-8f90-a1b2c3d4e5f6";
const B = "0190f3a2-9a9a-7bbb-8ccc-ddddeeee0001"; // shares A's first 8 hex digits
const C = "5c5c5c5c-2222-7333-8444-555566667777";

describe("uuidsIn", () => {
  test("distinct, lower-cased, in order", () => {
    assert.deepEqual(uuidsIn(`x ${C} y ${A.toUpperCase()} z ${C} 0190f3a2`), [C, A]);
    assert.deepEqual(uuidsIn("no ids, a hash 873aa9fece9bfa214491db5c94753347d1f6358f"), []);
  });
});

describe("expandIds", () => {
  test("an 8-hex prefix of exactly one UUID is shown whole", () => {
    assert.equal(expandIds("tool: worker 5c5c5c5c started", [A, C]), `tool: worker ${C} started`);
    assert.equal(expandIds("(5c5c5c5c), `5c5c5c5c`; 5c5c5c5c.", [C]), `(${C}), \`${C}\`; ${C}.`);
  });

  test("a prefix two UUIDs share stays short; a longer one that tells them apart is expanded", () => {
    assert.equal(expandIds("session 0190f3a2 done", [A, B]), "session 0190f3a2 done");
    assert.equal(expandIds("session 0190f3a2-1b2c done", [A, B]), `session ${A} done`);
    assert.equal(expandIds("session 0190f3a2-9a done", [A, B]), `session ${B} done`);
  });

  test("a token no UUID begins stays as written", () => {
    assert.equal(expandIds("commit 873aa9fe and 0190f3a3", [A, C]), "commit 873aa9fe and 0190f3a3");
    assert.equal(expandIds("worker 5c5c5c5c", []), "worker 5c5c5c5c");
  });

  test("whole UUIDs are untouched, even when another UUID shares their prefix", () => {
    const line = `ids ${A} and ${B.toUpperCase()} and ${C}`;
    assert.equal(expandIds(line, [A, B, C]), line);
  });

  test("half ids are expanded", () => {
    assert.equal(expandIds("sessions 5c5c5c5c-2222 and 5c5c5c5c-2222-7333-8444", [C]), `sessions ${C} and ${C}`);
  });

  test("only standalone tokens: never inside a name, a longer hex run or a non-prefix", () => {
    const line = "sova-5c5c5c5c x5c5c5c5c 5c5c5c5c_log 5c5c5c5c5c5c 5c5c5c5c-foo 5c5c5c5c-3333 5c5c5c5";
    assert.equal(expandIds(line, [C]), line);
  });

  test("deterministic: the same line and set give the same text, whatever their order", () => {
    const line = "a 5c5c5c5c b 0190f3a2-1b2c c 0190f3a2";
    const once = expandIds(line, [A, B, C]);
    assert.equal(once, `a ${C} b ${A} c 0190f3a2`);
    assert.equal(expandIds(line, [C, B, A, C]), once);
    assert.equal(expandIds(line, new Set([B, C, A])), once);
  });
});
