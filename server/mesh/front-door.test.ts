// Run: pnpm exec tsx --test server/mesh/front-door.test.ts
// The generated front door: order rules, upstream addresses, and the Caddyfile's directives.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { frontDoorConfig, upstreamHostport } from "./front-door";
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
  test("carries the lab-proven directives, each once; one failed connect never benches a host", () => {
    const { caddyfile } = frontDoorConfig(config(), "a.x.ts.net");
    // The main reverse_proxy, before the bare-502 fallbacks (which repeat the dial settings).
    const main = caddyfile.split("\t\t@bare502")[0]!;
    for (const d of [
      "lb_policy first",
      "lb_try_duration 6s",
      "max_fails 3",
      "fail_duration 3s",
      "health_uri /api/health",
      "health_interval 1s",
      "health_timeout 2500ms",
      "health_fails 2",
      "health_passes 2",
      "flush_interval -1",
      "header_up Host {upstream_hostport}",
      "dial_timeout 2s",
      "keepalive 30s",
      "response_header_timeout 35s",
      "resolvers 100.100.100.100",
      "default_bind {$SOVA_FRONT_DOOR_BIND}",
      ":{$SOVA_FRONT_DOOR_PORT:80} {",
    ]) {
      assert.equal(main.split("\n").filter((l) => l.trim() === d).length, 1, d);
    }
    assert.match(caddyfile, /\ttransport http \{\n\t\t\tdial_timeout 2s\n\t\t\tkeepalive 30s\n\t\t\tresponse_header_timeout 35s\n(\t\t\t#[^\n]*\n)?\t\t\tresolvers 100\.100\.100\.100\n\t\t\}/);
    assert.doesNotMatch(caddyfile, /keepalive off/);
  });

  test("names are resolved through MagicDNS by Caddy, whatever the tailnet domain; IP and localhost upstreams need no resolver", () => {
    const lab = frontDoorConfig(config({ peers: [{ id: "b", label: "B", nodeId: "5", dnsName: "b.mesh.lab" }] }), "a.mesh.lab").caddyfile;
    assert.match(lab, /^\t\t\tresolvers 100\.100\.100\.100$/m);
    const ips = frontDoorConfig(
      config({
        self: { id: "a", label: "A", serveUrl: "https://127.0.0.1:10443" },
        peers: [
          { id: "b", label: "B", nodeId: "5", dnsName: "b", serveUrl: "https://100.64.0.2:8443" },
          { id: "c", label: "C", nodeId: "3", dnsName: "c", serveUrl: "https://[fd7a:115c:a1e0::3]:8443" },
          { id: "d", label: "D", nodeId: "4", dnsName: "d", serveUrl: "https://localhost:8443" },
        ],
      }),
      null,
    ).caddyfile;
    assert.doesNotMatch(ips, /resolvers/);
    // One name among IPs is enough.
    const mixed = frontDoorConfig(config({ self: { id: "a", label: "A", serveUrl: "https://127.0.0.1:10443" } }), null).caddyfile;
    assert.match(mixed, /^\t\t\tresolvers 100\.100\.100\.100$/m);
  });

  test("an upstream that is the front door's own address is called out (it would proxy to itself)", () => {
    const loop = frontDoorConfig(config({ frontDoor: "https://a.x.ts.net:8443" }), "a.x.ts.net").caddyfile;
    assert.match(loop, /# WARNING: a's upstream is this front door's own address \(https:\/\/a\.x\.ts\.net:8443\)/);
    const fine = frontDoorConfig(config({ frontDoor: "https://a.x.ts.net:8443", self: { id: "a", label: "A", serveUrl: "https://a.x.ts.net:10443" } }), "a.x.ts.net").caddyfile;
    assert.doesNotMatch(fine, /WARNING/);
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

describe("the bare-502 fallback (Sova down behind tailscale serve)", () => {
  /** The upstreams of the fallback for the host with this dial address, or null. */
  const fallbackFor = (caddyfile: string, id: string) => {
    const m = new RegExp(`\\t@from_${id} \\{\\n\\t+method GET HEAD\\n\\t+vars \\{http\\.reverse_proxy\\.upstream\\.hostport\\} (\\S+)\\n\\t+\\}\\n\\t+handle @from_${id} \\{\\n\\t+reverse_proxy (.*) \\{`).exec(caddyfile);
    return m ? { hostport: m[1], upstreams: m[2]!.split(" ") } : null;
  };

  test("each host's bare 502 on a GET/HEAD goes to the other hosts, in failover order", () => {
    const { caddyfile } = frontDoorConfig(config({ frontDoorOrder: ["b", "a", "c"] }), "a.x.ts.net");
    assert.match(caddyfile, /\t\t@bare502 \{\n\t\t\tstatus 502\n\t\t\theader !Content-Type\n\t\t\}\n\t\thandle_response @bare502 \{/);
    assert.deepEqual(fallbackFor(caddyfile, "b"), { hostport: "b.x.ts.net:8443", upstreams: ["https://a.x.ts.net:8443", "https://c.x.ts.net:8443"] });
    assert.deepEqual(fallbackFor(caddyfile, "a"), { hostport: "a.x.ts.net:8443", upstreams: ["https://b.x.ts.net:8443", "https://c.x.ts.net:8443"] });
    assert.deepEqual(fallbackFor(caddyfile, "c"), { hostport: "c.x.ts.net:8443", upstreams: ["https://b.x.ts.net:8443", "https://a.x.ts.net:8443"] });
    // Anything else (a POST, Sova's own JSON 502) is the original response.
    assert.match(caddyfile, /\t\t\thandle \{\n\t\t\t\tcopy_response\n\t\t\t\}\n\t\t\}\n\t\}\n\}/);
    assert.equal(caddyfile.match(/method GET HEAD/g)!.length, 3);
    assert.doesNotMatch(caddyfile, /method[^\n]*POST/);
  });

  test("the fallback proxies dial like the main one: same transport, Host, streaming, passive failures", () => {
    const { caddyfile } = frontDoorConfig(config(), "a.x.ts.net");
    const block = caddyfile.split("handle @from_a {")[1]!.split("\t\t\thandle")[0]!;
    for (const d of ["lb_policy first", "lb_try_duration 6s", "lb_try_interval 250ms", "max_fails 3", "fail_duration 3s", "flush_interval -1", "header_up Host {upstream_hostport}", "dial_timeout 2s", "keepalive 30s", "response_header_timeout 35s", "resolvers 100.100.100.100", "header_down X-Sova-Upstream {upstream_hostport}"]) {
      assert.equal(block.split("\n").filter((l) => l.trim() === d).length, 1, d);
    }
    assert.doesNotMatch(block, /health_/);
  });

  test("one host: no fallback at all", () => {
    const { caddyfile } = frontDoorConfig(config({ peers: [] }), "a.x.ts.net");
    assert.doesNotMatch(caddyfile, /bare502|handle_response|copy_response/);
  });

  test("upstreamHostport is Caddy's dial address: default ports, bracketed IPv6", () => {
    assert.equal(upstreamHostport("https://a.x.ts.net:10443"), "a.x.ts.net:10443");
    assert.equal(upstreamHostport("https://a.x.ts.net"), "a.x.ts.net:443");
    assert.equal(upstreamHostport("http://100.64.0.2"), "100.64.0.2:80");
    assert.equal(upstreamHostport("https://[fd7a:115c:a1e0::3]:8443"), "[fd7a:115c:a1e0::3]:8443");
  });
});

describe("leaving hosts out (frontDoorExclude)", () => {
  test("excluded hosts are not upstreams and get no fallback; the rest keep their order", () => {
    const fd = frontDoorConfig(config({ frontDoorOrder: ["c", "a", "b"], frontDoorExclude: ["a"] }), "a.x.ts.net");
    assert.deepEqual(fd.order.map((h) => h.id), ["c", "b"]);
    assert.deepEqual(upstreamsOf(fd.caddyfile), ["https://c.x.ts.net:8443", "https://b.x.ts.net:8443"]);
    assert.doesNotMatch(fd.caddyfile, /a\.x\.ts\.net|@from_a|WARNING/);
  });

  test("ids that are no longer hosts are ignored; absent or empty is every host", () => {
    const all = frontDoorConfig(config(), "a.x.ts.net").caddyfile;
    assert.equal(frontDoorConfig(config({ frontDoorExclude: [] }), "a.x.ts.net").caddyfile, all);
    assert.equal(frontDoorConfig(config({ frontDoorExclude: ["gone"] }), "a.x.ts.net").caddyfile, all);
  });

  test("leaving out every host (a hand edit) keeps them all, flagged", () => {
    const fd = frontDoorConfig(config({ frontDoorExclude: ["a", "b", "c"] }), "a.x.ts.net");
    assert.deepEqual(fd.order.map((h) => h.id), ["a", "b", "c"]);
    assert.match(fd.caddyfile, /# WARNING: every host is left out of the front door/);
    // Leaving out two of three leaves one host: no fallback either.
    const one = frontDoorConfig(config({ frontDoorExclude: ["a", "b"] }), "a.x.ts.net");
    assert.deepEqual(upstreamsOf(one.caddyfile), ["https://c.x.ts.net:8443"]);
    assert.doesNotMatch(one.caddyfile, /bare502|WARNING/);
  });
});

describe("hosts with no browser address", () => {
  test("they are never upstreams, whatever the order says, and are listed apart; the rest keep their order", () => {
    const fd = frontDoorConfig(config({ frontDoorOrder: ["b", "c", "a"] }), "a.x.ts.net", new Set(["b"]));
    assert.deepEqual(fd.order.map((h) => h.id), ["c", "a"]);
    assert.deepEqual(upstreamsOf(fd.caddyfile), ["https://c.x.ts.net:8443", "https://a.x.ts.net:8443"]);
    assert.doesNotMatch(fd.caddyfile, /b\.x\.ts\.net|@from_b|WARNING/);
    assert.match(fd.caddyfile, /# Left out: b has no browser address \(Browser access is off\)\./);
    assert.deepEqual(fd.noBrowser, [{ id: "b", label: "Host B" }]);
  });

  test("this host too; left out by the user as well, it is listed once, as having no browser address", () => {
    const fd = frontDoorConfig(config({ frontDoorExclude: ["a"] }), "a.x.ts.net", new Set(["a"]));
    assert.deepEqual(fd.order.map((h) => h.id), ["b", "c"]);
    assert.deepEqual(fd.noBrowser, [{ id: "a", label: "Host A" }]);
  });

  test("with none, the answer is exactly what it was: no field, no line", () => {
    const plain = frontDoorConfig(config(), "a.x.ts.net");
    assert.deepEqual(frontDoorConfig(config(), "a.x.ts.net", new Set()), plain);
    assert.deepEqual(frontDoorConfig(config(), "a.x.ts.net", new Set(["gone"])), plain);
    assert.equal("noBrowser" in plain, false);
  });

  test("exclusions that leave only hosts with no browser address (a hand edit) keep the ones that have one, flagged", () => {
    const fd = frontDoorConfig(config({ frontDoorExclude: ["a", "c"] }), "a.x.ts.net", new Set(["b"]));
    assert.deepEqual(fd.order.map((h) => h.id), ["a", "c"]);
    assert.ok(!upstreamsOf(fd.caddyfile).some((u) => u.includes("b.x.ts.net")), "never the no-browser host");
    assert.match(fd.caddyfile, /# WARNING: every host with a browser address is left out of the front door \(frontDoorExclude\), so those are listed\./);
    assert.doesNotMatch(fd.caddyfile, /no host has a browser address|every host is left out/);
    assert.deepEqual(fd.noBrowser, [{ id: "b", label: "Host B" }]);
  });

  test("if no host has one, all stay, flagged, rather than an empty front door", () => {
    const fd = frontDoorConfig(config(), "a.x.ts.net", new Set(["a", "b", "c"]));
    assert.deepEqual(fd.order.map((h) => h.id), ["a", "b", "c"]);
    assert.match(fd.caddyfile, /# WARNING: no host has a browser address/);
    assert.equal(fd.noBrowser, undefined);
    // Those the user left in, with a browser address, are the ones kept.
    const one = frontDoorConfig(config({ frontDoorExclude: ["a"] }), "a.x.ts.net", new Set(["b"]));
    assert.deepEqual(one.order.map((h) => h.id), ["c"]);
  });
});
