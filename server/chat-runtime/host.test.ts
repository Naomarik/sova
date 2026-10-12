// Run: pnpm test -- server/chat-runtime/host.test.ts. A chat process's host, its socket replaced by an
// in-memory stream pair (the unit tier opens no sockets), the chat opened through chat-manager on a
// throwaway PI_CODING_AGENT_DIR with no credentials (no model is ever called). The test plays the
// server: control, open, calls, browsers, server-hosted tools, drains.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { after, test } from "node:test";
import type { ServerToolDecl } from "../../shared/chat-runtime";
import { type ChatRuntimeSettings, DEFAULT_RUNTIME_SETTINGS, type ExitCause, type FrameOf, NOT_RUN_NO_SERVER, OUTCOME_UNKNOWN } from "../../shared/chat-runtime-wire";

const agentDir = mkdtempSync(join(tmpdir(), "sova-chat-host-test-"));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths
const sessionsDir = join(agentDir, "sessions", "--tmp-chathost--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });

const { ChatRuntimeHost } = await import("./host");
const { Link, awaitFrame } = await import("./link");
const { disposeAllChats, serverToolSpec } = await import("../chat-manager");
const { canonicalPath } = await import("../paths");
const { readInflight } = await import("./inflight");

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
async function setup(o: { build?: string; serverBuild?: string; settings?: Partial<ChatRuntimeSettings>; open?: boolean } = {}) {
  const s = session();
  const exits: ExitCause[] = [];
  const host = new ChatRuntimeHost({ path: s.path, sessionId: s.id, unit: "u", build: o.build ?? "b1", startedAt: 1, exit: (c) => exits.push(c), log: quiet, tickMs: 60_000 });
  const settings = { ...DEFAULT_RUNTIME_SETTINGS, ...o.settings };
  const connect = (since: number | null = null, build = o.serverBuild ?? o.build ?? "b1") => {
    const [a, b] = pair();
    const runtimeEnd = new Link(a as never, { log: quiet });
    const server = new Link(b as never, { log: quiet });
    const e = ++epoch;
    host.onControl(runtimeEnd, { t: "control", proto: 1, epoch: e, serverPid: 1, serverStartedAt: 1, build, since, settings });
    return { server, runtimeEnd, epoch: e, drop: () => (a.destroy(), b.destroy()) };
  };
  const ctl = connect();
  if (o.open !== false) {
    const opened = awaitFrame(ctl.server, "opened", 5_000);
    ctl.server.send({ t: "open", id: "o1", path: s.path, force: true, link: null, served: [] });
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
  return { ...s, host, exits, ctl, connect, call };
}

/** Collect a link's frames of one type. */
function collect<T extends FrameOf<"client.send">["t"] | "state" | "event" | "events.gap" | "reload.request" | "tool.call" | "exit" | "drained">(link: InstanceType<typeof Link>, t: T) {
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

test("drain: refused with a pane attached for idle; otherwise the chat closes and says why", async () => {
  const t = await setup();
  t.ctl.server.send({ t: "client.attach", clientId: "k1", client: { clientId: "k1" } });
  await settle();
  const refused = awaitFrame(t.ctl.server, "drained", 2_000);
  t.ctl.server.send({ t: "drain", id: "d1", reason: "idle", force: false });
  assert.deepEqual(await refused, { t: "drained", id: "d1", ok: false, why: "attached" });
  t.ctl.server.send({ t: "client.detach", clientId: "k1" });
  const ok = awaitFrame(t.ctl.server, "drained", 2_000);
  const exit = awaitFrame(t.ctl.server, "exit", 2_000);
  t.ctl.server.send({ t: "drain", id: "d2", reason: "idle", force: false });
  assert.deepEqual(await ok, { t: "drained", id: "d2", ok: true });
  assert.deepEqual(await exit, { t: "exit", cause: "idle" });
  assert.deepEqual(t.exits, ["idle"]);
  assert.equal(t.host.hosting, false);
  assert.equal(readInflight(t.id), null);
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
