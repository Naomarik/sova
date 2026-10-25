import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createHttp, request } from "node:http";
import { connect, createServer as createTcp } from "node:net";
import { test } from "node:test";
import { startRunnerProxy } from "./runner-proxy";

/** Admits exactly one origin among a connection's candidates. */
const only = (origin: string, delayMs = 0) => async (candidates: string[]) => { if (delayMs) await new Promise(ok => setTimeout(ok, delayMs)); if (!candidates.includes(origin)) throw new Error("not approved"); return origin; };

// A sandbox-off recording attempt's own proxy (§app.tours/sites): it admits an origin only when the
// attempt's live check passes for it, decides before any lookup or dial, refuses a named host that
// resolves anywhere but a public address, and dials exactly the address it checked.

async function listener() {
  let connections = 0;
  const server = createHttp((_req, res) => { res.end("approved page"); });
  server.on("connection", () => { connections++; });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return { origin: `http://127.0.0.1:${port}`, port, connections: () => connections, close: async () => { server.closeAllConnections(); await new Promise<void>(d => server.close(() => d())); } };
}
/** One request through the proxy as Chromium sends it: an absolute URL for http. */
function viaProxy(proxyUrl: string, target: string): Promise<{ status: number; body: string }> {
  const proxy = new URL(proxyUrl);
  return new Promise((done, fail) => {
    const req = request({ host: proxy.hostname, port: Number(proxy.port), path: target, method: "GET", headers: { host: new URL(target).host }, agent: false }, res => {
      let body = ""; res.on("data", c => { body += c; }); res.on("end", () => done({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", fail); req.end();
  });
}
/** A CONNECT through the proxy; its status line. */
function connectVia(proxyUrl: string, authority: string): Promise<string> {
  const proxy = new URL(proxyUrl);
  return new Promise((done, fail) => {
    const s = connect(Number(proxy.port), proxy.hostname, () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    let text = "";
    s.on("data", b => { text += b.toString("latin1"); if (text.includes("\r\n")) { done(text.split("\r\n")[0]!); s.destroy(); } });
    s.on("error", fail); s.on("close", () => done(text.split("\r\n")[0] ?? ""));
  });
}

test("the attempt proxy reaches an admitted origin and refuses another loopback port before dialling it", async () => {
  const approved = await listener(), other = await listener();
  const decisions: string[] = [];
  const proxy = await startRunnerProxy({
    admit: only(approved.origin),
    onDecision: d => decisions.push(`${d.method} ${d.origin} ${d.allowed}`),
  });
  try {
    // Positive control: the approved origin answers through the proxy.
    assert.deepEqual(await viaProxy(proxy.url, `${approved.origin}/drafts`), { status: 200, body: "approved page" });
    // Another loopback port: refused, asked, never dialled (plain request and CONNECT alike).
    assert.equal((await viaProxy(proxy.url, `${other.origin}/next`)).status, 403);
    assert.match(await connectVia(proxy.url, `127.0.0.1:${other.port}`), /^HTTP\/1\.1 403/);
    assert.equal(other.connections(), 0, "the refused port was never dialled");
    assert.ok(decisions.includes(`GET ${other.origin} false`) && decisions.includes(`CONNECT https://127.0.0.1:${other.port} false`), decisions.join("; "));
    // A CONNECT for an approved plain-http origin (a WebSocket) is admitted.
    assert.match(await connectVia(proxy.url, `127.0.0.1:${approved.port}`), /^HTTP\/1\.1 200/);
  } finally { await proxy.close(); await approved.close(); await other.close(); }
});

test("a host name is decided before any lookup; an admitted one is resolved and must be public", async () => {
  let lookups = 0;
  const decisions: string[] = [];
  let dialled = 0;
  const trap = createTcp(s => { dialled++; s.destroy(); });
  trap.listen(0, "127.0.0.1"); await once(trap, "listening");
  const trapPort = (trap.address() as { port: number }).port;
  const proxy = await startRunnerProxy({
    admit: only(`https://approved.example.test:${trapPort}`),
    resolve: async () => { lookups++; return [{ address: "127.0.0.1" }]; },
    onDecision: d => decisions.push(`${d.origin} ${d.allowed}`),
  });
  try {
    // Not approved: refused with no lookup and no dial.
    assert.match(await connectVia(proxy.url, `unapproved.example.test:${trapPort}`), /^HTTP\/1\.1 403/);
    assert.equal(lookups, 0, "an unapproved name is never looked up");
    // Control: the approved name is looked up; it resolves to loopback, so it is refused undialled.
    assert.match(await connectVia(proxy.url, `approved.example.test:${trapPort}`), /^HTTP\/1\.1 403/);
    assert.equal(lookups, 1, "the approved name was looked up");
    assert.equal(dialled, 0, "a name resolving to this computer is never dialled");
    assert.deepEqual(decisions, [`https://unapproved.example.test:${trapPort} false`, `https://approved.example.test:${trapPort} false`]);
  } finally { await proxy.close(); trap.close(); }
});

test("a stopped proxy says so", async () => {
  const proxy = await startRunnerProxy({ admit: async c => c[0]! });
  let closed = false;
  void proxy.closed.then(() => { closed = true; });
  await proxy.close();
  await new Promise(ok => setTimeout(ok, 10));
  assert.equal(closed, true);
});

test("the browser going away ends the proxied request it left waiting upstream", async () => {
  let reached!: () => void; const arrived = new Promise<void>(r => { reached = r; });
  let upstreamClosed = false;
  const held = createHttp((req, res) => { res.once("close", () => { upstreamClosed = true; }); reached(); void req; });
  held.listen(0, "127.0.0.1"); await once(held, "listening");
  const origin = `http://127.0.0.1:${(held.address() as { port: number }).port}`;
  const proxy = await startRunnerProxy({ admit: only(origin) });
  try {
    const p = new URL(proxy.url);
    const client = request({ host: p.hostname, port: Number(p.port), path: `${origin}/hold`, headers: { host: new URL(origin).host }, agent: false });
    client.on("error", () => {}); client.end();
    await arrived;
    client.destroy();
    for (let i = 0; i < 100 && !upstreamClosed; i++) await new Promise(ok => setTimeout(ok, 20));
    assert.equal(upstreamClosed, true, "the held upstream request closed with its browser side");
    // And close() returns even with that connection gone and others idle.
    const idle = connect(Number(p.port), p.hostname); await once(idle, "connect");
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([proxy.close(), new Promise<never>((_ok, fail) => { timer = setTimeout(() => fail(new Error("close() did not return within 5 s with an idle connection open")), 5000); })]).finally(() => clearTimeout(timer));
  } finally { await proxy.close(); held.closeAllConnections(); held.close(); }
});

// The server in its own process, as a running copy is: Bun's listener defers accept until the
// client's first byte, so a proxy that connects but never sends leaves the copy in SYN-RECV.
async function separateServer() {
  const { spawn } = await import("node:child_process");
  const script = `const http = require("node:http"); const s = http.createServer((q, r) => { r.setHeader("content-type", "text/plain"); r.end("copy " + q.url); }); s.listen(0, "127.0.0.1", () => console.log(s.address().port));`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((ok, fail) => { child.stdout!.once("data", (b: Buffer) => ok(Number(b.toString().trim()))); child.once("error", fail); child.once("exit", () => fail(new Error("the copy stand-in exited"))); });
  return { origin: `http://127.0.0.1:${port}`, close: () => { child.kill("SIGKILL"); } };
}
const within = <T>(ms: number, what: string, p: Promise<T>) => { let timer: ReturnType<typeof setTimeout> | undefined; return Promise.race([p, new Promise<never>((_ok, fail) => { timer = setTimeout(() => fail(new Error(`${what} did not answer within ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer)); };

test("a slow admission still forwards the request to a server in another process", { timeout: 30_000 }, async () => {
  const copy = await separateServer();
  try {
    for (const delayMs of [0, 300, 1500]) {
      const proxy = await startRunnerProxy({ admit: only(copy.origin, delayMs) });
      try {
        // Positive control at 0 ms; the production-like cases admit after the request has ended.
        const answer = await within(delayMs + 2000, `a GET admitted after ${delayMs} ms`, viaProxy(proxy.url, `${copy.origin}/drafts`));
        assert.deepEqual(answer, { status: 200, body: "copy /drafts" }, `admitted after ${delayMs} ms`);
        // Several at once on a keep-alive browser connection, as a page's scripts load.
        const answers = await within(delayMs + 3000, "parallel GETs", Promise.all(["/a.js", "/b.js", "/c.js", "/d.js", "/e.js", "/f.js"].map(p => viaProxy(proxy.url, `${copy.origin}${p}`))));
        assert.ok(answers.every(a => a.status === 200), JSON.stringify(answers));
      } finally { await proxy.close(); }
    }
  } finally { copy.close(); }
});
