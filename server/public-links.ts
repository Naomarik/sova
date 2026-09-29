import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SHARE_PORT_DEFAULT, type PublicLinksFile, type ShareFront, type ShareGatewaySetting, type ShareRoute } from "../shared/public-links";
import { stateRoot } from "./state-root";

/**
 * The Public links setting (§mesh.public/setting): `<stateRoot>/public-links.json`, 0600, written
 * atomically, parsed strictly (an unknown key or a wrong type rejects the whole file). Separate
 * from peers.json, so a host that is its own gateway works with the mesh off. A missing file is
 * `route: "off"`; a file that doesn't parse is logged and read as off, never half-applied.
 *
 * `lastKnownUrl` and `verifiedAt` are written only by the server (writeServerFields); a PUT's
 * patch can't carry them. The SOVA_SHARE_* variables win over the file (pinnedByEnv).
 */

export const OFF: PublicLinksFile = { version: 1, route: "off" };

const FRONTS: readonly ShareFront[] = ["vhost", "caddy", "funnel", "cloudflared"];
const FILE_KEYS = ["version", "route", "gateway", "ingressPort", "lastKnownUrl", "verifiedAt"];
const PATCH_KEYS = ["route", "gateway", "ingressPort"];
const GATEWAY_KEYS = ["publicUrl", "front", "sharePort", "acceptFrom"];
/** A Tailscale StableID (e.g. "nXXXXCNTRL"): short, printable, no spaces. */
const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ACCEPT_MAX = 256;

export const publicLinksFile = () => join(stateRoot(), "public-links.json");

class ParseError extends Error {}
const fail = (msg: string): never => {
  throw new ParseError(msg);
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function onlyKeys(v: Record<string, unknown>, keys: readonly string[], what: string): void {
  for (const k of Object.keys(v)) if (!keys.includes(k)) fail(`${what}: unknown key "${k}"`);
}
const isPort = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;

/** An https origin: no path, query, fragment or credentials; returned without a trailing slash. */
export function parsePublicUrl(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) return fail("publicUrl must be an https:// address");
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    return fail("publicUrl must be an https:// address");
  }
  if (u.protocol !== "https:") fail("publicUrl must start with https://");
  if (u.username || u.password) fail("publicUrl must not carry a user or password");
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) fail("publicUrl must be just the address, with no path");
  return u.origin;
}

function parseRoute(v: unknown): ShareRoute {
  if (v === "off" || v === "self") return v;
  if (isObj(v)) {
    onlyKeys(v, ["via"], "route");
    const via = v.via;
    if (isObj(via)) {
      onlyKeys(via, ["nodeId"], "route.via");
      if (typeof via.nodeId === "string" && NODE_ID.test(via.nodeId)) return { via: { nodeId: via.nodeId } };
    }
  }
  return fail('route must be "off", "self" or {via: {nodeId}}');
}

function parseGateway(v: unknown): ShareGatewaySetting {
  if (!isObj(v)) return fail("gateway must be an object");
  onlyKeys(v, GATEWAY_KEYS, "gateway");
  const publicUrl = parsePublicUrl(v.publicUrl);
  if (!FRONTS.includes(v.front as ShareFront)) fail(`gateway.front must be one of ${FRONTS.join(", ")}`);
  const sharePort = v.sharePort === undefined ? SHARE_PORT_DEFAULT : v.sharePort;
  if (!isPort(sharePort)) fail("gateway.sharePort must be a port, 1-65535");
  const acceptFrom = v.acceptFrom === undefined ? "all" : v.acceptFrom;
  if (acceptFrom !== "all") {
    if (!Array.isArray(acceptFrom) || acceptFrom.length > ACCEPT_MAX || !acceptFrom.every((x) => typeof x === "string" && NODE_ID.test(x)))
      fail('gateway.acceptFrom must be "all" or a list of node ids');
  }
  return { publicUrl, front: v.front as ShareFront, sharePort: sharePort as number, acceptFrom: acceptFrom === "all" ? "all" : [...new Set(acceptFrom as string[])] };
}

