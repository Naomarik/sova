// The stall recorder's logic, in-process: the board, the cap, the watchdog's decisions on a fake
// clock, what may enter a record. The real thread against a really blocked loop is
// stall-recorder.integration.test.ts.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import {
  ActivityBoard, CappedLog, foldTraces, frameLabel, lateQuantile, NAME_SLOTS, OTHER_NAME, stallLogDir, StallWatch, summariesOf,
  type MainSample, type ProcDetail, type StallSummary, type WatchConfig,
} from "./stall-recorder-core";
import { opEnd, opStart, opTrack, stallRecorderStatus } from "./stall-recorder";
import { routeOpName } from "./stall-recorder-route";
import { stateRoot } from "./state-root";

const root = mkdtempSync(join(tmpdir(), "sova-stall-"));
after(() => rmSync(root, { recursive: true, force: true }));
let nthDir = 0;
const dir = () => join(root, `d${nthDir++}`);

describe("the board", () => {
  test("an op is seen in flight by a second view of the same memory, and moves to recent when it ends", () => {
    const writer = ActivityBoard.create();
    const reader = new ActivityBoard(writer.sab);
    const op = writer.enter("GET /api/sessions", 100, 7);
    assert.deepEqual(reader.ops(112).list, [{ name: "GET /api/sessions", ageMs: 1200, detail: 7 }]);
    writer.exit(op, 130, 2706);
    assert.equal(reader.ops(131).total, 0);
    assert.deepEqual(reader.recent(131), [{ name: "GET /api/sessions", agoMs: 3100, durationMs: 3000, detail: 2706 }]);
  });

  test("a spent or unknown token ends nothing, even when its slot holds the next op", () => {
    const b = ActivityBoard.create();
    const first = b.enter("first", 1);
    b.exit(first, 2);
    const second = b.enter("second", 3);
    b.exit(first, 4);
    b.exit(first, 4);
    b.exit(-1, 4);
    b.exit(99999, 4);
    assert.deepEqual(b.ops(5).list.map((o) => o.name), ["second"]);
    b.exit(second, 6);
    assert.equal(b.ops(7).total, 0);
  });

  test("past the slots an op is counted, not an error, and the slots come back", () => {
    const b = ActivityBoard.create();
    const tokens = Array.from({ length: 64 }, () => b.enter("a", 1));
    assert.ok(tokens.every((t) => t >= 0));
    assert.equal(b.enter("over", 1), -1);
    assert.equal(b.ops(2, 100).dropped, 1);
    b.exit(tokens[0]!, 2);
    assert.ok(b.enter("back", 2) >= 0);
  });

  test("names beyond the table share one name; a long name is cut, not lost", () => {
    const b = ActivityBoard.create();
    for (let i = 0; i < NAME_SLOTS + 50; i++) b.nameId(`name ${i}`);
    const op = b.enter("one more name", 1);
    assert.equal(b.ops(2).list[0]!.name, OTHER_NAME);
    b.exit(op, 2);
    const c = ActivityBoard.create();
    c.enter("x".repeat(500), 1);
    assert.equal(c.ops(2).list[0]!.name, "x".repeat(47));
  });

  test("the recent ring keeps the newest, newest first, however many went through", () => {
    const b = ActivityBoard.create();
    for (let i = 0; i < 1000; i++) b.exit(b.enter(`op ${i}`, i), i + 1);
    const recent = b.recent(1001, 3);
    assert.deepEqual(recent.map((r) => r.name), ["op 999", "op 998", "op 997"]);
  });

  test("the beat counts lateness into buckets a quantile can read, and the max goes back to zero", () => {
    const b = ActivityBoard.create();
    for (let i = 0; i < 99; i++) b.beat(3);
    b.beat(20_000);
    assert.equal(b.beatSeq(), 100);
    assert.equal(lateQuantile(b.lateCounts(), 0.5), 10);
    assert.equal(lateQuantile(b.lateCounts(), 1), 15000);
    assert.equal(b.takeLateMax(), 20_000);
    assert.equal(b.takeLateMax(), 0);
  });

  test("memory goes up in megabytes and says how old it is", () => {
    const b = ActivityBoard.create();
    assert.equal(b.memory(1), null);
    b.publishMemory(10, { heapUsed: 5 * 1024 ** 2, heapTotal: 6 * 1024 ** 2, external: 7 * 1024 ** 2, arrayBuffers: 8 * 1024 ** 2 });
    assert.deepEqual(b.memory(30), { ageMs: 2000, heapUsedMb: 5, heapTotalMb: 6, externalMb: 7, arrayBuffersMb: 8 });
  });
});

