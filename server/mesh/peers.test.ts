// Run: pnpm exec tsx --test server/mesh/peers.test.ts
// peers.json validation and its atomic 0600 write, and the LocalAPI body parsers, against a
// throwaway PI_CODING_AGENT_DIR in the OS temp dir (removed after).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "sova-mesh-peers-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
after(() => rmSync(tmp, { recursive: true, force: true }));

const { defaultSelfId, peersFile, peerUrl, readPeers, validatePeers, writePeers } = await import("./peers");
const { parseStatus, parseWhois, whoisAddr } = await import("./localapi");

const b = { id: "b", nodeId: "nB", dnsName: "b.lab.ts.net." };

describe("validatePeers", () => {
  test("fills defaults and strips the trailing dot", () => {
    const v = validatePeers({ self: { id: "a" }, peers: [b] });
    assert.ok("config" in v);
    assert.deepEqual(v.config, {
      self: { id: "a", label: "a" },
      peers: [{ id: "b", label: "b", nodeId: "nB", dnsName: "b.lab.ts.net" }],
      sync: {},
      frontDoor: null,
    });
    assert.equal(peerUrl(v.config.peers[0]!), "http://b.lab.ts.net:4801");
  });

  test("loginKinds: api-keys kept, all/null/absent dropped, anything else refused", () => {
    const kinds = (loginKinds: unknown) => {
      const v = validatePeers({ peers: [b], loginKinds });
      return "config" in v ? v.config.loginKinds : v.error;
    };
    assert.equal(kinds("api-keys"), "api-keys");
    for (const k of ["all", null, undefined]) assert.equal(kinds(k), undefined, String(k));
    assert.equal(kinds("oauth"), 'loginKinds must be "all" or "api-keys"');
  });

  test("SOVA_HOST_ID names this host while the mesh is on, over the file; ignored while off or invalid", () => {
    const selfOf = (raw: object) => {
      const v = validatePeers(raw);
      return "config" in v ? v.config.self : v.error;
    };
    process.env.SOVA_HOST_ID = "vps";
    try {
      assert.deepEqual(selfOf({ peers: [b] }), { id: "vps", label: "vps" });
      assert.deepEqual(selfOf({ self: { id: "ubuntu-8gb", label: "VPS" }, peers: [b] }), { id: "vps", label: "VPS" });
      assert.deepEqual(selfOf({ self: { id: "a" }, peers: [] }), { id: "a", label: "a" }, "off: the file's id");
      assert.equal((selfOf({}) as { id: string }).id, defaultSelfId(), "off: the hostname default");
      assert.match(String(selfOf({ peers: [{ ...b, id: "vps" }] })), /vps/, "a peer can't take this host's id");
      process.env.SOVA_HOST_ID = "Not A Valid Id";
      assert.deepEqual(selfOf({ self: { id: "a" }, peers: [b] }), { id: "a", label: "a" });
    } finally {
      delete process.env.SOVA_HOST_ID;
    }
    assert.deepEqual(selfOf({ self: { id: "a" }, peers: [b] }), { id: "a", label: "a" }, "unset: unchanged");
  });

  test("an explicit url is reduced to its origin; SOVA_PEER_PORT moves the default", () => {
    const v = validatePeers({ peers: [{ ...b, url: "https://b.lab.ts.net:9000/" }, { id: "c", nodeId: "nC", dnsName: "fd7a::1" }] });
    assert.ok("config" in v);
    assert.equal(peerUrl(v.config.peers[0]!), "https://b.lab.ts.net:9000");
    process.env.SOVA_PEER_PORT = "4999";
    try {
      assert.equal(peerUrl(v.config.peers[1]!), "http://[fd7a::1]:4999");
    } finally {
      delete process.env.SOVA_PEER_PORT;
    }
  });

  const bad: Array<[string, unknown]> = [
    ["not an object", []],
    ["bad version", { version: 2 }],
    ["bad self id", { self: { id: "A B" } }],
    ["peer without nodeId", { peers: [{ id: "b", dnsName: "b" }] }],
    ["peer id equal to self", { self: { id: "b" }, peers: [b] }],
    ["duplicate id", { peers: [b, { ...b, nodeId: "nX" }] }],
    ["duplicate nodeId", { peers: [b, { ...b, id: "c" }] }],
    ["name with a path", { peers: [{ ...b, dnsName: "b/../x" }] }],
    ["url with a path", { peers: [{ ...b, url: "http://b:1/api" }] }],
    ["url with credentials", { peers: [{ ...b, url: "http://u:p@b:1" }] }],
    ["non-http url", { peers: [{ ...b, url: "file:///etc" }] }],
    ["priority not a number", { peers: [{ ...b, priority: "1" }] }],
    ["unknown sync category", { sync: { files: true } }],
    ["sync not a boolean", { sync: { logins: "yes" } }],
    ["frontDoor not a URL", { frontDoor: "sova" }],
  ];
  for (const [name, raw] of bad) test(`refuses: ${name}`, () => assert.ok("error" in validatePeers(raw)));
});

