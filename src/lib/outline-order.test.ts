import assert from "node:assert/strict";
import { test } from "node:test";
import { newestTopics, topicTime } from "../../shared/outline-order";

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

test("newestTopics sorts by each topic's own section, so topics from one summarizer run come apart", () => {
  // One run wrote all three (same `at`), each claiming its own section of the conversation.
  const run = 900;
  const topics = [
    { id: "t1", at: run, sectionAt: 300 },
    { id: "t2", at: run, sectionAt: 500 },
    { id: "t3", at: run, sectionAt: 400 },
  ];
  assert.deepEqual(newestTopics(topics).map((x) => x.id), ["t2", "t3", "t1"]);
});

test("topicTime falls back to `at` when a topic has no section (older snapshots, overlay topics)", () => {
  assert.equal(topicTime({ at: 700 }), 700);
  assert.equal(topicTime({ at: 700, sectionAt: 0 }), 700);
  assert.equal(topicTime({ at: 700, sectionAt: 250 }), 250);
  // Mixed: an old topic (summary clock) and a new one (section clock) sort on one axis; a tie keeps the later topic first.
  const mixed = [{ id: "old", at: 400 }, { id: "new", at: 900, sectionAt: 400 }, { id: "newest", at: 900, sectionAt: 600 }];
  assert.deepEqual(newestTopics(mixed).map((x) => x.id), ["newest", "new", "old"]);
});
