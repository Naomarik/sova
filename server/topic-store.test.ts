// Run: npx tsx --test server/topic-store.test.ts (or pnpm test). Everything is in a throwaway dir.
//
// §chat.topics/store and §chat.topics/open: names, reuse, the per-session limit, notes kept across a
// reload until acknowledged, the cap refusing instead of dropping, compaction, closing.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { TOPIC_NAME_RE } from "../shared/topic-message";
import { TOPIC_PENDING_CAP, TOPICS_PER_SESSION, topicBase, TopicStore } from "./topic-store";

const root = mkdtempSync(join(tmpdir(), "sova-topic-store-"));
after(() => rmSync(root, { recursive: true, force: true }));
let d = 0;
const fresh = () => join(root, `s${d++}`);
const A = { sessionId: "sess-a", path: "/x/a.jsonl" };
const B = { sessionId: "sess-b", path: "/x/b.jsonl" };
const from = { sessionId: "pusher", title: "Fix login" };

test("topicBase: lowercase letters, digits and single dashes, at most 16, never empty", () => {
  assert.equal(topicBase("merge"), "merge");
  assert.equal(topicBase("Merge Round!"), "merge-round");
  assert.equal(topicBase("--a__b--"), "a-b");
  assert.equal(topicBase("x".repeat(40)), "x".repeat(16));
  assert.equal(topicBase("abcdefghijklmno-pq"), "abcdefghijklmno", "a cut never leaves a trailing dash");
  assert.equal(topicBase("!!!"), "topic");
  assert.equal(topicBase(""), "topic");
});

test("open: a server-made name every push can check; the same base reuses; different sessions never share", () => {
  const s = new TopicStore(fresh());
  const a = s.open(A, "merge");
  assert.match(a.name, /^merge-[a-z0-9]{6}$/);
  assert.ok(TOPIC_NAME_RE.test(a.name));
  assert.equal(a.reused, false);
  assert.deepEqual(s.open(A, "Merge"), { name: a.name, reused: true }, "the same base, sanitised, is the same topic");
  const b = s.open(B, "merge");
  assert.notEqual(b.name, a.name);
  assert.equal(s.topic(a.name)!.receiver.sessionId, "sess-a");
  assert.equal(s.topic(b.name)!.receiver.sessionId, "sess-b");
  assert.equal(s.topic("merge"), null, "a base name is not a topic");
  // Reloaded from disk: the same open topics.
  const again = new TopicStore(s.dir);
  assert.equal(again.topic(a.name)!.receiver.path, "/x/a.jsonl");
});

test("open: a session holds at most 5 topics; a reuse is never refused", () => {
  const s = new TopicStore(fresh());
  for (let i = 0; i < TOPICS_PER_SESSION; i++) s.open(A, `t${i}`);
  assert.throws(() => s.open(A, "one-more"), /already has 5 topics open/);
  assert.equal(s.open(A, "t0").reused, true);
  assert.equal(s.open(B, "one-more").reused, false, "another session's count is its own");
});

test("open: a suffix that clashes is drawn again, so a name is never handed out twice", () => {
  const dir = fresh();
  // Two draws of the same bytes, then different ones.
  const draws = [Buffer.alloc(6, 0), Buffer.alloc(6, 0), Buffer.alloc(6, 1)];
  const s = new TopicStore(dir, Date.now, (n) => (n === 6 && draws.length ? draws.shift()! : Buffer.alloc(n, 7)));
  const first = s.open(A, "merge").name;
  const second = s.open(B, "merge").name;
  assert.equal(first, "merge-aaaaaa");
  assert.equal(second, "merge-bbbbbb");
});

test("notes: kept across a reload until acknowledged; a torn last line is skipped", () => {
  const s = new TopicStore(fresh());
  const { name } = s.open(A, "merge");
  const one = s.push(name, from, "READY feat/x 0123456");
  const two = s.push(name, from, "second");
  assert.ok(one.ok && two.ok);
  appendFileSync(join(s.dir, `${name}.jsonl`), '{"t":"item","v":1,"id":"qi_torn');
  const reread = new TopicStore(s.dir);
  assert.deepEqual(reread.pending(name).map((it) => it.text), ["READY feat/x 0123456", "second"]);
  reread.ack(name, [(one as { id: string }).id], "tb_000000000000", "sess-a");
  assert.deepEqual(new TopicStore(s.dir).pending(name).map((it) => it.text), ["second"], "an ack outlives a reload");
});

