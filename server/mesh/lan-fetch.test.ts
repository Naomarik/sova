import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net, { type AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import tls, { type TLSSocket } from "node:tls";
import { mintLanIdentity } from "./lan-cert";
import { agentFetch, LAN_HOST } from "./lan-fetch";
import { connectReverse, serveReverse } from "./lan-reverse";
import { connectPinned, relayServerOptions } from "./lan-tls";

let server: http.Server;
let agent: http.Agent;
let seen: { host?: string; method?: string; len?: number } = {};

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

test("GET with a query; the Host is fixed, never this machine's", async () => {
  const res = await agentFetch(agent, "/json?q=a%20b");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.deepEqual(await res.json(), { q: "a b" });
  assert.equal(seen.host, LAN_HOST);
});

test("a POST body streams in whole, from a string or a Request", async () => {
  const body = crypto.randomBytes(3 * 1024 * 1024);
  const r1 = await (await agentFetch(agent, "/echo", { method: "POST", body })).json();
  assert.equal(r1.n, body.length);
  assert.equal(r1.h, crypto.createHash("sha256").update(body).digest("hex"));
  const r2 = await (await agentFetch(agent, new Request("http://anything/echo", { method: "PUT", body: "hello" }))).json();
  assert.equal(r2.n, 5);
  assert.equal(seen.method, "PUT");
});

test("204 and HEAD have no body; a big body arrives whole; repeated headers stay apart", async () => {
  assert.equal((await agentFetch(agent, "/none")).body, null);
  assert.equal((await agentFetch(agent, "/json", { method: "HEAD" })).body, null);
  assert.equal((await (await agentFetch(agent, "/big")).arrayBuffer()).byteLength, 4 * 1024 * 1024);
  const c = await agentFetch(agent, "/cookies");
  assert.deepEqual(c.headers.getSetCookie(), ["a=1", "b=2"]);
});

test("aborts reject as fetch does: before the answer, and in the middle of a body", async () => {
  await assert.rejects(agentFetch(agent, "/hang", { signal: AbortSignal.timeout(150) }), (e: Error) => e.name === "TimeoutError");
  const ac = new AbortController();
  const res = await agentFetch(agent, "/slow", { signal: ac.signal });
  const reader = res.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
  ac.abort();
  await assert.rejects(reader.read(), (e: Error) => e.name === "AbortError");
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(agentFetch(agent, "/json", { signal: pre.signal }), (e: Error) => e.name === "AbortError");
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
