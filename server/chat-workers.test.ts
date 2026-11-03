// The worker registry (§app.chat-processes/workers, /worker-crash) over a fake router: no process, no
// socket. A worker chat's "handle" is a stand-in with a mirror and a `call` that records.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { WorkerFeedFrame, WorkerStart } from "../shared/chat-runtime";
import type { RemoteChatHandle } from "./chat-handle-remote";
import type { ChatDeath } from "./chat-runtime/supervisor";
import { deathText, type WorkerProcesses, type WorkerRecord, WorkerRegistry } from "./chat-workers";

interface FakeHandle {
  mirror: Record<string, unknown> & { sessionId: string; worker: { proc: string; seq?: number; lastSettled: unknown } };
  at: { pid: number; unit: string };
  closed: boolean;
  calls: { method: string; args: unknown }[];
  call(method: string, args: unknown): Promise<unknown>;
  sent: unknown[];
  sendWorker(f: unknown): void;
}

let dir: string;
let n = 0;

/** What a worker's surviving process took under its keys (its keyed-send receipts): shared across fake handles of one "process". */
type Taken = Set<string>;

function fakeProcs(o: { failStart?: string; failSend?: string; feedSince?: (args: { proc: string; seq: number }) => unknown; holdStart?: boolean; holdSend?: "before" | "after"; taken?: Taken } = {}) {
  const handles: FakeHandle[] = [];
  const stopped: string[] = [];
  const procs: WorkerProcesses = {
    start: async (rec: WorkerRecord) => {
      if (o.failStart) throw new Error(o.failStart);
      // The server dies here: the process never opens.
      if (o.holdStart) return new Promise<never>(() => {});
      const h: FakeHandle = {
        mirror: { sessionId: rec.chatId, running: false, starting: false, compacting: false, model: rec.spec.model ? { ref: rec.spec.model } : null, thinking: "low", worker: { proc: `p${++n}`, lastSettled: null } },
        at: { pid: 1000 + n, unit: "u" },
        closed: false,
        calls: [],
        call: async (method, args) => {
          h.calls.push({ method, args });
          if (method === "send") {
            if (o.failSend) throw new Error(o.failSend);
            // The server dies before the send leaves it, or after the process took it (its answer lost).
            if (o.holdSend === "before") {
              h.calls.pop();
              return new Promise<never>(() => {});
            }
            const key = (args as { key?: string }).key;
            if (key && o.taken) {
              if (o.taken.has(key)) return { queued: false, turnId: null, again: true };
              o.taken.add(key);
            }
            if (o.holdSend === "after") return new Promise<never>(() => {});
            return { queued: false, turnId: null };
          }
          if (method === "feedSince") return o.feedSince ? o.feedSince(args as { proc: string; seq: number }) : { gap: true };
          return null;
        },
        sent: [],
        sendWorker: (f) => void h.sent.push(f),
      };
      handles.push(h);
      return h as unknown as RemoteChatHandle;
    },
    stop: async (rec) => void stopped.push(rec.chatId),
  };
  return { procs, handles, stopped };
}

const start = (key = "sid:ag_01:1", task: string | null = "do it"): WorkerStart => ({
  key,
  spec: {
    kind: "worker",
    parent: { sessionId: "sid", path: "/p/parent.jsonl", workerId: "ag_01" },
    cwd: dir,
    model: "zai/glm-5.3",
    thinking: "low",
    builtins: null,
    extensions: [],
    flags: {},
    appendSystemPrompt: null,
    env: {},
    agentDir: null,
    lowered: true,
  },
  session: { new: { dir: join(dir, "sessions") } },
  task,
});

const reg = (procs: WorkerProcesses, o: { autoResume?: boolean; opened?: string[]; logged?: unknown[] } = {}) =>
  new WorkerRegistry(procs, {
    dir: () => join(dir, "workers"),
    autoResume: () => o.autoResume ?? true,
    openParent: async (p) => void o.opened?.push(p),
    logResume: (args, why) => void o.logged?.push({ ...args, outcome: why ?? "resumed" }),
  });
