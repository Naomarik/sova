import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { EventEmitter } from "node:events";
import { createWorkerSession } from "../harness/pi/worker-session";
import { chatBun } from "./bun";
import { type FeedFrame, WorkerFeed } from "./worker-feed";
import { LinkWorkerHost } from "./worker-port";
import { NOT_RUN_NO_SERVER } from "../../shared/chat-runtime-wire";
import type { Link } from "./link";

/** A harness session that emits pi events as HarnessEvents (frame() is their wire-1 frame). */
function fakeSession() {
  const fns = new Set<(e: unknown) => void>();
  return {
    subscribe(fn: (e: unknown) => void) {
      fns.add(fn);
      return () => void fns.delete(fn);
    },
    persistedId: (h: unknown) => ((h as { id?: string } | undefined)?.id ?? null),
    emit(event: Record<string, unknown>) {
      const e = { type: "other", frame: () => ({ type: "event", event: { ...event } }), ...(event.type === "message_end" || event.type === "message_start" ? { handle: event.message } : {}) };
      for (const fn of fns) fn(e);
    },
  };
}

/** The chat's send keys as the feed reads them (server/send-keys.ts): `label` a message, `done` a key. */
function fakeKeys() {
  const of = new WeakMap<object, string>();
  const fns = new Set<(key: string) => void>();
  return {
    keyOf: (h: unknown) => (h && typeof h === "object" ? of.get(h) : undefined),
    onDone: (fn: (key: string) => void) => (fns.add(fn), () => void fns.delete(fn)),
    label: (m: object, key: string) => void of.set(m, key),
    done: (key: string) => {
      for (const fn of fns) fn(key);
    },
  };
}

