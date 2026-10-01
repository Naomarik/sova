// Run: npx tsx --test server/topics-runtime.test.ts (or pnpm test). Uses a throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
//
// Topic queues in real runtimes (§chat.topics/open, /push, /delivery, /row): runs are real SDK runs
// up to the model call, and only the model is a stub (the test dir has no credentials), as in
// session-profiles-runtime.test.ts. The model's tool calls are real tool calls, so the sender and
// the receiver come from the runtimes themselves.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, test } from "node:test";
import type { ChatServerMessage } from "../shared/protocol";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-topics-runtime-")));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { baseDelayMs: 1 } }));
const sessionsDir = join(agentDir, "sessions", "--tmp-topics--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });

const { acquireChat, disposeAllChats, disposeHeldChat, onReceiverIdle, resolveRegenerate, TOPIC_DELIVERED_ENTRY } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
const { archiveSession, getSessionSummary, onSessionArchived } = await import("./sessions-index");
const { normalizeEntries, readActiveBranch } = await import("./transcript");
const { parseProfile, PROFILE_ENTRY } = await import("../shared/profiles");
const { parseTopicBatch, formatTopicBatch } = await import("../shared/topic-message");
const { setTopicStore, topicStore, QUEUE_PUSH_DESCRIPTION, pushNote } = await import("./topics");
const { TopicStore, TOPIC_PENDING_CAP } = await import("./topic-store");
const { TopicDelivery, receiverSpecial } = await import("./topic-delivery");
const { projectOverseerOfPath } = await import("./project-overseer-store");
const { addWebSession } = await import("./web-sessions");
const { markOwned } = await import("./write-guard");
const { writeModelPolicy, EMPTY_POLICY } = await import("./model-policy");
const { sessionLimitsFile } = await import("./session-powers");
// Wires the session-powers host (setPowersHost), so session_send runs as on the server.
await import("./session-profile-routes");

after(async () => {
  await disposeAllChats();
});

/** A captain: messages other sessions (so it has queue_open), not One at a time here. */
const CAPTAIN = { ...(parseProfile({ id: "cap", label: "Captain", icon: "branch", remove: [], grant: ["sessions.read", "sessions.message", "sessions.all"], singleton: false, overseerMayStart: false }) as object), source: "user" };
const READER = { ...(parseProfile({ id: "rd", label: "Reader", icon: "eye", remove: [], grant: ["sessions.read"], singleton: false, overseerMayStart: false }) as object), source: "user" };

let n = 0;
function makeSession(p?: unknown): string {
  const id = `0199bbbb-0000-7000-8000-${String(++n).padStart(12, "0")}`;
  const path = canonicalPath(join(sessionsDir, `2026-10-01T00-00-${String(n).padStart(2, "0")}-000Z_${id}.jsonl`));
  const lines: unknown[] = [{ type: "session", version: 3, id, timestamp: "2026-10-01T00:00:00.000Z", cwd }];
  if (p !== undefined) lines.push({ type: "custom", id: `p${n}`, parentId: null, timestamp: "2026-10-01T00:00:00.100Z", customType: PROFILE_ENTRY, data: { v: 1, profile: p } });
  const parent = p !== undefined ? `p${n}` : null;
  lines.push({ type: "message", id: `u${n}`, parentId: parent, timestamp: "2026-10-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: `task ${n}` }], timestamp: 0 } });
  lines.push({
    type: "message", id: `a${n}`, parentId: `u${n}`, timestamp: "2026-10-01T00:00:02.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "done" }], provider: "stub", model: "stub", api: "stub", stopReason: "stop", timestamp: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
  });
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
const toolResults = (path: string, name: string) =>
  entries(path)
    .filter((e) => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === name)
    .map((e) => ({ text: (e.message.content as { text?: string }[]).map((c) => c.text ?? "").join(""), isError: e.message.isError === true }));

type Chat = Awaited<ReturnType<typeof acquireChat>>;
const TEST_MODEL = {
  id: "stub", name: "stub", api: "stub", provider: "stub", baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000,
};
type StubReply = { toolCall: { name: string; arguments: Record<string, unknown> } } | void;
/** Per session id: its model calls, in order (a hook may hold the reply back). Empty: plain "ok". */
const calls = new Map<string, Array<() => Promise<StubReply> | StubReply>>();
function fakeRuns(chat: Chat): void {
  const session = chat.session as unknown as {
    _modelRuntime: { hasConfiguredAuth(p: string): boolean };
    agent: { state: { model: unknown }; getApiKey: unknown; streamFunction: unknown };
    sessionManager: { getSessionId(): string };
  };
  const sid = session.sessionManager.getSessionId();
  session._modelRuntime.hasConfiguredAuth = () => true;
  session.agent.state.model = TEST_MODEL;
  session.agent.getApiKey = async () => "stub";
  session.agent.streamFunction = async () => {
    const reply = (await calls.get(sid)?.shift()?.()) ?? undefined;
    const call = reply?.toolCall;
    const message = {
      role: "assistant", api: "stub", provider: "stub", model: "stub", timestamp: Date.now(),
      content: call ? [{ type: "toolCall", id: `tc-${Date.now()}-${Math.random()}`, name: call.name, arguments: call.arguments }] : [{ type: "text", text: "ok" }],
      stopReason: call ? "toolUse" : "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: call ? "toolUse" : "stop", message }; }, result: async () => message };
  };
}
async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sink = () => {
  const got: ChatServerMessage[] = [];
  return { got, client: { send: (m: ChatServerMessage) => void got.push(m) } };
};
const push = (topic: string, text: string) => ({ toolCall: { name: "queue_push", arguments: { topic, text } } });
const open = (name: string) => ({ toolCall: { name: "queue_open", arguments: { name } } });

/** Run one user turn in `chat` with these model replies, and wait for it to finish. */
async function turn(chat: Chat, path: string, replies: Array<() => Promise<StubReply> | StubReply>, text = "go"): Promise<void> {
  calls.set(idOfPath(path), [...replies, () => undefined]);
  const { client } = sink();
  await new Promise<void>((done) => {
    const off = chat.session.subscribe((e) => {
      if (e.type !== "agent_settled") return;
      off();
      done();
    });
    chat.handle(client, { type: "prompt", text });
  });
}
async function held(path: string): Promise<Chat> {
  const chat = await acquireChat(path, true);
  fakeRuns(chat);
  return chat;
}
/** The delivery the server runs, bound to these runtimes, with short waits. */
const delivery = () =>
  new TopicDelivery(
    {
      async summary(path) {
        // The same gate server/index.ts gives startTopicDelivery: same function, same arguments.
        const s = await getSessionSummary(path);
        return s ? { archived: s.archived, live: s.live, special: receiverSpecial(s, projectOverseerOfPath(path)) } : null;
      },
      acquire: async (path) => {
        const chat = await acquireChat(path, true);
        fakeRuns(chat);
        return chat;
      },
      onIdle: onReceiverIdle,
      onArchived: onSessionArchived,
    },
    { debounceMs: 40, settleMs: 20, maxWaitMs: 120 },
  );
let running: InstanceType<typeof TopicDelivery> | null = null;
let storeDir = 0;
function freshStore(): void {
  setTopicStore(new TopicStore(join(agentDir, `topics-${storeDir++}`)));
}
afterEach(() => {
  running?.stop();
  running = null;
});

/** A captain with an open topic, and an ordinary owner session. */
async function pair() {
  freshStore();
  const capPath = makeSession(CAPTAIN);
  const ownPath = makeSession();
  const cap = await held(capPath);
  const own = await held(ownPath);
  await turn(cap, capPath, [() => open("merge")], "start the round");
  const opened = toolResults(capPath, "queue_open")[0]!;
  const name = /"(merge-[a-z0-9]{6})"/.exec(opened.text)![1]!;
  return { capPath, ownPath, cap, own, name, cid: idOfPath(capPath), oid: idOfPath(ownPath) };
}

describe("the tools (§chat.topics/open, §chat.topics/push)", () => {
  test("queue_push is in every ordinary session and in a captain; queue_open only where session_send is", async () => {
    freshStore();
    const plain = await held(makeSession());
    const reader = await held(makeSession(READER));
    const cap = await held(makeSession(CAPTAIN));
    for (const c of [plain, reader, cap]) assert.ok(c.session.getActiveToolNames().includes("queue_push"));
    assert.ok(!plain.session.getActiveToolNames().includes("queue_open"));
    assert.ok(!reader.session.getActiveToolNames().includes("queue_open"), "reading does not open topics");
    assert.ok(cap.session.getActiveToolNames().includes("queue_open"));
    const tool = plain.session.getAllTools().find((t) => t.name === "queue_push")!;
    assert.equal(tool.description, QUEUE_PUSH_DESCRIPTION);
    assert.equal(QUEUE_PUSH_DESCRIPTION, "Push a short note to a topic. Use only when told which topic; never guess one.");
  });

  test("queue_open: a server-made name, the same one again for the same base", async () => {
    const { capPath, cap, name, cid } = await pair();
    await turn(cap, capPath, [() => open("Merge")]);
    const [first, second] = toolResults(capPath, "queue_open");
    assert.match(first!.text, new RegExp(`^Opened "${name}"\\.`));
    assert.match(second!.text, new RegExp(`^Your topic "${name}" is still open\\.`));
    assert.equal(topicStore().topic(name)!.receiver.sessionId, cid);
  });

  test("queue_push: queued with the runtime's own identity; every refusal is one sentence and takes nothing", async () => {
    const { ownPath, own, capPath, cap, name, oid } = await pair();
    await turn(own, ownPath, [
      () => push(name, "READY feat/x 0123456"),
      () => ({ toolCall: { name: "queue_push", arguments: { topic: "merge", text: "guessed" } } }),
      () => push("merge-zzzzzz", "guessed suffix"),
      () => push(name, "   "),
      () => push(name, "x".repeat(4001)),
    ], "answer the captain");
    const r = toolResults(ownPath, "queue_push");
    assert.deepEqual(r.map((x) => x.text), [
      `Queued on "${name}".`,
      'No open topic "merge".',
      'No open topic "merge-zzzzzz".',
      "text must not be blank.",
      "Too long: at most 4000 characters.",
    ]);
    assert.deepEqual(r.map((x) => x.isError), [false, true, true, true, true]);
    const pending = topicStore().pending(name);
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0]!.from, { sessionId: oid, title: "task " + (n) });
    // The receiver can't push to its own topic.
    await turn(cap, capPath, [() => push(name, "note to self")]);
    assert.match(toolResults(capPath, "queue_push")[0]!.text, /receiver; a topic is for other sessions/);
    // The audit has a line per push, never the text.
    const audit = readFileSync(join(topicStore().dir, "audit.jsonl"), "utf8");
    assert.ok(!audit.includes("READY feat/x"), "the text is never logged");
    assert.equal(audit.trim().split("\n").filter((l) => JSON.parse(l).tool === "queue_push").length, 6);
  });

  test("queue_push: the sixth push in 10 minutes and a full topic are refused", async () => {
    const { ownPath, own, name } = await pair();
    await turn(own, ownPath, Array.from({ length: 6 }, (_, i) => () => push(name, `n${i}`)));
    const r = toolResults(ownPath, "queue_push");
    assert.equal(r.filter((x) => !x.isError).length, 5);
    assert.equal(r[5]!.text, "Limit: at most 5 pushes to one topic in 10 minutes.");
    // Fill to the cap from elsewhere; a push past it is refused and the oldest stays.
    const s = topicStore();
    while (s.pending(name).length < TOPIC_PENDING_CAP) s.push(name, { sessionId: "elsewhere", title: "x" }, "fill");
    const other = makeSession();
    const oc = await held(other);
    await turn(oc, other, [() => push(name, "past the cap")]);
    assert.match(toolResults(other, "queue_push")[0]!.text, /already holds 200 undelivered notes/);
    assert.equal(s.pending(name)[0]!.text, "n0");
  });
});

describe("delivery (§chat.topics/delivery, §chat.topics/row)", () => {
  test("receiverSpecial, the summary gate index.ts uses: an org's ordinary sessions are deliverable, its special ones and workers are not", () => {
    const org = (kind: string) => ({ orgId: "o1", orgName: "Org", kind }) as never;
    // Over every org kind: organizations mark where the sidebar lists a session; on their own they
    // never make a receiver special (the gate before the fix refused every one of these).
    for (const kind of ["coding", "other", "gathering", "offer", "overseer"]) assert.equal(receiverSpecial({ org: org(kind) }, null), false, `org kind ${kind}`);
    assert.equal(receiverSpecial({}, null), false);
    // What the chat runtime opens as special (SpecialKind), a worker, and a project overseer's file:
    assert.equal(receiverSpecial({ overseer: true }, null), true);
    assert.equal(receiverSpecial({ baton: {} as never }, null), true);
    assert.equal(receiverSpecial({ workerSession: {} as never }, null), true);
    assert.equal(receiverSpecial({ org: org("overseer") }, { orgId: "o1", projectId: "p1" }), true);
  });

  test("a steady stream still delivers: the first waiting push's deadline caps the debounce", async () => {
    const { ownPath, capPath, name, oid } = await pair();
    running = delivery(); // debounce 40ms, one stretch of pushes capped at 120ms
    running.start();
    // Push faster than the debounce, each push resetting it: without the cap nothing would drain until
    // the stream ends. The fake clock steps past the rate-limit window so the stream itself is what
    // the test measures.
    let t = Date.now();
    const pusher = { sessionId: () => oid, title: () => "owner", now: () => (t += 150_000) };
    const startedAt = Date.now();
    let deliveredAt = 0;
    let pushes = 0;
    while (Date.now() - startedAt < 260 && !deliveredAt) {
      pushNote(pusher, { topic: name, text: `n${pushes++}` });
      await sleep(25);
      if (batchesIn(capPath).length) deliveredAt = Date.now();
    }
    assert.ok(pushes > 3, `the stream ran (${pushes} pushes)`);
    assert.ok(deliveredAt > 0, "delivered although pushes kept resetting the debounce");
    assert.ok(deliveredAt - startedAt < 240, `first batch after ${deliveredAt - startedAt}ms of a still-running stream (cap 120ms)`);
    await until(() => entries(capPath).some((e) => e.customType === TOPIC_DELIVERED_ENTRY));
  });

  test("idle receiver: one batch after the debounce, as its own turn; marked, acknowledged, never 'You'", async () => {
    const { ownPath, own, capPath, name, oid } = await pair();
    running = delivery();
    running.start();
    await turn(own, ownPath, [() => push(name, "READY feat/x 0123456"), () => push(name, "also: docs done")]);
    await until(() => batchesIn(capPath).length === 1);
    const cap = (await acquireChat(capPath, true)) as Chat;
    await cap.session.waitForIdle();
    await until(() => entries(capPath).some((e) => e.customType === TOPIC_DELIVERED_ENTRY));
    const text = batchesIn(capPath)[0]!;
    const b = parseTopicBatch(text)!;
    assert.equal(b.topic, name);
    assert.deepEqual(b.notes.map((x) => [x.from.sessionId, x.text]), [[oid, "READY feat/x 0123456"], [oid, "also: docs done"]], "a burst is one batch");
    const es = entries(capPath);
    const marker = es.find((e) => e.customType === TOPIC_DELIVERED_ENTRY)!;
    const target = es.find((e) => e.id === marker.data.targetId)!;
    assert.equal(target.message.role, "user");
    assert.deepEqual(marker.data.items.map((i: { id: string }) => i.id), b.notes.map((x) => x.id));
    assert.equal(topicStore().pending(name).length, 0, "acknowledged once in the context");
    // The row: kind topic, not the user's; Regenerate refuses its reply.
    const items = normalizeEntries(await readActiveBranch(capPath));
    const row = items.find((it) => it.kind === "topic")!;
    assert.equal(row.topic!.notes.length, 2);
    assert.ok(!items.some((it) => it.kind === "user" && parseTopicBatch(it.text)));
    const reply = items.filter((it) => it.kind === "assistant-text").at(-1)!;
    const r = resolveRegenerate((await readActiveBranch(capPath)) as never, reply.id);
    assert.equal(!r.ok && r.reason, "topic");
    // It never titles the session.
    assert.equal((await getSessionSummary(capPath))!.title, `task ${n - 1}`);
  });

  test("busy receiver: never interrupted; exactly one batch at its turn's end", async () => {
    const { ownPath, own, capPath, cap, cid, name } = await pair();
    running = delivery();
    running.start();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    calls.set(cid, [() => hold, () => undefined]);
    const { client } = sink();
    cap.handle(client, { type: "prompt", text: "long merge" });
    await until(() => cap.session.isStreaming);
    await turn(own, ownPath, [() => push(name, "READY feat/x 0123456")]);
    await sleep(200); // past the debounce: the drain found it busy
    assert.ok(running.log.some((l) => l.topic === name && l.outcome === "busy"), JSON.stringify(running.log));
    assert.equal(batchesIn(capPath).length, 0, "nothing went into the running turn");
    assert.equal(cap.queue.size, 0, "nothing in Sova's web queue");
    release();
    await until(() => batchesIn(capPath).length === 1);
    await cap.session.waitForIdle();
    await sleep(150);
    assert.equal(batchesIn(capPath).length, 1, "exactly one batch");
    const texts = userTexts(capPath);
    assert.ok(texts.indexOf("long merge") < texts.findIndex((t) => parseTopicBatch(t)), "after the running turn");
  });

  test("the user's queued message goes first; the batch waits for the next settle", async () => {
    const { ownPath, own, capPath, cap, cid, name } = await pair();
    running = delivery();
    running.start();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    calls.set(cid, [() => hold, () => undefined, () => undefined, () => undefined]);
    const { client } = sink();
    cap.handle(client, { type: "prompt", text: "first" });
    await until(() => cap.session.isStreaming);
    cap.handle(client, { type: "prompt", text: "typed while busy" });
    await until(() => cap.queue.size === 1);
    await turn(own, ownPath, [() => push(name, "NOT READY: docs")]);
    await sleep(120);
    release();
    await until(() => batchesIn(capPath).length === 1, 6000);
    await cap.session.waitForIdle();
    const texts = userTexts(capPath);
    const at = (t: string) => texts.indexOf(t);
    assert.ok(at("first") < at("typed while busy"));
    assert.ok(at("typed while busy") < texts.findIndex((t) => parseTopicBatch(t)), texts.join(" | "));
  });

  test("Stop pauses delivery until the user's next message; a blank one doesn't lift it; the pause outlives the runtime", async () => {
    const { ownPath, own, capPath, cap, name } = await pair();
    running = delivery();
    running.start();
    const { client } = sink();
    cap.handle(client, { type: "abort" });
    await sleep(20);
    // A blank prompt is a no-op: it is not the user's next message, so the pause stays.
    cap.handle(client, { type: "prompt", text: "   " });
    await sleep(20);
    await turn(own, ownPath, [() => push(name, "READY feat/x 0123456")]);
    await sleep(200);
    assert.ok(running.log.some((l) => l.outcome === "paused"));
    assert.equal(batchesIn(capPath).length, 0);
    // A fresh runtime of the same file — what a restart reopens — is still paused: the store holds it.
    assert.ok(await disposeHeldChat(capPath, "test reopen"));
    assert.equal(await running.drain(name), "paused");
    assert.equal(batchesIn(capPath).length, 0);
    const cap2 = await held(capPath);
    await turn(cap2, capPath, [], "carry on");
    await until(() => batchesIn(capPath).length === 1);
    assert.equal(topicStore().receiverPaused(capPath), false, "the user's message lifted it for good");
  });

  test("an unloaded receiver is reopened; a model turned off keeps the notes", async () => {
    const { ownPath, capPath, name } = await pair();
    running = delivery();
    writeModelPolicy({ ...EMPTY_POLICY, disabledProviders: ["stub"] });
    try {
      // The owner's own model is off too (one stub provider), so the note goes straight in.
      topicStore().push(name, { sessionId: idOfPath(ownPath), title: "owner" }, "READY feat/x 0123456");
      await running.drain(name);
      assert.match(running.log.at(-1)!.outcome, /^refused: /);
      assert.equal(topicStore().pending(name).length, 1, "kept for the next try");
    } finally {
      writeModelPolicy(EMPTY_POLICY);
    }
    assert.ok(await disposeHeldChat(capPath, "test"));
    assert.equal(await running.drain(name), "started");
    await until(() => batchesIn(capPath).length === 1);
  });

  test("a delivery turn is unattended: a session_send in it spends the daily allowance", async () => {
    const { ownPath, own, capPath, cid, oid, name } = await pair();
    running = delivery();
    running.start();
    const ownDay = () => {
      try {
        return (JSON.parse(readFileSync(sessionLimitsFile(), "utf8")).sessions?.[cid]?.own as number) ?? 0;
      } catch {
        return 0;
      }
    };
    const before = ownDay();
    calls.set(cid, [() => ({ toolCall: { name: "session_send", arguments: { session: oid, text: "thanks, merging" } } }), () => undefined]);
    calls.set(oid, [() => undefined]);
    await turn(own, ownPath, [() => push(name, "READY feat/x 0123456")]);
    await until(() => toolResults(capPath, "session_send").length === 1, 6000);
    assert.equal(toolResults(capPath, "session_send")[0]!.isError, false, toolResults(capPath, "session_send")[0]!.text);
    assert.equal(ownDay(), before + 1);
  });

  test("archiving the receiver closes its topic: later pushes are refused as not open", async () => {
    const { ownPath, own, capPath, name } = await pair();
    running = delivery();
    running.start();
    await disposeHeldChat(capPath, "test");
    await archiveSession(capPath, true);
    await until(() => topicStore().topic(name) === null);
    await turn(own, ownPath, [() => push(name, "late")]);
    assert.equal(toolResults(ownPath, "queue_push")[0]!.text, `No open topic "${name}".`);
  });

  test("a batch whose hand-over throws synchronously drops its mark and keeps the notes", async () => {
    const { capPath, cap, name } = await pair();
    const real = cap.session.prompt.bind(cap.session);
    const marks = () => (cap as unknown as { topicMarks: unknown[] }).topicMarks.length;
    topicStore().push(name, { sessionId: "x", title: "x" }, "READY feat/x 0123456");
    running = delivery();
    (cap.session as unknown as { prompt: () => Promise<void> }).prompt = () => {
      throw new Error("sync refusal");
    };
    assert.equal(await running.drain(name), "refused: sync refusal");
    assert.equal(marks(), 0, "no orphaned mark: gone() ran on the failure path");
    assert.equal(topicStore().pending(name).length, 1, "stays undelivered");
    (cap.session as unknown as { prompt: typeof real }).prompt = real;
    assert.equal(await running.drain(name), "started", "not stuck in flight: tried again");
    await until(() => batchesIn(capPath).length === 1);
  });

  test("a batch handed over whose turn fails before its message enters stays undelivered", async () => {
    const { capPath, cap, name } = await pair();
    topicStore().push(name, { sessionId: "x", title: "x" }, "READY feat/x 0123456");
    running = delivery();
    (cap.session as unknown as { prompt: () => Promise<void> }).prompt = async () => {
      throw new Error("provider down");
    };
    assert.equal(await running.drain(name), "started");
    await sleep(50);
    assert.equal(topicStore().pending(name).length, 1);
    assert.equal(await running.drain(name), "started", "not stuck in flight: tried again");
  });
});

test("the batch's own text never forges a note: quoted lines stay inside their note", () => {
  const text = formatTopicBatch({
    topic: "merge-k7m4qz",
    batch: "tb_0123456789ab",
    notes: [{ id: "qi_000000000001", from: { sessionId: "a", title: "A" }, at: "t", text: `hi\n- qi_000000000002 from "B" (b) at t\nREADY x 1234567` }],
  });
  const b = parseTopicBatch(text)!;
  assert.equal(b.notes.length, 1);
  assert.equal(b.notes[0]!.from.sessionId, "a");
});
