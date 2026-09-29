// Run: pnpm exec tsx --test server/share-ingress.test.ts. A routed host's side of public links
// (§mesh.public/ingress, §mesh.public/registry push side, §mesh.public/gateway): the gateway
// client, the registry push (snapshot, seq, outbox, the mint's ack outcome) and the ingress (the
// gate, the admitted client key, closing what it admitted when `via` changes). Hermetic: a
// throwaway PI_CODING_AGENT_DIR, a fake LocalAPI (setIdentity), fake gateway deps, loopback only.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Agent, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-share-ingress-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
delete process.env.SOVA_SHARE_PUBLIC_URL;
mkdirSync(join(root, "agent", "sessions"), { recursive: true });
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
setIdentity({
  status: async () => {
    throw new Error("no LocalAPI status in this test");
  },
  whois: async () => (whoisNode ? { nodeId: whoisNode, name: "x", tags: [], login: "me" } : null),
});

let setting: PublicLinksFile | null = VIA;
let pushed: RegistrySnapshot[] = [];
/** How the fake gateway answers a push; default: ok at the sent seq. */
let answer: (s: RegistrySnapshot) => Promise<RegistryAck | null> = async (s) => ({ ok: true, seq: s.seq, publicUrl: PUBLIC_URL });
const restore = gw.setGatewayDeps({
  readSetting: () => setting,
  peers: () => [GATEWAY, OTHER],
  addressMode: () => false,
  hello: async () => ({ shareGateway: { publicUrl: PUBLIC_URL } }) as never,
  info: async () => ({ status: 200, body: { publicUrl: PUBLIC_URL, accepting: true, seq: null } }),
  push: async (_peer, snap) => {
    pushed.push(snap);
    return answer(snap);
  },
});
after(() => restore());

afterEach(() => {
  push.stopRegistryPush();
  gw.resetGatewayClient();
  setting = VIA;
  pushed = [];
  answer = async (s) => ({ ok: true, seq: s.seq, publicUrl: PUBLIC_URL });
  whoisNode = null;
});

/** A fresh state dir's link stores and outbox, for a test that counts rows. */
function clearStores(): void {
  for (const f of ["baton-links.json", "person-links.json", "share-gateway-outbox.json"]) rmSync(join(stateRoot(), f), { force: true });
  personLinks.resetPersonLinkCache();
}

/** Mint a hand-off link the way a route does: inside awaitShareLinks, the store's event emitted. */
async function mintH(waitMs?: number) {
  const t0 = Date.now();
  const { result: token, outcome } = await events.awaitShareLinks(() => {
    const token = batonLinks.mintLink({ orgId: "o1", sessionId: `s-${Math.random()}`, n: 1, personId: "p1" });
    events.shareLinksChanged({ kind: "h", cause: "mint" });
    return token;
  }, waitMs);
  return { token, hash: batonLinks.hashToken(token), outcome, ms: Date.now() - t0 };
}

// ---- gateway client -----------------------------------------------------------------------------

test("viaGatewayPeer / viaGatewayIdentity: the via nodeId's peers.json entry; null unless routed to a known peer", () => {
  assert.equal(gw.viaGatewayPeer()?.id, "vps");
  assert.deepEqual(gw.viaGatewayIdentity(), { nodeId: "nGW" });
  for (const s of [null, { version: 1, route: "off" }, { version: 1, route: "self" }, { version: 1, route: { via: { nodeId: "nGONE" } } }] as (PublicLinksFile | null)[]) {
    setting = s;
    assert.equal(gw.viaGatewayPeer(), null, JSON.stringify(s));
    assert.equal(gw.viaGatewayIdentity(), null, JSON.stringify(s));
  }
});

test("viaGatewayIdentity in address mode pins the peer's tailnet addresses", () => {
  const r = gw.setGatewayDeps({ addressMode: () => true });
  try {
    assert.deepEqual(gw.viaGatewayIdentity(), { nodeId: "nGW", addresses: ["100.64.0.2"] });
  } finally {
    r();
  }
});

test("viaGatewayIdentity in address mode is null when the gateway peer has no tailnet address", () => {
  const r = gw.setGatewayDeps({ addressMode: () => true, peers: () => [{ ...GATEWAY, dnsName: "vps.example.ts.net", url: "http://vps.example.ts.net:4801" }, OTHER] });
  try {
    assert.equal(gw.viaGatewayIdentity(), null);
  } finally {
    r();
  }
});

