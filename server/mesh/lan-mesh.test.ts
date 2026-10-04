// Run: pnpm test -- server/mesh/lan-mesh.test.ts
// Dial-out pairings end to end in one process (§mesh/lan): this process's Sova server, paired
// through its own Mesh page routes, against a stand-in for the other host built from the same
// transport modules. First this server is the RELAY (the stand-in dials it on both channels), then
// the DIAL-OUT HOST (it dials a stand-in relay). Both directions pass the answering host's peer gate
// and grants; a removed pairing loses its connections at once.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { after, before, describe, test } from "node:test";
import type { MeshSessionsView } from "../../shared/mesh-access";
import type { LanStatus } from "../../shared/mesh-lan";

const tmp = mkdtempSync(join(tmpdir(), "sova-lan-mesh-test-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
process.env.PORT = "0";
process.env.SOVA_PEER_HOST = "127.0.0.1";
process.env.SOVA_PEER_PORT = "0";
mkdirSync(join(tmp, "agent", "sessions", "live"), { recursive: true });

const { setIdentity } = await import("./localapi");
// No tailnet at all: a host whose only peers are pairings never asks for one.
let tailscaleAsked = 0;
setIdentity({
  status: async () => {
    tailscaleAsked++;
    throw new Error("no tailscale here");
  },
  whois: async () => {
    tailscaleAsked++;
    return null;
  },
});

const { server } = await import("../index");
const { stopMesh, listenerInfo } = await import("./index");
const { AUTH_COOKIE, sovaToken } = await import("../auth");
const { mintLanIdentity, parsePin } = await import("./lan-cert");
const { RelayDialer } = await import("./lan-dialer");
const { RelayListener } = await import("./lan-relay");
const { LAN_PROFILE } = await import("./lan-admission");
const { connectReverse, serveReverse } = await import("./lan-reverse");
const { agentFetch } = await import("./lan-fetch");
const { streamWebSocketServer } = await import("../runtime-quirks");
const { accessFile } = await import("./access");
const { cleanLabel } = await import("./details");
type ReverseClient = Awaited<ReturnType<typeof connectReverse>>;

const AUTH = { Cookie: `${AUTH_COOKIE}=${sovaToken()}` };
let base = "";
const api = async <T>(method: string, path: string, body?: unknown): Promise<[number, T]> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...AUTH, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return [res.status, (await res.json()) as T];
};
const lan = async () => (await api<LanStatus>("GET", "/api/mesh/lan"))[1];
const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
};

// ---- the stand-in's own Sova-like server: what the other host answers on its side ----------------
const seen: Array<{ path: string; headers: IncomingMessage["headers"] }> = [];
const standInWss = streamWebSocketServer();
function standInServer(): Server {
  const s = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    seen.push({ path: url.pathname, headers: req.headers });
    if (url.pathname === "/api/peer/hello") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ mesh: 1, id: "other", label: "Other", hostname: "other", version: "0", protocol: "x", pi: "x", now: Date.now() }));
    }
    if (url.pathname === "/api/sessions") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify([{ id: "far-1", path: "/far/one.jsonl" }]));
    }
    if (url.pathname === "/api/page") {
      // Everything a hostile host would try on the browser's origin.
      res.writeHead(302, {
        "content-type": "text/html",
        location: "https://evil.example/",
        "set-cookie": "x=1",
        "access-control-allow-origin": "*",
        "clear-site-data": '"*"',
        "service-worker-allowed": "/",
        link: "<https://evil.example/x.js>; rel=preload",
        refresh: "0;url=https://evil.example/",
        "x-custom": "1",
      });
      return res.end("<script>alert(1)</script>");
    }
    res.writeHead(404);
    res.end();
  });
  s.on("upgrade", (req, socket, head) => standInWss.handleUpgrade(req, socket as Duplex, head, (ws) => ws.send("hi from the other host")));
  return s;
}

before(async () => {
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", r)));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  stopMesh();
  server.close();
  server.closeAllConnections();
  rmSync(tmp, { recursive: true, force: true });
});

