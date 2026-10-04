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
  const c = ok({ peers: [{ id: "relay", lan: { role: "dial", pin: "abcd-ef01-2345-6789-abcd-ef01-2345-6789", host: "192.0.2.5", port: 4803 } }] });
  const p = c.peers[0]!;
  assert.equal(p.nodeId, lanNodeId(PIN));
  assert.deepEqual(p.lan, { role: "dial", pin: PIN, host: "192.0.2.5", port: 4803 });
  assert.equal(p.dnsName, "192.0.2.5");
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
    [{ role: "accept", pin: PIN, host: "192.0.2.5" }, /no host/],
    [{ role: "dial", pin: PIN, port: 4803 }, /host/],
    [{ role: "dial", pin: PIN, host: "0.0.0.0", port: 4803 }, /host/],
    [{ role: "dial", pin: PIN, host: "http://x/", port: 4803 }, /host/],
    [{ role: "dial", pin: PIN, host: "192.0.2.5", port: 0 }, /port/],
    [{ role: "dial", pin: PIN, host: "192.0.2.5", port: 70000 }, /port/],
    ["dial", /object/],
  ] as const) assert.match(err({ peers: [{ id: "x", lan }] }), why, JSON.stringify(lan));
  assert.match(err({ peers: [{ id: "x", lan: { role: "accept", pin: PIN }, url: "http://192.0.2.5:4801" }] }), /no url/);
});

test("two pairings with one pin are one node twice", () => {
  assert.match(err({ peers: [{ id: "a", lan: { role: "accept", pin: PIN } }, { id: "b", lan: { role: "dial", pin: PIN, host: "192.0.2.5", port: 1 } }] }), /listed twice/);
});

test("self.relay: one IP, never a wildcard; exposure lan or internet", () => {
  assert.deepEqual(ok({ self: { id: "h", relay: { host: "192.0.2.9", port: 4803 } } }).self.relay, { host: "192.0.2.9", port: 4803 });
  assert.deepEqual(ok({ self: { id: "h", relay: { host: "2001:db8::1", port: 4803, exposure: "internet" } } }).self.relay, { host: "2001:db8::1", port: 4803, exposure: "internet" });
  for (const relay of [{ host: "0.0.0.0", port: 1 }, { host: "::", port: 1 }, { host: "relay.example", port: 1 }, { host: "192.0.2.9", port: -1 }, { host: "192.0.2.9", port: 1, exposure: "wan" }]) {
    assert.match(err({ self: { id: "h", relay } }), /self\.relay/, JSON.stringify(relay));
  }
});
