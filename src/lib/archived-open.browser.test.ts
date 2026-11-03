// Run: pnpm test -- src/lib/archived-open.browser.test.ts (Solid's reactive build, a stand-in WebSocket).
// An archived chat opens on its file's rows and starts nothing (§chat.transcript/instant-open, "An
// archived chat"): the view composes its socket and wait as ChatView does, and no trigger (the open
// itself, a reload, its tab coming to the front, another tab's open, a send) makes a socket until it
// is unarchived; then the first send connects, once.
import assert from "node:assert/strict";
import { test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const g = globalThis as Record<string, unknown>;
const made: string[] = [];
class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(url: string) {
    made.push(url);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
}
g.WebSocket = FakeSocket;

const solid = await import("solid-js");
const { createReconnectingSocket } = await import("./socket");
const { FILE_READ_WAIT_MS, mayWake, waitAtOpen, waitOnWake, WAIT_START } = await import("./chat-wait");

/** A chat view's open, as ChatView makes it: the file read, then the socket, which an archived view closes at once. */
function openView(archived: () => boolean, fileRead: Promise<void> | undefined) {
  return solid.createRoot((dispose) => {
    const [wait, setWait] = solid.createSignal(WAIT_START);
    const atOpen = archived();
    const socket = createReconnectingSocket("ws://h/ws/chat?path=a", { onMessage() {}, after: atOpen ? (fileRead ?? Promise.resolve()) : fileRead, afterMs: FILE_READ_WAIT_MS });
    if (atOpen) {
      setWait(waitAtOpen(true));
      socket.close();
    }
    const wake = () => {
      if (!mayWake(wait(), archived())) return false;
      setWait(waitOnWake(wait()));
      socket.retry();
      return true;
    };
    return { socket, wait, wake, dispose };
  });
}

test("an archived chat's view makes no socket at open, with rows kept in the tab (no file read) or read from the file", async () => {
  for (const fileRead of [undefined, Promise.resolve()]) {
    made.length = 0;
    const v = openView(() => true, fileRead);
    await new Promise((r) => setTimeout(r, FILE_READ_WAIT_MS + 50));
    assert.equal(made.length, 0, "no /ws/chat upgrade at all");
    assert.equal(v.wait().asleep, true, "asleep: no Connecting note, no Not connected");
    assert.equal(v.socket.status(), "closed");
    v.dispose();
  }
});

test("nothing wakes an archived chat (its tab to the front, another tab's open, a send); after Unarchive the first send connects once", async () => {
  made.length = 0;
  const [archived, setArchived] = solid.createSignal(true);
  const v = openView(archived, Promise.resolve());
  await new Promise((r) => setTimeout(r, 10));
  // Front, held elsewhere, a send: each calls wake.
  for (let i = 0; i < 3; i++) assert.equal(v.wake(), false);
  assert.equal(made.length, 0);
  setArchived(false);
  assert.equal(v.wake(), true, "unarchived: a send wakes it");
  assert.equal(made.length, 1);
  assert.equal(v.wake(), false, "waking already: no second connect");
  assert.equal(made.length, 1);
  v.dispose();
});

test("an ordinary chat still connects at open", async () => {
  made.length = 0;
  const v = openView(() => false, Promise.resolve());
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(made.length, 1);
  v.dispose();
});
