// Run: pnpm test -- src/lib/socket.browser.test.ts (Solid's reactive build, a stand-in WebSocket).
// A chat socket's first connect can wait for the file's rows (§chat.transcript/instant-open), and
// every connect reads its URL again, so it names the rows the view holds by then.
import assert from "node:assert/strict";
import { test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const g = globalThis as Record<string, unknown>;
const made: { url: string; sock: FakeSocket }[] = [];
class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(url: string) {
    made.push({ url, sock: this });
  }
  send() {}
  close() {
    this.readyState = 3;
  }
}
g.WebSocket = FakeSocket;

const solid = await import("solid-js");
const { createReconnectingSocket } = await import("./socket");

test("after: no socket until the promise settles, status connecting meanwhile; then one connect", async () => {
  made.length = 0;
  let release!: () => void;
  const after = new Promise<void>((r) => (release = r));
  const { status, dispose } = solid.createRoot((dispose) => ({ status: createReconnectingSocket("ws://h/a", { onMessage() {}, after }).status, dispose }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(made.length, 0);
  assert.equal(status(), "connecting");
  release();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(made.length, 1);
  dispose();
});

test("after: a failed read connects too; a view closed meanwhile never connects", async () => {
  made.length = 0;
  const failed = solid.createRoot((dispose) => {
    createReconnectingSocket("ws://h/b", { onMessage() {}, after: Promise.reject(new Error("no file")) });
    return dispose;
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(made.length, 1);
  failed();
  made.length = 0;
  let release!: () => void;
  const closed = solid.createRoot((dispose) => {
    createReconnectingSocket("ws://h/c", { onMessage() {}, after: new Promise<void>((r) => (release = r)) });
    return dispose;
  });
  closed();
  release();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(made.length, 0);
});

test("a URL function is read at every connect", async () => {
  made.length = 0;
  let last = "r1";
  const s = solid.createRoot((dispose) => ({ socket: createReconnectingSocket(() => `ws://h/d?have=${last}`, { onMessage() {} }), dispose }));
  assert.equal(made[0]!.url, "ws://h/d?have=r1");
  last = "r2";
  s.socket.reconnect();
  assert.equal(made.at(-1)!.url, "ws://h/d?have=r2");
  s.dispose();
});

test("afterMs: a first-connect wait that never settles connects once the time is up, once", async () => {
  made.length = 0;
  let last: string | undefined;
  const s = solid.createRoot((dispose) => ({
    socket: createReconnectingSocket(() => `ws://h/e${last ? `?have=${last}` : ""}`, { onMessage() {}, after: new Promise<void>(() => {}), afterMs: 20 }),
    dispose,
  }));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(made.length, 0, "not before the time is up");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(made.length, 1);
  assert.equal(made[0]!.url, "ws://h/e", "nothing painted: no row named");
  s.dispose();
});

test("afterMs: a read that lands first connects at once, and the timer adds no second socket", async () => {
  made.length = 0;
  let release!: () => void;
  const s = solid.createRoot((dispose) => {
    createReconnectingSocket("ws://h/f", { onMessage() {}, after: new Promise<void>((r) => (release = r)), afterMs: 30 });
    return dispose;
  });
  release();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(made.length, 1);
  s();
});

// A chat closed while quiet (§chat.transcript/instant-open, §app.chat-processes/idle-stop).

test("an older bundle, which doesn't know `closed`: the chat's quiet close comes with a code its socket never retries", async () => {
  const { CHAT_CLOSED_CLOSE_CODE } = await import("../../shared/protocol");
  made.length = 0;
  const seen: unknown[] = [];
  // As an old ChatView: every message ignored but the ones it knows; reconnects are the socket's.
  const s = solid.createRoot((dispose) => ({ socket: createReconnectingSocket("ws://h/i", { onMessage: (m) => void seen.push(m) }), dispose }));
  const sock = made[0]!.sock;
  sock.readyState = 1;
  sock.onopen?.();
  sock.onmessage?.({ data: JSON.stringify({ type: "closed", reason: "idle" }) });
  sock.onclose?.({ code: CHAT_CLOSED_CLOSE_CODE });
  await new Promise((r) => setTimeout(r, 1_200)); // past the first retry's 1 s
  assert.equal(made.length, 1, "never reconnected, so the chat is never reopened");
  assert.equal(s.socket.status(), "closed");
  s.dispose();
});
