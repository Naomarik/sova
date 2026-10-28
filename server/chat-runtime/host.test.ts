// Run: pnpm test -- server/chat-runtime/host.test.ts. A chat process's host, its socket replaced by an
// in-memory stream pair (the unit tier opens no sockets), the chat opened through chat-manager on a
// throwaway PI_CODING_AGENT_DIR with no credentials (no model is ever called). The test plays the
// server: control, open, calls, browsers, server-hosted tools, drains.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { after, test } from "node:test";
import type { ServerToolDecl } from "../../shared/chat-runtime";
import {
  CHAT_WIRE_PROTO,
  type ChatRuntimeSettings,
  type ChatWireType,
  DEFAULT_RUNTIME_SETTINGS,
  type ExitCause,
  type FrameOf,
  NOT_RUN_NO_SERVER,
  OUTCOME_UNKNOWN,
} from "../../shared/chat-runtime-wire";

const agentDir = mkdtempSync(join(tmpdir(), "sova-chat-host-test-"));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths
const sessionsDir = join(agentDir, "sessions", "--tmp-chathost--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });

const { ChatRuntimeHost, GONE_CALL } = await import("./host");
const { Link, awaitFrame } = await import("./link");
const { disposeAllChats, serverToolSpec, setSpecialSpec, specialSpecOf } = await import("../chat-manager");
const { canonicalPath } = await import("../paths");
const { readInflight } = await import("./inflight");
// The writer lock's start time as on Linux (/proc); on macOS none, so no `ps` is spawned (the unit tier forbids it).
const { procStart, setProcStartForTest } = await import("./writer-lock");
setProcStartForTest((pid) => procStart(pid, "linux"));

after(async () => {
  await disposeAllChats();
});

let n = 0;
function session(): { path: string; id: string } {
  const id = `01a0-ho${n}`;
  const path = join(sessionsDir, `2026-10-12T00-00-0${n}-000Z_${id}.jsonl`);
  n++;
  const lines = [
    { type: "session", version: 3, id, timestamp: "2026-10-12T00:00:00.000Z", cwd },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-10-12T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "first ask" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-12T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "first answer" }], provider: "zai", model: "glm-5.3", stopReason: "stop" } },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return { path: canonicalPath(path), id };
}

/** Two ends of an in-memory stream, as a connected socket pair. */
function pair(): [Duplex, Duplex] {
  const ends: Duplex[] = [];
  for (let i = 0; i < 2; i++)
    ends.push(
      new Duplex({
        read() {},
        write(chunk, _enc, cb) {
          ends[1 - i]!.push(chunk);
          cb();
        },
        final(cb) {
          ends[1 - i]!.push(null);
          cb();
        },
      }),
    );
  return [ends[0]!, ends[1]!];
}

const quiet = () => {};
let epoch = 100;

/** A host for a fresh session, and a "server" linked to it as controller. */
async function setup(o: { build?: string; serverBuild?: string; settings?: Partial<ChatRuntimeSettings>; open?: boolean; proto?: number; served?: ServerToolDecl[]; log?: (line: string) => void; askWithinMs?: number } = {}) {
  const s = session();
  const exits: ExitCause[] = [];
  const host = new ChatRuntimeHost({ path: s.path, sessionId: s.id, unit: "u", build: o.build ?? "b1", startedAt: 1, exit: (c) => exits.push(c), log: o.log ?? quiet, tickMs: 60_000, ...(o.askWithinMs ? { askWithinMs: o.askWithinMs } : {}) });
  const settings = { ...DEFAULT_RUNTIME_SETTINGS, ...o.settings };
  const connect = (since: number | null = null, build = o.serverBuild ?? o.build ?? "b1", proto = o.proto ?? CHAT_WIRE_PROTO, serverPid = 1) => {
    const [a, b] = pair();
    const runtimeEnd = new Link(a as never, { log: quiet });
    const server = new Link(b as never, { log: quiet });
    const e = ++epoch;
    runtimeEnd.peerProto = proto; // as serveLink sets it from the control
    host.onControl(runtimeEnd, { t: "control", proto, epoch: e, serverPid, serverStartedAt: 1, build, since, settings });
    return { server, runtimeEnd, epoch: e, drop: () => (a.destroy(), b.destroy()) };
  };
  const ctl = connect();
  // The chat's asks of its first controller, from its open on (its stored reply timings among them).
  const asks = collect(ctl.server, "ask");
  if (o.open !== false) {
    const opened = awaitFrame(ctl.server, "opened", 5_000);
    ctl.server.send({ t: "open", id: "o1", path: s.path, force: true, link: null, served: o.served ?? [] });
    const f = await opened;
    assert.equal(f.ok, true, JSON.stringify(f));
  }
  let calls = 0;
  const call = async (server: typeof ctl.server, e: number, method: string, args: unknown = {}) => {
    const id = `c${++calls}`;
    const got = awaitFrame(server, "reply", 5_000, (f) => f.reply.id === id);
    server.send({ t: "call", call: { id, epoch: e, chatId: s.path, method, args } as never });
    return (await got).reply;
  };
  /** Answer the chat's `reply.timings` ask (made as it opens) with `result`. */
  const answerTimings = async (result: unknown) => {
    for (let i = 0; i < 100 && !asks.some((a) => a.method === "reply.timings"); i++) await settle(5);
    const ask = asks.find((a) => a.method === "reply.timings");
    assert.ok(ask, "the chat asked for its reply timings");
    ctl.server.send({ t: "answer", id: ask.id, ok: true, result });
  };
  return { ...s, host, exits, ctl, connect, call, asks, answerTimings };
}

/** Collect a link's frames of one type. */
function collect<T extends ChatWireType>(link: InstanceType<typeof Link>, t: T) {
  const got: FrameOf<T>[] = [];
  link.on(t, (f) => got.push(f as FrameOf<T>));
  return got;
}
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

test("open: the chat's mirror, with what only the process knows", async () => {
  const t = await setup();
  const opened = awaitFrame(t.ctl.server, "opened", 5_000);
  t.ctl.server.send({ t: "open", id: "o2", path: t.path, force: true, link: null, served: [] });
  const f = await opened;
  assert.ok(f.ok);
  if (!f.ok) return;
  assert.equal(f.mirror.chatId, t.path);
  assert.equal(f.mirror.sessionId, t.id);
  assert.equal(f.mirror.leafId, "a1");
  assert.equal(f.mirror.build, "b1");
  assert.deepEqual(f.mirror.code, { state: "current" });
  assert.equal(f.mirror.quiet.quiet, true);
  assert.equal(f.mirror.quiet.clients, 0);
  assert.equal(f.mirror.claude, "none");
  assert.deepEqual(JSON.parse(JSON.stringify(f.mirror)), f.mirror, "plain data");
  // Another path is refused: one chat per process.
  const other = awaitFrame(t.ctl.server, "opened", 5_000, (x) => x.id === "o3");
  t.ctl.server.send({ t: "open", id: "o3", path: "/elsewhere.jsonl", force: true, link: null, served: [] });
  assert.equal((await other).ok, false);
});

test("calls: the chat's own answers; a stale epoch runs nothing", async () => {
  const t = await setup();
  const branch = await t.call(t.ctl.server, t.ctl.epoch, "branch");
  assert.ok(branch.ok);
  assert.deepEqual((branch.ok ? (branch.result as { id: string }[]) : []).map((e) => e.id), ["u1", "a1"]);
  const bad = await t.call(t.ctl.server, t.ctl.epoch, "appendState", { kind: "no-such-kind", data: {} });
  assert.deepEqual(bad, { id: bad.id, ok: false, error: { message: "Unknown state kind: no-such-kind" } });
  const stale = await t.call(t.ctl.server, t.ctl.epoch - 1, "branch");
  assert.deepEqual(stale, { id: stale.id, ok: false, error: { message: "stale controller" } });
  assert.deepEqual(await t.call(t.ctl.server, t.ctl.epoch, "releaseIdleModelChild"), { id: `c4`, ok: true, result: "none" });
  assert.deepEqual(await t.call(t.ctl.server, t.ctl.epoch, "reacquire", { force: false }), { id: `c5`, ok: true, result: "ok" });
});