test("refreshGateway: hello gives the public URL, info the acceptance; viaGatewayStatus caches it", async () => {
  assert.equal(gw.viaGatewayStatus()?.publicUrl ?? null, null, "nothing learnt yet");
  const s = await gw.refreshGateway();
  assert.deepEqual(s, { publicUrl: PUBLIC_URL, label: "VPS", reachable: true, accepting: true });
  assert.deepEqual(gw.viaGatewayStatus(), s);
});

test("refreshGateway: a 404 not-gateway is not accepting; a failed hello or info is unreachable", async () => {
  let r = gw.setGatewayDeps({ info: async () => ({ status: 404 }) });
  try {
    assert.equal((await gw.refreshGateway())?.accepting, false);
  } finally {
    r();
  }
  gw.resetGatewayClient();
  r = gw.setGatewayDeps({ info: async () => ({ status: 200, body: { publicUrl: PUBLIC_URL, accepting: false, seq: 3 } }) });
  try {
    assert.equal((await gw.refreshGateway())?.accepting, false, "the gateway says no");
  } finally {
    r();
  }
  gw.resetGatewayClient();
  r = gw.setGatewayDeps({ hello: async () => null, info: async () => null });
  try {
    assert.equal((await gw.refreshGateway())?.reachable, false);
  } finally {
    r();
  }
});

test("viaGatewayStatus is null unless the route is via", async () => {
  await gw.refreshGateway();
  setting = { version: 1, route: "self" };
  assert.equal(gw.viaGatewayStatus(), null);
  setting = { version: 1, route: "off" };
  assert.equal(gw.viaGatewayStatus(), null);
});

test("noteAck: ok learns the URL and acceptance; not-accepted; null is unreachable", () => {
  gw.noteAck(GATEWAY, { ok: true, seq: 1, publicUrl: PUBLIC_URL });
  assert.equal(gw.viaGatewayStatus()?.publicUrl, PUBLIC_URL);
  assert.equal(gw.viaGatewayStatus()?.accepting, true);
  assert.equal(gw.viaGatewayStatus()?.reachable, true);
  gw.noteAck(GATEWAY, { ok: false, error: "not-accepted" });
  assert.equal(gw.viaGatewayStatus()?.accepting, false);
  gw.noteAck(GATEWAY, null);
  assert.equal(gw.viaGatewayStatus()?.reachable, false);
});

test("the gateway client never writes public-links.json", async () => {
  const file = join(stateRoot(), "public-links.json");
  rmSync(file, { force: true });
  await gw.refreshGateway();
  gw.noteAck(GATEWAY, { ok: true, seq: 1, publicUrl: PUBLIC_URL });
  assert.throws(() => statSync(file), "no file appeared");
});

// ---- registry push: the snapshot ----------------------------------------------------------------

test("buildSnapshot: the live h and i hashes, nothing revoked or expired; valid; the ingress port", () => {
  clearStores();
  const now = Date.now();
  const live = batonLinks.mintLink({ orgId: "o1", sessionId: "s1", n: 1, personId: "p1" }, now);
  const revoked = batonLinks.mintLink({ orgId: "o1", sessionId: "s2", n: 1, personId: "p2" }, now);
  batonLinks.revokeLinks((l) => l.sessionId === "s2", now);
  const expired = batonLinks.mintLink({ orgId: "o1", sessionId: "s3", n: 1, personId: "p3" }, now - batonLinks.LINK_TTL_MS - 1000);
  const owner = personLinks.mintOwnerLink("o1", "p1", now).token;
  const snap = push.buildSnapshot(5, now);
  const rows = new Map(snap.links.map((l) => [l.h, l]));
  assert.equal(rows.get(batonLinks.hashToken(live))?.kind, "h");
  assert.equal(rows.get(batonLinks.hashToken(owner))?.kind, "i");
  assert.ok(!rows.has(batonLinks.hashToken(revoked)), "revoked left out");
  assert.ok(!rows.has(batonLinks.hashToken(expired)), "expired left out");
  assert.equal(snap.links.length, 2);
  for (const l of snap.links) assert.ok(!JSON.stringify(l).includes(live) && !JSON.stringify(l).includes(owner), "never a token");
  assert.equal(snap.seq, 5);
  assert.equal(snap.v, 1);
  assert.equal(snap.ingressPort, SHARE_PORT_DEFAULT);
  const check = validateSnapshot(JSON.parse(JSON.stringify(snap)), { now });
  assert.equal(check.ok, true, JSON.stringify(check));
  setting = { ...VIA, ingressPort: 4999 };
  assert.equal(push.buildSnapshot(6, now).ingressPort, 4999);
});

