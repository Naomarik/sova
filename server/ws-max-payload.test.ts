import { strict as assert } from "node:assert";
import type { AddressInfo } from "node:net";
import { after, describe, test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { enforceMaxPayload, MESSAGE_TOO_BIG, messageBytes } from "./ws-max-payload";

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
