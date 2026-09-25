// Run: pnpm exec tsx --test server/mesh/mesh.test.ts
// The mesh against a throwaway PI_CODING_AGENT_DIR in the OS temp dir (removed after), the server
// on an ephemeral port, a stub identity provider (the only place one exists: the lab uses real
// whois), a fake peer (plain HTTP + WS on loopback), and this server's own peer listener bound
// to 127.0.0.1 so a request can make the whole trip: proxy → peer listener → whois gate → app.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import type { MeshCandidate, MeshHello, MeshInfo, MeshSessions, MeshSettings } from "../../shared/protocol";

const tmp = mkdtempSync(join(tmpdir(), "sova-mesh-test-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
process.env.PORT = "0";
process.env.SOVA_PEER_HOST = "127.0.0.1";
process.env.SOVA_PEER_PORT = "0";
mkdirSync(join(tmp, "agent", "sessions", "live"), { recursive: true });

// Every LocalAPI call goes through this stub; OFF, it must never be called.
const { setIdentity } = await import("./localapi");
let identityCalls = 0;
/** What whois answers for the next NEW connection to the peer listener. */
let whoisNode: string | null = null;
let tailnetPeers: Array<{ nodeId: string; name: string; online: boolean; tags?: string[] }> = [];
setIdentity({
  status: async () => {
    identityCalls++;
    return {
      backendState: "Running",
      self: { nodeId: "nA", name: "a.lab", hostName: "a", os: "linux", online: true, tags: [], login: "me", addresses: ["127.0.0.1"] },
      peers: tailnetPeers.map((p) => ({ hostName: p.name.split(".")[0]!, os: "linux", tags: [], login: "me", addresses: [], ...p })),
    };
  },
  whois: async () => {
    identityCalls++;
    return whoisNode ? { nodeId: whoisNode, name: "x", tags: [], login: "me" } : null;
  },
});

// Count every outbound fetch this process makes.
const realFetch = globalThis.fetch;
let fetches = 0;
globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
  fetches++;
  return realFetch(...args);
}) as typeof fetch;

const { app, server } = await import("../index");
const { listenerInfo, stopMesh } = await import("./index");
const { clearProbes, ownProtocol } = await import("./hello");
const { peersFile } = await import("./peers");

let base = "";
let wsBase = "";

// ---- the fake peer ----------------------------------------------------------------------------

let fake: Server;
let fakePort = 0;
let deadPort = 0;
let fakeHello: "same" | "other" | "refused" = "same";
let fakeSessions: unknown = [{ id: "s1", path: "/far/s1.jsonl" }];

async function listen(s: Server, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((r) => s.listen(0, host, r));
  return (s.address() as { port: number }).port;
}

before(async () => {
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", r)));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
  fake = createServer(async (req: IncomingMessage, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/peer/hello") {
      if (fakeHello === "refused") return json(403, { error: "not a peer" }, { "X-Sova-Mesh": "refused" });
      const hello: MeshHello = { mesh: 1, id: "b", label: "B", hostname: "b", version: "0", protocol: fakeHello === "same" ? ownProtocol() : "0000", pi: "x", now: 1 };
      return json(200, hello);
    }
    if (url.pathname === "/api/sessions") return json(200, fakeSessions);
    if (url.pathname === "/api/gate-refused") return json(403, { error: "not a peer" }, { "X-Sova-Mesh": "refused" });
    if (url.pathname === "/api/own-403") return json(403, { error: "route says no" });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    json(url.pathname === "/api/teapot" ? 418 : 200, { method: req.method, url: req.url, body: Buffer.concat(chunks).toString(), fwd: req.headers["x-forwarded-host"] ?? null });
  });
  const wss = new WebSocketServer({ noServer: true });
  fake.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.searchParams.get("refuse") === "1") {
      socket.end("HTTP/1.1 403 Forbidden\r\nX-Sova-Mesh: refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(`hello ${req.url}`);
      ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
      const code = Number(url.searchParams.get("close"));
      if (code) setTimeout(() => ws.close(code, `bye ${code}`), 20);
    });
  });
  fakePort = await listen(fake);
  const dead = createServer();
  deadPort = await listen(dead);
  await new Promise((r) => dead.close(r));
});

