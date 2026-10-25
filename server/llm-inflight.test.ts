// Run: npx tsx --test server/llm-inflight.test.ts
// An injected own counter, fake peer sockets and virtual time: no network, no
// model (two hubs over real sockets: llm-inflight.integration.test.ts).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { LlmFeedMessage, LlmInflight, SessionFeedMessage } from "../shared/protocol";
import { hostCount, LlmInflightHub, meshTotal, type LlmProcessSnapshot, type HubTimers, type OwnCounter, type PeerSocket, type PeerState, type TokenRing, MAX_CALLS, MAX_SLOT_TOKENS } from "./llm-inflight";

const NOW = 1_000_000;
const OWN_PID = 100;
const snap = (over: Partial<LlmProcessSnapshot> = {}): LlmProcessSnapshot => ({ v: 1, producer: "own", pid: OWN_PID, active: 0, approximate: 0, claudeTurns: 0, degraded: false, ...over });

describe("hostCount", () => {
  test("this process's own count, chat processes' reports folded in by its counter; a complete 0 only then", () => {
    assert.deepEqual(hostCount(snap(), NOW), { count: 0, approximate: 0, partial: false, gaps: [] });
    assert.deepEqual(hostCount(snap({ active: 3, approximate: 1 }), NOW), { count: 3, approximate: 1, partial: false, gaps: [] });
  });

  test("a running Claude Code turn makes it partial; a degraded counter is an unreported process", () => {
    assert.deepEqual(hostCount(snap({ active: 1, claudeTurns: 1 }), NOW).gaps, [{ reason: "claude-internal" }]);
    assert.deepEqual(hostCount(snap({ degraded: true }), NOW).gaps, [{ reason: "unreported", processes: 1 }]);
  });
});

describe("meshTotal", () => {
  const local: LlmInflight = { count: 1, approximate: 0, partial: false, gaps: [] };
  const ok = (instance: string, count: number, gaps: LlmInflight["gaps"] = []): PeerState => ({ state: "ok", instance, local: { count, approximate: 0, partial: gaps.length > 0, gaps } });

  test("each host once: a peer that is this server, or a host already counted, adds nothing", () => {
    const peers = new Map<string, PeerState>([
      ["a", ok("i-a", 2)],
      ["b", ok("i-a", 2)], // the same server under a second entry
      ["c", ok("self", 9)], // this server, reached as a peer
    ]);
    assert.deepEqual(meshTotal(local, "self", peers), { count: 3, approximate: 0, partial: false, gaps: [] });
  });

  test("a peer without a count is a named gap, never a 0; a peer's own gaps carry its id", () => {
    const peers = new Map<string, PeerState>([
      ["a", { state: "connecting" }],
      ["b", { state: "unreachable" }],
      ["c", { state: "unsupported" }],
      ["d", ok("i-d", 1, [{ reason: "claude-internal" }, { reason: "unreported", processes: 2 }])],
    ]);
    assert.deepEqual(meshTotal(local, "self", peers), {
      count: 2,
      approximate: 0,
      partial: true,
      gaps: [
        { reason: "peer-connecting", host: "a" },
        { reason: "peer-unreachable", host: "b" },
        { reason: "peer-unsupported", host: "c" },
        { reason: "claude-internal", host: "d" },
        { reason: "unreported", host: "d", processes: 2 },
      ],
    });
  });
});

// ---- the hub ---------------------------------------------------------------------------------

class FakeOwn implements OwnCounter {
  value = snap();
  private fns = new Set<() => void>();
  snapshot = () => this.value;
  subscribe = (fn: () => void) => {
    this.fns.add(fn);
    return () => void this.fns.delete(fn);
  };
  set(over: Partial<LlmProcessSnapshot>): void {
    this.value = snap({ ...this.value, ...over });
    for (const fn of this.fns) fn();
  }
  get listeners(): number {
    return this.fns.size;
  }
}