test("a browser: the chat's frames for it, serialized, hello first; gone on detach", async () => {
  const t = await setup();
  const sends = collect(t.ctl.server, "client.send");
  const states = collect(t.ctl.server, "state");
  t.ctl.server.send({ t: "client.attach", clientId: "k1", client: { clientId: "k1", wire: 2 } });
  await t.answerTimings(null);
  await settle(120);
  const first = JSON.parse(sends[0]!.json);
  assert.equal(first.type, "hello");
  assert.ok(sends.every((s) => s.clientId === "k1"));
  assert.ok(sends.some((s) => JSON.parse(s.json).type === "queue"));
  assert.equal(states.at(-1)?.mirror.quiet.clients, 1);
  t.ctl.server.send({ t: "client.detach", clientId: "k1" });
  await settle(120);
  assert.equal(states.at(-1)?.mirror.quiet.clients, 0);
});

test("a cold wire-2 pane: its one hello waits for the stored reply timings and carries them; the code state follows it", async () => {
  const t = await setup({ serverBuild: "b0" });
  const sends = collect(t.ctl.server, "client.send");
  t.ctl.server.send({ t: "client.attach", clientId: "k1", client: { clientId: "k1", wire: 2 } });
  await settle(40);
  assert.deepEqual(sends.map((s) => JSON.parse(s.json).type), [], "nothing before its hello");
  const timing = { ttftMs: 800, replyMs: 2000, output: 300 };
  await t.answerTimings({ v: "1.1", timings: { a1: timing } });
  await settle(80);
  const msgs = sends.map((s) => JSON.parse(s.json));
  assert.equal(msgs[0].type, "hello");
  assert.deepEqual(msgs[0].items.find((it: { id: string }) => it.id === "a1:0")?.facts?.reply, timing, "the first hello carries the reply facts");
  assert.equal(msgs.filter((m) => m.type === "hello").length, 1, "one hello");
  const code = msgs.findIndex((m) => m.type === "code");
  assert.ok(code > 0, "the code state goes after the hello, which would clear it");
});

test("a cold wire-2 pane whose timings ask times out still gets its hello, once", async () => {
  const t = await setup({ askWithinMs: 60 });
  const sends = collect(t.ctl.server, "client.send");
  t.ctl.server.send({ t: "client.attach", clientId: "k1", client: { clientId: "k1", wire: 2 } });
  await settle(250);
  const hellos = sends.map((s) => JSON.parse(s.json)).filter((m) => m.type === "hello");
  assert.equal(hellos.length, 1);
  assert.equal(hellos[0].items.find((it: { id: string }) => it.id === "a1:0")?.facts?.reply, undefined);
});

test("a broker drop keeps the panes as orphans until a pane comes back (or the grace ends)", async () => {
  const t = await setup({ settings: { orphanGraceMs: 100 } });
  t.ctl.server.send({ t: "client.attach", clientId: "k1", client: { clientId: "k1" } });
  await settle();
  t.ctl.drop();
  await settle();
  const chat = t.host.heldChat()!;
  // The orphan still counts as attached (dialogs wait for it).
  assert.equal((chat as unknown as { clients: Set<unknown> }).clients.size, 1);
  const next = t.connect();
  const states = collect(next.server, "state");
  next.server.send({ t: "client.attach", clientId: "k2", client: { clientId: "k2" } });
  await settle(200);
  assert.equal((chat as unknown as { clients: Set<unknown> }).clients.size, 1, "the orphan went, the new pane stays");
  assert.equal(states.at(-1)?.mirror.quiet.clients, 1);

  // No pane comes back: the grace ends and the orphans go.
  next.drop();
  await settle();
  assert.equal((chat as unknown as { clients: Set<unknown> }).clients.size, 1, "the new pane is an orphan now");
  const third = t.connect();
  await settle(250);
  assert.equal((chat as unknown as { clients: Set<unknown> }).clients.size, 0);
  third.drop();
});

test("events: replayed from the server's last seq on a new control", async () => {
  const t = await setup();
  const events = collect(t.ctl.server, "event");
  const { emitChatEvent } = await import("../chat-manager");
  emitChatEvent(t.path, "receiverIdle");
  emitChatEvent(t.path, "receiverIdle");
  await settle();
  assert.equal(events.length, 2);
  const [e1, e2] = events.map((f) => f.event.seq);
  t.ctl.drop();
  await settle();
  // Frames arrive on a later turn of the loop: listeners set right after control hear them all.
  const next = t.connect(e1!);
  const replay = collect(next.server, "event");
  await settle();
  assert.deepEqual(replay.map((f) => f.event.seq), [e2]);
  next.drop();
  await settle();
  const gap = t.connect(-5);
  const gaps = collect(gap.server, "events.gap");
  await settle();
  assert.equal(gaps.length, 1, "events before the ring's oldest are a gap");
  gap.drop();
  await settle();
  const fresh = t.connect(null);
  const none = collect(fresh.server, "event");
  await settle();
  assert.equal(none.length, 0, "a fresh server gets no replay");
});

test("server-hosted tools: run by the server; unknown outcome after a drop; waiting for a server; not run without one", async () => {
  const t = await setup({ settings: { serverToolWaitMs: 300 } });
  const decl: ServerToolDecl = { name: "trial_tool", label: "Trial", description: "a served tool", parameters: { type: "object", properties: {} } };
  const tool = serverToolSpec(t.path, decl);
  // 1. Answered by the server.
  const calls = collect(t.ctl.server, "tool.call");
  const ran = tool.execute("tc-1", {}, undefined, undefined, undefined);
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.call.name, "trial_tool");
  assert.equal(calls[0]!.ctx.sessionId, t.id);
  assert.equal(calls[0]!.ctx.cwd, cwd);
  assert.equal(calls[0]!.ctx.leafId, "a1");
  t.ctl.server.send({ t: "tool.result", effectId: calls[0]!.call.effectId, outcome: { ok: true, result: { content: [{ type: "text", text: "done" }], details: null } } });
  assert.deepEqual(await ran, { content: [{ type: "text", text: "done" }], details: null });

  // 2. Delivered, then the server went away: the next server's control says unknown; never re-sent.
  const lost = tool.execute("tc-2", {}, undefined, undefined, undefined);
  await settle();
  assert.equal(calls.length, 2);
  t.ctl.drop();
  await settle();
  const next = t.connect();
  const nextCalls = collect(next.server, "tool.call");
  await assert.rejects(lost, (e: Error) => e.message === OUTCOME_UNKNOWN);
  await settle();
  assert.equal(nextCalls.length, 0, "never sent again");

  // 3. Made with no server: waits, and is sent when one comes.
  next.drop();
  await settle();
  const waiting = tool.execute("tc-3", {}, undefined, undefined, undefined);
  await settle(30);
  const third = t.connect();
  const thirdCalls = collect(third.server, "tool.call");
  await settle();
  assert.equal(thirdCalls.length, 1);
  third.server.send({ t: "tool.result", effectId: thirdCalls[0]!.call.effectId, outcome: { ok: true, result: { content: [], details: null } } });
  assert.deepEqual(await waiting, { content: [], details: null });

  // 4. Delivered and the server never comes back: unknown after the wait.
  const orphan = tool.execute("tc-4", {}, undefined, undefined, undefined);
  await settle();
  third.drop();
  await assert.rejects(orphan, (e: Error) => e.message === OUTCOME_UNKNOWN);

  // 5. No server ever: the not-run text after the wait.
  const never = tool.execute("tc-5", {}, undefined, undefined, undefined);
  await assert.rejects(never, (e: Error) => e.message === NOT_RUN_NO_SERVER);
});

