// Run: pnpm exec tsx --test server/mesh/details.test.ts
// Per-host details and rename against a throwaway PI_CODING_AGENT_DIR (removed after), the server
// on an ephemeral port, a stub identity provider, a fake peer on loopback that records what it is
// told, and this server's own peer listener on 127.0.0.1 so peer routes go through the real gate.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { HostDetails, HostRenameResult, MeshDetails } from "../../shared/mesh-details";
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
    if (url.pathname === "/api/peer/rename" || url.pathname === "/api/peer/label") told.push({ path: url.pathname, body });
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
    ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
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
    req.setTimeout(8000, () => req.destroy(new Error(`no answer within 8 s: ${path}`)));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
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
    ] as const) {
      const [st, body] = await call(method, path, method === "GET" ? undefined : { id: "x", label: "y", labelAt: 1 });
      assert.equal(st, st0, `${method} ${path}`);
      assert.deepEqual(body, unknown, `${method} ${path}`);
    }
    assert.equal(identityCalls, 0);
    assert.equal(fetches, 0);
  });

  test("a rename in Settings is stamped with the mesh off too (it spreads once paired), and calls no one", async () => {
    const t0 = Date.now();
    const [st] = await call("PUT", "/api/mesh/settings", { hostLabel: "Before pairing" });
    assert.equal(st, 200);
    const self = peersDoc().self;
    assert.equal(self.label, "Before pairing");
    assert.ok(self.labelAt >= t0);
    await call("PUT", "/api/mesh/settings", { sync: { themes: true } });
    assert.equal(peersDoc().self.labelAt, self.labelAt, "another setting keeps the stamp");
    assert.equal(fetches, 0);
    assert.equal(identityCalls, 0);
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

  test("a peer written before dates were recorded says so (null), not a date", async () => {
    const doc = peersDoc();
    delete doc.peers[0].pairedAt;
    writeFileSync(peersFile(), JSON.stringify(doc));
    fresh();
    const [, d] = await call<MeshDetails>("GET", "/api/mesh/details");
    assert.equal(d.hosts[1]!.pairedAt, null);
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

  test("/api/peer/label renames the CALLER's entry only, and only with a newer stamp", async () => {
    whoisNode = "nB";
    let r = await peerCall("POST", "/api/peer/label", { label: "Bee", labelAt: 1_000, nodeId: "nC", id: "c" });
    assert.equal(r.status, 200);
    let doc = peersDoc();
    assert.equal(doc.peers.find((p: { id: string }) => p.id === "b").label, "Bee");
    assert.equal(doc.peers.find((p: { id: string }) => p.id === "c").label, "c", "a body id never picks the entry");
    const mtime = statSync(peersFile()).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    r = await peerCall("POST", "/api/peer/label", { label: "Older", labelAt: 999 });
    assert.equal(r.status, 200);
    doc = peersDoc();
    assert.equal(doc.peers.find((p: { id: string }) => p.id === "b").label, "Bee", "an older name never wins");
    assert.equal(statSync(peersFile()).mtimeMs, mtime, "and nothing is written");
    for (const bad of [{ label: "", labelAt: 2_000 }, { label: "x".repeat(81), labelAt: 2_000 }, { label: "ok" }, { label: "ok", labelAt: -1 }]) {
      assert.equal((await peerCall("POST", "/api/peer/label", bad)).status, 400, JSON.stringify(bad));
    }
    whoisNode = null;
    assert.equal((await peerCall("POST", "/api/peer/label", { label: "Evil", labelAt: 9_999 })).status, 403);
  });

  test("a name typed here for a peer keeps its stamp: the peer's same name again doesn't replace it, a newer rename does", async () => {
    const list = peersDoc().peers.map((p: { id: string; nodeId: string; dnsName: string; url?: string; label: string }) => ({
      id: p.id, nodeId: p.nodeId, name: p.dnsName, url: p.url, label: p.id === "b" ? "My phone" : p.label,
    }));
    await call("PUT", "/api/mesh/peers", { peers: list });
    let b = peersDoc().peers.find((p: { id: string }) => p.id === "b");
    assert.equal(b.label, "My phone");
    assert.equal(b.labelAt, 1_000, "the stamp stays as it was");
    whoisNode = "nB";
    assert.equal((await peerCall("POST", "/api/peer/label", { label: "Bee", labelAt: 1_000 })).status, 200);
    b = peersDoc().peers.find((p: { id: string }) => p.id === "b");
    assert.equal(b.label, "My phone", "its peer-up announce of the same name leaves the user's name");
    assert.equal((await peerCall("POST", "/api/peer/label", { label: "Bee 2", labelAt: 1_001 })).status, 200);
    assert.equal(peersDoc().peers.find((p: { id: string }) => p.id === "b").label, "Bee 2", "a real rename wins");
  });

  test("a stamp from a clock far ahead is kept as a day ahead: it can't lock the name, and the same name again writes nothing", async () => {
    const before = readFileSync(peersFile(), "utf8");
    whoisNode = "nB";
    const far = Date.now() + 10 * 365 * 86_400_000;
    assert.equal((await peerCall("POST", "/api/peer/label", { label: "From the future", labelAt: far })).status, 200);
    let b = peersDoc().peers.find((p: { id: string }) => p.id === "b");
    assert.equal(b.label, "From the future");
    assert.ok(b.labelAt <= Date.now() + 86_400_000, "kept at most a day ahead");
    const mtime = statSync(peersFile()).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await peerCall("POST", "/api/peer/label", { label: "From the future", labelAt: far })).status, 200);
    assert.equal(statSync(peersFile()).mtimeMs, mtime, "its peer-up announce of the same name writes nothing");
    // Its clock is right again and its stamps restarted (a fresh peers.json there): two days ahead is past the kept stamp.
    assert.equal((await peerCall("POST", "/api/peer/label", { label: "Fixed clock", labelAt: Date.now() + 2 * 86_400_000 })).status, 200);
    b = peersDoc().peers.find((p: { id: string }) => p.id === "b");
    assert.equal(b.label, "Fixed clock");
    whoisNode = null;
    writeFileSync(peersFile(), before); // the later tests start from b's real stamp
  });

  test("a host's details carry each sync category's state, never its error text", async () => {
    onSyncStatus(() => [{ category: "themes", enabled: true, state: "error", lastAt: null, error: "EACCES: /somewhere/private/themes" }]);
    try {
      whoisNode = "nB";
      const r = await peerCall("GET", "/api/peer/details");
      assert.equal(r.status, 200);
      const cats = (JSON.parse(r.body) as HostDetails).sync.categories;
      assert.deepEqual(cats, [{ category: "themes", enabled: true, state: "error", lastAt: null }]);
      assert.doesNotMatch(r.body, /somewhere/);
    } finally {
      onSyncStatus(() => []);
      whoisNode = null;
    }
  });

  test("renaming this host stamps it and tells every peer", async () => {
    told.length = 0;
    const [st, res] = await call<HostRenameResult>("PUT", "/api/mesh/label", { id: peersDoc().self.id, label: "  Laptop  " });
    assert.equal(st, 200);
    assert.equal(res.label, "Laptop");
    const self = peersDoc().self;
    assert.equal(self.label, "Laptop");
    assert.equal(typeof self.labelAt, "number");
    assert.deepEqual(told, [{ path: "/api/peer/label", body: { label: "Laptop", labelAt: self.labelAt } }]);
    assert.deepEqual(res.told.find((t) => t.id === "b"), { id: "b", ok: true });
    assert.equal(res.told.find((t) => t.id === "c")!.ok, false, "a down peer is reported, not hidden");
  });

  test("a peer that was up and missed a rename hears it when it answers again, with no page open meanwhile", async () => {
    fresh();
    await call("GET", "/api/mesh"); // b is up here
    fakeAway = true;
    await call("PUT", "/api/mesh/label", { id: peersDoc().self.id, label: "Renamed while b was away" });
    fakeAway = false;
    told.length = 0;
    fresh();
    await call("GET", "/api/mesh"); // b answers again
    await waitFor(() => told.some((t) => t.path === "/api/peer/label"));
    assert.deepEqual(told.find((t) => t.path === "/api/peer/label")!.body, { label: "Renamed while b was away", labelAt: peersDoc().self.labelAt });
  });

  test("Settings → Mesh: a new name goes out like one made here; another setting doesn't", async () => {
    told.length = 0;
    await call("PUT", "/api/mesh/settings", { sync: { themes: false } });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(told.length, 0, "a sync toggle tells no one a name");
    await call("PUT", "/api/mesh/settings", { hostLabel: "Desk" });
    await waitFor(() => told.length > 0);
    assert.deepEqual(told[0]!.body, { label: "Desk", labelAt: peersDoc().self.labelAt });
  });

  test("renaming a peer asks it, and takes its answer here", async () => {
    told.length = 0;
    const [st, res] = await call<HostRenameResult>("PUT", "/api/mesh/label", { id: "b", label: "Phone" });
    assert.equal(st, 200);
    assert.deepEqual(told, [{ path: "/api/peer/rename", body: { label: "Phone" } }]);
    assert.equal(res.label, "Phone");
    const b = peersDoc().peers.find((p: { id: string }) => p.id === "b");
    assert.equal(b.label, "Phone");
    assert.equal(b.labelAt, 5_000);
    assert.equal(b.id, "b", "the id never changes");
    fakeDetails = "old";
    const [st2, err] = await call<{ error: string }>("PUT", "/api/mesh/label", { id: "b", label: "Nope" });
    assert.equal(st2, 501);
    assert.match(err.error, /older build/);
    fakeDetails = "ok";
    assert.equal((await call("PUT", "/api/mesh/label", { id: "c", label: "Gone" }))[0], 502, "a down host");
    assert.equal((await call("PUT", "/api/mesh/label", { id: "zz", label: "Who" }))[0], 404);
    assert.equal((await call("PUT", "/api/mesh/label", { id: "b", label: " " }))[0], 400);
  });

  test("/api/peer/rename: a peer renames this host, which then tells its peers", async () => {
    told.length = 0;
    whoisNode = "nB";
    const r = await peerCall("POST", "/api/peer/rename", { label: "Named by B", id: "other" });
    assert.equal(r.status, 200);
    const self = peersDoc().self;
    assert.equal(self.label, "Named by B");
    assert.deepEqual(JSON.parse(r.body), { label: "Named by B", labelAt: self.labelAt });
    await waitFor(() => told.some((t) => t.path === "/api/peer/label"));
    assert.deepEqual(told.find((t) => t.path === "/api/peer/label")!.body, { label: "Named by B", labelAt: self.labelAt });
    assert.equal((await peerCall("POST", "/api/peer/rename", { label: "x".repeat(81) })).status, 400);
    whoisNode = null;
    assert.equal((await peerCall("POST", "/api/peer/rename", { label: "Evil" })).status, 403);
    assert.equal((await call("POST", "/api/peer/rename", { label: "Browser" }))[0], 404, "never from the main listener");
  });

  test("a new name's stamp is always past the last one, even when this host's clock is behind it", async () => {
    const future = Date.now() + 10 * 365 * 86_400_000;
    const doc = peersDoc();
    doc.self.labelAt = future;
    writeFileSync(peersFile(), JSON.stringify(doc));
    await call("PUT", "/api/mesh/label", { id: doc.self.id, label: "Clock behind" });
    const first = peersDoc().self.labelAt as number;
    assert.ok(first > future, "the rename in the dialog");
    await call("PUT", "/api/mesh/settings", { hostLabel: "Clock still behind" });
    assert.ok((peersDoc().self.labelAt as number) > first, "the rename in Settings");
  });

  test("a peers.json broken by hand between the checks is the plain 404, not a crash", async () => {
    const good = readFileSync(peersFile(), "utf8");
    // The mesh was on at the last read; the file breaks before this request reads it again.
    writeFileSync(peersFile(), "{ not json");
    const [st, body] = await call("GET", "/api/mesh/details");
    assert.equal(st, 404);
    assert.deepEqual(body, { error: "Not found" });
    writeFileSync(peersFile(), good);
    assert.equal((await call("GET", "/api/mesh"))[0], 200);
  });
});
