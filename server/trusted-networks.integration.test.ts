// The trust boundary of a trusted network (§app.access/networks, §app.access/gate) over real sockets: the
// server on an ephemeral loopback port (HOST=127.0.0.1, SOVA_AUTH=off: the test rig's "no token"), and a
// trusted network stood in for by loopback addresses, since a test can't bring up a VPN. The trusted
// listener sits at 127.0.0.2 (this computer's address on the network), the trusted range is
// 127.0.0.2/31 (so a client bound to 127.0.0.3 is a device on that network), and a client bound to
// 127.0.0.4 is anyone else. Every request goes out with node:http, ws or a raw socket bound to the
// source address it claims to be, so the server judges a real socket's address and nothing else.
// Seen failing in a scratch copy, one break at a time: serverAuthEnabled and the gate ignoring the open
// listeners (the 401 case), silentLocal not skipping a trusted socket (no cookie), the listener's source
// check passing everyone (cut off, forwarded-for, narrowing), re-judging and the close of upgraded sockets
// left out (narrowing, Stop Trusting).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request, Agent, type IncomingHttpHeaders } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "sova-trusted-net-test-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
process.env.PORT = "0";
for (const name of ["SOVA_TOKEN", "HOST", "SOVA_ALLOWED_HOSTS", "SOVA_ALLOWED_ORIGINS"]) delete process.env[name];
// The review's case: a loopback bind with the token switched off, which a trusted network must override.
process.env.HOST = "127.0.0.1";
process.env.SOVA_AUTH = "off";
mkdirSync(join(tmp, "agent", "sessions", "live"), { recursive: true });

const { app, server } = await import("./index");
const { AUTH_COOKIE, sovaToken, serverAuthEnabled } = await import("./auth");
const { senderSecret } = await import("./overseer-sender");
// The test's seam: a plan of listeners in place of detection, the store and the private-range rule.
const { setTrustedPlanForTest, refreshTrustedListeners } = await import("./networks/listeners");
if (!server.listening) await new Promise((r) => server.once("listening", r));
const port = (server.address() as { port: number }).port;

const ADDR = "127.0.0.2"; // this computer on the trusted network
const RANGE = "127.0.0.2/31";
const IN = "127.0.0.3"; // a device on it
const OUT = "127.0.0.4"; // anyone else
const at = `${ADDR}:${port}`;
const token = sovaToken();

/** Trust the stand-in network (or, with no ranges, stop trusting it), and wait until the listeners match. */
async function trustStandIn(ranges: string[] | null): Promise<void> {
  setTrustedPlanForTest(ranges ? [{ address: ADDR, ranges }] : null);
  await refreshTrustedListeners();
}

after(async () => {
  await trustStandIn(null).catch(() => {});
  server.close();
  server.closeAllConnections();
  rmSync(tmp, { recursive: true, force: true });
});

type Answer = { status: number; headers: IncomingHttpHeaders; body: string };
/** One request to `host`:port from the source address `from`, headers exactly as given. */
function send(from: string, host: string, method: string, path: string, headers: Record<string, string> = {}, agent: Agent | false = false): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, localAddress: from, path, method, headers: { Host: `${host}:${port}`, ...headers }, agent }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error(`no answer within 8 s: ${method} ${path}`)));
    req.end();
  });
}

/** What a raw connection from `from` gets: the bytes sent back before the server closed it. */
function rawExchange(from: string, host: string, text: string): Promise<{ bytes: string; closed: "closed" | "reset" | "refused" }> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect({ host, port, localAddress: from });
    let bytes = "";
    socket.setTimeout(8000, () => socket.destroy(new Error(`still open after 8 s from ${from}`)));
    socket.on("connect", () => socket.write(text));
    socket.on("data", (c) => (bytes += c));
    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNRESET" || err.code === "EPIPE") resolve({ bytes, closed: "reset" });
      else if (err.code === "ECONNREFUSED") resolve({ bytes, closed: "refused" });
      else reject(err);
    });
    socket.on("close", () => resolve({ bytes, closed: "closed" }));
  });
}

/** A WebSocket handshake from `from`, written by hand: Bun's `ws` client ignores localAddress, a net socket
    doesn't. "open" (101) with the socket left open, the refusal's HTTP status, or "no response" when cut. */