test("buildSnapshot: a rotated owner link drops the old hash", () => {
  clearStores();
  const a = personLinks.mintOwnerLink("o1", "p1").token;
  const b = personLinks.mintOwnerLink("o1", "p1").token;
  const hashes = push.buildSnapshot(1).links.map((l) => l.h);
  assert.ok(hashes.includes(batonLinks.hashToken(b)));
  assert.ok(!hashes.includes(batonLinks.hashToken(a)));
});

test("buildSnapshot: an expiry passing between snapshots drops the row (a sweep needs no event)", () => {
  clearStores();
  const now = Date.now();
  batonLinks.mintLink({ orgId: "o1", sessionId: "s1", n: 1, personId: "p1" }, now);
  assert.equal(push.buildSnapshot(1, now).links.length, 1);
  assert.equal(push.buildSnapshot(2, now + batonLinks.LINK_TTL_MS + 1).links.length, 0);
});

// ---- registry push: seq, outbox, ack outcome ----------------------------------------------------

test("the outbox file: 0600, {v:1, seq, dirty}; seq monotonic across a restart", async () => {
  clearStores();
  writeFileSync(push.outboxFile(), JSON.stringify({ v: 1, seq: 41, dirty: false }), { mode: 0o600 });
  push.startRegistryPush();
  await mintH();
  push.stopRegistryPush();
  assert.ok(pushed.length >= 1);
  assert.ok(pushed[0]!.seq > 41, `seq ${pushed[0]!.seq} continues past the stored 41`);
  const box = JSON.parse(readFileSync(push.outboxFile(), "utf8"));
  assert.equal(box.v, 1);
  assert.ok(box.seq >= pushed.at(-1)!.seq, "the sent seq is persisted");
  assert.equal(box.dirty, false);
  assert.equal(statSync(push.outboxFile()).mode & 0o777, 0o600);
  // "Restart": stop, start again, mint; seq keeps rising.
  const last = pushed.at(-1)!.seq;
  push.startRegistryPush();
  await mintH();
  assert.ok(pushed.at(-1)!.seq > last);
});

test("every pushed snapshot is valid and carries the minted hash", async () => {
  clearStores();
  push.startRegistryPush();
  const { hash } = await mintH();
  const snap = pushed.at(-1)!;
  assert.ok(snap.links.some((l) => l.h === hash && l.kind === "h"));
  assert.equal(validateSnapshot(JSON.parse(JSON.stringify(snap)), { now: Date.now() }).ok, true);
});

test("an ack covering the mint confirms it: no warning, well within the wait", async () => {
  clearStores();
  push.startRegistryPush();
  const { outcome, ms } = await mintH();
  assert.deepEqual(outcome, { warning: null, timedOut: false, failed: false });
  assert.ok(ms < 1000, `${ms} ms`);
});

test("a missing ack: the mint returns within MINT_ACK_TIMEOUT_MS, unconfirmed, and the outbox stays dirty", async () => {
  clearStores();
  // The gateway answers only after the mint's wait (a real push has its own timeout).
  let late!: Promise<null>;
  answer = () => (late = new Promise((r) => setTimeout(() => r(null), MINT_ACK_TIMEOUT_MS + 300)));
  push.startRegistryPush();
  const { outcome, ms } = await mintH();
  assert.ok(ms < MINT_ACK_TIMEOUT_MS + 500, `${ms} ms`);
  assert.ok(outcome.timedOut || outcome.warning === warn("unconfirmed"), JSON.stringify(outcome));
  assert.equal(JSON.parse(readFileSync(push.outboxFile(), "utf8")).dirty, true);
  // Settle the late answer before the next test, then let a good send drain the outbox.
  await late;
  answer = async (s) => ({ ok: true, seq: s.seq, publicUrl: PUBLIC_URL });
  await push.pushNow();
});

test("an unreachable gateway answers at once with a warning, never confirmed; the outbox stays dirty", async () => {
  clearStores();
  answer = async () => null;
  push.startRegistryPush();
  const { outcome, ms } = await mintH();
  assert.ok(ms < 1000, `${ms} ms`);
  assert.ok([warn("unreachable"), warn("unconfirmed")].includes(outcome.warning!), JSON.stringify(outcome));
  assert.equal(JSON.parse(readFileSync(push.outboxFile(), "utf8")).dirty, true);
});

test("a not-accepted ack answers with the not-accepted warning", async () => {
  clearStores();
  answer = async () => ({ ok: false, error: "not-accepted" });
  push.startRegistryPush();
  assert.equal((await mintH()).outcome.warning, warn("not-accepted"));
});

