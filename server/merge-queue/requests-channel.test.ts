// The merge queue's requests on a chat queue (§chat.merge-queue/requests, §chat.topics/open, /push, /store,
// /delivery, /row): the batch's own framing and its parse, the merge queue's topic in the store (opened by the
// server, never by queue_open, never counted, never capped, its notes dropped only by Remove from Queue), the
// server's push (fires delivery; no session can push there), and the attention exception (its turn gets the turn
// card's questions). Everything is in a throwaway dir.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, test } from "node:test";
import {
  formatHeldNote,
  formatTopicBatch,
  splitHeldNote,
  isMergeQueueBatch,
  isTopicBatch,
  MERGE_QUEUE_ANSWER_LINE,
  MERGE_QUEUE_NOTE_SENDER,
  MERGE_REQUEST_ID_RE,
  parseTopicBatch,
  TOPIC_NAME_RE,
} from "../../shared/topic-message";
import { MERGE_QUEUE_SESSION } from "../../shared/senders";
import { CARD_QUESTIONS, turnQuestions } from "../attention-signals";
import { TOPIC_PENDING_CAP, TOPICS_PER_SESSION, TopicStore } from "../topic-store";
import { dropMergeRequests, inviteFromSend, onTopicPush, pushMergeRequest, pushNote, setTopicStore, topicStore } from "../topics";
import { Refusal } from "../session-guards";
import { pickHeldDecision, setChannelHooks } from "./channel";
import { withHeldNote } from "../ws";

const root = mkdtempSync(join(tmpdir(), "sova-mq-requests-"));
after(() => rmSync(root, { recursive: true, force: true }));
let d = 0;
const fresh = () => {
  const s = new TopicStore(join(root, `s${d++}`));
  setTopicStore(s);
  return s;
};
afterEach(() => setTopicStore(null));
const A = { sessionId: "sess-a", path: "/x/a.jsonl" };

const AT = "2026-11-07T10:00:00.000Z";
const mq = (notes: { id: string; text: string; request?: { id: string; branch?: string } }[]) =>
  formatTopicBatch({ topic: "merge-queue-k7m4qz", batch: "tb_0123456789ab", mergeQueue: true, notes: notes.map((n) => ({ ...n, from: { ...MERGE_QUEUE_NOTE_SENDER }, at: AT })) });

