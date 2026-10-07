// Run: node scripts/run-tests.mjs server/share-ingress.integration.test.ts. A routed host's ingress
// over real loopback sockets (§mesh.public/ingress): the gate, the admitted client key, closing what it
// admitted when `via` changes, and where startIngress binds. Hermetic: a throwaway PI_CODING_AGENT_DIR,
// a fake LocalAPI (setIdentity), fake gateway deps, loopback only. The gateway client and the registry
// push in process are share-ingress.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Agent, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-share-ingress-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
delete process.env.SOVA_SHARE_PUBLIC_URL;
mkdirSync(join(root, "agent", "sessions"), { recursive: true });
// A stub share page: with no built dist-share/ the share listener answers 503 (share/routes.ts).
process.env.SOVA_SHARE_DIST = join(root, "dist-share");
mkdirSync(process.env.SOVA_SHARE_DIST, { recursive: true });
writeFileSync(join(process.env.SOVA_SHARE_DIST, "index.html"), "<!doctype html><title>Shared</title>");
after(() => rmSync(root, { recursive: true, force: true }));

const { stateRoot } = await import("./state-root");
const { setIdentity } = await import("./mesh/localapi");
const gw = await import("./share/gateway-client");
const push = await import("./share/registry-push");
const ingress = await import("./share/ingress");
const events = await import("./share/links-events");
const { validateSnapshot } = await import("./share/registry-validation");
const batonLinks = await import("./baton-links");
const personLinks = await import("./person-links");
const { REFUSED_HEADER } = await import("./mesh/hello");
const { addressIdentity } = await import("./mesh/address-identity");
const { peerUrl } = await import("./mesh/peers");
const { meshApi } = await import("./mesh/index");
const { previewAddress } = await import("./share/preview-address");
const { LINK_WARNINGS, MINT_ACK_TIMEOUT_MS, SHARE_PORT_DEFAULT } = await import("../shared/public-links");
type PublicLinksFile = import("../shared/public-links").PublicLinksFile;
type RegistrySnapshot = import("../shared/public-links").RegistrySnapshot;
type RegistryAck = import("../shared/public-links").RegistryAck;
type PeerEntry = import("./mesh/peers").PeerEntry;

const TOKEN = "A".repeat(43);
const GATEWAY: PeerEntry = { id: "vps", label: "VPS", nodeId: "nGW", dnsName: "100.64.0.2" };
const OTHER: PeerEntry = { id: "desk", label: "Desk", nodeId: "nDESK", dnsName: "100.64.0.3" };
const PUBLIC_URL = "https://share.example.com";
const VIA: PublicLinksFile = { version: 1, route: { via: { nodeId: "nGW" } } };
const warn = (code: keyof typeof LINK_WARNINGS) => LINK_WARNINGS[code].replaceAll("{gateway}", GATEWAY.label);

// ---- fakes --------------------------------------------------------------------------------------

let whoisNode: string | null = null;
const fakeIdentity = {
  status: async (): Promise<never> => {
    throw new Error("no LocalAPI status in this test");
  },
  whois: async () => (whoisNode ? { nodeId: whoisNode, name: "x", tags: [], login: "me" } : null),
};
setIdentity(fakeIdentity);

// The fake gateways, one per StableID, answer through BOTH dependency shapes: the reviewed M4's
// (hello/info/push per peer) and the fixed one's (a verified endpoint, then one `call` per URL), so
// every test here runs against either version.
type Reply = { status: number; body: unknown } | null;
const DESK_URL = "https://desk-share.example.com";
const urlOf = (node: string) => (node === "nDESK" ? DESK_URL : PUBLIC_URL);
let setting: PublicLinksFile | null = VIA;
let addrMode = false;
/** Hold or rewrite the fixed client's endpoint resolution. */
let endpointHook: ((p: PeerEntry, base: string) => Promise<string | null>) | null = null;
let peers: PeerEntry[] = [GATEWAY, OTHER];
let pushed: RegistrySnapshot[] = [];
/** The StableID each snapshot in `pushed` went to. */
let pushedTo: string[] = [];
/** Every URL the fixed client called. */
let calls: string[] = [];
let recorded: string[] = [];
const helloOk = (node: string): Reply => ({ status: 200, body: { mesh: 1, shareGateway: { publicUrl: urlOf(node) } } });
const infoOk = (node: string): Reply => ({ status: 200, body: { publicUrl: urlOf(node), accepting: true, seq: null } });
let helloReply: (node: string) => Promise<Reply> = async (n) => helloOk(n);
let infoReply: (node: string) => Promise<Reply> = async (n) => infoOk(n);
/** How the fake gateway answers a push, as an ack (null: no answer); default: ok at the sent seq. */
let answer: (s: RegistrySnapshot, node: string) => Promise<RegistryAck | null> = async (s, node) => ({ ok: true, seq: s.seq, publicUrl: urlOf(node) });
/** A raw push reply instead of `answer` (the strict-parsing tests). */
let rawReply: ((s: RegistrySnapshot, node: string) => Promise<Reply>) | null = null;