describe("WorkerFeed", () => {
  test("feeds the fold's event types, never message_update; a message_end is tagged with its entry", async () => {
    const out: FeedFrame[] = [];
    const feed = new WorkerFeed((f) => out.push(f), { proc: "P" });
    const s = fakeSession();
    feed.attach(s as never);
    s.emit({ type: "agent_start" });
    s.emit({ type: "message_update" });
    s.emit({ type: "message_end", message: { role: "assistant", id: "e7", stopReason: "stop" } });
    s.emit({ type: "agent_end" });
    await Promise.resolve();
    assert.deepEqual(out.map((f) => (f.event as { type: string }).type), ["agent_start", "message_end", "agent_end"]);
    assert.equal((out[1]!.event as { entryId?: string }).entryId, "e7");
    assert.deepEqual(out.map((f) => f.cursor.seq), [1, 2, 3]);
  });

  test("a settle is told under the key of the send that started its run, with its outcome", async () => {
    const feed = new WorkerFeed(() => {}, { proc: "P" });
    const s = fakeSession();
    feed.attach(s as never);
    feed.noteSend("k:task");
    s.emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "boom" } });
    s.emit({ type: "agent_settled" });
    await Promise.resolve();
    assert.deepEqual(feed.settled, { key: "k:task#1", outcome: "error", error: "boom" });
  });

  test("a settle names its run's final assistant entry, after that entry's id is read; its frame carries the key", async () => {
    const out: FeedFrame[] = [];
    const feed = new WorkerFeed((f) => out.push(f), { proc: "P" });
    const s = fakeSession();
    feed.attach(s as never);
    feed.noteSend("k:task");
    s.emit({ type: "message_end", message: { role: "assistant", id: "e1", stopReason: "toolUse" } });
    s.emit({ type: "message_end", message: { role: "assistant", id: "e2", stopReason: "stop" } });
    s.emit({ type: "agent_settled" });
    assert.equal(feed.settled, null);
    await Promise.resolve();
    assert.deepEqual(feed.settled, { key: "k:task#1", entryId: "e2", outcome: "success" });
    assert.deepEqual(out.map((f) => (f.event as { type: string }).type), ["message_end", "message_end", "agent_settled"]);
    assert.equal((out[2]!.event as { settleKey?: string }).settleKey, "k:task#1");
    assert.equal((out[2]!.event as { settleEntryId?: string }).settleEntryId, "e2");
  });

  test("a user message names the key of the send it came from (on its start and its end); others none", async () => {
    const out: FeedFrame[] = [];
    const feed = new WorkerFeed((f) => out.push(f), { proc: "P" });
    const s = fakeSession();
    const keys = fakeKeys();
    feed.attach(s as never, keys);
    const mine = { role: "user", content: "do it" };
    const twin = { role: "user", content: "do it" };
    keys.label(mine, "w:s1");
    s.emit({ type: "agent_start" });
    for (const message of [mine, twin]) for (const type of ["message_start", "message_end"]) s.emit({ type, message });
    await Promise.resolve();
    const keyed = out.map((f) => (f.event as { type: string; sendKey?: string }).sendKey ?? null);
    assert.deepEqual(keyed, [null, "w:s1", "w:s1", null, null], "by identity: the twin with the same text names none");
    // Read again after a dropped link (`since`), the frames still name it.
    const again = feed.since("P", 0) as { frames: FeedFrame[] };
    assert.deepEqual(again.frames.map((f) => (f.event as { sendKey?: string }).sendKey ?? null), keyed);
  });

  test("a keyed send that never ran is told: at once when no run is going, else just before the run's settle", async () => {
    const out: FeedFrame[] = [];
    const feed = new WorkerFeed((f) => out.push(f), { proc: "P" });
    const s = fakeSession();
    const keys = fakeKeys();
    feed.attach(s as never, keys);
    const types = () => out.map((f) => { const e = f.event as { type: string; sendKey?: string }; return e.sendKey && e.type === "send_dropped" ? `dropped ${e.sendKey}` : e.type; });
    keys.done("idle-1"); // a turn that failed before it began
    await Promise.resolve();
    assert.deepEqual(types(), ["dropped idle-1"]);
    out.length = 0;
    const ran = { role: "user", content: "ran" };
    keys.label(ran, "ran-1");
    s.emit({ type: "agent_start" });
    s.emit({ type: "message_start", message: ran });
    keys.done("ran-1"); // its turn's end: it ran, so nothing to tell
    keys.done("stop-1"); // Stop drained it while the run went on
    const late = { role: "user", content: "late" };
    keys.label(late, "late-1");
    keys.done("late-1"); // given up on, then the loop delivered it after all
    s.emit({ type: "message_start", message: late });
    s.emit({ type: "message_end", message: { role: "assistant", stopReason: "aborted" } });
    s.emit({ type: "agent_settled" });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(types(), ["agent_start", "message_start", "message_start", "message_end", "dropped stop-1", "agent_settled"]);
    keys.done("ran-1"); // a late repeat for a key that ran
    await Promise.resolve();
    assert.equal(out.length, 6);
  });

  test("since: the frames after a seq of this process; another process or one out of the ring is a gap", () => {
    const feed = new WorkerFeed(() => {}, { proc: "P", max: 3 });
    const s = fakeSession();
    feed.attach(s as never);
    for (let i = 0; i < 5; i++) s.emit({ type: "turn_start" });
    assert.deepEqual("frames" in feed.since("P", 3) ? (feed.since("P", 3) as { frames: FeedFrame[] }).frames.map((f) => f.cursor.seq) : null, [4, 5]);
    assert.deepEqual(feed.since("P", 0), { gap: true });
    assert.deepEqual(feed.since("Q", 4), { gap: true });
    assert.deepEqual(feed.since("P", 5), { frames: [] });
  });
});

/** A link stand-in: frames sent are recorded, frames received are emitted to listeners. */
function fakeLink(proto = 3) {
  const bus = new EventEmitter();
  const sent: { t: string; [k: string]: unknown }[] = [];
  const link = {
    isOpen: true,
    compatible: true,
    peerProto: proto,
    send: (f: { t: string }) => (sent.push(f as never), true),
    on: (t: string, fn: (f: unknown) => void) => (bus.on(t, fn), () => void bus.off(t, fn)),
  };
  return { link: link as unknown as Link, sent, recv: (f: { t: string }) => bus.emit(f.t, f), raw: link };
}

