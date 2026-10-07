// Run: node scripts/run-tests.mjs server/share-ingress.test.ts. A routed host's side of public links
// (§mesh.public/registry push side, §mesh.public/gateway), in process: the gateway client and the
// registry push (snapshot, seq, outbox, the mint's ack outcome). Hermetic: a throwaway
// PI_CODING_AGENT_DIR, a fake LocalAPI (setIdentity), fake gateway deps, no sockets. The ingress over
// real loopback sockets is share-ingress.integration.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  const r = gw.setGatewayDeps({ addressMode: () => true } as never);
  try {
    assert.deepEqual(gw.viaGatewayIdentity(), { nodeId: "nGW", addresses: ["100.64.0.2"] });
  } finally {
    r();
  }
});

test("viaGatewayIdentity in address mode is null when the gateway peer has no tailnet address", () => {
  const r = gw.setGatewayDeps({ addressMode: () => true, peers: () => [{ ...GATEWAY, dnsName: "vps.example.ts.net", url: "http://vps.example.ts.net:4801" }, OTHER] } as never);
  try {
    assert.equal(gw.viaGatewayIdentity(), null);
  } finally {
    r();
  }
});

test("refreshGateway: hello gives the public URL, info the acceptance; viaGatewayStatus caches it", async () => {
  assert.equal(gw.viaGatewayStatus(), null, "nothing learnt yet");
  const s = await gw.refreshGateway();
  assert.deepEqual(s, { publicUrl: PUBLIC_URL, label: "VPS", reachable: true, accepting: true, kinds: null, previewUrl: null });
  assert.deepEqual(gw.viaGatewayStatus(), s);
});

test("refreshGateway: a 404 not-gateway is not accepting; a failed hello or info is unreachable", async () => {
  infoReply = async () => ({ status: 404, body: { error: "not-gateway" } });
  assert.equal((await gw.refreshGateway())?.accepting, false);
  gw.resetGatewayClient();
  infoReply = async () => ({ status: 200, body: { publicUrl: PUBLIC_URL, accepting: false, seq: 3 } });
  assert.equal((await gw.refreshGateway())?.accepting, false, "the gateway says no");
  gw.resetGatewayClient();
  helloReply = async () => null;
  infoReply = async () => null;
  assert.equal((await gw.refreshGateway())?.reachable, false);
});

test("viaGatewayStatus: null until the selected gateway was asked, and null when the via gateway is no peer", async () => {
  assert.equal(gw.viaGatewayStatus(), null, "routed, nothing asked yet");
  await gw.refreshGateway();
  assert.deepEqual(gw.viaGatewayStatus(), { publicUrl: PUBLIC_URL, label: "VPS", reachable: true, accepting: true, kinds: null, previewUrl: null });
  setting = { version: 1, route: { via: { nodeId: "nGONE" } } };
  assert.equal(gw.viaGatewayStatus(), null, "via names no peer");
});

test("viaGatewayStatus is null unless the route is via", async () => {
  await gw.refreshGateway();
  setting = { version: 1, route: "self" };
  assert.equal(gw.viaGatewayStatus(), null);
  setting = { version: 1, route: "off" };
  assert.equal(gw.viaGatewayStatus(), null);
});

test("noteAck: ok learns the URL and acceptance; not-accepted; null is unreachable", () => {
  gw.noteAck(gw.currentTarget()!, { ok: true, seq: 1, publicUrl: PUBLIC_URL }, true);
  assert.equal(gw.viaGatewayStatus()?.publicUrl, PUBLIC_URL);
  assert.equal(gw.viaGatewayStatus()?.accepting, true);
  assert.equal(gw.viaGatewayStatus()?.reachable, true);
  gw.noteAck(gw.currentTarget()!, { ok: false, error: "not-accepted" }, true);
  assert.equal(gw.viaGatewayStatus()?.accepting, false);
  gw.noteAck(gw.currentTarget()!, null, false);
  assert.equal(gw.viaGatewayStatus()?.reachable, false);
});

test("the gateway client never writes public-links.json", async () => {
  const file = join(stateRoot(), "public-links.json");
  rmSync(file, { force: true });
  await gw.refreshGateway();
  gw.noteAck(gw.currentTarget()!, { ok: true, seq: 1, publicUrl: PUBLIC_URL }, true);
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
  const { outcome } = await mintH();
  // Confirmed and not timed out: the ack ended the wait, not MINT_ACK_TIMEOUT_MS.
  assert.deepEqual(outcome, { warning: null, timedOut: false, failed: false });
});

