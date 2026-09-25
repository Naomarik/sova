import { isIP } from "node:net";
import type { FrontDoorConfig } from "../../shared/protocol";
import type { PeersConfig } from "./peers";

// The front door (brief: "Caddy with lb_policy first + active health checks, in an order the user
// sets"): generated here, from peers.json and the user's order, for the user to install. Sova
// never runs, writes or reloads Caddy. The directives are the lab's proven set
// (scripts/mesh-lab/lab.mjs writeCaddyfile, exercised by e2e m4).

/** A host's browser-facing address by default: its `tailscale serve` on :8443. */
export const DEFAULT_SERVE_PORT = 8443;

/** Tailscale's own resolver (MagicDNS), on every tailnet node. */
export const TAILNET_RESOLVER = "100.100.100.100";

/** A hostname that needs a DNS lookup: not an IP literal, not localhost. */
const isName = (hostname: string) => !isIP(hostname.replace(/^\[|\]$/g, "")) && hostname !== "localhost";

/** An upstream's dial address as Caddy reports it ({upstream_hostport}): host:port, IPv6 bracketed. */
export function upstreamHostport(upstream: string): string {
  const u = new URL(upstream);
  return `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
}

const origin = (host: string, port: number) => `https://${host.includes(":") ? `[${host}]` : host}:${port}`;

/**
 * The hosts in failover order: the user's `frontDoorOrder` first (ids that are no longer hosts are
 * skipped), then every host it leaves out, this host first, then peers.json order.
 * `selfDnsName` is this node's MagicDNS name when known (the mesh is on and tailscaled answered);
 * without it and without a self serveUrl, the self upstream is a placeholder the Caddyfile flags.
 */
export function frontDoorOrder(config: PeersConfig, selfDnsName: string | null): Array<{ id: string; label: string; upstream: string; placeholder?: true }> {
  const hosts = [
    {
      id: config.self.id,
      label: config.self.label,
      ...(config.self.serveUrl
        ? { upstream: config.self.serveUrl }
        : selfDnsName
          ? { upstream: origin(selfDnsName, DEFAULT_SERVE_PORT) }
          : { upstream: origin(`${config.self.id}.YOUR-TAILNET.ts.net`, DEFAULT_SERVE_PORT), placeholder: true as const }),
    },
    ...config.peers.map((p) => ({ id: p.id, label: p.label, upstream: p.serveUrl ?? origin(p.dnsName, DEFAULT_SERVE_PORT) })),
  ];
  const byId = new Map(hosts.map((h) => [h.id, h]));
  const chosen = (config.frontDoorOrder ?? []).filter((id) => byId.has(id));
  return [...chosen, ...hosts.map((h) => h.id).filter((id) => !chosen.includes(id))].map((id) => byId.get(id)!);
}

export function frontDoorConfig(config: PeersConfig, selfDnsName: string | null): FrontDoorConfig {
  const order = frontDoorOrder(config, selfDnsName);
  const flagged = order.filter((h) => h.placeholder).map((h) => h.id);
  const schemes = new Set(order.map((h) => new URL(h.upstream).protocol));
  // Upstream names are MagicDNS names: Caddy resolves them through tailscale itself, so the front
  // door's host needn't use MagicDNS as its system resolver (a server often doesn't).
  const named = order.some((h) => isName(new URL(h.upstream).hostname));
  const door = config.frontDoor ? new URL(config.frontDoor).origin : null;
  const loops = door ? order.filter((h) => new URL(h.upstream).origin === door).map((h) => h.id) : [];
  const transport = (indent: string) => [
    `${indent}transport http {`,
    `${indent}\tdial_timeout 2s`,
    `${indent}\tkeepalive 30s`,
    `${indent}\tresponse_header_timeout 35s`,
    ...(named ? [`${indent}\t# tailnet names, looked up through MagicDNS whatever this host's own DNS is`, `${indent}\tresolvers ${TAILNET_RESOLVER}`] : []),
    `${indent}}`,
  ];
  // Caddy never retries a 502 response, so the bare one tailscale serve gives for a down Sova is
  // handled per answering host (response matchers can't name the upstream; request matchers can).
  const fallback =
    order.length < 2
      ? []
      : [
          `\t\t# Sova down behind tailscale serve: serve answers a bare 502 (no Content-Type) until the`,
          `\t\t# health check marks the host down; a GET or HEAD is sent on to the other hosts in order.`,
          `\t\t# Sova's own 502s are JSON and pass through; a POST is never replayed.`,
          `\t\t@bare502 {`,
          `\t\t\tstatus 502`,
          `\t\t\theader !Content-Type`,
          `\t\t}`,
          `\t\thandle_response @bare502 {`,
          ...order.flatMap((h) => [
            `\t\t\t@from_${h.id} {`,
            `\t\t\t\tmethod GET HEAD`,
            `\t\t\t\tvars {http.reverse_proxy.upstream.hostport} ${upstreamHostport(h.upstream)}`,
            `\t\t\t}`,
            `\t\t\thandle @from_${h.id} {`,
            `\t\t\t\treverse_proxy ${order
              .filter((o) => o.id !== h.id)
              .map((o) => o.upstream)
              .join(" ")} {`,
            `\t\t\t\t\tlb_policy first`,
            `\t\t\t\t\tlb_try_duration 6s`,
            `\t\t\t\t\tlb_try_interval 250ms`,
            `\t\t\t\t\tmax_fails 3`,
            `\t\t\t\t\tfail_duration 3s`,
            `\t\t\t\t\tflush_interval -1`,
            `\t\t\t\t\theader_up Host {upstream_hostport}`,
            ...transport(`\t\t\t\t\t`),
            `\t\t\t\t\theader_down X-Sova-Upstream {upstream_hostport}`,
            `\t\t\t\t}`,
            `\t\t\t}`,
          ]),
          `\t\t\thandle {`,
          `\t\t\t\tcopy_response`,
          `\t\t\t}`,
          `\t\t}`,
        ];
  const lines = [
    `# Sova front door, generated by Sova (GET /api/mesh/front-door). Sova never runs or writes it.`,
    `# Failover order: ${order.map((h) => h.id).join(" > ")}. The first healthy upstream serves every`,
    `# request; when it fails its health check the next one takes over, and it takes back over once`,
    `# healthy again. Change the order on Sova's Mesh page, then copy this file again.`,
    `#`,
    `# Each upstream is a host's browser-facing address: by default its \`tailscale serve\` on :${DEFAULT_SERVE_PORT}`,
    `# (https, a ts.net certificate), or the address set for it on Sova's Mesh page.`,
    ...(flagged.length
      ? [`#`, `# TODO: ${flagged.join(", ")} has no known MagicDNS name yet (the mesh is off, or tailscaled`, `# did not answer): replace YOUR-TAILNET below, or set its address on Sova's Mesh page.`]
      : []),
    ...(schemes.size > 1
      ? [`#`, `# WARNING: Caddy needs every upstream on one scheme, and these mix http and https: give them`, `# all https (tailscale serve) or all http serve URLs, or Caddy refuses this file.`]
      : []),
    ...(loops.length
      ? [`#`, `# WARNING: ${loops.join(", ")}'s upstream is this front door's own address (${door}): it would proxy`, `# to itself. Set that host's address on Sova's Mesh page (e.g. its other tailscale serve port).`]
      : []),
    `#`,
    `# Where it listens: port SOVA_FRONT_DOOR_PORT (default 80) on SOVA_FRONT_DOOR_BIND (default: every`,
    `# interface), both read from Caddy's environment. Don't write an address into the site line`,
    `# instead: "127.0.0.1:4890 {" would make 127.0.0.1 a Host match and still listen everywhere.`,
    `#`,
    `# Serving this front door itself (pick one):`,
    `#  - on a tailnet node, behind \`tailscale serve --bg --https=443 http://127.0.0.1:4890\` with`,
    `#    SOVA_FRONT_DOOR_BIND=127.0.0.1 and SOVA_FRONT_DOOR_PORT=4890 in Caddy's environment (serve then`,
    `#    provides the ts.net certificate);`,
    `#  - or with a certificate from \`tailscale cert <name>.ts.net\`: site address <name>.ts.net and`,
    `#    \`tls <name>.ts.net.crt <name>.ts.net.key\` inside the site block.`,
    `# The front door's URL is a new browser origin: bookmarks and installed apps need the new address.`,
    `{`,
    `\tadmin localhost:2019`,
    `\tauto_https off`,
    `\tdefault_bind {$SOVA_FRONT_DOOR_BIND}`,
    `}`,
    ``,
    `:{$SOVA_FRONT_DOOR_PORT:80} {`,
    `\treverse_proxy ${order.map((h) => h.upstream).join(" ")} {`,
    `\t\tlb_policy first`,
    `\t\tlb_try_duration 6s`,
    `\t\tlb_try_interval 250ms`,
    `\t\t# one stalled connect (a tailnet path change) must not bench a healthy host: passive`,
    `\t\t# failures bench it only after 3 within 3s (a stopped host: under a second), and`,
    `\t\t# the active check needs 2 misses in a row to mark it down, 2 answers to bring it back`,
    `\t\tmax_fails 3`,
    `\t\tfail_duration 3s`,
    `\t\thealth_uri /api/health`,
    `\t\thealth_interval 1s`,
    `\t\thealth_timeout 2500ms`,
    `\t\thealth_fails 2`,
    `\t\thealth_passes 2`,
    `\t\t# streamed replies (chat) pass through unbuffered`,
    `\t\tflush_interval -1`,
    `\t\t# tailscale serve routes by Host: send each upstream its own name`,
    `\t\theader_up Host {upstream_hostport}`,
    `\t\t# reuse upstream connections: tailscale serve stalls a few new connections in a thousand`,
    `\t\t# for seconds, and a health check on a fresh one would bench a healthy host. A dead`,
    `\t\t# host's address blackholes: the dial is bounded, the health check marks it down within`,
    `\t\t# seconds, and a request already written into its pooled connection is bounded by the`,
    `\t\t# header timeout (Sova's slowest routes answer within 30s: a /peer hop, an ssh target)`,
    ...transport(`\t\t`),
    `\t\t# which host answered, for debugging`,
    `\t\theader_down X-Sova-Upstream {upstream_hostport}`,
    ...fallback,
    `\t}`,
    `}`,
    ``,
  ];
  return { order: order.map(({ id, label, upstream }) => ({ id, label, upstream })), caddyfile: lines.join("\n") };
}
