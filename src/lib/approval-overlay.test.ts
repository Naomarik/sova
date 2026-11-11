import assert from "node:assert/strict";
import { test } from "node:test";
import { acked, begin, chatQueue, EMPTY, failed, folderQueue, inOrder, noteChatFolder, pendingAny, projectQueue, queueOf, readLanded, settled } from "./approval-overlay";

test("a clicked row shows its decision until a read started after its save's answer lands", () => {
  let o = begin(EMPTY, ["a", "b"], "approved", 1);
  assert.deepEqual(Object.keys(o), ["a", "b"]);
  // Reads started before the save answered (the rebuild's broadcast, a hello) never drop it.
  o = readLanded(o, 1);
  assert.ok(pendingAny(o), "a read while the save runs leaves it");
  o = acked(o, 1, 2); // two reads had started when it answered
  assert.ok(pendingAny(readLanded(o, 2)), "a read started before the answer leaves it");
  assert.deepEqual(readLanded(o, 3), {}, "the first read after the answer carries the decision: the overlay goes");
});

test("a failed save drops only its own rows, and a newer click on the same row outlives an older save", () => {
  let o = begin(EMPTY, ["a"], "approved", 1);
  o = begin(o, ["b"], "disallowed", 2);
  o = begin(o, ["a"], "disallowed", 3); // clicked again: the newer save owns "a"
  assert.deepEqual(Object.keys(failed(o, 1)).sort(), ["a", "b"], "save 1 no longer owns a row");
  assert.deepEqual(failed(o, 2), { a: { to: "disallowed", save: 3 } });
  assert.deepEqual(Object.keys(acked(o, 1, 9)).sort(), ["a", "b"]);
  assert.equal(acked(o, 1, 9).a!.ackedAt, undefined, "an older save's answer never acks the newer click");
  assert.deepEqual(settled(o, 3), { b: { to: "disallowed", save: 2 } }, "a PUT that answers with the whole list settles at once");
  assert.equal(failed(o, 7), o, "nothing to drop: the same overlay");
});

test("a folder's saves run one at a time in click order, a failure never stalls the next, other folders never wait", async () => {
  const seen: string[] = [];
  let release!: () => void;
  const first = inOrder("p:a", () => new Promise<void>((r) => (release = () => (seen.push("1"), r()))));
  const second = inOrder("p:a", async () => {
    seen.push("2");
    throw new Error("refused");
  });
  const third = inOrder("p:a", async () => void seen.push("3"));
  await inOrder("d:/other", async () => void seen.push("other"));
  assert.deepEqual(seen, ["other"], "another folder's save went at once; this folder's second waits for its first");
  seen.length = 0;
  release();
  await first;
  await assert.rejects(second, /refused/);
  await third;
  assert.deepEqual(seen, ["1", "2", "3"]);
});

test("each surface names a folder's queue the same way", () => {
  assert.equal(queueOf({ kind: "project", id: "x" }), projectQueue("x"));
  assert.equal(queueOf({ kind: "folder", path: "/r" }), folderQueue("/r"));
  assert.notEqual(projectQueue("x"), folderQueue("x"));
});

test("a save past its time fails for its caller, yet the folder's next save waits for its real answer", async () => {
  let answer!: () => void;
  const late: boolean[] = [];
  const seen: string[] = [];
  const slow = inOrder("p:slow", () => new Promise<void>((r) => (answer = r)), { ms: 20, late: (ok) => late.push(ok) });
  const next = inOrder("p:slow", async () => void seen.push("next"), { ms: 1000 });
  await assert.rejects(slow, /didn't answer in 0 s/);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(seen, [], "the next save hasn't gone out: the first may still land");
  answer();
  await next;
  assert.deepEqual(seen, ["next"]);
  assert.deepEqual(late, [true], "the late answer is told, so its surface reads again");
});

test("a save timed out while it waited in line never goes out", async () => {
  let answer!: () => void;
  const went: string[] = [];
  const first = inOrder("p:line", () => new Promise<void>((r) => (answer = r)), { ms: 1000 });
  const queued = inOrder("p:line", async () => void went.push("queued"), { ms: 20 });
  await assert.rejects(queued, /didn't answer/);
  answer();
  await first;
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(went, []);
});

test("a chat's mid-chat lines queue on its folder's queue, read once per folder", async () => {
  let reads = 0;
  const read = async (cwd: string) => (reads++, cwd === "/p/sub" ? { folder: { projectId: "x", root: "/p" } } : { folder: { root: cwd } });
  assert.equal(await chatQueue("/s/unknown.jsonl", read), "chat:/s/unknown.jsonl", "a chat whose folder isn't said yet: its own queue");
  noteChatFolder("/s/a.jsonl", "/p/sub");
  noteChatFolder("/s/b.jsonl", "/p/sub");
  noteChatFolder("/s/c.jsonl", "/loose");
  assert.equal(await chatQueue("/s/a.jsonl", read), projectQueue("x"));
  assert.equal(await chatQueue("/s/b.jsonl", read), projectQueue("x"));
  assert.equal(await chatQueue("/s/c.jsonl", read), folderQueue("/loose"));
  assert.equal(reads, 2);
  noteChatFolder("/s/d.jsonl", "/broken");
  assert.equal(await chatQueue("/s/d.jsonl", async () => Promise.reject(new Error("no"))), "chat:/s/d.jsonl");
});
