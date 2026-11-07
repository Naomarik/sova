// Run: pnpm test -- src/lib/first-connect-send.browser.test.ts (Solid's reactive build, a stand-in WebSocket).
// A send made before a chat view's first connection is ready (a new session's Enter at once,
// §chat.transcript/send-while-starting): the view composes its socket, wait, outbox and unanswered
// sends as ChatView does, and the send is held, written in order as the connection opens (before
// the chat's hello), and never dropped: a connection that never opens, or a chat that fails to
// start, hands its text back.
import assert from "node:assert/strict";
import { test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const g = globalThis as Record<string, unknown>;
class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static made: FakeSocket[] = [];
  static waiting: ((s: FakeSocket) => void)[] = [];
  readyState = 0;
  written: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.made.push(this);
    for (const w of FakeSocket.waiting.splice(0)) w(this);
  }
  /** The next socket made, or the newest when one is already there and unopened. */
  static next(): Promise<FakeSocket> {
    const last = FakeSocket.made.at(-1);
    if (last && last.readyState === 0) return Promise.resolve(last);
    return new Promise((r) => FakeSocket.waiting.push(r));
  }
  send(data: string) {
    if (this.readyState !== 1) throw new Error("not open");
    this.written.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  say(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}
g.WebSocket = FakeSocket;

const solid = await import("solid-js");
const { createReconnectingSocket } = await import("./socket");
const { Outbox } = await import("./chat-outbox");
const { UnackedSends } = await import("./unacked-sends");
const { composerWait, errorHandsBack, holdsSends, waitAtOpen, waitOnHello, waitOnOpen, waitOnStatus, waitReason } = await import("./chat-wait");

let seq = 0;
/** A chat view's first connect, as ChatView composes it: what Enter does, and what comes back. */
function openView() {
  return solid.createRoot((dispose) => {
    const [wait, setWait] = solid.createSignal(waitAtOpen(false));
    const outbox = new Outbox(`/s/first-${++seq}.jsonl`, null);
    const unacked = new UnackedSends();
    const handedBack = new Set<string>();
    const back: string[] = [];
    const handBack = (texts: { text: string }[]) => back.push(...texts.map((t) => t.text));
    let everOpened = false;
    const socket = createReconnectingSocket<Record<string, unknown>>("ws://h/ws/chat?path=a", {
      onOpen() {
        everOpened = true;
        setWait(waitOnOpen(solid.untrack(wait)));
        const conn = solid.untrack(wait).conn;
        for (const frame of outbox.take()) {
          if (!socket.send(frame)) break;
          unacked.sent(String(frame.clientId), String(frame.text), conn);
        }
      },
      onMessage(msg) {
        if (msg.type === "hello") setWait(waitOnHello(solid.untrack(wait)));
        if (msg.type === "send_ack") unacked.settled(String(msg.clientId));
        if (msg.type === "queue_removed") {
          const u = unacked.take(String(msg.itemId), handedBack);
          if (u) handBack([u]);
        }
        if (msg.type === "queue_remove_refused" && msg.reason === "consumed") socket.send({ type: "abort" });
        if (msg.type === "error") {
          const failed = errorHandsBack(solid.untrack(wait));
          if (failed !== null) handBack(unacked.takeFrom(failed, handedBack));
        }
      },
    });
    solid.createEffect(
      solid.on(
        socket.status,
        (status) => {
          const { next, handBack: conn } = waitOnStatus(solid.untrack(wait), status, everOpened);
          if (conn !== null) handBack(unacked.takeFrom(conn, handedBack));
          setWait(next);
          if (status === "failed" || status === "closed") handBack(outbox.take().map((f) => ({ text: String(f.text) })));
        },
        { defer: true },
      ),
    );
    /** Enter: false when the composer would refuse it (the old gate). */
    const enter = (text: string, clientId: string): boolean => {
      if (composerWait(wait(), waitReason(socket.status(), wait()))) return false;
      const frame = { type: "steer", text, clientId };
      if (holdsSends(solid.untrack(wait), outbox.size)) outbox.push(frame);
      else {
        if (!socket.send(frame)) return false;
        unacked.sent(clientId, text, solid.untrack(wait).conn);
      }
      return true;
    };
    /** Stop: before the open, the outbox's texts come back; after it, before the hello, this
        connection's sends are taken back by client id; else an abort. */
    const stop = () => {
      if (outbox.size) return handBack(outbox.take().map((f) => ({ text: String(f.text) })));
      const w = solid.untrack(wait);
      const carried = w.open && !w.ready ? [...unacked.of(w.conn).keys()] : [];
      if (!carried.length) return void socket.send({ type: "abort" });
      for (const id of carried) socket.send({ type: "queue_remove", id: `queue_remove-${id}`, itemId: id });
    };
    const note = () => waitReason(socket.status(), wait());
    return { enter, stop, note, wait, outbox, back, dispose };
  });
}

test("Enter before the first connection opens is held, not dropped; it goes in order as the connection opens, before the chat's hello", async () => {
  const pending = FakeSocket.next();
  const v = openView();
  const ws = await pending;
  assert.equal(v.enter("first", "c1"), true, "Send works while connecting");
  assert.equal(v.enter("second", "c2"), true);
  assert.equal(v.outbox.size, 2);
  assert.equal(v.note()?.text, "Connecting to chat…", "the note still floats");
  assert.equal(ws.written.length, 0, "nothing on a socket still connecting");
  ws.open();
  assert.deepEqual(
    ws.written.map((f) => f.clientId),
    ["c1", "c2"],
    "written in order on open",
  );
  assert.equal(v.outbox.size, 0);
  assert.equal(v.enter("third", "c3"), true, "after open, before hello: straight on the socket");
  assert.deepEqual(
    ws.written.map((f) => f.clientId),
    ["c1", "c2", "c3"],
  );
  ws.say({ type: "hello" });
  assert.equal(v.note(), null);
  for (const id of ["c1", "c2", "c3"]) ws.say({ type: "send_ack", clientId: id });
  assert.deepEqual(v.back, [], "nothing handed back");
  v.dispose();
});

test("a first connection that never opens hands the held text back to the composer", async () => {
  const pending = FakeSocket.next();
  const v = openView();
  const ws = await pending;
  assert.equal(v.enter("hello there", "c1"), true);
  ws.drop(4422); // a permanent close: the socket stays down
  assert.deepEqual(v.back, ["hello there"]);
  assert.equal(v.outbox.size, 0);
  v.dispose();
});

test("a chat that fails to start after the connection opened (its error before the hello) hands what it carried back, once", async () => {
  const pending = FakeSocket.next();
  const v = openView();
  const ws = await pending;
  v.enter("hello there", "c1");
  ws.open();
  assert.equal(ws.written.length, 1);
  ws.say({ type: "error", code: "internal", message: "boom" });
  assert.deepEqual(v.back, ["hello there"]);
  ws.drop(4500); // the server closes it; the drop hands nothing back again
  assert.deepEqual(v.back, ["hello there"]);
  v.dispose();
});

test("a reconnect after the first hello keeps today's gate: Enter is refused until the reconnect's hello", async () => {
  const pending = FakeSocket.next();
  const v = openView();
  const ws = await pending;
  ws.open();
  ws.say({ type: "hello" });
  ws.drop(1006);
  assert.equal(v.enter("while reconnecting", "c9"), false, "the reconnect's gate");
  assert.equal(v.outbox.size, 0);
  v.dispose();
});

test("Stop after the connection opened, before the chat's hello: the send is taken back by its id, its text returns, nothing is aborted", async () => {
  const pending = FakeSocket.next();
  const v = openView();
  const ws = await pending;
  v.enter("take me back", "c1");
  ws.open();
  v.stop();
  assert.deepEqual(ws.written.at(-1), { type: "queue_remove", id: "queue_remove-c1", itemId: "c1" });
  assert.deepEqual(v.back, [], "not before the server says it took it back");
  ws.say({ type: "queue_removed", id: "queue_remove-c1", itemId: "c1", text: "take me back" });
  assert.deepEqual(v.back, ["take me back"]);
  ws.say({ type: "hello" });
  assert.equal(
    ws.written.some((f) => f.type === "abort"),
    false,
  );
  v.dispose();
});

test("Stop after open, before hello, when the chat already took the send: the turn is stopped, the text stays sent", async () => {
  const pending = FakeSocket.next();
  const v = openView();
  const ws = await pending;
  v.enter("too late", "c1");
  ws.open();
  v.stop();
  ws.say({ type: "queue_remove_refused", id: "queue_remove-c1", itemId: "c1", reason: "consumed", message: "Already sent." });
  assert.deepEqual(ws.written.at(-1), { type: "abort" });
  assert.deepEqual(v.back, []);
  v.dispose();
});

test("Stop before the connection opens: what the outbox kept comes back and never goes", async () => {
  const pending = FakeSocket.next();
  const v = openView();
  const ws = await pending;
  v.enter("not yet", "c1");
  v.stop();
  assert.deepEqual(v.back, ["not yet"]);
  ws.open();
  assert.equal(ws.written.length, 0);
  v.dispose();
});
