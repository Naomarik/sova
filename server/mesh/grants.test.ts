// Run: pnpm test -- server/mesh/grants.test.ts
// Per-peer grants (§mesh.peers/grants) end to end in one process, like mesh.test.ts: the server on
// an ephemeral port, a stub identity provider, a fake peer on loopback, and this server's own peer
// listener on 127.0.0.1, so a request makes the whole trip through the identity check and then the
// grant check. Also: every route a peer can reach has a class (the completeness check).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { WebSocket } from "ws";
import type { MeshAccessView, MeshInfoView, MeshSessionsView } from "../../shared/mesh-access";

const tmp = mkdtempSync(join(tmpdir(), "sova-grants-test-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
process.env.PORT = "0";
process.env.SOVA_PEER_HOST = "127.0.0.1";
process.env.SOVA_PEER_PORT = "0";
mkdirSync(join(tmp, "agent", "sessions", "live"), { recursive: true });

const { setIdentity } = await import("./localapi");
/** What whois answers for the next NEW connection to the peer listener. */
let whoisNode: string | null = null;
setIdentity({
  status: async () => ({
    backendState: "Running",
    self: { nodeId: "nA", name: "a.lab", hostName: "a", os: "linux", online: true, tags: [], login: "me", addresses: ["127.0.0.1"] },
    peers: [],
  }),
  whois: async () => (whoisNode ? { nodeId: whoisNode, name: "x", tags: [], login: "me" } : null),
});

const { app, server } = await import("../index");
const { listenerInfo, mayShareWith, peerFetch, stopMesh } = await import("./index");
const { accessFile, classifyRequest, classifyUpgrade, clearDenied } = await import("./access");
const { clearProbes, ownProtocol } = await import("./hello");
const { clearPeerReach } = await import("./proxy");
const { AUTH_COOKIE, sovaToken } = await import("../auth");
const AUTH = { Cookie: `${AUTH_COOKIE}=${sovaToken()}` };
const mainFetch = (url: string, init: RequestInit = {}) => fetch(url, { ...init, headers: { ...AUTH, ...(init.headers as Record<string, string> | undefined) } });

let base = "";

// ---- the fake peer: its hello and session list answer as `fakeMode` says; /api/echo reports the
// headers a relayed request carried.
let fake: Server;
let fakePort = 0;
let fakeMode: "open" | "denied" | "sessions-denied" = "open";

before(async () => {
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", r)));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  fake = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const denied = () => json(403, { error: "not shared with this host" }, { "X-Sova-Mesh": "denied" });
    if (url.pathname === "/api/peer/hello") {
      if (fakeMode === "denied") return denied();
      return json(200, { mesh: 1, id: "f", label: "F", hostname: "f", version: "0", protocol: ownProtocol(), pi: "x", now: Date.now() });
    }
    if (url.pathname === "/api/sessions") return fakeMode === "open" ? json(200, [{ id: "s1", path: "/far/s1.jsonl" }]) : denied();
    const h = req.headers;
    json(200, {
      fwd: h["x-forwarded-host"] ?? null,
      relayed: h["x-sova-relayed"] ?? null,
      origin: h.origin ?? null,
      referer: h.referer ?? null,
      ua: h["user-agent"] ?? null,
      lang: h["accept-language"] ?? null,
      xff: h["x-forwarded-for"] ?? null,
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  fakePort = (fake.address() as { port: number }).port;
});

after(async () => {
  stopMesh();
  server.close();
  server.closeAllConnections();
  fake.close();
  fake.closeAllConnections();
  rmSync(tmp, { recursive: true, force: true });
});

const getJson = async <T>(path: string, headers: Record<string, string> = {}): Promise<[number, T]> => {
  const res = await mainFetch(`${base}${path}`, { headers });
  return [res.status, (await res.json()) as T];
};
const putJson = async <T>(path: string, body: unknown): Promise<[number, T]> => {
  const res = await mainFetch(`${base}${path}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return [res.status, (await res.json()) as T];
};

/** A request on a NEW connection to the peer listener (whois runs again). */
function peerCall(method: string, path: string, body?: string): Promise<{ status: number; marker: string | undefined; body: string }> {
  const info = listenerInfo()!;
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: info.port, path, method, agent: false, headers: body ? { "content-type": "application/json" } : {} }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode!, marker: res.headers["x-sova-mesh"] as string | undefined, body: text }));
    });
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error(`no answer within 8 s: ${path}`)));
    req.end(body);
  });
}

/** An upgrade on the peer listener: its HTTP refusal (status + marker), or "open". */
function peerSocket(path: string): Promise<{ open: true; ws: WebSocket; closed: Promise<number> } | { open: false; status: number; marker?: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${listenerInfo()!.port}${path}`);
    const closed = new Promise<number>((r) => ws.on("close", (c) => r(c)));
    ws.once("open", () => resolve({ open: true, ws, closed }));
    ws.once("unexpected-response", (_req, res) => {
      resolve({ open: false, status: res.statusCode!, marker: res.headers["x-sova-mesh"] as string | undefined });
      ws.terminate();
    });
    ws.on("error", () => {});
  });
}

async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, j) => (timer = setTimeout(() => j(new Error(`timed out after ${ms} ms: ${what}`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

function watchableSession(): string {
  const dir = join(tmp, "agent", "sessions", "--grants--");
  mkdirSync(dir, { recursive: true });
  const id = "0197a000-0000-7000-8000-000000000002";
  const file = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: tmp })}\n`);
  return file;
}

const grant = (peer: string, g: unknown) => putJson<MeshAccessView>("/api/mesh/access", { peer, grant: g });
const accessDoc = () => JSON.parse(readFileSync(accessFile(), "utf8")) as { version: 1; peers: Record<string, { preset: string; logins?: string[] }> };
const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const PEERS = () => [
  { id: "b", label: "B", nodeId: "nB", name: "127.0.0.1", url: `http://127.0.0.1:${fakePort}` },
  { id: "f", label: "F", nodeId: "nF", name: "127.0.0.1", url: `http://127.0.0.1:${fakePort}` },
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

describe("grants on the peer listener", () => {
  before(async () => {
    const [s] = await putJson("/api/mesh/peers", { peers: PEERS() });
    assert.equal(s, 200);
    await waitFor(() => (listenerInfo()?.addresses.length ?? 0) > 0);
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

  test("presence: hello and details, nothing else; a denial is X-Sova-Mesh: denied, never refused", async () => {
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
    const ws = await peerSocket("/ws/watch?feed=sessions");
    assert.deepEqual(ws.open ? "open" : [ws.status, ws.marker], [403, "denied"]);
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

  test("sessions: drive sessions and the llm feed, but no settings write, sync or pool", async () => {
    await grant("b", { preset: "sessions" });
    whoisNode = "nB";
    assert.equal((await peerCall("GET", "/api/sessions")).status, 200);
    assert.equal((await peerCall("GET", "/api/settings")).status, 200);
    assert.equal((await peerCall("PUT", "/api/settings", "{}")).marker, "denied");
    assert.equal((await peerCall("GET", "/api/peer/sync/manifest")).marker, "denied");
    assert.equal((await peerCall("POST", "/api/peer/claude-pool/doc", "{}")).marker, "denied");
    assert.equal((await peerCall("POST", "/api/peer/rename", "{}")).marker, "denied");
    const llm = await peerSocket("/ws/watch?feed=llm");
    assert.equal(llm.open, true);
    if (llm.open) llm.ws.terminate();
  });

  test("switches on top of a preset", async () => {
    await grant("b", { preset: "presence", caps: { "sync.themes": true } });
    whoisNode = "nB";
    assert.notEqual((await peerCall("GET", "/api/peer/sync/manifest")).marker, "denied");
    assert.equal((await peerCall("GET", "/api/peer/sync/extensions")).marker, "denied");
  });

  test("lowering a grant cuts the peer's open socket at once", async () => {
    await grant("b", { preset: "full" });
    const file = watchableSession();
    whoisNode = "nB";
    const ws = await peerSocket(`/ws/watch?path=${encodeURIComponent(file)}`);
    assert.equal(ws.open, true);
    if (!ws.open) return;
    // Still open under a grant that keeps sessions.
    await grant("b", { preset: "sessions" });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ws.ws.readyState, WebSocket.OPEN);
    await grant("b", { preset: "presence" });
    await within(ws.closed, 2000, "the socket closes when sessions is taken away");
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
    assert.equal((await mainFetch(`${base}/peer/b/api/mesh/access`)).status, 404);
    assert.equal((await getJson("/api/mesh/access"))[0], 200);
    assert.equal((await grant("nobody", { preset: "full" }))[0], 404);
    assert.equal((await grant("b", { preset: "everything" }))[0], 400);
  });
});

describe("this host's own calls", () => {
  test("what it doesn't grant a peer, it never sends it; reading the peer's own things still goes", async () => {
    await grant("b", { preset: "full", caps: { links: false, "sync.logins": false } });
    await assert.rejects(peerFetch("b", "/api/peer/links/whoami"), /not shared with b/);
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

  test("a relayed browser request to a peer this host restricts carries nothing of this host or the browser", async () => {
    clearPeerReach();
    const headers = { Origin: base, Referer: `${base}/`, "User-Agent": "sova-test-agent", "Accept-Language": "en-GB", "X-Forwarded-For": "198.51.100.7" };
    const full = (await (await mainFetch(`${base}/peer/b/api/echo`, { headers })).json()) as Record<string, string | null>;
    assert.equal(full.fwd, new URL(base).host);
    assert.equal(full.ua, "sova-test-agent");
    await grant("b", { preset: "sessions" });
    const scrubbed = (await (await mainFetch(`${base}/peer/b/api/echo`, { headers })).json()) as Record<string, string | null>;
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
