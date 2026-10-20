import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptItem } from "../../shared/protocol";
import { inputCount, inputsText } from "./input-count";
import { isInput, isTurnStart } from "./turn";

const item = (id: string, kind: TranscriptItem["kind"]): TranscriptItem => ({ id, kind });

test("inputCount counts the branch's user rows, and nothing else", () => {
  const items = [
    item("a", "user"),
    item("b", "assistant-text"),
    item("c", "tool-call"),
    item("d", "user"),
    item("e", "info"),
  ];
  assert.equal(inputCount(items), 2);
  assert.equal(inputCount([]), 0);
  assert.equal(inputCount([item("a", "assistant-text")]), 0);
});

test("inputCount drops with the branch: a rewind leaves fewer user rows", () => {
  const before = [item("a", "user"), item("b", "assistant-text"), item("c", "user")];
  assert.equal(inputCount(before), 2);
  assert.equal(inputCount(before.slice(0, 1)), 1); // rewound to just before "c"
});

test("the trigger's copy is plural-correct", () => {
  assert.equal(inputsText(1), "1 input");
  assert.equal(inputsText(7), "7 inputs");
});

test("inputCount leaves out a fired wake nudge: an input, but not one the user typed", () => {
  const items = [item("a", "user"), item("b", "assistant-text"), item("c", "wake"), item("d", "tool-call")];
  assert.equal(inputCount(items), 1);
  assert.equal(isInput(item("c", "wake")), true, "still an input: Undo last turn and the rewind targets read isInput");
});

test("a link message starts a turn but is never an input; a wake nudge is an input the count leaves out", () => {
  const items = [item("a", "user"), item("l", "link"), item("r", "assistant-text"), item("w", "wake")];
  assert.equal(inputCount(items), 1);
  assert.equal(isTurnStart(item("l", "link")), true);
  assert.equal(isInput(item("l", "link")), false);
});

test("inputCount leaves out what another session, the Overseer or a teammate sent, by marker, in either order", () => {
  const items: TranscriptItem[] = [
    { id: "mark-s", kind: "info", sessionMark: { kind: "sent", targetId: "s", from: { sessionId: "x", title: "X" }, hop: 1 } },
    { id: "s", kind: "user", text: '[from session "X" (x), hop 1]\nhi' },
    { id: "o", kind: "user", text: "check the build" },
    { id: "mark-o", kind: "info", overseerMark: { kind: "sent", targetId: "o" } },
    { id: "t", kind: "user", text: "from Kim" },
    { id: "mark-t", kind: "info", batonMark: { kind: "sent", targetId: "t", by: "p_kim" } },
    { id: "me", kind: "user", text: "mine, in a shared session" },
    { id: "mark-me", kind: "info", batonMark: { kind: "sent", targetId: "me", by: "operator" } },
    { id: "b", kind: "user", text: "[overseer-brief] two blockers" },
    { id: "u", kind: "user", text: "typed" },
  ];
  assert.equal(inputCount(items), 2, "only the operator's baton message and the typed one");
});

test("a header line alone never makes a message another session's: the marker decides", () => {
  assert.equal(inputCount([{ id: "u", kind: "user", text: '[from session "X" (x), hop 1]\npasted' }]), 1);
});