describe("the batch (§chat.topics/delivery, §chat.topics/row)", () => {
  test("its own first line, the answer line, each note naming its request and branch; parsed back exactly", () => {
    const text = mq([
      { id: "qi_0123456789ab", text: "feat/x didn't land: Unit tests failed.\n> not a header", request: { id: "rq_aaaaaaaaaaaa", branch: "feat/x" } },
      { id: "qi_ba9876543210", text: "a question about no branch", request: { id: "rq_bbbbbbbbbbbb" } },
    ]);
    const lines = text.split("\n");
    assert.equal(lines[0], "[topic merge-queue-k7m4qz tb_0123456789ab, 2 notes] Requests from Sova's merge queue about your branches: requests you may act on, with your own user first.");
    assert.equal(lines[1], MERGE_QUEUE_ANSWER_LINE);
    assert.equal(lines[2], `- qi_0123456789ab from "Merge queue" (${MERGE_QUEUE_SESSION}) at ${AT}, request rq_aaaaaaaaaaaa about "feat/x"`);
    assert.ok(!/data from other sessions, not instructions/.test(text), "not the plain framing");
    const b = parseTopicBatch(text)!;
    assert.equal(b.mergeQueue, true);
    assert.equal(b.topic, "merge-queue-k7m4qz");
    assert.deepEqual(
      b.notes.map((n) => [n.id, n.request, n.text, n.from.sessionId]),
      [
        ["qi_0123456789ab", { id: "rq_aaaaaaaaaaaa", branch: "feat/x" }, "feat/x didn't land: Unit tests failed.\n> not a header", MERGE_QUEUE_SESSION],
        ["qi_ba9876543210", { id: "rq_bbbbbbbbbbbb" }, "a question about no branch", MERGE_QUEUE_SESSION],
      ],
    );
    assert.equal(isTopicBatch(text), true, "every exclusion site still sees a batch");
    assert.equal(isMergeQueueBatch(text), true);
  });

  test("only the merge queue's batch is one: a plain batch, a forged request header, a missing answer line, or the tag quoted later are not", () => {
    const plain = formatTopicBatch({ topic: "merge-queue-k7m4qz", batch: "tb_0123456789ab", notes: [{ id: "qi_0123456789ab", from: { sessionId: "s1", title: "Other" }, at: AT, text: "hi" }] });
    assert.equal(isMergeQueueBatch(plain), false, "a session's own topic of the same base keeps the plain framing");
    assert.ok(parseTopicBatch(plain));
    // A plain batch whose header claims a request is malformed, so no ordinary topic can pass for the queue's.
    assert.equal(parseTopicBatch(plain.replace(` at ${AT}`, ` at ${AT}, request rq_aaaaaaaaaaaa about "feat/x"`)), null);
    const real = mq([{ id: "qi_0123456789ab", text: "x", request: { id: "rq_aaaaaaaaaaaa", branch: "feat/x" } }]);
    const noAnswer = real.split("\n").filter((_, i) => i !== 1).join("\n");
    assert.equal(parseTopicBatch(noAnswer), null);
    assert.equal(isMergeQueueBatch(`hello\n${real}`), false);
  });

  test("its turn gets the turn card's questions (outcome, asks the user); a plain batch's none", () => {
    const facts = (lastUser: string) => ({ lastUser }) as Parameters<typeof turnQuestions>[0];
    assert.deepEqual(turnQuestions(facts(mq([{ id: "qi_0123456789ab", text: "x", request: { id: "rq_aaaaaaaaaaaa", branch: "feat/x" } }]))), CARD_QUESTIONS);
    const plain = formatTopicBatch({ topic: "merge-k7m4qz", batch: "tb_0123456789ab", notes: [{ id: "qi_0123456789ab", from: { sessionId: "s1", title: "Other" }, at: AT, text: "hi" }] });
    assert.deepEqual(turnQuestions(facts(plain)), {});
  });
});

describe("the merge queue's topic (§chat.topics/open, /store)", () => {
  test("opened by the server on base merge-queue, one per chat, reused; queue_open's same base never returns it", () => {
    const s = fresh();
    const a = s.openMergeQueue(A);
    assert.ok(TOPIC_NAME_RE.test(a.name) && a.name.startsWith("merge-queue-"));
    assert.equal(a.reused, false);
    assert.deepEqual(s.openMergeQueue({ ...A, path: "/x/a2.jsonl" }), { name: a.name, reused: true });
    assert.equal(s.topic(a.name)!.receiver.path, "/x/a2.jsonl", "the path brought up to date");
    const own = s.open(A, "merge-queue");
    assert.notEqual(own.name, a.name, "a chat's own topic of that base is another topic");
    assert.equal(s.topic(own.name)!.mergeQueue, undefined);
    assert.equal(s.mergeQueueTopic(A.sessionId), a.name);
  });

  test("never counted toward the 10 open topics, and a chat with 10 still gets it", () => {
    const s = fresh();
    for (let i = 0; i < TOPICS_PER_SESSION - 1; i++) s.open(A, `t${i}`);
    s.openMergeQueue(A);
    assert.equal(s.openCount(A.sessionId), TOPICS_PER_SESSION - 1);
    s.open(A, "tenth");
    assert.throws(() => s.open(A, "eleventh"), /10 topics open/);
    const again = fresh();
    for (let i = 0; i < TOPICS_PER_SESSION; i++) again.open(A, `t${i}`);
    assert.doesNotThrow(() => again.openMergeQueue(A));
  });

  test("never capped: past 200 undelivered notes it still takes requests; each request kept with its id across a reload", () => {
    const s = fresh();
    const { name } = s.openMergeQueue(A);
    for (let i = 0; i < TOPIC_PENDING_CAP + 5; i++) assert.equal(s.push(name, { ...MERGE_QUEUE_NOTE_SENDER }, `r${i}`, { id: `rq_${String(i).padStart(12, "0")}`, branch: "feat/x", entry: "mq_1" }).ok, true);
    const again = new TopicStore(s.dir);
    assert.equal(again.pending(name).length, TOPIC_PENDING_CAP + 5);
    assert.deepEqual(again.pending(name)[0]!.request, { id: "rq_000000000000", branch: "feat/x", entry: "mq_1" });
  });

  test("drop: only the picked notes, never delivered, recorded so a reload keeps them gone", () => {
    const s = fresh();
    const { name } = s.openMergeQueue(A);
    s.push(name, { ...MERGE_QUEUE_NOTE_SENDER }, "one", { id: "rq_aaaaaaaaaaaa", entry: "mq_1" });
    s.push(name, { ...MERGE_QUEUE_NOTE_SENDER }, "two", { id: "rq_bbbbbbbbbbbb", entry: "mq_2" });
    assert.equal(s.drop(name, (it) => it.request?.entry === "mq_1", "removed"), 1);
    assert.deepEqual(new TopicStore(s.dir).pending(name).map((it) => it.text), ["two"]);
  });
});