function handshake(from: string, host: string, headers: Record<string, string> = {}, path = "/ws/watch?path=nope"): Promise<{ answer: "open" | number | "no response"; socket: Socket }> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, localAddress: from });
    let bytes = "";
    const done = () => {
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(bytes)?.[1]);
      resolve({ answer: status === 101 ? "open" : status || "no response", socket });
    };
    socket.setTimeout(8000, () => socket.destroy());
    socket.on("connect", () => {
      const all = { Host: `${host}:${port}`, Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", Origin: `http://${host}:${port}`, ...headers };
      socket.write(`GET ${path} HTTP/1.1\r\n${Object.entries(all).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
    });
    socket.on("data", (c) => {
      bytes += c;
      if (bytes.includes("\r\n\r\n")) done();
    });
    socket.on("error", () => {});
    socket.on("close", done);
  });
}

async function upgrade(from: string, host: string, headers: Record<string, string> = {}): Promise<"open" | number | "no response"> {
  const { answer, socket } = await handshake(from, host, headers);
  socket.destroy();
  return answer;
}

const SESSIONS = "/api/sessions";
const withToken = { "x-sova-token": token };
const withCookie = { Cookie: `${AUTH_COOKIE}=${token}` };
/** A kept-alive HTTP connection and an upgraded socket, both from the device `from`, open now. */
async function openConnections(from: string): Promise<{ http: Promise<void>; ws: Promise<void>; done: () => void }> {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const res = await send(from, ADDR, "GET", SESSIONS, withToken, agent);
  assert.equal(res.status, 200, "the kept-alive connection was answered");
  await new Promise((r) => setImmediate(r)); // the agent takes the socket back after the answer ends
  const kept = Object.values(agent.freeSockets).flat()[0];
  assert.ok(kept, "the agent keeps the connection open");
  const http = new Promise<void>((resolve) => kept.once("close", () => resolve()));
  // The session list's feed: a socket that stays open until something closes it.
  const { answer, socket } = await handshake(from, ADDR, withToken, "/ws/watch?feed=sessions");
  assert.equal(answer, "open", "the upgraded socket opened");
  const ws = socket.destroyed ? Promise.resolve() : new Promise<void>((resolve) => socket.once("close", () => resolve()));
  return { http, ws, done: () => (agent.destroy(), socket.destroy()) };
}

/** "At once": closed within 2 s, or the test fails saying what stayed open. Shorter than any idle timeout
    (the server's keep-alive closes an idle connection after 5 s), so only the change itself can close it in time. */
const within = <T>(p: Promise<T>, what: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_r, reject) => setTimeout(() => reject(new Error(`${what}: still open after 2 s`)), 2000).unref())]);

const GET = (path: string, host = at, extra: Record<string, string> = {}) =>
  `GET ${path} HTTP/1.1\r\n${Object.entries({ Host: host, ...extra, Connection: "close" }).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;

describe("before any network is trusted", () => {
  test("the rig really has the token off (so the trusted cases below aren't vacuous), and nothing answers at the network's address", async () => {
    assert.equal((await send("127.0.0.1", "127.0.0.1", "GET", SESSIONS)).status, 200, "SOVA_AUTH=off on a loopback bind asks no token");
    assert.equal((await rawExchange(IN, ADDR, GET(SESSIONS))).closed, "refused");
  });
});

describe("a trusted network (HOST=127.0.0.1, SOVA_AUTH=off)", () => {
  before(() => trustStandIn([RANGE]));

  test("a device on it gets the sign-in: 401 without the token, 200 with it (header or cookie)", async () => {
    const refused = await send(IN, ADDR, "GET", SESSIONS);
    assert.equal(refused.status, 401, "SOVA_AUTH=off never applies to a trusted listener");
    assert.equal(JSON.parse(refused.body).locked, true);
    assert.equal((await send(IN, ADDR, "GET", SESSIONS, withToken)).status, 200);
    assert.equal((await send(IN, ADDR, "GET", SESSIONS, { ...withCookie, Origin: `http://${at}`, "Sec-Fetch-Site": "same-origin" })).status, 200);
  });

  test("never a silent sign-in: a navigation from it earns no cookie, even from a loopback-looking source", async () => {
    // The stand-in device's address is loopback, so this also proves the silent path is the main listener's alone.
    for (const site of ["none", "same-origin"]) {
      const nav = { "Sec-Fetch-Site": site, "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
      const res = await send(IN, ADDR, "GET", SESSIONS, nav);
      assert.equal(res.status, 401, site);
      assert.equal(res.headers["set-cookie"], undefined, site);
      assert.equal((await send(IN, ADDR, "GET", "/", nav)).headers["set-cookie"], undefined, `the shell, ${site}`);
    }
  });

  test("its exact address and origin are ones Sova goes by; a foreign Host or another origin is still refused", async () => {
    assert.equal((await send(IN, ADDR, "GET", SESSIONS, { ...withToken, Origin: `http://${at}` })).status, 200);
    for (const origin of [`http://${ADDR}:9999`, `https://${at}`, "https://evil.example", "null"])
      assert.equal((await send(IN, ADDR, "GET", SESSIONS, { ...withToken, Origin: origin })).status, 403, origin);
    // DNS rebinding: a name that resolves to the network's address is not Sova's.
    assert.equal((await send(IN, ADDR, "GET", SESSIONS, { ...withToken, Host: `evil.example:${port}` })).status, 403);
  });

  test("its WebSocket upgrade asks the token too, with the same origin rule", async () => {
    assert.equal(await upgrade(IN, ADDR), 401);
    assert.equal(await upgrade(IN, ADDR, withToken), "open");
    assert.equal(await upgrade(IN, ADDR, { ...withCookie, Origin: "https://evil.example" }), 403);
  });

  test("a source outside the range is cut off at accept: no HTTP answer, no WebSocket", async () => {
    const res = await rawExchange(OUT, ADDR, GET(SESSIONS, at, withToken));
    assert.equal(res.bytes, "", "not one byte of an answer");
    assert.notEqual(res.closed, "refused", "the listener is there; the source is what's refused");
    assert.equal(await upgrade(OUT, ADDR, withToken), "no response");
    // Not vacuous: this computer itself on the main listener is still answered from 127.0.0.4.
    assert.equal((await send(OUT, "127.0.0.1", "GET", SESSIONS, withToken)).status, 200);
  });

  test("a forwarded-for header can't speak for the source: only the socket's address counts", async () => {
    const claims: Array<Record<string, string>> = [{ "X-Forwarded-For": IN }, { "X-Real-IP": IN }, { Forwarded: `for=${IN}` }, { "X-Forwarded-For": `${IN}, ${OUT}` }, { "CF-Connecting-IP": IN }];
    for (const claim of claims) {
      const res = await rawExchange(OUT, ADDR, GET(SESSIONS, at, { ...withToken, ...claim }));
      assert.equal(res.bytes, "", JSON.stringify(claim));
    }
    // And the other way round: a device in range claiming to be elsewhere is still judged as itself.
    assert.equal((await send(IN, ADDR, "GET", SESSIONS, { ...withToken, "X-Forwarded-For": OUT })).status, 200);
  });

  test("narrowing the range closes the open connections of a device it leaves out, kept-alive and upgraded", async () => {
    const open = await openConnections(IN);
    const stays = await openConnections(ADDR); // a device the narrower range still holds
    let kept = true;
    void stays.http.then(() => (kept = false));
    void stays.ws.then(() => (kept = false));
    try {
      await trustStandIn([`${ADDR}/32`]);
      await within(open.http, "the kept-alive connection");
      await within(open.ws, "the upgraded socket");
      await new Promise((r) => setImmediate(r));
      assert.equal(kept, true, "not vacuous: the connections of a device still in range stay open");
      assert.equal((await rawExchange(IN, ADDR, GET(SESSIONS, at, withToken))).bytes, "", "and it can't come back");
    } finally {
      open.done();
      stays.done();
      await trustStandIn([RANGE]);
    }
  });

  test("the trust routes are the page's alone: a script, a chat, a tour recorder, a relayed call or a peer is refused", async () => {
    const main = `127.0.0.1:${port}`;
    const page = { Host: main, Origin: `http://${main}`, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", ...withCookie };
    const body = JSON.stringify({ range: "10.8.0.0/24" });
    const post = (path: string, headers: Record<string, string>, text = body) =>
      new Promise<Answer>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path, method: "POST", headers, agent: false }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
        });
        req.on("error", reject);
        req.end(text);
      });
    // [who, headers, the refusal: your-click 403, a plain 403, or the token's 401]
    const callers: Array<[string, Record<string, string>, "yourClick" | 403 | 401]> = [
      ["a script (the token header)", { "Content-Type": "application/json", Host: main, ...withToken }, "yourClick"],
      ["a chat (its caller mark)", { ...page, ...withToken, "x-sova-caller": "chat-key" }, "yourClick"],
      ["the Overseer (its sender mark)", { ...page, "x-sova-overseer": senderSecret() }, "yourClick"],
      ["a cookieless socket (SOVA_AUTH=off no longer makes it the page)", { "Content-Type": "application/json", Host: main }, 401],
      ["a tour recorder", { ...page, "x-sova-tour-recorder": "1" }, 403],
      ["a relayed call", { ...page, "X-Sova-Relayed": "1" }, 403],
    ];
    for (const [who, headers, want] of callers) {
      const res = await post("/api/auth/networks/trust", headers);
      assert.equal(res.status, want === "yourClick" ? 403 : want, `${who}: ${res.body}`);
      if (want === "yourClick") assert.equal(JSON.parse(res.body).yourClick, true, who);
    }
    // A peer, as the peer listener hands it on (no socket of the main listener's gate).
    const peer = await app.request("/api/auth/networks/trust", { method: "POST", headers: { "Content-Type": "application/json" }, body }, { incoming: {}, meshPeer: { id: "p" } });
    assert.ok(peer.status === 403 || peer.status === 404, `a peer: answered ${peer.status}`);
    // Not vacuous: the page itself passes the door and meets the range rule (a public range is refused as such).
    const own = await post("/api/auth/networks/trust", page, JSON.stringify({ range: "8.8.8.0/24" }));
    assert.equal(own.status, 400, own.body);
    assert.equal(JSON.parse(own.body).yourClick, undefined);
  });
});

describe("Stop Trusting", () => {
  test("closes the listener and every open connection at once; SOVA_AUTH=off is the rig's again", async () => {
    await trustStandIn([RANGE]);
    const open = await openConnections(IN);
    try {
      await trustStandIn(null);
      await within(open.http, "the kept-alive connection");
      await within(open.ws, "the upgraded socket");
    } finally {
      open.done();
    }
    assert.equal((await rawExchange(IN, ADDR, GET(SESSIONS))).closed, "refused", "nothing listens there now");
    assert.equal(serverAuthEnabled(), false);
    assert.equal((await send("127.0.0.1", "127.0.0.1", "GET", SESSIONS)).status, 200);
  });
});
