// Detection of this computer's networks (server/networks/detect.ts, §app.access/networks) over fixture
// interface tables in os.networkInterfaces' shape, with the facts Linux's /sys/class/net adds, and the
// route readers the point-to-point ranges come from (server/networks/probe.ts).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classifyNetworks, networkLabel, type DetectInput, type IfaceAddress, type IfaceFacts } from "./detect";
import { parseIpRoutes, parseNetstatRoutes } from "./probe";

const MAC = "3c:22:fb:11:22:33";
const ZERO = "00:00:00:00:00:00";
const v4 = (address: string, prefix: number, mac = MAC, internal = false): IfaceAddress => ({ address, netmask: "", family: "IPv4", mac, internal, cidr: `${address}/${prefix}` });
const v6 = (address: string, prefix: number, mac = MAC): IfaceAddress => ({ address, netmask: "", family: "IPv6", mac, internal: false, cidr: `${address}/${prefix}` });
const virtual: IfaceFacts = { virtual: true, up: true };

/** A Linux laptop: Wi-Fi, a USB Ethernet, Docker, Incus, Tailscale, a WireGuard tunnel, ZeroTier, NetBird, Nebula,
    an OpenVPN tun, a bridge port and a down interface. */
const LINUX: DetectInput = {
  platform: "linux",
  interfaces: {
    lo: [v4("127.0.0.1", 8, ZERO, true), { ...v6("::1", 128, ZERO), internal: true }],
    wlan0: [v4("192.168.1.23", 24), v6("fe80::1", 64), v6("2001:db8::23", 64)],
    eth0: [v4("192.168.50.4", 24)],
    docker0: [v4("172.17.0.1", 16)],
    "br-8d5defc7c72b": [v4("172.18.0.1", 16)],
    incusbr0: [v4("10.120.33.1", 24)],
    veth150fc5e: [v6("fe80::a", 64)],
    tailscale0: [v4("100.101.102.103", 32, ZERO), v6("fd7a:115c:a1e0::1", 128, ZERO)],
    wg0: [v4("10.8.0.2", 32, ZERO)],
    ztabcdef12: [v4("10.147.17.5", 24, "aa:bb:cc:dd:ee:ff")],
    wt0: [v4("100.90.1.2", 16, ZERO)],
    nebula1: [v4("192.168.100.7", 24, ZERO)],
    tun0: [v4("10.211.0.6", 24, ZERO)],
    vethport: [v4("10.55.0.2", 24)],
    wg1: [v4("10.9.0.2", 24, ZERO)],
    myvirt0: [v4("10.66.0.1", 24)],
    ppp0: [v4("8.8.4.4", 32, ZERO)],
  },
  facts: {
    wlan0: { devtype: "wlan", wireless: true, physical: true, up: true },
    eth0: { physical: true, up: true },
    docker0: { devtype: "bridge", ...virtual },
    "br-8d5defc7c72b": { devtype: "bridge", ...virtual },
    incusbr0: { devtype: "bridge", ...virtual },
    tailscale0: { tun: true, ...virtual },
    wg0: { devtype: "wireguard", ...virtual },
    ztabcdef12: { tun: true, ...virtual },
    wt0: { devtype: "wireguard", ...virtual },
    nebula1: { tun: true, ...virtual },
    tun0: { tun: true, ...virtual },
    vethport: { bridgePort: true, ...virtual },
    wg1: { devtype: "wireguard", virtual: true, up: false },
    myvirt0: { ...virtual },
    ppp0: { ...virtual },
  },
  routes: { wg0: ["10.8.0.0/24", "10.200.0.0/16"], tailscale0: [] },
  tailscale: null,
};

const row = (list: ReturnType<typeof classifyNetworks>, iface: string) => list.filter((n) => n.iface === iface);

describe("a Linux computer's networks", () => {
  const found = classifyNetworks(LINUX);

  test("each VPN is named by what it is, with this computer's address and the range it covers", () => {
    assert.deepEqual(
      found.filter((n) => n.vpn).map((n) => [n.kind, n.iface, n.address, n.range]),
      [
        ["tailscale", "tailscale0", "100.101.102.103", "100.64.0.0/10"],
        ["tailscale", "tailscale0", "fd7a:115c:a1e0::1", "fd7a:115c:a1e0::/48"],
        ["nebula", "nebula1", "192.168.100.7", "192.168.100.0/24"],
        ["vpn", "tun0", "10.211.0.6", "10.211.0.0/24"],
        ["wireguard", "wg0", "10.8.0.2", "10.8.0.0/24"],
        ["netbird", "wt0", "100.90.1.2", "100.90.0.0/16"],
        ["zerotier", "ztabcdef12", "10.147.17.5", "10.147.17.0/24"],
      ],
    );
  });

  test("Wi-Fi and wired networks come after the VPNs, marked as not a VPN", () => {
    const lan = found.filter((n) => !n.vpn);
    assert.deepEqual(lan.map((n) => [n.kind, n.iface, n.address, n.range]), [
      ["wired", "eth0", "192.168.50.4", "192.168.50.0/24"],
      ["wifi", "wlan0", "192.168.1.23", "192.168.1.0/24"],
    ]);
    const kinds = found.map((n) => n.vpn);
    assert.deepEqual(kinds, [...kinds].sort((a, b) => Number(b) - Number(a)), "every VPN first");
    assert.equal(found[0]!.kind, "tailscale", "Tailscale first of all");
  });

  test("loopback, Docker, VM and bridge networks, bridge ports, down and unknown virtual interfaces are left out", () => {
    for (const iface of ["lo", "docker0", "br-8d5defc7c72b", "incusbr0", "veth150fc5e", "vethport", "wg1", "myvirt0"]) assert.deepEqual(row(found, iface), [], iface);
  });

  test("link-local and public addresses are never listed: they can't be trusted", () => {
    assert.ok(!found.some((n) => n.address.startsWith("fe80") || n.address === "2001:db8::23"));
    assert.deepEqual(row(found, "ppp0"), [], "a tunnel with a public address");
  });

  test("a point-to-point address takes the most specific route on its interface that holds it, else no range", () => {
    assert.equal(row(found, "wg0")[0]!.range, "10.8.0.0/24");
    const bare = classifyNetworks({ ...LINUX, routes: {} });
    assert.equal(row(bare, "wg0")[0]!.range, null, "no route: the page asks for a range");
    assert.equal(row(bare, "tailscale0")[0]!.range, "100.64.0.0/10", "Tailscale's range is known");
    const dhcp6 = classifyNetworks({ platform: "linux", interfaces: { wlan0: [v6("fdea:1:2:3::9", 128)] }, facts: { wlan0: { devtype: "wlan", wireless: true, physical: true, up: true } }, routes: { wlan0: ["fe80::/64"] } });
    assert.equal(dhcp6[0]!.range, "fdea:1:2:3::/64", "a lone IPv6 address with no route sits on its /64");
  });

  test("every row starts untrusted and has a stable id per interface address", () => {
    assert.ok(found.every((n) => n.trusted === false));
    assert.equal(new Set(found.map((n) => n.id)).size, found.length);
    assert.equal(row(found, "wg0")[0]!.id, "wg0 10.8.0.2");
  });
});

