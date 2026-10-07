// Run: node scripts/run-tests.mjs server/mesh/details.integration.test.ts
// Per-host details against the real server and peer listener: a throwaway PI_CODING_AGENT_DIR
// (removed after), the server on an ephemeral port, a stub identity provider, a fake peer on
// loopback, and this server's own peer listener on 127.0.0.1: nothing called while the mesh is off,
// one real round trip, and the peer route through the real gate. Every rule in-process: details.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { HostBrowserAccessResult, HostDetails, HostRenameResult, MeshDetails } from "../../shared/mesh-details";
import type { MeshFrontDoor } from "../../shared/mesh-local";
import type { MeshHello } from "../../shared/protocol";

const tmp = mkdtempSync(join(tmpdir(), "sova-details-test-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
process.env.PORT = "0";
process.env.SOVA_PEER_HOST = "127.0.0.1";
process.env.SOVA_PEER_PORT = "0";
mkdirSync(join(tmp, "agent", "sessions", "live"), { recursive: true });

const { setIdentity } = await import("./localapi");
let identityCalls = 0;
let whoisNode: string | null = null;
setIdentity({
  status: async () => {
    identityCalls++;
    return {
      backendState: "Running",
      self: { nodeId: "nA", name: "a.lab", hostName: "a", os: "linux", online: true, tags: [], login: "me", addresses: ["127.0.0.1"] },
      peers: [],
    };
  },
  whois: async () => {
    identityCalls++;
    return whoisNode ? { nodeId: whoisNode, name: "x", tags: [], login: "me" } : null;
  },
});

const realFetch = globalThis.fetch;
let fetches = 0;
globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
  fetches++;
  return realFetch(...args);
}) as typeof fetch;

const { server } = await import("../index");
const { listenerInfo, onSyncStatus, stopMesh } = await import("./index");
const { AUTH_COOKIE, sovaToken } = await import("../auth");
// Main-listener calls pass its gate as a browser's would (with the cookie); the peer listener's never ask.
const AUTH = { Cookie: `${AUTH_COOKIE}=${sovaToken()}` };
const { clearProbes, ownProtocol } = await import("./hello");
const { clearPeerReach } = await import("./proxy");
const { peersFile, readPeers } = await import("./peers");

let base = "";

// ---- the fake peer ----------------------------------------------------------------------------

let fake: Server;
let fakePort = 0;
let deadPort = 0;
let fakeDetails: "ok" | "old" = "ok";
let fakeLabel = "B";
/** What the fake peer says about its browser address; undefined: an older build that doesn't say. */
let fakeBrowser: boolean | undefined;
/** The stamp the fake peer's details carry with it; undefined: none. */
let fakeBrowserAt: number | undefined;
/** The fake peer drops every connection, as a stopped host does. */
let fakeAway = false;
const told: Array<{ path: string; body: unknown }> = [];

const fakeHostDetails = (): HostDetails => ({
  details: 1,
  id: "b",
  label: fakeLabel,
  now: Date.now(),
  identity: { hostname: "b", addresses: [], platform: "android", osRelease: "x", arch: "arm64", device: "phone" },
  versions: { sova: "0", pi: "x", node: "v0", protocol: ownProtocol() },
  uptime: { process: 1, machine: 2 },
  resources: { cores: 8, memory: { total: 2, available: 1 }, batteryHint: "termux-api" },
  activity: { sessions: 3, turnsRunning: 0, workers: 0 },
  sync: { categories: [] },
  ...(fakeBrowser !== undefined ? { browserAccess: fakeBrowser } : {}),
  ...(fakeBrowserAt !== undefined ? { browserAccessAt: fakeBrowserAt } : {}),
});