test("a missing ack: the mint returns within MINT_ACK_TIMEOUT_MS, unconfirmed, and the outbox stays dirty", async () => {
  clearStores();
  // The gateway answers only after the mint's wait (a real push has its own timeout).
  let late!: Promise<null>;
  let answered = false;
  answer = () => (late = new Promise<null>((r) => setTimeout(() => r(null), MINT_ACK_TIMEOUT_MS + 300)).then((v) => ((answered = true), v)));
  push.startRegistryPush();
  const { outcome } = await mintH();
  // Back before the gateway's answer, which comes only after the mint's wait: the wait ended it.
  assert.equal(answered, false, "the mint returned before the late answer");
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
  const { outcome } = await mintH();
  // At once: the failed send ended the wait, not MINT_ACK_TIMEOUT_MS.
  assert.equal(outcome.timedOut, false, JSON.stringify(outcome));
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
  let sent = 0;
  answer = async (s) => (sent++, await gate, { ok: true, seq: s.seq, publicUrl: PUBLIC_URL });
  push.startRegistryPush();
  const mints = [mintH(), mintH(), mintH()];
  // The batch is at the gateway, its answer held: let it answer.
  for (const end = Date.now() + 10_000; sent === 0; await new Promise((r) => setTimeout(r, 5))) assert.ok(Date.now() < end, "the push reached the gateway");
  release();
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

// =================================================================================================
// M4 review (astra, B1-B5): each fails on the reviewed M4, passes on the fix.
// =================================================================================================

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

// ---- B1: a mint is confirmed only when its own hash was sent and didn't collide ----------------

/** Two mints, each in its own awaitShareLinks, started without awaiting between them (both land
    before either listener runs). */
function mintTwo() {
  let a = "";
  let b = "";
  const pa = events.awaitShareLinks(() => {
    a = batonLinks.mintLink({ orgId: "o1", sessionId: `sa-${Math.random()}`, n: 1, personId: "p1" });
  }, WAIT);
  const pb = events.awaitShareLinks(() => {
    b = batonLinks.mintLink({ orgId: "o1", sessionId: `sb-${Math.random()}`, n: 1, personId: "p1" });
  }, WAIT);
  return { hashA: () => batonLinks.hashToken(a), hashB: () => batonLinks.hashToken(b), pa, pb };
}

test("B1(i) concurrent mints A then B, only B's hash colliding: B warns", async () => {
  clearStores();
  push.startRegistryPush();
  await push.pushNow();
  const m = mintTwo();
  answer = async (s, node) => ({ ok: true, seq: s.seq, publicUrl: urlOf(node), collisions: s.links.some((l) => l.h === m.hashB()) ? [m.hashB()] : [] });
  const [, b] = await Promise.all([m.pa, m.pb]);
  assert.equal(b.outcome.warning, warn("unconfirmed"), JSON.stringify(b.outcome));
});

test("B1(i) concurrent mints A then B, only A's hash colliding: A warns", async () => {
  clearStores();
  push.startRegistryPush();
  await push.pushNow();
  const m = mintTwo();
  answer = async (s, node) => ({ ok: true, seq: s.seq, publicUrl: urlOf(node), collisions: s.links.some((l) => l.h === m.hashA()) ? [m.hashA()] : [] });
  const [a] = await Promise.all([m.pa, m.pb]);
  assert.equal(a.outcome.warning, warn("unconfirmed"), JSON.stringify(a.outcome));
});

test("B1(ii) a mint whose row the byte cap trims out of the snapshot warns", async () => {
  clearStores();
  // ~6000 rows expiring in 10 days: past SNAPSHOT_MAX_BYTES, so the soonest-expiring are cut.
  const now = Date.now();
  const rows = Array.from({ length: 6000 }, (_, i) => ({
    hash: i.toString(16).padStart(64, "0"),
    orgId: "o1",
    sessionId: `bulk-${i}`,
    n: 1,
    personId: "p1",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 10 * 86_400_000).toISOString(),
  }));
  mkdirSync(stateRoot(), { recursive: true });
  writeFileSync(join(stateRoot(), "baton-links.json"), JSON.stringify({ version: 1, links: rows }), { mode: 0o600 });
  push.startRegistryPush();
  await push.pushNow();
  // Minted 13 days ago: it expires in a day, the soonest of all, so it is the one left out.
  const { hash, outcome } = await mintH(WAIT, now - 13 * 86_400_000);
  assert.ok(!pushed.at(-1)!.links.some((l) => l.h === hash), "the test's premise: the row was trimmed");
  assert.equal(outcome.warning, warn("unconfirmed"), JSON.stringify(outcome));
});

test("B1(iii) a mint revoked before the snapshot carrying it is sent warns", async () => {
  clearStores();
  const first = deferred<RegistryAck | null>();
  let n = 0;
  answer = async (s, node) => (n++ === 0 ? first.promise : { ok: true, seq: s.seq, publicUrl: urlOf(node) });
  push.startRegistryPush(); // its first send is held
  await tick();
  let token = "";
  const p = events.awaitShareLinks(() => {
    token = batonLinks.mintLink({ orgId: "o1", sessionId: "s-revoke", n: 1, personId: "p1" });
  }, WAIT);
  await tick(); // its listener has read the live set
  batonLinks.revokeLinks((l) => l.sessionId === "s-revoke");
  const firstSnap = pushed[0]!;
  first.resolve({ ok: true, seq: firstSnap.seq, publicUrl: PUBLIC_URL });
  const { outcome } = await p;
  assert.ok(!pushed.at(-1)!.links.some((l) => l.h === batonLinks.hashToken(token)), "premise: the carrying snapshot lacks it");
  assert.equal(outcome.warning, warn("unconfirmed"), JSON.stringify(outcome));
});

test("B1(iv) control: an earlier ack's collision on another hash doesn't unconfirm a later clean mint", async () => {
  clearStores();
  push.startRegistryPush();
  let x = "";
  answer = async (s, node) => ({ ok: true, seq: s.seq, publicUrl: urlOf(node), collisions: x && s.links.some((l) => l.h === x) ? [x] : [] });
  const first = await mintH(WAIT);
  x = first.hash;
  await push.pushNow(); // the gateway now reports x colliding, on every ack
  const later = await mintH(WAIT);
  assert.equal(later.outcome.warning, null, JSON.stringify(later.outcome));
});

// ---- B3: a gateway change invalidates the old gateway's pending answers --------------------------

test("B3 A's late ok ack after via moved to B confirms nothing; B gets a snapshot, and B's ack confirms", async () => {
  clearStores();
  const heldA = deferred<RegistryAck | null>();
  const heldB = deferred<void>();
  let holdA = false;
  answer = async (s, node) => {
    if (node === "nGW") return holdA ? heldA.promise : { ok: true, seq: s.seq, publicUrl: PUBLIC_URL };
    await heldB.promise;
    return { ok: true, seq: s.seq, publicUrl: DESK_URL };
  };
  push.startRegistryPush();
  await push.pushNow(); // A is current and idle
  holdA = true;
  const p = mintH(WAIT); // its snapshot goes to A, and A's answer is held
  for (const end = Date.now() + 10_000; !((pushed.at(-1)?.links.length ?? 0) > 0 && pushedTo.at(-1) === "nGW"); await new Promise((r) => setTimeout(r, 5)))
    assert.ok(Date.now() < end, "the mint's snapshot reached A");
  assert.ok(pushed.at(-1)!.links.length > 0 && pushedTo.at(-1) === "nGW", "premise: the mint rides A's held send");
  setting = { version: 1, route: { via: { nodeId: "nDESK" } } };
  push.registryRouteChanged();
  const aSeq = pushed.filter((_, i) => pushedTo[i] === "nGW").at(-1)!.seq;
  heldA.resolve({ ok: true, seq: aSeq, publicUrl: PUBLIC_URL });
  // A's ok ack for the seq that carried the mint arrived: it must not confirm it.
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(await settlesWithin(p, 200), false, "the mint still waits for B");
  assert.notEqual(gw.viaGatewayStatus()?.publicUrl, PUBLIC_URL, "the status is not A's");
  for (const end = Date.now() + 10_000; !pushedTo.includes("nDESK"); await new Promise((r) => setTimeout(r, 5))) assert.ok(Date.now() < end, "B's snapshot");
  assert.ok(pushedTo.includes("nDESK"), "B received a snapshot");
  heldB.resolve();
  const { outcome } = await p;
  assert.equal(outcome.warning, null, `B's ack confirms: ${JSON.stringify(outcome)}`);
});

test("B3 route turned off while a mint waits: the mint warns", async () => {
  clearStores();
  const heldA = deferred<RegistryAck | null>();
  answer = async () => heldA.promise;
  push.startRegistryPush();
  await tick();
  const p = mintH(WAIT);
  await tick();
  setting = { version: 1, route: "off" };
  push.registryRouteChanged();
  heldA.resolve({ ok: true, seq: pushed.at(-1)!.seq, publicUrl: PUBLIC_URL });
  const { outcome } = await p;
  assert.ok(outcome.warning, `warned: ${JSON.stringify(outcome)}`);
});

test("B3 the gateway removed from peers while a mint waits: the mint warns", async () => {
  clearStores();
  const heldA = deferred<RegistryAck | null>();
  answer = async () => heldA.promise;
  push.startRegistryPush();
  await tick();
  const p = mintH(WAIT);
  await tick();
  peers = [OTHER];
  void push.pushNow();
  heldA.resolve({ ok: true, seq: pushed.at(-1)!.seq, publicUrl: PUBLIC_URL });
  const { outcome } = await p;
  assert.ok(outcome.warning, `warned: ${JSON.stringify(outcome)}`);
});

// ---- B4: strict reply and setting parsing --------------------------------------------------------

const H = "a".repeat(64);
test("B4 parseAck: only the contract's shapes, with the right HTTP status", () => {
  const good = { ok: true, seq: 3, publicUrl: PUBLIC_URL };
  assert.deepEqual(gw.parseAck({ status: 200, body: good }), good);
  assert.deepEqual(gw.parseAck({ status: 200, body: { ...good, collisions: [H] } }), { ...good, collisions: [H] });
  assert.deepEqual(gw.parseAck({ status: 403, body: { ok: false, error: "not-accepted" } }), { ok: false, error: "not-accepted" });
  const bad: [string, { status: number; body: unknown } | null][] = [
    ["null", null],
    ["not JSON", { status: 200, body: undefined }],
    ["seq missing", { status: 200, body: { ok: true, publicUrl: PUBLIC_URL } }],
    ["seq -1", { status: 200, body: { ...good, seq: -1 } }],
    ["seq 1.5", { status: 200, body: { ...good, seq: 1.5 } }],
    ["seq string", { status: 200, body: { ...good, seq: "3" } }],
    ["publicUrl missing", { status: 200, body: { ok: true, seq: 3 } }],
    ["publicUrl http", { status: 200, body: { ...good, publicUrl: "http://share.example.com" } }],
    ["publicUrl with a path", { status: 200, body: { ...good, publicUrl: "https://share.example.com/x" } }],
    ["publicUrl garbage", { status: 200, body: { ...good, publicUrl: "not a url" } }],
    ["an extra key", { status: 200, body: { ...good, extra: 1 } }],
    ["collisions not an array", { status: 200, body: { ...good, collisions: H } }],
    ["a collision that is an object", { status: 200, body: { ...good, collisions: [{ h: H }] } }],
    ["a collision that is a number", { status: 200, body: { ...good, collisions: [1] } }],
    ["a collision not 64-hex", { status: 200, body: { ...good, collisions: ["abc"] } }],
    ["ok true on HTTP 500", { status: 500, body: good }],
    ["ok true on HTTP 404", { status: 404, body: good }],
    ["an unknown error", { status: 403, body: { ok: false, error: "nope" } }],
    ["a known error on HTTP 500", { status: 500, body: { ok: false, error: "bad-snapshot" } }],
    ["a failure with an extra key", { status: 403, body: { ok: false, error: "not-accepted", why: "x" } }],
    ["ok missing", { status: 200, body: { seq: 3, publicUrl: PUBLIC_URL } }],
    ["an array", { status: 200, body: [good] }],
  ];
  for (const [name, reply] of bad) assert.equal(gw.parseAck(reply), null, name);
});

test("B4 parseInfo: GatewayInfo, not-gateway, or null", () => {
  const good = { publicUrl: PUBLIC_URL, accepting: true, seq: null };
  assert.deepEqual(gw.parseInfo({ status: 200, body: good }), good);
  assert.deepEqual(gw.parseInfo({ status: 200, body: { ...good, seq: 4 } }), { ...good, seq: 4 });
  assert.equal(gw.parseInfo({ status: 404, body: { error: "not-gateway" } }), "not-gateway");
  const bad: [string, { status: number; body: unknown } | null][] = [
    ["null", null],
    ["accepting missing", { status: 200, body: { publicUrl: PUBLIC_URL, seq: null } }],
    ["accepting a string", { status: 200, body: { ...good, accepting: "yes" } }],
    ["seq -1", { status: 200, body: { ...good, seq: -1 } }],
    ["publicUrl http", { status: 200, body: { ...good, publicUrl: "http://share.example.com" } }],
    ["publicUrl missing", { status: 200, body: { accepting: true, seq: null } }],
    ["an extra key", { status: 200, body: { ...good, extra: 1 } }],
    ["HTTP 500", { status: 500, body: good }],
    ["404 with another error", { status: 404, body: { error: "nope" } }],
  ];
  for (const [name, reply] of bad) assert.equal(gw.parseInfo(reply), null, name);
});

test("B4 an invalid ack through the push confirms nothing and leaves the status as it was", async () => {
  clearStores();
  push.startRegistryPush();
  await push.pushNow();
  await gw.refreshGateway();
  const before = gw.viaGatewayStatus();
  rawReply = async (s) => ({ status: 200, body: { ok: true, seq: s.seq, publicUrl: "http://evil.example", collisions: [{ h: 1 }] } });
  const { outcome } = await mintH(WAIT);
  assert.ok(outcome.warning || outcome.timedOut, `not confirmed: ${JSON.stringify(outcome)}`);
  assert.deepEqual(gw.viaGatewayStatus(), before, "status unchanged");
});

test("B4 a public-links.json the strict reader rejects (an unknown key): nothing binds, nothing pushes", async () => {
  clearStores();
  const file = join(stateRoot(), "public-links.json");
  mkdirSync(stateRoot(), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, route: { via: { nodeId: "nGW" } }, extra: 1 }), { mode: 0o600 });
  const quiet = console.warn;
  console.warn = () => {};
  try {
    await withDefaults(["readSetting"], async () => {
      assert.equal(gw.viaGatewayPeer(), null, "not routed");
      push.startRegistryPush();
      await push.pushNow();
      await mintH(WAIT);
      push.stopRegistryPush();
      assert.equal(pushed.length, 0, "nothing pushed");
      await ingress.startIngress();
      assert.equal(ingress.ingressInfo(), null, "nothing bound");
      ingress.stopIngress();
    });
  } finally {
    console.warn = quiet;
    rmSync(file, { force: true });
  }
});

