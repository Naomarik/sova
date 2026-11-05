import { type RequestOptions, request } from "node:http";
import { discoversOnMac, type Endpoint, EndpointError, forgetLocalApiEndpoint, localApiEndpoint } from "./localapi-endpoint";

// Tailscale LocalAPI, plain node:http, no dependency: over tailscaled's unix socket on Linux, and on a
// Mac over whichever install answers (localapi-endpoint.ts: the app's port on 127.0.0.1 with its key,
// or a socket). Only `status` (this node and its peers) and `whois` (who is on the other end of a
// tailnet connection) are used. Nothing here runs unless the mesh is on, or the user asks for
// discovery. Tests inject their own `Identity` (setIdentity); the lab and real hosts use LocalAPI.

export { DEFAULT_TAILSCALE_SOCKET } from "./localapi-endpoint";
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

/** Why a Mac can't ask its Tailscale, when it is one a person can act on; each has its own words there.
    Every other failure (Linux, SOVA_TAILSCALE_SOCKET, a reset connection, an answer) keeps tailscaled's. */
type Trouble = "missing" | "not-running" | "not-running-daemon" | "not-admin" | "refused" | "refused-daemon" | "slow";

const ON_A_MAC: Record<Trouble, string> = {
  missing: "Sova can't find Tailscale on this Mac. Install the Tailscale app from tailscale.com and sign in.",
  "not-running": "Tailscale isn't running on this Mac. Open the Tailscale app and connect.",
  "not-running-daemon": "Tailscale (tailscaled) isn't running on this Mac. Start tailscaled.",
  "not-admin": "Only an administrator account on this Mac can ask Tailscale who's connected. Run Sova from an administrator account.",
  refused: "Tailscale on this Mac refused Sova's request. Quit and reopen the Tailscale app.",
  "refused-daemon": "Tailscale (tailscaled) on this Mac refused Sova's request. Restart tailscaled.",
  slow: "Tailscale on this Mac didn't answer in time. Try again.",
};

class LocalApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** The connection's error code ("ETIMEDOUT" for no answer in time); none for an answer. */
    readonly code?: string,
  ) {
    super(message);
  }
}

let connectForTest: RequestOptions["createConnection"] | null = null;
/** Tests only: open each LocalAPI connection in-process (node:http's createConnection) instead of
    dialing its endpoint; returns the undo. Never set outside tests. */
export function setLocalApiConnectForTest(connect: RequestOptions["createConnection"] | null): () => void {
  const before = connectForTest;
  connectForTest = connect;
  return () => {
    connectForTest = before;
  };
}

/** One GET /localapi/v0/<path> at an endpoint → parsed JSON. A non-2xx answer throws with its status.
    The app's key goes only to 127.0.0.1, in the request's Authorization, and into no message. */
function once(at: Endpoint, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: "local-tailscaled.sock" };
    if (at.kind === "tcp") headers.Authorization = `Basic ${Buffer.from(`:${at.token}`).toString("base64")}`;
    // 127.0.0.1, never "localhost", which can resolve to ::1, where the app doesn't listen.
    const where: RequestOptions = at.kind === "socket" ? { socketPath: at.path } : { host: "127.0.0.1", port: at.port };
    const req = request(
      { ...where, path: `/localapi/v0/${path}`, headers, timeout: TIMEOUT_MS, ...(connectForTest ? { createConnection: connectForTest } : {}) },
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
    req.on("timeout", () => req.destroy(new LocalApiError("tailscaled did not answer in time", undefined, "ETIMEDOUT")));
    req.on("error", (err) =>
      reject(err instanceof LocalApiError ? err : new LocalApiError(`tailscaled unreachable: ${err.message}`, undefined, (err as NodeJS.ErrnoException).code ?? "")),
    );
    req.end();
  });
}

/** Whether a failure says the endpoint may be gone or wrong (a connection error, or a refused key):
    it is then forgotten, so the next request looks again, whatever the failure's words. */
const unreachable = (err: unknown): err is LocalApiError =>
  err instanceof LocalApiError && (err.status === 401 || err.status === 403 || (err.status === undefined && err.code !== undefined));

/** The Mac words for a failure at an endpoint, or null to keep its own (technical) message. */
function trouble(err: unknown, at: Endpoint): Trouble | null {
  if (!unreachable(err)) return null;
  if (err.status !== undefined) return at.kind === "socket" ? "refused-daemon" : "refused";
  if (err.code === "ENOENT") return "missing";
  if (err.code === "ECONNREFUSED") return at.kind === "socket" ? "not-running-daemon" : "not-running";
  if (err.code === "ETIMEDOUT") return "slow";
  return null; // ECONNRESET, EPIPE, EACCES on a socket, no code: tailscaled's own words
}

const onAMac = (why: Trouble): LocalApiError => new LocalApiError(ON_A_MAC[why]);
/** A failure as said on a Mac: its Mac words, or the failure itself. */
const said = (err: unknown, at: Endpoint): unknown => {
  const why = trouble(err, at);
  return why ? onAMac(why) : err;
};

/** GET /localapi/v0/<path> → parsed JSON, from this host's own Tailscale. On a Mac, a refused
    connection or key at the app's port means one fresh look (the app may have restarted on a new
    port and key, or left its files behind) and one retry; what a person can act on is said for a Mac.
    With SOVA_TAILSCALE_SOCKET set, a Mac does as Linux. */
async function localApi(path: string): Promise<unknown> {
  if (!discoversOnMac()) return once(await localApiEndpoint(), path);
  let at: Endpoint;
  try {
    at = await localApiEndpoint();
  } catch (err) {
    throw err instanceof EndpointError ? onAMac(err.reason) : err;
  }
  try {
    return await once(at, path);
  } catch (err) {
    if (!unreachable(err)) throw err;
    forgetLocalApiEndpoint();
    const retry = at.kind === "tcp" && (err.status !== undefined || err.code === "ECONNREFUSED");
    if (!retry) throw said(err, at);
    let next: Endpoint;
    try {
      next = await localApiEndpoint(at);
    } catch (e) {
      throw e instanceof EndpointError && e.reason === "not-admin" ? onAMac("not-admin") : said(err, at);
    }
    try {
      return await once(next, path);
    } catch (e) {
      if (!unreachable(e)) throw e;
      forgetLocalApiEndpoint();
      throw said(e, next);
    }
  }
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
