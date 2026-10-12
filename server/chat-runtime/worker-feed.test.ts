import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { EventEmitter } from "node:events";
import { createWorkerSession } from "../harness/pi/worker-session";
import { resolveBun } from "./bun";
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
      const e = { type: "other", frame: () => ({ type: "event", event }), ...(event.type === "message_end" ? { handle: event.message } : {}) };
      for (const fn of fns) fn(e);
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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Bun: the server's own runtime, else SOVA_BUN, else bun on PATH, else none", () => {
    const dir = mkdtempSync(join(tmpdir(), "bun-"));
    try {
      assert.equal(resolveBun({ env: {}, execPath: "/x/bun", bunVersion: "1.3", cwd: dir }), "/x/bun");
      assert.equal(resolveBun({ env: { PATH: dir }, execPath: "/x/node", bunVersion: undefined, cwd: dir }), null);
      mkdirSync(join(dir, "bin"));
      const exe = join(dir, "bin", "bun");
      writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });
      assert.equal(resolveBun({ env: { PATH: join(dir, "bin") }, execPath: "/x/node", bunVersion: undefined, cwd: dir }), exe);
      assert.equal(resolveBun({ env: { SOVA_BUN: exe, PATH: "" }, execPath: "/x/node", bunVersion: undefined, cwd: dir }), exe);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
