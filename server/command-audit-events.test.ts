// Run: pnpm test -- server/command-audit-events.test.ts
// The record's rows on Sova's event stream (§app.command-audit/record): only a socket that asked
// (`?with=command.ran`) hears them, live only. A socket that didn't ask gets byte for byte what it
// gets with no record at all; the ring, the seqs and a resume are the same with thousands of command
// frames as with none; and a slow socket that asked drops command frames before any event.
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMAND_RAN, type CommandFrame, type EventsServerFrame } from "../shared/events";
import { EventHub, type EventSources } from "./events";
import { serveEvents, type EventsSocket } from "./events-ws";

function sources() {
  const chat = new Set<(e: { chatId: string; type: string }) => void>();
  const s: EventSources = {
    onChatEvent: (fn) => (chat.add(fn), () => chat.delete(fn)),
    onAttention: () => () => {},
    holdFeed: () => null,
    isHosted: () => true,
    idOf: (p) => p.replace(/^.*\/|\.jsonl$/g, ""),
  };
  return { s, chat: (chatId: string, type: string) => chat.forEach((fn) => fn({ chatId, type })) };
}

/** A socket whose sends finish at once (`auto`) or only when the test says. */
function fakeSocket(auto = true) {
  const sent: string[] = [];
  const pending: (() => void)[] = [];
  const handlers: Record<string, (() => void)[]> = {};
  const ws = {
    readyState: 1,
    OPEN: 1,
    closed: null as null | { code?: number },
    send(data: string, cb: () => void) {
      sent.push(data);
      if (auto) queueMicrotask(cb);
      else pending.push(cb);
    },
    close(code?: number) {
      this.closed = { code };
      this.readyState = 3;
      for (const fn of handlers.close ?? []) fn();
    },
    on(event: string, fn: () => void) {
      (handlers[event] ??= []).push(fn);
    },
  };
  return { ws: ws as typeof ws & EventsSocket, sent, frames: () => sent.map((x) => JSON.parse(x) as EventsServerFrame), drain: () => pending.splice(0).forEach((cb) => cb()), unfinished: () => pending.length };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const cmd = (i: number): CommandFrame => ({ type: "command", name: COMMAND_RAN, at: new Date(i).toISOString(), caller: "no-key", method: "GET", route: `/api/r${i}`, status: 200 });
const noTimers = { setTimeout: () => ({}), clearTimeout: () => {} };

test("a socket that didn't ask gets exactly the frames it gets with no record; one that asked hears each row", async () => {
  const a = sources();
  const b = sources();
  const plainHub = new EventHub(a.s, { lingerMs: 10 });
  const auditedHub = new EventHub(b.s, { lingerMs: 10 });
  // The same stream id, so the two can be compared byte for byte.
  Object.defineProperty(auditedHub, "stream", { value: plainHub.stream });
  const plain = fakeSocket();
  const without = fakeSocket();
  const asked = fakeSocket();
  const bogus = fakeSocket();
  serveEvents(plain.ws, new URLSearchParams(), plainHub, noTimers);
  serveEvents(without.ws, new URLSearchParams(), auditedHub, noTimers);
  serveEvents(asked.ws, new URLSearchParams("with=command.ran"), auditedHub, noTimers);
  serveEvents(bogus.ws, new URLSearchParams("with=everything"), auditedHub, noTimers);
  for (let i = 0; i < 5; i++) {
    a.chat(`/s/c${i}.jsonl`, "started");
    b.chat(`/s/c${i}.jsonl`, "started");
    auditedHub.announce(cmd(i));
  }
  await tick();
  const at = (f: string) => f.replace(/"at":\d+/, '"at":0');
  assert.deepEqual(without.sent.map(at), plain.sent.map(at), "byte for byte, apart from the clock");
  assert.equal(bogus.ws.closed, null, "an unknown `with` is ignored: it connects as today");
  assert.deepEqual(bogus.sent.map(at), plain.sent.map(at));
  const heard = asked.frames().filter((f) => f.type === "command") as CommandFrame[];
  assert.deepEqual(heard.map((f) => f.route), ["/api/r0", "/api/r1", "/api/r2", "/api/r3", "/api/r4"]);
  assert.ok(heard.every((f) => !("seq" in f)), "a command frame takes no seq");
  assert.deepEqual(asked.frames().filter((f) => f.type !== "command").map((f) => JSON.stringify(f)).map(at), plain.sent.map(at));
  plainHub.close();
  auditedHub.close();
});

test("2,000 command frames between a turn.ended and a resume: the resume returns the turn.ended, no gap, the same seqs", async () => {
  const src = sources();
  const hub = new EventHub(src.s, { lingerMs: 10 });
  const first = fakeSocket();
  serveEvents(first.ws, new URLSearchParams("with=command.ran"), hub, noTimers);
  src.chat("/s/x.jsonl", "settled");
  const ended = first.frames().find((f) => f.type === "event" && f.name === "turn.ended") as { seq: number } | undefined;
  assert.ok(ended);
  for (let i = 0; i < 2000; i++) hub.announce(cmd(i));
  const seqBefore = hub.hello().seq;
  const back = fakeSocket();
  serveEvents(back.ws, new URLSearchParams(`stream=${hub.stream}&since=${ended.seq - 1}&with=command.ran`), hub, noTimers);
  await tick();
  const frames = back.frames();
  assert.equal(frames[0]!.type, "hello");
  assert.equal(hub.hello().seq, seqBefore, "announcing took no seq");
  assert.deepEqual(frames.slice(1).map((f) => (f.type === "event" ? `${f.name}:${f.seq}` : f.type)), [`turn.ended:${ended.seq}`], "no gap and no command frame replayed");
  hub.close();
});

test("asleep, nothing is announced; a socket that asked and stalls drops command frames before any event, with no gap and no close", async () => {
  const src = sources();
  const hub = new EventHub(src.s, { lingerMs: 10 });
  hub.announce(cmd(0)); // asleep: no one to hear it, nothing kept
  assert.equal(hub.hello().seq, 0);
  const slow = fakeSocket(false);
  const timers = { armed: 0, setTimeout: () => ((timers.armed++), {}), clearTimeout: () => {} };
  serveEvents(slow.ws, new URLSearchParams("with=command.ran"), hub, timers);
  src.chat("/s/y.jsonl", "started");
  for (let i = 0; i < 2000; i++) hub.announce({ ...cmd(i), route: `/api/${"p".repeat(400)}` });
  src.chat("/s/y.jsonl", "settled");
  assert.equal(timers.armed, 0, "dropping command frames never arms the too-slow close");
  for (let r = 0; r < 500 && slow.unfinished(); r++) {
    slow.drain();
    await tick();
  }
  const events = slow.frames().filter((f) => f.type === "event" || f.type === "gap");
  assert.deepEqual(events.map((f) => (f.type === "event" ? f.name : `gap:${(f as { reason: string }).reason}`)), ["turn.started", "turn.ended"]);
  assert.equal(slow.ws.closed, null);
  hub.close();
});
