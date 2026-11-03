// Run: pnpm test src/lib/merge-chat.test.ts
// A worker recorded as a branch's chat is named as its chat's worker and links to that chat, never by its prompt.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "../../shared/protocol";
import { chatRefOf, workerLabel } from "./merge-chat";

const s = (id: string, x: Partial<SessionSummary> = {}) => ({ id, path: `/s/${id}.jsonl`, title: id, archived: false, ...x }) as SessionSummary;
const prompt = "You are the spec writer for alignment al_5 in the worktree /home/…";

test("a main chat is itself", () => {
  assert.deepEqual(chatRefOf("A", [s("A", { title: "Build the merge queue" })]), { path: "/s/A.jsonl", title: "Build the merge queue", archived: false });
  assert.deepEqual(chatRefOf("/s/A.jsonl", [s("A")])?.path, "/s/A.jsonl", "an older record's path");
  assert.equal(chatRefOf("Z", [s("A")]), undefined);
});

test("a worker: 'Worker {name} of “{its chat's title}”', linking to that chat; its prompt never shows", () => {
  const list = [s("P", { title: "Merge queue rows" }), s("W", { title: prompt, workerSession: true, workerOf: { id: "P", path: "/s/P.jsonl", name: "spec writer" } })];
  const ref = chatRefOf("W", list)!;
  assert.deepEqual(ref, { path: "/s/P.jsonl", title: "Worker spec writer of “Merge queue rows”", archived: false });
  assert.ok(!ref.title!.includes("You are"));
});

test("a worker of a worker names the top chat; no name: 'Worker of …'; no chat known: 'A worker's chat'", () => {
  const list = [s("P", { title: "Top" }), s("W1", { workerSession: true, workerOf: { id: "P", path: "/s/P.jsonl" } }), s("W2", { title: prompt, workerSession: true, workerOf: { id: "W1", path: "/s/W1.jsonl", name: "tester" } })];
  assert.equal(chatRefOf("W2", list)?.title, "Worker tester of “Top”");
  assert.equal(chatRefOf("W1", list)?.title, "Worker of “Top”");
  const orphan = chatRefOf("O", [s("O", { title: prompt, workerSession: true })])!;
  assert.deepEqual(orphan, { path: "/s/O.jsonl", title: "A worker's chat", archived: false });
  assert.equal(workerLabel({}, null), "A worker's chat");
});
