// Run: pnpm exec tsx --test server/mesh/front-door.test.ts
// The generated front door: order rules, upstream addresses, and the Caddyfile's directives.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { frontDoorConfig } from "./front-door";
import type { PeersConfig } from "./peers";

const config = (over: Partial<PeersConfig> = {}): PeersConfig => ({
  self: { id: "a", label: "Host A" },
  peers: [
    { id: "b", label: "Host B", nodeId: "5", dnsName: "b.x.ts.net" },
    { id: "c", label: "Host C", nodeId: "3", dnsName: "c.x.ts.net" },
  ],
  sync: {},
  frontDoor: null,
  ...over,
});

/** The upstream list on the reverse_proxy line, in order. */
const upstreamsOf = (caddyfile: string) => /\treverse_proxy (.*) \{/.exec(caddyfile)![1]!.split(" ");

describe("front door order", () => {
  test("default: this host first, then peers.json order, each on its tailscale serve :8443", () => {
    const fd = frontDoorConfig(config(), "a.x.ts.net");
    assert.deepEqual(fd.order, [
      { id: "a", label: "Host A", upstream: "https://a.x.ts.net:8443" },
      { id: "b", label: "Host B", upstream: "https://b.x.ts.net:8443" },
      { id: "c", label: "Host C", upstream: "https://c.x.ts.net:8443" },
    ]);
    assert.deepEqual(upstreamsOf(fd.caddyfile), fd.order.map((h) => h.upstream));
  });

  test("the user's order first; hosts it leaves out follow; ids no longer hosts are skipped", () => {
    const fd = frontDoorConfig(config({ frontDoorOrder: ["c", "gone", "a"] }), "a.x.ts.net");
    assert.deepEqual(fd.order.map((h) => h.id), ["c", "a", "b"]);
    assert.deepEqual(upstreamsOf(fd.caddyfile), ["https://c.x.ts.net:8443", "https://a.x.ts.net:8443", "https://b.x.ts.net:8443"]);
    assert.match(fd.caddyfile, /Failover order: c > a > b/);
  });

  test("serveUrl overrides a host's upstream, self included", () => {
    const fd = frontDoorConfig(
      config({ self: { id: "a", label: "Host A", serveUrl: "http://a.lab:8443" }, peers: [{ id: "b", label: "B", nodeId: "5", dnsName: "b.lab", serveUrl: "http://b.lab:8443" }] }),
      null,
    );
    assert.deepEqual(upstreamsOf(fd.caddyfile), ["http://a.lab:8443", "http://b.lab:8443"]);
    assert.doesNotMatch(fd.caddyfile, /TODO|WARNING/);
  });

  test("mesh off / unknown self name: a flagged placeholder, never a guess", () => {
    const fd = frontDoorConfig(config({ peers: [] }), null);
    assert.deepEqual(fd.order, [{ id: "a", label: "Host A", upstream: "https://a.YOUR-TAILNET.ts.net:8443" }]);
    assert.match(fd.caddyfile, /# TODO: a has no known MagicDNS name yet/);
  });

  test("mixed http/https upstreams are called out (Caddy refuses them)", () => {
    const fd = frontDoorConfig(config({ self: { id: "a", label: "A", serveUrl: "http://a.lab:8443" } }), null);
    assert.match(fd.caddyfile, /# WARNING: Caddy needs every upstream on one scheme/);
  });
});

describe("the Caddyfile", () => {
  test("carries the lab-proven directives, each once", () => {
    const { caddyfile } = frontDoorConfig(config(), "a.x.ts.net");
    for (const d of [
      "lb_policy first",
      "lb_try_duration 5s",
      "fail_duration 10s",
      "health_uri /api/health",
      "health_interval 1s",
      "health_timeout 1s",
      "flush_interval -1",
      "header_up Host {upstream_hostport}",
      "dial_timeout 1s",
      "keepalive off",
    ]) {
      assert.equal(caddyfile.split("\n").filter((l) => l.trim() === d).length, 1, d);
    }
    assert.match(caddyfile, /\ttransport http \{\n\t\t\tdial_timeout 1s\n\t\t\tkeepalive off\n\t\t\}/);
  });

  test("braces balance and every non-comment line is inside a block or a block edge", () => {
    const { caddyfile } = frontDoorConfig(config(), "a.x.ts.net");
    const code = caddyfile.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
    let depth = 0;
    for (const l of code) {
      depth += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
      assert.ok(depth >= 0, l);
    }
    // {upstream_hostport} placeholders open and close on one line, so they net to zero.
    assert.equal(depth, 0);
  });
});
