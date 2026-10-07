// Run: pnpm test -- server/mesh/mesh.test.ts
// The mesh's routes on this host's own app, in-process (§mesh/peers): built with nothing started
// (no listener, no peer listener), a stub identity provider, and tailnet peers answered over an
// in-process wire (peer-wire-test-fixtures.ts): settings, peers, front door and login-kind
// validation, the hello probe's states, the session lists, the /peer proxy's own answers. The peer
// listener, the gate, real hops (sockets, WebSockets, blackholed and wedged peers) and revocation:
// mesh.integration.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { MeshLocalSettings } from "../../shared/mesh-local";
import type { FrontDoorConfig, MeshCandidate, MeshHello, MeshInfo, MeshSessions, MeshSettings } from "../../shared/protocol";
import { testApp } from "./app-test-fixtures";
import { fakeWire } from "./peer-wire-test-fixtures";

const tmp = mkdtempSync(join(tmpdir(), "sova-mesh-unit-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
mkdirSync(join(tmp, "agent", "sessions", "live"), { recursive: true });

// Every LocalAPI call goes through this stub; OFF, it must never be called.
const { setIdentity } = await import("./localapi");
let identityCalls = 0;
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
    return null;
  },
});

const wire = fakeWire();
const app = await testApp();
const { listenerInfo, meshApi, stopMesh } = await import("./index");
const hookLog: string[] = [];
meshApi.onMeshStart(() => hookLog.push("start"));
meshApi.onMeshStop(() => hookLog.push("stop"));
meshApi.onPeerUp((id) => hookLog.push(`up:${id}`));
const settingsLog: string[] = [];
meshApi.onSettingsChange((s) => settingsLog.push(s.hostLabel));
const { clearProbes, ownProtocol } = await import("./hello");
const { peersFile } = await import("./peers");

// ---- the fake peer, in-process ------------------------------------------------------------------

const B = "http://127.0.0.1:47001";
const DEAD = "http://127.0.0.1:47002";
let fakeHello: "same" | "other" | "refused" = "same";
let fakeSessions: unknown = [{ id: "s1", path: "/far/s1.jsonl" }];
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
wire.serve(B, async (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/api/peer/hello") {
    if (fakeHello === "refused") return json(403, { error: "not a peer" }, { "X-Sova-Mesh": "refused" });
    const hello: MeshHello = { mesh: 1, id: "b", label: "B", hostname: "b", version: "0", protocol: fakeHello === "same" ? ownProtocol() : "0000", pi: "x", now: 1 };
    return json(200, hello);
  }
  if (url.pathname === "/api/sessions") return json(200, fakeSessions);
  if (url.pathname === "/api/gate-refused") return json(403, { error: "not a peer" }, { "X-Sova-Mesh": "refused" });
  if (url.pathname === "/api/own-403") return json(403, { error: "route says no" });
  if (url.pathname === "/api/sets-cookie") return json(200, { ok: true }, { "Set-Cookie": "planted=1; Path=/" });
  const h = req.headers;
  return json(url.pathname === "/api/teapot" ? 418 : 200, { method: req.method, url: `${url.pathname}${url.search}`, body: await req.text(), fwd: h.get("x-forwarded-host"), relayed: h.get("x-sova-relayed"), cookie: h.get("cookie"), token: h.get("x-sova-token"), authorization: h.get("authorization") });
});
wire.down(DEAD);

after(() => {
  stopMesh();
  wire.restore();
  rmSync(tmp, { recursive: true, force: true });
});