before(async () => {
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", r)));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  fake = createServer(async (req: IncomingMessage, res) => {
    if (fakeAway) return req.socket.destroy();
    const url = new URL(req.url ?? "/", "http://x");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    if (url.pathname === "/api/peer/hello") {
      const hello: MeshHello = { mesh: 1, id: "b", label: fakeLabel, hostname: "b", version: "0", protocol: ownProtocol(), pi: "x", now: 1 };
      return json(200, hello);
    }
    if (fakeDetails === "old") return json(404, { error: "Not found" });
    if (url.pathname === "/api/peer/details") return json(200, fakeHostDetails());
    if (["/api/peer/rename", "/api/peer/label", "/api/peer/browser-access", "/api/peer/set-browser-access"].includes(url.pathname)) told.push({ path: url.pathname, body });
    if (url.pathname === "/api/peer/set-browser-access") {
      fakeBrowser = (body as { browserAccess: boolean }).browserAccess;
      return json(200, { browserAccess: fakeBrowser });
    }
    if (url.pathname === "/api/peer/browser-access") return json(200, { ok: true });
    if (url.pathname === "/api/peer/rename") {
      fakeLabel = (body as { label: string }).label;
      return json(200, { label: fakeLabel, labelAt: 5_000 });
    }
    if (url.pathname === "/api/peer/label") return json(200, { ok: true });
    json(404, { error: "Not found" });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  fakePort = (fake.address() as { port: number }).port;
  const dead = createServer();
  await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
  deadPort = (dead.address() as { port: number }).port;
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

const call = async <T>(method: string, path: string, body?: unknown): Promise<[number, T]> => {
  const res = await realFetch(`${base}${path}`, {
    method,
    ...(body !== undefined ? { headers: { "Content-Type": "application/json", ...AUTH }, body: JSON.stringify(body) } : { headers: AUTH }),
  });
  return [res.status, (await res.json()) as T];
};

/** A request on a NEW connection to the peer listener (so whois runs for it). */
function peerCall(method: string, path: string, body?: unknown): Promise<{ status: number; body: string }> {
  const info = listenerInfo()!;
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: info.port, path, method, agent: false, headers: { "Content-Type": "application/json" } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode!, body: text }));
    });
    req.on("error", reject);
    req.setTimeout(15_000, () => req.destroy(new Error(`no answer within 15 s: ${path}`)));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function waitFor(check: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const peersDoc = () => JSON.parse(readFileSync(peersFile(), "utf8"));
const fresh = () => {
  clearProbes();
  clearPeerReach();
};

describe("mesh off", () => {
  test("every details route is the plain /api 404, with no Tailscale call and no fetch", async () => {
    const [st0, unknown] = await call("GET", "/api/no-such-route");
    for (const [method, path] of [
      ["GET", "/api/mesh/details"],
      ["PUT", "/api/mesh/label"],
      ["GET", "/api/peer/details"],
      ["POST", "/api/peer/rename"],
      ["POST", "/api/peer/label"],
      ["PUT", "/api/mesh/browser-access"],
      ["POST", "/api/peer/browser-access"],
      ["POST", "/api/peer/set-browser-access"],
    ] as const) {
      const [st, body] = await call(method, path, method === "GET" ? undefined : { id: "x", label: "y", labelAt: 1 });
      assert.equal(st, st0, `${method} ${path}`);
      assert.deepEqual(body, unknown, `${method} ${path}`);
    }
    assert.equal(identityCalls, 0);
    assert.equal(fetches, 0);
  });

});

describe("mesh on", () => {
  test("pairing stamps pairedAt on a new peer and keeps it when the list is re-sent", async () => {
    const t0 = Date.now();
    const [st] = await call("PUT", "/api/mesh/peers", { peers: [{ id: "b", nodeId: "nB", name: "b.lab", url: `http://127.0.0.1:${fakePort}` }] });
    assert.equal(st, 200);
    await waitFor(() => (listenerInfo()?.addresses.length ?? 0) > 0);
    const first = peersDoc().peers[0].pairedAt as number;
    assert.ok(first >= t0 && first <= Date.now());
    await new Promise((r) => setTimeout(r, 5));
    await call("PUT", "/api/mesh/peers", {
      peers: [
        { id: "b", nodeId: "nB", name: "b.lab", url: `http://127.0.0.1:${fakePort}` },
        { id: "c", nodeId: "nC", name: "c.lab", url: `http://127.0.0.1:${deadPort}` },
      ],
    });
    const doc = peersDoc();
    assert.equal(doc.peers[0].pairedAt, first, "an existing peer keeps its date");
    assert.ok(doc.peers[1].pairedAt > first, "a new one gets its own");
  });

  test("GET /api/mesh/details: this host first, a peer's own answer, a down peer, and an older build", async () => {
    fresh();
    const [st, d] = await call<MeshDetails>("GET", "/api/mesh/details");
    assert.equal(st, 200);
    const [self, b, c] = d.hosts;
    assert.equal(self!.self, true);
    assert.equal(self!.state, "self");
    assert.equal(self!.details!.versions.protocol, ownProtocol());
    assert.equal(self!.details!.versions.node, process.version);
    assert.equal(self!.details!.identity.dnsName, "a.lab");
    assert.equal(typeof self!.details!.resources.cores, "number");
    assert.equal(b!.id, "b");
    assert.equal(b!.state, "up");
    assert.equal(b!.details!.label, "B");
    assert.equal(typeof b!.latencyMs, "number");
    assert.equal(typeof b!.pairedAt, "number");
    assert.deepEqual(b!.open, { kind: "through" }, "a phone with no address of its own is opened through this host");
    assert.equal(c!.state, "down");
    assert.equal(c!.unavailable, "down");
    assert.equal(c!.details, undefined);
    fakeDetails = "old";
    fresh();
    const [, d2] = await call<MeshDetails>("GET", "/api/mesh/details");
    assert.equal(d2.hosts[1]!.unavailable, "update");
    assert.equal(d2.hosts[1]!.details, undefined);
    fakeDetails = "ok";
  });

  test("/api/peer/details: 404 on the main listener, 403 for a non-peer, the host's own answer for a peer", async () => {
    const [st] = await call("GET", "/api/peer/details");
    assert.equal(st, 404);
    whoisNode = null;
    assert.equal((await peerCall("GET", "/api/peer/details")).status, 403);
    whoisNode = "nB";
    const r = await peerCall("GET", "/api/peer/details");
    assert.equal(r.status, 200);
    const d = JSON.parse(r.body) as HostDetails;
    assert.equal(d.details, 1);
    assert.equal(d.id, readPeers().ok && (readPeers() as { config: { self: { id: string } } }).config.self.id);
    assert.doesNotMatch(r.body, new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no path of this host");
  });

  const selfId = () => peersDoc().self.id as string;
  const peerB = () => peersDoc().peers.find((p: { id: string }) => p.id === "b");
  const upstreams = (fd: MeshFrontDoor) => /\treverse_proxy (.*) \{/.exec(fd.caddyfile)![1]!.split(" ");

});
