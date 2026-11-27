import type { DetectedNetwork, NetworkKind } from "../../shared/networks";
import { cidrContains, cidrText, ipValue, networkOf, parseCidr, PRIVATE_RANGES, type Cidr } from "./ranges";

// This computer's networks as the Access page lists them (§app.access/networks): VPNs named where
// they can be (Tailscale, WireGuard, ZeroTier, NetBird, Nebula; anything else a plain "VPN"), then
// Wi-Fi and wired networks. Docker, VM and bridge networks, loopback, link-local addresses and down
// interfaces are left out. Pure over a table of interfaces (os.networkInterfaces' shape) and the
// facts the system adds (server/networks/probe.ts reads them), so tests feed fixture tables.

/** One address of an interface, as os.networkInterfaces() gives it. */
export interface IfaceAddress {
  address: string;
  netmask: string;
  family: string | number;
  mac: string;
  internal: boolean;
  cidr: string | null;
}

/** What the system says of an interface beyond its addresses (Linux /sys/class/net/<if>/). */
export interface IfaceFacts {
  /** uevent's DEVTYPE: wireguard, wlan, bridge, vlan… */
  devtype?: string;
  /** A tun/tap device (tun_flags exists). */
  tun?: boolean;
  /** A wireless device (a `wireless` folder, or DEVTYPE=wlan). */
  wireless?: boolean;
  /** Backed by hardware (a `device` link). */
  physical?: boolean;
  /** Under /sys/devices/virtual. */
  virtual?: boolean;
  /** IFF_UP; false: down, left out. */
  up?: boolean;
  /** A port of a bridge (brport / master), never a network of its own. */
  bridgePort?: boolean;
}

export interface DetectInput {
  platform: NodeJS.Platform;
  interfaces: Record<string, IfaceAddress[] | undefined>;
  facts?: Record<string, IfaceFacts | undefined>;
  /** Route destinations per interface (CIDR text), read for point-to-point addresses only. */
  routes?: Record<string, string[] | undefined>;
  /** This node's Tailscale addresses from LocalAPI; null or absent when it can't be asked. */
  tailscale?: string[] | null;
}

/** Interfaces that are never a network a phone reaches this computer on. */
const EXCLUDED = /^(?:lo\d*|docker\d*|br-|veth|virbr|incusbr|lxcbr|lxdbr|bridge\d|vmnet|vboxnet|awdl|llw|anpi|ap\d|gif\d|stf\d|cni|flannel|cali|podman|kube|cilium|vxlan|tunl\d|sit\d|ip6tnl|ip_vti|ip6_vti|ip6gre|gre\d|gretap|erspan|dummy|ifb|nlmon|bond|team)/i;

const TAILSCALE_V4 = parseCidr("100.64.0.0/10")!;
const TAILSCALE_V6 = parseCidr("fd7a:115c:a1e0::/48")!;
const LINK_LOCAL = [parseCidr("169.254.0.0/16")!, parseCidr("fe80::/10")!];
const PRIVATE = PRIVATE_RANGES.map((r) => parseCidr(r)!);

const familyOf = (a: IfaceAddress): 4 | 6 | null => (a.family === "IPv4" || a.family === 4 ? 4 : a.family === "IPv6" || a.family === 6 ? 6 : null);
const zeroMac = (mac: string): boolean => /^(?:0{2}[:-]){5}0{2}$/.test(mac);

/** The kind a name says, where it says one. */
function kindByName(name: string, platform: NodeJS.Platform): NetworkKind | null {
  if (/^tailscale/i.test(name)) return "tailscale";
  if (/^wg/i.test(name)) return "wireguard";
  if (/^zt/i.test(name) || (platform === "darwin" && /^feth/i.test(name))) return "zerotier";
  if (/^wt\d/i.test(name)) return "netbird";
  if (/^nebula/i.test(name)) return "nebula";
  if (/^(?:tun|tap|ppp|ipsec|utun|gpd|cscotun|vpn|nordlynx|proton|mullvad|tailnet)/i.test(name)) return "vpn";
  return null;
}

/** The kind of a non-VPN interface, or null when it is some other virtual device (left out). */
function lanKind(name: string, facts: IfaceFacts | undefined, platform: NodeJS.Platform): NetworkKind | null {
  if (facts?.wireless || facts?.devtype === "wlan") return "wifi";
  if (platform === "linux") {
    if (facts?.physical) return /^wl/i.test(name) ? "wifi" : "wired";
    // No facts at all (a system that hides /sys): go by the name.
    if (!facts) return /^wl/i.test(name) ? "wifi" : /^(?:en|eth)/i.test(name) ? "wired" : null;
    return null;
  }
  // macOS and others: an en* port may be Wi-Fi or wired, and nothing cheap tells which.
  if (/^en\d/i.test(name)) return "lan";
  if (/^(?:eth|em)\d/i.test(name)) return "wired";
  if (/^wl/i.test(name)) return "wifi";
  return null;
}

