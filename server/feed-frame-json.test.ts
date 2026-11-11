import assert from "node:assert/strict";
import { test } from "node:test";
import { feedFrameJson } from "./feed-frame-json";

test("one broadcast is serialized once; another message, or the same object after the tick, is serialized afresh", async () => {
  let reads = 0;
  const counted = {
    type: "merge_queue",
    get n() {
      reads += 1;
      return reads;
    },
  };
  const texts = [feedFrameJson(counted), feedFrameJson(counted), feedFrameJson(counted)];
  assert.equal(reads, 1, "every socket of one broadcast shares the first text");
  assert.equal(new Set(texts).size, 1);

  const msg: { type: string; view: { n: number } } = { type: "merge_queue", view: { n: 1 } };
  assert.equal(feedFrameJson(msg), '{"type":"merge_queue","view":{"n":1}}', "another message gets its own text");
  await Promise.resolve();
  msg.view.n = 2;
  assert.equal(feedFrameJson(msg), '{"type":"merge_queue","view":{"n":2}}', "the same object sent again after a change reads as changed");
});
