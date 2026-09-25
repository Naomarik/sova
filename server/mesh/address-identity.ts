import { isIP } from "node:net";
import type { Identity, TailnetStatus, WhoisResult } from "./localapi";
import type { PeerEntry } from "./peers";

// SOVA_MESH_IDENTITY=addresses: an Identity for hosts with no Tailscale LocalAPI (the Android
// app runs no tailscaled socket for other apps). The caller is the peers.json entry whose tailnet
// IP, written as an IP literal in its name or url, is exactly the connection's source address.
// This rests on WireGuard: a packet that arrives through the tunnel with a tailnet source came
// from that node. It is weaker than a StableID: an IP that the control plane reassigns (after the
// node is deleted) passes as the old peer. The listener binds tailnet addresses only (see
// tailnetAddresses), so a LAN caller can't reach it with a tailnet source.

/** 100.64.0.0/10 or fd7a:115c:a1e0::/48, canonical form; null for anything else. */
export function tailnetIp(raw: string): string | null {
  let ip = raw.trim().replace(/^\[|\]$/g, "");
  if (ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  const family = isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 100 && b! >= 64 && b! < 128 ? ip : null;
  }
  if (family === 6) {
    const canon = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    return canon.startsWith("fd7a:115c:a1e0:") ? canon : null;
  }
  return null;
}

/** The tailnet IPs a peers.json entry names: its name and its url's host, when IP literals. */
export function entryAddresses(p: PeerEntry): string[] {
  const out = new Set<string>();
  const byName = tailnetIp(p.dnsName);
  if (byName) out.add(byName);
  if (p.url) {
    try {
      const host = tailnetIp(new URL(p.url).hostname);
      if (host) out.add(host);
    } catch {
      // not a URL: nothing to match
    }
  }
  return [...out];
}

/** SOVA_PEER_HOST as tailnet IPs; throws on anything else (never a wildcard or loopback). */
export function tailnetAddresses(pinned: string | undefined): string[] {
  const list = (pinned ?? "").split(",").map((a) => a.trim()).filter(Boolean);
  if (!list.length) throw new Error("SOVA_MESH_IDENTITY=addresses needs SOVA_PEER_HOST (this node's tailnet IP)");
  return list.map((a) => {
    const ip = tailnetIp(a);
    if (!ip) throw new Error(`SOVA_PEER_HOST ${a} is not a tailnet address`);
    return ip;
  });
}

/** The IP of a whois address, "ip:port" or "[ipv6]:port"; null for any other shape. */
export function whoisHost(addr: string): string | null {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(addr) ?? /^([^:[\]]+):(\d+)$/.exec(addr);
  return m ? m[1]! : null;
}

/** SOVA_MESH_IDENTITY: "addresses" opts in; unset or empty is LocalAPI, silently; anything else
    is LocalAPI with a warning, so a typo doesn't pass unnoticed. */
export function identityMode(value: string | undefined): "addresses" | "localapi" {
  if (value === "addresses") return "addresses";
  if (value) console.warn(`[mesh] SOVA_MESH_IDENTITY=${JSON.stringify(value)} is not "addresses": using Tailscale LocalAPI`);
  return "localapi";
}

export function addressIdentity(peers: () => PeerEntry[], env: NodeJS.ProcessEnv = process.env): Identity {
  return {
    async status(): Promise<TailnetStatus> {
      const addresses = tailnetAddresses(env.SOVA_PEER_HOST);
      const self = {
        nodeId: env.SOVA_SELF_NODE_ID ?? "",
        name: env.SOVA_SELF_DNS ?? "",
        hostName: "",
        os: "",
        online: true,
        tags: [],
        login: "",
        addresses,
      };
      return { backendState: "Running", self, peers: [] };
    },
    async whois(addr: string): Promise<WhoisResult | null> {
      const host = whoisHost(addr);
      const ip = host === null ? null : tailnetIp(host);
      const own = new Set(tailnetAddresses(env.SOVA_PEER_HOST));
      const hits = ip && !own.has(ip) ? peers().filter((p) => entryAddresses(p).includes(ip)) : [];
      if (hits.length !== 1) {
        console.warn(`[mesh] refused ${addr}: ${!ip ? "not a tailnet address" : own.has(ip) ? "this host" : hits.length ? "several peers.json entries" : "no peers.json entry"}`);
        return null;
      }
      return { nodeId: hits[0]!.nodeId, name: hits[0]!.dnsName, tags: [], login: "" };
    },
  };
}