// ---- B5: calls go to the address bound to the gateway's StableID ---------------------------------

const EVIL: PeerEntry = { ...GATEWAY, dnsName: "evil.example" };
function statusWith(nodes: { nodeId: string; addresses: string[] }[]) {
  setIdentity({
    whois: fakeIdentity.whois,
    status: async () => ({
      backendState: "Running",
      self: { nodeId: "nSELF", name: "self", hostName: "self", os: "linux", online: true, tags: [], login: "me", addresses: ["100.64.0.9"] },
      peers: nodes.map((n) => ({ ...n, name: n.nodeId, hostName: n.nodeId, os: "linux", online: true, tags: [], login: "me" })),
    }),
  });
}
/** Every call made, as its origin (the fake `call` answers anything by its path). */
function anyCall() {
  const seen: string[] = [];
  const call = async (url: string, init?: RequestInit): Promise<Reply> => {
    seen.push(url);
    const path = new URL(url).pathname;
    if (path === "/api/peer/hello") return helloOk("nGW");
    if (path === "/api/peer/share-gateway/info") return infoOk("nGW");
    if (path === "/api/peer/share-gateway/links") return pushReply("nGW", JSON.parse(String(init?.body)));
    return null;
  };
  return { seen, call };
}

test("B5 the default endpoint is the tailnet IP LocalAPI lists for the StableID, never the entry's name", async () => {
  peers = [EVIL, OTHER];
  statusWith([{ nodeId: "nGW", addresses: ["100.64.0.2", "fd7a:115c:a1e0::2"] }]);
  const port = new URL(peerUrl(EVIL)).port;
  const c = anyCall();
  await withDefaults(["endpoint", "hello", "info", "push"], async () => {
    const undo = gw.setGatewayDeps({ call: c.call } as never);
    try {
      await gw.refreshGateway();
      clearStores();
      push.startRegistryPush();
      await mintH(WAIT);
      push.stopRegistryPush();
    } finally {
      undo();
    }
  });
  assert.ok(c.seen.length > 0, "calls were made");
  for (const u of c.seen) assert.ok(u.startsWith(`http://100.64.0.2${port ? `:${port}` : ""}/`), u);
  assert.ok(!c.seen.some((u) => u.includes("evil.example")));
});

