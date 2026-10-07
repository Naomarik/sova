// Run: npx tsx --test server/llm-inflight.test.ts
// A throwaway live dir, an injected own counter, fake peer sockets and virtual time: no network, no
// model (two hubs over real sockets: llm-inflight.integration.test.ts).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { LlmFeedMessage, LlmInflight, SessionFeedMessage } from "../shared/protocol";
import { hostCount, LlmInflightHub, meshTotal, parseProcessLlm, type LiveEntry, type LlmProcessSnapshot, type HubTimers, type OwnCounter, type PeerSocket, type PeerState, type TokenRing, type UnadoptedWorker, MAX_CALLS, MAX_SLOT_TOKENS } from "./llm-inflight";

const NOW = 1_000_000;
const OWN_PID = 100;
const snap = (over: Partial<LlmProcessSnapshot> = {}): LlmProcessSnapshot => ({ v: 1, producer: "own", pid: OWN_PID, active: 0, approximate: 0, claudeTurns: 0, degraded: false, ...over });
const entry = (pid: number, llm: Partial<LlmProcessSnapshot> | null, heartbeat = NOW): LiveEntry => ({ pid, heartbeat, llm: llm ? snap({ producer: `p${pid}`, pid, ...llm }) : null });
const all = () => true;

describe("parseProcessLlm", () => {
  test("takes exactly the published shape and nothing looser", () => {
    assert.deepEqual(parseProcessLlm(snap({ active: 2, approximate: 1 })), snap({ active: 2, approximate: 1 }));
    assert.equal(parseProcessLlm(undefined), null);
    assert.equal(parseProcessLlm({ ...snap(), v: 2 }), null);
    assert.equal(parseProcessLlm({ ...snap(), active: -1 }), null);
    assert.equal(parseProcessLlm({ ...snap(), active: 1.5 }), null);
    assert.equal(parseProcessLlm({ ...snap(), degraded: "no" }), null);
    assert.equal(parseProcessLlm({ ...snap(), producer: "" }), null);
    // approximate never exceeds active
    assert.equal(parseProcessLlm(snap({ active: 1, approximate: 3 }))!.approximate, 1);
  });
});

describe("hostCount", () => {
  test("a complete 0 only when every process reports", () => {
    assert.deepEqual(hostCount(snap(), [entry(1, {}), entry(2, {})], NOW, all), { count: 0, approximate: 0, partial: false, gaps: [] });
  });

  test("own process plus one contribution per other process", () => {
    const got = hostCount(snap({ active: 2, approximate: 1 }), [entry(1, { active: 1 }), entry(2, { active: 3 })], NOW, all);
    assert.deepEqual(got, { count: 6, approximate: 1, partial: false, gaps: [] });
  });

  test("this server's own records (its pid, or its producer) are never added to its own count", () => {
    const own = snap({ active: 1 });
    const got = hostCount(own, [entry(OWN_PID, { active: 1, producer: "own" }), { pid: 7, heartbeat: NOW, llm: snap({ active: 1 }) }], NOW, all);
    assert.equal(got.count, 1);
  });

  test("a process with several records counts once, from its freshest reporting one", () => {
    const got = hostCount(snap(), [entry(1, { active: 1 }, NOW - 2000), entry(1, { active: 2 }, NOW - 100), entry(1, null)], NOW, all);
    assert.deepEqual(got, { count: 2, approximate: 0, partial: false, gaps: [] });
  });

  test("a dead pid counts nothing and leaves no gap", () => {
    assert.deepEqual(hostCount(snap(), [entry(1, { active: 4 })], NOW, (pid) => pid !== 1), { count: 0, approximate: 0, partial: false, gaps: [] });
  });

  test("a record without presence.llm, or stale while its pid lives, is unreported: partial, never 0", () => {
    const got = hostCount(snap(), [entry(1, null), entry(2, { active: 5 }, NOW - 20_000), entry(3, { active: 1 })], NOW, all);
    assert.deepEqual(got, { count: 1, approximate: 0, partial: true, gaps: [{ reason: "unreported", processes: 2 }] });
  });

  test("a running Claude Code turn makes it partial; a degraded counter is an unreported process", () => {
    const got = hostCount(snap({ active: 1, claudeTurns: 1 }), [entry(1, { degraded: true, active: 2 })], NOW, all);
    assert.deepEqual(got, { count: 3, approximate: 0, partial: true, gaps: [{ reason: "claude-internal" }, { reason: "unreported", processes: 1 }] });
    assert.deepEqual(hostCount(snap({ degraded: true }), [], NOW, all).gaps, [{ reason: "unreported", processes: 1 }]);
  });
});

