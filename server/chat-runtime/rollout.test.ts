import assert from "node:assert/strict";
import { test } from "node:test";
import type { Link } from "./link";
import { linkWaitReady, Rollout, type RolloutDeps, type RolloutSupervisor } from "./rollout";
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
  assert.deepEqual(calls, ["start-rep a", "expect a reload", "drain a", "await-exit a", "unlocked /s/a.jsonl", "repoint a u-a-r1", "open a u-a-r1"]);
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

test("a chat asking again the moment its refused reload says older gets a reload of its own, never the refused one", async () => {
  let drains = 0;
  let again: Promise<string> | null = null;
  const f = make({
    drain: async () => ({ ok: drains++ > 0 }),
    // The chat asks at once on hearing "older" (a Reload now that stood), before the refused run has settled.
    setCode: (id, state) => {
      if (state === "older" && !again) again = f.r.request(id, { auto: false });
    },
  });
  assert.equal(await f.r.request("a", { auto: true }), "refused");
  assert.ok(again);
  assert.equal(await again, "reloaded");
});

test("a Reload now that joins a chat's queued automatic reload makes it a Reload now: the halt after another chat's failure doesn't skip it", async () => {
  let boots = 0;
  const { r, calls } = make({ waitReady: async () => (boots++ === 0 ? { ok: false, error: "no hello in 30 s" } : { ok: true }) });
  const first = r.request("a", { auto: true }); // fails to boot: the automatic rollout halts
  const queued = r.request("b", { auto: true }); // queued behind it, automatic
  const pressed = r.request("b", { auto: false }); // the pane's Reload now joins it
  assert.equal(await first, "failed");
  assert.equal(await queued, "reloaded");
  assert.equal(await pressed, "reloaded");
  assert.ok(calls.includes("start-rep b"));
});

test("a Reload now joining a reload already under way doesn't make that chat's next automatic request a Reload now", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let boots = 0;
  const { r } = make({
    waitReady: async () => {
      if (boots++ === 0) return { ok: false, error: "no hello in 30 s" }; // a: halts the automatic rollout
      await gate; // b's Reload now is under way until released
      return { ok: true };
    },
  });
  assert.equal(await r.request("a", { auto: true }), "failed");
  const running = r.request("b", { auto: false });
  await new Promise((ok) => setTimeout(ok, 10));
  const joined = r.request("b", { auto: false }); // joins the run already in reload()
  release();
  assert.equal(await running, "reloaded");
  assert.equal(await joined, "reloaded");
  assert.equal(await r.request("b", { auto: true }), "halted", "the next automatic request is still automatic");
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
  assert.deepEqual(codes, ["a:reloading"], "no failed badge: the chat opens in the server, on current code");
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

test("the halt names the new code; unused code is collected once a run of reloads that moved a chat ends", async () => {
  const lines: string[] = [];
  let collected = 0;
  let boots = 0;
  const { r } = make({
    waitReady: async () => (boots++ === 2 ? { ok: false, error: "exit 3" } : { ok: true }),
    codeId: () => "gen-b",
    collect: async () => void collected++,
    log: (l) => lines.push(l),
  });
  await Promise.all([r.request("a", { auto: true }), r.request("b", { auto: true })]);
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(collected, 1, "once, after the run of two");
  assert.equal(await r.request("a", { auto: false }), "failed");
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(collected, 1, "nothing moved: nothing to collect");
  assert.ok(lines.some((l) => l.startsWith("a: could not start on new code (gen-b): exit 3")), lines.join("\n"));
  assert.match(r.halted!, /^a: \(gen-b\) exit 3/);
});

test("a chat with no process is gone", async () => {
  const { r } = make();
  assert.equal(await r.request("zz", { auto: true }), "gone");
});

test("linkWaitReady: dials the replacement without replay, waits for its hello saying ready, and keeps the link", async () => {
  const closed: string[] = [];
  const fakeLink = (name: string) => ({ close: () => void closed.push(name) }) as unknown as Link;
  const dials: unknown[] = [];
  const settings = {} as never;
  const ready = linkWaitReady(
    { epoch: 9, build: "b", settings },
    (async (sock: string, o: unknown) => {
      dials.push([sock, o]);
      return { link: fakeLink(sock), hello: { state: sock.endsWith("warm.sock") ? "ready" : "booting" } };
    }) as never,
    (async (_l: Link, t: string, _ms: number, match: (h: { state: string }) => boolean) => {
      assert.equal(t, "hello");
      assert.ok(match({ state: "ready" }) && !match({ state: "booting" }));
      return { state: "ready" };
    }) as never,
  );
  const warm = await ready(recOf("a", "u-a-r1"), 30_000);
  assert.ok(warm.ok);
  const [sock, o] = dials[0] as [string, { since: unknown; epoch: number; retryForMs: number }];
  assert.equal(sock, "/s/u-a-r1.sock");
  assert.deepEqual([o.since, o.epoch, o.retryForMs], [null, 9, 30_000]);
  const cold = await linkWaitReady({ epoch: 9, build: "b", settings }, (async () => ({ link: fakeLink("cold"), hello: { state: "booting" } })) as never, (async () => {
    throw new Error("The link ended (closed)");
  }) as never)(recOf("a", "u-a-r2"), 30_000);
  assert.deepEqual(cold, { ok: false, error: "The link ended (closed)" });
  assert.deepEqual(closed, ["cold"], "a replacement that never got ready: its link is closed");
});