class FakeSocket extends EventEmitter {
  closed = false;
  constructor(readonly url: string) {
    super();
  }
  pings = 0;
  answersPings = true;
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
  terminate(): void {
    this.close();
  }
  ping(): void {
    this.pings++;
    if (this.answersPings) setImmediate(() => this.emit("pong"));
  }
  send(msg: LlmFeedMessage): void {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
}

const frame = (instance: string, count: number): LlmFeedMessage => ({ type: "llm_local", host: "x", instance, local: { count, approximate: 0, partial: false, gaps: [] } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Let queued stream, socket and watch callbacks land. */
const settle = () => new Promise((r) => setImmediate(r));

/** Virtual time for a hub: its clock (`now`) and timers (`timers`) move only by `advance`, which fires
    what comes due in order, each one's consequences landing before the next. */
function virtualTime(start = Date.now()) {
  let t = start;
  let next = 0;
  const pending = new Map<number, { at: number; ms: number; every: boolean; fn: () => void }>();
  const add = (fn: () => void, ms: number, every: boolean) => (pending.set(++next, { at: t + ms, ms, every, fn }), next);
  const drop = (h: unknown) => void pending.delete(h as number);
  const timers: HubTimers = { setTimeout: (fn, ms) => add(fn, ms, false), clearTimeout: drop, setInterval: (fn, ms) => add(fn, ms, true), clearInterval: drop };
  return {
    timers,
    now: () => t,
    /** Timers waiting with this delay (e.g. the debounce a watch event armed). */
    waiting: (ms: number) => [...pending.values()].filter((p) => p.ms === ms).length,
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const due = [...pending].filter(([, p]) => p.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        const [h, p] = due;
        t = p.at;
        if (p.every) p.at += p.ms;
        else pending.delete(h);
        p.fn();
        await settle();
      }
      t = end;
    },
  };
}
/** Poll for what only the OS delivers (a watch event); the guard only stops a hang. */
async function until(ok: () => boolean, what: string, guardMs = 30_000): Promise<void> {
  const end = Date.now() + guardMs;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`still waiting after ${guardMs} ms: ${what}`);
    await sleep(5);
  }
}
const inflights = (msgs: SessionFeedMessage[]) => msgs.flatMap((m) => (m.type === "llm_inflight" ? [m.inflight] : []));