test("SOVA_CHAT_TEST_FAIL_OPEN=<build>: that build refuses every open, as a broken deploy's (T27)", async () => {
  process.env.SOVA_CHAT_TEST_FAIL_OPEN = "bad";
  try {
    const t = await setup({ build: "bad", open: false });
    const opened = awaitFrame(t.ctl.server, "opened", 5_000);
    t.ctl.server.send({ t: "open", id: "o1", path: t.path, force: true, link: null, served: [] });
    const f = await opened;
    assert.equal(f.ok, false);
    assert.match(JSON.stringify(f), /failing the open on purpose/);
    t.ctl.server.close();
  } finally {
    delete process.env.SOVA_CHAT_TEST_FAIL_OPEN;
  }
});

test("drain: a pane attached doesn't hold an idle close (§app.chat-processes/idle-stop); the chat closes and says why", async () => {
  const t = await setup();
  t.ctl.server.send({ t: "client.attach", clientId: "k1", client: { clientId: "k1" } });
  await settle();
  const ok = awaitFrame(t.ctl.server, "drained", 2_000);
  const exit = awaitFrame(t.ctl.server, "exit", 2_000);
  t.ctl.server.send({ t: "drain", id: "d1", reason: "idle", force: false });
  assert.deepEqual(await ok, { t: "drained", id: "d1", ok: true });
  assert.deepEqual(await exit, { t: "exit", cause: "idle" });
  // It waits for the server to close the link (what a pane sent before then is refused back), then exits.
  assert.deepEqual(t.exits, []);
  t.ctl.server.close();
  await settle();
  assert.deepEqual(t.exits, ["idle"]);
  assert.equal(t.host.hosting, false);
  assert.equal(readInflight(t.id), null);
});

test("drain: a reply running or a message queued refuses an idle close, a pane attached or not; quiet again, it closes", async () => {
  const t = await setup();
  const states = collect(t.ctl.server, "state");
  const tick = () => (t.host as unknown as { tick(): void }).tick();
  t.ctl.server.send({ t: "client.attach", clientId: "k1", client: { clientId: "k1" } });
  await settle();
  const chat = t.host.heldChat()!;
  const harness = chat.harness as unknown as { isRunning(): boolean };
  const running = harness.isRunning.bind(harness);
  let drains = 0;
  const drain = async () => {
    const id = `d${++drains}`;
    const got = awaitFrame(t.ctl.server, "drained", 2_000, (f) => f.id === id);
    t.ctl.server.send({ t: "drain", id, reason: "idle", force: false });
    return got;
  };
  // A reply running.
  harness.isRunning = () => true;
  tick();
  await settle();
  assert.equal(states.at(-1)?.mirror.quiet.quiet, false, "a running reply is not quiet");
  assert.deepEqual(await drain(), { t: "drained", id: "d1", ok: false, why: "busy" });
  harness.isRunning = running;
  // A message queued.
  Object.defineProperty(chat.queue, "size", { get: () => 1, configurable: true });
  tick();
  await settle();
  assert.equal(states.at(-1)?.mirror.quiet.quiet, false, "a queued message is not quiet");
  assert.deepEqual(await drain(), { t: "drained", id: "d2", ok: false, why: "busy" });
  delete (chat.queue as unknown as { size?: number }).size;
  tick();
  await settle();
  assert.equal(states.at(-1)?.mirror.quiet.quiet, true);
  assert.equal(states.at(-1)?.mirror.quiet.clients, 1, "the pane is still attached");
  assert.deepEqual(t.exits, []);
  assert.deepEqual(await drain(), { t: "drained", id: "d3", ok: true });
  t.ctl.server.close();
  await settle();
  assert.deepEqual(t.exits, ["idle"]);
});