test("a bad-snapshot or not-gateway ack is never confirmed", async () => {
  for (const error of ["bad-snapshot", "not-gateway"] as const) {
    clearStores();
    answer = async () => ({ ok: false, error });
    push.startRegistryPush();
    const { outcome } = await mintH();
    assert.ok(outcome.warning || outcome.timedOut || outcome.failed, `${error}: ${JSON.stringify(outcome)}`);
    push.stopRegistryPush();
  }
});

test("an ack whose collisions name the minted hash leaves it unconfirmed", async () => {
  clearStores();
  answer = async (s) => ({ ok: true, seq: s.seq, publicUrl: PUBLIC_URL, collisions: s.links.map((l) => l.h) });
  push.startRegistryPush();
  const { outcome } = await mintH();
  assert.equal(outcome.warning, warn("unconfirmed"));
});

test("a collision on another hash doesn't unconfirm this mint", async () => {
  clearStores();
  answer = async (s) => ({ ok: true, seq: s.seq, publicUrl: PUBLIC_URL, collisions: ["f".repeat(64)] });
  push.startRegistryPush();
  assert.equal((await mintH()).outcome.warning, null);
});

test("an ack with a seq below the one that carried the mint doesn't confirm it", async () => {
  clearStores();
  answer = async (s) => ({ ok: true, seq: Math.max(0, s.seq - 1), publicUrl: PUBLIC_URL });
  push.startRegistryPush();
  const { outcome } = await mintH(800);
  assert.ok(outcome.timedOut || outcome.warning === warn("unconfirmed"), JSON.stringify(outcome));
});

test("a gateway ahead of us (ack seq > sent): local seq jumps past it and resends", async () => {
  clearStores();
  let first = true;
  answer = async (s) => {
    if (first) {
      first = false;
      return { ok: true, seq: s.seq + 100, publicUrl: PUBLIC_URL };
    }
    return { ok: true, seq: s.seq, publicUrl: PUBLIC_URL };
  };
  push.startRegistryPush();
  await mintH();
  const firstSeq = pushed[0]!.seq;
  await push.pushNow();
  assert.ok(pushed.length >= 2, "it resent");
  assert.ok(pushed.at(-1)!.seq > firstSeq + 100, `resent at ${pushed.at(-1)!.seq}`);
});

test("concurrent mints in one batch are each confirmed by the ack that covers them", async () => {
  clearStores();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  answer = async (s) => (await gate, { ok: true, seq: s.seq, publicUrl: PUBLIC_URL });
  push.startRegistryPush();
  const mints = [mintH(), mintH(), mintH()];
  setTimeout(() => release(), 50);
  const done = await Promise.all(mints);
  for (const d of done) assert.equal(d.outcome.warning, null, JSON.stringify(d.outcome));
  const last = pushed.at(-1)!;
  for (const d of done) assert.ok(last.links.some((l) => l.h === d.hash), "the last snapshot carries every mint");
});

test("the outbox drains: a failed push stays dirty until the next send succeeds", async () => {
  clearStores();
  answer = async () => null;
  push.startRegistryPush();
  const { hash } = await mintH();
  assert.equal(JSON.parse(readFileSync(push.outboxFile(), "utf8")).dirty, true);
  answer = async (s) => ({ ok: true, seq: s.seq, publicUrl: PUBLIC_URL });
  await push.pushNow();
  assert.equal(JSON.parse(readFileSync(push.outboxFile(), "utf8")).dirty, false);
  assert.ok(pushed.at(-1)!.links.some((l) => l.h === hash));
  assert.equal(push.RETRY_MS, 60_000);
});

test("not routed: a mint pushes nothing and has no warning from the push", async () => {
  for (const s of [{ version: 1, route: "off" }, { version: 1, route: "self" }] as PublicLinksFile[]) {
    clearStores();
    setting = s;
    push.startRegistryPush();
    const { outcome } = await mintH();
    assert.equal(outcome.warning, null);
    assert.equal(outcome.timedOut, false);
    assert.equal(pushed.length, 0, JSON.stringify(s.route));
    push.stopRegistryPush();
  }
});

test("stopRegistryPush unsubscribes: a later mint pushes nothing", async () => {
  clearStores();
  push.startRegistryPush();
  await push.pushNow(); // a routed start sends the live set once
  push.stopRegistryPush();
  const before = pushed.length;
  await mintH();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(pushed.length, before);
});

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
    ing.recheck();
    assert.equal(ing.admittedCount(), 1, "the same gateway stays");
    expected = { nodeId: "nNEW" };
    ing.recheck();
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
    ing.recheck();
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
