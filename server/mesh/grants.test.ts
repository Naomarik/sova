// Run: pnpm test -- server/mesh/grants.test.ts
// Per-peer grants (§mesh.peers/grants), in-process: this host's app built with nothing started, the
// peer listener's own gate (PeerGate, with the runtime's peerByNode and allows) fed in-process
// connections, a stub identity, and the other peers answered over the test wire. Every route a peer
// can reach has a class (the completeness check). Sockets on the real peer listener, a lowered grant
// cutting one, and a relayed browser over real hops: grants.integration.test.ts.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { MeshAccessView, MeshInfoView, MeshSessionsView } from "../../shared/mesh-access";
import { testApp } from "./app-test-fixtures";
import { inProcessPeerGate } from "./peer-gate-test-fixtures";
import { fakeWire } from "./peer-wire-test-fixtures";

const tmp = mkdtempSync(join(tmpdir(), "sova-grants-unit-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
mkdirSync(join(tmp, "agent", "sessions", "live"), { recursive: true });

const { setIdentity } = await import("./localapi");
setIdentity({
  status: async () => ({
    backendState: "Running",
    self: { nodeId: "nA", name: "a.lab", hostName: "a", os: "linux", online: true, tags: [], login: "me", addresses: ["127.0.0.1"] },
    peers: [],
  }),
  whois: async () => null,
});

const wire = fakeWire();
const app = await testApp();
const { mayShareWith, NotShared, peerByNode, peerFetch, stopMesh } = await import("./index");
const { accessFile, allows, classifyRequest, classifyUpgrade, clearDenied } = await import("./access");
const { clearProbes, ownProtocol } = await import("./hello");
const { clearPeerReach } = await import("./proxy");
// The mesh's link transfers probe tar when it starts: answered here, so no tar runs.
(await import("./links-transfer")).setTarAvailableForTest(true);

/** Who the next call on the peer gate comes from: a tailnet node, as whois would say, or nobody. */
let whoisNode: string | null = null;
const peer = inProcessPeerGate(
  { fetch: app.fetch, upgrade: (_req, socket) => socket.destroy(), allows: (p, need) => allows(p.nodeId, need) },
  () => (whoisNode ? peerByNode(whoisNode) : null),
);
const peerCall = peer.call;

// ---- the other peers, in-process: hello and session list answer as `fakeMode` says; /api/echo
// reports the headers a relayed request carried.
const FAKE = "http://127.0.0.1:47021";
let fakeMode: "open" | "denied" | "sessions-denied" = "open";
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
wire.serve(FAKE, (req) => {
  const url = new URL(req.url);
  const denied = () => json(403, { error: "not shared with this host" }, { "X-Sova-Mesh": "denied" });
  if (url.pathname === "/api/peer/hello") {
    if (fakeMode === "denied") return denied();
    return json(200, { mesh: 1, id: "f", label: "F", hostname: "f", version: "0", protocol: ownProtocol(), pi: "x", now: Date.now() });
  }
  if (url.pathname === "/api/sessions") return fakeMode === "open" ? json(200, [{ id: "s1", path: "/far/s1.jsonl" }]) : denied();
  const h = req.headers;
  return json(200, { fwd: h.get("x-forwarded-host"), relayed: h.get("x-sova-relayed"), origin: h.get("origin"), referer: h.get("referer"), ua: h.get("user-agent"), lang: h.get("accept-language"), xff: h.get("x-forwarded-for") });
});

after(() => {
  stopMesh();
  wire.restore();
  rmSync(tmp, { recursive: true, force: true });
});

const getJson = async <T>(path: string, headers: Record<string, string> = {}): Promise<[number, T]> => {
  const res = await app.request(path, { headers });
  return [res.status, (await res.json()) as T];
};
const putJson = async <T>(path: string, body: unknown): Promise<[number, T]> => {
  const res = await app.request(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return [res.status, (await res.json()) as T];
};

const grant = (peerId: string, g: unknown) => putJson<MeshAccessView>("/api/mesh/access", { peer: peerId, grant: g });
const accessDoc = () => JSON.parse(readFileSync(accessFile(), "utf8")) as { version: 1; peers: Record<string, { preset: string; logins?: string[] }> };

const PEERS = () => [
  { id: "b", label: "B", nodeId: "nB", name: "127.0.0.1", url: FAKE },
  { id: "f", label: "F", nodeId: "nF", name: "127.0.0.1", url: FAKE },
];

// ---- completeness: no route a peer reaches is left to the default ------------------------------

describe("classification", () => {
  test("every registered route a peer can reach has a class; none falls to the default", () => {
    const unclassified: string[] = [];
    let checked = 0;
    for (const r of app.routes) {
      // Middleware (app.use) and the /api 404 fallback are not routes of their own.
      if (r.method === "ALL") continue;
      if (!r.path.startsWith("/api/") || /^\/api\/mesh(?:\/|$)/.test(r.path)) continue;
      const concrete = r.path.replace(/:[^/]+/g, "x").replace(/\*/g, "x");
      checked++;
      if (classifyRequest(r.method, concrete).rule === "default") unclassified.push(`${r.method} ${r.path}`);
    }
    assert.ok(checked > 200, `only ${checked} routes enumerated`);
    assert.deepEqual(unclassified, [], "classify these in server/mesh/access.ts");
  });

  test("every socket and feed a peer can open has a class", () => {
    for (const [path, q] of [
      ["/ws/chat", "path=/x.jsonl"],
      ["/ws/watch", "path=/x.jsonl"],
      ["/ws/watch", "feed=sessions"],
      ["/ws/watch", "feed=llm"],
      ["/ws/watch", "claude=00000000-0000-0000-0000-000000000000"],
    ] as const) {
      assert.notEqual(classifyUpgrade(path, new URLSearchParams(q)).rule, "default", `${path}?${q}`);
    }
  });
});

describe("grants on the peer gate", () => {
  before(async () => {
    const [s] = await putJson("/api/mesh/peers", { peers: PEERS() });
    assert.equal(s, 200);
  });

  test("no mesh-access.json: a peers PUT without grants writes none and every peer has everything", async () => {
    assert.equal(existsSync(accessFile()), false);
    whoisNode = "nB";
    assert.equal((await peerCall("GET", "/api/peer/hello")).status, 200);
    assert.equal((await peerCall("GET", "/api/sessions")).status, 200);
    assert.equal(mayShareWith("b", "sync.logins"), true);
    const [, view] = await getJson<MeshAccessView>("/api/mesh/access");
    assert.equal(view.exists, false);
    assert.ok(view.peers.every((p) => Object.values(p.effective).every(Boolean) && p.logins === "all"));
  });

  test("pairing names a preset for a NEW peer only; one it doesn't name gets none (= full)", async () => {
    const [s] = await putJson("/api/mesh/peers", {
      peers: [...PEERS(), { id: "c", nodeId: "nC", name: "127.0.0.1" }, { id: "d", nodeId: "nD", name: "127.0.0.1" }],
      grants: { b: "none", c: "presence" },
    });
    assert.equal(s, 200);
    const doc = accessDoc();
    assert.deepEqual(doc.peers.nC, { preset: "presence" });
    assert.equal(doc.peers.nB, undefined, "b was paired already: its grant is not the PUT's to change");
    assert.equal(doc.peers.nD, undefined);
    // Unpairing drops the grant.
    await putJson("/api/mesh/peers", { peers: PEERS() });
    assert.equal(accessDoc().peers.nC, undefined);
    // A bad preset is refused before anything is written.
    assert.equal((await putJson("/api/mesh/peers", { peers: [...PEERS(), { id: "c", nodeId: "nC", name: "127.0.0.1" }], grants: { c: "root" } }))[0], 400);
  });

  test("presence: hello and details, nothing else; a denial is X-Sova-Mesh: denied, never refused (sockets: the integration file)", async () => {
    assert.equal((await grant("b", { preset: "presence" }))[0], 200);
    whoisNode = "nB";
    assert.equal((await peerCall("GET", "/api/peer/hello")).status, 200);
    assert.equal((await peerCall("GET", "/api/peer/details")).status, 200);
    for (const [m, p] of [
      ["GET", "/api/sessions"],
      ["GET", "/api/peer/sync/manifest"],
      ["GET", "/api/peer/credentials/manifest"],
      ["POST", "/api/peer/claude-pool/lend"],
      ["GET", "/api/peer/links/whoami"],
      ["PUT", "/api/settings"],
      ["GET", "/api/%73essions"],
    ] as const) {
      const r = await peerCall(m, p);
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal(r.marker, "denied", `${m} ${p}`);
    }
    // A node that is not a peer is still refused, not denied.
    whoisNode = "nStranger";
    assert.equal((await peerCall("GET", "/api/peer/hello")).marker, "refused");
  });

  test("none: hello itself is denied", async () => {
    await grant("b", { preset: "none" });
    whoisNode = "nB";
    const r = await peerCall("GET", "/api/peer/hello");
    assert.equal(r.status, 403);
    assert.equal(r.marker, "denied");
  });

  test("sessions: drive sessions, but no settings write, sync or pool (the llm feed: the integration file)", async () => {
    await grant("b", { preset: "sessions" });
    whoisNode = "nB";
    assert.equal((await peerCall("GET", "/api/sessions")).status, 200);
    assert.equal((await peerCall("GET", "/api/settings")).status, 200);
    assert.equal((await peerCall("PUT", "/api/settings", "{}")).marker, "denied");
    assert.equal((await peerCall("GET", "/api/peer/sync/manifest")).marker, "denied");
    assert.equal((await peerCall("POST", "/api/peer/claude-pool/doc", "{}")).marker, "denied");
    assert.equal((await peerCall("POST", "/api/peer/rename", "{}")).marker, "denied");
  });

  test("switches on top of a preset", async () => {
    await grant("b", { preset: "presence", caps: { "sync.themes": true } });
    whoisNode = "nB";
    assert.notEqual((await peerCall("GET", "/api/peer/sync/manifest")).marker, "denied");
    assert.equal((await peerCall("GET", "/api/peer/sync/extensions")).marker, "denied");
  });

  test("a hand edit that lowers a grant is enforced on the next call", async () => {
    await grant("b", { preset: "full" });
    writeFileSync(accessFile(), JSON.stringify({ version: 1, peers: { nB: { preset: "none" } } }));
    whoisNode = "nB";
    assert.equal((await peerCall("GET", "/api/peer/hello")).marker, "denied");
    await grant("b", null);
  });

  test("a broken mesh-access.json fails closed: hello only, for every peer, and the page says so", async () => {
    writeFileSync(accessFile(), "{broken");
    for (const node of ["nB", "nF"]) {
      whoisNode = node;
      assert.equal((await peerCall("GET", "/api/peer/hello")).status, 200, node);
      assert.equal((await peerCall("GET", "/api/peer/details")).marker, "denied", node);
      assert.equal((await peerCall("GET", "/api/sessions")).marker, "denied", node);
    }
    const [, view] = await getJson<MeshAccessView>("/api/mesh/access");
    assert.ok(view.error && /not JSON/.test(view.error));
    // It is never overwritten from the page.
    assert.equal((await grant("b", { preset: "full" }))[0], 409);
    assert.equal(readFileSync(accessFile(), "utf8"), "{broken");
    rmSync(accessFile());
  });

  test("/api/mesh/access: this host's own browser only; a peer or a relayed browser never reaches it", async () => {
    whoisNode = "nB";
    assert.equal((await peerCall("GET", "/api/mesh/access")).status, 404);
    assert.equal((await peerCall("PUT", "/api/mesh/access", JSON.stringify({ peer: "b", grant: { preset: "full" } }))).status, 404);
    assert.equal((await getJson("/api/mesh/access", { "X-Sova-Relayed": "1" }))[0], 404);
    const sent = wire.fetches;
    assert.equal((await app.request("/peer/b/api/mesh/access")).status, 404);
    assert.equal(wire.fetches, sent, "never forwarded");
    assert.equal((await getJson("/api/mesh/access"))[0], 200);
    assert.equal((await grant("nobody", { preset: "full" }))[0], 404);
    assert.equal((await grant("b", { preset: "everything" }))[0], 400);
  });
});

describe("this host's own calls", () => {
  test("what it doesn't grant a peer, it never sends it; reading the peer's own things still goes", async () => {
    await grant("b", { preset: "full", caps: { links: false, "sync.logins": false } });
    await assert.rejects(peerFetch("b", "/api/peer/links", { method: "POST", body: "{}" }), /not shared with b/);
    await assert.rejects(peerFetch("b", "/api/peer/credentials/manifest"), /not shared with b/);
    await assert.rejects(peerFetch("b", "/api/peer/claude-pool/doc"), /not shared with b/);
    assert.equal((await peerFetch("b", "/api/sessions")).status, 200);
    assert.equal(mayShareWith("b", "links"), false);
    assert.equal(mayShareWith("b", "sessions"), true);
    await grant("b", { preset: "presence" });
    await assert.rejects(peerFetch("b", "/api/peer/sync/manifest"), /not shared with b/);
    await assert.rejects(peerFetch("b", "/api/peer/sync/extensions"), /not shared with b/);
    await grant("b", { preset: "none" });
    await assert.rejects(peerFetch("b", "/api/peer/label", { method: "POST", body: "{}" }), /not shared with b/);
    await grant("b", null);
  });

  test("reading a peer about itself or its session by id is the peer's grant, never this host's; link sends stay gated", async () => {
    await grant("b", { preset: "none" });
    // The link identity probe and the transcript read leave whatever this host grants b.
    assert.equal((await peerFetch("b", "/api/peer/links/whoami")).status, 200);
    assert.equal((await peerFetch("b", "/api/peer/links/read?id=s1&items=5")).status, 200);
    // What this host sends b on its own initiative does not, and says why: withheld, not down.
    for (const path of ["/api/peer/links", "/api/peer/links/lk_0123456789abcdef/message", "/api/peer/links/lk_0123456789abcdef/end", "/api/peer/links/lk_0123456789abcdef/offers"]) {
      await assert.rejects(peerFetch("b", path, { method: "POST", body: "{}" }), (err: unknown) => err instanceof NotShared && /not shared with b/.test(err.message), path);
    }
    await assert.rejects(peerFetch("b", "/api/peer/links/whoami/x"), NotShared);
    await assert.rejects(peerFetch("b", "/api/peer/links/readx"), NotShared);
    await grant("b", null);
  });

  test("serving: the transcript read needs this host's sessions grant, links alone is not enough", async () => {
    await grant("b", { preset: "presence", caps: { links: true } });
    whoisNode = "nB";
    const read = await peerCall("GET", "/api/peer/links/read?id=nope");
    assert.equal(read.status, 403);
    assert.equal(read.marker, "denied");
    assert.equal((await peerCall("GET", "/api/peer/links/whoami")).status, 200);
    await grant("b", { preset: "presence", caps: { sessions: true } });
    const allowed = await peerCall("GET", "/api/peer/links/read?id=nope");
    assert.notEqual(allowed.marker, "denied");
    assert.equal(allowed.status, 404); // no such session: the route ran
    await grant("b", null);
  });

  test("a relayed browser request to a peer this host restricts carries nothing of this host or the browser", async () => {
    clearPeerReach();
    const headers = { Host: "a.lab:4800", Origin: "http://a.lab:4800", Referer: "http://a.lab:4800/", "User-Agent": "sova-test-agent", "Accept-Language": "en-GB", "X-Forwarded-For": "198.51.100.7" };
    const full = (await (await app.request("/peer/b/api/echo", { headers })).json()) as Record<string, string | null>;
    assert.equal(full.fwd, "a.lab:4800");
    assert.equal(full.ua, "sova-test-agent");
    await grant("b", { preset: "sessions" });
    const scrubbed = (await (await app.request("/peer/b/api/echo", { headers })).json()) as Record<string, string | null>;
    assert.equal(scrubbed.fwd, "peer");
    assert.equal(scrubbed.relayed, "1");
    for (const k of ["origin", "referer", "lang", "xff"]) assert.equal(scrubbed[k], null, k);
    assert.equal(scrubbed.ua, "peer", "a fixed user agent, never the browser's or the runtime's");
    await grant("b", null);
  });
});

describe("a peer that hides from this host", () => {
  test("hello denied: hidden, not down and not refused", async () => {
    clearProbes();
    fakeMode = "denied";
    const [, info] = await getJson<MeshInfoView>("/api/mesh");
    const f = info.peers.find((p) => p.id === "f")!;
    assert.equal(f.state, "hidden");
    fakeMode = "open";
  });

  test("sessions denied: the list shows it hidden with no rows, none kept from before", async () => {
    clearDenied();
    fakeMode = "open";
    const [, first] = await getJson<MeshSessionsView>("/api/mesh/sessions");
    assert.equal(first.peers.find((p) => p.id === "f")?.state, "up");
    fakeMode = "sessions-denied";
    const [, then] = await getJson<MeshSessionsView>("/api/mesh/sessions");
    const row = then.peers.find((p) => p.id === "f")!;
    assert.equal(row.state, "hidden");
    assert.equal(row.sessions, undefined);
    assert.equal(row.stale, undefined);
    // The page learns what the peer keeps from this host from its answer, never from a claim.
    const [, view] = await getJson<MeshAccessView>("/api/mesh/access");
    assert.deepEqual(view.peers.find((p) => p.id === "f")?.theirs?.denied, ["sessions"]);
    fakeMode = "open";
  });
});
