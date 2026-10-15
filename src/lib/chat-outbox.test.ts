// Run: pnpm test -- src/lib/chat-outbox.test.ts. A message sent while its chat starts is the
// server's to deliver (§chat.transcript/send-while-starting): the browser's side, with a fake
// socket and storage (no connection is made).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { courier, deliverStranded, keepParcel, Outbox, PARCEL_TTL_MS, registerPutBack, sendsOf, sendsOnTheWay, takeBackHere, takeStranded, handOverOnUnload, LEASE_MS, HAND_OVER_MAX_BYTES, type ParcelStore } from "./chat-outbox";

function memoryStore(): ParcelStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

/** A WebSocket stand-in: records what is sent; the test opens it, answers and closes it. */
class FakeSocket {
  readyState: number = WebSocket.CONNECTING;
  sent: unknown[] = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url = "") {}
  send(data: string) {
    if (this.readyState !== WebSocket.OPEN) throw new Error("send while not open");
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.closedWith = code;
    this.readyState = WebSocket.CLOSED;
    this.onclose?.();
  }
  open() {
    this.readyState = WebSocket.OPEN;
    this.onopen?.();
  }
  answer(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop() {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.();
  }
}

const P = "/s/a.jsonl";
const prompt = (clientId: string, text: string) => ({ type: "prompt", text, clientId });

/** A courier on a fake socket; what it put back, by chat. */
function harness() {
  const sockets: FakeSocket[] = [];
  const back: { path: string; texts: string[] }[] = [];
  registerPutBack((path, texts) => void back.push({ path, texts }));
  const deps = {
    url: (path: string) => `ws://x/ws/chat?path=${path}`,
    open: (url: string) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s as unknown as WebSocket;
    },
    listenMs: 60_000,
    store: null as ParcelStore | null,
  };
  return { sockets, back, deps };
}

describe("Outbox", () => {
  test("keeps frames in order, in storage too, until taken", () => {
    const store = memoryStore();
    const box = new Outbox(P, store, () => 1000);
    box.push({ type: "set_model", ref: "a/b" });
    box.push(prompt("c1", "hi"));
    assert.equal(box.size, 2);
    const kept = JSON.parse(store.data.get("sova:chat-outbox")!);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].path, P);
    assert.deepEqual(kept[0].frames.map((f: { type: string }) => f.type), ["set_model", "prompt"]);
    assert.deepEqual(box.take().map((f) => f.type), ["set_model", "prompt"]);
    assert.equal(box.size, 0);
    assert.deepEqual(JSON.parse(store.data.get("sova:chat-outbox")!), [], "gone from storage once taken");
  });

  test("sendsOf: prompt and steer texts by client id", () => {
    assert.deepEqual([...sendsOf([{ type: "set_model" }, prompt("a", "x"), { type: "steer", text: "y", clientId: "b" }, { type: "prompt", text: "no id" }])], [
      ["a", "x"],
      ["b", "y"],
    ]);
  });
});