test("B5 a StableID LocalAPI doesn't list: no call is made, and a mint is unreachable", async () => {
  peers = [EVIL, OTHER];
  statusWith([{ nodeId: "nSOMEONE", addresses: ["100.64.0.2"] }]);
  const c = anyCall();
  let outcome: Awaited<ReturnType<typeof mintH>>["outcome"] | undefined;
  await withDefaults(["endpoint", "hello", "info", "push"], async () => {
    const undo = gw.setGatewayDeps({ call: c.call } as never);
    try {
      clearStores();
      push.startRegistryPush();
      outcome = (await mintH(WAIT)).outcome;
      push.stopRegistryPush();
    } finally {
      undo();
    }
  });
  assert.deepEqual(c.seen, [], "nothing was called");
  assert.equal(outcome?.warning, warn("unreachable"), JSON.stringify(outcome));
});

test("B5 address mode: the entry's own tailnet IP; none, no call", async () => {
  for (const [entry, want] of [
    [{ ...GATEWAY, dnsName: "100.64.0.5" }, "100.64.0.5"],
    [EVIL, null],
  ] as [PeerEntry, string | null][]) {
    peers = [entry, OTHER];
    const c = anyCall();
    await withDefaults(["endpoint", "hello", "info", "push"], async () => {
      const undo = gw.setGatewayDeps({ call: c.call, addressMode: () => true } as never);
      try {
        await gw.refreshGateway();
      } finally {
        undo();
      }
    });
    if (want === null) assert.deepEqual(c.seen, [], `${entry.dnsName}: no call`);
    else {
      assert.ok(c.seen.length > 0, "called");
      for (const u of c.seen) assert.equal(new URL(u).hostname, want, u);
    }
  }
});

// =================================================================================================
// M4 re-review (astra v2): B1, B3 and B4's remaining windows.
// =================================================================================================

// ---- B1 v2: a mint gone before its listener ran never counts as confirmed ------------------------

test("B1v2(a) an owner link rotated by a second mint in the same tick: the first (never sent) warns", async () => {
  clearStores();
  push.startRegistryPush();
  await push.pushNow();
  const pA = events.awaitShareLinks(() => personLinks.mintOwnerLink("oRot", "pRot").token, WAIT);
  const pB = events.awaitShareLinks(() => personLinks.mintOwnerLink("oRot", "pRot").token, WAIT);
  const [a] = await Promise.all([pA, pB]);
  const hashA = batonLinks.hashToken(a.result);
  assert.ok(!pushed.some((snap) => snap.links.some((l) => l.h === hashA)), "premise: no snapshot carried A");
  assert.equal(a.outcome.warning, warn("unconfirmed"), JSON.stringify(a.outcome));
});

