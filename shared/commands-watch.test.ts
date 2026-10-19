// Run: pnpm test -- shared/commands-watch.test.ts
// `sova watch`'s derived events (§app.commands/watch): the pure diff of two list reads, and what it
// cannot see (a turn that starts and ends between reads), which is why the events are best effort.
import assert from "node:assert/strict";
import { test } from "node:test";
import { diffSessions, indexSessions, type WatchedSession } from "./commands-watch";

const s = (id: string, over: Partial<WatchedSession> = {}): WatchedSession => ({ id, path: `/s/${id}.jsonl`, title: id, archived: false, busy: false, ...over });
const names = (evs: { event: string; id: string }[]) => evs.map((e) => `${e.event}:${e.id}`);

test("nothing changed, nothing printed", () => {
  const list = [s("a"), s("b", { tags: { user: ["x"] } })];
  assert.deepEqual(diffSessions(indexSessions(list), list), []);
});

test("created, removed, renamed, tagged, archived and turns, each from its own field", () => {
  const before = indexSessions([s("a"), s("b"), s("c"), s("d"), s("e", { busy: true })]);
  const after = [s("a", { title: "A2" }), s("b", { tags: { user: ["t"] } }), s("c", { archived: true }), s("d", { busy: true }), s("e"), s("f")];
  const evs = diffSessions(before, after);
  assert.deepEqual(names(evs), ["renamed:a", "tagged:b", "archived:c", "turn.started:d", "turn.ended:e", "created:f"]);
  assert.deepEqual(evs[0], { event: "renamed", id: "a", path: "/s/a.jsonl", from: "a", title: "A2" });
  assert.deepEqual(evs[1]!.tags, { user: ["t"] });
  assert.equal(evs[2]!.archived, true);
  assert.deepEqual(names(diffSessions(indexSessions(after), [s("a", { title: "A2" })])), ["removed:b", "removed:c", "removed:d", "removed:e", "removed:f"]);
  assert.deepEqual(diffSessions(indexSessions([s("c", { archived: true })]), [s("c")]), [{ event: "archived", id: "c", path: "/s/c.jsonl", archived: false }]);
  // Tags cleared is a change too.
  assert.deepEqual(names(diffSessions(indexSessions([s("b", { tags: { user: ["t"] } })]), [s("b")])), ["tagged:b"]);
});

test("a session that appears mid-turn is created, then started", () => {
  assert.deepEqual(names(diffSessions(new Map(), [s("n", { busy: true })])), ["created:n", "turn.started:n"]);
});

test("best effort: a turn that starts and ends between two reads is never seen; two renames show once", () => {
  const first = indexSessions([s("a")]);
  // Read 2 happens after the turn already ended and the title changed twice.
  assert.deepEqual(diffSessions(first, [s("a", { title: "third" })]), [{ event: "renamed", id: "a", path: "/s/a.jsonl", from: "a", title: "third" }]);
});

test("indexSessions keeps only what the diff reads", () => {
  const big = { ...s("a"), extra: "ignored" } as WatchedSession;
  assert.deepEqual([...indexSessions([big]).values()], [s("a")]);
});
