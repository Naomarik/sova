// The merge queue's requests reach a branch's chat on a chat queue (§chat.merge-queue/requests, §chat.topics/delivery,
// §chat.topics/row), in real runtimes: runs are real SDK runs up to the model call, only the model is a stub (the test
// dir has no credentials), as in topics-runtime.test.ts. The request goes in through the merge queue's own path
// (wake.ts sendQueueWake with the real push), so what is checked is what a hand-back does: an idle chat gets one
// batch, framed as the merge queue's requests, never "You"; a busy chat gets it after its turn, never mid-turn; Stop
// holds it until the user's next message; a worker's request goes to the chat running it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, test } from "node:test";
import type { ChatServerMessage, SessionSummary } from "../shared/protocol";
import { piSession } from "./harness/pi/testing/handle";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-mq-requests-runtime-")));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { baseDelayMs: 1 } }));
const sessionsDir = join(agentDir, "sessions", "--tmp-mq-requests--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });

await import("./testing/in-process-chats");
const { acquireChat, disposeAllChats, onReceiverIdle, TOPIC_DELIVERED_ENTRY } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
const { getSessionSummary, onSessionArchived } = await import("./sessions-index");
const { normalizeEntries } = await import("./transcript");
const { readActiveBranch } = await import("./harness/pi/reader");
const { parseTopicBatch, isMergeQueueBatch, MERGE_REQUEST_ID_RE } = await import("../shared/topic-message");
const { setTopicStore, topicStore, pushMergeRequest } = await import("./topics");
const { TopicStore } = await import("./topic-store");
const { TopicDelivery, receiverSpecial } = await import("./topic-delivery");
const { acquireChatHandle, onChatEvent } = await import("./chat-handle");
const { projectOverseerOfPath } = await import("./project-overseer-store");
const { addWebSession } = await import("./web-sessions");
const { markOwned } = await import("./write-guard");
const { sendQueueWake } = await import("./merge-queue/wake");
const { MERGE_QUEUE_SENT_PREFIX } = await import("../shared/merge-queue");
const { turnQuestions, CARD_QUESTIONS } = await import("./attention-signals");
const { setChannelHooks } = await import("./merge-queue/channel");
/** What the chat queue told the merge queue (channel.ts hooks). */
const told: string[] = [];
setChannelHooks({ requestDelivered: (id, d) => void told.push(`${id}:${d}`), chatPaused: (sid, p) => void told.push(`${sid}:${p ? "paused" : "through"}`) });

after(async () => {
  await disposeAllChats();
});

let n = 0;
function makeSession(): string {
  const id = `0199cccc-0000-7000-8000-${String(++n).padStart(12, "0")}`;
  const path = canonicalPath(join(sessionsDir, `2026-11-07T00-00-${String(n).padStart(2, "0")}-000Z_${id}.jsonl`));
  const lines: unknown[] = [
    { type: "session", version: 3, id, timestamp: "2026-11-07T00:00:00.000Z", cwd },
    { type: "message", id: `u${n}`, parentId: null, timestamp: "2026-11-07T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: `task ${n}` }], timestamp: 0 } },
    {
      type: "message", id: `a${n}`, parentId: `u${n}`, timestamp: "2026-11-07T00:00:02.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "done" }], provider: "stub", model: "stub", api: "stub", stopReason: "stop", timestamp: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  markOwned(path);
  addWebSession(id);
  return path;
}
const idOfPath = (path: string) => JSON.parse(readFileSync(path, "utf8").split("\n")[0]!).id as string;
const entries = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const userTexts = (path: string) =>
  entries(path)
    .filter((e) => e.type === "message" && e.message.role === "user")
    .map((e) => (e.message.content as { text?: string }[]).map((c) => c.text ?? "").join(""));
const batchesIn = (path: string) => userTexts(path).filter((t) => parseTopicBatch(t));

type Chat = Awaited<ReturnType<typeof acquireChat>>;
const TEST_MODEL = {
  id: "stub", name: "stub", api: "stub", provider: "stub", baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000,
};
/** Per session id: model calls, in order (one may hold its reply back). Empty: plain "ok". */
const calls = new Map<string, Array<() => Promise<void> | void>>();
function fakeRuns(chat: Chat): void {
  const session = piSession(chat) as unknown as {
    _modelRuntime: { hasConfiguredAuth(p: string): boolean };
    agent: { state: { model: unknown }; getApiKey: unknown; streamFunction: unknown };
    sessionManager: { getSessionId(): string };
  };
  const sid = session.sessionManager.getSessionId();
  session._modelRuntime.hasConfiguredAuth = () => true;
  session.agent.state.model = TEST_MODEL;
  session.agent.getApiKey = async () => "stub";
  session.agent.streamFunction = async () => {
    await calls.get(sid)?.shift()?.();
    const message = {
      role: "assistant", api: "stub", provider: "stub", model: "stub", timestamp: Date.now(),
      content: [{ type: "text", text: "ok" }], stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; }, result: async () => message };
  };
}
/** Poll until `cond` holds; the guard only stops a hang. */
async function until(cond: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`still waiting after ${ms} ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const sink = () => ({ send: (_m: ChatServerMessage) => undefined });
async function turn(chat: Chat, text: string): Promise<void> {
  await new Promise<void>((done) => {
    const off = piSession(chat).subscribe((e) => {
      if (e.type !== "agent_settled") return;
      off();
      done();
    });
    chat.handle(sink(), { type: "prompt", text });
  });
}
async function held(path: string): Promise<Chat> {
  const chat = await acquireChat(path, true);
  fakeRuns(chat);
  return chat;
}
const delivery = () => {
  const log: { topic: string; outcome: string }[] = [];
  const d = new TopicDelivery(
    {
      async summary(path) {
        const s = await getSessionSummary(path);
        return s ? { archived: s.archived, live: s.live, special: receiverSpecial(s, projectOverseerOfPath(path)) } : null;
      },
      acquire: async (path) => {
        fakeRuns(await acquireChat(path, true));
        return acquireChatHandle(path, true);
      },
      onIdle: onReceiverIdle,
      onChatEvent,
      onArchived: onSessionArchived,
    },
    { debounceMs: 40, settleMs: 20, maxWaitMs: 120, onDrain: (topic, outcome) => void log.push({ topic, outcome }) },
  );
  return Object.assign(d, { log });
};
let running: ReturnType<typeof delivery> | null = null;
let storeDir = 0;
afterEach(() => {
  running?.stop();
  running = null;
});
function fresh(): void {
  setTopicStore(new TopicStore(join(agentDir, `topics-${storeDir++}`)));
  running = delivery();
  running.start();
}

/** The merge queue's own path for a hand-back: sendQueueWake with the real push, the session rows given. */
const request = (path: string, text: string, info: { branch?: string; entry?: string; kind?: string; id?: string }, rows?: Record<string, Partial<SessionSummary>>, parents: Record<string, string> = {}) =>
  sendQueueWake(
    path,
    text,
    {
      summary: async (p) => {
        const s = await getSessionSummary(p);
        return s ? ({ ...s, ...(rows?.[p] ?? {}) } as SessionSummary) : null;
      },
      parentOf: async (p) => parents[p] ?? null,
      send: async (p, t, req) => pushMergeRequest({ sessionId: req.sessionId, path: p }, { ...req, text: t }).id,
    },
    info,
  );

describe("merge queue requests in a branch's chat (§chat.merge-queue/requests)", () => {
  test("an idle chat gets exactly one batch: the merge queue's framing, its request ids, a folded row, never 'You'; its turn reads like the user's for attention", async () => {
    fresh();
    const path = makeSession();
    await held(path);
    const id1 = await request(path, `${MERGE_QUEUE_SENT_PREFIX} feat/x didn't land: Unit tests failed.`, { kind: "needs-fix", branch: "feat/x", entry: "mq_1" });
    const id2 = await request(path, `${MERGE_QUEUE_SENT_PREFIX} feat/x: the review found a gap.`, { kind: "sent-back", branch: "feat/x", entry: "mq_1", id: "rq_0123456789ab" });
    assert.match(id1, MERGE_REQUEST_ID_RE);
    assert.equal(id2, "rq_0123456789ab");
    await until(() => batchesIn(path).length === 1);
    await piSession(await acquireChat(path, true)).waitForIdle();
    await until(() => entries(path).some((e) => e.customType === TOPIC_DELIVERED_ENTRY));
    const text = batchesIn(path)[0]!;
    assert.ok(isMergeQueueBatch(text), text);
    assert.ok(!text.includes(MERGE_QUEUE_SENT_PREFIX), "the old prefix is gone from the notes");
    assert.match(text.split("\n")[1]!, /Your user's Land stands/, "a request about a queued entry: the Land stands");
    const b = parseTopicBatch(text)!;
    assert.deepEqual(b.notes.map((x) => [x.request?.id, x.request?.branch, x.text]), [
      [id1, "feat/x", "feat/x didn't land: Unit tests failed."],
      [id2, "feat/x", "feat/x: the review found a gap."],
    ]);
    assert.equal(topicStore().pending(b.topic).length, 0, "acknowledged once in the context");
    assert.ok(told.includes(`${id1}:delivered`) && told.includes(`${id2}:delivered`), `each request stamped delivered: ${told.join(", ")}`);
    const items = normalizeEntries(await readActiveBranch(path));
    assert.equal(items.filter((it) => it.kind === "topic").length, 1);
    assert.equal(items.find((it) => it.kind === "topic")!.topic!.mergeQueue, true);
    assert.ok(!items.some((it) => it.kind === "user" && parseTopicBatch(it.text)), "never a 'You' row");
    assert.deepEqual(turnQuestions({ lastUser: text } as Parameters<typeof turnQuestions>[0]), CARD_QUESTIONS);
    await until(() => !running!.log.length || running!.log.at(-1)!.outcome !== "in-flight");
    assert.equal(batchesIn(path).length, 1, "exactly one batch");
  });

  test("a request from before any Land (no entry): its batch never says the user's Land stands", async () => {
    fresh();
    const path = makeSession();
    await held(path);
    await request(path, "feat/d is finished, but its spec drafts wouldn't land with it.", { kind: "drafts", branch: "feat/d" });
    await until(() => batchesIn(path).length === 1);
    await piSession(await acquireChat(path, true)).waitForIdle();
    const text = batchesIn(path)[0]!;
    assert.ok(isMergeQueueBatch(text));
    assert.doesNotMatch(text, /Land stands|land it again/);
  });

  test("a busy chat gets it after its turn, never in it, and never in Sova's web queue", async () => {
    fresh();
    const path = makeSession();
    const chat = await held(path);
    const sid = idOfPath(path);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    calls.set(sid, [() => hold]);
    chat.handle(sink(), { type: "prompt", text: "long work" });
    await until(() => piSession(chat).isStreaming);
    await request(path, "feat/x didn't land: Unit tests failed.", { kind: "needs-fix", branch: "feat/x" });
    const topic = topicStore().mergeQueueTopic(sid)!;
    await until(() => running!.log.some((l) => l.topic === topic && l.outcome === "busy"));
    assert.equal(batchesIn(path).length, 0, "nothing went into the running turn");
    assert.equal(chat.queue.size, 0, "nothing in Sova's web queue");
    release();
    await until(() => batchesIn(path).length === 1);
    await piSession(chat).waitForIdle();
    const texts = userTexts(path);
    assert.ok(texts.indexOf("long work") < texts.findIndex((t) => isMergeQueueBatch(t)), "after the running turn");
  });

  test("Stop holds requests until the user's next message, then they arrive", async () => {
    fresh();
    const path = makeSession();
    const chat = await held(path);
    chat.handle(sink(), { type: "abort" });
    await until(() => topicStore().receiverPaused(path));
    await request(path, "feat/x didn't land: Unit tests failed.", { kind: "needs-fix", branch: "feat/x" });
    const topic = topicStore().mergeQueueTopic(idOfPath(path))!;
    await until(() => running!.log.some((l) => l.topic === topic && l.outcome === "paused"));
    assert.equal(batchesIn(path).length, 0);
    assert.equal(topicStore().pending(topic).length, 1, "kept, not dropped");
    const sid = idOfPath(path);
    assert.ok(told.includes(`${sid}:paused`), "the merge queue heard the chat is paused (its card says so)");
    await turn(chat, "carry on");
    await until(() => batchesIn(path).length === 1);
    await until(() => told.includes(`${sid}:through`));
    assert.equal(topicStore().receiverPaused(path), false);
  });

  test("a worker's request goes to the chat that runs it, naming the worker; a chat that can't take notes gets none and the caller is told", async () => {
    fresh();
    const top = makeSession();
    const worker = makeSession();
    await held(top);
    await request(worker, "feat/w didn't land: Unit tests failed.", { kind: "needs-fix", branch: "feat/w" }, { [worker]: { workerSession: {} as never, title: "Build the rows" } }, { [worker]: top });
    await until(() => batchesIn(top).length === 1);
    const b = parseTopicBatch(batchesIn(top)[0]!)!;
    assert.match(b.notes[0]!.text, /^For your worker "Build the rows"/);
    assert.equal(topicStore().mergeQueueTopic(idOfPath(worker)), null, "no queue opened on the worker");
    // A chat held open in a terminal: refused before any topic opens, so the caller keeps its fallback.
    const tui = makeSession();
    await assert.rejects(request(tui, "x", { branch: "feat/t" }, { [tui]: { live: { pid: 1, status: "idle" } as never } }), /terminal/);
    assert.equal(topicStore().mergeQueueTopic(idOfPath(tui)), null);
  });
});
