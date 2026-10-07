// Run: pnpm test -- server/mesh/lan-reverse.test.ts
// The reverse channel's pieces that need no socket (§mesh.lan/reverse-channel): an h2 session pair
// over two in-process streams. Over a real pinned TLS pair: lan-reverse.integration.test.ts.
import assert from "node:assert/strict";
import { once } from "node:events";
import http2 from "node:http2";
import type { Duplex } from "node:stream";
import { test } from "node:test";
import { duplexPair } from "./duplex-pair-test-fixtures";
import { serveReverse, streamDuplex } from "./lan-reverse";

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