describe("courier", () => {
  test("never sends while connecting; on open, every frame in order; leaves once the send is acknowledged", () => {
    const { sockets, back, deps } = harness();
    courier(P, [{ type: "set_model", ref: "a/b" }, prompt("c1", "hello")], new Map(), deps);
    const s = sockets[0]!;
    assert.deepEqual(s.sent, [], "nothing on a connecting socket");
    assert.deepEqual([...sendsOnTheWay(P)], [["c1", "hello"]], "shown as on its way meanwhile");
    s.open();
    assert.deepEqual(s.sent.map((f) => (f as { type: string }).type), ["set_model", "prompt"]);
    s.answer({ type: "hello", items: [] });
    assert.equal(s.closedWith, null, "stays for the answer");
    s.answer({ type: "send_ack", clientId: "c1", queued: false });
    assert.equal(s.closedWith, 1000);
    assert.equal(sendsOnTheWay(P).size, 0);
    assert.deepEqual(back, []);
  });

  test("a refusal goes back to the chat's draft, quietly; to its open view when there is one", () => {
    const { sockets, back, deps } = harness();
    courier(P, [prompt("c1", "first")], new Map(), deps);
    sockets[0]!.open();
    sockets[0]!.answer({ type: "error", code: "internal", message: "model off", clientId: "c1" });
    assert.deepEqual(back, [{ path: P, texts: ["first"] }]);
    const seen: string[][] = [];
    const stop = takeBackHere(P, (texts) => void seen.push(texts));
    courier(P, [prompt("c2", "second")], new Map(), deps);
    sockets[1]!.open();
    sockets[1]!.answer({ type: "error", code: "config", message: "folder gone" });
    stop();
    assert.deepEqual(seen, [["second"]]);
    assert.equal(back.length, 1, "not also to the draft");
  });

  test("a connection that never opens puts the messages back at once", () => {
    const { sockets, back, deps } = harness();
    courier(P, [prompt("c1", "lost?")], new Map(), deps);
    sockets[0]!.drop();
    assert.deepEqual(back, [{ path: P, texts: ["lost?"] }]);
  });

  test("an open connection handed over: nothing re-sent, it listens for the sends it carried", () => {
    const { back, deps } = harness();
    const s = new FakeSocket();
    s.readyState = WebSocket.OPEN;
    courier(P, [], new Map([["c9", "on the way"]]), deps, s as unknown as WebSocket);
    assert.deepEqual(s.sent, []);
    s.answer({ type: "error", code: "refused", message: "no", clientId: "c9" });
    assert.deepEqual(back, [{ path: P, texts: ["on the way"] }]);
    assert.equal(s.closedWith, 1000);
  });
});

describe("deliverStranded", () => {
  test("a page load sends what an earlier page kept; kept over a day, back to the draft", () => {
    const { sockets, back, deps } = harness();
    const store = memoryStore();
    const now = 10 * PARCEL_TTL_MS;
    keepParcel({ id: "fresh", path: "/s/fresh.jsonl", frames: [prompt("f1", "fresh one")], at: now - 1000 }, store);
    keepParcel({ id: "old", path: "/s/old.jsonl", frames: [prompt("o1", "old one")], at: now - PARCEL_TTL_MS - 1 }, store);
    deliverStranded({ ...deps, page: "this-page" }, store, now, false);
    assert.deepEqual(back, [{ path: "/s/old.jsonl", texts: ["old one"] }]);
    assert.equal(sockets.length, 1);
    assert.match(sockets[0]!.url, /fresh/);
    sockets[0]!.open();
    assert.deepEqual(sockets[0]!.sent, [prompt("f1", "fresh one")]);
    assert.deepEqual(takeStranded(store, now, "another").taken, [], "nothing kept twice");
  });
});

