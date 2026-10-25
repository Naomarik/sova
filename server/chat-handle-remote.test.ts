// Run: pnpm test -- server/chat-handle-remote.test.ts. A chat in a process of its own as the server talks
// to it (§app.chat-processes/server-messages, §app.chat-processes/special-kinds), over a fake link: a
// command waits for a relink, a keyed send or a turn's end whose answer was lost goes once more, an ended
// handle refuses at once; a special chat's run events reach its kind once, acknowledged; a served call's
// writes are calls back into the chat and move the call's own view of the branch.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ChatRunEvent, ServerToolCall } from "../shared/chat-runtime";
import type { ChatRuntimeMirror, ChatWireFrame, ChatWireType, FrameOf } from "../shared/chat-runtime-wire";
import type { LinkEnd } from "./chat-runtime/link";

const agentDir = mkdtempSync(join(tmpdir(), "sova-chat-handle-remote-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions"), { recursive: true });
after(() => {});

const { RemoteChatHandle, UNREACHABLE } = await import("./chat-handle-remote");
const { registerSpecialHost, serveTools } = await import("./chat-handle");
const { BATON } = await import("./harness/state-kinds");

/** A link a test drives: what the handle sends is recorded; `deliver` plays the chat's frames. */
class FakeLink {
  sent: ChatWireFrame[] = [];
  isOpen = true;
  compatible = true;
  peerProto = 2;
  private handlers = new Map<string, ((f: unknown) => void)[]>();
  private end!: (e: LinkEnd) => void;
  readonly closed: Promise<LinkEnd> = new Promise((r) => (this.end = r));
  on<T extends ChatWireType>(t: T, fn: (f: FrameOf<T>) => void): () => void {
    const list = this.handlers.get(t) ?? [];
    list.push(fn as (f: unknown) => void);
    this.handlers.set(t, list);
    return () => this.handlers.set(t, (this.handlers.get(t) ?? []).filter((x) => x !== fn));
  }
  send(f: ChatWireFrame): boolean {
    if (!this.isOpen) return false;
    this.sent.push(f);
    return true;
  }
  deliver(f: ChatWireFrame): void {
    for (const fn of this.handlers.get(f.t) ?? []) fn(f);
  }
  close(): void {
    this.drop();
  }
  drop(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.end({ reason: "lost" });
  }
  calls = () => this.sent.filter((f): f is FrameOf<"call"> => f.t === "call");
}

