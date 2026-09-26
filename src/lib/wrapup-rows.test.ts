import assert from "node:assert/strict";
import { test } from "node:test";
import { wrapupRowIds } from "./wrapup-rows";

const row = (id: string, batonMark?: { kind: string; phase?: string }) => ({ id, batonMark });

test("only the rows between a wrap-up's start and end fold; the marks and everything else stay", () => {
  const items = [row("u1"), row("a1"), row("ws", { kind: "wrapup", phase: "start" }), row("p"), row("t"), row("tc"), row("we", { kind: "wrapup", phase: "end" }), row("after")];
  assert.deepEqual([...wrapupRowIds(items)], ["p", "t", "tc"]);
});

test("a wrap-up still running folds to the end of the list", () => {
  assert.deepEqual([...wrapupRowIds([row("a"), row("ws", { kind: "wrapup", phase: "start" }), row("p")])], ["p"]);
});

test("no wrap-up, nothing folds; other baton marks never open a fold", () => {
  assert.equal(wrapupRowIds([row("a"), row("h", { kind: "handoff" }), row("b")]).size, 0);
});

test("two wrap-ups (done, then close) fold separately", () => {
  const items = [row("ws1", { kind: "wrapup", phase: "start" }), row("x"), row("we1", { kind: "wrapup", phase: "end" }), row("mid"), row("ws2", { kind: "wrapup", phase: "start" }), row("y"), row("we2", { kind: "wrapup", phase: "end" })];
  assert.deepEqual([...wrapupRowIds(items)], ["x", "y"]);
});