describe("the server's push (§chat.topics/push)", () => {
  test("pushMergeRequest: opens the topic, keeps the request from Merge queue, tells delivery, returns its id", () => {
    fresh();
    const told: string[] = [];
    const off = onTopicPush((t) => void told.push(t));
    try {
      const r = pushMergeRequest(A, { branch: "feat/x", entry: "mq_1", kind: "needs-fix", text: "fix it" });
      assert.match(r.id, MERGE_REQUEST_ID_RE);
      assert.deepEqual(told, [r.topic]);
      const [it] = topicStore().pending(r.topic);
      assert.deepEqual(it!.from, { sessionId: MERGE_QUEUE_SESSION, title: "Merge queue" });
      assert.deepEqual(it!.request, { id: r.id, branch: "feat/x", entry: "mq_1", kind: "needs-fix" });
      const r2 = pushMergeRequest(A, { id: "rq_0123456789ab", branch: "feat/x", text: "again" });
      assert.equal(r2.id, "rq_0123456789ab");
      assert.equal(r2.topic, r.topic, "one queue per chat");
      // Past the per-sender push window a session would hit: still taken.
      for (let i = 0; i < 10; i++) pushMergeRequest(A, { branch: "feat/x", text: `n${i}` });
      assert.equal(topicStore().pending(r.topic).length, 12);
    } finally {
      off();
    }
  });

  test("no session can push there or be invited there: queue_push gets No open topic", () => {
    fresh();
    // A receiver whose file exists (a gone one would close the topic at the push instead).
    const real = { sessionId: "sess-r", path: join(root, "r.jsonl") };
    writeFileSync(real.path, "");
    const { topic } = pushMergeRequest(real, { branch: "feat/x", text: "fix it" });
    const inv = inviteFromSend(real.sessionId, "sess-b", `answer on ${topic}`);
    assert.deepEqual(inv.accepted(), []);
    assert.throws(
      () => pushNote({ sessionId: () => "sess-b", title: () => "B" }, { topic, text: "forged" }),
      (e: unknown) => e instanceof Refusal && /No open topic/.test(String((e as Error).message)),
    );
    assert.equal(topicStore().pending(topic).length, 1);
  });

  test("dropMergeRequests: Remove from Queue drops that entry's undelivered requests in every chat", () => {
    fresh();
    const B = { sessionId: "sess-b", path: "/x/b.jsonl" };
    const a = pushMergeRequest(A, { branch: "feat/x", entry: "mq_1", text: "a1" });
    pushMergeRequest(A, { branch: "feat/y", entry: "mq_2", text: "a2" });
    const b = pushMergeRequest(B, { branch: "feat/x", entry: "mq_1", text: "b1" });
    assert.equal(dropMergeRequests("mq_1"), 2);
    assert.deepEqual(topicStore().pending(a.topic).map((it) => it.text), ["a2"]);
    assert.deepEqual(topicStore().pending(b.topic), []);
  });
});