describe("the log", () => {
  test("many times the cap of writes never passes two files, and the newest record survives", () => {
    const d = dir();
    const log = new CappedLog(d, 4096, 1024);
    for (let i = 0; i < 2000; i++) log.write({ i, pad: "x".repeat(100) });
    const size = statSync(join(d, "stalls.jsonl")).size;
    const old = statSync(join(d, "stalls.1.jsonl")).size;
    assert.ok(size <= 4096, `newest file ${size}`);
    assert.ok(old <= 4096, `older file ${old}`);
    assert.equal(log.tail().at(-1)!.i, 1999);
  });

  test("a new process starts from the file's real size: restarts can't outrun the cap", () => {
    const d = dir();
    for (let run = 0; run < 50; run++) {
      const log = new CappedLog(d, 1024, 512);
      for (let i = 0; i < 5; i++) log.write({ run, i, pad: "x".repeat(100) });
    }
    assert.ok(statSync(join(d, "stalls.jsonl")).size <= 1024);
    assert.ok(statSync(join(d, "stalls.1.jsonl")).size <= 1024);
  });

  test("a record over the line limit gives up its long lists, stays valid, and says so", () => {
    const d = dir();
    const log = new CappedLog(d, 1 << 20, 1024);
    log.write({ t: "stall", atMostMs: 5000, stacks: Array.from({ length: 500 }, (_, i) => `frame ${i}`) });
    const [rec] = log.tail();
    assert.equal(rec!.atMostMs, 5000);
    assert.equal(rec!.truncated, true);
    assert.equal(rec!.stacks, undefined);
  });

  test("a record that can't be made short enough is left out", () => {
    const d = dir();
    const log = new CappedLog(d, 1 << 20, 256);
    log.write({ t: "x", other: "y".repeat(1000) });
    assert.equal(existsSync(join(d, "stalls.jsonl")), false);
  });

  test("a torn last line reads as the records before it", () => {
    const d = dir();
    const log = new CappedLog(d);
    log.write({ n: 1 });
    writeFileSync(log.file, readFileSync(log.file, "utf8") + '{"n":2,"tor', "utf8");
    assert.deepEqual(log.tail().map((r) => r.n), [1]);
  });
});

/** The watchdog on a fake clock, its reads scripted and its writes kept. */
function rig(over: Partial<WatchConfig> = {}, earlier: Record<string, unknown>[] = []) {
  const board = ActivityBoard.create();
  const written: Record<string, any>[] = [];
  const sent: unknown[] = [];
  const io = {
    t: 1000,
    rss: 100,
    sample: { state: "R", cpuMs: 0, runQueueMs: 0 } as MainSample,
    threads: { "(main)": 0, HeapHelper: 0 } as Record<string, number>,
    mono() { return this.t; },
    wall() { return 1_000_000 + this.t; },
    rssBytes() { return this.rss; },
    mainSample() { return { ...this.sample }; },
    detail(): ProcDetail { return { memory: { rssBytes: this.rss }, threads: { ...this.threads } }; },
    write: (rec: Record<string, unknown>) => void written.push(rec),
    toMain: (msg: unknown) => void sent.push(msg),
  };
  const watch = new StallWatch(board, { beatMs: 1000, stallMs: 2000, tickMs: 1000, memoryFirstBytes: 1000, pid: 42, startedAt: 1_000_000, ...over }, io, earlier);
  const step = (beating: boolean, ms = 1000) => {
    io.t += ms;
    if (beating) board.beat(0);
    watch.tick();
  };
  const of = (t: string) => written.filter((r) => r.t === t);
  return { board, written, sent, io, watch, step, of };
}

