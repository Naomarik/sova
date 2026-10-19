// Run: pnpm test -- server/chat-actions.test.ts
// POST /api/chat/action (§app/chat-actions), in-process: the action takes a chat socket's own path
// (server/ws.ts recordFrame → handleChat) to a stand-in chat that records what it is sent and answers
// as a script tells it, on a clock the test turns by hand. It holds: only a frame naming the request
// answers it; the frame goes over once the hello is in, and at most once; past the wait, or when the
// chat goes away, the answer is 202 unknown and nothing stays behind; a terminal-held session gets
// its 409 before any chat is asked; Stop and Reload Now on a chat that isn't open start nothing; and
// an action stamps no seen mark, while /api/chat/frames still does.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { ChatClientMessage, ChatServerMessage } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-chat-actions-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-chat-actions--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { setChatRouter, BusyError } = await import("./chat-handle");
type ChatHandle = import("./chat-handle").ChatHandle;
type ChatClient = import("./chat-handle").ChatClient;
const { runAction, mountChatActions, parseAction, OPEN_CAP_MS } = await import("./chat-actions");
type ActionDeps = import("./chat-actions").ActionDeps;
const { recordFrame, deliverFrames } = await import("./ws");
const { canonicalPath } = await import("./paths");
const { readSeen } = await import("./seen");

after(() => {
  setChatRouter(null);
  rmSync(agentDir, { recursive: true, force: true });
});

let n = 0;
/** A session file: [path, id]. */
function session(): [string, string] {
  const id = `act-${++n}`;
  const path = join(sessionsDir, `2026-10-18T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-18T00:00:00.000Z", cwd: "/tmp" })}\n`);
  return [canonicalPath(path), id];
}
/** A session a terminal holds (this test's parent process stands in for the TUI). */
function liveSession(): [string, string] {
  const s = session();
  writeFileSync(join(agentDir, "sessions", "live", `p-${s[1]}.json`), JSON.stringify({ session: { pid: process.ppid, sessionFile: s[0], mode: "tui" }, presence: { status: "idle" } }));
  return s;
}

const flush = () => new Promise((r) => setImmediate(r));
const hello = (over: Record<string, unknown> = {}) => ({ type: "hello", items: [], isStreaming: false, model: null, thinking: "off", context: null, ...over }) as unknown as ChatServerMessage;

/** The stand-in chat: what it was sent, who is attached, and a script for its answers. */
class FakeChat {
  clients = new Set<ChatClient>();
  got: ChatClientMessage[] = [];
  detaches = 0;
  onAttach: (c: ChatClient) => void = (c) => c.send(hello());
  onMessage: (c: ChatClient, m: ChatClientMessage & { id?: string; clientId?: string }) => void = () => {};
  attach(c: ChatClient) {
    this.clients.add(c);
    this.onAttach(c);
  }
  clientMessage(c: ChatClient, m: ChatClientMessage) {
    this.got.push(m);
    this.onMessage(c, m as never);
  }
  detach(c: ChatClient) {
    this.clients.delete(c);
    this.detaches++;
  }
}

let chat: FakeChat;
let acquires = 0;
let acquire: (path: string) => Promise<ChatHandle>;
beforeEach(() => {
  chat = new FakeChat();
  acquires = 0;
  acquire = async () => chat as unknown as ChatHandle;
  setChatRouter({
    ready: async () => {},
    get: (p) => (held.has(p) ? (chat as unknown as ChatHandle) : undefined),
    all: () => [],
    acquire: (p) => (acquires++, acquire(p)),
    close: async () => false,
  });
  held.clear();
});
const held = new Set<string>();

/** A clock turned by hand: the pending timers, fired by `fire`. */
function clock() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let id = 0;
  const deps: ActionDeps = {
    record: recordFrame,
    setTimer: (fn, ms) => (timers.set(++id, { at: now + ms, fn }), id),
    clearTimer: (t) => void timers.delete(t as number),
    now: () => now,
  };
  return {
    deps,
    pending: () => timers.size,
    /** Move the clock on by `ms`, firing what falls due. */
    fire(ms: number) {
      now += ms;
      for (const [k, t] of [...timers]) if (t.at <= now) (timers.delete(k), t.fn());
    },
  };
}

