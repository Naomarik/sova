// Run: pnpm test -- server/chat-runtime/methods.test.ts. Keyed sends (al_3 stage 3 §5.1): a send
// delivered again under its key gets the first receipt back and starts no second turn; a keyed,
// tracked turn's end answers every ask until an hour after it ended; keys are forgotten after an hour. The table is the one both handles run (chat-handle.ts in the server, host.ts in a chat process).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatSession } from "../chat-manager";
import type { ChatSendInput, ChatSendReceipt } from "../../shared/chat-runtime";
import { type CallCtx, KEPT_MS, KEYS_MAX, METHODS } from "./methods";

const send = (chat: ChatSession, a: ChatSendInput, ctx: CallCtx) => METHODS.send(chat, a, ctx) as ChatSendReceipt;

/** A chat whose every accepted prompt starts a turn that ends when `end()` is called. */
function fakeChat(opts: { queued?: boolean } = {}) {
  const accepted: string[] = [];
  const ends: (() => void)[] = [];
  const chat = {
    runTag: { next: undefined as string | undefined },
    assertModelAllowed() {},
    reportTurnFailure() {},
    acceptPrompt(text: string) {
      accepted.push(text);
      const turn = new Promise<void>((resolve) => ends.push(resolve));
      return { queued: !!opts.queued, turn };
    },
  };
  return { chat: chat as unknown as ChatSession, accepted, ends };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const clock = (start = 1_000) => {
  const c = { t: start, now: () => c.t };
  return c;
};

test("a repeated key returns the first receipt and runs one turn", async () => {
  const { chat, accepted, ends } = fakeChat();
  const c = clock();
  const ctx: CallCtx = { turns: new Map(), now: c.now };
  const first = send(chat, { text: "look", key: "look:1", track: true }, ctx);
  const again = send(chat, { text: "look", key: "look:1", track: true }, ctx);
  assert.deepEqual(again, first);
  assert.ok(first.turnId);
  assert.deepEqual(accepted, ["look"]);
  // Another key is another send.
  send(chat, { text: "look", key: "look:2" }, ctx);
  assert.deepEqual(accepted, ["look", "look"]);
  // Unkeyed sends are never deduped.
  send(chat, { text: "x" }, ctx);
  send(chat, { text: "x" }, ctx);
  assert.equal(accepted.length, 4);
  ends.forEach((e) => e());
});

test("a keyed tracked turn answers every ask; an unkeyed one, one", async () => {
  const { chat, ends } = fakeChat();
  const ctx: CallCtx = { turns: new Map(), now: clock().now };
  const keyed = send(chat, { text: "a", key: "k", track: true }, ctx);
  const plain = send(chat, { text: "b", track: true }, ctx);
  ends.forEach((e) => e());
  assert.deepEqual(await METHODS.turnEnd(chat, { turnId: keyed.turnId! }, ctx), { ok: true });
  assert.deepEqual(await METHODS.turnEnd(chat, { turnId: keyed.turnId! }, ctx), { ok: true });
  assert.deepEqual(await METHODS.turnEnd(chat, { turnId: keyed.turnId! }, ctx), { ok: true });
  assert.deepEqual(await METHODS.turnEnd(chat, { turnId: plain.turnId! }, ctx), { ok: true });
  assert.throws(() => METHODS.turnEnd(chat, { turnId: plain.turnId! }, ctx), /not tracked/);
});

test("a key is forgotten an hour after its send; a kept turn an hour after it ended, never while it runs", async () => {
  const { chat, accepted, ends } = fakeChat();
  const c = clock();
  const ctx: CallCtx = { turns: new Map(), now: c.now };
  const r = send(chat, { text: "a", key: "k", track: true }, ctx);
  c.t += KEPT_MS - 1;
  assert.deepEqual(send(chat, { text: "a", key: "k", track: true }, ctx), r);
  assert.equal(accepted.length, 1);
  c.t += 1;
  // The key is gone; the turn still runs, so its end is still kept.
  const r2 = send(chat, { text: "a", key: "k", track: true }, ctx);
  assert.notEqual(r2.turnId, r.turnId);
  assert.equal(accepted.length, 2);
  ends[0]!();
  await settle();
  c.t += KEPT_MS - 1;
  assert.deepEqual(await METHODS.turnEnd(chat, { turnId: r.turnId! }, ctx), { ok: true });
  c.t += 1;
  assert.throws(() => METHODS.turnEnd(chat, { turnId: r.turnId! }, ctx), /not tracked/);
  ends.forEach((e) => e());
});

test("a queued keyed send is deduped too (no turn id); the oldest keys go past the cap", () => {
  const { chat, accepted } = fakeChat({ queued: true });
  const ctx: CallCtx = { turns: new Map(), now: clock().now };
  assert.deepEqual(send(chat, { text: "q", key: "q0", track: true }, ctx), { queued: true, turnId: null });
  assert.deepEqual(send(chat, { text: "q", key: "q0", track: true }, ctx), { queued: true, turnId: null });
  assert.equal(accepted.length, 1);
  for (let i = 1; i <= KEYS_MAX; i++) send(chat, { text: "q", key: `q${i}` }, ctx);
  assert.equal(ctx.keys!.size, KEYS_MAX);
  send(chat, { text: "q", key: "q0" }, ctx);
  assert.equal(accepted.length, KEYS_MAX + 2, "q0 was evicted, so it runs again");
});

test("a refused send records no key: its retry may run", () => {
  const { chat, accepted } = fakeChat();
  let refuse = true;
  (chat as unknown as { assertModelAllowed(): void }).assertModelAllowed = () => {
    if (refuse) throw new Error("model off");
  };
  const ctx: CallCtx = { turns: new Map(), now: clock().now };
  assert.throws(() => send(chat, { text: "a", key: "k", checkModel: true }, ctx), /model off/);
  refuse = false;
  send(chat, { text: "a", key: "k", checkModel: true }, ctx);
  assert.equal(accepted.length, 1);
});
