// Run: pnpm test -- server/mesh/lan-fetch.test.ts
// agentFetch, fetch over an http.Agent (§mesh.lan/as-a-peer), against an in-process HTTP server that
// never listens: each connection is an in-process stream pair, as the reverse channel's streams are
// plain Duplexes in production. Plus which paths the L5 response cap covers. The cap cutting an
// endless body (it needs a socket's bounded buffers), a connection nobody answers and a real pinned
// channel's agent: lan-fetch.integration.test.ts.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, test } from "node:test";
import { LIST_MAX_BYTES, PROBE_MAX_BYTES, responseCap } from "./dial";
import { duplexPair } from "./duplex-pair-test-fixtures";
import { agentFetch, LAN_HOST } from "./lan-fetch";

let server: http.Server;
let agent: http.Agent;
let seen: { host?: string; method?: string; len?: number } = {};

before(() => {
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
  // Every connection the agent makes is one end of a pair; the server gets the other, never listening.
  class InProcess extends http.Agent {
    override createConnection() {
      const [client, served] = duplexPair();
      Object.assign(served, { remoteAddress: undefined, setTimeout: () => served, setNoDelay: () => served, setKeepAlive: () => served, ref: () => served, unref: () => served });
      Object.assign(client, { setTimeout: () => client, setNoDelay: () => client, setKeepAlive: () => client, ref: () => client, unref: () => client });
      server.emit("connection", served);
      return client as never;
    }
  }
  agent = new InProcess();
});

after(() => {
  agent.destroy();
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

test("L5: a pairing's probes and session lists are capped; other paths aren't", () => {
  assert.equal(responseCap("/api/peer/hello"), PROBE_MAX_BYTES);
  assert.equal(responseCap("/api/peer/details?x=1"), PROBE_MAX_BYTES);
  assert.equal(responseCap("/api/sessions"), LIST_MAX_BYTES);
  assert.equal(responseCap("/api/sessions", { SOVA_MESH_LIST_MAX_BYTES: "1000" }), 1000);
  assert.equal(responseCap("/api/peer/sync/doc"), undefined);
});
