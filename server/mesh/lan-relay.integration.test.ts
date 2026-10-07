// Run: node scripts/run-tests.mjs server/mesh/lan-relay.integration.test.ts
// The relay listener over real TLS on loopback (§mesh.lan/relay-listener). The address rules and the
// default handshake deadline without a socket: lan-relay.test.ts.
import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { test } from "node:test";
import type { TLSSocket } from "node:tls";
import { type LanIdentity, mintLanIdentity } from "./lan-cert";
import { type AdmissionProfile, LAN_PROFILE } from "./lan-admission";
import { RelayListener, type RelayEvent, type RelayPeer } from "./lan-relay";
import { connectPinned } from "./lan-tls";

const relayId = mintLanIdentity();
const mac = mintLanIdentity();
const mac2 = mintLanIdentity();
const peer = (id: LanIdentity, label: string): RelayPeer => ({ id: label, label, pin: id.pin });

/** Poll with a generous hang guard: never a bound on how fast the relay is. */
async function until(what: string, ok: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function listener(over: { profile?: AdmissionProfile; handshakeMs?: number } = {}) {
  const got: string[] = [];
  const events: RelayEvent[] = [];
  const socks: TLSSocket[] = [];
  const l = new RelayListener({
    host: "127.0.0.1", port: 0, identity: relayId, profile: over.profile ?? LAN_PROFILE,
    ...(over.handshakeMs ? { handshakeMs: over.handshakeMs } : {}),
    onPeer: (s, p, ch) => { got.push(ch === "answer" ? p.label : `${p.label}/${ch}`); socks.push(s); },
    onEvent: (e) => events.push(e),
  });
  return { l, got, events, socks, port: () => l.address()!.port, done: async () => { socks.forEach((s) => s.destroy()); await l.close(); } };
}
type Rig = ReturnType<typeof listener>;

/** Dial, and wait for the relay's verdict (in TLS 1.3 it comes after the client's handshake): the
    socket handed on, or this side closed by the relay. A dial refused outright has its verdict already. */
async function dial(t: Rig, id: LanIdentity, port: number): Promise<void> {
  const handed = t.got.length;
  const s = await connectPinned(id, relayId.pin, "127.0.0.1", port, "answer", 10_000).catch(() => null);
  if (!s) return;
  s.resume(); // read, so the relay's close reaches this side
  await until("the relay's verdict", () => t.got.length > handed || s.destroyed);
  s.destroy();
}

test("listens only while a host is paired, on the one address it was given", async () => {
  // Which addresses it refuses to bind at all: lan-relay.test.ts.
  const t = listener();
  assert.equal(t.l.listening, false);
  await t.l.setPaired([]);
  assert.equal(t.l.listening, false);
  await t.l.setPaired([peer(mac, "mac")]);
  assert.equal(t.l.listening, true);
  assert.equal(t.l.address()!.address, "127.0.0.1");
  await t.l.setPaired([]);
  assert.equal(t.l.listening, false);
});

test("hands on a paired host's socket with its record; an unpaired one never", async () => {
  const t = listener();
  await t.l.setPaired([peer(mac, "mac")]);
  await dial(t, mac, t.port());
  await dial(t, mac2, t.port());
  assert.deepEqual(t.got, ["mac"]);
  await t.done();
});

test("the channel a host asked for reaches the caller", async () => {
  const t = listener();
  await t.l.setPaired([peer(mac, "mac")]);
  const s = await connectPinned(mac, relayId.pin, "127.0.0.1", t.port(), "ask", 10_000);
  await until("the relay to hand it on", () => t.got.length > 0);
  s.destroy();
  assert.deepEqual(t.got, ["mac/ask"]);
  await t.done();
});

test("pairing a second host takes effect for new connections; unpairing refuses at once", async () => {
  const t = listener();
  await t.l.setPaired([peer(mac, "mac")]);
  const port = t.port();
  await dial(t, mac2, port);
  assert.deepEqual(t.got, []);
  await t.l.setPaired([peer(mac, "mac"), peer(mac2, "mac2")]);
  assert.equal(t.port(), port, "the same listener");
  await dial(t, mac2, port);
  assert.deepEqual(t.got, ["mac2"]);
  void t.l.setPaired([peer(mac2, "mac2")]); // not awaited: the pin check must already refuse
  await dial(t, mac, port);
  assert.deepEqual(t.got, ["mac2"]);
  await t.done();
});

test("5 failed handshakes ban the address; its next connection is closed before TLS", async () => {
  const t = listener();
  await t.l.setPaired([peer(mac, "mac")]);
  for (let i = 0; i < 5; i++) await dial(t, mac2, t.port());
  assert.deepEqual(t.events.filter((e) => e.kind === "ban").length, 1);
  assert.equal(t.l.counts().banned, 1);
  // Closed by the ban (admission's refusal), not by the handshake deadline: it is counted as refused.
  const refusedBefore = t.l.counts().refused.banned;
  const raw = net.connect(t.port(), "127.0.0.1");
  raw.on("error", () => {});
  await once(raw, "close");
  assert.equal(t.l.counts().refused.banned, refusedBefore + 1, "closed at once, as banned");
  await dial(t, mac, t.port()); // even the paired host, from a banned address
  assert.deepEqual(t.got, []);
  assert.doesNotMatch(JSON.stringify(t.l.counts()), /127\.0\.0\.1/);
  await t.done();
});

test("a connection that never handshakes is closed at the handshake deadline and counts as failed", async () => {
  // A short deadline (the default, 5 s, is lan-relay.test.ts's), and a ban at the first failure:
  // the ban is how this test sees the close counted as a failed handshake.
  const t = listener({ handshakeMs: 300, profile: { ...LAN_PROFILE, failuresToBan: 1 } });
  await t.l.setPaired([peer(mac, "mac")]);
  const raw = net.connect(t.port(), "127.0.0.1");
  raw.on("error", () => {});
  let heard = 0;
  raw.on("data", (d: Buffer) => (heard += d.length));
  await once(raw, "close");
  assert.equal(heard, 0, "the relay said nothing: no handshake ever started");
  await until("the relay's side of the close", () => t.l.counts().open === 0);
  assert.equal(t.events.filter((e) => e.kind === "ban").length, 1, "counted as a failed handshake");
  await t.done();
});

test("closing the listener stops accepting; a socket already handed on stays the caller's", async () => {
  const t = listener();
  await t.l.setPaired([peer(mac, "mac")]);
  const port = t.port();
  const live = await connectPinned(mac, relayId.pin, "127.0.0.1", port, "answer", 10_000);
  await until("the relay to hand it on", () => t.socks.length > 0);
  assert.equal(t.socks.length, 1);
  await t.l.close();
  assert.equal(t.socks[0]!.destroyed, false);
  await assert.rejects(connectPinned(mac, relayId.pin, "127.0.0.1", port, "answer", 10_000), /refused/);
  live.destroy();
  t.socks[0]!.destroy();
});

test("every one of several paired hosts is accepted", async () => {
  const t = listener();
  const mac3 = mintLanIdentity();
  await t.l.setPaired([peer(mac, "mac"), peer(mac2, "mac2"), peer(mac3, "mac3")]);
  for (const id of [mac3, mac, mac2]) await dial(t, id, t.port());
  assert.deepEqual(t.got, ["mac3", "mac", "mac2"]);
  await t.done();
});
