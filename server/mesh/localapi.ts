import { request } from "node:http";

// Tailscale LocalAPI over the system tailscaled's unix socket: plain node:http, no dependency.
// Only `status` (this node and its peers) and `whois` (who is on the other end of a tailnet
// connection) are used. Nothing here runs unless the mesh is on, or the user asks for discovery.
// Tests inject their own `Identity` (setIdentity); the lab and real hosts use the socket.

export const DEFAULT_TAILSCALE_SOCKET = "/var/run/tailscale/tailscaled.sock";
const TIMEOUT_MS = 2000;

export interface WhoisResult {
  /** Tailscale StableID: the one thing a peer is authenticated by. */
  nodeId: string;
  /** MagicDNS name, without the trailing dot. */
  name: string;
  tags: string[];
  login: string;
}

export interface TailnetNode {
  nodeId: string;
  /** MagicDNS name, without the trailing dot. */
  name: string;
  hostName: string;
  os: string;
  online: boolean;
  tags: string[];
  login: string;
  addresses: string[];
}

export interface TailnetStatus {
  backendState: string;
  self: TailnetNode;
  peers: TailnetNode[];
}

export interface Identity {
  status(): Promise<TailnetStatus>;
  /** `addr` is "ip:port" (IPv6 as "[ip]:port"); null when tailscaled knows no such caller. */
  whois(addr: string): Promise<WhoisResult | null>;
}

export const tailscaleSocket = (): string => process.env.SOVA_TAILSCALE_SOCKET || DEFAULT_TAILSCALE_SOCKET;

class LocalApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** GET /localapi/v0/<path> → parsed JSON. A non-2xx answer throws with its status. */
function localApi(path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: tailscaleSocket(), path: `/localapi/v0/${path}`, headers: { Host: "local-tailscaled.sock" }, timeout: TIMEOUT_MS },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
            reject(new LocalApiError(`tailscaled ${path.split("?")[0]}: ${res.statusCode} ${body.trim().slice(0, 200)}`, res.statusCode));
            return;
          }
          try {
            // User and node numeric ids exceed 2^53: keep them as strings so they still match.
            resolve(JSON.parse(body.replace(/"(UserID|ID)":\s*(-?\d+)/g, '"$1":"$2"')));
          } catch {
            reject(new LocalApiError(`tailscaled ${path.split("?")[0]}: not JSON`));
          }
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new LocalApiError("tailscaled did not answer in time")));
    req.on("error", (err) => reject(err instanceof LocalApiError ? err : new LocalApiError(`tailscaled unreachable: ${err.message}`)));
    req.end();
  });
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const dnsName = (v: unknown): string => str(v).replace(/\.$/, "");

function node(raw: Record<string, unknown>, users: Record<string, unknown>): TailnetNode {
  const user = users[String(raw.UserID)] as Record<string, unknown> | undefined;
  const tags = strs(raw.Tags);
  return {
    nodeId: str(raw.ID),
    name: dnsName(raw.DNSName),
    hostName: str(raw.HostName),
    os: str(raw.OS),
    online: raw.Online === true,
    tags,
    // Tagged nodes belong to no user; tailscaled reports them as "tagged-devices".
    login: tags.length ? "tagged-devices" : str(user?.LoginName),
    addresses: strs(raw.TailscaleIPs),
  };
}

/** Parse a LocalAPI `status` body (exported for tests). */
export function parseStatus(raw: unknown): TailnetStatus {
  const r = (raw ?? {}) as Record<string, unknown>;
  const users = (r.User ?? {}) as Record<string, unknown>;
  const peers = Object.values((r.Peer ?? {}) as Record<string, Record<string, unknown>>).map((p) => node(p, users));
  return { backendState: str(r.BackendState), self: node((r.Self ?? {}) as Record<string, unknown>, users), peers };
}

/** Parse a LocalAPI `whois` body (exported for tests); null without a StableID. */
export function parseWhois(raw: unknown): WhoisResult | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = (r.Node ?? {}) as Record<string, unknown>;
  const u = (r.UserProfile ?? {}) as Record<string, unknown>;
  const nodeId = str(n.StableID);
  if (!nodeId) return null;
  const tags = strs(n.Tags);
  return { nodeId, name: dnsName(n.Name), tags, login: tags.length ? "tagged-devices" : str(u.LoginName) };
}

export const localApiIdentity: Identity = {
  status: async () => parseStatus(await localApi("status")),
  whois: async (addr) => {
    try {
      return parseWhois(await localApi(`whois?addr=${encodeURIComponent(addr)}`));
    } catch (err) {
      if (err instanceof LocalApiError && err.status === 404) return null; // "no match for IP:port"
      throw err;
    }
  },
};

let identity: Identity = localApiIdentity;
export const getIdentity = (): Identity => identity;
/** Tests only: swap in a stub identity provider. */
export const setIdentity = (next: Identity): void => {
  identity = next;
};

/** "ip:port" for whois, bracketing IPv6 and unwrapping IPv4-mapped addresses. */
export function whoisAddr(address: string, port: number): string {
  const ip = address.startsWith("::ffff:") && address.includes(".") ? address.slice(7) : address;
  return ip.includes(":") ? `[${ip}]:${port}` : `${ip}:${port}`;
}
