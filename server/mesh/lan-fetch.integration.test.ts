// Run: node scripts/run-tests.mjs server/mesh/lan-fetch.integration.test.ts
// agentFetch over real sockets (§mesh.lan/as-a-peer): the L5 cap cutting an endless body (the kernel's
// buffers bound what arrives before the cut; in-process nothing does), nobody there, and a real pinned
// channel's agent. Requests, bodies and aborts over in-process streams: lan-fetch.test.ts.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net, { type AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import tls, { type TLSSocket } from "node:tls";
import { mintLanIdentity } from "./lan-cert";
import { agentFetch } from "./lan-fetch";
import { connectReverse, serveReverse } from "./lan-reverse";
import { connectPinned, relayServerOptions } from "./lan-tls";

let server: http.Server;
let agent: http.Agent;
let seen: { host?: string; method?: string; len?: number } = {};
let endlessSent = 0;

before(async () => {
  server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    seen = { host: req.headers.host, method: req.method };
    if (url.pathname === "/json") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ q: url.searchParams.get("q") }));
    if (url.pathname === "/echo") {
      const h = crypto.createHash("sha256");
      let n = 0;
      req.on("data", (d: Buffer) => { n += d.length; h.update(d); });
      req.on("end", () => res.end(JSON.stringify({ n, h: h.digest("hex") })));
      return;
    }
    if (url.pathname === "/none") return void res.writeHead(204).end();
    if (url.pathname === "/cookies") {
      res.setHeader("set-cookie", ["a=1", "b=2"]);
      return void res.end("ok");
    }
    if (url.pathname === "/big") return void res.end(Buffer.alloc(4 * 1024 * 1024, 7));
    if (url.pathname === "/slow") {
      res.writeHead(200);
      res.write("first");
      return; // never ends
    }
    if (url.pathname === "/hang") return;
    if (url.pathname === "/endless") {
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(64 * 1024, 32);
      const pump = () => {
        while (!res.destroyed && endlessSent < 64 * 1024 * 1024) {
          endlessSent += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      res.on("close", () => {});
      return pump();
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  class To extends http.Agent {
    override createConnection() {
      return net.connect(port, "127.0.0.1");
    }
  }
  agent = new To();
});

after(() => {
  server.close();
  server.closeAllConnections();
});

test("L5: a capped body: a declared length past the cap rejects, an endless one is cut at the cap", async () => {
  // /big declares 4 MiB.
  await assert.rejects(agentFetch(agent, "/big", undefined, { maxBytes: 1024 * 1024 }), (e: TypeError & { cause?: { code?: string } }) => e instanceof TypeError && e.cause?.code === "too large");
  // /endless streams chunked with no length, without end.
  const res = await agentFetch(agent, "/endless", undefined, { maxBytes: 256 * 1024 });
  assert.equal(res.status, 200);
  await assert.rejects(res.arrayBuffer(), (e: TypeError & { cause?: { code?: string } }) => e.cause?.code === "too large");
  assert.ok(endlessSent < 64 * 1024 * 1024, "the stream was cut, not read to the end");
  // Under the cap, whole.
  assert.equal((await (await agentFetch(agent, "/big", undefined, { maxBytes: 4 * 1024 * 1024 })).arrayBuffer()).byteLength, 4 * 1024 * 1024);
});

test("nobody there: a TypeError, as fetch's", async () => {
  class Dead extends http.Agent {
    override createConnection() {
      return net.connect(1, "127.0.0.1");
    }
  }
  await assert.rejects(agentFetch(new Dead(), "/json"), TypeError);
});

test("over a real pinned channel's agent", async () => {
  const relayId = mintLanIdentity();
  const host = mintLanIdentity();
  const srv = tls.createServer(relayServerOptions(relayId));
  const client = new Promise<Awaited<ReturnType<typeof connectReverse>>>((resolve) => srv.once("secureConnection", (s: TLSSocket) => void connectReverse(s).then(resolve)));
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const sock = await connectPinned(host, relayId.pin, "127.0.0.1", (srv.address() as AddressInfo).port, "answer");
  const side = serveReverse(sock, (d) => server.emit("connection", d));
  const c = await client;
  assert.deepEqual(await (await agentFetch(c.agent, "/json?q=via")).json(), { q: "via" });
  c.close();
  await side.closed;
  srv.close();
});
