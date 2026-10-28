// Tap-to-follow's pure parts (§chat.markdown/vis-flow-focus): kind words,
// and where an arrow key moves the cursor. The reactive controller is ./focus.browser.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { kindWord, step, type FocusGraph, type FocusShape } from "./focus";

const shape = (id: string, x: number, y: number, panel = 0, s: FocusShape["shape"] = "box", down = true): FocusShape => ({ id, panel, x, y, shape: s, down });

test("kind words: Question for a decision; Start, Step, Outcome by shape or arrows; Start, State, End in a state machine", () => {
  assert.equal(kindWord("decision", 1, 2, false), "Question");
  assert.equal(kindWord("decision", 1, 2, true), "Question");
  assert.equal(kindWord("round", 0, 1, false), "Start", "nothing leads in");
  assert.equal(kindWord("start", 1, 1, false), "Start");
  assert.equal(kindWord("box", 1, 0, false), "Outcome", "nothing leads out");
  assert.equal(kindWord("end", 1, 1, false), "Outcome");
  assert.equal(kindWord("box", 1, 1, false), "Step");
  assert.equal(kindWord("start", 0, 1, true), "Start");
  assert.equal(kindWord("end", 1, 0, true), "End");
  assert.equal(kindWord("round", 0, 0, true), "State", "a machine's states are States, arrows or not");
});

test("arrow keys along the ranks go to the nearest rank, closest across; across them, the same rank first", () => {
  //        a(0,0)
  // b(-100,100)   c(100,100)
  //        d(0,200)           panel 1: e(0,0) f(0,100)
  const shapes = [shape("a", 0, 0), shape("b", -100, 100), shape("c", 100, 100), shape("d", 0, 200), shape("e", 0, 0, 1), shape("f", 0, 100, 1)];
  const at = (id: string) => shapes.find((s) => s.id === id)!;
  assert.equal(step(shapes, at("a"), "down").id, "b", "the next rank, not the shape two ranks straight below; a tie goes to the first");
  assert.equal(step(shapes, at("b"), "down").id, "d");
  assert.equal(step(shapes, at("d"), "up").id, "b");
  assert.equal(step(shapes, at("b"), "right").id, "c", "across the ranks: the same rank first, though a and d are nearer");
  assert.equal(step(shapes, at("c"), "left").id, "b");
  assert.equal(step(shapes, at("a"), "left").id, "b", "nothing on its rank: the nearest that way");
  assert.equal(step(shapes, at("d"), "down").id, "e", "off the bottom of panel 0: panel 1's first");
  assert.equal(step(shapes, at("e"), "up").id, "d", "off the top of panel 1: panel 0's last in reading order");
  assert.equal(step(shapes, at("f"), "down").id, "f", "nowhere to go: it stays");
});

test("in a dir: right drawing the ranks run left to right, so right and left walk them", () => {
  // a(0,0) -> b(100,-50), c(100,50) -> d(200,0)
  const shapes = [shape("a", 0, 0, 0, "box", false), shape("b", 100, -50, 0, "box", false), shape("c", 100, 50, 0, "box", false), shape("d", 200, 0, 0, "box", false)];
  const at = (id: string) => shapes.find((s) => s.id === id)!;
  assert.equal(step(shapes, at("a"), "right").id, "b");
  assert.equal(step(shapes, at("b"), "down").id, "c", "the same rank");
  assert.equal(step(shapes, at("c"), "right").id, "d");
  assert.equal(step(shapes, at("d"), "left").id, "b");
});