describe("LlmInflightHub", () => {
  let own: FakeOwn;
  let peers: Array<{ id: string; url: string }>;
  let sockets: FakeSocket[];
  let hub: LlmInflightHub;
  let time: ReturnType<typeof virtualTime>;

  beforeEach(() => {
    own = new FakeOwn();
    peers = [];
    sockets = [];
    time = virtualTime();
    hub = new LlmInflightHub({
      own,
      now: time.now,
      timers: time.timers,
      debounceMs: 5,
      sweepMs: 40,
      peerAnswerMs: 60,
      peerRetryMs: 30,
      peerPingMs: 60,
      peerDeadMs: 150,
      mesh: {
        peers: () => peers,
        selfId: () => "here",
        connect: (url) => {
          const s = new FakeSocket(url);
          sockets.push(s);
          return s as unknown as PeerSocket;
        },
      },
    });
  });
  afterEach(() => {
    hub.stop();
  });

  test("snapshot on connect, then a frame only when the total or its coverage changes", async () => {
    own.set({ active: 1 });
    const got: SessionFeedMessage[] = [];
    const off = hub.addBrowser((m) => got.push(m));
    assert.deepEqual(inflights(got), [{ count: 1, approximate: 0, partial: false, gaps: [] }]);
    own.set({ active: 1 }); // an unchanged report
    await time.advance(400);
    assert.equal(got.length, 1);
    own.set({ active: 3, degraded: true });
    await time.advance(400);
    assert.deepEqual(inflights(got).at(-1), { count: 3, approximate: 0, partial: true, gaps: [{ reason: "unreported", processes: 1 }] });
    own.set({ active: 1, degraded: false });
    await time.advance(400);
    assert.deepEqual(inflights(got).at(-1), { count: 1, approximate: 0, partial: false, gaps: [] });
    off();
  });

  test("nothing is watched, swept or subscribed once the last listener leaves", () => {
    const off1 = hub.addBrowser(() => {});
    const off2 = hub.addLocal(() => {});
    assert.equal(hub.listening, true);
    assert.equal(own.listeners, 1);
    off1();
    assert.equal(hub.listening, true);
    off2();
    assert.equal(hub.listening, false);
    assert.equal(own.listeners, 0);
  });

  test("no peer socket while the mesh is off, nor for a peer listener alone", () => {
    hub.addBrowser(() => {});
    assert.deepEqual(sockets, []);
    peers = [{ id: "a", url: "http://a:4801" }];
    const off = hub.addLocal(() => {});
    off();
    assert.deepEqual(sockets.length, 0, "a peer's own listener opens nothing");
  });

  test("one socket per peer, shared by every browser, closed when the last browser leaves", async () => {
    peers = [{ id: "a", url: "http://a:4801" }];
    const one: SessionFeedMessage[] = [];
    const off1 = hub.addBrowser((m) => one.push(m));
    const off2 = hub.addBrowser(() => {});
    assert.equal(sockets.length, 1);
    assert.deepEqual(inflights(one)[0]!.gaps, [{ reason: "peer-connecting", host: "a" }]);
    sockets[0]!.send(frame("i-a", 2));
    assert.deepEqual(inflights(one).at(-1), { count: 2, approximate: 0, partial: false, gaps: [] });
    off1();
    assert.equal(sockets[0]!.closed, false);
    off2();
    assert.equal(sockets[0]!.closed, true);
    assert.deepEqual(hub.peerSockets(), []);
  });

  test("a removed peer's socket closes at the next sweep, and its count goes", async () => {
    peers = [{ id: "a", url: "http://a:4801" }];
    const got: SessionFeedMessage[] = [];
    hub.addBrowser((m) => got.push(m));
    sockets[0]!.send(frame("i-a", 3));
    peers = [];
    await time.advance(100);
    assert.equal(sockets[0]!.closed, true);
    assert.deepEqual(inflights(got).at(-1), { count: 0, approximate: 0, partial: false, gaps: [] });
  });

  test("a dropped peer is unreachable (not 0) and is retried; its next count clears the gap", async () => {
    peers = [{ id: "a", url: "http://a:4801" }];
    const got: SessionFeedMessage[] = [];
    hub.addBrowser((m) => got.push(m));
    sockets[0]!.send(frame("i-a", 1));
    sockets[0]!.close();
    assert.deepEqual(inflights(got).at(-1), { count: 0, approximate: 0, partial: true, gaps: [{ reason: "peer-unreachable", host: "a" }] });
    await time.advance(60);
    assert.equal(sockets.length, 2, "retried");
    sockets[1]!.send(frame("i-a", 1));
    assert.deepEqual(inflights(got).at(-1), { count: 1, approximate: 0, partial: false, gaps: [] });
  });

  test("an older peer (an error, or no count at all) is unsupported, never 0", async () => {
    peers = [
      { id: "a", url: "http://a:4801" },
      { id: "b", url: "http://b:4801" },
    ];
    const got: SessionFeedMessage[] = [];
    hub.addBrowser((m) => got.push(m));
    sockets[0]!.emit("message", Buffer.from(JSON.stringify({ type: "error", message: "Invalid or missing ?path=" })));
    sockets[0]!.close();
    await time.advance(80); // b never answers
    const last = inflights(got).at(-1)!;
    assert.equal(last.partial, true);
    assert.deepEqual(last.gaps.filter((g) => g.reason === "peer-unsupported"), [
      { reason: "peer-unsupported", host: "a" },
      { reason: "peer-unsupported", host: "b" },
    ]);
  });

  test("a peer's feed is this host's own count only: never a peer's, so nothing is summed twice", () => {
    peers = [{ id: "a", url: "http://a:4801" }];
    own.set({ active: 1 });
    hub.addBrowser(() => {});
    sockets[0]!.send(frame("i-a", 5));
    const local: LlmFeedMessage[] = [];
    hub.addLocal((m) => local.push(m));
    assert.deepEqual(local, [{ type: "llm_local", host: "here", instance: hub.instance, local: { count: 1, approximate: 0, partial: false, gaps: [] } }]);
    assert.equal(hub.total().count, 6);
    sockets[0]!.send(frame("i-a", 7));
    assert.equal(local.length, 1, "a peer's change is not this host's");
  });

  test("a peer that answered once, then went silent and half-open, becomes a gap; one that pongs stays", async () => {
    peers = [
      { id: "a", url: "http://a:4801" },
      { id: "b", url: "http://b:4801" },
    ];
    const got: SessionFeedMessage[] = [];
    hub.addBrowser((m) => got.push(m));
    sockets[0]!.answersPings = false; // a: half-open, never answers again
    sockets[0]!.send(frame("i-a", 2));
    sockets[1]!.send(frame("i-b", 1));
    assert.equal(inflights(got).at(-1)!.count, 3);
    await time.advance(320);
    assert.equal(sockets[0]!.closed, true, "dropped past the dead line");
    assert.equal(sockets[1]!.closed, false, "b answered its pings");
    assert.equal(sockets[1]!.pings > 0, true);
    const last = inflights(got).at(-1)!;
    assert.equal(last.count, 1, "a's last count is gone, not kept");
    assert.deepEqual(last.gaps.filter((g) => g.host === "a").map((g) => g.reason), ["peer-unreachable"]);
  });

  test("a peer frame over the bounds is ignored, never added", () => {
    peers = [{ id: "a", url: "http://a:4801" }];
    hub.addBrowser(() => {});
    sockets[0]!.emit("message", Buffer.from(JSON.stringify({ type: "llm_local", host: "a", instance: "i", local: { count: 10_000_000, approximate: 0, partial: false, gaps: [] } })));
    sockets[0]!.emit("message", Buffer.from(JSON.stringify({ type: "llm_local", host: "a", instance: "i", local: { count: 1, approximate: 0, partial: true, gaps: Array(50).fill({ reason: "claude-internal" }) } })));
    assert.deepEqual(hub.total().gaps, [{ reason: "peer-connecting", host: "a" }]);
  });

  test("a garbage frame from a peer changes nothing", () => {
    peers = [{ id: "a", url: "http://a:4801" }];
    hub.addBrowser(() => {});
    sockets[0]!.emit("message", Buffer.from("{not json"));
    sockets[0]!.emit("message", Buffer.from(JSON.stringify({ type: "llm_local", instance: "i", local: { count: -1 } })));
    assert.deepEqual(hub.total().gaps, [{ reason: "peer-connecting", host: "a" }]);
  });
});