/** The whole file, strictly; throws on anything else. */
export function parsePublicLinks(raw: unknown): PublicLinksFile {
  if (!isObj(raw)) return fail("not an object");
  onlyKeys(raw, FILE_KEYS, "public-links.json");
  if (raw.version !== 1) fail("version must be 1");
  const out: PublicLinksFile = { version: 1, route: parseRoute(raw.route) };
  if (raw.gateway !== undefined) out.gateway = parseGateway(raw.gateway);
  if (raw.ingressPort !== undefined) {
    if (!isPort(raw.ingressPort)) fail("ingressPort must be a port, 1-65535");
    out.ingressPort = raw.ingressPort as number;
  }
  if (raw.lastKnownUrl !== undefined) out.lastKnownUrl = parsePublicUrl(raw.lastKnownUrl);
  if (raw.verifiedAt !== undefined) {
    if (typeof raw.verifiedAt !== "number" || !Number.isSafeInteger(raw.verifiedAt) || raw.verifiedAt < 0) fail("verifiedAt must be a time");
    out.verifiedAt = raw.verifiedAt as number;
  }
  if (out.route === "self" && !out.gateway) fail('route "self" needs a gateway setting');
  return out;
}

/** The setting as stored; off when there is no file or it doesn't parse. */
export function readPublicLinks(): PublicLinksFile {
  let text: string;
  try {
    text = readFileSync(publicLinksFile(), "utf8");
  } catch {
    return { ...OFF };
  }
  try {
    return parsePublicLinks(JSON.parse(text));
  } catch (err) {
    console.warn(`[share] public-links.json ignored (read as off): ${err instanceof ParseError ? err.message : "not JSON"}`);
    return { ...OFF };
  }
}

function write(file: PublicLinksFile): void {
  const path = publicLinksFile();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/**
 * Apply a PUT's patch: `{file}` as written, or `{error}` and nothing written. Changing the
 * gateway's address (or leaving "self") drops `verifiedAt`: a Verify vouches for one address.
 */
export function patchPublicLinks(patch: unknown): { file: PublicLinksFile } | { error: string } {
  const cur = readPublicLinks();
  try {
    if (!isObj(patch)) fail("Expected a JSON object body");
    const p = patch as Record<string, unknown>;
    onlyKeys(p, PATCH_KEYS, "body");
    const next: Record<string, unknown> = { ...cur };
    if ("route" in p) next.route = p.route;
    if ("gateway" in p) next.gateway = p.gateway;
    if ("ingressPort" in p) next.ingressPort = p.ingressPort;
    for (const k of PATCH_KEYS) if (next[k] === null) delete next[k];
    const file = parsePublicLinks(next);
    if (file.route !== "self" || file.gateway?.publicUrl !== cur.gateway?.publicUrl) delete file.verifiedAt;
    write(file);
    return { file };
  } catch (err) {
    if (err instanceof ParseError) return { error: err.message };
    throw err;
  }
}

/** The server-written fields: a Verify that passed (`verifiedAt`), a via gateway's URL as learnt
    (`lastKnownUrl`); null removes one. Returns the file as written. */
export function writeServerFields(fields: { verifiedAt?: number | null; lastKnownUrl?: string | null }): PublicLinksFile {
  const file = readPublicLinks();
  if (fields.verifiedAt !== undefined) {
    if (fields.verifiedAt === null) delete file.verifiedAt;
    else file.verifiedAt = fields.verifiedAt;
  }
  if (fields.lastKnownUrl !== undefined) {
    if (fields.lastKnownUrl === null) delete file.lastKnownUrl;
    else file.lastKnownUrl = parsePublicUrl(fields.lastKnownUrl);
  }
  write(file);
  return file;
}

/** A routed host's via gateway URL as learnt (its hello or ack): kept as `lastKnownUrl`, so links
    point there while the gateway is out of reach. Re-reads the file and writes it atomically;
    throws on a URL that isn't a bare https origin. */
export function recordLastKnownUrl(url: string): PublicLinksFile {
  return writeServerFields({ lastKnownUrl: url });
}

/** The SOVA_SHARE_* variables that are set, and so win over the setting. */
export const SHARE_ENV = ["SOVA_SHARE_PUBLIC_URL", "SOVA_SHARE_HOST", "SOVA_SHARE_PORT"] as const;
export function pinnedByEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return SHARE_ENV.filter((k) => !!env[k]?.trim());
}
