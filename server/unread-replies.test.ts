import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { isUnreadReply, UnreadReplies } from "./unread-replies";
import { readActiveBranch } from "./transcript";

const dir = mkdtempSync(join(tmpdir(), "unread-replies-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const header = () => JSON.stringify({ type: "session", id: "s", version: 3 }) + "\n";
/** One entry line chained to `parent`; `kind` picks a final reply, a tool step or a user message. */
function entry(parent: string | null, kind: "reply" | "tool" | "user", t: number): { id: string; line: string } {
  const id = `e${++n}`;
  const message =
    kind === "user"
      ? { role: "user", content: "hi", timestamp: t }
      : { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: kind === "tool" ? "toolUse" : "stop", timestamp: t };
  return { id, line: JSON.stringify({ type: "message", id, parentId: parent, timestamp: new Date(t).toISOString(), message }) + "\n" };
}
/** The count a full read of the branch gives: what the incremental one must equal. */
async function fullCount(path: string, since: number) {
  return (await readActiveBranch(path)).filter((e) => isUnreadReply(e, since)).length;
}
/** Appends `k` turns (user, tool step, reply) after `leaf`; returns the new leaf. */
function turns(path: string, leaf: string, k: number, t0: number): string {
  for (let i = 0; i < k; i++) {
    for (const kind of ["user", "tool", "reply"] as const) {
      const e = entry(leaf, kind, t0 + i * 10 + n);
      appendFileSync(path, e.line);
      leaf = e.id;
    }
  }
  return leaf;
}

test("a file that only grows is read from where it was, and counts what a full read counts", async () => {
  const path = join(dir, "grow.jsonl");
  const first = entry(null, "user", 1000);
  writeFileSync(path, header() + first.line);
  let leaf = turns(path, first.id, 5, 2000);
  const since = 2025;
  const u = new UnreadReplies();
  assert.equal(await u.count(path, since), await fullCount(path, since));
  assert.equal(u.full, 1);
  for (let round = 0; round < 4; round++) {
    leaf = turns(path, leaf, 3, 5000 + round * 100);
    assert.equal(await u.count(path, since), await fullCount(path, since), `round ${round}`);
  }
  assert.equal(u.full, 1, "every growth after the first read was incremental");
  assert.equal(await u.count(path, since), await fullCount(path, since), "an unchanged file");
  assert.equal(u.full, 1);
});

test("a line still being written waits for its end", async () => {
  const path = join(dir, "partial.jsonl");
  const first = entry(null, "user", 1000);
  writeFileSync(path, header() + first.line);
  const u = new UnreadReplies();
  assert.equal(await u.count(path, 0), 0);
  const reply = entry(first.id, "reply", 3000);
  appendFileSync(path, reply.line.slice(0, 20));
  assert.equal(await u.count(path, 0), 0);
  appendFileSync(path, reply.line.slice(20));
  assert.equal(await u.count(path, 0), 1);
  assert.equal(u.full, 1);
});

test("an entry that doesn't extend the branch (a rewind) counts the whole branch again", async () => {
  const path = join(dir, "rewind.jsonl");
  const first = entry(null, "user", 1000);
  writeFileSync(path, header() + first.line);
  turns(path, first.id, 4, 2000);
  const u = new UnreadReplies();
  assert.equal(await u.count(path, 0), 4);
  // A new branch off the first message: the four replies leave the active branch.
  const fork = entry(first.id, "reply", 9000);
  appendFileSync(path, fork.line);
  assert.equal(await u.count(path, 0), await fullCount(path, 0));
  assert.equal(await u.count(path, 0), 1);
  assert.equal(u.full, 2, "the fork was counted in full");
});

test("a line that doesn't parse, a shrunk or rewritten file, or another since counts again in full", async () => {
  const path = join(dir, "other.jsonl");
  const first = entry(null, "user", 1000);
  writeFileSync(path, header() + first.line);
  turns(path, first.id, 2, 2000);
  const u = new UnreadReplies();
  assert.equal(await u.count(path, 0), 2);
  appendFileSync(path, "{not json\n");
  assert.equal(await u.count(path, 0), await fullCount(path, 0));
  assert.equal(u.full, 2, "unparsable line");

  assert.equal(await u.count(path, 2015), await fullCount(path, 2015));
  assert.equal(u.full, 3, "another since");

  writeFileSync(path, header() + first.line);
  assert.equal(await u.count(path, 0), 0);
  assert.equal(u.full, 4, "shrunk");

  // Rewritten to a different first message, then grown past the old size: the bytes before the
  // counted end differ, so it's not taken for an append.
  const other = entry(null, "user", 1000);
  writeFileSync(path, header() + other.line.replace("hi", "hello there, a longer first message"));
  turns(path, other.id, 1, 3000);
  assert.equal(await u.count(path, 0), await fullCount(path, 0));
  assert.equal(u.full, 5, "rewritten");
});

test("no since counts nothing, and a missing file counts nothing", async () => {
  const u = new UnreadReplies();
  assert.equal(await u.count(join(dir, "gone.jsonl"), 0), 0);
  assert.equal(await u.count(join(dir, "gone.jsonl"), undefined), 0);
});