/** The range a point-to-point address sits on: the most specific route on its interface that holds it, else
    the well-known Tailscale ranges for Tailscale. */
function rangeOf(address: string, prefix: number, family: 4 | 6, kind: NetworkKind, routes: string[] | undefined): Cidr | null {
  const full = family === 4 ? 32 : 128;
  if (prefix < full) return networkOf(address, prefix);
  let best: Cidr | null = null;
  for (const text of routes ?? []) {
    const c = parseCidr(text);
    if (!c || c.family !== family || c.prefix === 0 || c.prefix === full) continue;
    if (!cidrContains(c, address)) continue;
    if (!best || c.prefix > best.prefix) best = c;
  }
  if (best) return best;
  if (kind === "tailscale") return family === 4 ? TAILSCALE_V4 : TAILSCALE_V6;
  // A lone IPv6 address (DHCPv6 hands out /128s) sits on its /64, as IPv6 subnets are.
  if (family === 6) return networkOf(address, 64);
  return null;
}

const ORDER: Record<NetworkKind, number> = { tailscale: 0, wireguard: 1, zerotier: 1, netbird: 1, nebula: 1, vpn: 1, wifi: 2, wired: 2, lan: 2 };

/** The networks found, in the page's order: Tailscale, the other VPNs, then Wi-Fi and wired. `trusted` is false
    here; the listener manager marks it. */
export function classifyNetworks(input: DetectInput): DetectedNetwork[] {
  const out: DetectedNetwork[] = [];
  const tailscale = input.tailscale ? new Set(input.tailscale.map((a) => a.toLowerCase())) : null;
  for (const [name, addrs] of Object.entries(input.interfaces)) {
    if (!addrs?.length || EXCLUDED.test(name)) continue;
    const facts = input.facts?.[name];
    if (facts?.up === false || facts?.bridgePort || facts?.devtype === "bridge") continue;
    for (const a of addrs) {
      const family = familyOf(a);
      if (!family || a.internal) continue;
      const address = a.address.toLowerCase().replace(/%.*$/, "");
      if (!ipValue(address) || LINK_LOCAL.some((c) => cidrContains(c, address))) continue;
      // Only an address inside a private range can be trusted; a public one (a global IPv6 on Wi-Fi) isn't listed.
      if (!PRIVATE.some((c) => cidrContains(c, address))) continue;
      let kind = kindByName(name, input.platform);
      if (facts?.devtype === "wireguard" && (!kind || kind === "vpn")) kind = "wireguard";
      const tunnel = !!facts?.tun || facts?.devtype === "wireguard" || zeroMac(a.mac) || kind !== null;
      // Tailscale: its own addresses when LocalAPI answers, else its ranges on a tunnel no name claims
      // (utun on macOS). NetBird shares 100.64/10, so a name wins.
      if (tailscale ? tailscale.has(address) : (kind === null || kind === "vpn") && tunnel && (cidrContains(TAILSCALE_V4, address) || cidrContains(TAILSCALE_V6, address))) kind = "tailscale";
      if (!kind && tunnel) kind = "vpn";
      if (!kind) kind = lanKind(name, facts, input.platform);
      if (!kind) continue;
      const prefix = Number(/\/(\d+)$/.exec(a.cidr ?? "")?.[1] ?? (family === 4 ? 32 : 128));
      const range = rangeOf(address, prefix, family, kind, input.routes?.[name]);
      out.push({
        id: `${name} ${address}`,
        kind,
        iface: name,
        address,
        range: range ? cidrText(range) : null,
        vpn: ORDER[kind] < 2,
        trusted: false,
      });
    }
  }
  return out.sort((x, y) => ORDER[x.kind] - ORDER[y.kind] || x.iface.localeCompare(y.iface) || (x.address.includes(":") ? 1 : 0) - (y.address.includes(":") ? 1 : 0));
}

/** Whether an interface's addresses are all point-to-point (/32 or /128), so its range needs a route read. */
export function needsRoutes(addrs: IfaceAddress[] | undefined): boolean {
  return (addrs ?? []).some((a) => !a.internal && /\/(?:32|128)$/.test(a.cidr ?? ""));
}

const NAMES: Record<NetworkKind, string> = {
  tailscale: "Tailscale",
  wireguard: "WireGuard",
  zerotier: "ZeroTier",
  netbird: "NetBird",
  nebula: "Nebula",
  vpn: "VPN",
  wifi: "Wi-Fi",
  wired: "Wired",
  lan: "Wi-Fi or wired",
};

/** A network's name as the page and the pairing link say it: "WireGuard · wg0". */
export const networkLabel = (n: Pick<DetectedNetwork, "kind" | "iface">): string => `${NAMES[n.kind]} · ${n.iface}`;