const S = Math.floor(NOW / 30_000);
const ringAt = (end: number, slots: Record<number, number>, partial?: true): TokenRing => ({ bucketMs: 30_000, end, out: Array.from({ length: 60 }, (_, i) => slots[i] ?? 0), ...(partial ? { partial } : {}) });
const tail = (t: LlmInflight["tokens"], n = 3) => t!.out.slice(60 - n);
const zeros = () => new Array(60).fill(0);

describe("tokens: one host", () => {
  test("its own ring (chat processes' rings folded in by its counter), aligned to now's slot; none without one", () => {
    const got = hostCount(snap({ tokens: ringAt(S - 1, { 59: 10, 58: 2 }) }), NOW);
    assert.deepEqual(tail(got.tokens, 3), [2, 10, 0]);
    assert.equal(got.tokens!.end, S);
    assert.equal(got.tokens!.partial, false);
    assert.equal(hostCount(snap(), NOW).tokens, undefined);
    assert.equal(hostCount(snap({ tokens: ringAt(S, {}, true) }), NOW).tokens!.partial, true, "a ring it says is partial");
    assert.equal(hostCount(snap({ claudeTurns: 1, tokens: ringAt(S, {}) }), NOW).tokens!.partial, true, "a Claude Code turn's internal calls");
  });
});

