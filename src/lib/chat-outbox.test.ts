// Run: pnpm test -- src/lib/chat-outbox.test.ts. A message sent while its chat starts is the
// server's to deliver (§chat.transcript/send-while-starting): the browser's side, with a fake
// socket and storage (no connection is made).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { courier, deliverStranded, keepParcel, Outbox, PARCEL_TTL_MS, registerPutBack, sendsOf, sendsOnTheWay, takeBackHere, takeParcels, type ParcelStore } from "./chat-outbox";

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
    deliverStranded(deps, store, now);
    assert.deepEqual(back, [{ path: "/s/old.jsonl", texts: ["old one"] }]);
    assert.equal(sockets.length, 1);
    assert.match(sockets[0]!.url, /fresh/);
    sockets[0]!.open();
    assert.deepEqual(sockets[0]!.sent, [prompt("f1", "fresh one")]);
    assert.deepEqual(takeParcels(store), [], "nothing kept twice");
  });
});