describe("the watchdog", () => {
  test("a beating loop writes nothing but the boot line, however long it runs", () => {
    const r = rig();
    for (let i = 0; i < 500; i++) r.step(true);
    assert.deepEqual(r.written.map((w) => w.t), ["boot"]);
  });

  test("a silent loop opens once, past the threshold and not before, with what was in flight", () => {
    const r = rig();
    r.board.enter("GET /api/sessions", 10);
    r.step(true);
    r.step(false);
    r.step(false);
    assert.equal(r.of("stall-open").length, 0, "2 s of silence is within the beat plus the threshold");
    r.step(false);
    r.step(false);
    r.step(false);
    assert.equal(r.of("stall-open").length, 1);
    const open = r.of("stall-open")[0]!;
    assert.equal(open.ops[0].name, "GET /api/sessions");
    assert.equal(open.sinceAt, 1_000_000 + 2000);
  });

  test("a held stall is written at each doubling: a process that dies in one leaves a trail, a long one few lines", () => {
    const r = rig();
    r.step(true);
    for (let i = 0; i < 300; i++) r.step(false);
    assert.deepEqual(r.of("stall-progress").map((p) => p.heldMs), [6000, 12000, 24000, 48000, 96000, 192000]);
  });

  test("the main thread's word closes it with the stacks, the bounds and what the thread spent", () => {
    const r = rig();
    r.step(true);
    for (let i = 0; i < 6; i++) {
      r.io.sample = { state: i < 3 ? "R" : "D", cpuMs: i * 900, runQueueMs: i * 50, wchan: "folio_wait" };
      r.io.threads = { "(main)": i * 900, HeapHelper: i * 2000 };
      r.io.rss = 100 + i * 10;
      r.step(false);
    }
    r.board.beat(6000);
    r.watch.stallEnded({ gapMs: 7000, atLeastMs: 6000, stacks: [{ samples: 60, frames: ["parentOf server/x.ts:1"] }], samples: 60 });
    const [s] = r.of("stall");
    assert.equal(r.of("stall").length, 1);
    assert.equal(s!.atLeastMs, 6000);
    assert.equal(s!.atMostMs, 7000);
    assert.equal(s!.source, "main");
    assert.equal(s!.seenLive, true);
    assert.equal(s!.stacks[0].frames[0], "parentOf server/x.ts:1");
    assert.deepEqual(s!.states, { R: 1, D: 3 });
    assert.equal(s!.rssPeakBytes, 150);
    assert.ok(s!.mainCpuMs > 0);
    assert.ok(s!.mainRunQueueMs > 0);
    assert.equal(s!.threads[0].name, "HeapHelper", "the collector's threads outspent the main thread here");
    for (let i = 0; i < 5; i++) r.step(true);
    assert.equal(r.of("stall").length, 1, "the watchdog doesn't close it a second time");
  });

  test("a stall the main thread never reports is closed by the watchdog, from what it saw", () => {
    const r = rig();
    r.step(true);
    for (let i = 0; i < 6; i++) r.step(false);
    for (let i = 0; i < 4; i++) r.step(true);
    const [s] = r.of("stall");
    assert.equal(s!.source, "watchdog");
    assert.equal(s!.stacks, undefined);
    assert.equal(s!.atMostMs, 7000);
  });

  test("a stall too short for the watchdog's eye is still written from the main thread's word", () => {
    const r = rig();
    r.watch.stallEnded({ gapMs: 3100, atLeastMs: 2100 });
    const [s] = r.of("stall");
    assert.equal(s!.seenLive, false);
    assert.equal(s!.atMostMs, 3100);
  });

  test("each rung is crossed once, the next at twice it, and the main thread is asked each time", () => {
    const r = rig();
    for (const rss of [999, 1000, 1500, 1999, 2000, 16_000]) {
      r.io.rss = rss;
      r.step(true);
    }
    assert.deepEqual(r.of("memory").map((m) => m.rungBytes), [1000, 2000, 4000]);
    assert.deepEqual(r.sent.filter((m: any) => m.k === "memory").map((m: any) => m.rungBytes), [1000, 2000, 4000]);
  });

  test("a ladder comes back only once memory has fallen and stayed quiet", () => {
    const r = rig();
    r.io.rss = 1000;
    r.step(true);
    r.io.rss = 100;
    r.step(true);
    r.io.rss = 1000;
    r.step(true);
    assert.equal(r.of("memory").length, 1, "soon after: the same rung isn't written again");
    r.io.rss = 100;
    r.step(true, 11 * 60_000);
    r.io.rss = 1000;
    r.step(true);
    assert.equal(r.of("memory").length, 2);
  });

  test("over the first rung the ramp is written as it moves, and a flat line writes nothing", () => {
    const r = rig();
    r.io.rss = 2500;
    r.step(true, 5000);
    const before = r.of("mem").length;
    for (let i = 0; i < 100; i++) r.step(true, 5000);
    assert.equal(r.of("mem").length, before, "flat");
    for (let i = 0; i < 10; i++) {
      r.io.rss = Math.round(r.io.rss * 1.1);
      r.step(true, 5000);
    }
    assert.equal(r.of("mem").length, before + 10);
  });

  test("once an hour, one line of lateness", () => {
    const r = rig();
    r.board.beat(30_000);
    for (let i = 0; i < 3600; i++) r.step(true);
    const [h] = r.of("hour");
    assert.equal(h!.lateMaxMs, 30_000);
    assert.equal(h!.lateP50Ms, 10);
  });

  test("a stall its process never closed reads as unfinished after a restart", () => {
    const earlier = [
      { t: "stall-open", at: 1, pid: 7, ops: [{ name: "GET /api/x", ageMs: 1 }] },
      { t: "stall-open", at: 2, pid: 8 },
      { t: "stall", at: 3, pid: 8, atMostMs: 9000 },
    ];
    const r = rig({}, earlier);
    const msg = r.sent.at(-1) as { k: string; list: StallSummary[] };
    assert.equal(msg.k, "summaries");
    assert.deepEqual(msg.list.map((s) => [s.kind, s.pid, s.unfinished ?? false]), [["stall-open", 7, true], ["stall", 8, false]]);
    assert.deepEqual(msg.list[0]!.ops, ["GET /api/x"]);
  });

  test("the running process's own open stall is not called unfinished", () => {
    assert.equal(summariesOf([{ t: "stall-open", at: 1, pid: 7 }], 7)[0]!.unfinished, undefined);
  });
});