async function pushReply(node: string, snap: RegistrySnapshot): Promise<Reply> {
  pushed.push(snap);
  pushedTo.push(node);
  if (rawReply) return rawReply(snap, node);
  const a = await answer(snap, node);
  return a ? { status: a.ok ? 200 : a.error === "not-gateway" ? 404 : 403, body: a } : null;
}

const fakeDeps: Record<string, unknown> = {
  readSetting: () => setting,
  peers: () => peers,
  addressMode: () => addrMode,
  // the fixed client: an endpoint per StableID, carrying the entry's port and name (so a changed
  // entry is a changed endpoint); a test may hold it (endpointHook)
  endpoint: async (p: PeerEntry) => {
    const base = `http://gw-${p.nodeId}.${p.dnsName.replace(/[^A-Za-z0-9-]/g, "-")}.test:${new URL(peerUrl(p)).port || "80"}`;
    return endpointHook ? endpointHook(p, base) : base;
  },
  call: async (url: string, init?: RequestInit): Promise<Reply> => {
    calls.push(url);
    const m = /^http:\/\/gw-([^./]+)\.[^/]*\.test(?::\d+)?(\/.*)$/.exec(url);
    if (!m) return null;
    const [, node, path] = m as unknown as [string, string, string];
    if (path === "/api/peer/hello") return helloReply(node);
    // The routed host asks with ?kinds=1 (GatewayInfo.kinds); the fake answers either.
    if (path === "/api/peer/share-gateway/info" || path === "/api/peer/share-gateway/info?kinds=1" || path === "/api/peer/share-gateway/info?kinds=1&preview=1") return infoReply(node);
    if (path === "/api/peer/share-gateway/links" && init?.method === "PUT") return pushReply(node, JSON.parse(String(init.body)));
    return null;
  },
  recordUrl: (u: string) => void recorded.push(u),
  // the reviewed client
  hello: async (p: PeerEntry) => ((await helloReply(p.nodeId))?.body ?? null),
  info: async (p: PeerEntry) => infoReply(p.nodeId),
  push: async (p: PeerEntry, snap: RegistrySnapshot) => ((await pushReply(p.nodeId, snap))?.body ?? null),
};
const without = (...keys: string[]) => Object.fromEntries(Object.entries(fakeDeps).filter(([k]) => !keys.includes(k)));
let undoDeps = gw.setGatewayDeps(fakeDeps as never);
/** Run `fn` with the real defaults for `keys` (every other dependency faked). */
async function withDefaults(keys: string[], fn: () => Promise<void> | void): Promise<void> {
  undoDeps();
  const undo = gw.setGatewayDeps(without(...keys) as never);
  try {
    await fn();
  } finally {
    undo();
    undoDeps = gw.setGatewayDeps(fakeDeps as never);
  }
}
after(() => undoDeps());

afterEach(() => {
  push.stopRegistryPush();
  gw.resetGatewayClient();
  setting = VIA;
  peers = [GATEWAY, OTHER];
  pushed = [];
  pushedTo = [];
  calls = [];
  recorded = [];
  helloReply = async (n) => helloOk(n);
  infoReply = async (n) => infoOk(n);
  answer = async (s, node) => ({ ok: true, seq: s.seq, publicUrl: urlOf(node) });
  rawReply = null;
  endpointHook = null;
  addrMode = false;
  whoisNode = null;
  setIdentity(fakeIdentity);
});