describe("readPeers / writePeers", () => {
  test("missing file is OFF with missing:true", () => {
    const r = readPeers();
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.missing, true);
  });

  test("round-trips at mode 0600, and a malformed file is an error, not missing", () => {
    const v = validatePeers({ self: { id: "a", label: "Host A" }, peers: [{ ...b, priority: 2 }] });
    assert.ok("config" in v);
    writePeers(v.config);
    assert.equal(statSync(peersFile()).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(peersFile(), "utf8")).version, 1);
    const r = readPeers();
    assert.ok(r.ok);
    assert.deepEqual(r.config, v.config);
    writeFileSync(peersFile(), "{nope");
    const bad = readPeers();
    assert.equal(bad.ok, false);
    assert.equal(!bad.ok && bad.missing, undefined);
  });
});

describe("LocalAPI parsers", () => {
  test("status: self, peers, logins; tagged nodes report tagged-devices", () => {
    const s = parseStatus({
      BackendState: "Running",
      Self: { ID: "nA", DNSName: "a.lab.ts.net.", HostName: "a", OS: "linux", Online: true, TailscaleIPs: ["100.64.0.1"], UserID: "7" },
      Peer: {
        k1: { ID: "nB", DNSName: "b.lab.ts.net.", HostName: "b", OS: "linux", Online: false, TailscaleIPs: ["100.64.0.2"], UserID: "7" },
        k2: { ID: "nT", DNSName: "t.lab.ts.net.", HostName: "t", OS: "linux", Online: true, Tags: ["tag:work"], UserID: "9" },
      },
      User: { "7": { LoginName: "me@example.com" }, "9": { LoginName: "tagged-devices" } },
    });
    assert.equal(s.self.nodeId, "nA");
    assert.equal(s.self.login, "me@example.com");
    assert.deepEqual(
      s.peers.map((p) => [p.nodeId, p.name, p.online, p.login]),
      [
        ["nB", "b.lab.ts.net", false, "me@example.com"],
        ["nT", "t.lab.ts.net", true, "tagged-devices"],
      ],
    );
  });

  test("whois: StableID is the identity; none → null", () => {
    assert.deepEqual(parseWhois({ Node: { ID: 5, StableID: "nB", Name: "b.lab.ts.net.", Tags: null }, UserProfile: { LoginName: "me" } }), {
      nodeId: "nB",
      name: "b.lab.ts.net",
      tags: [],
      login: "me",
    });
    assert.equal(parseWhois({ Node: { ID: 5 } }), null);
    assert.equal(parseWhois(null), null);
  });

  test("whoisAddr brackets IPv6 and unwraps IPv4-mapped", () => {
    assert.equal(whoisAddr("100.64.0.2", 5), "100.64.0.2:5");
    assert.equal(whoisAddr("::ffff:100.64.0.2", 5), "100.64.0.2:5");
    assert.equal(whoisAddr("fd7a:115c:a1e0::1", 5), "[fd7a:115c:a1e0::1]:5");
  });
});
