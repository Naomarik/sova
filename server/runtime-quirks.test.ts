import { strict as assert } from "node:assert";
import type { AddressInfo } from "node:net";
import { after, describe, test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { cappedWebSocket, cappedWebSocketServer, enforceMaxPayload, loopDelaySampler, MESSAGE_TOO_BIG, messageBytes, slicingFetch } from "./runtime-quirks";

// The cap is ours, not ws's: each server here is built WITHOUT maxPayload, so on Node too it is
// enforceMaxPayload, never ws, that closes (the same position Bun's shim puts every socket in).
const servers: WebSocketServer[] = [];
after(() => {
  for (const s of servers) s.close();
});
function serve(onConnection: (ws: WebSocket) => void): Promise<string> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  servers.push(wss);
  wss.on("connection", onConnection);
  return new Promise((resolve) => wss.on("listening", () => resolve(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`)));
}
const opened = (ws: WebSocket) => new Promise<void>((resolve, reject) => ws.once("open", () => resolve()).once("error", reject));
const closed = (ws: WebSocket) => new Promise<number>((resolve) => ws.once("close", (code: number) => resolve(code)));

describe("messageBytes", () => {
  test("counts every form a runtime hands a message over in", () => {
    assert.equal(messageBytes(Buffer.alloc(5)), 5);
    assert.equal(messageBytes(new ArrayBuffer(6)), 6);
    assert.equal(messageBytes(new Uint8Array(7)), 7);
    assert.equal(messageBytes([Buffer.alloc(2), Buffer.alloc(3)]), 5);
    assert.equal(messageBytes("é"), 2);
  });
});

describe("enforceMaxPayload", () => {
  test("a server socket closes with 1009 at the first message over the cap, and no listener sees it or anything after", async () => {
    const seen: number[] = [];
    const url = await serve((ws) => {
      ws.on("message", (m: Buffer) => seen.push(messageBytes(m))); // added BEFORE the cap
      enforceMaxPayload(ws, 1024);
      ws.on("error", () => {});
    });
    const c = new WebSocket(url);
    c.on("error", () => {});
    await opened(c);
    const code = closed(c);
    c.send(Buffer.alloc(1024));
    c.send(Buffer.alloc(1025));
    c.send("after");
    assert.equal(await code, MESSAGE_TOO_BIG);
    assert.deepEqual(seen, [1024]);
  });

  test("a client socket calls onOversize instead, once", async () => {
    const url = await serve((ws) => {
      ws.send(Buffer.alloc(10));
      ws.send(Buffer.alloc(2048));
      ws.send(Buffer.alloc(4096));
    });
    const c = new WebSocket(url);
    const seen: number[] = [];
    let over = 0;
    enforceMaxPayload(c, 1024, (ws) => {
      over++;
      ws.terminate();
    });
    c.on("message", (m: Buffer) => seen.push(messageBytes(m)));
    c.on("error", () => {});
    await closed(c);
    assert.equal(over, 1);
    assert.deepEqual(seen, [10]);
  });
});

describe("cappedWebSocketServer / cappedWebSocket", () => {
  test("a noServer server's handleUpgrade hands over sockets that close with 1009 over maxPayload", async () => {
    const wss = cappedWebSocketServer({ noServer: true, maxPayload: 1024 });
    const seen: number[] = [];
    const http = createServer();
    http.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("error", () => {});
      ws.on("message", (m: Buffer) => seen.push(m.length));
    }));
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    after(() => http.close());
    const c = new WebSocket(`ws://127.0.0.1:${(http.address() as AddressInfo).port}`);
    c.on("error", () => {});
    await opened(c);
    const code = closed(c);
    c.send(Buffer.alloc(1000));
    c.send(Buffer.alloc(4096));
    assert.equal(await code, MESSAGE_TOO_BIG);
    assert.deepEqual(seen, [1000]);
  });

  test("a client never sees a message over maxPayload; the socket ends (onOversize where ws doesn't cap it first)", async () => {
    const url = await serve((ws) => ws.send(Buffer.alloc(64 * 1024)));
    let over = false;
    const c = cappedWebSocket(url, undefined, { maxPayload: 16 * 1024, onOversize: (ws) => { over = true; ws.terminate(); } });
    let got = 0;
    c.on("message", () => got++);
    c.on("error", () => {});
    await closed(c);
    // Ended either way: Node's ws rejects the frame itself (an error, then the close), elsewhere
    // onOversize ends it. Which one ran is the runtime's business; no message got through.
    assert.equal(got, 0);
    void over;
  });
});