describe("Tailscale", () => {
  test("LocalAPI's own addresses decide: NetBird's CGNAT address on wt0 stays NetBird", () => {
    const found = classifyNetworks({ ...LINUX, tailscale: ["100.101.102.103", "fd7a:115c:a1e0::1"] });
    assert.deepEqual(found.filter((n) => n.kind === "tailscale").map((n) => n.address), ["100.101.102.103", "fd7a:115c:a1e0::1"]);
    assert.equal(row(found, "wt0")[0]!.kind, "netbird");
  });

  test("without LocalAPI, a tunnel no name claims is Tailscale by its ranges (utun on a Mac)", () => {
    const mac: DetectInput = { platform: "darwin", interfaces: { utun4: [v4("100.70.1.2", 32, ZERO)], utun5: [v4("10.30.0.4", 32, ZERO)] }, routes: { utun5: ["10.30/16"] } };
    const found = classifyNetworks(mac);
    assert.deepEqual(found.map((n) => [n.kind, n.iface]), [["tailscale", "utun4"], ["vpn", "utun5"]]);
  });
});

describe("a Mac's networks", () => {
  const MAC_TABLE: DetectInput = {
    platform: "darwin",
    interfaces: {
      lo0: [v4("127.0.0.1", 8, ZERO, true)],
      en0: [v4("192.168.1.40", 24)],
      bridge100: [v4("192.168.64.1", 24)],
      awdl0: [v6("fe80::b", 64)],
      llw0: [v6("fe80::c", 64)],
      utun3: [v4("10.6.0.9", 32, ZERO)],
      feth1234: [v4("10.147.20.3", 24)],
      vmnet8: [v4("172.16.12.1", 24)],
    },
    routes: { utun3: ["10.6.0.0/24"] },
  };
  const found = classifyNetworks(MAC_TABLE);

  test("WireGuard on a Mac is a plain VPN, ZeroTier's feth is ZeroTier, an en port is Wi-Fi or wired", () => {
    assert.deepEqual(found.map((n) => [n.kind, n.iface, n.range]), [
      ["zerotier", "feth1234", "10.147.20.0/24"],
      ["vpn", "utun3", "10.6.0.0/24"],
      ["lan", "en0", "192.168.1.0/24"],
    ]);
  });

  test("its VM bridges, AirDrop and loopback are left out", () => {
    for (const iface of ["lo0", "bridge100", "awdl0", "llw0", "vmnet8"]) assert.deepEqual(row(found, iface), [], iface);
  });
});

describe("names", () => {
  test("each kind has its plain name beside the interface", () => {
    assert.equal(networkLabel({ kind: "wireguard", iface: "wg0" }), "WireGuard · wg0");
    assert.equal(networkLabel({ kind: "vpn", iface: "tun0" }), "VPN · tun0");
    assert.equal(networkLabel({ kind: "lan", iface: "en0" }), "Wi-Fi or wired · en0");
  });
});

describe("reading routes", () => {
  test("ip -j route: destinations, default left out, garbage is none", () => {
    assert.deepEqual(parseIpRoutes('[{"dst":"10.8.0.0/24","dev":"wg0","scope":"link"},{"dst":"default","dev":"wg0"},{"dst":"10.200.0.0/16"}]'), ["10.8.0.0/24", "10.200.0.0/16"]);
    assert.deepEqual(parseIpRoutes(""), []);
    assert.deepEqual(parseIpRoutes("{not json"), []);
  });

  test("netstat -rn: shortened networks are expanded per interface", () => {
    const text = [
      "Routing tables",
      "",
      "Internet:",
      "Destination        Gateway            Flags               Netif Expire",
      "default            192.168.1.1        UGScg                 en0",
      "10.6/16            utun3              USc                 utun3",
      "10.6.0.9           10.6.0.9           UH                  utun3",
      "192.168.1          link#6             UCS                   en0      !",
      "fd7a:115c:a1e0::/48 fe80::%utun4      Uc                  utun4",
    ].join("\n");
    assert.deepEqual(parseNetstatRoutes(text), { utun3: ["10.6.0.0/16", "10.6.0.9/32"], en0: ["192.168.1.0/24"], utun4: ["fd7a:115c:a1e0::/48"] });
  });
});