test("F14: a prompt that reaches a stopping chat goes back to its pane as a refusal naming it, never lost in silence", async () => {
  const t = await setup();
  const sends = collect(t.ctl.server, "client.send");
  t.ctl.server.send({ t: "client.attach", clientId: "k1", client: { clientId: "k1" } });
  await settle();
  const exit = awaitFrame(t.ctl.server, "exit", 5_000);
  // A stop from outside (SIGTERM) and, in flight behind it, the pane's /btw; then one sent after the exit.
  void t.host.close("operator", { dispose: true, message: "Reconnecting." });
  t.ctl.server.send({ t: "client.msg", clientId: "k1", msg: { type: "prompt", text: "/btw a side question", clientId: "p1" } });
  await exit;
  t.ctl.server.send({ t: "client.msg", clientId: "k1", msg: { type: "steer", text: "and this", clientId: "p2" } });
  t.ctl.server.send({ t: "client.msg", clientId: "k1", msg: { type: "set_model", ref: "x/y" } as never });
  await settle();
  const refused = sends.map((f) => JSON.parse(f.json)).filter((m) => m.code === "refused");
  assert.deepEqual(refused.map((m) => m.clientId), ["p1", "p2"]);
  assert.match(refused[0].message, /restarting; your message wasn't sent/);
  t.ctl.server.close();
  await settle();
  assert.deepEqual(t.exits, ["operator"]);
});

test("F14: a prompt that reaches a chat closing for a reload goes back to its pane as a refusal, never run, never lost", async () => {
  const t = await setup();
  const sends = collect(t.ctl.server, "client.send");
  t.ctl.server.send({ t: "client.attach", clientId: "k1", client: { clientId: "k1" } });
  await settle();
  const exit = awaitFrame(t.ctl.server, "exit", 5_000);
  // The rollout's drain closes it for a reload; the pane's prompt is in flight behind it.
  void t.host.close("reload", { dispose: true });
  t.ctl.server.send({ t: "client.msg", clientId: "k1", msg: { type: "prompt", text: "RELOAD-RACE-PROMPT", clientId: "p1" } });
  assert.equal((await exit).cause, "reload");
  await settle();
  const refused = sends.map((f) => JSON.parse(f.json)).filter((m) => m.code === "refused");
  assert.deepEqual(refused.map((m) => m.clientId), ["p1"]);
  assert.ok(refused[0].message, "it says why");
  assert.equal(readFileSync(t.path, "utf8").includes("RELOAD-RACE-PROMPT"), false, "never run here");
  t.ctl.server.close();
  await settle();
  assert.deepEqual(t.exits, ["reload"]);
});

test("F14: an operator close lets what the chat already asked the server finish first (bounded), then disposes", async () => {
  const t = await setup({ proto: CHAT_WIRE_PROTO });
  const wk = collect(t.ctl.server, "wk");
  const exits = collect(t.ctl.server, "exit");
  // A command the chat took (an idle /btw) is mid-way: its question to its worker is on its way.
  const workers = (t.host as unknown as { workers: { bind(p: { sessionId: string; path: string }): { send(id: string, i: unknown): Promise<unknown> } } }).workers;
  const asked = workers.bind({ sessionId: t.id, path: t.path }).send("btw-chat", { text: "a side question" });
  await settle();
  assert.equal(wk.length, 1, "the request reached the server");
  void t.host.close("operator", { dispose: true, message: "Reconnecting." });
  await settle(200);
  assert.equal(exits.length, 0, "not disposed while the server hasn't answered it");
  assert.equal(t.host.hosting, true);
  t.ctl.server.send({ t: "wk.result", id: wk[0]!.id, ok: true, result: { queued: false } });
  assert.deepEqual(await asked, { queued: false });
  await settle(200);
  assert.deepEqual(exits.map((f) => f.cause), ["operator"]);
  t.ctl.server.close();
});

test("F14: an extension command an idle chat took (a /btw sent as a steer runs at once) holds an operator close until it settles", async () => {
  const logs: string[] = [];
  const t = await setup({ log: (l) => logs.push(l) });
  const chat = t.host.heldChat()!;
  let finish!: () => void;
  const running = new Promise<void>((r) => (finish = r));
  const sent: string[] = [];
  (chat as unknown as { harness: { send(text: string): Promise<void> } }).harness.send = (text: string) => (sent.push(text), running);
  const exits = collect(t.ctl.server, "exit");
  t.ctl.server.send({ t: "client.attach", clientId: "k1", client: { clientId: "k1" } });
  await settle();
  t.ctl.server.send({ t: "client.msg", clientId: "k1", msg: { type: "steer", text: "/btw a side question", clientId: "s1" } });
  await settle();
  assert.deepEqual(sent, ["/btw a side question"], "taken");
  void t.host.close("operator", { dispose: true, message: "Reconnecting." });
  await settle(200);
  assert.equal(exits.length, 0, "the command is still running: not disposed");
  finish();
  await settle(200);
  assert.deepEqual(exits.map((f) => f.cause), ["operator"]);
  assert.ok(logs.some((l) => /closing \(operator\): 1 command\(s\) running/.test(l)), logs.join("\n"));
  t.ctl.server.close();
});

test("F14: a request the server never answers holds the close only for the bound, and is logged", async () => {
  const logs: string[] = [];
  const t = await setup({ proto: CHAT_WIRE_PROTO, log: (l) => logs.push(l) });
  const exits = collect(t.ctl.server, "exit");
  const workers = (t.host as unknown as { workers: { bind(p: { sessionId: string; path: string }): { send(id: string, i: unknown): Promise<unknown> } } }).workers;
  void workers.bind({ sessionId: t.id, path: t.path }).send("btw-chat", { text: "q" }).catch(() => {});
  await settle();
  const t0 = Date.now();
  void t.host.close("operator", { dispose: true, message: "Reconnecting." });
  await awaitFrame(t.ctl.server, "exit", 6_000);
  assert.ok(Date.now() - t0 >= 2_900, "it waited the bound");
  assert.equal(exits.length, 1);
  assert.ok(logs.some((l) => /closing with .* 1 request\(s\) to the server unanswered/.test(l)), logs.join("\n"));
  t.ctl.server.close();
});

test("5e: with no server linked, a quiet chat exits by itself after the idle-stop time, as an idle stop; a linked one never does", async () => {
  const logs: string[] = [];
  const t = await setup({ settings: { idleStopMin: 0.001 }, log: (l) => logs.push(l) });
  const tick = () => (t.host as unknown as { tick(): void }).tick();
  tick();
  await settle(120);
  tick();
  await settle();
  assert.deepEqual(t.exits, [], "a server is linked: the server decides");
  t.ctl.drop();
  await settle();
  tick();
  await settle(120);
  tick();
  await settle(100);
  assert.deepEqual(t.exits, ["idle"]);
  assert.ok(logs.some((l) => /no server, and quiet for 0.001 min: closing/.test(l)), logs.join("\n"));
});

test("5e: a process never opened (a start or a reload's replacement its server never finished) exits by itself with no server too, and leaves the chat's run marker alone", async () => {
  const t = await setup({ open: false, settings: { idleStopMin: 0.001 } });
  const { inflightDir } = await import("./inflight");
  // The chat's run in flight, recorded by the process that has it open (a reload's old process).
  mkdirSync(inflightDir(), { recursive: true });
  const marker = join(inflightDir(), `${encodeURIComponent(t.id)}.json`);
  writeFileSync(marker, JSON.stringify({ v: 1, path: t.path, since: 1 }));
  const tick = () => (t.host as unknown as { tick(): void }).tick();
  tick();
  await settle(120);
  tick();
  await settle();
  assert.deepEqual(t.exits, [], "a server is linked: the server decides");
  t.ctl.drop();
  await settle();
  tick();
  await settle(120);
  tick();
  await settle(100);
  assert.deepEqual(t.exits, ["idle"]);
  assert.ok(existsSync(marker), "another process's run marker is kept");
  rmSync(marker, { force: true });
});

test("a process stopped before it opened the chat (a reload's replacement) leaves the chat's run marker alone", async () => {
  const t = await setup({ open: false });
  const { inflightDir } = await import("./inflight");
  mkdirSync(inflightDir(), { recursive: true });
  const marker = join(inflightDir(), `${encodeURIComponent(t.id)}.json`);
  writeFileSync(marker, JSON.stringify({ v: 1, path: t.path, since: 1 }));
  await t.host.close("operator", { dispose: true });
  assert.ok(existsSync(marker));
  rmSync(marker, { force: true });
});

test("5e: with no server linked, a chat with something in flight keeps running", async () => {
  const t = await setup({ settings: { idleStopMin: 0.001 } });
  const tick = () => (t.host as unknown as { tick(): void }).tick();
  t.ctl.drop();
  await settle();
  // A run in flight (its turn starting stands in for a reply).
  const chat = t.host.heldChat()!;
  (chat as unknown as { starting: Promise<void> | null }).starting = new Promise(() => {});
  tick();
  await settle(120);
  tick();
  await settle(100);
  assert.deepEqual(t.exits, []);
  (chat as unknown as { starting: Promise<void> | null }).starting = null;
  tick();
  await settle(120);
  tick();
  await settle(100);
  assert.deepEqual(t.exits, ["idle"], "once nothing is in flight");
});

test("code: older than the server's build shows the badge and asks for a reload once quiet and alone", async () => {
  const t = await setup({ build: "a", serverBuild: "b" });
  const reloads = collect(t.ctl.server, "reload.request");
  const sends = collect(t.ctl.server, "client.send");
  t.ctl.server.send({ t: "client.attach", clientId: "k1", client: { clientId: "k1" } });
  await settle();
  const code = sends.map((s) => JSON.parse(s.json)).find((m) => m.type === "code");
  assert.deepEqual(code, { type: "code", state: "older" });
  // A pane is attached and the dwell is long: no automatic request yet. Reload now: quiet, so at once.
  (t.host as unknown as { check(): void }).check();
  assert.equal(reloads.length, 0);
  t.ctl.server.send({ t: "client.msg", clientId: "k1", msg: { type: "reload_code" } as never });
  await settle();
  assert.deepEqual(reloads, [{ t: "reload.request", auto: false }]);
  // The rollout says it failed: the panes hear it.
  t.ctl.server.send({ t: "push", kind: "code", state: "failed", detail: "boom" });
  await settle();
  assert.deepEqual(sends.map((s) => JSON.parse(s.json)).filter((m) => m.type === "code").at(-1), { type: "code", state: "failed", detail: "boom" });
});

test("code: Reload now whose drain is refused as busy asks again at the next quiet moment, not after the dwell", async () => {
  const t = await setup({ build: "a", serverBuild: "b" });
  const reloads = collect(t.ctl.server, "reload.request");
  const sends = collect(t.ctl.server, "client.send");
  t.ctl.server.send({ t: "client.attach", clientId: "k1", client: { clientId: "k1" } });
  await settle();
  t.ctl.server.send({ t: "client.msg", clientId: "k1", msg: { type: "reload_code" } as never });
  await settle();
  assert.deepEqual(reloads, [{ t: "reload.request", auto: false }]);
  // The rollout starts the replacement, then its drain is refused (a prompt arrived): code goes back to older.
  t.ctl.server.send({ t: "push", kind: "code", state: "reloading" });
  t.ctl.server.send({ t: "push", kind: "code", state: "older" });
  await settle();
  assert.deepEqual(sends.map((s) => JSON.parse(s.json)).filter((m) => m.type === "code").at(-1), { type: "code", state: "older", pending: true });
  // Quiet again with the pane still attached and the dwell long: Reload now's request, not the automatic rule's.
  (t.host as unknown as { check(): void }).check();
  await settle();
  assert.deepEqual(reloads, [{ t: "reload.request", auto: false }, { t: "reload.request", auto: false }]);
});

test("code: Reload now while quiet, then a reply before its drain: refused, the pane says pending, and the reload is asked at once when the chat is quiet again (t21r)", async () => {
  const t = await setup({ build: "a", serverBuild: "b" });
  const reloads = collect(t.ctl.server, "reload.request");
  const sends = collect(t.ctl.server, "client.send");
  const lastCode = () => sends.map((s) => JSON.parse(s.json)).filter((m) => m.type === "code").at(-1);
  // What makes the chat not quiet for a reload: here a working worker of another backend (it runs in this process).
  const live = join(agentDir, "sessions", "live", `test-${t.id}.json`);
  const busy = (on: boolean) =>
    on
      ? writeFileSync(live, JSON.stringify({ session: { pid: process.pid, sessionFile: t.path, sessionId: t.id }, heartbeat: Date.now() + 60_000, presence: { workerCounts: { total: 1, working: 1 }, workers: [{ id: "ag_01", name: "w", status: "running", backend: "native-cli" }] } }))
      : rmSync(live, { force: true });
  const tick = () => (t.host as unknown as { tick(): void }).tick();
  t.ctl.server.send({ t: "client.attach", clientId: "k1", client: { clientId: "k1" } });
  await settle();
  t.ctl.server.send({ t: "client.msg", clientId: "k1", msg: { type: "reload_code" } as never });
  await settle();
  assert.deepEqual(reloads, [{ t: "reload.request", auto: false }], "quiet: asked at once");
  // The replacement boots; meanwhile the chat stops being quiet. The rollout's drain is refused.
  t.ctl.server.send({ t: "push", kind: "code", state: "reloading" });
  busy(true);
  tick();
  await settle();
  const refused = awaitFrame(t.ctl.server, "drained", 2_000);
  t.ctl.server.send({ t: "drain", id: "d1", reason: "reload", force: false });
  assert.deepEqual(await refused, { t: "drained", id: "d1", ok: false, why: "busy" });
  t.ctl.server.send({ t: "push", kind: "code", state: "older" });
  await settle();
  assert.deepEqual(lastCode(), { type: "code", state: "older", pending: true }, "Reloads after this reply");
  tick();
  await settle();
  assert.equal(reloads.length, 1, "not while busy");
  // Quiet again, the pane attached and the dwell long: Reload now's request at once.
  busy(false);
  tick();
  await settle();
  assert.deepEqual(reloads, [{ t: "reload.request", auto: false }, { t: "reload.request", auto: false }]);
});

test("code: a reload, or its failure, ends with the server that ran it: the next server sees plain older code and asks again", async () => {
  const t = await setup({ build: "a", serverBuild: "b" });
  const check = () => (t.host as unknown as { check(): void }).check();
  t.ctl.server.send({ t: "push", kind: "code", state: "reloading" });
  await settle();
  // The same server's link coming back: its reload still runs.
  t.ctl.drop();
  await settle();
  const same = t.connect(null, "b");
  const sameStates = collect(same.server, "state");
  const sameReloads = collect(same.server, "reload.request");
  await settle();
  check();
  await settle();
  assert.equal(sameStates.at(-1)?.mirror.code.state, "reloading");
  assert.equal(sameReloads.length, 0);
  // The server restarts mid-reload: the next one (another pid) sees older code, and nobody attached, so it is asked at once.
  same.drop();
  await settle();
  const next = t.connect(null, "b", undefined, 2);
  const nextStates = collect(next.server, "state");
  const nextReloads = collect(next.server, "reload.request");
  await settle();
  check();
  await settle();
  assert.equal(nextStates.at(-1)?.mirror.code.state, "older");
  assert.deepEqual(nextReloads, [{ t: "reload.request", auto: true }]);
  // That reload fails; the server after it starts clean too.
  next.server.send({ t: "push", kind: "code", state: "failed", detail: "boom" });
  await settle();
  next.drop();
  await settle();
  const third = t.connect(null, "b", undefined, 3);
  const thirdStates = collect(third.server, "state");
  await settle();
  check();
  await settle();
  assert.equal(thirdStates.at(-1)?.mirror.code.state, "older");
});

test("code: a reload asked for but not yet begun when the server restarts is asked of the next server: Reload now's as auto false, else the automatic one", async () => {
  // Reload now pressed during a reply (a working worker of another backend holds it), asked once the reply ends.
  const t = await setup({ build: "a", serverBuild: "b" });
  const live = join(agentDir, "sessions", "live", `test-${t.id}.json`);
  writeFileSync(live, JSON.stringify({ session: { pid: process.pid, sessionFile: t.path, sessionId: t.id }, heartbeat: Date.now() + 60_000, presence: { workerCounts: { total: 1, working: 1 }, workers: [{ id: "ag_01", name: "w", status: "running", backend: "native-cli" }] } }));
  const tick = () => (t.host as unknown as { tick(): void }).tick();
  const reloads = collect(t.ctl.server, "reload.request");
  t.ctl.server.send({ t: "client.attach", clientId: "k1", client: { clientId: "k1" } });
  await settle();
  tick();
  await settle();
  t.ctl.server.send({ t: "client.msg", clientId: "k1", msg: { type: "reload_code" } as never });
  await settle();
  assert.equal(reloads.length, 0, "held by the reply");
  rmSync(live, { force: true });
  tick();
  await settle();
  assert.deepEqual(reloads, [{ t: "reload.request", auto: false }], "asked as the reply ends");
  // The server goes before it begins the reload (no push), and another server takes control.
  t.ctl.drop();
  await settle();
  const next = t.connect(null, "b", undefined, 2);
  const nextReloads = collect(next.server, "reload.request");
  await settle(150);
  tick();
  await settle();
  assert.deepEqual(nextReloads, [{ t: "reload.request", auto: false }]);

  // No Reload now and no pane: the automatic request, asked again of the next server.
  const u = await setup({ build: "a", serverBuild: "b" });
  const uReloads = collect(u.ctl.server, "reload.request");
  (u.host as unknown as { check(): void }).check();
  await settle();
  assert.deepEqual(uReloads, [{ t: "reload.request", auto: true }]);
  u.ctl.drop();
  await settle();
  const uNext = u.connect(null, "b", undefined, 2);
  const uNextReloads = collect(uNext.server, "reload.request");
  await settle(150);
  (u.host as unknown as { check(): void }).check();
  await settle();
  assert.deepEqual(uNextReloads, [{ t: "reload.request", auto: true }]);
});

test("code: Reload now pressed while an automatic reload is under way stands: refused at the drain, it asks again at the next quiet moment (t21r)", async () => {
  const t = await setup({ build: "a", serverBuild: "b" });
  const reloads = collect(t.ctl.server, "reload.request");
  const sends = collect(t.ctl.server, "client.send");
  // Nobody attached: the automatic request at once.
  (t.host as unknown as { check(): void }).check();
  await settle();
  assert.deepEqual(reloads, [{ t: "reload.request", auto: true }]);
  t.ctl.server.send({ t: "push", kind: "code", state: "reloading" });
  await settle();
  // A pane attaches and presses Reload now while that reload runs.
  t.ctl.server.send({ t: "client.attach", clientId: "k1", client: { clientId: "k1" } });
  await settle();
  t.ctl.server.send({ t: "client.msg", clientId: "k1", msg: { type: "reload_code" } as never });
  await settle();
  // The drain is refused (a reply started), the replacement goes: older again.
  t.ctl.server.send({ t: "push", kind: "code", state: "older" });
  await settle();
  assert.deepEqual(sends.map((s) => JSON.parse(s.json)).filter((m) => m.type === "code").at(-1), { type: "code", state: "older", pending: true });
  // Quiet, the pane attached, the dwell long: Reload now's request at once.
  (t.host as unknown as { check(): void }).check();
  await settle();
  assert.deepEqual(reloads, [{ t: "reload.request", auto: true }, { t: "reload.request", auto: false }]);
});

test("a call that reaches a process closing for a reload goes unanswered, so the handle sends it to the replacement (never 'This chat is closed.')", async () => {
  const t = await setup();
  const replies = collect(t.ctl.server, "reply");
  // Closing for a reload: its chat is disposed before it says it exits.
  void t.host.close("reload", { dispose: true });
  await settle(150);
  t.ctl.server.send({ t: "call", call: { id: "late", epoch: t.ctl.epoch, chatId: t.path, method: "reacquire", args: { force: false } } as never });
  await settle(150);
  assert.deepEqual(replies.filter((r) => r.reply.id === "late"), [], "no answer: the handle resends it to the replacement");
});

test("code: workers in processes of their own never hold a reload (they're reattached); another backend's working worker does; idle stop waits for both", async () => {
  /** This process's live record for the chat, with one worker of `backend` working. */
  const liveRecord = (t: { path: string; id: string }, backend: string) =>
    writeFileSync(
      join(agentDir, "sessions", "live", `test-${t.id}.json`),
      JSON.stringify({
        session: { pid: process.pid, sessionFile: t.path, sessionId: t.id },
        heartbeat: Date.now() + 60_000,
        presence: { workerCounts: { total: 1, working: 1 }, workers: [{ id: "ag_01", name: "w", status: "running", backend }] },
      }),
    );
  const tick = (t: { host: unknown }) => (t.host as { tick(): void }).tick();

  const a = await setup({ build: "a", serverBuild: "b" });
  liveRecord(a, "pi");
  const aReloads = collect(a.ctl.server, "reload.request");
  const aStates = collect(a.ctl.server, "state");
  a.ctl.server.send({ t: "client.attach", clientId: "k1", client: { clientId: "k1" } });
  await settle();
  tick(a);
  await settle();
  assert.equal(aStates.at(-1)?.mirror.quiet.quiet, false, "a working worker still keeps the chat from an idle stop");
  assert.equal(aStates.at(-1)?.mirror.quiet.workersWorking, 0, "nothing holds the reload");
  const busy = awaitFrame(a.ctl.server, "drained", 2_000);
  a.ctl.server.send({ t: "drain", id: "d1", reason: "idle", force: false });
  assert.deepEqual(await busy, { t: "drained", id: "d1", ok: false, why: "busy" });
  a.ctl.server.send({ t: "client.msg", clientId: "k1", msg: { type: "reload_code" } as never });
  await settle();
  assert.deepEqual(aReloads, [{ t: "reload.request", auto: false }], "Reload now: at once, mid worker run");

  const b = await setup({ build: "a", serverBuild: "b" });
  liveRecord(b, "native-cli");
  const bReloads = collect(b.ctl.server, "reload.request");
  const bStates = collect(b.ctl.server, "state");
  const bSends = collect(b.ctl.server, "client.send");
  b.ctl.server.send({ t: "client.attach", clientId: "k1", client: { clientId: "k1" } });
  await settle();
  tick(b);
  await settle();
  assert.equal(bStates.at(-1)?.mirror.quiet.workersWorking, 1, "Reloads when its worker finishes");
  b.ctl.server.send({ t: "client.msg", clientId: "k1", msg: { type: "reload_code" } as never });
  await settle();
  assert.equal(bReloads.length, 0, "a worker inside this process would end with it");
  assert.deepEqual(bSends.map((s) => JSON.parse(s.json)).filter((m) => m.type === "code").at(-1), { type: "code", state: "older", pending: true });
  const refused = awaitFrame(b.ctl.server, "drained", 2_000);
  b.ctl.server.send({ t: "drain", id: "d2", reason: "reload", force: false });
  assert.deepEqual(await refused, { t: "drained", id: "d2", ok: false, why: "busy" });
  rmSync(join(agentDir, "sessions", "live", `test-${a.id}.json`), { force: true });
  rmSync(join(agentDir, "sessions", "live", `test-${b.id}.json`), { force: true });
});

test("code: a current chat answers Reload now with current, to that pane only", async () => {
  const t = await setup();
  const sends = collect(t.ctl.server, "client.send");
  t.ctl.server.send({ t: "client.attach", clientId: "k1", client: { clientId: "k1" } });
  await settle();
  assert.equal(sends.map((s) => JSON.parse(s.json)).filter((m) => m.type === "code").length, 0, "current: no code message");
  t.ctl.server.send({ t: "client.msg", clientId: "k1", msg: { type: "reload_code" } as never });
  await settle();
  assert.deepEqual(sends.map((s) => JSON.parse(s.json)).filter((m) => m.type === "code"), [{ type: "code", state: "current" }]);
});

// ---- stage 3: the transport a special loadout's chat rides ---------------------------------------

test("wait-asks: queued with no server, written to the next controller, answered; not quiet meanwhile", async () => {
  const t = await setup({ settings: { serverToolWaitMs: 400 } });
  t.ctl.drop();
  await settle();
  const asked = t.host.waitAsk("special.runStart", { leafId: "a1", images: false });
  await settle(30);
  const next = t.connect();
  const asks = collect(next.server, "ask");
  const states = collect(next.server, "state");
  await settle();
  assert.equal(asks.length, 1);
  assert.equal(asks[0]!.method, "special.runStart");
  assert.deepEqual(asks[0]!.args, { leafId: "a1", images: false });
  assert.equal(states.at(-1)?.mirror.quiet.quiet, false, "a wait-ask in flight is not quiet");
  assert.equal(states.at(-1)?.mirror.quiet.hooks, 1);
  const answer = { prompt: { appendSystemPrompt: "p" } };
  next.server.send({ t: "answer", id: asks[0]!.id, ok: true, result: answer });
  assert.deepEqual(await asked, answer);
  await settle();
  assert.equal(states.at(-1)?.mirror.quiet.quiet, true);
  assert.equal(states.at(-1)?.mirror.quiet.hooks, 0);

  // Written, then the server went: written again to the next one.
  const again = t.host.waitAsk("special.compact", { leafId: null });
  await settle();
  next.drop();
  await settle();
  const third = t.connect();
  const asks3 = collect(third.server, "ask");
  await settle();
  assert.equal(asks3.length, 1);
  third.server.send({ t: "answer", id: asks3[0]!.id, ok: false, error: { message: "nope" } });
  await assert.rejects(again, /nope/);

  // No server in time: fails with the not-run text.
  third.drop();
  await settle();
  await assert.rejects(t.host.waitAsk("powers.sessions", {}), (e: Error) => e.message === NOT_RUN_NO_SERVER);
});

test("run events: facts kept until acked and written again first at the next control; ticks dropped without a server", async () => {
  // The served call and the wait-ask fail serverToolWaitMs after the last controller drops (the end of
  // the test waits for that); the steps between their making and that drop take a few settles.
  const t = await setup({ settings: { serverToolWaitMs: 800 } });
  const runs = collect(t.ctl.server, "run");
  t.host.runEvent({ type: "run.start", tag: "look:1" });
  t.host.runEvent({ type: "entry.appended" });
  t.host.runEvent({ type: "user.entered", card: null });
  await settle();
  assert.deepEqual(runs.map((f) => [f.n, f.event.type]), [[1, "run.start"], [2, "entry.appended"], [3, "user.entered"]]);
  t.ctl.server.send({ t: "run.ack", n: 1 });
  await settle();
  t.ctl.drop();
  await settle();
  // Without a server: facts wait, ticks go nowhere.
  t.host.runEvent({ type: "message.end" });
  t.host.runEvent({ type: "run.settled" });
  // A served call and a wait-ask made meanwhile go after the facts.
  const tool = serverToolSpec(t.path, { name: "trial_tool", label: "Trial", description: "d", parameters: { type: "object" } });
  const ran = tool.execute("tc-r", {}, undefined, undefined, undefined);
  const asked = t.host.waitAsk("special.agentEnd", { text: "x" });
  const next = t.connect();
  const order: string[] = [];
  for (const type of ["state", "run", "ask", "tool.call"] as const) next.server.on(type, (f) => order.push(type === "run" ? `run ${(f as FrameOf<"run">).n}` : type));
  const states = collect(next.server, "state");
  await settle();
  assert.deepEqual(order, ["state", "run 3", "run 4", "ask", "tool.call"], "state, unacked facts in order, asks, then calls");
  assert.equal(states.at(-1)?.mirror.quiet.quiet, false);
  next.server.send({ t: "run.ack", n: 4 });
  await settle();
  assert.equal(states.at(-1)?.mirror.quiet.outbox, 0);
  next.drop();
  await Promise.all([assert.rejects(ran), assert.rejects(asked)]);
});

test("the reply's text is coalesced, and what waits goes before the next event", async () => {
  const t = await setup();
  const runs = collect(t.ctl.server, "run");
  for (const text of ["a", "ab", "abc"]) t.host.runEvent({ type: "reply.text", text });
  t.host.runEvent({ type: "message.end" });
  await settle(10);
  assert.deepEqual(runs.map((f) => f.event), [{ type: "reply.text", text: "abc" }, { type: "message.end" }]);
  t.host.runEvent({ type: "reply.text", text: "abcd" });
  await settle(10);
  assert.equal(runs.length, 2, "not yet: at most one every 100 ms");
  await settle(150);
  assert.deepEqual(runs.at(-1)?.event, { type: "reply.text", text: "abcd" });
  assert.deepEqual(runs.map((f) => f.n), [1, 2, 3]);
});

test("a stage-2 server gets no run events, wait-asks or actions; a special open is refused", async () => {
  const t = await setup({ proto: 1, settings: { serverToolWaitMs: 200 } });
  const runs = collect(t.ctl.server, "run");
  const asks = collect(t.ctl.server, "ask");
  const calls = collect(t.ctl.server, "tool.call");
  t.host.runEvent({ type: "run.start" });
  const asked = t.host.waitAsk("special.runStart", { leafId: null, images: false });
  const acted = t.host.action("@saveChoice", { model: "x" });
  await settle();
  assert.equal(runs.length + asks.length + calls.length, 0);
  await assert.rejects(asked, (e: Error) => e.message === NOT_RUN_NO_SERVER);
  assert.deepEqual(await acted, { ok: false, error: { message: NOT_RUN_NO_SERVER } });
  const t2 = await setup({ proto: 1, open: false });
  const opened = awaitFrame(t2.ctl.server, "opened", 2_000);
  t2.ctl.server.send({ t: "open", id: "o9", path: t2.path, force: true, link: null, served: [], special: { kind: "baton" } as never });
  const f = await opened;
  assert.equal(f.ok, false);
});

test("actions: a call under an effect id of their own; unknown after a drop, never sent again", async () => {
  const t = await setup({ settings: { serverToolWaitMs: 2_000 } });
  const calls = collect(t.ctl.server, "tool.call");
  const sent = t.host.action("@clientSend", { images: 0, text: "hi" });
  await settle();
  assert.equal(calls.length, 1);
  const c = calls[0]!.call;
  assert.equal(c.name, "@clientSend");
  assert.equal(c.toolCallId, "@clientSend");
  assert.deepEqual(c.params, { images: 0, text: "hi" });
  assert.match(c.effectId, /#@clientSend#/);
  // The server answers an action with the action's own result.
  t.ctl.server.send({ t: "tool.result", effectId: c.effectId, outcome: { ok: true, result: { by: "op" } } });
  assert.deepEqual(await sent, { ok: true, result: { by: "op" } });

  const lost = t.host.action("@saveChoice", { thinking: "high" });
  await settle();
  t.ctl.drop();
  await settle();
  const next = t.connect();
  const nextCalls = collect(next.server, "tool.call");
  assert.deepEqual(await lost, { ok: false, unknown: true, error: { message: OUTCOME_UNKNOWN } });
  await settle();
  assert.equal(nextCalls.length, 0);
});

test("call-backs: an append within a served call answers its entry and moves the leaf; a nested tool runs inside the call; a call-back for a settled call is refused", async () => {
  const decl: ServerToolDecl = { name: "trial_nested", label: "Nested", description: "d", parameters: { type: "object" } };
  const t = await setup({ served: [decl] });
  const calls = collect(t.ctl.server, "tool.call");
  const backs = collect(t.ctl.server, "tool.backResult");
  const parent = serverToolSpec(t.path, { name: "trial_parent", label: "Parent", description: "d", parameters: { type: "object" } });
  const ran = parent.execute("tc-p", {}, undefined, undefined, undefined);
  await settle();
  const effectId = calls[0]!.call.effectId;

  t.ctl.server.send({ t: "tool.back", effectId, id: "b1", op: "append", kind: "sova-fanout-member", data: { who: "x" }, announce: false });
  await settle();
  const b1 = backs.find((b) => b.id === "b1")!;
  assert.ok(b1.ok, JSON.stringify(b1));
  if (b1.ok) {
    const r = b1.result as { entryId: string; entry: { id: string } };
    assert.equal(r.entry.id, r.entryId);
    assert.equal(t.host.heldChat()!.leafId(), r.entryId);
  }
  t.ctl.server.send({ t: "tool.back", effectId, id: "b2", op: "append", kind: "no-such-kind", data: {}, announce: false });
  t.ctl.server.send({ t: "tool.back", effectId, id: "b3", op: "append", kind: "sova-fanout-member", data: {}, announce: true });
  t.ctl.server.send({ t: "tool.back", effectId, id: "b4", op: "tool", name: "no_such_tool", toolCallId: "n1", params: {} });
  await settle();
  assert.deepEqual(backs.find((b) => b.id === "b2"), { t: "tool.backResult", id: "b2", ok: false, error: { message: "Unknown state kind: no-such-kind" } });
  assert.equal(backs.find((b) => b.id === "b3")?.ok, false, "an ordinary chat has no special writer");
  assert.deepEqual(backs.find((b) => b.id === "b4"), { t: "tool.backResult", id: "b4", ok: false, error: { message: "No such tool in this chat: no_such_tool" } });

  // The chat's own registered tool (a served one here): run inside the parent call; its own call goes to the server.
  t.ctl.server.send({ t: "tool.back", effectId, id: "b5", op: "tool", name: "trial_nested", toolCallId: "n2", params: { q: 1 } });
  await settle();
  const nested = calls.find((c) => c.call.name === "trial_nested");
  assert.ok(nested, "the nested tool's call reached the server");
  t.ctl.server.send({ t: "tool.result", effectId: nested!.call.effectId, outcome: { ok: true, result: { content: [{ type: "text", text: "inner" }], details: null } } });
  await settle();
  assert.deepEqual(backs.find((b) => b.id === "b5"), { t: "tool.backResult", id: "b5", ok: true, result: { content: [{ type: "text", text: "inner" }], details: null } });

  t.ctl.server.send({ t: "tool.result", effectId, outcome: { ok: true, result: { content: [], details: null } } });
  await ran;
  t.ctl.server.send({ t: "tool.back", effectId, id: "b6", op: "append", kind: "sova-fanout-member", data: {}, announce: false });
  await settle();
  assert.deepEqual(backs.find((b) => b.id === "b6"), { t: "tool.backResult", id: "b6", ok: false, error: { message: GONE_CALL } });
});

test("session powers in a chat process: reads wait for the server; a send is an action whose unknown outcome keeps the spend", async () => {
  const t = await setup({ settings: { serverToolWaitMs: 2_000 } });
  const { sessionPowersTools, SessionLimits, RunState } = await import("../session-powers");
  const { DEFAULT_LIMITS } = await import("../../shared/profiles");
  const profile = { id: "p", label: "P", icon: "branch", description: "", remove: [], grant: ["sessions.read", "sessions.message", "sessions.all"], singleton: false, limits: DEFAULT_LIMITS, overseerMayStart: false } as never;
  const limits = new SessionLimits("me", DEFAULT_LIMITS, null);
  const tools = sessionPowersTools({ sessionId: "me", cwd, title: () => "me", profile, run: new RunState(limits), limits }, () => join(agentDir, "actions.jsonl"));
  const asks = collect(t.ctl.server, "ask");
  const calls = collect(t.ctl.server, "tool.call");
  const other = { id: "s2", path: "/s/s2", cwd, title: "Other", lastActiveAt: "2026-10-12T00:00:00.000Z", archived: false, busy: false };
  const answer = (method: string, result: unknown) => {
    const a = asks.find((x) => x.method === method && !(x as { done?: true }).done)!;
    (a as { done?: true }).done = true;
    t.ctl.server.send({ t: "answer", id: a.id, ok: true, result });
  };

  // session_list: the sessions and what this server hosts, asked of the server.
  const listed = tools.find((x) => x.name === "session_list")!.execute("l1", {}, undefined, undefined, undefined as never);
  await settle();
  answer("powers.sessions", [other]);
  await settle();
  answer("powers.held", { streaming: true, queued: 0 });
  const out = ((await listed).content[0] as { text: string }).text;
  assert.match(out, /^1 session\.\n- s2 · "Other" · .* · hosted here$/);

  // session_send delivered: the server's PowersHost.send result, the action's own result, is the tool's answer.
  const delivered = tools.find((x) => x.name === "session_send")!.execute("s0", { session: "s2", text: "first" }, undefined, undefined, undefined as never);
  await settle();
  answer("powers.session", other);
  await settle();
  const first = calls.find((c) => c.call.name === "@powers.send")!;
  t.ctl.server.send({ t: "tool.result", effectId: first.call.effectId, outcome: { ok: true, result: { ok: true, queued: false, kind: "prompt" } } });
  const okResult = await delivered;
  assert.match((okResult.content[0] as { text: string }).text, /^Sent to \[Other\]\(sova:\/\/s\/s2\) \(hop 1\)\.$/);
  assert.equal(limits.counts().own, 1);
  calls.length = 0;

  // session_send: resolved through the server, sent as @powers.send; the server stops mid-send.
  const sending = tools.find((x) => x.name === "session_send")!.execute("s1", { session: "s2", text: "hello" }, undefined, undefined, undefined as never);
  await settle();
  answer("powers.session", other);
  await settle();
  const send = calls.find((c) => c.call.name === "@powers.send")!;
  assert.ok(send, "the send is an action");
  const p = send.call.params as { path: string; text: string; from: { sessionId: string; hop: number }; invite: { target: string; text: string } };
  assert.equal(p.path, "/s/s2");
  assert.match(p.text, /\nhello$/);
  assert.deepEqual(p.invite, { target: "s2", text: "hello" });
  assert.equal(limits.counts().own, 2, "spent before the hand-off");
  t.ctl.drop();
  await settle();
  t.connect();
  await assert.rejects(sending, (e: Error) => e.message === OUTCOME_UNKNOWN);
  assert.equal(limits.counts().own, 2, "an unknown outcome keeps the spend");
});

test("push special: the server's word on a special chat's composer reaches the chat's spec", async () => {
  const t = await setup();
  setSpecialSpec(t.path, { kind: "project-overseer", composerClosed: null } as never);
  t.ctl.server.send({ t: "push", kind: "special", composerClosed: "This project is archived." });
  await settle();
  assert.equal(specialSpecOf(t.path)?.composerClosed, "This project is archived.");
  t.ctl.server.send({ t: "push", kind: "special", composerClosed: null });
  await settle();
  assert.equal(specialSpecOf(t.path)?.composerClosed, null);
  setSpecialSpec(t.path, null);
});

test("a link opened while the chat booted hears one hello saying ready when control comes after the boot; a link opened ready hears none", async () => {
  const s = session();
  // The boot has ended: the host exists and is ready, and its server's control hasn't come yet.
  const host = new ChatRuntimeHost({ path: s.path, sessionId: s.id, unit: "u", build: "b1", startedAt: 1, exit: () => {}, log: quiet, tickMs: 60_000 });
  const control = (e: number) => ({ t: "control" as const, proto: CHAT_WIRE_PROTO, epoch: e, serverPid: 1, serverStartedAt: 1, build: "b1", since: null, settings: DEFAULT_RUNTIME_SETTINGS });
  const link = (said: "booting" | "ready") => {
    const [a, b] = pair();
    const runtimeEnd = new Link(a as never, { log: quiet });
    const server = new Link(b as never, { log: quiet });
    const states = collect(server, "hello");
    // As serveLink does: the link's first frame, sent as the connection came, with the state then.
    runtimeEnd.send({ t: "hello", proto: CHAT_WIRE_PROTO, minProto: CHAT_WIRE_PROTO - 1, epoch: 0, ...host.hello(), state: said });
    return { runtimeEnd, states };
  };
  const booted = link("booting");
  host.onControl(booted.runtimeEnd, control(++epoch));
  await settle();
  assert.deepEqual(booted.states.map((h) => h.state), ["booting", "ready"], "one ready hello, after the booting one");
  // The next server's link, opened once the chat was ready: its opening hello says so, and no other comes.
  const ready = link("ready");
  host.onControl(ready.runtimeEnd, control(++epoch));
  await settle();
  assert.deepEqual(ready.states.map((h) => h.state), ["ready"]);
  assert.deepEqual(booted.states.map((h) => h.state), ["booting", "ready"], "nothing more on the old link");
});

test("taking control that throws partway still says the state once on a link whose opening hello said booting", async () => {
  const control = (e: number) => ({ t: "control" as const, proto: CHAT_WIRE_PROTO, epoch: e, serverPid: 1, serverStartedAt: 1, build: "b1", since: null, settings: DEFAULT_RUNTIME_SETTINGS });
  const booted = (host: InstanceType<typeof ChatRuntimeHost>) => {
    const [a, b] = pair();
    const runtimeEnd = new Link(a as never, { log: quiet });
    const server = new Link(b as never, { log: quiet });
    const hellos = collect(server, "hello");
    runtimeEnd.send({ t: "hello", proto: CHAT_WIRE_PROTO, minProto: CHAT_WIRE_PROTO - 1, epoch: 0, ...host.hello(), state: "booting" });
    return { runtimeEnd, hellos };
  };
  /** `method` throws while `run` runs (the host's own timers call it again later: put back after). */
  const throwsOnce = (host: object, method: string, run: () => void) => {
    const own = host as Record<string, unknown>;
    own[method] = () => {
      throw new Error("boom");
    };
    try {
      assert.throws(run, /boom/);
    } finally {
      delete own[method];
    }
  };
  // Booted, no chat yet: the server's build is taken first on every compatible link.
  const s = session();
  const fresh = new ChatRuntimeHost({ path: s.path, sessionId: s.id, unit: "u", build: "b1", startedAt: 1, exit: () => {}, log: quiet, tickMs: 60_000 });
  const one = booted(fresh);
  const e1 = ++epoch;
  throwsOnce(fresh, "setServerBuild", () => fresh.onControl(one.runtimeEnd, control(e1)));
  await settle();
  assert.deepEqual(one.hellos.map((h) => [h.state, h.epoch]), [["booting", 0], ["ready", e1]], "one hello saying ready, with this control's epoch");
  // A chat open: its state goes to the new server, and that throws.
  const t = await setup();
  const two = booted(t.host);
  const e2 = ++epoch;
  throwsOnce(t.host, "sendState", () => t.host.onControl(two.runtimeEnd, control(e2)));
  await settle();
  assert.deepEqual(two.hellos.map((h) => [h.state, h.epoch]), [["booting", 0], ["open", e2]]);
});