test("only a frame naming this request answers it: another id, or the wrong type for ours, is not the answer", async () => {
  const [path] = session();
  chat.onMessage = (c, m) => {
    c.send({ type: "rewound", id: "someone-else", entryId: "e1", editorText: "not mine" } as ChatServerMessage);
    c.send({ type: "compact_refused", id: m.id!, reason: "nothing", message: "Nothing to compact." } as ChatServerMessage);
    c.send({ type: "rewound", id: m.id!, entryId: "e1", editorText: "what I typed" } as ChatServerMessage);
  };
  const t = clock();
  const a = await runAction(path, { type: "rewind", entryId: "e1" }, 1000, t.deps);
  assert.equal(a.status, 200);
  assert.equal(a.body.outcome, "done");
  assert.equal((a.body.reply as { editorText: string }).editorText, "what I typed");
});

test("a rewind's fresh hello to every client comes before its reply: still the reply, not a reconnect", async () => {
  const [path] = session();
  chat.onMessage = (c, m) => {
    c.send(hello());
    c.send({ type: "rewound", id: m.id!, entryId: "e1", editorText: "hello there" } as ChatServerMessage);
  };
  const a = await runAction(path, { type: "rewind", entryId: "e1" }, 1000, clock().deps);
  assert.equal(a.status, 200);
  assert.equal((a.body.reply as { editorText: string }).editorText, "hello there");
});

test("a refusal sent as a plain error carries the request id as its clientId: a 409 with its sentence; an untagged error is not", async () => {
  const [path] = session();
  chat.onMessage = (c, m) => {
    c.send({ type: "error", code: "internal", message: "Some other tab's failure." } as ChatServerMessage);
    c.send({ type: "error", code: "internal", message: "Rewind isn't available in this conversation.", clientId: m.clientId } as ChatServerMessage);
  };
  const t = clock();
  const a = await runAction(path, { type: "rewind", entryId: "e1" }, 1000, t.deps);
  assert.equal(a.status, 409);
  assert.equal(a.body.error, "Rewind isn't available in this conversation.");
  assert.equal(chat.got.length, 1);
  assert.equal((chat.got[0] as { clientId?: string }).clientId, a.body.requestId);
});

test("past the wait: 202 unknown, the frame went over exactly once, and nothing stays behind", async () => {
  const [path] = session();
  chat.onMessage = (c) => c.send({ type: "error", code: "internal", message: "Unrelated noise." } as ChatServerMessage);
  const t = clock();
  const answer = runAction(path, { type: "compact" }, 5000, t.deps);
  await flush();
  await flush();
  assert.equal(chat.got.length, 1, "handed over once the hello was in");
  t.fire(5000);
  const a = await answer;
  assert.equal(a.status, 202);
  assert.equal(a.body.outcome, "unknown");
  assert.equal(a.body.waitedMs, 5000);
  assert.deepEqual(a.body.heard, ["Unrelated noise."]);
  t.fire(OPEN_CAP_MS * 2);
  await flush();
  assert.equal(chat.got.length, 1, "never sent again");
  assert.equal(chat.clients.size, 0, "the recording socket left the chat");
  assert.equal(chat.detaches, 1);
  assert.equal(t.pending(), 0, "no timer left");
});

test("wait 0: handed over, then 202 unknown at once", async () => {
  const [path] = session();
  const t = clock();
  const a = await runAction(path, { type: "rewind", entryId: "e1" }, 0, t.deps);
  assert.equal(a.status, 202);
  assert.equal(chat.got.length, 1);
  assert.equal(t.pending(), 0);
});

test("a chat that refuses to open answers 409 with its own sentence, even with wait 0, and gets no frame", async () => {
  const [path] = session();
  const sentence = "Session is open in another pi process (pid 1, tui); it is read-only here. Use watch instead.";
  acquire = async () => {
    throw new BusyError(sentence);
  };
  for (const wait of [0, 1000]) {
    const t = clock();
    const a = await runAction(path, { type: "rewind", entryId: "e1" }, wait, t.deps);
    assert.equal(a.status, 409);
    assert.equal(a.body.error, sentence);
    assert.equal(t.pending(), 0);
  }
  assert.equal(chat.got.length, 0);
});