after(async () => {
  stopMesh();
  server.close();
  server.closeAllConnections();
  fake.close();
  fake.closeAllConnections();
  rmSync(tmp, { recursive: true, force: true });
});

const getJson = async <T>(path: string): Promise<[number, T]> => {
  const res = await realFetch(`${base}${path}`);
  return [res.status, (await res.json()) as T];
};
const putJson = async <T>(path: string, body: unknown): Promise<[number, T]> => {
  const res = await realFetch(`${base}${path}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return [res.status, (await res.json()) as T];
};

/** A plain request on a NEW connection (so whois runs again), to the peer listener. */
function peerGet(path: string): Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }> {
  const info = listenerInfo()!;
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: info.port, path, agent: false }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Open a socket; resolve with its first message and close code, or the handshake's HTTP status. */
function wsTrip(url: string, send?: string): Promise<{ first?: string; code?: number; reason?: string; status?: number; error?: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let first: string | undefined;
    ws.on("message", (d) => {
      if (first === undefined) {
        first = d.toString();
        if (send) ws.send(send);
      }
    });
    ws.on("close", (code, reason) => resolve({ first, code, reason: reason.toString() }));
    ws.on("unexpected-response", (_req, res) => {
      resolve({ status: res.statusCode });
      ws.terminate();
    });
    ws.on("error", (err) => resolve({ error: err.message }));
  });
}

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

// ---- OFF --------------------------------------------------------------------------------------

describe("mesh OFF (no peers.json)", () => {
  test("nothing runs: no listener, no Tailscale call, no outbound request", async () => {
    assert.equal(listenerInfo(), null);
    const [s, info] = await getJson<MeshInfo>("/api/mesh");
    assert.equal(s, 200);
    assert.equal(info.enabled, false);
    assert.deepEqual([info.peers, info.sync, info.frontDoor, info.self.listen], [[], [], null, undefined]);
    assert.deepEqual(await getJson("/api/mesh/sessions"), [200, { peers: [] }]);
    const [, hello] = await getJson<MeshHello>("/api/mesh/hello");
    assert.equal(hello.protocol, ownProtocol());
    assert.equal(hello.nodeId, undefined);
    const [, settings] = await getJson<MeshSettings>("/api/mesh/settings");
    assert.deepEqual(settings.sync, { settings: true, themes: true, extensions: true, logins: true });
    await realFetch(`${base}/peer/b/api/health`);
    await wsTrip(`${wsBase}/peer/b/ws/chat?path=x`);
    assert.equal(identityCalls, 0);
    assert.equal(fetches, 0);
    assert.equal(listenerInfo(), null);
  });

  test("/peer/* and /api/peer/* answer exactly what an unknown path answers", async () => {
    for (const [mesh, other] of [
      ["/peer/b/api/health", "/nopeer/b/api/health"],
      ["/peer/b/ws/chat", "/nopeer/b/ws/chat"],
      ["/api/peer/hello", "/api/nopeer/hello"],
    ] as const) {
      const [a, b] = await Promise.all([app.request(mesh), app.request(other)]);
      assert.equal(a.status, b.status, mesh);
      assert.equal(await a.text(), await b.text(), mesh);
    }
    const [a, b] = await Promise.all([wsTrip(`${wsBase}/peer/b/ws/chat`), wsTrip(`${wsBase}/nopeer/ws/chat`)]);
    assert.deepEqual(a, b);
    assert.ok(a.error, "an unknown socket path is dropped, as before");
  });

  test("a settings write leaves the mesh off", async () => {
    const [s, settings] = await putJson<MeshSettings>("/api/mesh/settings", { hostLabel: "Host A", sync: { logins: false } });
    assert.equal(s, 200);
    assert.equal(settings.hostLabel, "Host A");
    assert.equal(settings.sync.logins, false);
    assert.equal(settings.sync.themes, true);
    const [, info] = await getJson<MeshInfo>("/api/mesh");
    assert.equal(info.enabled, false);
    assert.equal(info.self.label, "Host A");
    assert.equal(listenerInfo(), null);
    assert.equal(identityCalls, 0);
    assert.equal((await putJson("/api/mesh/settings", { frontDoor: "ftp://x" }))[0], 400);
  });
});

// ---- ON ---------------------------------------------------------------------------------------

describe("mesh ON", () => {
  before(async () => {
    const [s] = await putJson<MeshInfo>("/api/mesh/peers", {
      peers: [
        { id: "b", label: "B", nodeId: "nB", name: "127.0.0.1", url: `http://127.0.0.1:${fakePort}` },
        { id: "dead", nodeId: "nD", name: "127.0.0.1", url: `http://127.0.0.1:${deadPort}` },
      ],
    });
    assert.equal(s, 200);
    await waitFor(() => (listenerInfo()?.addresses.length ?? 0) > 0);
  });

  test("the peer listener binds the pinned address", () => {
    assert.deepEqual(listenerInfo()!.addresses, ["127.0.0.1"]);
    assert.ok(listenerInfo()!.port > 0);
  });

  test("the gate: a non-tailnet caller and a tailnet node outside peers.json get 403 + marker", async () => {
    for (const node of [null, "nStranger"]) {
      whoisNode = node;
      for (const path of ["/api/health", "/api/peer/hello"]) {
        const r = await peerGet(path);
        assert.equal(r.status, 403, `${node} ${path}`);
        assert.equal(r.headers["x-sova-mesh"], "refused");
        assert.deepEqual(JSON.parse(r.body), { error: "not a peer" });
      }
    }
  });

  test("a peer reaches /api/* and hello, never /api/mesh, /peer, /ext or the shell", async () => {
    whoisNode = "nB";
    assert.deepEqual(JSON.parse((await peerGet("/api/health")).body), { ok: true });
    const hello = JSON.parse((await peerGet("/api/peer/hello")).body) as MeshHello;
    assert.equal(hello.mesh, 1);
    assert.equal(hello.nodeId, "nA");
    for (const path of ["/api/mesh", "/api/mesh/peers", "/peer/b/api/health", "/ext/x/", "/", "/index.html"]) {
      assert.equal((await peerGet(path)).status, 404, path);
    }
  });

  test("peer listener WS: refused without whois, dispatched to Sova's own sockets with it", async () => {
    const port = listenerInfo()!.port;
    whoisNode = null;
    assert.deepEqual(await wsTrip(`ws://127.0.0.1:${port}/ws/watch?path=nope`), { status: 403 });
    whoisNode = "nB";
    const r = await wsTrip(`ws://127.0.0.1:${port}/ws/watch?path=nope`);
    assert.equal(r.code, 4404);
    assert.deepEqual(await wsTrip(`ws://127.0.0.1:${port}/ext/x/ws/y`), { status: 404 });
  });

  test("proxy REST: verbatim path + query + body; the peer's answer untouched", async () => {
    const res = await realFetch(`${base}/peer/b/api/echo?x=1&y=%2F`, { method: "POST", body: "hi" });
    assert.equal(res.status, 200);
    const echo = (await res.json()) as { method: string; url: string; body: string; fwd: string };
    assert.deepEqual([echo.method, echo.url, echo.body], ["POST", "/api/echo?x=1&y=%2F", "hi"]);
    assert.equal(echo.fwd, new URL(base).host);
    assert.equal((await realFetch(`${base}/peer/b/api/teapot`)).status, 418);
  });

  test("proxy REST: our own failures — unknown 404, down 502, gate refusal 403; a route's 403 passes", async () => {
    assert.deepEqual(await getJson("/peer/nope/api/x"), [404, { error: "Unknown peer" }]);
    assert.deepEqual(await getJson("/peer/dead/api/x"), [502, { error: "peer down", id: "dead" }]);
    assert.deepEqual(await getJson("/peer/b/api/gate-refused"), [403, { error: "peer refused", id: "b" }]);
    assert.deepEqual(await getJson("/peer/b/api/own-403"), [403, { error: "route says no" }]);
    assert.deepEqual(await getJson("/peer/b/ws/chat"), [426, { error: "WebSocket upgrade required" }]);
  });

  test("proxy WS: frames both ways, every close code mirrored exactly", async () => {
    for (const code of [1000, 4404, 4409, 4422, 4500]) {
      const r = await wsTrip(`${wsBase}/peer/b/ws/chat?path=p&close=${code}`, "ping");
      assert.equal(r.first, `hello /ws/chat?path=p&close=${code}`);
      assert.equal(r.code, code);
      assert.equal(r.reason, `bye ${code}`);
    }
  });

  test("proxy WS: down → HTTP 502, refused → 403, unknown → 404, all before any upgrade (never 4422)", async () => {
    assert.deepEqual(await wsTrip(`${wsBase}/peer/dead/ws/chat?path=p`), { status: 502 });
    assert.deepEqual(await wsTrip(`${wsBase}/peer/b/ws/chat?refuse=1`), { status: 403 });
    assert.deepEqual(await wsTrip(`${wsBase}/peer/nope/ws/chat`), { status: 404 });
  });

  test("the whole trip: proxy → peer listener → whois gate → this app", async () => {
    const port = listenerInfo()!.port;
    await putJson("/api/mesh/peers", {
      peers: [
        { id: "b", label: "B", nodeId: "nB", name: "127.0.0.1", url: `http://127.0.0.1:${fakePort}` },
        { id: "self", nodeId: "nSelf", name: "127.0.0.1", url: `http://127.0.0.1:${port}` },
      ],
    });
    whoisNode = "nSelf";
    assert.deepEqual(await getJson("/peer/self/api/health"), [200, { ok: true }]);
    const r = await wsTrip(`${wsBase}/peer/self/ws/watch?path=nope`);
    assert.equal(r.code, 4404);
    whoisNode = "nStranger";
    // A WS dial is always a new connection, so whois runs again (REST rides a kept-alive one).
    assert.deepEqual(await wsTrip(`${wsBase}/peer/self/ws/watch?path=nope`), { status: 403 });
  });

  test("GET /api/mesh: up / skewed / refused / down from the hello probe", async () => {
    await putJson("/api/mesh/peers", {
      peers: [
        { id: "b", label: "B", nodeId: "nB", name: "127.0.0.1", url: `http://127.0.0.1:${fakePort}`, priority: 2 },
        { id: "dead", nodeId: "nD", name: "127.0.0.1", url: `http://127.0.0.1:${deadPort}` },
      ],
    });
    const state = async () => {
      clearProbes();
      const [, info] = await getJson<MeshInfo>("/api/mesh");
      return Object.fromEntries(info.peers.map((p) => [p.id, p.state]));
    };
    fakeHello = "same";
    assert.deepEqual(await state(), { b: "up", dead: "down" });
    fakeHello = "other";
    assert.deepEqual(await state(), { b: "skewed", dead: "down" });
    fakeHello = "refused";
    assert.deepEqual(await state(), { b: "refused", dead: "down" });
    fakeHello = "same";
    const [, info] = await getJson<MeshInfo>("/api/mesh");
    assert.equal(info.enabled, true);
    assert.equal(info.self.nodeId, "nA");
    assert.equal(info.peers[0]!.priority, 2);
    assert.ok(info.peers[0]!.lastSeen);
    assert.equal(info.peers[1]!.lastSeen, null);
  });

  test("GET /api/mesh/sessions: grouped by peer; a peer that stops answering keeps its last list, stale", async () => {
    fakeSessions = [{ id: "s1", path: "/far/s1.jsonl", peer: "forged" }];
    const [, first] = await getJson<MeshSessions>("/api/mesh/sessions");
    assert.deepEqual(first.peers.map((p) => [p.id, p.state, p.sessions?.length ?? null, p.stale ?? false]), [
      ["b", "up", 1, false],
      ["dead", "down", null, false],
    ]);
    fakeSessions = "garbage";
    const [, second] = await getJson<MeshSessions>("/api/mesh/sessions");
    assert.deepEqual([second.peers[0]!.state, second.peers[0]!.stale, second.peers[0]!.sessions?.length], ["down", true, 1]);
    fakeSessions = [];
  });

  test("candidates: tailnet nodes, probed; peerId for known ones", async () => {
    tailnetPeers = [
      { nodeId: "nB", name: "127.0.0.1", online: true },
      { nodeId: "nOff", name: "off.lab", online: false },
    ];
    process.env.SOVA_PEER_PORT = String(fakePort); // candidates are probed on the default peer port
    try {
      const [s, list] = await getJson<MeshCandidate[]>("/api/mesh/candidates");
      assert.equal(s, 200);
      assert.deepEqual(
        list.map((c) => [c.nodeId, c.sova, c.peerId ?? null]),
        [
          ["nB", "yes", "b"],
          ["nOff", "no", null],
        ],
      );
    } finally {
      process.env.SOVA_PEER_PORT = "0";
    }
  });

  test("PUT peers resolves a name through LocalAPI; refuses unknown names, this host and bad input", async () => {
    tailnetPeers = [{ nodeId: "nC", name: "c.lab", online: true }];
    const keep = { id: "b", nodeId: "nB", name: "127.0.0.1", url: `http://127.0.0.1:${fakePort}` };
    const [s, info] = await putJson<MeshInfo>("/api/mesh/peers", { peers: [keep, { id: "c", name: "c" }] });
    assert.equal(s, 200);
    assert.deepEqual(
      info.peers.map((p) => [p.id, p.nodeId, p.name]),
      [
        ["b", "nB", "127.0.0.1"],
        ["c", "nC", "c.lab"],
      ],
    );
    assert.equal((await putJson("/api/mesh/peers", { peers: [{ id: "x", name: "ghost" }] }))[0], 400);
    tailnetPeers.push({ nodeId: "nA", name: "a.lab", online: true });
    assert.equal((await putJson("/api/mesh/peers", { peers: [{ id: "x", name: "a.lab" }] }))[0], 400);
    assert.equal((await putJson("/api/mesh/peers", { peers: [{ id: "Bad Id", nodeId: "n1", name: "x" }] }))[0], 400);
    assert.equal((await putJson("/api/mesh/peers", { nope: 1 }))[0], 400);
  });

  test("a malformed peers.json turns the mesh off and is never overwritten", async () => {
    writeFileSync(peersFile(), "{broken");
    const [, info] = await getJson<MeshInfo>("/api/mesh");
    assert.equal(info.enabled, false);
    assert.match(info.error ?? "", /not JSON/);
    assert.equal(listenerInfo(), null);
    assert.equal((await putJson("/api/mesh/peers", { peers: [] }))[0], 409);
    assert.equal((await putJson("/api/mesh/settings", { hostLabel: "x" }))[0], 409);
    rmSync(peersFile());
  });

  test("PUT peers [] turns the mesh off: the listener closes", async () => {
    await putJson("/api/mesh/peers", { peers: [{ id: "b", nodeId: "nB", name: "127.0.0.1", url: `http://127.0.0.1:${fakePort}` }] });
    await waitFor(() => (listenerInfo()?.addresses.length ?? 0) > 0);
    const port = listenerInfo()!.port;
    const calls = identityCalls;
    const [s, info] = await putJson<MeshInfo>("/api/mesh/peers", { peers: [] });
    assert.equal(s, 200);
    assert.equal(info.enabled, false);
    assert.equal(listenerInfo(), null);
    assert.equal(identityCalls, calls, "turning off calls no Tailscale");
    await assert.rejects(realFetch(`http://127.0.0.1:${port}/api/health`));
  });
});
