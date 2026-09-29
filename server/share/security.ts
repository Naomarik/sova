import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { INGRESS_STRIP_HEADERS } from "../../shared/public-links";

/**
 * The public-links security helpers (§mesh.public/forwarded-for): whose forwarded address a share
 * server believes (trustedClient), and which headers a gateway hop drops (stripForwarded). The
 * share edge's default client key is trustedClient's `local-proxy`; clientAddress is the old rule,
 * kept only for its callers' imports.
 */

type ClientRequest = Pick<IncomingMessage, "headers"> & { socket: { remoteAddress?: string } };

/**
 * The pre-public-links rule: a loopback or tailnet (100.64.0.0/10, fd7a:115c:a1e0::/48) peer's
 * last X-Forwarded-For hop is used instead of the socket address. Any tailnet device can therefore
 * choose its own key, so no share server uses it any more (trustedClient replaced it).
 */
export function clientAddress(req: ClientRequest): string {
  const peer = req.socket.remoteAddress ?? "";
  const plain = peer.replace(/^::ffff:/, "");
  const proxied = plain === "127.0.0.1" || plain === "::1" || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(plain) || /^fd7a:115c:a1e0:/i.test(plain);
  const xff = req.headers["x-forwarded-for"];
  if (proxied && typeof xff === "string" && xff.trim()) return xff.split(",").pop()!.trim();
  return plain || "unknown";
}

/** An IP literal in one canonical spelling: IPv4 dotted, an IPv4-mapped IPv6 as its IPv4, IPv6
    lowercase and compressed (brackets allowed around it). null for anything else: a port, a zone,
    a name, an empty or padded string. */
export function canonicalIp(raw: string): string | null {
  let ip = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  const family = isIP(ip);
  if (family === 4) return ip;
  if (family !== 6 || ip.includes("%")) return null;
  ip = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (mapped) {
    const hi = parseInt(mapped[1]!, 16);
    const lo = parseInt(mapped[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return ip;
}

function loopback(ip: string): boolean {
  return ip === "::1" || (isIP(ip) === 4 && ip.startsWith("127."));
}

/** Whose X-Forwarded-For a listener may believe. `local-proxy`: the gateway's configured front on
    this host's loopback, never any tailnet peer's last hop. `admitted`: a routed host's ingress,
    only on a connection its gate admitted, and only a single value. `none`: never. */
export type ForwardedTrust = "local-proxy" | "admitted" | "none";

export interface TrustedClientContext {
  trust: ForwardedTrust;
  /** The connection passed the ingress gate. Known from the listener's own control flow (its
      `client` runs only after `admit`), never from anything the request says. */
  admitted?: boolean;
}

/**
 * The address a request is rate-limited and logged under: the socket's own address (canonical,
 * "unknown" when it has none), unless the context believes one X-Forwarded-For value:
 * - `local-proxy`, from a loopback socket only: the LAST hop, the one the local front appended
 *   (repeated headers arrive joined with ", "). A tailnet or LAN socket is never believed.
 * - `admitted`, only when `admitted` is true: a single value (one header, no comma).
 * A believed value that is not an IP literal falls back to the socket address. No other
 * forwarding header (Forwarded, X-Real-IP, Tailscale-*, x-sova-*) is ever read.
 */
export function trustedClient(req: ClientRequest, ctx: TrustedClientContext): string {
  const socket = canonicalIp(req.socket.remoteAddress ?? "") ?? "unknown";
  const raw: unknown = req.headers["x-forwarded-for"];
  const xff = Array.isArray(raw) ? raw.join(", ") : typeof raw === "string" ? raw : null;
  if (xff === null) return socket;
  let claimed: string | undefined;
  if (ctx.trust === "local-proxy" && loopback(socket)) claimed = xff.split(",").pop();
  else if (ctx.trust === "admitted" && ctx.admitted === true && !Array.isArray(raw) && !xff.includes(",")) claimed = xff;
  return (claimed !== undefined && canonicalIp(claimed.trim())) || socket;
}

/** Hop-by-hop headers (RFC 9110 §7.6.1, plus the legacy ones proxies still see): never forwarded. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade"]);
const STRIP_EXACT = new Set<string>(INGRESS_STRIP_HEADERS.filter((h) => !h.endsWith("*")));
const STRIP_PREFIX = INGRESS_STRIP_HEADERS.filter((h) => h.endsWith("*")).map((h) => h.slice(0, -1));

/** The request headers a gateway forwards on a hop, with every client-supplied forwarding,
    identity and hop-by-hop header removed (INGRESS_STRIP_HEADERS, case-insensitively, and any
    header Connection names). A new object with lowercase names; the input is not changed. The
    gateway then sets INGRESS_SET_HEADERS itself, and a `/ws/h` hop its own Upgrade and
    Connection (both hop-by-hop, so stripped here). Host is kept: the hop decides it. */
export function stripForwarded(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const named = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "connection" || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) for (const token of v.split(",")) if (token.trim()) named.add(token.trim().toLowerCase());
  }
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(key) || named.has(key) || STRIP_EXACT.has(key) || STRIP_PREFIX.some((p) => key.startsWith(p))) continue;
    out[key] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}
