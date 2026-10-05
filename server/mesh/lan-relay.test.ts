import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { test } from "node:test";
import type { TLSSocket } from "node:tls";
import { type LanIdentity, mintLanIdentity } from "./lan-cert";
import { LAN_PROFILE } from "./lan-admission";
import { RelayListener, type RelayEvent, type RelayPeer } from "./lan-relay";
import { connectPinned } from "./lan-tls";

const relayId = mintLanIdentity();
const mac = mintLanIdentity();
const mac2 = mintLanIdentity();
const peer = (id: LanIdentity, label: string): RelayPeer => ({ id: label, label, pin: id.pin });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function listener() {
  const got: string[] = [];
  const events: RelayEvent[] = [];
  const socks: TLSSocket[] = [];
  const l = new RelayListener({
    host: "127.0.0.1", port: 0, identity: relayId, profile: LAN_PROFILE,
    onPeer: (s, p, ch) => { got.push(ch === "answer" ? p.label : `${p.label}/${ch}`); socks.push(s); },
    onEvent: (e) => events.push(e),
  });
  return { l, got, events, socks, port: () => l.address()!.port, done: async () => { socks.forEach((s) => s.destroy()); await l.close(); } };
}

/** Dial; the relay's verdict comes after the client's handshake in TLS 1.3, so wait for it. */
async function dial(id: LanIdentity, port: number): Promise<void> {
  const s = await connectPinned(id, relayId.pin, "127.0.0.1", port, "answer", 2000).catch(() => null);
  await sleep(150);
  s?.destroy();
}

test("listens only while a host is paired, and never on every interface or a public address", async () => {
  // The backstop behind the relay setting's own check (peers.ts): any spelling of every interface,
  // a public address or a name throws before anything binds.
  for (const host of ["0.0.0.0", "::", "", "0::", "0::0", "0000::", "::0.0.0.0", "::ffff:0.0.0.0", "[::]"]) {
    assert.throws(() => new RelayListener({ host, port: 0, identity: relayId, profile: LAN_PROFILE, onPeer: () => {} }), /one local-network address/, host);
  }
  for (const host of ["192.0.2.10", "2001:db8::1", "100.64.0.1", "relay.example"]) {
    assert.throws(() => new RelayListener({ host, port: 0, identity: relayId, profile: LAN_PROFILE, onPeer: () => {} }), /one local-network address/, host);
  }
  // The internet scope (the accept process's alone) takes one public address, never every interface
  // or a group address; the default scope above never takes a public one.
  for (const host of ["192.0.2.10", "2001:db8::1", "198.51.100.7"]) {
    assert.doesNotThrow(() => new RelayListener({ scope: "internet", host, port: 0, identity: relayId, profile: LAN_PROFILE, onPeer: () => {} }), host);
  }
  for (const host of ["0.0.0.0", "::", "::ffff:0.0.0.0", "224.0.0.1", "255.255.255.255", "ff02::1", "relay.example"]) {
    assert.throws(() => new RelayListener({ scope: "internet", host, port: 0, identity: relayId, profile: LAN_PROFILE, onPeer: () => {} }), /an internet relay binds one address/, host);
  }
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
  await dial(mac, t.port());
  await dial(mac2, t.port());
  assert.deepEqual(t.got, ["mac"]);
  await t.done();
});

test("the channel a host asked for reaches the caller", async () => {
  const t = listener();
  await t.l.setPaired([peer(mac, "mac")]);
  const s = await connectPinned(mac, relayId.pin, "127.0.0.1", t.port(), "ask", 2000);
  await sleep(150);
  s.destroy();
  assert.deepEqual(t.got, ["mac/ask"]);
  await t.done();
});

test("pairing a second host takes effect for new connections; unpairing refuses at once", async () => {
  const t = listener();
  await t.l.setPaired([peer(mac, "mac")]);
  const port = t.port();
  await dial(mac2, port);
  assert.deepEqual(t.got, []);
  await t.l.setPaired([peer(mac, "mac"), peer(mac2, "mac2")]);
  assert.equal(t.port(), port, "the same listener");
  await dial(mac2, port);
  assert.deepEqual(t.got, ["mac2"]);
  void t.l.setPaired([peer(mac2, "mac2")]); // not awaited: the pin check must already refuse
  await dial(mac, port);
  assert.deepEqual(t.got, ["mac2"]);
  await t.done();
});

test("5 failed handshakes ban the address; its next connection is closed before TLS", async () => {
  const t = listener();
  await t.l.setPaired([peer(mac, "mac")]);
  for (let i = 0; i < 5; i++) await dial(mac2, t.port());
  assert.deepEqual(t.events.filter((e) => e.kind === "ban").length, 1);
  assert.equal(t.l.counts().banned, 1);
  const raw = net.connect(t.port(), "127.0.0.1");
  raw.on("error", () => {});
  await Promise.race([once(raw, "close"), sleep(1000)]);
  assert.equal(raw.destroyed, true, "closed at once");
  await dial(mac, t.port()); // even the paired host, from a banned address
  assert.deepEqual(t.got, []);
  assert.doesNotMatch(JSON.stringify(t.l.counts()), /127\.0\.0\.1/);
  await t.done();
});

test("a connection that never handshakes is closed after 5 s and counts as failed", async () => {
  const t = listener();
  await t.l.setPaired([peer(mac, "mac")]);
  const t0 = Date.now();
  const raw = net.connect(t.port(), "127.0.0.1");
  raw.on("error", () => {});
  await Promise.race([once(raw, "close"), sleep(7000)]);
  const took = Date.now() - t0;
  assert.ok(raw.destroyed && took >= 4500 && took < 6500, `closed after ${took} ms`);
  await sleep(100); // the relay's side of the close lands just after the client's
  assert.equal(t.l.counts().open, 0);
  await t.done();
});

test("closing the listener stops accepting; a socket already handed on stays the caller's", async () => {
  const t = listener();
  await t.l.setPaired([peer(mac, "mac")]);
  const port = t.port();
  const live = await connectPinned(mac, relayId.pin, "127.0.0.1", port, "answer", 2000);
  await sleep(150);
  assert.equal(t.socks.length, 1);
  await t.l.close();
  assert.equal(t.socks[0]!.destroyed, false);
  await assert.rejects(connectPinned(mac, relayId.pin, "127.0.0.1", port, "answer", 1000), /refused/);
  live.destroy();
  t.socks[0]!.destroy();
});

test("every one of several paired hosts is accepted", async () => {
  const t = listener();
  const mac3 = mintLanIdentity();
  await t.l.setPaired([peer(mac, "mac"), peer(mac2, "mac2"), peer(mac3, "mac3")]);
  for (const id of [mac3, mac, mac2]) await dial(id, t.port());
  assert.deepEqual(t.got, ["mac3", "mac", "mac2"]);
  await t.done();
});