describe("hostCount: folded children and unadopted workers", () => {
  const c = (active: number, over: Partial<NonNullable<UnadoptedWorker["counts"]>> = {}) => ({ active, approximate: 0, claudeTurns: 0, degraded: false, ...over });

  test("a worker folded into its parent adds nothing of its own (it also loads the sessions extension)", () => {
    const parent = entry(1, { active: 3, folded: ["p2"] });
    assert.deepEqual(hostCount(snap(), [parent, entry(2, { active: 1 })], NOW, all), { count: 3, approximate: 0, partial: false, gaps: [] });
    // a record that can't say who it is can't be matched: unknown, never 0 and never added
    assert.deepEqual(hostCount(snap(), [parent, entry(2, null)], NOW, all), { count: 3, approximate: 0, partial: true, gaps: [{ reason: "unreported", processes: 1 }] });
  });

  test("nested: parent folds child and grandchild (transitively); each counted once, in any order", () => {
    const parent = entry(1, { active: 3, folded: ["p2", "p3"] });
    const child = entry(2, { active: 2, folded: ["p3"] });
    const grandchild = entry(3, { active: 1 });
    assert.equal(hostCount(snap(), [grandchild, child, parent], NOW, all).count, 3);
    assert.equal(hostCount(snap(), [parent, grandchild, child], NOW, all).count, 3);
  });

  test("this server's own folded workers are never added again", () => {
    assert.equal(hostCount(snap({ active: 2, folded: ["p5"] }), [entry(5, { active: 2 })], NOW, all).count, 2);
  });

  test("an unadopted worker adds its last own count once; one that never reported is unreported, never 0", () => {
    const got = hostCount(snap(), [], NOW, all, [{ key: "a/1", producer: "w7", counts: c(1) }, { key: "a/2", counts: null }]);
    assert.deepEqual(got, { count: 1, approximate: 0, partial: true, gaps: [{ reason: "unreported", processes: 1 }] });
    assert.deepEqual(hostCount(snap(), [], NOW, all, [{ key: "a/3", counts: c(1, { claudeTurns: 1 }) }]).gaps, [{ reason: "claude-internal" }]);
  });

  test("adoption: the parent folds the worker, so the reader's copy adds nothing; nor does one with its own record", () => {
    const parent = entry(1, { active: 1, folded: ["w7"] });
    assert.equal(hostCount(snap(), [parent], NOW, all, [{ key: "a/1", producer: "w7", counts: c(1) }]).count, 1);
    assert.equal(hostCount(snap(), [entry(7, { active: 1, producer: "w7" })], NOW, all, [{ key: "a/1", producer: "w7", counts: c(1) }]).count, 1);
  });

  test("bounds: an oversized or malformed folded list, or a count past the cap, is degraded and capped", () => {
    const many = Array.from({ length: 300 }, (_, i) => `c${i}`);
    assert.equal(parseProcessLlm({ ...snap(), folded: many })!.degraded, true);
    assert.equal(parseProcessLlm({ ...snap(), folded: many })!.folded!.length, 300, "every id read is still excluded");
    assert.equal(parseProcessLlm({ ...snap(), folded: many.slice(0, 64) })!.degraded, false);
    // a long list still excludes its last child: no double count past the writer's limit
    const parent = entry(1, { active: 2, folded: many });
    assert.equal(hostCount(snap(), [parent, entry(2, { active: 5, producer: "c299" })], NOW, all).count, 2);
    assert.equal(parseProcessLlm({ ...snap(), folded: "x" })!.degraded, true);
    assert.equal(parseProcessLlm({ ...snap(), folded: [1, "ok"] })!.degraded, true);
    const huge = parseProcessLlm({ ...snap(), active: 10_000_000 })!;
    assert.deepEqual([huge.active, huge.degraded], [MAX_CALLS, true]);
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
  let dir: string;
  let own: FakeOwn;
  let peers: Array<{ id: string; url: string }>;
  let sockets: FakeSocket[];
  let hub: LlmInflightHub;
  let time: ReturnType<typeof virtualTime>;
  const record = (name: string, pid: number, llm: Partial<LlmProcessSnapshot> | null, heartbeat = Date.now()) =>
    writeFileSync(join(dir, name), JSON.stringify({ session: { pid }, heartbeat, ...(llm ? { presence: { llm: snap({ producer: `p${pid}`, pid, ...llm }) } } : {}) }));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llm-inflight-"));
    own = new FakeOwn();
    peers = [];
    sockets = [];
    time = virtualTime();
    hub = new LlmInflightHub({
      own,
      liveDir: dir,
      alive: (pid) => pid < 1000,
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
    rmSync(dir, { recursive: true, force: true });
  });

  test("snapshot on connect, then a frame only when the total or its coverage changes", async () => {
    record("p1-a.json", 1, { active: 1 });
    const got: SessionFeedMessage[] = [];
    const off = hub.addBrowser((m) => got.push(m));
    assert.deepEqual(inflights(got), [{ count: 1, approximate: 0, partial: false, gaps: [] }]);
    record("p1-a.json", 1, { active: 1 }); // a heartbeat-only rewrite
    await time.advance(400); // ten sweeps: a full rescan, whatever the watcher saw
    assert.equal(got.length, 1);
    own.set({ active: 2 });
    record("p2-b.json", 2, null);
    await time.advance(400); // ten sweeps: a full rescan, whatever the watcher saw
    assert.deepEqual(inflights(got).at(-1), { count: 3, approximate: 0, partial: true, gaps: [{ reason: "unreported", processes: 1 }] });
    unlinkSync(join(dir, "p2-b.json"));
    own.set({ active: 0 });
    await time.advance(400); // ten sweeps: a full rescan, whatever the watcher saw
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

describe("the live-record watch comes back", () => {
  test("a live dir that appears later, and a watch that fails, are watched again at the next sweep", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-late-"));
    const dir = join(root, "live");
    const own = new FakeOwn();
    const time = virtualTime();
    const hub = new LlmInflightHub({ own, liveDir: dir, alive: () => true, debounceMs: 5, sweepMs: 40, now: time.now, timers: time.timers });
    const got: SessionFeedMessage[] = [];
    try {
      hub.addBrowser((m) => got.push(m));
      assert.equal((hub as any).watcher, null, "no dir yet");
      mkdirSync(dir);
      await time.advance(40);
      assert.notEqual((hub as any).watcher, null, "attached once the dir exists");
      (hub as any).watcher.emit("error", new Error("watch lost"));
      assert.equal((hub as any).watcher, null);
      await time.advance(40);
      assert.notEqual((hub as any).watcher, null, "re-attached");
      // the re-attached watch sees a new record without waiting for the 30 s rescan
      writeFileSync(join(dir, "p9-x.json"), JSON.stringify({ session: { pid: 9 }, heartbeat: Date.now(), presence: { llm: snap({ producer: "p9", pid: 9, active: 2 }) } }));
      await until(() => time.waiting(5) > 0, "the watch event's debounce");
      await time.advance(5);
      assert.equal(inflights(got).at(-1)!.count, 2);
    } finally {
      hub.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the worker registry is read per sweep, never per call", () => {
  test("100 own begin/end changes cause no registry read; the sweep does; an adoption between reads counts once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-reg-"));
    const own = new FakeOwn();
    let reads = 0;
    let registry: UnadoptedWorker[] = [{ key: "a/1", producer: "w7", counts: { active: 1, approximate: 0, claudeTurns: 0, degraded: false } }];
    const time = virtualTime();
    const hub = new LlmInflightHub({ own, liveDir: dir, alive: () => true, debounceMs: 1, sweepMs: 150, workers: () => (reads++, registry), now: time.now, timers: time.timers });
    const got: SessionFeedMessage[] = [];
    try {
      hub.addBrowser((m) => got.push(m));
      assert.equal(reads, 1, "one read when counting starts");
      for (let i = 0; i < 100; i++) own.set({ active: (i + 1) % 2 }); // ends at 0
      await time.advance(30);
      assert.equal(reads, 1, "begin/end recounts from the held snapshot");
      assert.equal(inflights(got).at(-1)!.count, 1, "own 0 + the unadopted worker's 1");
      // the worker is adopted: its parent's record names it, before the registry is read again
      writeFileSync(join(dir, "p3-x.json"), JSON.stringify({ session: { pid: 3 }, heartbeat: Date.now(), presence: { llm: snap({ producer: "p3", pid: 3, active: 1, folded: ["w7"] }) } }));
      await until(() => time.waiting(1) > 0, "the watch event's debounce");
      await time.advance(40);
      assert.equal(reads, 1);
      assert.equal(inflights(got).at(-1)!.count, 1, "counted once: the held copy is excluded by the parent's folded");
      registry = [];
      await time.advance(200);
      assert.equal(reads >= 2, true, "the sweep refreshed it");
      assert.equal(inflights(got).at(-1)!.count, 1);
    } finally {
      hub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- output tokens ---------------------------------------------------------------------------

const S = Math.floor(NOW / 30_000);
const ringAt = (end: number, slots: Record<number, number>, partial?: true): TokenRing => ({ bucketMs: 30_000, end, out: Array.from({ length: 60 }, (_, i) => slots[i] ?? 0), ...(partial ? { partial } : {}) });
const tail = (t: LlmInflight["tokens"], n = 3) => t!.out.slice(60 - n);
const zeros = () => new Array(60).fill(0);

describe("tokens: one host", () => {
  test("parsed bounded with presence.llm; a malformed ring is dropped alone", () => {
    const tokens = ringAt(S, { 59: 5 });
    assert.deepEqual(parseProcessLlm(snap({ tokens }))!.tokens, tokens);
    assert.equal(parseProcessLlm(snap({ tokens: ringAt(S, { 59: 1e12 }) }))!.tokens!.out[59], MAX_SLOT_TOKENS, "a slot past the cap is capped");
    for (const bad of [{ ...tokens, bucketMs: 1000 }, { ...tokens, out: [1, 2] }, { ...tokens, out: [...tokens.out.slice(1), -3] }, { ...tokens, end: 0.5 }, "x"]) {
      const got = parseProcessLlm({ ...snap(), tokens: bad });
      assert.ok(got, "the count survives");
      assert.equal(got.tokens, undefined);
    }
  });

  test("own plus each counted process, aligned to now's slot; none absent from an own without a ring", () => {
    const own = snap({ tokens: ringAt(S - 1, { 59: 10 }) });
    const got = hostCount(own, [entry(1, { tokens: ringAt(S, { 59: 3 }) }), entry(2, { tokens: ringAt(S - 2, { 59: 7, 58: 1 }) })], NOW, all);
    assert.deepEqual(tail(got.tokens, 4), [1, 7, 10, 3]);
    assert.equal(got.tokens!.end, S);
    assert.equal(got.tokens!.partial, false);
    assert.equal(hostCount(snap(), [entry(1, { tokens: ringAt(S, { 59: 3 }) })], NOW, all).tokens, undefined);
  });

  test("folded producers add no tokens; a process, worker or own without a ring, or any gap, is partial", () => {
    const own = snap({ tokens: ringAt(S, {}) });
    const parent = entry(1, { active: 1, folded: ["p2", "w9"], tokens: ringAt(S, { 59: 5 }) });
    const child = entry(2, { active: 1, tokens: ringAt(S, { 59: 100 }) });
    const worker: UnadoptedWorker = { key: "o/w9", producer: "w9", counts: { active: 0, approximate: 0, claudeTurns: 0, degraded: false }, tokens: ringAt(S, { 59: 1000 }) };
    const got = hostCount(own, [parent, child], NOW, all, [worker]);
    assert.deepEqual(tail(got.tokens, 1), [5], "only the parent's ring: it already holds its workers'");
    assert.equal(got.tokens!.partial, false);
    assert.equal(hostCount(own, [entry(3, {})], NOW, all).tokens!.partial, true, "an older counter: its tokens unknown");
    assert.equal(hostCount(own, [entry(3, { tokens: ringAt(S, {}, true) })], NOW, all).tokens!.partial, true, "a process that says its own ring is partial");
    assert.equal(hostCount(snap({ tokens: ringAt(S, {}, true) }), [], NOW, all).tokens!.partial, true);
    assert.equal(hostCount(own, [], NOW, all, [{ key: "o/x", producer: "x", counts: { active: 0, approximate: 0, claudeTurns: 0, degraded: false } }]).tokens!.partial, true, "a worker that reported no ring");
    assert.equal(hostCount(own, [entry(4, null)], NOW, all).tokens!.partial, true, "an unreported process");
    assert.equal(hostCount(own, [entry(5, { claudeTurns: 1, tokens: ringAt(S, {}) })], NOW, all).tokens!.partial, true, "a Claude Code turn's internal calls");
  });

  test("a host's slot is bounded", () => {
    const big = ringAt(S, { 59: MAX_SLOT_TOKENS });
    const entries = Array.from({ length: 20 }, (_, i) => entry(i + 1, { tokens: big }));
    assert.equal(hostCount(snap({ tokens: ringAt(S, {}) }), entries, NOW, all).tokens!.out[59], 10 * MAX_SLOT_TOKENS);
  });

  test("a departed producer's ring stays until it ages out, unless a counted process now folds it", () => {
    const own = snap({ tokens: ringAt(S, {}) });
    const retained = new Map<string, TokenRing>();
    hostCount(own, [entry(1, { tokens: ringAt(S, { 59: 40, 0: 2 }) }), entry(2, { tokens: ringAt(S, { 59: 9 }) })], NOW, all, [], retained);
    // p1 exits (its record gone); p2's pid dies
    const gone = hostCount(own, [entry(2, { tokens: ringAt(S, { 59: 9 }) })], NOW, (pid) => pid !== 2, [], retained);
    assert.deepEqual(tail(gone.tokens, 1), [49], "both still in the window");
    const later = hostCount(own, [], NOW + 30_000, all, [], retained);
    assert.deepEqual(tail(later.tokens, 2), [49, 0], "aged by one slot");
    assert.equal(later.tokens!.out[0], 0, "its oldest slot aged out");
    assert.equal(hostCount(own, [], NOW + 60 * 30_000, all, [], retained).tokens!.out.every((n) => n === 0), true);
    assert.equal(retained.size, 0, "forgotten once aged out");
    // adopted: now folded into another process's count, whose ring holds it
    hostCount(own, [entry(1, { tokens: ringAt(S, { 59: 40 }) })], NOW, all, [], retained);
    const adopted = hostCount(own, [entry(3, { folded: ["p1"], tokens: ringAt(S, { 59: 40 }) })], NOW, all, [], retained);
    assert.deepEqual(tail(adopted.tokens, 1), [40], "never twice");
    assert.equal(retained.has("p1"), false);
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
    const dir = mkdtempSync(join(tmpdir(), "llm-tok-"));
    const own = new FakeOwn();
    let clock = NOW;
    const sockets: FakeSocket[] = [];
    const time = virtualTime(NOW);
    own.value = snap({ tokens: ringAt(S, {}) });
    const hub = new LlmInflightHub({
      own, liveDir: dir, alive: () => true, debounceMs: 1, sweepMs: 20, now: () => clock, timers: time.timers, peerPingMs: 1e9, peerDeadMs: 1e9,
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
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
