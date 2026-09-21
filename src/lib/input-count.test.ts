import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptItem } from "../../shared/protocol";
import { inputCount, inputsText } from "./input-count";

const item = (id: string, kind: TranscriptItem["kind"]): TranscriptItem => ({ id, kind, raw: {} });

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
