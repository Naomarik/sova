// peers.json's dial-out pairings and relay setting (§mesh.lan/pairing).
import assert from "node:assert/strict";
import { test } from "node:test";
import { lanNodeId } from "./lan-cert";
import { validatePeers } from "./peers";

const PIN = "ABCDEF0123456789ABCDEF0123456789";
const tailnet = { id: "vps", nodeId: "nVPS", dnsName: "vps.example.ts.net" };
const ok = (raw: unknown) => {
  const v = validatePeers(raw);
  if ("error" in v) assert.fail(v.error);
  return v.config;
};
const err = (raw: unknown) => {
  const v = validatePeers(raw);
  assert.ok("error" in v, "expected a refusal");
  return v.error;
};

test("a dial pairing: node id from its pin, its host as the name, no browser address", () => {
  const c = ok({ peers: [{ id: "relay", lan: { role: "dial", pin: "abcd-ef01-2345-6789-abcd-ef01-2345-6789", host: "10.0.0.5", port: 4803 } }] });
  const p = c.peers[0]!;
  assert.equal(p.nodeId, lanNodeId(PIN));
  assert.deepEqual(p.lan, { role: "dial", pin: PIN, host: "10.0.0.5", port: 4803 });
  assert.equal(p.dnsName, "10.0.0.5");
  assert.equal(p.browserAccess, false);
});

test("an accept pairing: no host or port; shown as dial-out", () => {
  const c = ok({ peers: [{ id: "laptop", nodeId: lanNodeId(PIN), lan: { role: "accept", pin: PIN } }, tailnet] });
  assert.equal(c.peers[0]!.dnsName, "dial-out");
  assert.deepEqual(c.peers[0]!.lan, { role: "accept", pin: PIN });
  assert.equal(c.peers[1]!.lan, undefined, "a tailnet peer is untouched");
});

test("the lan: namespace is only for pairings, and a pairing's id must match its pin", () => {
  assert.match(err({ peers: [{ id: "x", nodeId: "lan:abc", dnsName: "x.example" }] }), /lan link/);
  assert.match(err({ peers: [{ id: "x", nodeId: "LAN:abc", dnsName: "x.example" }] }), /lan link/);
  assert.match(err({ peers: [{ id: "x", nodeId: "nOther", lan: { role: "accept", pin: PIN } }] }), /must be lan:/);
});

test("a malformed lan link is refused whole", () => {
  for (const [lan, why] of [
    [{ role: "relay", pin: PIN }, /role/],
    [{ role: "accept", pin: "ABCD" }, /pin/],
    [{ role: "accept", pin: PIN, host: "10.0.0.5" }, /no host/],
    [{ role: "dial", pin: PIN, port: 4803 }, /host/],
    [{ role: "dial", pin: PIN, host: "0.0.0.0", port: 4803 }, /host/],
    [{ role: "dial", pin: PIN, host: "http://x/", port: 4803 }, /host/],
    [{ role: "dial", pin: PIN, host: "10.0.0.5", port: 0 }, /port/],
    [{ role: "dial", pin: PIN, host: "10.0.0.5", port: 70000 }, /port/],
    ["dial", /object/],
  ] as const) assert.match(err({ peers: [{ id: "x", lan }] }), why, JSON.stringify(lan));
  assert.match(err({ peers: [{ id: "x", lan: { role: "accept", pin: PIN }, url: "http://10.0.0.5:4801" }] }), /no url/);
});

test("two pairings with one pin are one node twice", () => {
  assert.match(err({ peers: [{ id: "a", lan: { role: "accept", pin: PIN } }, { id: "b", lan: { role: "dial", pin: PIN, host: "10.0.0.5", port: 1 } }] }), /listed twice/);
});