describe("tokens: the mesh", () => {
  const local: LlmInflight = { count: 0, approximate: 0, partial: false, gaps: [], tokens: { bucketMs: 30_000, end: S, out: zeros(), partial: false } };
  const okT = (instance: string, tokens?: LlmInflight["tokens"]): PeerState => ({ state: "ok", instance, local: { count: 0, approximate: 0, partial: false, gaps: [], ...(tokens ? { tokens } : {}) } });
  const peerRing = (end: number, slots: Record<number, number>, partial = false) => ({ ...ringAt(end, slots), partial });

  test("each host's ring once, aligned to this host's slot; a peer without one, or not heard from, is partial", () => {
    const peers = new Map<string, PeerState>([["a", okT("i-a", peerRing(S - 1, { 59: 4 }))], ["b", okT("i-a", peerRing(S, { 59: 4 }))], ["c", okT("self", peerRing(S, { 59: 9 }))]]);
    const got = meshTotal(local, "self", peers);
    assert.deepEqual(tail(got.tokens, 2), [4, 0]);
    assert.equal(got.tokens!.partial, false);
    assert.equal(meshTotal(local, "self", new Map([["a", okT("i-a")]])).tokens!.partial, true, "an older peer: unknown");
    assert.equal(meshTotal(local, "self", new Map([["a", okT("i-a", peerRing(S, {}, true))]])).tokens!.partial, true);
    assert.equal(meshTotal(local, "self", new Map<string, PeerState>([["a", { state: "unreachable" }]])).tokens!.partial, true);
    assert.equal(meshTotal({ ...local, tokens: undefined }, "self", peers).tokens, undefined, "no local ring: unknown");
  });

  test("a peer that drops keeps its last ring until it ages out", () => {
    const retained = new Map<string, TokenRing>();
    meshTotal(local, "self", new Map([["a", okT("i-a", peerRing(S, { 59: 12 }))]]), retained);
    const dropped = meshTotal(local, "self", new Map<string, PeerState>([["a", { state: "unreachable" }]]), retained);
    assert.deepEqual(tail(dropped.tokens, 1), [12]);
    assert.equal(dropped.tokens!.partial, true);
    const aged = { ...local, tokens: { ...local.tokens!, end: S + 60 } };
    assert.equal(meshTotal(aged, "self", new Map(), retained).tokens!.out.every((n) => n === 0), true);
    assert.equal(retained.size, 0);
  });
});

describe("tokens: the hub", () => {
  test("a frame when tokens land; none when only time passes; a peer's ring is bounded, a bad one dropped", async () => {
    const own = new FakeOwn();
    let clock = NOW;
    const sockets: FakeSocket[] = [];
    const time = virtualTime(NOW);
    own.value = snap({ tokens: ringAt(S, {}) });
    const hub = new LlmInflightHub({
      own, debounceMs: 1, sweepMs: 20, now: () => clock, timers: time.timers, peerPingMs: 1e9, peerDeadMs: 1e9,
      mesh: { peers: () => [{ id: "a", url: "http://a" }], selfId: () => "here", connect: (url) => { const s = new FakeSocket(url); sockets.push(s); return s as unknown as PeerSocket; } },
    });
    const got: SessionFeedMessage[] = [];
    try {
      hub.addBrowser((m) => got.push(m));
      sockets[0]!.send({ type: "llm_local", host: "a", instance: "i-a", local: { count: 0, approximate: 0, partial: false, gaps: [], tokens: { ...ringAt(S, { 59: 1e12 }), partial: false } } });
      await time.advance(10);
      const before = got.length;
      assert.equal(inflights(got).at(-1)!.tokens!.out[59], 10 * MAX_SLOT_TOKENS, "a peer's slot is capped at a host's bound");
      own.set({ tokens: ringAt(S, { 59: 5 }) });
      await time.advance(10);
      assert.equal(got.length, before + 1, "the tokens: one frame");
      clock += 3 * 30_000;
      own.set({ tokens: ringAt(S + 3, { 56: 5 }) });
      await time.advance(80);
      assert.equal(got.length, before + 1, "time passing, sweeps and an unchanged report: no frame");
      sockets[0]!.send({ type: "llm_local", host: "a", instance: "i-a", local: { count: 0, approximate: 0, partial: false, gaps: [], tokens: { bucketMs: 30_000, end: S, out: [1], partial: false } as any } });
      await time.advance(10);
      const last = inflights(got).at(-1)!;
      assert.equal(last.count, 0, "the count still taken");
      assert.equal(last.tokens!.partial, true, "its ring unknown");
    } finally {
      hub.stop();
    }
  });
});