test("the pairing routes are this host's own browser's only", async () => {
  for (const [method, path] of [
    ["GET", "/api/mesh/lan"],
    ["POST", "/api/mesh/lan/key"],
    ["POST", "/api/mesh/lan/pairings"],
    ["PUT", "/api/mesh/lan/relay"],
  ] as const) {
    const res = await fetch(`${base}${path}`, { method, headers: { ...AUTH, "X-Sova-Relayed": "1" } });
    assert.equal(res.status, 404, `${method} ${path} relayed`);
    await res.body?.cancel();
  }
  const [, before] = await api<LanStatus>("GET", "/api/mesh/lan");
  assert.equal(before.fingerprint, undefined, "no key until asked for");
  assert.deepEqual(before.pairings, []);
});

describe("this host as the relay", () => {
  const other = mintLanIdentity();
  const otherServer = standInServer();
  let relayPin = "";
  let port = 0;
  let answer: InstanceType<typeof RelayDialer>;
  let ask: InstanceType<typeof RelayDialer>;
  let askClient: ReverseClient | null = null;

  before(async () => {
    const [, key] = await api<LanStatus>("POST", "/api/mesh/lan/key");
    relayPin = parsePin(key.fingerprint)!;
    assert.ok(relayPin);
    const [s1, r1] = await api<LanStatus>("PUT", "/api/mesh/lan/relay", { relay: { host: "127.0.0.1", port: 0 } });
    assert.equal(s1, 200, JSON.stringify(r1));
    assert.equal(r1.relay?.listening, false, "no listener before a pairing exists");
  });

  after(() => {
    answer?.stop();
    ask?.stop();
    otherServer.close();
  });

  test("the relay setting takes only a local-network address of this host (q9: no internet relay)", async () => {
    const bad: Array<[unknown, RegExp]> = [
      [{ host: "203.0.113.7", port: 4803 }, /public address/],
      [{ host: "2001:db8::7", port: 4803 }, /public address/],
      [{ host: "0::", port: 4803 }, /every interface/],
      [{ host: "::ffff:0.0.0.0", port: 4803 }, /every interface/],
      [{ host: "127.0.0.1", port: 4803, exposure: "internet" }, /separate accept process/],
      // Private, but not an address of this host.
      [{ host: "10.255.255.254", port: 4803 }, /not an address of this host/],
    ];
    for (const [relay, why] of bad) {
      const [status, r] = await api<{ error: string }>("PUT", "/api/mesh/lan/relay", { relay });
      assert.equal(status, 400, JSON.stringify(relay));
      assert.match(r.error, why, JSON.stringify(relay));
    }
    assert.equal((await lan()).relay?.host, "127.0.0.1", "the setting is unchanged");
  });

  test("a bad pairing is refused whole", async () => {
    const bad: Array<[unknown, RegExp]> = [
      [{ id: "laptop", role: "accept", pin: "1234" }, /32 hex/],
      [{ id: "Laptop!", role: "accept", pin: other.pin }, /id must/],
      [{ id: "laptop", role: "both", pin: other.pin }, /role/],
      [{ id: "laptop", role: "accept", pin: relayPin }, /own fingerprint/],
      [{ id: "laptop", role: "dial", pin: other.pin, host: "0.0.0.0", port: 1 }, /host/],
      [{ id: "laptop", role: "dial", pin: other.pin, host: "198.51.100.7", port: 1 }, /public address/],
      [{ id: "laptop", role: "accept", pin: other.pin, grant: "root" }, /grant/],
    ];
    for (const [body, why] of bad) {
      const [status, r] = await api<{ error: string }>("POST", "/api/mesh/lan/pairings", body);
      assert.equal(status, 400, JSON.stringify(body));
      assert.match(r.error, why);
    }
  });

  test("pairing a dial-out host starts the listener and grants it presence", async () => {
    const [status, r] = await api<LanStatus>("POST", "/api/mesh/lan/pairings", { id: "laptop", label: "Laptop", role: "accept", pin: other.pin.toLowerCase().match(/.{4}/g)!.join("-") });
    assert.equal(status, 200, JSON.stringify(r));
    await until("the listener", async () => (await lan()).relay?.listening === true);
    port = (await lan()).relay!.boundPort!;
    const [, access] = await api<{ peers: Array<{ id: string; nodeId: string; grant?: { preset: string } }> }>("GET", "/api/mesh/access");
    const row = access.peers.find((p) => p.id === "laptop")!;
    assert.equal(row.grant?.preset, "presence");
    assert.match(row.nodeId, /^lan:[0-9a-f]{32}$/);
    assert.equal(listenerInfo(), null, "no tailnet listener for a pairing alone");
  });

  test("the dial-out host connects on both channels", async () => {
    const target = { id: "relay", label: "Relay", host: "127.0.0.1", port, pin: relayPin };
    answer = new RelayDialer({ identity: other, relay: target, channel: "answer", onStream: (d) => otherServer.emit("connection", d) });
    ask = new RelayDialer({ identity: other, relay: target, channel: "ask", onClient: (c) => (askClient = c) });
    answer.start();
    ask.start();
    await until("both channels", async () => {
      const p = (await lan()).pairings.find((x) => x.id === "laptop");
      return p?.channels.answer.state === "connected" && p.channels.ask.state === "connected";
    });
    assert.ok(askClient);
  });

  test("the relay asks over the answer channel: sessions, and a proxied page cut down to safe headers", async () => {
    const [, sessions] = await api<MeshSessionsView>("GET", "/api/mesh/sessions");
    const row = sessions.peers.find((p) => p.id === "laptop")!;
    assert.equal(row.state, "up");
    assert.deepEqual(row.sessions?.map((s) => s.id), ["far-1"]);
    const hop = seen.find((s) => s.path === "/api/sessions")!;
    assert.equal(hop.headers.host, "lan-peer", "the Host names nothing");

    // The pairing has the full grant here, and the hop still carries nothing of this host or browser.
    await api("PUT", "/api/mesh/access", { peer: "laptop", grant: { preset: "full" } });
    const res = await fetch(`${base}/peer/laptop/api/page`, { headers: { ...AUTH, Origin: base, "User-Agent": "TheBrowser/1", "Accept-Language": "xx" }, redirect: "manual" });
    await api("PUT", "/api/mesh/access", { peer: "laptop", grant: { preset: "presence" } });
    const hopped = [...seen].reverse().find((s) => s.path === "/api/page")!;
    assert.equal(hopped.headers["x-forwarded-host"], "peer");
    assert.equal(hopped.headers.origin, undefined);
    assert.equal(hopped.headers["accept-language"], undefined);
    assert.notEqual(hopped.headers["user-agent"], "TheBrowser/1");
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("content-type"), "application/octet-stream");
    assert.equal(res.headers.get("content-disposition"), "attachment");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-security-policy") ?? "", /sandbox/);
    for (const h of ["location", "set-cookie", "access-control-allow-origin", "clear-site-data", "service-worker-allowed", "link", "refresh", "x-custom"]) {
      assert.equal(res.headers.get(h), null, h);
    }
    await res.body?.cancel();
  });

  test("a WebSocket to the dial-out host rides a stream through the proxy", async () => {
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`${base.replace("http", "ws")}/peer/laptop/ws/watch?feed=sessions`, { headers: AUTH });
    const first = await new Promise<string>((ok, fail) => {
      ws.once("message", (d) => ok(String(d)));
      ws.once("error", fail);
    });
    assert.equal(first, "hi from the other host");
    ws.close();
  });

  test("the dial-out host asks over the ask channel, and the relay's grant decides", async () => {
    const hello = await agentFetch(askClient!.agent, "/api/peer/hello");
    assert.equal(hello.status, 200);
    assert.equal(((await hello.json()) as { mesh: number }).mesh, 1);
    const denied = await agentFetch(askClient!.agent, "/api/sessions");
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("x-sova-mesh"), "denied");
    await denied.body?.cancel();
    // Never this host's own Mesh page routes, whatever the grant.
    for (const path of ["/api/mesh/lan", "/api/mesh/access", "/api/mesh"]) {
      const r = await agentFetch(askClient!.agent, path);
      assert.equal(r.status, 404, path);
      await r.body?.cancel();
    }
    const [s] = await api("PUT", "/api/mesh/access", { peer: "laptop", grant: { preset: "sessions" } });
    assert.equal(s, 200);
    const now = await agentFetch(askClient!.agent, "/api/sessions");
    assert.equal(now.status, 200);
    assert.ok(Array.isArray(await now.json()));
  });

  test("a socket on the ask channel passes the gate too, and a lowered grant cuts it", async () => {
    const ws = await askClient!.webSocket("/ws/watch?feed=sessions");
    await new Promise<void>((ok, fail) => {
      if (ws.readyState === ws.OPEN) return ok();
      ws.once("open", () => ok());
      ws.once("error", fail);
    });
    const closed = new Promise<void>((r) => ws.once("close", () => r()));
    await api("PUT", "/api/mesh/access", { peer: "laptop", grant: { preset: "presence" } });
    await closed;
    await assert.rejects(
      askClient!.webSocket("/ws/watch?feed=sessions").then(
        (w) =>
          new Promise((ok, fail) => {
            w.once("open", ok);
            w.once("unexpected-response", (_q, res: IncomingMessage) => fail(new Error(`status ${res.statusCode} ${res.headers["x-sova-mesh"]}`)));
            w.once("error", fail);
          }),
      ),
      /403 denied/,
    );
  });

  test("M1: with no grant entry, or no grants file, the pairing has presence, never full", async () => {
    const askSessions = async () => {
      const r = await agentFetch(askClient!.agent, "/api/sessions");
      await r.body?.cancel();
      return `${r.status} ${r.headers.get("x-sova-mesh") ?? ""}`.trim();
    };
    const shown = async () => (await api<{ peers: Array<{ id: string; grant?: { preset: string } }> }>("GET", "/api/mesh/access"))[1].peers.find((p) => p.id === "laptop")?.grant?.preset;
    await api("PUT", "/api/mesh/access", { peer: "laptop", grant: { preset: "full" } });
    assert.equal(await askSessions(), "200");
    // Cleared on the page: presence, written as such, and shown as such.
    const [s] = await api("PUT", "/api/mesh/access", { peer: "laptop", grant: null });
    assert.equal(s, 200);
    assert.equal(await shown(), "presence");
    assert.equal(await askSessions(), "403 denied");
    // The whole file gone (a user "resetting" grants): still presence, never full.
    await api("PUT", "/api/mesh/access", { peer: "laptop", grant: { preset: "full" } });
    rmSync(accessFile(), { force: true });
    assert.equal(await askSessions(), "403 denied");
    assert.equal(await shown(), "presence");
    const hello = await agentFetch(askClient!.agent, "/api/peer/hello");
    assert.equal(hello.status, 200, "presence still answers hello");
    await hello.body?.cancel();
  });

  test("L6: a pairing can't rename itself here; names lose control and bidi characters", async () => {
    const r = await agentFetch(askClient!.agent, "/api/peer/label", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "Trusted\n[mesh] forged line", labelAt: Date.now() + 1000 }) });
    assert.equal(r.status, 200, "answered as taken");
    await r.body?.cancel();
    assert.equal((await lan()).pairings.find((p) => p.id === "laptop")?.label, "Laptop", "the operator's name stays");
    assert.equal(cleanLabel("Trusted\n[mesh] forged"), "Trusted[mesh] forged");
    assert.equal(cleanLabel("a\u202eb\u2066c\u0007"), "abc");
    assert.equal(cleanLabel("\u0000\u001b"), null, "nothing printable is no name");
  });

  test("M1: a pairing whose grant can't be written is not made", async () => {
    const before = readFileSync(join(tmp, "agent", "sova", "peers.json"), "utf8");
    writeFileSync(accessFile(), "{broken");
    const [status, r] = await api<{ error: string }>("POST", "/api/mesh/lan/pairings", { id: "second", role: "accept", pin: mintLanIdentity().pin, grant: "presence" });
    assert.equal(status, 409, JSON.stringify(r));
    assert.match(r.error, /grant couldn't be written/);
    assert.equal(readFileSync(join(tmp, "agent", "sova", "peers.json"), "utf8"), before, "peers.json untouched");
    rmSync(accessFile(), { force: true });
    // A refused pairing never touches an existing pairing's grant either.
    await api("PUT", "/api/mesh/access", { peer: "laptop", grant: { preset: "presence" } });
    const [dup] = await api("POST", "/api/mesh/lan/pairings", { id: "again", role: "accept", pin: other.pin, grant: "full" });
    assert.equal(dup, 400);
    const [, view] = await api<{ peers: Array<{ id: string; grant?: { preset: string } }> }>("GET", "/api/mesh/access");
    assert.equal(view.peers.find((p) => p.id === "laptop")?.grant?.preset, "presence");
  });

  test("a host with another key is refused before any stream", async () => {
    const stranger = mintLanIdentity();
    let status = "";
    const d = new RelayDialer({ identity: stranger, relay: { id: "relay", label: "Relay", host: "127.0.0.1", port, pin: relayPin }, channel: "ask", onStatus: (s) => (status = s.state) });
    d.start();
    await until("the refusal", () => status === "waiting");
    d.stop();
  });

  test("the paired host dialing with a wrong relay pin never displaces its working connection", async () => {
    let status = "";
    const wrongPin = mintLanIdentity().pin;
    for (const channel of ["ask", "answer"] as const) {
      status = "";
      const d = new RelayDialer({ identity: other, relay: { id: "relay", label: "Relay", host: "127.0.0.1", port, pin: wrongPin }, channel, onStatus: (s) => (status = s.state) });
      d.start();
      await until(`the ${channel} refusal`, () => status === "waiting");
      d.stop();
    }
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(askClient!.destroyed, false);
    const hello = await agentFetch(askClient!.agent, "/api/peer/hello");
    assert.equal(hello.status, 200, "the real ask channel still answers");
    await hello.body?.cancel();
    const p = (await lan()).pairings.find((x) => x.id === "laptop")!;
    assert.equal(p.channels.answer.state, "connected");
    assert.equal(p.channels.ask.state, "connected");
    assert.equal(p.cloneSuspected, undefined);
  });

  test("M2: Stop Relaying ends both channels of a kept pairing within 1 s; nothing of the old listener stays up", async () => {
    await api("PUT", "/api/mesh/access", { peer: "laptop", grant: { preset: "sessions" } });
    const client = askClient!;
    const ws = await client.webSocket("/ws/watch?feed=sessions");
    await new Promise<void>((ok, fail) => (ws.readyState === ws.OPEN ? ok() : (ws.once("open", () => ok()), ws.once("error", fail))));
    const wsClosed = new Promise<void>((r) => ws.once("close", () => r()));
    const t0 = Date.now();
    const [s] = await api("PUT", "/api/mesh/lan/relay", { relay: null });
    assert.equal(s, 200);
    const within = (p: Promise<unknown>, what: string) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what} still open after 1 s`)), 1000 - (Date.now() - t0)))]);
    await within(client.closed, "the ask channel");
    await within(wsClosed, "a WebSocket on the ask channel");
    await within(until("the relay's answer channel to close", async () => (await lan()).pairings.find((x) => x.id === "laptop")?.channels.answer.state === "not connected", 1000), "the answer channel");
    const p = (await lan()).pairings.find((x) => x.id === "laptop")!;
    assert.deepEqual([p.channels.answer.state, p.channels.ask.state], ["not connected", "not connected"]);
    assert.equal((await lan()).relay, undefined, "not a relay");
    const sessions = (await api<MeshSessionsView>("GET", "/api/mesh/sessions"))[1].peers.find((x) => x.id === "laptop")!;
    assert.equal(sessions.state, "down", "the relay can't reach it either");
    // The pairing is still paired: relaying again at the same port lets it dial back in.
    const [s2, r2] = await api<LanStatus>("PUT", "/api/mesh/lan/relay", { relay: { host: "127.0.0.1", port } });
    assert.equal(s2, 200, JSON.stringify(r2));
    await until("both channels again", async () => {
      const q = (await lan()).pairings.find((x) => x.id === "laptop");
      return q?.channels.answer.state === "connected" && q.channels.ask.state === "connected" && !!askClient && !askClient.destroyed;
    }, 30_000);
    await api("PUT", "/api/mesh/access", { peer: "laptop", grant: { preset: "presence" } });
  });

  test("removing the pairing ends its connections at once and stops the listener", async () => {
    const client = askClient!;
    const [status] = await api("DELETE", "/api/mesh/lan/pairings/laptop");
    assert.equal(status, 200);
    await Promise.race([client.closed, new Promise((_, no) => setTimeout(() => no(new Error("still open")), 2000))]);
    await until("the listener to stop", async () => (await lan()).relay?.listening === false);
    const [, access] = await api<{ peers: Array<{ id: string }> }>("GET", "/api/mesh/access");
    assert.equal(access.peers.length, 0, "its grant went with it");
    answer.stop();
    ask.stop();
  });
});

describe("this host as the dial-out host", () => {
  const relayId = mintLanIdentity();
  const relayServer = standInServer();
  let ownPin = "";
  let relay: InstanceType<typeof RelayListener>;
  /** The stand-in relay's client toward this host (our answer channel). */
  let toUs: ReverseClient | null = null;

  before(async () => {
    ownPin = parsePin((await lan()).fingerprint)!;
    relay = new RelayListener({
      host: "127.0.0.1",
      port: 0,
      identity: relayId,
      profile: LAN_PROFILE,
      onPeer: (sock, _peer, channel) => {
        if (channel === "ask") serveReverse(sock, (d) => relayServer.emit("connection", d));
        else void connectReverse(sock).then((c) => (toUs = c));
      },
    });
    await relay.setPaired([{ id: "me", label: "Me", pin: ownPin }]);
  });

  after(async () => {
    await relay.close();
    relayServer.close();
  });

  test("pairing a relay dials it on both channels", async () => {
    const [status, r] = await api<LanStatus>("POST", "/api/mesh/lan/pairings", { id: "relay", role: "dial", pin: relayId.pin, host: "127.0.0.1", port: relay.address()!.port });
    assert.equal(status, 200, JSON.stringify(r));
    await until("both channels", async () => {
      const p = (await lan()).pairings.find((x) => x.id === "relay");
      return p?.channels.answer.state === "connected" && p.channels.ask.state === "connected";
    });
  });

  test("this host's own calls to the relay go over the ask channel", async () => {
    const [, sessions] = await api<MeshSessionsView>("GET", "/api/mesh/sessions");
    const row = sessions.peers.find((p) => p.id === "relay")!;
    assert.equal(row.state, "up");
    assert.deepEqual(row.sessions?.map((s) => s.id), ["far-1"]);
  });

  test("the relay's calls into this host pass this host's grant for it", async () => {
    await until("the relay's client", () => toUs !== null);
    const hello = await agentFetch(toUs!.agent, "/api/peer/hello");
    assert.equal(hello.status, 200);
    await hello.body?.cancel();
    const denied = await agentFetch(toUs!.agent, "/api/sessions");
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("x-sova-mesh"), "denied");
    await denied.body?.cancel();
  });

  test("removing the relay stops dialing at once", async () => {
    const client = toUs!;
    const [status] = await api("DELETE", "/api/mesh/lan/pairings/relay");
    assert.equal(status, 200);
    await Promise.race([client.closed, new Promise((_, no) => setTimeout(() => no(new Error("still open")), 2000))]);
    assert.deepEqual((await lan()).pairings, []);
    assert.equal(tailscaleAsked, 0, "nothing ever asked Tailscale");
  });
});

test("L8: a relay listener that can't bind logs a fixed phrase and the code, never the address", async () => {
  const { LanRuntime } = await import("./lan");
  const { validatePeers } = await import("./peers");
  const busy = createServer();
  busy.listen(0, "127.0.0.1");
  await new Promise((r) => busy.once("listening", r));
  const busyPort = (busy.address() as { port: number }).port;
  const v = validatePeers({ self: { id: "me", relay: { host: "127.0.0.1", port: busyPort } }, peers: [{ id: "laptop", lan: { role: "accept", pin: mintLanIdentity().pin } }] });
  assert.ok("config" in v);
  const rt = new LanRuntime({ fetch: () => new Response(null), upgrade: () => {}, pairingByNode: () => null });
  const said: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void said.push(a.join(" "));
  try {
    await rt.apply(v.config);
  } finally {
    console.warn = warn;
    await rt.stop();
    busy.close();
  }
  assert.ok(said.some((l) => /EADDRINUSE/.test(l)), JSON.stringify(said));
  for (const l of said) {
    assert.doesNotMatch(l, /127\.0\.0\.1/, l);
    assert.doesNotMatch(l, new RegExp(`\\b${busyPort}\\b`), l);
  }
});
