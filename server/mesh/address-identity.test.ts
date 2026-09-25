import assert from "node:assert/strict";
import { test } from "node:test";
import { addressIdentity, entryAddresses, tailnetAddresses, tailnetIp } from "./address-identity";
import type { PeerEntry } from "./peers";

const vps: PeerEntry = { id: "vps", label: "VPS", nodeId: "nVPS", dnsName: "vps.example.ts.net", url: "http://100.64.0.2:4801" };
const laptop: PeerEntry = { id: "laptop", label: "Laptop", nodeId: "nLAP", dnsName: "100.64.0.4" };
const v6: PeerEntry = { id: "six", label: "Six", nodeId: "nSIX", dnsName: "fd7a:115c:a1e0:0:0:0:0:5" };
const env = { SOVA_PEER_HOST: "100.64.0.3", SOVA_SELF_NODE_ID: "nPHONE", SOVA_SELF_DNS: "phone.example.ts.net" };
const quiet = () => {
  const warn = console.warn;
  console.warn = () => {};
  return () => void (console.warn = warn);
};

test("tailnetIp: only the tailnet ranges, canonical", () => {
  assert.equal(tailnetIp("100.64.0.1"), "100.64.0.1");
  assert.equal(tailnetIp("100.127.255.255"), "100.127.255.255");
  assert.equal(tailnetIp("::ffff:100.100.1.1"), "100.100.1.1");
  assert.equal(tailnetIp("[fd7a:115c:a1e0:0:0:0:0:5]"), "fd7a:115c:a1e0::5");
  for (const bad of ["100.63.255.255", "100.128.0.0", "192.168.0.9", "127.0.0.1", "0.0.0.0", "::", "::1", "fd7a:115c:a1e1::5", "vps", ""]) {
    assert.equal(tailnetIp(bad), null, bad);
  }
});

test("entryAddresses: IP literals from name and url only (no DNS)", () => {
  assert.deepEqual(entryAddresses(vps), ["100.64.0.2"]);
  assert.deepEqual(entryAddresses(laptop), ["100.64.0.4"]);
  assert.deepEqual(entryAddresses(v6), ["fd7a:115c:a1e0::5"]);
  assert.deepEqual(entryAddresses({ ...vps, url: "http://vps:4801" }), []);
});

test("tailnetAddresses: SOVA_PEER_HOST must be tailnet literals", () => {
  assert.deepEqual(tailnetAddresses("100.64.0.3"), ["100.64.0.3"]);
  for (const bad of [undefined, "", "0.0.0.0", "127.0.0.1", "::", "192.168.0.9", "100.64.0.3,0.0.0.0"]) {
    assert.throws(() => tailnetAddresses(bad), String(bad));
  }
});

test("whois: exactly one matching entry is the caller; its StableID comes from peers.json", async () => {
  const id = addressIdentity(() => [vps, laptop, v6], env);
  assert.deepEqual(await id.whois("100.64.0.2:41000"), { nodeId: "nVPS", name: "vps.example.ts.net", tags: [], login: "" });
  assert.equal((await id.whois("100.64.0.4:5"))?.nodeId, "nLAP");
  assert.equal((await id.whois("[fd7a:115c:a1e0::5]:5"))?.nodeId, "nSIX");
  const restore = quiet();
  try {
    assert.equal(await id.whois("100.64.0.9:5"), null, "unknown tailnet node");
    assert.equal(await id.whois("192.168.1.10:5"), null, "LAN caller");
    assert.equal(await id.whois("127.0.0.1:5"), null, "loopback");
    assert.equal(await id.whois("100.64.0.3:5"), null, "this host");
    const mislisted = { ...laptop, id: "me", nodeId: "nME", dnsName: "100.64.0.3" };
    assert.equal(await addressIdentity(() => [mislisted], env).whois("100.64.0.3:5"), null, "this host, even if listed");
    assert.equal(await addressIdentity(() => [vps, { ...laptop, dnsName: "100.64.0.2" }], env).whois("100.64.0.2:5"), null, "ambiguous");
    assert.equal(await addressIdentity(() => [vps], {}).whois("100.64.0.2:5").catch(() => "threw"), "threw", "no SOVA_PEER_HOST");
  } finally {
    restore();
  }
});

test("status: self from env, no peers (no discovery)", async () => {
  const s = await addressIdentity(() => [vps], env).status();
  assert.equal(s.self.nodeId, "nPHONE");
  assert.equal(s.self.name, "phone.example.ts.net");
  assert.deepEqual(s.self.addresses, ["100.64.0.3"]);
  assert.deepEqual(s.peers, []);
  await assert.rejects(addressIdentity(() => [], { SOVA_PEER_HOST: "0.0.0.0" }).status());
});