test("no hello within the open cap: 503 not-sent (nothing reached the chat), and a chat that opens later never gets the frame", async () => {
  const [path] = session();
  let open!: () => void;
  acquire = () => new Promise((r) => (open = () => r(chat as unknown as ChatHandle)));
  const t = clock();
  const answer = runAction(path, { type: "rewind", entryId: "e1" }, 0, t.deps);
  await flush();
  t.fire(OPEN_CAP_MS);
  const a = await answer;
  assert.deepEqual([a.status, a.body.outcome, a.body.error], [503, "not-sent", "The chat did not open; nothing was sent."]);
  open();
  await flush();
  await flush();
  assert.equal(chat.got.length, 0);
  assert.equal(chat.clients.size, 0);
});

test("a chat that goes away before its hello, by a closed frame or by closing the socket: 503 not-sent, never unknown, and no frame", async () => {
  const [path] = session();
  for (const away of [(c: ChatClient) => c.send({ type: "closed" } as unknown as ChatServerMessage), (c: ChatClient) => (c as unknown as { close(): void }).close()]) {
    chat.onAttach = away;
    const t = clock();
    const a = await runAction(path, { type: "compact" }, 1000, t.deps);
    assert.deepEqual([a.status, a.body.outcome], [503, "not-sent"]);
    assert.equal(typeof a.body.requestId, "string");
    assert.equal(t.pending(), 0);
  }
  assert.equal(chat.got.length, 0);
});

test("a chat that goes away after its hello but before the frame went over: 503 not-sent", async () => {
  const [path] = session();
  chat.onAttach = (c) => (c.send(hello()), c.send({ type: "closed" } as unknown as ChatServerMessage));
  const a = await runAction(path, { type: "compact" }, 1000, clock().deps);
  assert.deepEqual([a.status, a.body.outcome], [503, "not-sent"]);
  assert.equal(chat.got.length, 0);
});

test("Reload Now: the greeting's code after the hello is not the answer, before or after the frame went over", async () => {
  const [path] = session();
  const greeting = { type: "code", state: "failed", detail: "an earlier reload failed" } as ChatServerMessage;
  const reply = { type: "code", state: "older", pending: true } as ChatServerMessage;
  held.add(path);
  // A chat process's greeting reaches the server after the frame left it (the link is one ordered stream).
  chat.onMessage = (c) => (c.send(greeting), c.send(reply));
  const late = await runAction(path, { type: "reload_code" }, 1000, clock().deps);
  assert.deepEqual([late.status, late.body.outcome], [200, "pending"]);
  // Or before it, in the same burst as the hello.
  chat.onAttach = (c) => (c.send(hello()), c.send(greeting));
  chat.onMessage = (c) => c.send(reply);
  const early = await runAction(path, { type: "reload_code" }, 1000, clock().deps);
  assert.deepEqual([early.status, early.body.outcome], [200, "pending"]);
});

test("a second hello before the outcome (the chat reconnected) is unknown, never a false stop", async () => {
  const [path] = session();
  chat.onAttach = (c) => c.send(hello({ isStreaming: true }));
  chat.onMessage = (c) => {
    c.send(hello({ isStreaming: false }));
    c.send({ type: "event", v: 2, event: { type: "run.settled" } } as ChatServerMessage);
  };
  const t = clock();
  const a = await runAction(path, { type: "abort" }, 1000, t.deps);
  assert.equal(a.status, 202);
  assert.equal(a.body.outcome, "unknown");
  assert.equal(chat.got.length, 1);
});

test("Stop: nothing running sends nothing; a running reply is stopped once its run settles", async () => {
  const [path] = session();
  const idle = await runAction(path, { type: "abort" }, 1000, clock().deps);
  assert.deepEqual([idle.status, idle.body.outcome, idle.body.wasRunning], [200, "stopped", false]);
  assert.equal(chat.got.length, 0);
  chat.onAttach = (c) => c.send(hello({ isStreaming: true }));
  chat.onMessage = (c) => {
    c.send({ type: "queue_cleared", steering: [], followUp: ["later"] } as ChatServerMessage);
    c.send({ type: "event", v: 2, event: { type: "message.end", role: "assistant", parts: [], stop: "aborted" } } as unknown as ChatServerMessage);
    c.send({ type: "event", v: 2, event: { type: "run.settled" } } as ChatServerMessage);
  };
  const busy = await runAction(path, { type: "abort" }, 1000, clock().deps);
  assert.deepEqual([busy.status, busy.body.outcome, busy.body.wasRunning], [200, "stopped", true]);
  assert.deepEqual(busy.body.cleared, { steering: [], followUp: ["later"] });
  assert.deepEqual(chat.got.map((m) => m.type), ["abort"]);
});