const call = async <T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<[number, T]> => {
  const res = await app.request(path, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
  return [res.status, (await res.json()) as T];
};
const getJson = <T>(path: string) => call<T>("GET", path);
const putJson = <T>(path: string, body: unknown) => call<T>("PUT", path, body);

const peersB = { id: "b", label: "B", nodeId: "nB", name: "127.0.0.1", url: B };
const peersDead = { id: "dead", nodeId: "nD", name: "127.0.0.1", url: DEAD };

// ---- OFF --------------------------------------------------------------------------------------

describe("mesh OFF (no peers.json)", () => {
  test("/peer/* and /api/peer/* answer exactly what an unknown path answers (REST; sockets: the integration file)", async () => {
    for (const [mesh, other] of [
      ["/peer/b/api/health", "/nopeer/b/api/health"],
      ["/peer/b/ws/chat", "/nopeer/b/ws/chat"],
      ["/api/peer/hello", "/api/nopeer/hello"],
      ["/api/peer/credentials/manifest", "/api/nopeer/credentials/manifest"],
      ["/api/peer/credentials/entry?key=pi:x", "/api/nopeer/credentials/entry?key=pi:x"],
    ] as const) {
      const [a, b] = await Promise.all([app.request(mesh), app.request(other)]);
      assert.equal(a.status, b.status, mesh);
      assert.equal(await a.text(), await b.text(), mesh);
    }
    assert.equal(wire.fetches, 0, "nothing went out");
  });

  test("a settings write leaves the mesh off", async () => {
    const [s, settings] = await putJson<MeshSettings>("/api/mesh/settings", { hostLabel: "Host A", sync: { logins: false } });
    assert.equal(s, 200);
    assert.equal(settings.hostLabel, "Host A");
    assert.equal(settings.sync.logins, false);
    assert.equal(settings.sync.themes, true);
    assert.deepEqual(settingsLog, ["Host A"], "onSettingsChange fires after the write");
    const [, info] = await getJson<MeshInfo>("/api/mesh");
    assert.equal(info.enabled, false);
    assert.equal(info.self.label, "Host A");
    assert.equal(listenerInfo(), null);
    assert.equal(identityCalls, 0);
    assert.equal((await putJson("/api/mesh/settings", { frontDoor: "ftp://x" }))[0], 400);
    assert.deepEqual(settingsLog, ["Host A"], "not after a refused write");
  });
});

// ---- ON ---------------------------------------------------------------------------------------

describe("mesh ON", () => {
  before(async () => {
    const [s] = await putJson<MeshInfo>("/api/mesh/peers", { peers: [peersB, peersDead] });
    assert.equal(s, 200);
    // The PUT answered with a probed MeshInfo: b came up, dead didn't. Nothing listens (nothing was started).
    assert.deepEqual(hookLog, ["start", "up:b"]);
    assert.equal(listenerInfo(), null);
  });

  test("proxy REST: verbatim path + query + body; nothing of this host's credentials goes; no cookie comes back", async () => {
    const res = await app.request("/peer/b/api/echo?x=1&y=%2F", { method: "POST", body: "hi", headers: { Host: "a.lab:4800", Cookie: "sova=secret", "X-Sova-Token": "t", Authorization: "Bearer t" } });
    assert.equal(res.status, 200);
    const echo = (await res.json()) as { method: string; url: string; body: string; fwd: string; relayed: string; cookie: string | null; token: string | null; authorization: string | null };
    assert.deepEqual([echo.method, echo.url, echo.body], ["POST", "/api/echo?x=1&y=%2F", "hi"]);
    assert.equal(echo.fwd, "a.lab:4800");
    assert.equal(echo.relayed, "1", "the relay marks itself, so the peer's local routes refuse it");
    // This host's token never travels to another host (§app.access/callers).
    assert.deepEqual([echo.cookie, echo.token, echo.authorization], [null, null, null], "the peer is sent no cookie or token from this side");
    assert.equal((await app.request("/peer/b/api/teapot")).status, 418);
    // Nor does a peer's answer set a cookie on this origin (it could shadow this host's own).
    const planted = await app.request("/peer/b/api/sets-cookie");
    assert.equal(planted.status, 200);
    assert.equal(planted.headers.get("set-cookie"), null);
  });

  test("proxy REST: our own failures — unknown 404, down 502, gate refusal 403; a route's 403 passes", async () => {
    assert.deepEqual(await getJson("/peer/nope/api/x"), [404, { error: "Unknown peer" }]);
    assert.deepEqual(await getJson("/peer/dead/api/x"), [502, { error: "peer down", id: "dead" }]);
    assert.deepEqual(await getJson("/peer/b/api/gate-refused"), [403, { error: "peer refused", id: "b" }]);
    assert.deepEqual(await getJson("/peer/b/api/own-403"), [403, { error: "route says no" }]);
    assert.deepEqual(await getJson("/peer/b/ws/chat"), [426, { error: "WebSocket upgrade required" }]);
  });

  test("a known-down peer is a 502 at once: no new dial while it is marked down", async () => {
    // The counted twin of the integration file's timed blackhole check: once a hop found the peer
    // down, the next one never reaches the wire.
    const { clearPeerReach } = await import("./proxy");
    clearPeerReach();
    assert.deepEqual(await getJson("/peer/dead/api/health"), [502, { error: "peer down", id: "dead" }]);
    const sent = wire.fetches;
    assert.deepEqual(await getJson("/peer/dead/api/health"), [502, { error: "peer down", id: "dead" }]);
    assert.equal(wire.fetches, sent, "no request went out for a peer just found down");
  });

  test("the hop's waits: a 3 s TCP check, 30 s for response headers, 5 s for a socket's handshake, 3 s known down", async () => {
    // The integration file runs blackholed and wedged peers with these shortened; these are the defaults.
    const { peerTimeouts } = await import("./proxy");
    assert.deepEqual(peerTimeouts(), { connectMs: 3000, headersMs: 30_000, wsHandshakeMs: 5000, downMs: 3000 });
  });

  test("GET /api/mesh: up / skewed / refused / down from the hello probe", async () => {
    await putJson("/api/mesh/peers", { peers: [{ ...peersB, priority: 2 }, peersDead] });
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

  test("a skewed peer polled like the web does (status, then sessions) comes up once, never again per poll", async () => {
    fakeHello = "other";
    fakeSessions = [];
    const ups = () => hookLog.filter((h) => h === "up:b").length;
    clearProbes();
    await getJson<MeshInfo>("/api/mesh"); // settle: whatever it was, it has answered now
    await getJson<MeshSessions>("/api/mesh/sessions");
    const before = ups();
    for (let i = 0; i < 3; i++) {
      clearProbes();
      const [, info] = await getJson<MeshInfo>("/api/mesh");
      assert.equal(info.peers.find((p) => p.id === "b")!.state, "skewed", "premise: the hello says skewed");
      const [, sessions] = await getJson<MeshSessions>("/api/mesh/sessions");
      assert.equal(sessions.peers.find((p) => p.id === "b")!.state, "up", "premise: its session list answers");
    }
    assert.equal(ups(), before, "each poll read it as gone and back");
    fakeHello = "same";
  });

  test("candidates: tailnet nodes, probed; peerId for known ones", async () => {
    tailnetPeers = [
      { nodeId: "nB", name: "127.0.0.1", online: true },
      { nodeId: "nOff", name: "off.lab", online: false },
    ];
    const was = process.env.SOVA_PEER_PORT;
    process.env.SOVA_PEER_PORT = new URL(B).port; // candidates are probed on the default peer port
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
      if (was === undefined) delete process.env.SOVA_PEER_PORT;
      else process.env.SOVA_PEER_PORT = was;
    }
  });

  test("PUT peers resolves a name through LocalAPI; refuses unknown names, this host and bad input", async () => {
    tailnetPeers = [{ nodeId: "nC", name: "c.lab", online: true }];
    const [s, info] = await putJson<MeshInfo>("/api/mesh/peers", { peers: [peersB, { id: "c", name: "c" }] });
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

  test("front door: a host can be left out (frontDoorExclude), validated, kept by a peers PUT, cleared by null or []", async () => {
    const phone = { id: "phone", nodeId: "nP", name: "127.0.0.1", url: DEAD };
    await putJson("/api/mesh/peers", { peers: [{ ...peersB, name: "b.lab" }, phone] });
    const stored = () => (JSON.parse(readFileSync(peersFile(), "utf8")) as { frontDoorExclude?: string[] }).frontDoorExclude;
    let [, fd] = await getJson<FrontDoorConfig>("/api/mesh/front-door");
    const self = fd.order[0]!.id;
    assert.deepEqual(fd.order.map((h) => h.id), [self, "b", "phone"], "absent: every host, as before");
    assert.equal(stored(), undefined);
    assert.equal((await putJson("/api/mesh/settings", { frontDoorExclude: ["nobody"] }))[0], 400);
    assert.equal((await putJson("/api/mesh/settings", { frontDoorExclude: ["phone", "phone"] }))[0], 400);
    assert.equal((await putJson("/api/mesh/settings", { frontDoorExclude: [self, "b", "phone"] }))[0], 400, "never every host");
    const [s, settings] = await putJson<MeshLocalSettings>("/api/mesh/settings", { frontDoorExclude: ["phone"] });
    assert.deepEqual([s, settings.frontDoorExclude, stored()], [200, ["phone"], ["phone"]]);
    [, fd] = await getJson<FrontDoorConfig>("/api/mesh/front-door");
    assert.deepEqual(fd.order.map((h) => h.id), [self, "b"]);
    assert.doesNotMatch(fd.caddyfile, /@from_phone|127\.0\.0\.1:8443/);
    await putJson("/api/mesh/peers", { peers: [{ ...peersB, name: "b.lab" }, phone] });
    assert.deepEqual(stored(), ["phone"], "a peers PUT keeps it");
    let [, cleared] = await putJson<MeshLocalSettings>("/api/mesh/settings", { frontDoorExclude: [] });
    assert.deepEqual([cleared.frontDoorExclude, stored()], [undefined, undefined]);
    await putJson("/api/mesh/settings", { frontDoorExclude: ["b"] });
    [, cleared] = await putJson<MeshLocalSettings>("/api/mesh/settings", { frontDoorExclude: null });
    assert.deepEqual([cleared.frontDoorExclude, stored()], [undefined, undefined]);
  });

  test("login kinds: stored only as api-keys, null/all clear it, bad values 400; SOVA_SYNC_LOGIN_KINDS pins it", async () => {
    const stored = () => (JSON.parse(readFileSync(peersFile(), "utf8")) as { loginKinds?: string }).loginKinds;
    let [, got] = await getJson<MeshSettings>("/api/mesh/settings");
    assert.deepEqual([got.loginKinds, got.loginKindsPinned], [undefined, undefined], "absent = all, not pinned");
    assert.equal((await putJson("/api/mesh/settings", { loginKinds: "oauth" }))[0], 400);
    let [s, settings] = await putJson<MeshSettings>("/api/mesh/settings", { loginKinds: "api-keys" });
    assert.deepEqual([s, settings.loginKinds, stored()], [200, "api-keys", "api-keys"]);
    // A peers PUT keeps it.
    await putJson("/api/mesh/peers", { peers: [peersB, peersDead] });
    assert.equal(stored(), "api-keys");
    [, settings] = await putJson<MeshSettings>("/api/mesh/settings", { loginKinds: "all" });
    assert.deepEqual([settings.loginKinds, stored()], [undefined, undefined], "all is the default, never stored");
    await putJson("/api/mesh/settings", { loginKinds: "api-keys" });
    [, settings] = await putJson<MeshSettings>("/api/mesh/settings", { loginKinds: null });
    assert.deepEqual([settings.loginKinds, stored()], [undefined, undefined]);
    process.env.SOVA_SYNC_LOGIN_KINDS = "api-keys";
    try {
      [, got] = await getJson<MeshSettings>("/api/mesh/settings");
      assert.deepEqual([got.loginKinds, got.loginKindsPinned], ["api-keys", true], "the pin wins over the file, and says so");
      assert.equal(meshApi.settings().loginKinds, "api-keys", "server/sync sees the pin");
      for (const other of ["all", null]) {
        assert.deepEqual(await putJson("/api/mesh/settings", { loginKinds: other }), [409, { error: "loginKinds is pinned by SOVA_SYNC_LOGIN_KINDS on this host" }]);
      }
      assert.equal((await putJson("/api/mesh/settings", { loginKinds: "api-keys" }))[0], 200, "the pinned value itself is fine");
      const [ok, afterPut] = await putJson<MeshSettings>("/api/mesh/settings", { hostLabel: "A" });
      assert.deepEqual([ok, afterPut.loginKindsPinned], [200, true], "a PUT that leaves loginKinds alone is fine");
      delete process.env.SOVA_SYNC_LOGIN_KINDS;
      await putJson("/api/mesh/settings", { loginKinds: null });
      assert.equal(stored(), undefined);
      process.env.SOVA_SYNC_LOGIN_KINDS = "api-key"; // a typo fails closed
      assert.equal((await getJson<MeshSettings>("/api/mesh/settings"))[1].loginKinds, "api-keys");
    } finally {
      delete process.env.SOVA_SYNC_LOGIN_KINDS;
      await putJson("/api/mesh/settings", { loginKinds: null });
    }
  });

  test("a malformed peers.json turns the mesh off and is never overwritten", async () => {
    writeFileSync(peersFile(), "{broken");
    const [, info] = await getJson<MeshInfo>("/api/mesh");
    assert.equal(info.enabled, false);
    assert.match(info.error ?? "", /not JSON/);
    assert.equal(listenerInfo(), null);
    assert.equal((await putJson("/api/mesh/peers", { peers: [] }))[0], 409);
    assert.equal((await putJson("/api/mesh/settings", { hostLabel: "x" }))[0], 409);
    assert.equal(readFileSync(peersFile(), "utf8"), "{broken", "never overwritten");
    rmSync(peersFile());
  });
});