/** A fresh state dir's link stores and outbox, for a test that counts rows. */
function clearStores(): void {
  for (const f of ["baton-links.json", "person-links.json", "share-gateway-outbox.json"]) rmSync(join(stateRoot(), f), { force: true });
  personLinks.resetPersonLinkCache();
}

/** Mint a hand-off link the way a route does: inside awaitShareLinks (the store emits the change). */
async function mintH(waitMs?: number, now?: number) {
  const t0 = Date.now();
  const { result: token, outcome } = await events.awaitShareLinks(() => {
    const token = batonLinks.mintLink({ orgId: "o1", sessionId: `s-${Math.random()}`, n: 1, personId: "p1" }, now);
    return token;
  }, waitMs);
  return { token, hash: batonLinks.hashToken(token), outcome, ms: Date.now() - t0 };
}

// ---- the ingress --------------------------------------------------------------------------------

let expected: { nodeId: string; addresses?: string[] } | null = { nodeId: "nGW" };

async function openIngress() {
  const ing = ingress.createIngress({ expected: () => expected, addresses: async () => ["127.0.0.1"], port: 0, recheckMs: 60_000 });
  await ing.start();
  const port = ing.info().port;
  assert.ok(port > 0, "bound");
  return { ing, port };
}

function get(port: number, path: string, opts: { headers?: Record<string, string>; agent?: Agent } = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; socketClosed: Promise<void> }>((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, path, headers: opts.headers, agent: opts.agent ?? false }, (res) => {
      res.resume();
      const sock = res.socket;
      const socketClosed = new Promise<void>((done) => (sock.destroyed ? done() : sock.once("close", () => done())));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, socketClosed }));
    });
    r.on("error", reject);
    r.end();
  });
}

test("ingress: the gateway gets the share app; a stranger or another peer gets 403 with the marker", async () => {
  expected = { nodeId: "nGW" };
  const { ing, port } = await openIngress();
  try {
    whoisNode = "nGW";
    assert.equal((await get(port, `/h/${TOKEN}`)).status, 200, "the page shell (it asks the API)");
    assert.equal((await get(port, `/api/h/${TOKEN}`)).status, 404, "an unknown token: the share app's own 404");
    assert.equal((await get(port, "/api/sessions")).status, 404, "not a share path");
    for (const who of ["nDESK", "nSTRANGER", null]) {
      whoisNode = who;
      const r = await get(port, `/h/${TOKEN}`);
      assert.equal(r.status, 403, String(who));
      assert.equal(r.headers[REFUSED_HEADER.toLowerCase()], "refused");
    }
  } finally {
    ing.close();
  }
});

test("ingress: no expected gateway refuses everyone", async () => {
  expected = null;
  const { ing, port } = await openIngress();
  try {
    whoisNode = "nGW";
    assert.equal((await get(port, `/h/${TOKEN}`)).status, 403);
  } finally {
    ing.close();
    expected = { nodeId: "nGW" };
  }
});

test("ingress: the gateway's single X-Forwarded-For is the rate-limit key; a stranger's never counts", async () => {
  expected = { nodeId: "nGW" };
  const { ing, port } = await openIngress();
  try {
    whoisNode = "nGW";
    for (let i = 0; i < 65; i++) assert.notEqual((await get(port, `/h/${TOKEN}`, { headers: { "x-forwarded-for": `203.0.113.${i}` } })).status, 429, `client ${i}`);
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await get(port, `/h/${TOKEN}`, { headers: { "x-forwarded-for": "198.51.100.1" } })).status;
    assert.equal(last, 429, "one client past the limit");
  } finally {
    ing.close();
  }
});

test("ingress: a via change closes the gateway's kept-alive socket; recheck with the same gateway keeps it", async () => {
  expected = { nodeId: "nGW" };
  whoisNode = "nGW";
  const { ing, port } = await openIngress();
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const r = await get(port, `/h/${TOKEN}`, { agent });
    assert.equal(ing.admittedCount(), 1);
    await ing.recheck();
    assert.equal(ing.admittedCount(), 1, "the same gateway stays");
    expected = { nodeId: "nNEW" };
    await ing.recheck();
    await r.socketClosed;
    assert.equal(ing.admittedCount(), 0);
  } finally {
    agent.destroy();
    ing.close();
    expected = { nodeId: "nGW" };
  }
});