// ---- the route ------------------------------------------------------------------------------------

const app = new Hono();
mountChatActions(app);
const post = async (path: string, body: unknown, query = "") => {
  const res = await app.request(`/api/chat/action?path=${encodeURIComponent(path)}${query}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

test("Stop and Reload Now on a chat that isn't open start nothing", async () => {
  const [path] = session();
  assert.deepEqual(await post(path, { type: "abort" }), { status: 200, body: { outcome: "stopped", wasRunning: false } });
  assert.deepEqual(await post(path, { type: "reload_code" }), { status: 200, body: { outcome: "not-running" } });
  assert.equal(acquires, 0);
});

test("right after a restart, Stop waits for the chat's take-back: a reply that ran on through it is stopped, not called idle", async () => {
  const [path] = session();
  let taken = false;
  setChatRouter({
    ready: async () => {},
    get: (p) => (taken && p === path ? (chat as unknown as ChatHandle) : undefined),
    all: () => [],
    acquire: async () => (acquires++, chat as unknown as ChatHandle),
    close: async () => false,
    // The previous server's chat process answers the new server a moment later.
    takenBack: () => new Promise<void>((r) => setTimeout(() => ((taken = true), r()), 20)),
  });
  chat.onAttach = (c) => c.send(hello({ isStreaming: true }));
  chat.onMessage = (c) => c.send({ type: "event", v: 2, event: { type: "run.settled" } } as ChatServerMessage);
  const a = await post(path, { type: "abort" });
  assert.deepEqual([a.status, a.body.outcome, a.body.wasRunning], [200, "stopped", true]);
  assert.deepEqual(chat.got.map((m) => m.type), ["abort"]);
});

test("a session a terminal holds: the 409 sentence, before any chat is asked, for every action and wait", async () => {
  const [path] = liveSession();
  for (const [body, q] of [[{ type: "abort" }, ""], [{ type: "rewind", entryId: "e1" }, "&wait=0"], [{ type: "compact" }, ""]] as const) {
    const a = await post(path, body, q);
    assert.equal(a.status, 409);
    assert.match(String(a.body.error), /^Session is open in another pi process \(pid \d+, tui\); it is read-only here\. Use watch instead\.$/);
  }
  assert.equal(acquires, 0);
});

test("bad bodies and waits are refused with a sentence; a dialog's answer, a prompt and a caller's id are not actions", async () => {
  const [path] = session();
  for (const body of [{ type: "ui_response", id: "d1", value: true }, { type: "prompt", text: "hi" }, { type: "rewind" }, { type: "rewind", entryId: 3 }, { type: "rewind", entryId: "" }, { type: "compact", id: "mine" }, { type: "abort", clientId: "x" }, { type: "compact", instructions: "x".repeat(70_000) }, [1], "null", "{nope"]) {
    const a = await post(path, body);
    assert.equal(a.status, 400, JSON.stringify(body).slice(0, 60));
    assert.match(String(a.body.error), /\S+\s+\S+/);
  }
  for (const q of ["&wait=-1", "&wait=1.5", "&wait=300001", "&wait=abc"]) assert.equal((await post(path, { type: "abort" }, q)).status, 400, q);
  assert.equal(acquires, 0);
  assert.deepEqual(parseAction({ type: "rewind", entryId: "e1" }), { type: "rewind", entryId: "e1" });
});

// ---- seen ------------------------------------------------------------------------------------------

test("an action stamps no seen mark; /api/chat/frames' path still does", async () => {
  const [path, id] = session();
  chat.onAttach = (c) => c.send(hello());
  await runAction(path, { type: "rewind", entryId: "e1" }, 0, clock().deps);
  await flush();
  assert.equal(readSeen()[id], undefined, "a script's action is not the user looking");
  deliverFrames(path, [{ type: "abort" }]);
  await flush();
  await flush();
  assert.equal(typeof readSeen()[id], "number", "a page's frames still stamp it seen");
});