test("batch: oldest first, at most 20 notes and about 8,000 characters, always at least one", () => {
  const s = new TopicStore(fresh());
  const { name } = s.open(A, "merge");
  for (let i = 0; i < 25; i++) s.push(name, from, `n${i}`);
  assert.deepEqual(s.batch(name).map((it) => it.text), Array.from({ length: 20 }, (_, i) => `n${i}`));
  const big = new TopicStore(fresh());
  const t = big.open(A, "big").name;
  for (let i = 0; i < 3; i++) big.push(t, from, "x".repeat(3500));
  assert.equal(big.batch(t).length, 2);
  const huge = new TopicStore(fresh());
  const h = huge.open(A, "huge").name;
  huge.push(h, from, "y".repeat(9000));
  assert.equal(huge.batch(h).length, 1, "one note over the size still goes alone");
});

test("cap: at 200 undelivered notes a push is refused, nothing is dropped", () => {
  const s = new TopicStore(fresh());
  const { name } = s.open(A, "merge");
  for (let i = 0; i < TOPIC_PENDING_CAP; i++) assert.ok(s.push(name, from, `n${i}`).ok);
  const r = s.push(name, from, "one too many");
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /already holds 200 undelivered notes/);
  assert.equal(s.pending(name)[0]!.text, "n0", "the oldest is still there");
  assert.equal(s.pending(name).length, TOPIC_PENDING_CAP);
});

test("compaction: once delivered notes are most of the file, it is rewritten with only the rest", () => {
  const s = new TopicStore(fresh());
  const { name } = s.open(A, "merge");
  const ids: string[] = [];
  for (let i = 0; i < 60; i++) ids.push((s.push(name, from, `n${i}`) as { id: string }).id);
  s.ack(name, ids.slice(0, 55), "tb_000000000001", "sess-a");
  const lines = readFileSync(join(s.dir, `${name}.jsonl`), "utf8").trim().split("\n");
  assert.equal(lines.length, 5);
  assert.deepEqual(new TopicStore(s.dir).pending(name).map((it) => it.text), ["n55", "n56", "n57", "n58", "n59"]);
});

test("Stop's pause: kept with the store across a reload, lifted once, cleared when the last topic closes", () => {
  const dir = fresh();
  const file = join(root, "receiver.jsonl");
  writeFileSync(file, "{}\n");
  const s = new TopicStore(dir);
  assert.equal(s.receiverPaused(file), false);
  s.pauseReceiver(file);
  s.pauseReceiver(file); // idempotent
  assert.equal(new TopicStore(dir).receiverPaused(file), true, "a reload still holds the pause");
  const again = new TopicStore(dir);
  again.resumeReceiver(file);
  assert.equal(new TopicStore(dir).receiverPaused(file), false);
  // A path whose file is gone is pruned at load.
  s.pauseReceiver("/gone/nowhere.jsonl");
  assert.equal(new TopicStore(dir).receiverPaused("/gone/nowhere.jsonl"), false);
  // Closing the receiver's last topic drops its pause; another open topic keeps it.
  const { name } = s.open(A, "merge");
  s.pauseReceiver(A.path);
  const other = s.open(A, "standup").name;
  s.close(name);
  assert.equal(s.receiverPaused(A.path), true, "another topic of theirs is still open");
  s.close(other);
  assert.equal(new TopicStore(dir).receiverPaused(A.path), false, "no open topic: nothing left to pause");
});

test("close: the topic is gone for pushes, its notes are dropped and counted", () => {
  const s = new TopicStore(fresh());
  const { name } = s.open(A, "merge");
  s.push(name, from, "a");
  s.push(name, from, "b");
  assert.equal(s.close(name), 2);
  assert.equal(s.topic(name), null);
  assert.equal(existsSync(join(s.dir, `${name}.jsonl`)), false);
  assert.equal(new TopicStore(s.dir).topic(name), null, "closed across a reload");
  assert.notEqual(s.open(A, "merge").name, name, "a closed name is never reopened");
});