test("B1v2(b) a mint revoked in the same tick, before any listener ran: it warns", async () => {
  clearStores();
  push.startRegistryPush();
  await push.pushNow();
  const r = await events.awaitShareLinks(() => {
    const t = batonLinks.mintLink({ orgId: "o1", sessionId: "s-gone", n: 1, personId: "p1" });
    batonLinks.revokeLinks((l) => l.sessionId === "s-gone");
    return t;
  }, WAIT);
  assert.ok(!pushed.some((snap) => snap.links.some((l) => l.h === batonLinks.hashToken(r.result))), "premise: never sent");
  assert.equal(r.outcome.warning, warn("unconfirmed"), JSON.stringify(r.outcome));
});

test("B1v2 control: one clean mint alone is confirmed", async () => {
  clearStores();
  push.startRegistryPush();
  await push.pushNow();
  assert.equal((await mintH(WAIT)).outcome.warning, null);
});

test("B1v2 control: two unrelated clean mints in one tick are both confirmed", async () => {
  clearStores();
  push.startRegistryPush();
  await push.pushNow();
  const m = mintTwo();
  const [a, b] = await Promise.all([m.pa, m.pb]);
  assert.equal(a.outcome.warning, null, JSON.stringify(a.outcome));
  assert.equal(b.outcome.warning, null, JSON.stringify(b.outcome));
});

// ---- B3 v2: a target withdrawn while its address is being resolved gets no call ------------------

/** Hold the endpoint of calls for `node`; `resolve()` releases every held one. */
function holdEndpoint(node: string) {
  const waiting: (() => void)[] = [];
  let asked = 0;
  endpointHook = async (p, base) => {
    if (p.nodeId !== node || released) return base;
    asked++;
    await new Promise<void>((r) => waiting.push(r));
    return base;
  };
  let released = false;
  return {
    asked: () => asked,
    resolve: () => {
      released = true;
      for (const w of waiting.splice(0)) w();
    },
  };
}
const callsTo = (pattern: RegExp, from = 0) => calls.slice(from).filter((u) => pattern.test(u));
/** Resolves once `cond` holds; throws after `ms` (a hang guard, not a bound). */
async function until(cond: () => boolean, what: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const settleAll = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 10));
};

test("B3v2(a) via A → B while A's endpoint resolves: zero calls to A, B gets the snapshot, no A status", async () => {
  clearStores();
  push.startRegistryPush();
  await push.pushNow();
  const held = holdEndpoint("nGW");
  const p = mintH(WAIT);
  await until(() => held.asked() > 0, "A's endpoint asked");
  setting = { version: 1, route: { via: { nodeId: "nDESK" } } };
  gw.bumpRouteGeneration?.();
  push.registryRouteChanged();
  const mark = calls.length;
  held.resolve();
  await p;
  await until(() => pushedTo.includes("nDESK"), "B's snapshot");
  await settleAll();
  assert.deepEqual(callsTo(/gw-nGW\./, mark), [], "nothing went to A after it was withdrawn");
  assert.ok(pushedTo.includes("nDESK"), "B got a snapshot");
  assert.notEqual(gw.viaGatewayStatus()?.publicUrl, PUBLIC_URL, "no A status");
});

test("B3v2(b) via A → off while A's endpoint resolves: zero calls to A, the mint warns", async () => {
  clearStores();
  push.startRegistryPush();
  await push.pushNow();
  const held = holdEndpoint("nGW");
  const p = mintH(WAIT);
  await until(() => held.asked() > 0, "A's endpoint asked");
  setting = { version: 1, route: "off" };
  gw.bumpRouteGeneration?.();
  push.registryRouteChanged();
  const mark = calls.length;
  held.resolve();
  const { outcome } = await p;
  await settleAll();
  assert.deepEqual(callsTo(/gw-nGW\./, mark), [], "nothing went to A");
  assert.ok(outcome.warning, `warned: ${JSON.stringify(outcome)}`);
});

