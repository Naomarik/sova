import assert from "node:assert/strict";
import { test } from "node:test";
import { SHOWN_KINDS, WORK_LABEL } from "./assistant-model-rows";

test("the Owner card shows a model row for every kind, the gathering one as feature request chats", () => {
  assert.deepEqual(SHOWN_KINDS, ["reply", "coding", "gathering"]);
  assert.deepEqual(new Set(SHOWN_KINDS), new Set(Object.keys(WORK_LABEL)));
  assert.deepEqual(SHOWN_KINDS.map((k) => WORK_LABEL[k]), ["Its replies", "Fixes it starts", "Feature request chats it starts"]);
  assert.equal(new Set(Object.values(WORK_LABEL)).size, 3);
});