test("ingress: removing the gateway closes admitted sockets on the next poll, without a recheck call", async () => {
  expected = { nodeId: "nGW" };
  whoisNode = "nGW";
  const ing = ingress.createIngress({ expected: () => expected, addresses: async () => ["127.0.0.1"], port: 0, recheckMs: 50 });
  await ing.start();
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const r = await get(ing.info().port, `/h/${TOKEN}`, { agent });
    expected = null;
    await r.socketClosed;
    assert.equal(ing.admittedCount(), 0);
  } finally {
    agent.destroy();
    ing.close();
    expected = { nodeId: "nGW" };
  }
});

test("ingress: a raw kept-alive connection the gate admitted is destroyed when via changes", async () => {
  expected = { nodeId: "nGW" };
  whoisNode = "nGW";
  const { ing, port } = await openIngress();
  const { connect } = await import("node:net");
  const s = connect(port, "127.0.0.1");
  try {
    await new Promise((r) => s.once("connect", r));
    const closed = new Promise<void>((r) => s.once("close", () => r()));
    // A kept-alive HTTP request on the raw socket, admitted, then via changes.
    s.write(`GET /h/${TOKEN} HTTP/1.1\r\nHost: x\r\n\r\n`);
    await new Promise((r) => s.once("data", r));
    expected = { nodeId: "nNEW" };
    await ing.recheck();
    await closed;
  } finally {
    s.destroy();
    ing.close();
    expected = { nodeId: "nGW" };
  }
});

test("ingress: close() unbinds", async () => {
  const { ing, port } = await openIngress();
  ing.close();
  await assert.rejects(get(port, `/h/${TOKEN}`));
});

test("startIngress: not routed binds nothing; routed never binds loopback or a wildcard", async () => {
  setting = { version: 1, route: "off" };
  await ingress.startIngress();
  assert.equal(ingress.ingressInfo(), null);
  ingress.stopIngress();
  const prev = process.env.SOVA_PEER_HOST;
  setting = VIA;
  process.env.SOVA_PEER_HOST = "127.0.0.1";
  const quiet = console.warn;
  console.warn = () => {};
  try {
    await ingress.startIngress();
    const info = ingress.ingressInfo();
    for (const a of info?.addresses ?? []) assert.ok(!/^(127\.|::1$|0\.0\.0\.0$|::$)/.test(a), `bound ${a}`);
  } finally {
    ingress.stopIngress();
    console.warn = quiet;
    if (prev === undefined) delete process.env.SOVA_PEER_HOST;
    else process.env.SOVA_PEER_HOST = prev;
  }
});