let seq = 0;
function sessionFile(): string {
  const path = join(agentDir, "sessions", `s${++seq}.jsonl`);
  const lines = [
    { type: "session", version: 3, id: `sid-${seq}`, timestamp: "2026-10-12T00:00:00.000Z", cwd: agentDir },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-10-12T00:00:01.000Z", message: { role: "user", content: "hi", timestamp: 1 } },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return path;
}

const mirror = (o: Partial<ChatRuntimeMirror> = {}): ChatRuntimeMirror => ({ sessionId: "sid", special: null, closed: false, ...o }) as unknown as ChatRuntimeMirror;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function handle(o: { special?: ChatRuntimeMirror["special"]; path?: string } = {}) {
  const link = new FakeLink();
  const path = o.path ?? sessionFile();
  const h = new RemoteChatHandle(path, path, { unit: "u", pid: 1 }, link as never, mirror({ special: o.special ?? null }), 7);
  return { h, link, path };
}

test("a command made while the link is down waits for the relink, then goes", async () => {
  const { h, link } = handle();
  link.drop();
  await tick();
  const p = h.call("abort", {});
  const next = new FakeLink();
  h.repoint(next as never);
  await tick();
  const [c] = next.calls();
  assert.equal(c?.call.method, "abort");
  next.deliver({ t: "reply", reply: { id: c!.call.id, ok: true, result: null } });
  assert.equal(await p, null);
  assert.equal(link.calls().length, 0);
});

test("a keyed send whose answer was lost goes once more after the relink; an unkeyed command fails", async () => {
  const { h, link } = handle();
  const keyed = h.send({ text: "brief", origin: "server", key: "brief:1" });
  const plain = h.call("abort", {});
  assert.equal(link.calls().length, 2);
  link.drop();
  await assert.rejects(plain, (e: Error) => e.message === UNREACHABLE);
  const next = new FakeLink();
  h.repoint(next as never);
  const [again] = next.calls();
  assert.equal(again?.call.method, "send");
  assert.equal((again!.call.args as { key?: string }).key, "brief:1");
  next.deliver({ t: "reply", reply: { id: again!.call.id, ok: true, result: { queued: false, turnId: "t1" } } });
  assert.deepEqual(await keyed, { queued: false, turnId: "t1" });
  assert.equal(next.calls().length, 1, "once, not again");
});

test("a command made while a reload swaps the process waits for the replacement, never failing as unreachable", async () => {
  const { h, link } = handle();
  link.deliver({ t: "exit", cause: "reload" } as never);
  link.drop();
  await tick();
  assert.equal(h.closed, false, "the reload's replacement takes this handle over");
  assert.equal(h.reloading, true);
  const p = h.call("reacquire", { force: false });
  const next = new FakeLink();
  h.repoint(next as never, { unit: "u-r1", pid: 2 }, mirror());
  await tick();
  const [c] = next.calls();
  assert.equal(c?.call.method, "reacquire");
  next.deliver({ t: "reply", reply: { id: c!.call.id, ok: true, result: "attached" } });
  assert.equal(await p, "attached");
  assert.equal(h.reloading, false);
});

test("an open already sent when the process exits for a reload goes to the replacement once, never failing as unreachable (t18)", async () => {
  const { h, link } = handle();
  const p = h.call("reacquire", { force: false });
  assert.equal(link.calls().length, 1);
  // The old process closes for the reload before answering.
  link.deliver({ t: "exit", cause: "reload" } as never);
  await tick();
  const next = new FakeLink();
  h.repoint(next as never, { unit: "u-r1", pid: 2 }, mirror());
  await tick();
  const [c] = next.calls();
  assert.equal(c?.call.method, "reacquire");
  next.deliver({ t: "reply", reply: { id: c!.call.id, ok: true, result: "ok" } });
  assert.equal(await p, "ok");
  assert.equal(next.calls().length, 1, "once");
});

test("F14: once its process says it exits, the link is closed and a pane's prompt or steer comes back as a refusal naming it", async () => {
  for (const cause of ["operator", "reload"] as const) {
    const { h, link } = handle();
    const got: unknown[] = [];
    const pane = { send: (m: unknown) => got.push(m) } as never;
    h.attach(pane);
    h.clientMessage(pane, { type: "prompt", text: "before", clientId: "p0" });
    assert.equal(link.sent.filter((f) => f.t === "client.msg").length, 1, "a live link takes it");
    link.deliver({ t: "exit", cause } as never);
    assert.equal(link.isOpen, false, `${cause}: the server closes the link once it hears the exit`);
    h.clientMessage(pane, { type: "prompt", text: "/btw across the exit", clientId: "p1" });
    h.clientMessage(pane, { type: "steer", text: "more", clientId: "p2" });
    h.clientMessage(pane, { type: "set_model", ref: "x/y" } as never);
    const refused = got.filter((m) => (m as { code?: string }).code === "refused") as { clientId?: string }[];
    assert.deepEqual(refused.map((m) => m.clientId), ["p1", "p2"], cause);
  }
});

test("an ended handle refuses at once", async () => {
  const { h } = handle();
  h.endPanes("gone");
  await assert.rejects(h.call("abort", {}), (e: Error) => e.message === UNREACHABLE);
});

test("a special chat's run events reach its kind once, in order, and are acknowledged", async () => {
  const heard: [ChatRunEvent["type"], number][] = [];
  registerSpecialHost({
    kind: "baton",
    matches: () => false,
    spec: async () => {
      throw new Error("not in this test");
    },
    adopt: async () => {},
    runStart: async () => ({ prompt: {} }),
    runEvent: (_path, e, n) => void heard.push([e.type, n]),
  });
  const { h, link } = handle({ special: "baton" });
  const acks = () => link.sent.filter((f) => f.t === "run.ack");
  link.deliver({ t: "run", n: 1, event: { type: "run.start" } });
  assert.deepEqual(acks(), [{ t: "run.ack", n: 1 }], "a fact is acknowledged at once");
  link.deliver({ t: "run", n: 2, event: { type: "reply.text", text: "hi" } });
  assert.equal(acks().length, 1, "a tick waits for the batch");
  link.deliver({ t: "run", n: 3, event: { type: "run.settled" } });
  link.deliver({ t: "run", n: 3, event: { type: "run.settled" } }); // told again (a resend): heard once
  assert.deepEqual(heard, [
    ["run.start", 1],
    ["reply.text", 2],
    ["run.settled", 3],
  ]);
  await tick(250);
  assert.deepEqual(acks().at(-1), { t: "run.ack", n: 3 });
  h.bye();
});

test("a served call's write is a call back into the chat, and the call then reads it as its leaf", async () => {
  const { link, path } = handle();
  const seen: { leaf: string | null; last: string | undefined }[] = [];
  serveTools(path, [
    {
      name: "probe_write",
      label: "probe",
      description: "probe",
      parameters: { type: "object" },
      async execute(_id, _p, _s, _u, ctx) {
        const { serverToolCall } = await import("./chat-handle");
        const id = await serverToolCall()!.chat.append(BATON, { v: 1 } as never, { announce: true });
        seen.push({ leaf: ctx!.leafId(), last: ctx!.branch().at(-1)?.id ?? undefined });
        return { content: [{ type: "text", text: id }], details: null };
      },
    },
  ]);
  const call: ServerToolCall = { effectId: "fx-1", chatId: path, toolCallId: "tc", name: "probe_write", params: {}, attended: false, card: null };
  link.deliver({ t: "tool.call", call, ctx: { sessionId: `sid-${seq}`, cwd: agentDir, leafId: "u1", title: null } });
  await tick(20);
  const back = link.sent.find((f): f is FrameOf<"tool.back"> => f.t === "tool.back");
  assert.ok(back && back.op === "append" && back.announce && back.kind === BATON.type && back.effectId === "fx-1");
  link.deliver({ t: "tool.backResult", id: back.id, ok: true, result: { entryId: "m1", entry: { kind: "state", id: "m1", parentId: "u1", key: BATON.type, data: { v: 1 } } as never } });
  await tick(20);
  assert.deepEqual(seen, [{ leaf: "m1", last: "m1" }]);
  const result = link.sent.find((f): f is FrameOf<"tool.result"> => f.t === "tool.result");
  assert.deepEqual(result?.outcome, { ok: true, result: { content: [{ type: "text", text: "m1" }], details: null } });
});

test("a server action answers with its own result over the socket, as in one process", async () => {
  const { link, path } = handle();
  serveTools(path, [{ name: "@probe", label: "@probe", description: "action", parameters: { type: "object" }, execute: async () => ({ content: [], details: { ok: true, by: "operator" } }) }]);
  const call: ServerToolCall = { effectId: "fx-act", chatId: path, toolCallId: "@probe", name: "@probe", params: {}, attended: false, card: null };
  link.deliver({ t: "tool.call", call, ctx: { sessionId: `sid-${seq}`, cwd: agentDir, leafId: "u1", title: null } });
  await tick(20);
  const result = link.sent.find((f): f is FrameOf<"tool.result"> => f.t === "tool.result" && f.effectId === "fx-act");
  assert.deepEqual(result?.outcome, { ok: true, result: { ok: true, by: "operator" } });
});

test("mirrorListedKey: a mirror differing only in its LLM count starts no new listing", async () => {
  const { mirrorListedKey } = await import("./chat-handle-remote");
  const base = { sessionId: "s", busy: false } as any;
  const a = mirrorListedKey({ ...base, llm: { tokens: { end: 1 } } });
  assert.equal(mirrorListedKey({ ...base, llm: { tokens: { end: 2 } } }), a);
  assert.notEqual(mirrorListedKey({ ...base, busy: true, llm: { tokens: { end: 1 } } }), a);
});
