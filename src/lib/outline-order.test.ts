import assert from "node:assert/strict";
import { test } from "node:test";
import { newestTopics } from "../../shared/outline-order";

const t = (id: string, at: number) => ({ id, at });

test("newestTopics puts the most recently updated topic first, not the most recently created", () => {
  // t1 was created first but updated last: it leads.
  const topics = [t("t1", 300), t("t2", 100), t("t3", 200)];
  assert.deepEqual(newestTopics(topics).map((x) => x.id), ["t1", "t3", "t2"]);
});

test("newestTopics breaks a tie by keeping the later topic first", () => {
  // One summarizer run stamps several topics in the same millisecond.
  const topics = [t("t1", 50), t("t2", 100), t("t3", 100), t("t4", 100)];
  assert.deepEqual(newestTopics(topics).map((x) => x.id), ["t4", "t3", "t2", "t1"]);
});

test("newestTopics leaves the stored list untouched", () => {
  const topics = [t("t1", 1), t("t2", 2)];
  newestTopics(topics);
  assert.deepEqual(topics.map((x) => x.id), ["t1", "t2"]);
  assert.deepEqual(newestTopics([]), []);
});
