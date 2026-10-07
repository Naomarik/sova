// Run: pnpm test -- server/mesh/lan-reverse.test.ts
// The reverse channel's pieces that need no socket (§mesh.lan/reverse-channel): an h2 session pair
// over two in-process streams. Over a real pinned TLS pair: lan-reverse.integration.test.ts.
import assert from "node:assert/strict";
import { once } from "node:events";
import http2 from "node:http2";
import { Duplex } from "node:stream";
import { test } from "node:test";
import { serveReverse, streamDuplex } from "./lan-reverse";

/** Two streams wired to each other: what one writes, the other reads. */
function duplexPair(): [Duplex, Duplex] {
  const ends: Duplex[] = [];
  const end = (i: number) =>
    new Duplex({
      read() {},
      write(c, _e, cb) {
        ends[1 - i]!.push(c);
        cb();
      },
      final(cb) {
        ends[1 - i]!.push(null);
        cb();
      },
    });
  ends.push(end(0), end(1));
  return [ends[0]!, ends[1]!];
}

test("streamDuplex carries no address", async () => {
  const [mac, relay] = duplexPair();
  const server = serveReverse(mac, (d) => d.end("HTTP/1.1 204 No Content\r\n\r\n"));
  const client = http2.connect("http://lan-peer", { createConnection: () => relay as never });
  client.on("error", () => {});
  const s = client.request({ ":method": "CONNECT", ":authority": "lan-peer" });
  s.on("error", () => {});
  await once(s, "response");
  const d = streamDuplex(s) as Duplex & { remoteAddress?: string };
  assert.equal(d.remoteAddress, undefined);
  d.destroy();
  client.destroy();
  server.close();
});