describe("loopDelaySampler", () => {
  test("a stall shows in max, in Node's form (resolution included), on any runtime", async () => {
    const s = loopDelaySampler(20);
    await new Promise((r) => setTimeout(r, 120)); // the probe answers meanwhile
    s.reset();
    await new Promise<void>((r) => setTimeout(() => {
      const t = Date.now();
      while (Date.now() - t < 150);
      r();
    }, 30));
    await new Promise((r) => setTimeout(r, 60));
    const maxMs = s.max / 1e6;
    s.disable();
    assert.ok(maxMs - 20 >= 100, `max ${maxMs} ms (with the 20 ms resolution) shows the 150 ms stall`);
    assert.ok(s.percentile(50) / 1e6 >= 10, "a sample spans the interval, as Node's do");
  });
});

describe("cappedWebSocket handshakeTimeout", () => {
  test("a peer that never answers the upgrade: one error, one close, on any runtime", async () => {
    const wedged = createNetServer(() => {});
    await new Promise<void>((r) => wedged.listen(0, "127.0.0.1", () => r()));
    after(() => wedged.close());
    const c = cappedWebSocket(`ws://127.0.0.1:${(wedged.address() as AddressInfo).port}/`, undefined, { handshakeTimeout: 200 });
    const errors: string[] = [];
    let closes = 0;
    c.on("error", (e: Error) => errors.push(e.message));
    c.on("close", () => closes++);
    await new Promise((r) => setTimeout(r, 900));
    assert.deepEqual(errors, ["Opening handshake has timed out"]);
    assert.equal(closes, 1);
  });
});

describe("slicingFetch", () => {
  /** An HTTP server that writes `parts` one per tick, then (unless `hold`) ends. */
  async function sse(parts: Buffer[], hold = false): Promise<string> {
    const http = createServer(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const p of parts) {
        res.write(p);
        await new Promise((r) => setTimeout(r, 5));
      }
      if (!hold) res.end();
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    after(() => http.closeAllConnections?.());
    after(() => http.close());
    return `http://127.0.0.1:${(http.address() as AddressInfo).port}/`;
  }
  const text = Array.from({ length: 200 }, (_, i) => `data: {"i":${i},"s":"é€😀 \\t "}\n\n`).join("");
  const bytes = Buffer.from(text, "utf8");

  test("passes every byte through, in reads of at most `max`, across UTF-8 sequences split at slice edges", async () => {
    // Chunks cut at odd offsets so multi-byte characters straddle both the writes and the slices.
    const parts: Buffer[] = [];
    for (let at = 0; at < bytes.length; at += 997) parts.push(bytes.subarray(at, at + 997));
    const url = await sse(parts);
    const res = await slicingFetch(undefined, 7)(url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body!.getReader();
    const got: Uint8Array[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      assert.ok(value.length <= 7, `a read of ${value.length} bytes`);
      got.push(value);
    }
    assert.ok(Buffer.concat(got).equals(bytes), "byte for byte");
    assert.equal(new TextDecoder().decode(Buffer.concat(got)), text);
  });

  test("an abort mid-stream stops the next read", async () => {
    const url = await sse([bytes.subarray(0, 4000), bytes.subarray(4000)], true);
    const ac = new AbortController();
    const res = await slicingFetch(undefined, 100)(url, { signal: ac.signal });
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.equal(first.value!.length, 100);
    ac.abort();
    await assert.rejects(reader.read(), (e: Error) => e.name === "AbortError");
  });
});