const PARENT = { sessionId: "sid", path: "/p/parent.jsonl" };
const linkOf = (p: { sessionId: string; path: string }) => ({ mirror: { sessionId: p.sessionId }, path: p.path, sent: [] as unknown[], sendWorker(f: unknown) { this.sent.push(f); } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chat-workers-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("WorkerRegistry", () => {
  test("a watcher's state says whether the worker's process names send keys; a process on older code says nothing (§app.chat-processes/worker-instructions)", async () => {
    const { procs, handles } = fakeProcs();
    const r = reg(procs);
    const ref = await r.start(start("k", null));
    const states: { keys?: true }[] = [];
    r.watch(ref.chatId, null, (f) => void (f.t === "state" && states.push(f.state)));
    assert.equal(states.at(-1)!.keys, undefined, "an older process's mirror names no keys");
    const h = handles[0]!;
    h.mirror = { ...h.mirror, worker: { ...h.mirror.worker, keys: true } as never };
    r.onState(h as unknown as RemoteChatHandle);
    assert.equal(states.at(-1)!.keys, true);
  });

  test("a start makes the session file, writes the record, opens the process, sends the task once under its key", async () => {
    const { procs, handles } = fakeProcs();
    const r = reg(procs);
    const ref = await r.start(start());
    assert.equal(ref.workerId, "ag_01");
    assert.equal(ref.state, "open");
    assert.ok(readFileSync(ref.sessionFile, "utf8").includes('"type":"session"'));
    const rec = JSON.parse(readFileSync(join(dir, "workers", `${encodeURIComponent(ref.chatId)}.json`), "utf8"));
    assert.equal(rec.key, "sid:ag_01:1");
    assert.equal(handles.length, 1);
    assert.deepEqual(handles[0]!.calls, [{ method: "send", args: { text: "do it", key: "sid:ag_01:1:task", origin: "server", report: false } }]);
    // The same key again: the first ref, nothing started or sent.
    const again = await r.start(start());
    assert.equal(again.chatId, ref.chatId);
    assert.equal(handles.length, 1);
    assert.equal(handles[0]!.calls.length, 1);
    assert.deepEqual(r.list("sid").map((x) => x.chatId), [ref.chatId]);
    assert.deepEqual(r.list("other"), []);
  });

  test("a start the last server recorded but never finished is finished by the next one when the parent's start comes again: one task, taken once", async () => {
    const taken = (h: FakeHandle[]) => h.flatMap((x) => x.calls).filter((c) => c.method === "send" && (c.args as { key: string }).key === "sid:ag_01:1:task");
    // (a) It dies after recording the worker, before its process opened.
    {
      const first = reg(fakeProcs({ holdStart: true }).procs);
      void first.start(start());
      await new Promise((r) => setTimeout(r, 20));
      const { procs, handles } = fakeProcs();
      const next = reg(procs);
      const ref = await next.start(start());
      assert.equal(handles.length, 1, "one worker");
      assert.equal(taken(handles).length, 1, "its task, sent once");
      assert.equal(ref.state, "open");
      await next.start(start());
      assert.equal(taken(handles).length, 1, "and not again");
      rmSync(join(dir, "workers"), { recursive: true, force: true });
    }
    // (b) It dies after the process opened, before the task was sent.
    {
      const first = reg(fakeProcs({ holdSend: "before" }).procs);
      void first.start(start());
      await new Promise((r) => setTimeout(r, 20));
      const { procs, handles } = fakeProcs();
      const ref = await reg(procs).start(start());
      assert.equal(taken(handles).length, 1);
      assert.ok(ref.chatId);
      rmSync(join(dir, "workers"), { recursive: true, force: true });
    }
    // (c) The process took the task, the answer was lost: sent again under its key, taken once (the surviving process's receipt).
    {
      const process1: Taken = new Set();
      const first = reg(fakeProcs({ holdSend: "after", taken: process1 }).procs);
      void first.start(start());
      await new Promise((r) => setTimeout(r, 20));
      await reg(fakeProcs({ taken: process1 }).procs).start(start());
      assert.deepEqual([...process1], ["sid:ag_01:1:task"]);
      rmSync(join(dir, "workers"), { recursive: true, force: true });
    }
    // (d) Taken, the answer lost, and the worker's process gone too (no receipts left): its session holds the task, so it is not sent again.
    {
      const first = reg(fakeProcs({ holdSend: "after", taken: new Set() }).procs);
      void first.start(start());
      await new Promise((r) => setTimeout(r, 20));
      const rec = JSON.parse(readFileSync(join(dir, "workers", readdirSync(join(dir, "workers")).find((f) => f.endsWith(".json"))!), "utf8")) as WorkerRecord;
      appendFileSync(rec.path, `${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "do it" }], timestamp: Date.now() } })}\n`);
      const { procs, handles } = fakeProcs({ taken: new Set() });
      await reg(procs).start(start());
      assert.equal(taken(handles).length, 0, "already in its session: not run twice");
    }
  });

  test("a session file never stands for an empty task's delivery, nor one rewritten shorter since the start", async () => {
    const userLine = (text: string) => `${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } })}\n`;
    const sends = (h: FakeHandle[]) => h.flatMap((x) => x.calls).filter((c) => c.method === "send").length;
    const recordOf = () => JSON.parse(readFileSync(join(dir, "workers", readdirSync(join(dir, "workers")).find((f) => f.endsWith(".json"))!), "utf8")) as WorkerRecord;
    // Empty task: any user message would "hold" it.
    {
      void reg(fakeProcs({ holdSend: "before" }).procs).start(start("k", ""));
      await new Promise((r) => setTimeout(r, 20));
      appendFileSync(recordOf().path, userLine("something else"));
      const { procs, handles } = fakeProcs();
      await reg(procs).start(start("k", ""));
      assert.equal(sends(handles), 1, "delivered");
      rmSync(join(dir, "workers"), { recursive: true, force: true });
    }
    // Rewritten shorter than at the start: not consulted, delivered.
    {
      void reg(fakeProcs({ holdSend: "before" }).procs).start(start("k2"));
      await new Promise((r) => setTimeout(r, 20));
      writeFileSync(recordOf().path, "");
      const { procs, handles } = fakeProcs();
      await reg(procs).start(start("k2"));
      assert.equal(sends(handles), 1, "delivered");
    }
  });

  test("a start asked again while its first is still in flight answers only once the task was taken", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { procs, handles } = fakeProcs();
    const real = procs.start;
    procs.start = async (rec) => {
      const h = (await real(rec)) as unknown as FakeHandle;
      const call = h.call;
      h.call = async (m, a) => (m === "send" ? (await gate, call(m, a)) : call(m, a));
      return h as unknown as RemoteChatHandle;
    };
    const r = reg(procs);
    void r.start(start());
    await new Promise((ok) => setTimeout(ok, 20));
    let answered = false;
    const again = r.start(start()).then((x) => ((answered = true), x));
    await new Promise((ok) => setTimeout(ok, 20));
    assert.equal(answered, false, "no success before the task is taken");
    release();
    await again;
    assert.equal(handles[0]!.calls.filter((c) => c.method === "send").length, 1);
  });

  test("a resume opens the file as it is and sends nothing", async () => {
    const { procs, handles } = fakeProcs();
    const r = reg(procs);
    const first = await r.start(start("k1"));
    const resumed = await r.start({ ...start("k2", null), session: { resume: { file: first.sessionFile } } });
    assert.equal(resumed.sessionFile, first.sessionFile);
    assert.equal(handles[1]!.calls.length, 0);
  });

  test("a failed start ends the record with its reason and throws it", async () => {
    const { procs } = fakeProcs({ failStart: "Workers need Bun to run Sova's chat runtime" });
    const r = reg(procs);
    await assert.rejects(r.start(start()), /Workers need Bun/);
    assert.deepEqual(r.list("sid"), []);
  });

  test("a send maps prompt to a plain send and steer/followUp to their delivery; an ended worker refuses", async () => {
    const { procs, handles } = fakeProcs();
    const r = reg(procs);
    const ref = await r.start(start("k", null));
    await r.send(ref.chatId, { text: "a", delivery: "prompt", key: "s1" });
    await r.send(ref.chatId, { text: "b", delivery: "steer", key: "s2" });
    await r.send(ref.chatId, { text: "c", delivery: "followUp", key: "s3" });
    assert.deepEqual(
      handles[0]!.calls.map((c) => c.args),
      [
        { text: "a", key: "s1", origin: "server", report: false },
        { text: "b", key: "s2", origin: "server", report: false, delivery: "steer" },
        { text: "c", key: "s3", origin: "server", report: false, delivery: "followUp" },
      ],
    );
    await r.stop(ref.chatId, "test");
    await r.stop(ref.chatId, "again");
    await assert.rejects(r.send(ref.chatId, { text: "d", delivery: "prompt", key: "s4" }), /has ended/);
  });

  test("the feed: watchers get each frame; a re-watch from a cursor replays the frames after it; another process is a gap", async () => {
    const { procs, handles } = fakeProcs();
    const r = reg(procs);
    const ref = await r.start(start("k", null));
    const h = handles[0]!;
    const seen: WorkerFeedFrame[] = [];
    const off = r.watch(ref.chatId, null, (f) => seen.push(f));
    assert.equal(seen[0]!.t, "state");
    for (let i = 1; i <= 3; i++) r.onFeed(h as unknown as RemoteChatHandle, { t: "feed", cursor: { proc: "p1", seq: i }, event: { type: "turn_start", i } });
    off();
    assert.deepEqual(seen.filter((f) => f.t === "event").map((f) => (f as { cursor: { seq: number } }).cursor.seq), [1, 2, 3]);
    const replay: WorkerFeedFrame[] = [];
    r.watch(ref.chatId, { proc: "p1", seq: 1 }, (f) => replay.push(f));
    assert.deepEqual(replay.map((f) => f.t), ["event", "event", "state"]);
    const other: WorkerFeedFrame[] = [];
    r.watch(ref.chatId, { proc: "old", seq: 9 }, (f) => other.push(f));
    assert.deepEqual(other.map((f) => f.t), ["gap", "state"]);
  });

  test("an idle exit keeps the worker waiting, and its next send reopens it", async () => {
    const { procs, handles } = fakeProcs();
    const r = reg(procs);
    const ref = await r.start(start("k", null));
    const ends: string[] = [];
    r.watch(ref.chatId, null, (f) => f.t === "ended" && ends.push(f.cause));
    r.onExit(ref.chatId, "idle");
    assert.deepEqual(ends, ["idle"]);
    assert.equal(r.list("sid")[0]!.state, "idle");
    await r.send(ref.chatId, { text: "again", delivery: "prompt", key: "s" });
    assert.equal(handles.length, 2);
    assert.equal(r.list("sid")[0]!.state, "open");
  });

  for (const autoResume of [true, false])
    test(`a death with no run in flight keeps the worker waiting (setting ${autoResume ? "on" : "off"}), and its next send reopens it`, async () => {
      const { procs, handles } = fakeProcs();
      const r = reg(procs, { autoResume });
      const ref = await r.start(start("k", null));
      const ends: string[] = [];
      r.watch(ref.chatId, null, (f) => f.t === "ended" && ends.push(f.cause));
      r.died({ chatId: ref.chatId, sessionPath: ref.sessionFile, unit: "u", cause: "crashed", exit: null, signal: "KILL", logTail: ["x"], at: "t" }, null);
      assert.deepEqual(ends, ["idle"]);
      assert.equal(r.list("sid")[0]!.state, "idle");
      assert.equal(handles.length, 1);
      await r.send(ref.chatId, { text: "again", delivery: "prompt", key: "s" });
      assert.equal(handles.length, 2);
      assert.equal(r.list("sid")[0]!.state, "open");
    });

  test("a death mid-run is resumed once (the continue text, under the setting); otherwise it ends with the death text", async () => {
    const { procs, handles } = fakeProcs();
    const r = reg(procs);
    const ref = await r.start(start("k", null));
    const ends: WorkerFeedFrame[] = [];
    r.watch(ref.chatId, null, (f) => f.t === "ended" && ends.push(f));
    const death: ChatDeath = { chatId: ref.chatId, sessionPath: ref.sessionFile, unit: "u", cause: "crashed", exit: null, signal: "KILL", logTail: ["a", "b"], at: "t1" };
    r.died(death, { since: 1 } as never);
    await new Promise((res) => setTimeout(res, 10));
    assert.equal(handles.length, 2);
    assert.deepEqual(handles[1]!.calls.map((c) => c.method), ["markResuming", "send"]);
    assert.match(String((handles[1]!.calls[1]!.args as { text: string }).text), /stopped unexpectedly and cut off your last turn/);
    assert.equal((ends[0] as { resuming?: boolean }).resuming, true);
    // Its resumed run dies again: no second continue.
    r.died({ ...death, at: "t2" }, { since: 2, auto: true } as never);
    assert.equal(handles.length, 2);
    const last = ends.at(-1) as { cause: string; detail?: string };
    assert.equal(last.cause, "died");
    assert.match(last.detail ?? "", /^This worker's process stopped unexpectedly \(signal KILL\)\nLast output: a\nb$/);
    assert.deepEqual(r.list("sid"), []);
  });

  test("a second report of the same death while its resume reopens is ignored: one decision, the resume runs on", async () => {
    const logged: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { procs, handles } = fakeProcs();
    const slow: WorkerProcesses = { ...procs, start: async (rec) => (handles.length ? await gate : undefined, procs.start(rec)) };
    const r = reg(slow, { logged });
    const ref = await r.start(start("k", null));
    const death: ChatDeath = { chatId: ref.chatId, sessionPath: ref.sessionFile, unit: "u", cause: "crashed", exit: null, signal: "KILL", logTail: [], at: "t1" };
    r.died(death, { since: 1 } as never);
    r.died({ ...death, at: "t1b" }, { since: 1, auto: true } as never);
    release();
    await new Promise((res) => setTimeout(res, 10));
    assert.equal(logged.length, 1);
    assert.equal(r.list("sid")[0]!.state, "open");
    assert.deepEqual(handles[1]!.calls.map((c) => c.method), ["markResuming", "send"]);
  });

  test("with the setting off, a death mid-run ends it", async () => {
    const { procs, handles } = fakeProcs();
    const r = reg(procs, { autoResume: false });
    const ref = await r.start(start("k", null));
    r.died({ chatId: ref.chatId, sessionPath: ref.sessionFile, unit: "u", cause: "crashed", exit: 1, signal: null, logTail: [], at: "t" }, { since: 1 } as never);
    assert.equal(handles.length, 1);
    assert.deepEqual(r.list("sid"), []);
  });

  test("a run that settles with nobody watching opens the parent once", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { procs, handles } = fakeProcs();
    const opened: string[] = [];
    const r = reg(procs, { opened });
    await r.start(start("k", null));
    const h = handles[0]!;
    h.mirror = { ...h.mirror, worker: { proc: "p1", lastSettled: { key: "k:task#1", outcome: "success" } } };
    r.onState(h as unknown as RemoteChatHandle);
    t.mock.timers.tick(10_000);
    r.onState(h as unknown as RemoteChatHandle);
    t.mock.timers.tick(10_000);
    assert.deepEqual(opened, ["/p/parent.jsonl"]);
  });

  test("a run that settled with nobody watching just before its parent is archived never opens the parent (§app.chat-processes/workers)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const settle = (r: WorkerRegistry, h: FakeHandle, key: string) => {
      h.mirror = { ...h.mirror, worker: { proc: h.mirror.worker.proc, lastSettled: { key, outcome: "success" } } };
      r.onState(h as unknown as RemoteChatHandle);
    };
    const flush = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    // Archived as markArchived does it: the mark, then its workers stopped (stopAllOf).
    {
      const { procs, handles } = fakeProcs();
      const opened: string[] = [];
      let archived = false;
      const r = new WorkerRegistry(procs, { dir: () => join(dir, "workers"), autoResume: () => true, openParent: async (p) => void opened.push(p), archived: () => archived });
      await r.start(start("k", null));
      settle(r, handles[0]!, "k:task#1");
      t.mock.timers.tick(5_000);
      archived = true;
      await r.stopAllOf("sid", "its parent was archived");
      t.mock.timers.tick(300_000);
      await flush();
      assert.deepEqual(opened, [], "the pending report's open was cancelled");
      rmSync(join(dir, "workers"), { recursive: true, force: true });
    }
    // Only the mark (its workers not stopped yet when the timer fires): still never opened.
    {
      const { procs, handles } = fakeProcs();
      const opened: string[] = [];
      let archived = false;
      const r = new WorkerRegistry(procs, { dir: () => join(dir, "workers"), autoResume: () => true, openParent: async (p) => void opened.push(p), archived: () => archived });
      await r.start(start("k", null));
      settle(r, handles[0]!, "k:task#1");
      archived = true;
      t.mock.timers.tick(300_000);
      await flush();
      assert.deepEqual(opened, []);
      // A later settle of a worker whose parent is archived schedules nothing either.
      settle(r, handles[0]!, "k:task#2");
      t.mock.timers.tick(300_000);
      await flush();
      assert.deepEqual(opened, []);
      rmSync(join(dir, "workers"), { recursive: true, force: true });
    }
  });

  test("a parent that doesn't open for a settle is tried again; the report counts as taken only once it opened, across a restart too", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const settle = (r: WorkerRegistry, h: FakeHandle) => {
      h.mirror = { ...h.mirror, worker: { proc: h.mirror.worker.proc, lastSettled: { key: "k:task#1", outcome: "success" } } };
      r.onState(h as unknown as RemoteChatHandle);
    };
    const flush = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    // The first open fails, the retry opens it: one open that took, and no manual open.
    {
      const { procs, handles } = fakeProcs();
      const tries: string[] = [];
      let fail = 1;
      const r = new WorkerRegistry(procs, { dir: () => join(dir, "workers"), autoResume: () => true, openParent: async (p) => (tries.push(p), fail-- > 0 ? Promise.reject(new Error("folder gone")) : undefined) });
      await r.start(start("k", null));
      settle(r, handles[0]!);
      t.mock.timers.tick(10_000);
      await flush();
      assert.equal(tries.length, 1);
      t.mock.timers.tick(10_000);
      await flush();
      assert.equal(tries.length, 2, "tried again");
      t.mock.timers.tick(200_000);
      await flush();
      assert.equal(tries.length, 2, "once it opened, never again");
      rmSync(join(dir, "workers"), { recursive: true, force: true });
    }
    // The server stops after a failed open: the next one, taking the worker back, opens the parent.
    {
      const { procs, handles } = fakeProcs();
      const r = new WorkerRegistry(procs, { dir: () => join(dir, "workers"), autoResume: () => true, openParent: () => Promise.reject(new Error("folder gone")) });
      await r.start(start("k", null));
      settle(r, handles[0]!);
      t.mock.timers.tick(10_000);
      await flush();
      const opened: string[] = [];
      const next = reg(fakeProcs().procs, { opened });
      const h = handles[0]!;
      next.adopt(h as unknown as RemoteChatHandle);
      settle(next, h);
      t.mock.timers.tick(10_000);
      await flush();
      assert.deepEqual(opened, ["/p/parent.jsonl"], "not taken for seen by the failed open");
    }
  });

  test("a parent chat in a process of its own: ops answered on its link, watches fed there", async () => {
    const { procs } = fakeProcs();
    const r = reg(procs);
    const parent = linkOf(PARENT);
    r.serve(parent as unknown as RemoteChatHandle, { t: "wk", id: "k1", op: "start", args: start("pk", null) });
    await new Promise((res) => setTimeout(res, 20));
    const res = parent.sent[0] as { t: string; ok: boolean; result: { chatId: string } };
    assert.equal(res.t, "wk.result");
    assert.ok(res.ok);
    r.serve(parent as unknown as RemoteChatHandle, { t: "wk.watch", chatId: res.result.chatId, cursor: null });
    assert.equal((parent.sent[1] as { t: string; frame: { t: string } }).frame.t, "state");
    r.serve(parent as unknown as RemoteChatHandle, { t: "wk", id: "k2", op: "list", args: { parentSessionId: "other" } });
    await new Promise((res) => setTimeout(res, 5));
    assert.equal(((parent.sent[2] as { result: unknown[] }).result).length, 1);
  });

  test("records outlive the registry: a record with no process waits idle; an older server's server-stopped end replays as a died one", async () => {
    const { procs } = fakeProcs();
    const r = reg(procs);
    const ref = await r.start(start("k", null));
    const again = reg(procs);
    again.settleBoot();
    assert.equal(again.list("sid")[0]!.state, "idle");
    assert.equal(again.record(ref.chatId)!.key, "k");
    // A record an older server ended as "server-stopped" (it ran workers as its own children).
    const file = join(dir, "workers", `${ref.chatId}.json`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), placement: "child", state: "ended", ended: { cause: "server-stopped", at: "t" } }));
    const third = reg(procs);
    const got: WorkerFeedFrame[] = [];
    third.watch(ref.chatId, null, (f) => got.push(f));
    assert.deepEqual(got.find((f) => f.t === "ended"), { t: "ended", cause: "died", detail: "Sova's server stopped this worker with it" });
  });

  test("each crash-resume decision is logged: resumed, already a resume, the setting off, no run in flight", async () => {
    const logged: unknown[] = [];
    const { procs } = fakeProcs();
    const r = reg(procs, { logged });
    const ref = await r.start(start("k", null));
    const death: ChatDeath = { chatId: ref.chatId, sessionPath: ref.sessionFile, unit: "u", cause: "crashed", exit: 1, signal: null, logTail: [], at: "t1" };
    r.died(death, { since: 1 } as never);
    await new Promise((res) => setTimeout(res, 10));
    r.died({ ...death, at: "t2" }, { since: 2, auto: true } as never);
    const off = reg(procs, { logged, autoResume: false });
    const ref2 = await off.start(start("k2", null));
    off.died({ ...death, chatId: ref2.chatId }, { since: 1 } as never);
    const ref3 = await off.start(start("k3", null));
    off.died({ ...death, chatId: ref3.chatId }, null);
    const who = { path: ref.sessionFile, parent: "/p/parent.jsonl", workerId: "ag_01" };
    assert.deepEqual(logged, [
      { ...who, outcome: "resumed" },
      { ...who, outcome: "already a resume" },
      { ...who, path: ref2.sessionFile, outcome: "setting off" },
      { ...who, path: ref3.sessionFile, outcome: "no run in flight" },
    ]);
  });

  test("a task the worker does not accept fails the start and stops its chat (no worker left unowned)", async () => {
    const { procs, stopped } = fakeProcs({ failSend: "model refused" });
    const r = reg(procs);
    await assert.rejects(r.start(start()), /model refused/);
    assert.equal(stopped.length, 1);
    assert.deepEqual(r.list("sid"), []);
  });

  test("a settle a watcher was told of is not announced again by the next server", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { procs, handles } = fakeProcs();
    const opened: string[] = [];
    const r = reg(procs, { opened });
    const ref = await r.start(start("k", null));
    const off = r.watch(ref.chatId, null, () => {});
    const settled = { proc: "p1", lastSettled: { key: "k:task#1", entryId: "e9", outcome: "success" } };
    handles[0]!.mirror = { ...handles[0]!.mirror, worker: settled };
    r.onState(handles[0]! as unknown as RemoteChatHandle);
    off();
    assert.equal(r.record(ref.chatId)!.seenSettleKey, "k:task#1");
    const again = reg(procs, { opened });
    again.adopt({ ...handles[0]!, mirror: { ...handles[0]!.mirror } } as unknown as RemoteChatHandle);
    t.mock.timers.tick(10_000);
    assert.deepEqual(opened, []);
    // A later settle, unwatched, still opens the parent.
    const h = { ...handles[0]!, mirror: { ...handles[0]!.mirror, worker: { proc: "p1", lastSettled: { key: "k:task#2", outcome: "success" } } } };
    again.adopt(h as unknown as RemoteChatHandle);
    t.mock.timers.tick(10_000);
    assert.deepEqual(opened, ["/p/parent.jsonl"]);
  });

  test("a parent in this process reaches its own workers only", async () => {
    const { procs } = fakeProcs();
    const r = reg(procs);
    const ref = await r.bind(PARENT).start(start("k", null));
    const other = r.bind({ sessionId: "other", path: "/p/other.jsonl" });
    await assert.rejects(other.start(start("k2", null)), /its own parent session only/);
    // The path is the binding's, whatever the request spells.
    const spelled = await r.bind(PARENT).start({ ...start("k3", null), spec: { ...start().spec, parent: { sessionId: "sid", path: "/p/./parent.jsonl", workerId: "ag_02" } } });
    assert.equal(r.record(spelled.chatId)!.parent.path, "/p/parent.jsonl");
    await assert.rejects(other.start({ ...start("k", null), spec: { ...start().spec, parent: { sessionId: "other", path: "/p/other.jsonl", workerId: "ag_01" } } }), /No worker chat .* for this session/);
    await assert.rejects(other.send(ref.chatId, { text: "x", delivery: "prompt", key: "x" }), /No worker chat .* for this session/);
    await assert.rejects(other.abort(ref.chatId), /for this session/);
    await assert.rejects(other.stop(ref.chatId, "x"), /for this session/);
    assert.throws(() => other.watch(ref.chatId, null, () => {}), /for this session/);
    assert.deepEqual(await other.list(), []);
    assert.equal((await r.bind(PARENT).list()).length, 2);
  });

  test("a parent in a process of its own is the one its link names, never the frame", async () => {
    const { procs } = fakeProcs();
    const r = reg(procs);
    const ref = await r.start(start("k", null));
    const other = linkOf({ sessionId: "other", path: "/p/other.jsonl" });
    const serve = (f: Parameters<WorkerRegistry["serve"]>[1]) => r.serve(other as unknown as RemoteChatHandle, f);
    serve({ t: "wk", id: "a", op: "start", args: start("k9", null) });
    serve({ t: "wk", id: "b", op: "send", args: { chatId: ref.chatId, input: { text: "x", delivery: "prompt", key: "x" } } });
    serve({ t: "wk", id: "c", op: "abort", args: { chatId: ref.chatId } });
    serve({ t: "wk", id: "d", op: "stop", args: { chatId: ref.chatId, reason: "x" } });
    serve({ t: "wk", id: "e", op: "list", args: { parentSessionId: "sid" } });
    serve({ t: "wk.watch", chatId: ref.chatId, cursor: null });
    await new Promise((res) => setTimeout(res, 10));
    const byId = Object.fromEntries((other.sent as { t: string; id?: string }[]).filter((f) => f.t === "wk.result").map((f) => [f.id, f]));
    assert.match((byId.a as { error: { message: string } }).error.message, /its own parent session only/);
    for (const id of ["b", "c", "d"]) assert.match((byId[id] as { error: { message: string } }).error.message, /for this session/);
    assert.deepEqual((byId.e as { result: unknown }).result, []);
    const fed = (other.sent as { t: string; frame?: { t: string; detail?: string } }[]).find((f) => f.t === "wk.feed");
    assert.equal(fed?.frame?.t, "ended");
    assert.match(fed?.frame?.detail ?? "", /for this session/);
    assert.equal(r.list("sid")[0]!.state, "open");
  });

  test("a take-back starts its ring at the process's feed seq: an older cursor reads the frames sent while no server was linked", async () => {
    const asked: unknown[] = [];
    const missed = Array.from({ length: 10 }, (_, i) => ({ cursor: { proc: "p1", seq: 51 + i }, event: { type: "message_end", n: 51 + i } }));
    const { procs, handles } = fakeProcs({ feedSince: (args) => (asked.push(args), { frames: missed }) });
    const r = reg(procs);
    const ref = await r.start(start("k", null));
    // The next server takes the process back: its feed is at 60.
    const again = reg(procs);
    const h = { ...handles[0]!, mirror: { ...handles[0]!.mirror, worker: { proc: "p1", seq: 60, lastSettled: null } } };
    again.adopt(h as unknown as RemoteChatHandle);
    const got: WorkerFeedFrame[] = [];
    again.watch(ref.chatId, { proc: "p1", seq: 50 }, (f) => got.push(f));
    again.onFeed(h as unknown as RemoteChatHandle, { t: "feed", cursor: { proc: "p1", seq: 61 }, event: { type: "agent_settled" } } as never);
    await new Promise((res) => setTimeout(res, 10));
    assert.deepEqual(asked, [{ proc: "p1", seq: 50 }]);
    const seqs = got.filter((f) => f.t === "event").map((f) => (f as { cursor: { seq: number } }).cursor.seq);
    assert.deepEqual(seqs, [51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61], "the missed frames, in order, before the live one");
    assert.ok(!got.some((f) => f.t === "gap"));
  });

  test("frames a linked server missed (the same process, its seq ahead): watchers are told of a gap", async () => {
    const { procs, handles } = fakeProcs();
    const r = reg(procs);
    const ref = await r.start(start("k", null));
    const h = handles[0]!;
    h.mirror = { ...h.mirror, worker: { proc: h.mirror.worker.proc, seq: 0, lastSettled: null } };
    r.onState(h as unknown as RemoteChatHandle);
    const got: WorkerFeedFrame[] = [];
    r.watch(ref.chatId, null, (f) => got.push(f));
    h.mirror = { ...h.mirror, worker: { ...h.mirror.worker, seq: 7 } };
    r.onState(h as unknown as RemoteChatHandle);
    assert.ok(got.some((f) => f.t === "gap"));
  });

  test("the death text keeps the last 20 lines, at most 2 KB", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const text = deathText({ exit: 3, signal: null, logTail: lines });
    assert.match(text, /^This worker's process stopped unexpectedly \(exit 3\)\nLast output: line 10\n/);
    assert.ok(text.endsWith("line 29"));
    assert.equal(deathText({ exit: null, signal: null, logTail: [] }), "This worker's process stopped unexpectedly (it stopped answering)");
  });
});