/** Resolves true when `p` settles within `ms`, false otherwise. */
const settlesWithin = (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
const tick = () => new Promise((r) => setImmediate(r));
/** A push reply the test releases: resolve(ack) answers it. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const WAIT = 8000;

// ---- B2: established sockets are re-judged by the whole gate -----------------------------------

async function keptAlive(port: number) {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const r = await get(port, `/api/h/${TOKEN}`, { agent });
  return { agent, closed: r.socketClosed };
}

test("B2 the same nodeId with pins that no longer include the source: recheck closes it", async () => {
  whoisNode = "nGW";
  expected = { nodeId: "nGW", addresses: ["127.0.0.1"] };
  const { ing, port } = await openIngress();
  const k = await keptAlive(port);
  try {
    assert.equal(ing.admittedCount(), 1);
    expected = { nodeId: "nGW", addresses: ["100.64.0.77"] };
    await ing.recheck();
    assert.equal(await settlesWithin(k.closed, 1000), true, "closed");
  } finally {
    k.agent.destroy();
    ing.close();
    expected = { nodeId: "nGW" };
  }
});

test("B2 pins changed to [] (explicitly none): recheck closes it", async () => {
  whoisNode = "nGW";
  expected = { nodeId: "nGW", addresses: ["127.0.0.1"] };
  const { ing, port } = await openIngress();
  const k = await keptAlive(port);
  try {
    expected = { nodeId: "nGW", addresses: [] };
    await ing.recheck();
    assert.equal(await settlesWithin(k.closed, 1000), true, "closed");
  } finally {
    k.agent.destroy();
    ing.close();
    expected = { nodeId: "nGW" };
  }
});

describe("B2 with the real address-identity adapter", () => {
  let idPeers: PeerEntry[] = [];
  beforeEach(() => {
    idPeers = [{ ...GATEWAY, dnsName: "100.64.0.2" }];
    const adapter = addressIdentity(() => idPeers, { SOVA_PEER_HOST: "100.64.0.9" });
    // The ingress binds loopback here: its callers appear at the gateway's tailnet address.
    setIdentity({ status: adapter.status, whois: (addr: string) => adapter.whois(addr.replace(/^127\.0\.0\.1:/, "100.64.0.2:")) });
    expected = { nodeId: "nGW" };
  });
  let quiet: typeof console.warn;
  beforeEach(() => {
    quiet = console.warn;
    console.warn = () => {};
  });
  afterEach(() => {
    console.warn = quiet;
    setIdentity(fakeIdentity);
  });

  test("unique → ambiguous: recheck closes the kept-alive socket", async () => {
    const { ing, port } = await openIngress();
    const k = await keptAlive(port);
    try {
      assert.equal(ing.admittedCount(), 1, "admitted while unique");
      idPeers.push({ ...OTHER, dnsName: "100.64.0.2" });
      await ing.recheck();
      assert.equal(await settlesWithin(k.closed, 1000), true, "closed");
    } finally {
      k.agent.destroy();
      ing.close();
    }
  });

  test("unique → unmapped: recheck closes the kept-alive socket", async () => {
    const { ing, port } = await openIngress();
    const k = await keptAlive(port);
    try {
      idPeers = [{ ...GATEWAY, dnsName: "vps.example.ts.net" }];
      await ing.recheck();
      assert.equal(await settlesWithin(k.closed, 1000), true, "closed");
    } finally {
      k.agent.destroy();
      ing.close();
    }
  });
});

test("B2 expected() changing during admission: the request is refused and nothing is admitted", async () => {
  const A = { nodeId: "nGW" };
  const B = { nodeId: "nNEW" };
  let armed = false;
  let readsSinceArmed = 0;
  // A until the gate has read it once after whois answered; B from then on (the setting changed
  // between the gate's read and whatever the ingress reads next).
  const ing = ingress.createIngress({
    expected: () => (armed && readsSinceArmed++ >= 1 ? B : A),
    addresses: async () => ["127.0.0.1"],
    port: 0,
    recheckMs: 60_000,
  });
  setIdentity({ status: fakeIdentity.status, whois: async () => ((armed = true), { nodeId: "nGW", name: "x", tags: [], login: "me" }) });
  await ing.start();
  try {
    const r = await get(ing.info().port, `/api/h/${TOKEN}`);
    assert.equal(r.status, 403, "refused");
    assert.equal(ing.admittedCount(), 0, "nothing admitted");
  } finally {
    ing.close();
  }
});

test("B2 an upgraded socket is closed by recheck after a via change", async () => {
  whoisNode = "nGW";
  expected = { nodeId: "nGW" };
  const ing = ingress.createIngress({
    expected: () => expected,
    addresses: async () => ["127.0.0.1"],
    port: 0,
    recheckMs: 60_000,
    dispatch: (_q, r) => void r.writeHead(299).end(),
    // A 101 by hand, and the socket kept: an upgraded connection the ingress admitted.
    upgrade: (_q, socket) => void socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"),
  });
  await ing.start();
  const { connect } = await import("node:net");
  const s = connect(ing.info().port, "127.0.0.1");
  try {
    await new Promise((r) => s.once("connect", r));
    const closed = new Promise<void>((r) => s.once("close", () => r()));
    s.write(`GET /ws/h?token=${TOKEN} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    const first = await new Promise<string>((r) => s.once("data", (d) => r(d.toString("latin1"))));
    assert.match(first, /^HTTP\/1\.1 101/, "upgraded");
    expected = { nodeId: "nNEW" };
    await ing.recheck();
    assert.equal(await settlesWithin(closed, 1000), true, "the upgraded socket was closed");
  } finally {
    s.destroy();
    ing.close();
    expected = { nodeId: "nGW" };
  }
});