describe("leases: a parcel a live page holds is never taken by another (B2)", () => {
  /** Every frame a fake socket of the harness sent, plus what the Outbox itself takes, by type. */
  const kinds = (frames: unknown[]) => frames.map((f) => (f as { type: string }).type);
  const asked = [{ type: "set_model", ref: "a/b" }, { type: "set_thinking", level: "high" }, { type: "rewind", id: "rewind-1", entryId: "e1" }, prompt("c1", "hi")];

  test("a live Outbox's parcel stays put while its lease runs; its own socket sends each frame once", () => {
    const { sockets, deps } = harness();
    const store = memoryStore();
    let now = 1_000_000;
    const box = new Outbox(P, store, () => now, "live-page");
    for (const f of asked) box.push(f);
    // Another page loads Sova on the same storage while this one waits for its socket.
    deliverStranded({ ...deps, store, page: "other-page" }, store, now + 1000, false);
    assert.equal(sockets.length, 0, "no courier took the live page's parcel");
    // Its socket opens: the view sends what the Outbox holds.
    const sent = box.take();
    assert.deepEqual(kinds(sent), ["set_model", "set_thinking", "rewind", "prompt"]);
    assert.deepEqual(takeStranded(store, now + 10 * LEASE_MS, "x").taken, [], "nothing left behind");
  });

  test("this page never takes its own parcel at load, whatever its lease", () => {
    const { sockets, deps } = harness();
    const store = memoryStore();
    const box = new Outbox(P, store, () => 0, "me");
    box.push(asked[0]!);
    deliverStranded({ ...deps, store, page: "me" }, store, 10 * LEASE_MS, false);
    assert.equal(sockets.length, 0);
    assert.equal(box.take().length, 1);
  });

  test("a lease that ran out (the page froze or went): the other page delivers it, and the Outbox then sends nothing", () => {
    const { sockets, deps } = harness();
    const store = memoryStore();
    const box = new Outbox(P, store, () => 0, "frozen-page");
    for (const f of asked) box.push(f);
    deliverStranded({ ...deps, store, page: "other-page" }, store, LEASE_MS + 1, false);
    assert.equal(sockets.length, 1);
    sockets[0]!.open();
    const fromCourier = sockets[0]!.sent;
    const fromBox = box.take();
    assert.deepEqual(fromBox, [], "taken elsewhere: the live view sends none of it");
    const all = kinds([...fromCourier, ...fromBox]);
    for (const k of ["set_model", "set_thinking", "rewind"]) assert.equal(all.filter((x) => x === k).length, 1, `${k} once`);
  });
});

describe("handOverOnUnload: a going page hands its frames to the server (B1)", () => {
  test("frames not on an open socket are posted in order, and nothing stays to be replayed", () => {
    const store = memoryStore();
    const posts: { path: string; body: string }[] = [];
    const box = new Outbox(P, store, () => 5, "going");
    box.push({ type: "set_model", ref: "a/b" });
    box.push(prompt("c1", "hi"));
    handOverOnUnload({ url: () => "", post: (path, body) => (posts.push({ path, body }), true), store });
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.path, P);
    assert.deepEqual(JSON.parse(posts[0]!.body).frames.map((f: { type: string }) => f.type), ["set_model", "prompt"]);
    assert.equal(box.size, 0);
    assert.deepEqual(takeStranded(store, 10 * LEASE_MS, "next").taken, [], "no parcel left for a next load");
  });

  test("over the keepalive budget, a peer's chat, or no request: the parcel stays, free for the next load at once", () => {
    for (const variant of ["big", "peer", "no-post"] as const) {
      const store = memoryStore();
      const box = new Outbox(P, store, () => 5, "going");
      box.push(variant === "big" ? prompt("c1", "x".repeat(HAND_OVER_MAX_BYTES)) : prompt("c1", "hi"));
      const posts: string[] = [];
      handOverOnUnload({
        url: () => "",
        ...(variant === "no-post" ? {} : { post: (_p: string, b: string) => (posts.push(b), true) }),
        ...(variant === "peer" ? { local: () => false } : {}),
        store,
      });
      assert.deepEqual(posts, [], variant);
      const left = takeStranded(store, 6, "next-load").taken;
      assert.equal(left.length, 1, `${variant}: kept, and free at once`);
      assert.equal(left[0]!.frames.length, 1);
    }
  });

  test("a courier still connecting when the page goes hands its frames over; its socket then sends nothing and puts nothing back", () => {
    const { sockets, back, deps } = harness();
    const store = memoryStore();
    const posts: string[] = [];
    courier(P, [prompt("c7", "while leaving")], new Map(), { ...deps, store, page: "going" });
    handOverOnUnload({ url: () => "", post: (_p, b) => (posts.push(b), true), store });
    assert.equal(posts.length, 1);
    sockets[0]!.open();
    assert.deepEqual(sockets[0]!.sent, []);
    sockets[0]!.drop();
    assert.deepEqual(back, []);
  });
});
