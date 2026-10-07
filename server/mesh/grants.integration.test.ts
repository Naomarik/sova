// Run: node scripts/run-tests.mjs server/mesh/grants.integration.test.ts
// Per-peer grants (§mesh.peers/grants) on the real peer listener: the server on an ephemeral port, a
// stub identity provider, a fake peer on loopback, and this server's own peer listener on
// 127.0.0.1: sockets through the identity and grant checks, a lowered grant cutting an open socket,
// and a relayed browser over a real hop. The grant rules over the same gate in-process: grants.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { WebSocket } from "ws";
import type { MeshAccessView } from "../../shared/mesh-access";

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

const { server } = await import("../index");
const { listenerInfo, stopMesh } = await import("./index");
const { ownProtocol } = await import("./hello");
const { clearPeerReach } = await import("./proxy");
const { AUTH_COOKIE, sovaToken } = await import("../auth");
const AUTH = { Cookie: `${AUTH_COOKIE}=${sovaToken()}` };
const mainFetch = (url: string, init: RequestInit = {}) => fetch(url, { ...init, headers: { ...AUTH, ...(init.headers as Record<string, string> | undefined) } });

let base = "";

// ---- the fake peer: its hello and session list answer as `fakeMode` says; /api/echo reports the
// headers a relayed request carried.
let fake: Server;
let fakePort = 0;
const fakeMode = "open" as "open" | "denied" | "sessions-denied"; // the hiding states: grants.test.ts

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
    req.setTimeout(15_000, () => req.destroy(new Error(`no answer within 15 s: ${path}`)));
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
const waitFor = async (cond: () => boolean, ms = 15_000) => {
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
describe("grants on the peer listener", () => {
  before(async () => {
    const [s] = await putJson("/api/mesh/peers", { peers: PEERS() });
    assert.equal(s, 200);
    await waitFor(() => (listenerInfo()?.addresses.length ?? 0) > 0);
  });

  test("presence: a socket is denied (X-Sova-Mesh: denied), and a node that is not a peer is refused", async () => {
    // Its REST rules: grants.test.ts, on the same gate in-process.
    assert.equal((await grant("b", { preset: "presence" }))[0], 200);
    whoisNode = "nB";
    assert.equal((await peerCall("GET", "/api/peer/hello")).status, 200);
    const ws = await peerSocket("/ws/watch?feed=sessions");
    assert.deepEqual(ws.open ? "open" : [ws.status, ws.marker], [403, "denied"]);
    whoisNode = "nStranger";
    assert.equal((await peerCall("GET", "/api/peer/hello")).marker, "refused");
  });

  test("sessions: the llm feed opens on the peer listener", async () => {
    await grant("b", { preset: "sessions" });
    whoisNode = "nB";
    const llm = await peerSocket("/ws/watch?feed=llm");
    assert.equal(llm.open, true);
    if (llm.open) llm.ws.terminate();
  });

  test("lowering a grant cuts the peer's open socket at once", async () => {
    await grant("b", { preset: "full" });
    const file = watchableSession();
    whoisNode = "nB";
    const ws = await peerSocket(`/ws/watch?path=${encodeURIComponent(file)}`);
    assert.equal(ws.open, true);
    if (!ws.open) return;
    // Still open under a grant that keeps sessions: a ping sent after the change is answered (a cut
    // made by the change would have ended the socket before it).
    await grant("b", { preset: "sessions" });
    const pong = new Promise<void>((r) => ws.ws.once("pong", () => r()));
    ws.ws.ping();
    await within(pong, 15_000, "the socket answering after a grant that keeps sessions");
    assert.equal(ws.ws.readyState, WebSocket.OPEN);
    await grant("b", { preset: "presence" });
    await within(ws.closed, 15_000, "the socket closes when sessions is taken away");
  });
});

describe("this host's own calls", () => {
  test("a relayed browser request to a peer this host restricts carries nothing of this host or the browser (a real hop)", async () => {
    await grant("b", null); // no grant entry: full, so nothing is scrubbed yet
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