describe("LinkWorkerHost", () => {
  test("an op goes out as `wk` and resolves on its result; a watch is fed and asked again from its cursor at the next control", async () => {
    const host = new LinkWorkerHost(() => 60_000);
    const a = fakeLink();
    host.linked(a.link);
    const h = host.bind({ sessionId: "sid", path: "/p" });
    const p = h.list();
    const op = a.sent[0]!;
    assert.equal(op.t, "wk");
    assert.deepEqual(op.args, { parentSessionId: "sid" });
    a.recv({ t: "wk.result", id: op.id, ok: true, result: [] } as never);
    assert.deepEqual(await p, []);
    const seen: string[] = [];
    h.watch("w1", null, (f) => seen.push(f.t));
    a.recv({ t: "wk.feed", chatId: "w1", frame: { t: "event", cursor: { proc: "P", seq: 4 }, event: {} } } as never);
    assert.deepEqual(seen, ["event"]);
    // A new server: the watch from its last cursor, and an op it never answered, again.
    const pending = h.send("w1", { text: "x", delivery: "steer", key: "s" });
    host.unlinked();
    const b = fakeLink();
    host.linked(b.link);
    assert.deepEqual(b.sent.map((f) => f.t).sort(), ["wk", "wk.watch"]);
    assert.deepEqual(b.sent.find((f) => f.t === "wk.watch")!.cursor, { proc: "P", seq: 4 });
    const again = b.sent.find((f) => f.t === "wk")!;
    b.recv({ t: "wk.result", id: again.id, ok: true, result: { queued: true } } as never);
    assert.deepEqual(await pending, { queued: true });
  });

  test("with no server for the wait, an op fails as not run", async () => {
    const host = new LinkWorkerHost(() => 20);
    await assert.rejects(host.bind({ sessionId: "s", path: "/p" }).abort("w"), new RegExp(NOT_RUN_NO_SERVER.slice(0, 20)));
  });

  test("a proto-2 server gets no worker frames", () => {
    const host = new LinkWorkerHost(() => 20);
    const a = fakeLink(2);
    host.linked(a.link);
    void host.bind({ sessionId: "s", path: "/p" }).list().catch(() => {});
    assert.deepEqual(a.sent, []);
  });
});

describe("worker sessions and Bun", () => {
  test("a new worker session's file exists with its header before the chat opens it; a seed writes its messages", () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-session-"));
    try {
      const a = createWorkerSession({ new: { dir: join(dir, "a") } }, dir);
      const head = JSON.parse(readFileSync(a.path, "utf8").split("\n")[0]!);
      assert.equal(head.type, "session");
      assert.equal(head.id, a.sessionId);
      const b = createWorkerSession({ seed: { dir: join(dir, "b"), messages: [{ role: "user", content: [{ type: "text", text: "q" }], timestamp: 1 }] } }, dir);
      assert.match(readFileSync(b.path, "utf8"), /"text":"q"/);
      const c = createWorkerSession({ fork: { from: b.path, dir: join(dir, "c") } }, dir);
      assert.notEqual(c.sessionId, b.sessionId);
      assert.match(readFileSync(c.path, "utf8"), /"text":"q"/);
      assert.equal(createWorkerSession({ resume: { file: c.path } }, dir).sessionId, c.sessionId);
      // A parent mid-append (its last line partial) is forked from a copy: its own file is never written.
      const before = `${readFileSync(b.path, "utf8")}{"type":"message","id":"half`;
      writeFileSync(b.path, before);
      const d = createWorkerSession({ fork: { from: b.path, dir: join(dir, "d") } }, dir);
      assert.equal(readFileSync(b.path, "utf8"), before);
      assert.match(readFileSync(d.path, "utf8"), /"text":"q"/);
      assert.doesNotMatch(readFileSync(d.path, "utf8"), /"id":"half/);
      assert.deepEqual(readdirSync(join(dir, "d")).filter((n) => n.startsWith(".fork-source")), [], "the copy is gone");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Bun: the server's own runtime, else none, whatever Bun the machine has", () => {
    const dir = mkdtempSync(join(tmpdir(), "bun-"));
    const env = { SOVA_BUN: process.env.SOVA_BUN, PATH: process.env.PATH };
    try {
      assert.equal(chatBun({ ...process.versions, bun: "1.3" }, "/x/bun"), "/x/bun");
      const exe = join(dir, "bun");
      writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });
      process.env.SOVA_BUN = exe;
      process.env.PATH = dir;
      assert.equal(chatBun({ ...process.versions, bun: undefined } as NodeJS.ProcessVersions, "/x/node"), null, "a server on Node never looks for one");
    } finally {
      process.env.SOVA_BUN = env.SOVA_BUN;
      if (env.SOVA_BUN === undefined) delete process.env.SOVA_BUN;
      process.env.PATH = env.PATH;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