test("B3v2(c) the same node's peer-listener port changed while its endpoint resolves: no call to the old port; the next send uses the new one", async () => {
  clearStores();
  peers = [{ ...GATEWAY, url: "http://100.64.0.2:4801" }, OTHER];
  push.startRegistryPush();
  await push.pushNow();
  const held = holdEndpoint("nGW");
  const p = mintH(WAIT);
  await until(() => held.asked() > 0, "the endpoint asked");
  peers = [{ ...GATEWAY, url: "http://100.64.0.2:4899" }, OTHER];
  const mark = calls.length;
  held.resolve();
  await p;
  await push.pushNow();
  await settleAll();
  assert.deepEqual(callsTo(/:4801\//, mark), [], "nothing to the old port");
  assert.ok(callsTo(/:4899\/api\/peer\/share-gateway\/links$/, mark).length > 0, "the next send went to the new port");
});

test("B3v2(d) address mode: the entry's pinned address changed while its endpoint resolves: no call to the old pin", async () => {
  clearStores();
  addrMode = true;
  push.startRegistryPush();
  await push.pushNow();
  const held = holdEndpoint("nGW");
  const p = mintH(WAIT);
  await until(() => held.asked() > 0, "the endpoint asked");
  peers = [{ ...GATEWAY, dnsName: "100.64.0.7" }, OTHER];
  const mark = calls.length;
  held.resolve();
  await p;
  await push.pushNow();
  await settleAll();
  assert.deepEqual(callsTo(/100-64-0-2\./, mark), [], "nothing to the old pin");
  assert.ok(callsTo(/100-64-0-7\..*\/api\/peer\/share-gateway\/links$/, mark).length > 0, "the next send went to the new pin");
});

// ---- B4 v2: URL spellings that normalization would erase ----------------------------------------

test("B4v2 parseAck and parseInfo refuse a publicUrl that only becomes an origin after normalization", () => {
  const bad = ["https://share.example.com/private/..", "https://share.example.com/%2e", "https:share.example.com", "https://share.example.com\\private", "https://share.example.com\\"];
  for (const u of bad) {
    assert.equal(gw.parseAck({ status: 200, body: { ok: true, seq: 1, publicUrl: u } }), null, `ack ${u}`);
    assert.equal(gw.parseInfo({ status: 200, body: { publicUrl: u, accepting: true, seq: null } }), null, `info ${u}`);
  }
  for (const u of ["https://share.example.com", "https://share.example.com/"]) {
    assert.equal((gw.parseAck({ status: 200, body: { ok: true, seq: 1, publicUrl: u } }) as { publicUrl?: string } | null)?.publicUrl, PUBLIC_URL, `ack ${u}`);
    assert.equal((gw.parseInfo({ status: 200, body: { publicUrl: u, accepting: true, seq: null } }) as { publicUrl?: string } | null)?.publicUrl, PUBLIC_URL, `info ${u}`);
  }
});

// ---- non-blocking: an ambiguous StableID in LocalAPI ---------------------------------------------

test("two LocalAPI node records with the gateway's StableID: no endpoint, no call", async () => {
  peers = [EVIL, OTHER];
  statusWith([
    { nodeId: "nGW", addresses: ["100.64.0.2"] },
    { nodeId: "nGW", addresses: ["100.64.0.12"] },
  ]);
  const c = anyCall();
  await withDefaults(["endpoint", "hello", "info", "push"], async () => {
    const undo = gw.setGatewayDeps({ call: c.call } as never);
    try {
      await gw.refreshGateway();
    } finally {
      undo();
    }
  });
  assert.deepEqual(c.seen, []);
});

// ---- B1 v3: a hash minted while publishing was off is no later mint's candidate ------------------

test("B1v3 a link minted while off can't stand in for a later mint that was never sent: it warns", async () => {
  clearStores();
  setting = { version: 1, route: "off" };
  push.startRegistryPush();
  await mintH(WAIT); // X: minted while nothing is published
  setting = VIA;
  gw.bumpRouteGeneration?.();
  push.registryRouteChanged();
  const r = await events.awaitShareLinks(() => {
    const t = batonLinks.mintLink({ orgId: "o1", sessionId: "s-y", n: 1, personId: "p1" });
    batonLinks.revokeLinks((l) => l.sessionId === "s-y");
    return t;
  }, WAIT);
  assert.ok(!pushed.some((snap) => snap.links.some((l) => l.h === batonLinks.hashToken(r.result))), "premise: Y was never sent");
  assert.equal(r.outcome.warning, warn("unconfirmed"), JSON.stringify(r.outcome));
});

test("B1v3 control: after switching from off to via, a clean mint is confirmed", async () => {
  clearStores();
  setting = { version: 1, route: "off" };
  push.startRegistryPush();
  await mintH(WAIT);
  setting = VIA;
  gw.bumpRouteGeneration?.();
  push.registryRouteChanged();
  await push.pushNow();
  assert.equal((await mintH(WAIT)).outcome.warning, null);
});

// ---- B1 v3: a hash minted while publishing was off is no later mint's candidate ------------------

test("B1v3 a link minted while off can't stand in for a later mint that was never sent: it warns", async () => {
  clearStores();
  setting = { version: 1, route: "off" };
  push.startRegistryPush();
  await mintH(WAIT); // X: minted while nothing is published
  setting = VIA;
  gw.bumpRouteGeneration?.();
  push.registryRouteChanged();
  const r = await events.awaitShareLinks(() => {
    const t = batonLinks.mintLink({ orgId: "o1", sessionId: "s-y", n: 1, personId: "p1" });
    batonLinks.revokeLinks((l) => l.sessionId === "s-y");
    return t;
  }, WAIT);
  assert.ok(!pushed.some((snap) => snap.links.some((l) => l.h === batonLinks.hashToken(r.result))), "premise: Y was never sent");
  assert.equal(r.outcome.warning, warn("unconfirmed"), JSON.stringify(r.outcome));
});

test("B1v3 control: after switching from off to via, a clean mint is confirmed", async () => {
  clearStores();
  setting = { version: 1, route: "off" };
  push.startRegistryPush();
  await mintH(WAIT);
  setting = VIA;
  gw.bumpRouteGeneration?.();
  push.registryRouteChanged();
  await push.pushNow();
  assert.equal((await mintH(WAIT)).outcome.warning, null);
});

// ---- session links (kind `s`) and the gateway's kinds: the version-skew gate ---------------------

const sessionShares = await import("./session-shares");

/** Mint a session share the way the route does: inside awaitShareLinks (the store emits the change). */
async function mintS(waitMs?: number) {
  const { result, outcome } = await events.awaitShareLinks(
    () =>
      sessionShares.createShare({
        sessionId: `sess-${Math.random()}`,
        sessionPath: "/nonexistent/session.jsonl",
        title: "A shared session",
        mode: "snapshot",
        cut: { entryId: "e1", at: null },
        days: 30,
        labels: ["Ana"],
        anyone: false,
      }),
    waitMs,
  );
  return { hash: batonLinks.hashToken(result.tokens[0]!.token), outcome };
}

const infoWithKinds = (node: string, kinds: string[]): Reply => ({ status: 200, body: { publicUrl: urlOf(node), accepting: true, seq: null, kinds } });

test("parseInfo: kinds is optional; known kinds are kept, unknown ones dropped; a malformed list is no answer", () => {
  const good = { publicUrl: PUBLIC_URL, accepting: true, seq: null };
  assert.deepEqual(gw.parseInfo({ status: 200, body: good }), good, "an older gateway: no kinds");
  assert.deepEqual(gw.parseInfo({ status: 200, body: { ...good, kinds: ["h", "i", "s", "x"] } }), { ...good, kinds: ["h", "i", "s", "x"] });
  assert.deepEqual(gw.parseInfo({ status: 200, body: { ...good, kinds: ["h", "zz", "s"] } }), { ...good, kinds: ["h", "s"] });
  assert.equal(gw.parseInfo({ status: 200, body: { ...good, kinds: "s" } }), null);
  assert.equal(gw.parseInfo({ status: 200, body: { ...good, kinds: [1] } }), null);
});

test("the routed host asks its gateway's info with ?kinds=1&preview=1", async () => {
  await gw.refreshGateway();
  assert.ok(calls.some((u) => u.endsWith("/api/peer/share-gateway/info?kinds=1&preview=1")), calls.join("\n"));
});

test("version skew: a gateway whose info lists no kinds never receives an `s` row; h and i links still route and confirm", async () => {
  clearStores();
  rmSync(join(stateRoot(), "session-shares.json"), { force: true });
  infoReply = async (n) => infoOk(n); // an older gateway: no `kinds`
  push.startRegistryPush();
  await gw.refreshGateway();
  const s = await mintS(WAIT);
  const h = await mintH(WAIT);
  await push.pushNow();
  assert.ok(pushed.length >= 1, "something was pushed");
  for (const snap of pushed) assert.ok(!snap.links.some((l) => l.kind === "s"), `seq ${snap.seq} carries no s row`);
  assert.ok(!pushed.some((snap) => snap.links.some((l) => l.h === s.hash)), "the session hash never left");
  assert.ok(pushed.at(-1)!.links.some((l) => l.h === h.hash && l.kind === "h"), "the hand-off link still routes");
  assert.equal(h.outcome.warning, null, "the hand-off mint is confirmed");
  assert.notEqual(s.outcome.warning, null, "the session mint is never confirmed");
  assert.equal(push.gatewayRoutesSessions(), false);
});

test("a gateway whose info lists `s` gets the session rows; one that starts listing it is sent them without a mint", async () => {
  clearStores();
  rmSync(join(stateRoot(), "session-shares.json"), { force: true });
  infoReply = async (n) => infoOk(n);
  push.startRegistryPush();
  await gw.refreshGateway();
  const s = await mintS(WAIT);
  assert.ok(!pushed.some((snap) => snap.links.some((l) => l.h === s.hash)), "premise: not sent to the older gateway");
  // The gateway is updated: the next refresh learns `s` and owes it the session rows.
  infoReply = async (n) => infoWithKinds(n, ["h", "i", "s", "x"]);
  push.registryRouteChanged();
  await until(() => push.gatewayRoutesSessions(), "the refresh learnt `s`");
  await push.pushNow();
  assert.equal(push.gatewayRoutesSessions(), true);
  assert.ok(pushed.at(-1)!.links.some((l) => l.h === s.hash && l.kind === "s"), "the session row is sent");
  assert.equal(validateSnapshot(JSON.parse(JSON.stringify(pushed.at(-1)!)), { now: Date.now() }).ok, true);
  // And a later mint is confirmed like any other.
  const again = await mintS(WAIT);
  assert.equal(again.outcome.warning, null, JSON.stringify(again.outcome));
});

// ---- review M0 B1: the `s` capability is bound to the exact target that stated it ----------------

test("M0-B1 a same-node endpoint change forgets `s`: until the new endpoint states it, no snapshot carries an s row, and h still confirms", async () => {
  clearStores();
  rmSync(join(stateRoot(), "session-shares.json"), { force: true });
  infoReply = async (n) => infoWithKinds(n, ["h", "i", "s", "x"]);
  push.startRegistryPush();
  await gw.refreshGateway();
  assert.equal(push.gatewayRoutesSessions(), true, "premise: the first endpoint stated s");
  // The same StableID now answers at another address, an older service whose info is slow.
  peers = [{ ...GATEWAY, dnsName: "100.64.0.99" }, OTHER];
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let heldAnswered = false;
  infoReply = async (n) => {
    await held;
    heldAnswered = true;
    return infoOk(n);
  };
  gw.bumpRouteGeneration?.();
  push.registryRouteChanged();
  const before = pushed.length;
  const s = await mintS(WAIT);
  const h = await mintH(WAIT);
  await push.pushNow();
  const toNew = pushed.slice(before);
  assert.ok(toNew.length >= 1, "something was sent to the new endpoint");
  for (const snap of toNew) assert.ok(!snap.links.some((l) => l.kind === "s"), `seq ${snap.seq} carries no s row`);
  assert.equal(h.outcome.warning, null, "h still confirms");
  assert.notEqual(s.outcome.warning, null, "the session mint is not confirmed");
  release();
  // The held info answered, and what it runs has run (the loop turned once after it).
  await until(() => heldAnswered, "the held info answered");
  await new Promise((r) => setImmediate(r));
  assert.equal(push.gatewayRoutesSessions(), false, "the old-shaped info never lent it s");
});

test("M0-B1 support withdrawn between building a snapshot and sending it: the s-bearing snapshot never leaves", async () => {
  clearStores();
  rmSync(join(stateRoot(), "session-shares.json"), { force: true });
  infoReply = async (n) => infoWithKinds(n, ["h", "i", "s", "x"]);
  push.startRegistryPush();
  await gw.refreshGateway();
  await push.pushNow();
  // Hold the endpoint resolution of the next send; meanwhile the gateway says it no longer routes s.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let holding = true;
  endpointHook = async (_p, base) => {
    if (holding) {
      holding = false;
      await held;
    }
    return base;
  };
  const before = pushed.length;
  const minting = mintS(WAIT);
  await until(() => !holding, "the send is at its endpoint, held");
  endpointHook = null;
  infoReply = async (n) => infoOk(n);
  await gw.refreshGateway();
  assert.equal(push.gatewayRoutesSessions(), false);
  release();
  await minting;
  await push.pushNow();
  assert.ok(pushed.length > before, "premise: a snapshot went out after the release");
  for (const snap of pushed.slice(before)) assert.ok(!snap.links.some((l) => l.kind === "s"), `seq ${snap.seq} carries no s row`);
});

test("M0-B1 a bad-snapshot refusal of a snapshot with s rows: s is forgotten and the h/i set goes again at once", async () => {
  clearStores();
  rmSync(join(stateRoot(), "session-shares.json"), { force: true });
  infoReply = async (n) => infoWithKinds(n, ["h", "i", "s", "x"]);
  // A gateway that claims s but refuses it (an older validator behind a newer info route).
  answer = async (snap, node) => (snap.links.some((l) => l.kind === "s") ? { ok: false, error: "bad-snapshot" } : { ok: true, seq: snap.seq, publicUrl: urlOf(node) });
  push.startRegistryPush();
  await gw.refreshGateway();
  await mintS(WAIT);
  const h = await mintH(WAIT);
  assert.equal(h.outcome.warning, null, "h confirms without waiting for a retry timer");
  assert.equal(push.gatewayRoutesSessions(), false);
  assert.ok(!pushed.at(-1)!.links.some((l) => l.kind === "s"));
});

// ---- review M1 B6: a mint that makes several links is confirmed per link ------------------------

const shareInput = (labels: string[]) => ({
  sessionId: `sess-${Math.random()}`,
  sessionPath: "/nonexistent/session.jsonl",
  title: "A shared session",
  mode: "snapshot" as const,
  cut: { entryId: "e1", at: null },
  days: 30 as const,
  labels,
  anyone: false,
});

async function sessionGateway() {
  clearStores();
  rmSync(join(stateRoot(), "session-shares.json"), { force: true });
  infoReply = async (n) => infoWithKinds(n, ["h", "i", "s", "x"]);
  push.startRegistryPush();
  await gw.refreshGateway();
  await push.pushNow();
}

test("M1-B6 two recipients minted, one revoked in the same tick: the mint is not confirmed", async () => {
  await sessionGateway();
  const r = await events.awaitShareLinks(() => {
    const made = sessionShares.createShare(shareInput(["Ana", "Ben"]));
    sessionShares.revokeRecipient(made.share.id, made.tokens[0]!.recipientId);
    return made;
  }, WAIT);
  const ana = batonLinks.hashToken(r.result.tokens[0]!.token);
  assert.ok(!pushed.some((snap) => snap.links.some((l) => l.h === ana)), "premise: Ana's link never left");
  assert.notEqual(r.outcome.warning, null, "a returned link was never sent: never confirmed");
});

test("M1-B6 a share minted and one of its links relinked in the same tick: the share's mint warns, the relink confirms", async () => {
  await sessionGateway();
  let made!: ReturnType<typeof sessionShares.createShare>;
  const first = events.awaitShareLinks(() => (made = sessionShares.createShare(shareInput(["Ana", "Ben"]))), WAIT);
  const second = events.awaitShareLinks(() => sessionShares.relinkRecipient(made.share.id, made.tokens[0]!.recipientId), WAIT);
  const [a, b] = await Promise.all([first, second]);
  assert.notEqual(a.outcome.warning, null, "Ana's first link was rotated before it was sent");
  assert.equal(b.outcome.warning, null, JSON.stringify(b.outcome));
});

test("M1-B6 control: a clean two-recipient mint confirms, and Extend (no new link) confirms without being a mint", async () => {
  await sessionGateway();
  const r = await events.awaitShareLinks(() => sessionShares.createShare(shareInput(["Ana", "Ben"])), WAIT);
  assert.equal(r.outcome.warning, null, JSON.stringify(r.outcome));
  const sent = new Set(pushed.at(-1)!.links.map((l) => l.h));
  for (const t of r.result.tokens) assert.ok(sent.has(batonLinks.hashToken(t.token)));
  const x = await events.awaitShareLinks(() => sessionShares.extendShare(r.result.share.id, 7), WAIT);
  assert.equal(x.outcome.warning, null, JSON.stringify(x.outcome));
});

// ---- the preview address through a gateway comeback ---------------------------------------------


const PREVIEW_URL = "https://*.pv.example.com";
const ALL_KINDS = ["h", "i", "s", "x", "p"];
const infoWithPreview = (node: string, kinds: string[]): Reply => ({ status: 200, body: { publicUrl: urlOf(node), accepting: true, seq: null, kinds, previewUrl: PREVIEW_URL } });
const addressNow = () => previewAddress({}, VIA);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Routed through a gateway that stated `p` and its preview address. */
async function previewGateway() {
  clearStores();
  infoReply = async (n) => infoWithPreview(n, ALL_KINDS);
  push.startRegistryPush();
  await gw.refreshGateway();
  await push.pushNow();
  assert.equal(addressNow().url, PREVIEW_URL, "premise: the gateway's address is in effect");
}

/** The mesh sees the gateway go and come back; its info reply is held until `answer()`. */
function comeback(reply: (node: string) => Reply) {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let asked = 0;
  infoReply = async (n) => {
    asked++;
    await held;
    return reply(n);
  };
  meshApi.sawPeer(GATEWAY.id, false);
  meshApi.sawPeer(GATEWAY.id, true);
  return {
    asked: () => asked,
    answer: async () => {
      release();
      await pause(20); // the refresh settles, then the push the comeback owes
      await push.pushNow();
    },
  };
}

test("through a gateway comeback the preview address never reads unset, and the same answer keeps it", async () => {
  await previewGateway();
  const seen: Array<string | null> = [];
  const watch = setInterval(() => seen.push(addressNow().url), 1);
  try {
    const c = comeback((n) => infoWithPreview(n, ALL_KINDS));
    seen.push(addressNow().url); // right after the comeback, before anything answered
    await until(() => c.asked() > 0, "the comeback asks the gateway again");
    assert.ok(c.asked() > 0, "the comeback asks the gateway again");
    await pause(20); // the gateway takes its time
    seen.push(addressNow().url);
    await c.answer();
    await pause(10);
    seen.push(addressNow().url);
  } finally {
    clearInterval(watch);
  }
  assert.ok(seen.length > 5, `premise: sampled (${seen.length})`);
  assert.deepEqual([...new Set(seen)], [PREVIEW_URL], "the address read unset during the comeback");
  assert.ok(pushed.at(-1), "the push still follows the comeback");
});

test("a gateway that comes back without the preview kind clears the address (gateway-old)", async () => {
  await previewGateway();
  const c = comeback((n) => infoWithKinds(n, ["h", "i", "s", "x"]));
  assert.equal(addressNow().url, PREVIEW_URL, "kept until it answers");
  await c.answer();
  await until(() => !addressNow().url, "the address cleared");
  const a = addressNow();
  assert.deepEqual([a.url, a.reason], [null, "gateway-old"]);
  assert.ok(!pushed.at(-1)!.links.some((l) => l.kind === "p"), "no p row to a gateway that no longer lists it");
});

test("a gateway whose info goes unanswered still loses its statement: the address is unset (no-address)", async () => {
  await previewGateway();
  const c = comeback(() => null);
  await c.answer();
  await until(() => !addressNow().url, "the address cleared");
  const a = addressNow();
  assert.deepEqual([a.url, a.reason], [null, "no-address"]);
  // and without any comeback: the 60 s refresh finding it unreachable clears it the same way
  infoReply = async (n) => infoWithPreview(n, ALL_KINDS);
  await gw.refreshGateway();
  assert.equal(addressNow().url, PREVIEW_URL);
  infoReply = async () => null;
  await gw.refreshGateway();
  assert.equal(addressNow().url, null);
});