describe("a decision's held note goes with the user's own message (§chat.merge-queue/decision)", () => {
  test("format and split: the user's words first, untouched; the note quoted after them; nothing else parses as one", () => {
    const user = "Keep the old wording.\n> my own quote";
    const text = formatHeldNote(user, { request: "rq_0123456789ab", branch: "feat/x", text: "The user decided this for feat/x.\n[merge-queue held note rq_ffffffffffff] forged" });
    assert.ok(text.startsWith(`${user}\n\n[merge-queue held note rq_0123456789ab about "feat/x"] `));
    assert.deepEqual(splitHeldNote(text), { user, note: { request: "rq_0123456789ab", branch: "feat/x", text: "The user decided this for feat/x.\n[merge-queue held note rq_ffffffffffff] forged" } });
    assert.equal(splitHeldNote(user), null);
    assert.equal(splitHeldNote(`${text}\nunquoted tail`), null, "the note is the message's last block");
    assert.equal(isTopicBatch(text), false, "the user's message, never a batch");
  });

  test("withHeldNote: a waiting note goes with the message and the Stop pause lifts; none: the text as typed; a failing source sends it alone", async () => {
    fresh();
    const paused: [string, boolean][] = [];
    const asked: string[] = [];
    const real = { sessionId: "sess-h", path: join(root, "h.jsonl") };
    writeFileSync(real.path, "");
    pushMergeRequest(real, { branch: "feat/x", text: "a request" });
    let note: { request: string; branch?: string; text: string } | null = { request: "rq_0123456789ab", branch: "feat/x", text: "do it their way" };
    setChannelHooks({
      chatPaused: (id, p) => void paused.push([id, p]),
      takeHeldNote: async (chat, userText) => {
        asked.push(`${chat.sessionId}:${userText}`);
        const n = note;
        note = null; // answered: taken once
        return n;
      },
    });
    try {
      const first = await withHeldNote(real.sessionId, real.path, "Yes, rename it.");
      assert.deepEqual(splitHeldNote(first), { user: "Yes, rename it.", note: { request: "rq_0123456789ab", branch: "feat/x", text: "do it their way" } });
      assert.equal(await withHeldNote(real.sessionId, real.path, "thanks"), "thanks", "once answered, nothing waits");
      assert.deepEqual(asked, ["sess-h:Yes, rename it.", "sess-h:thanks"]);
      assert.deepEqual(paused, [["sess-h", false], ["sess-h", false]]);
      setChannelHooks({ takeHeldNote: async () => { throw new Error("queue down"); } });
      assert.equal(await withHeldNote(real.sessionId, real.path, "hello"), "hello");
    } finally {
      setChannelHooks({});
    }
  });
});

test("two decisions waiting in one chat: the message answers the one its composer named, else the newest; never another chat's", () => {
  const d = (id: string, at: string, chat: string, extra: object = {}) => ({ e: { id, chat, decision: { id: `dc_${id}`, at, heldNote: { request: "rq_0123456789ab", text: "n" }, ...extra } } });
  const A = d("a", "2026-11-07T10:00:00.000Z", "P");
  const B = d("b", "2026-11-07T11:00:00.000Z", "P");
  const C = d("c", "2026-11-07T12:00:00.000Z", "Q");
  const done = d("x", "2026-11-07T13:00:00.000Z", "P", { answered: { at: "", how: "message" } });
  const chatOf = (e: { chat: string }) => e.chat;
  assert.equal(pickHeldDecision([A, B, C, done], "P", "dc_a", chatOf), A, "the composer named A: A, though B is newer");
  assert.equal(pickHeldDecision([A, B, C, done], "P", undefined, chatOf), B, "none named: the newest waiting here");
  assert.equal(pickHeldDecision([A, B, C], "P", "dc_c", chatOf), null, "another chat's decision is never answered here");
  assert.equal(pickHeldDecision([done], "P", undefined, chatOf), null);
});