describe("what may enter a record", () => {
  test("a frame names its function and repository path, never where the repository is", () => {
    const home = homedir();
    assert.equal(frameLabel({ name: "parentOf", sourceURL: `${home}/webapps/sova/server/overseer-ideas.ts`, line: 79 }), "parentOf server/overseer-ideas.ts:79");
    assert.equal(frameLabel({ name: "x", sourceURL: `${home}/secret/place/tool.js`, line: 1 }), "x tool.js:1");
    assert.equal(frameLabel({ name: "", sourceURL: "[native code]" }), "(anonymous)");
    assert.equal(frameLabel({ name: "f", sourceURL: "/a/server/b.ts", line: 0xffffffff }), "f server/b.ts");
  });

  test("a request's name is its route pattern, whatever its URL carries", async () => {
    const app = new Hono();
    const seen: string[] = [];
    app.use("*", async (c, next) => {
      seen.push(routeOpName(c));
      await next();
    });
    app.use("/api/*", (_c, next) => next());
    app.get("/api/sessions/:id/thing", (c) => c.text("ok"));
    await app.request("/api/sessions/the-private-name/thing?q=some-secret");
    await app.request("/api/nothing/here/at-all");
    assert.deepEqual(seen, ["GET /api/sessions/:id/thing", "GET (no route)"]);
  });
});

describe("folding stacks", () => {
  const trace = (timestamp: number, ...names: string[]) => ({ timestamp, frames: names.map((name) => ({ name })) });

  test("the window keeps the stall's samples and leaves out what ran before it", () => {
    const { samples, stacks } = foldTraces([trace(1, "before"), trace(100, "stuck"), trace(101, "stuck"), trace(102, "stuck", "caller")], 3000);
    assert.equal(samples, 3);
    assert.deepEqual(stacks, [{ samples: 2, frames: ["stuck"] }, { samples: 1, frames: ["stuck", "caller"] }]);
  });

  test("the kept stacks are bounded, commonest first", () => {
    const traces = Array.from({ length: 500 }, (_, i) => trace(i, `f${i % 40}`, i % 40 === 3 ? "x" : "y"));
    traces.push(trace(500, "f3", "x"));
    const { stacks } = foldTraces(traces);
    assert.equal(stacks.length, 10);
    assert.deepEqual(stacks[0]!.frames, ["f3", "x"]);
  });
});

describe("the main thread's calls, with the recorder off", () => {
  test("they do nothing, say so and hand results and errors straight through", async () => {
    assert.equal(stallRecorderStatus().state, "off");
    assert.equal(opStart("x"), -1);
    opEnd(-1);
    assert.equal(opTrack("x", () => 5), 5);
    assert.equal(await opTrack("x", async () => 6), 6);
    assert.throws(() => opTrack("x", () => { throw new Error("boom"); }), /boom/);
    await assert.rejects(opTrack("x", async () => { throw new Error("boom"); }), /boom/);
  });
});

describe("the log's folder", () => {
  test("is the state root's, worked out without the harness", () => {
    const saved = process.env.PI_CODING_AGENT_DIR;
    try {
      for (const set of [undefined, "~", "~/elsewhere/agent", "/some/where/agent"]) {
        if (set === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = set;
        assert.equal(stallLogDir(), join(stateRoot(), "stalls"), `PI_CODING_AGENT_DIR=${set}`);
      }
    } finally {
      process.env.PI_CODING_AGENT_DIR = saved;
    }
  });
});
