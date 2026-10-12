import assert from "node:assert/strict";
import { test } from "node:test";
import { Rollout, type RolloutDeps, type RolloutSupervisor } from "./rollout";
import type { ChatRecord } from "./supervisor";

const recOf = (chatId: string, unit: string): ChatRecord => ({ chatId, sessionPath: `/s/${chatId}.jsonl`, cwd: "/w", unit, pid: 1, sock: `/s/${unit}.sock`, epoch: 1, startedAt: "t" });

/** A supervisor that writes down what rollout asked of it. */
function fakeSup() {
  const calls: string[] = [];
  const recs = new Map<string, ChatRecord>([
    ["a", recOf("a", "u-a")],
    ["b", recOf("b", "u-b")],
  ]);
  let n = 0;
  const sup: RolloutSupervisor = {
    record: (id) => recs.get(id),
    startReplacement: async (id) => {
      calls.push(`start-rep ${id}`);
      return recOf(id, `u-${id}-r${++n}`);
    },
    stopUnit: async (unit) => void calls.push(`stop ${unit}`),
    expectExit: (id, cause) => void calls.push(`expect ${id} ${cause}`),
    unexpectExit: (id) => void calls.push(`unexpect ${id}`),
    awaitExit: async (id) => void calls.push(`await-exit ${id}`),
    repoint: (id, rep) => {
      calls.push(`repoint ${id} ${rep.unit}`);
      recs.set(id, rep);
    },
    stop: async (id, cause) => {
      calls.push(`stop-chat ${id} ${cause}`);
      recs.delete(id);
    },
    waitUnlocked: async (path) => {
      calls.push(`unlocked ${path}`);
      return true;
    },
  };
  return { sup, calls, recs };
}

function make(over: Partial<RolloutDeps> = {}) {
  const f = fakeSup();
  const codes: string[] = [];
  const r = new Rollout({
    supervisor: f.sup,
    waitReady: async () => ({ ok: true }),
    drain: async (id) => {
      f.calls.push(`drain ${id}`);
      return { ok: true };
    },
    open: async (id, rep) => void f.calls.push(`open ${id} ${rep.unit}`),
    setCode: (id, state, detail) => void codes.push(`${id}:${state}${detail ? `:${detail}` : ""}`),
    logTail: async () => ["boot", "Error: cannot find module"],
    log: () => {},
    ...over,
  });
  return { r, codes, ...f };
}

test("a reload boots the replacement first, then drains the old process, then opens the chat there", async () => {
  const { r, calls, codes, recs } = make();
  assert.equal(await r.request("a", { auto: true }), "reloaded");
  assert.deepEqual(calls, ["start-rep a", "expect a reload", "drain a", "await-exit a", "repoint a u-a-r1", "open a u-a-r1"]);
  assert.deepEqual(codes, ["a:reloading"]);
  assert.equal(recs.get("a")!.unit, "u-a-r1");
});

test("a chat no longer quiet refuses: the replacement goes and the chat keeps its process", async () => {
  const { r, calls, codes } = make({ drain: async () => ({ ok: false }) });
  assert.equal(await r.request("a", { auto: true }), "refused");
  assert.deepEqual(calls, ["start-rep a", "expect a reload", "unexpect a", "stop u-a-r1"]);
  assert.deepEqual(codes, ["a:reloading", "a:older"]);
  assert.equal(r.halted, null, "a refusal is no failure");
});

test("a replacement that fails to boot halts the automatic rollout; Reload Now still tries", async () => {
  let boots = 0;
  const { r, calls, codes } = make({ waitReady: async () => (boots++ === 0 ? { ok: false, error: "no hello in 30 s" } : { ok: true }) });
  assert.equal(await r.request("a", { auto: true }), "failed");
  assert.deepEqual(calls, ["start-rep a", "stop u-a-r1"], "the old process is kept");
  assert.deepEqual(codes, ["a:reloading", "a:failed:no hello in 30 s: Error: cannot find module"]);
  assert.match(r.halted!, /no hello/);
  assert.equal(await r.request("b", { auto: true }), "halted", "no further automatic reload");
  assert.equal(await r.request("b", { auto: false }), "reloaded", "an explicit one still runs");
});

test("an open that fails on the replacement: it goes as an expected end, the lock is waited for, the router keeps the chat in the server, and the rollout halts", async () => {
  const failed: string[] = [];
  const { r, calls, codes } = make({
    open: async () => Promise.reject(new Error("refused: config")),
    onReloadOpenFailed: (id, path, reason) => void failed.push(`${id} ${path} ${reason}`),
  });
  assert.equal(await r.request("a", { auto: true }), "failed");
  assert.deepEqual(calls.slice(-3), ["repoint a u-a-r1", "stop-chat a reload", "unlocked /s/a.jsonl"]);
  assert.deepEqual(failed, ["a /s/a.jsonl the chat did not open on the new code: refused: config"]);
  assert.equal(codes.at(-1), "a:failed:the chat did not open on the new code: refused: config");
  assert.ok(r.halted);
});

test("reloads run one at a time; a second request for the same chat joins the first", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { r } = make({
    waitReady: async (rep) => {
      order.push(`ready ${rep.chatId}`);
      if (rep.chatId === "a") await gate;
      return { ok: true };
    },
  });
  const a1 = r.request("a", { auto: true });
  const a2 = r.request("a", { auto: false });
  const b = r.request("b", { auto: true });
  assert.equal(a1, a2);
  await new Promise((res) => setTimeout(res, 10));
  assert.deepEqual(order, ["ready a"], "b waits for a");
  release();
  assert.deepEqual(await Promise.all([a1, b]), ["reloaded", "reloaded"]);
  assert.deepEqual(order, ["ready a", "ready b"]);
});

test("a chat with no process is gone", async () => {
  const { r } = make();
  assert.equal(await r.request("zz", { auto: true }), "gone");
});