test("self.relay: one loopback, private or link-local IP; exposure lan only", () => {
  assert.deepEqual(ok({ self: { id: "h", relay: { host: "10.0.0.9", port: 4803 } } }).self.relay, { host: "10.0.0.9", port: 4803 });
  assert.deepEqual(ok({ self: { id: "h", relay: { host: "10.0.0.9", port: 4803, exposure: "lan" } } }).self.relay, { host: "10.0.0.9", port: 4803 });
  // Each range's edges, and the forms an address may take.
  for (const [host, kept] of [
    ["127.0.0.1", "127.0.0.1"],
    ["10.255.255.255", "10.255.255.255"],
    ["172.16.0.1", "172.16.0.1"],
    ["172.31.255.254", "172.31.255.254"],
    ["192.168.255.254", "192.168.255.254"],
    ["169.254.1.1", "169.254.1.1"],
    ["::1", "::1"],
    ["[::1]", "::1"],
    ["fc00::1", "fc00::1"],
    ["FD12:3456::1", "fd12:3456::1"],
    ["fe80::1", "fe80::1"],
    ["febf::1", "febf::1"],
    ["fe80::1%eth0", "fe80::1%eth0"],
    ["::ffff:10.1.2.3", "10.1.2.3"],
    ["::ffff:a01:203", "10.1.2.3"],
  ] as const) assert.deepEqual(ok({ self: { id: "h", relay: { host, port: 1 } } }).self.relay, { host: kept, port: 1 }, host);
  for (const relay of [
    // every interface, in every spelling (L1)
    { host: "0.0.0.0", port: 1 },
    { host: "::", port: 1 },
    { host: "0::", port: 1 },
    { host: "0::0", port: 1 },
    { host: "0000::", port: 1 },
    { host: "::0.0.0.0", port: 1 },
    { host: "::ffff:0.0.0.0", port: 1 },
    { host: "0:0:0:0:0:0:0:0", port: 1 },
    { host: "[::]", port: 1 },
    // public (H1/q9): documentation, carrier NAT, global IPv6, the edges just outside each range
    { host: "192.0.2.9", port: 1 },
    { host: "100.64.0.1", port: 1 },
    { host: "172.15.255.255", port: 1 },
    { host: "172.32.0.1", port: 1 },
    { host: "11.0.0.1", port: 1 },
    { host: "2001:db8::1", port: 1 },
    { host: "fec0::1", port: 1 },
    { host: "::ffff:192.0.2.9", port: 1 },
    { host: "::10.0.0.1", port: 1 },
    { host: "0.1.2.3", port: 1 },
    // not an IP, or malformed
    { host: "relay.example", port: 1 },
    { host: "010.0.0.1", port: 1 },
    { host: "10.0.0.256", port: 1 },
    { host: "1::2::3", port: 1 },
    { host: "10.0.0.1%eth0", port: 1 },
    { host: "fd00::1%eth0", port: 1 },
    // port and exposure
    { host: "10.0.0.9", port: -1 },
    { host: "10.0.0.9", port: 1, exposure: "wan" },
  ]) {
    assert.match(err({ self: { id: "h", relay } }), /self\.relay/, JSON.stringify(relay));
  }
  assert.match(err({ self: { id: "h", relay: { host: "203.0.113.7", port: 1 } } }), /public address/);
  assert.match(err({ self: { id: "h", relay: { host: "203.0.113.7", port: 1, exposure: "lan" } } }), /public address/, "LAN stays local-network only");
});

test("an internet relay setting: any one unicast address, valid whether or not the accept process runs", () => {
  for (const host of ["203.0.113.7", "2001:db8::7", "10.0.0.9", "198.51.100.1", "::ffff:198.51.100.2"]) {
    const c = ok({ self: { id: "h", relay: { host, port: 4803, exposure: "internet" } } });
    assert.equal(c.self.relay?.exposure, "internet", host);
  }
  assert.equal(ok({ self: { id: "h", relay: { host: "::ffff:198.51.100.2", port: 1, exposure: "internet" } } }).self.relay?.host, "198.51.100.2");
  for (const host of ["0.0.0.0", "::", "0::0", "::ffff:0.0.0.0", "224.0.0.1", "239.1.2.3", "255.255.255.255", "ff02::1", "relay.example", "203.0.113.7%eth0"]) {
    assert.match(err({ self: { id: "h", relay: { host, port: 4803, exposure: "internet" } } }), /self\.relay/, host);
  }
  assert.equal(ok({ self: { id: "h", relay: { host: "10.0.0.9", port: 1 } } }).self.relay?.exposure, undefined, "LAN is written as no exposure, as before");
});

test("a dial pairing marked as on the internet may name a public relay; nothing else may", () => {
  const link = (host: string, extra: Record<string, unknown> = {}) => ({ peers: [{ id: "x", lan: { role: "dial", pin: PIN, host, port: 4803, ...extra } }] });
  for (const host of ["203.0.113.7", "2001:db8::7", "100.127.255.254", "198.51.100.9"]) {
    assert.equal(ok(link(host, { internet: true })).peers[0]!.lan!.internet, true, host);
    assert.match(err(link(host)), /public address/, `${host} without the mark`);
  }
  assert.equal(ok(link("relay.example", { internet: true })).peers[0]!.lan!.host, "relay.example");
  for (const host of ["0.0.0.0", "::", "224.0.0.1", "255.255.255.255", "ff02::1"]) assert.match(err(link(host, { internet: true })), /host/, host);
  assert.match(err(link("10.0.0.5", { internet: false })), /internet must be true/);
  assert.match(err(link("10.0.0.5", { internet: "yes" })), /internet must be true/);
  assert.match(err({ peers: [{ id: "x", lan: { role: "accept", pin: PIN, internet: true } }] }), /only a relay this host dials/);
  assert.equal(ok(link("10.0.0.5")).peers[0]!.lan!.internet, undefined, "an unmarked pairing has no mark");
});

test("a dial pairing's relay: a public IP is refused when saved; a name is judged when dialed", () => {
  for (const host of ["192.0.2.5", "2001:db8::5", "100.127.255.254", "0::", "::ffff:0.0.0.0"]) {
    assert.match(err({ peers: [{ id: "x", lan: { role: "dial", pin: PIN, host, port: 1 } }] }), /host/, host);
  }
  assert.equal(ok({ peers: [{ id: "x", lan: { role: "dial", pin: PIN, host: "relay.example", port: 1 } }] }).peers[0]!.lan!.host, "relay.example");
  assert.equal(ok({ peers: [{ id: "x", lan: { role: "dial", pin: PIN, host: "cafe", port: 1 } }] }).peers[0]!.lan!.host, "cafe", "a hex-looking name is a name");
  assert.equal(ok({ peers: [{ id: "x", lan: { role: "dial", pin: PIN, host: "::ffff:10.0.0.5", port: 1 } }] }).peers[0]!.lan!.host, "10.0.0.5");
});
