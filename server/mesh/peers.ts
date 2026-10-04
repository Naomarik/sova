import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { parseIp, relayAddress } from "../../shared/mesh-lan";
import type { SyncCategory } from "../../shared/protocol";
import { stateRoot } from "../state-root";
import { isLanNodeId, lanNodeId, parsePin } from "./lan-cert";

// The mesh allowlist: `<state root>/peers.json`, curated by the user (by hand or through
// PUT /api/mesh/peers). The mesh is ON exactly when this file parses and lists at least one peer;
// a missing, empty or malformed file is OFF, and a malformed one is never overwritten.
// A peer is authenticated by its Tailscale StableID (`nodeId`) alone, never by a name: names are
// chosen by the nodes themselves.

export const DEFAULT_PEER_PORT = 4801;
/** SOVA_PEER_PORT: this host's peer-listener port, and the default port of a peer's URL. */
export const peerPort = (): number => {
  const n = Number(process.env.SOVA_PEER_PORT);
  return process.env.SOVA_PEER_PORT && Number.isInteger(n) && n >= 0 && n < 65536 ? n : DEFAULT_PEER_PORT;
};
export const PEER_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface PeerEntry {
  /** Slug used in /peer/<id>/; unique, never the self id. */
  id: string;
  label: string;
  /** Tailscale StableID ("n…CNTRL" on tailscale.com; a decimal string on Headscale). */
  nodeId: string;
  /** MagicDNS name or tailnet IP: what the UI shows, and where this host dials by default. */
  dnsName: string;
  /** The peer's peer-listener origin, when not the default (see peerUrl). */
  url?: string;
  /** Front-door order hint; Sova only reports it. */
  priority?: number;
  /** Its browser-facing address (the front door's upstream), when not https://<dnsName>:8443. */
  serveUrl?: string;
  /** When this host paired it (ms epoch); absent for peers paired before dates were recorded. */
  pairedAt?: number;
  /** When the peer named itself `label` (its clock, ms epoch); absent: a name given here. */
  labelAt?: number;
  /** false: the peer said it has no browser address (its Browser access is off); absent: it has one. */
  browserAccess?: false;
  /** When the peer set that (its clock, ms epoch, clamped); absent: it never sent a stamp. */
  browserAccessAt?: number;
  /** A dial-out pairing (§mesh.lan/pairing), reached over pinned TLS instead of the tailnet. Its
      nodeId is lanNodeId(pin); it has no url, serveUrl or browser address. */
  lan?: LanLink;
}

/** How a dial-out pairing is reached. */
export interface LanLink {
  /** "dial": this host dials the peer, its relay. "accept": the peer dials this host. */
  role: "dial" | "accept";
  /** The peer's key pin: 32 upper-case hex digits (lan-cert.ts). */
  pin: string;
  /** role "dial": where the relay listens. */
  host?: string;
  port?: number;
}

/** This host as a relay for dial-out hosts: where it listens while it accepts any (§mesh.lan/pairing). */
export interface RelaySetting {
  /** One loopback, private or link-local IP address of this host (shared/mesh-lan.ts relayAddress). */
  host: string;
  /** 1–65535; 0 picks a free port (tests). */
  port: number;
  /** Only "lan" (a misbehaving address is banned for 5 min): "internet" waits for the separate
      accept process, so it is refused. Absent: "lan". */
  exposure?: "lan";
}

export const SYNC_CATEGORIES: readonly SyncCategory[] = ["settings", "themes", "extensions", "logins"];

export interface PeersConfig {
  /** `labelAt`: when this host last renamed itself (ms epoch); absent: never, since recorded.
      `browserAccess`: this host's own Browser access setting; absent: SOVA_BROWSER_ACCESS decides.
      `browserAccessAt`: when it was last set (ms epoch). */
  self: { id: string; label: string; serveUrl?: string; labelAt?: number; browserAccess?: boolean; browserAccessAt?: number; relay?: RelaySetting };
  peers: PeerEntry[];
  /** Per-category sync switches the user has set; an absent category is on. */
  sync: Partial<Record<SyncCategory, boolean>>;
  frontDoor: string | null;
  /** The front door's upstream order the user set: host ids (self included). */
  frontDoorOrder?: string[];
  /** Hosts the front door leaves out (ids); absent = none. */
  frontDoorExclude?: string[];
  /** Which logins this host syncs; stored only when "api-keys" (absent = all). */
  loginKinds?: "api-keys";
}

export type PeersRead = { ok: true; config: PeersConfig } | { ok: false; error: string; missing?: true };

/** Read per call, like every state path: PI_CODING_AGENT_DIR is what the tests move. */
export const peersFile = (): string => join(stateRoot(), "peers.json");

/** This machine's short hostname as a peer-id slug (the default self id). */
export function defaultSelfId(): string {
  const slug = hostname()
    .split(".")[0]!
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+/, "")
    .slice(0, 32);
  return slug || "sova";
}

const text = (v: unknown, max = 80): string | null => (typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null);
// A MagicDNS name, a bare host name, an IPv4 or an IPv6 address; nothing that could carry a path or credentials.
const NAME_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9-]{1,63})*\.?|[0-9a-fA-F:]+)$/;

/** A peer URL: http(s)://host[:port] and nothing else → its origin, else the reason it isn't one. */
function checkUrl(raw: unknown): { url: string } | { error: string } {
  if (typeof raw !== "string") return { error: "must be a string" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: "is not a URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "must be http(s)" };
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return { error: "must be scheme, host and port only" };
  return { url: url.origin };
}

/** Where this host dials a peer: its explicit `url`, else http://<dnsName>:<peer port>. */
export function peerUrl(p: PeerEntry): string {
  if (p.url) return p.url;
  return `http://${p.dnsName.includes(":") ? `[${p.dnsName}]` : p.dnsName}:${peerPort()}`;
}

/**
 * Validate a whole config document (the file, or a PUT body). Every error is fatal: a half-valid
 * allowlist is not something to guess about.
 */
export function validatePeers(raw: unknown): { config: PeersConfig } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "expected an object" };
  const r = raw as Record<string, unknown>;
  if (r.version !== undefined && r.version !== 1) return { error: `unsupported version ${JSON.stringify(r.version)}` };
  const selfRaw = (r.self ?? {}) as Record<string, unknown>;
  if (typeof selfRaw !== "object" || selfRaw === null || Array.isArray(selfRaw)) return { error: "self must be an object" };
  const selfId = selfRaw.id === undefined ? defaultSelfId() : selfRaw.id;
  if (typeof selfId !== "string" || !PEER_ID_RE.test(selfId)) return { error: `self.id must match ${PEER_ID_RE}` };
  if (selfRaw.label !== undefined && !text(selfRaw.label)) return { error: "self.label must be a non-empty string (≤ 80)" };
  if (selfRaw.labelAt !== undefined && !isTime(selfRaw.labelAt)) return { error: "self.labelAt must be a time (ms epoch)" };
  if (selfRaw.browserAccess !== undefined && typeof selfRaw.browserAccess !== "boolean") return { error: "self.browserAccess must be true or false" };
  if (selfRaw.browserAccessAt !== undefined && !isTime(selfRaw.browserAccessAt)) return { error: "self.browserAccessAt must be a time (ms epoch)" };
  const selfServe = selfRaw.serveUrl === undefined || selfRaw.serveUrl === null ? null : checkUrl(selfRaw.serveUrl);
  if (selfServe && "error" in selfServe) return { error: `self.serveUrl ${selfServe.error}` };
  const relay = selfRaw.relay === undefined || selfRaw.relay === null ? null : checkRelay(selfRaw.relay);
  if (relay && "error" in relay) return { error: `self.relay ${relay.error}` };
  if (r.peers !== undefined && !Array.isArray(r.peers)) return { error: "peers must be an array" };
  const peers: PeerEntry[] = [];
  const ids = new Set([selfId]);
  const nodes = new Set<string>();
  for (const [i, p] of ((r.peers as unknown[] | undefined) ?? []).entries()) {
    if (typeof p !== "object" || p === null || Array.isArray(p)) return { error: `peers[${i}] is not an object` };
    const e = p as Record<string, unknown>;
    if (typeof e.id !== "string" || !PEER_ID_RE.test(e.id)) return { error: `peers[${i}].id must match ${PEER_ID_RE}` };
    if (ids.has(e.id)) return { error: `peers[${i}].id ${e.id} is not unique (or is the self id)` };
    const lan = e.lan === undefined ? null : checkLan(e.lan);
    if (lan && "error" in lan) return { error: `peers[${i}].lan ${lan.error}` };
    const nodeId = lan ? lanNodeId(lan.link.pin) : text(e.nodeId, 128);
    if (!nodeId) return { error: `peers[${i}].nodeId is required` };
    if (lan && e.nodeId !== undefined && e.nodeId !== nodeId) return { error: `peers[${i}].nodeId must be ${nodeId} for this pin` };
    if (!lan && isLanNodeId(nodeId)) return { error: `peers[${i}].nodeId: "lan:" names a dial-out pairing, which needs a lan link` };
    if (nodes.has(nodeId)) return { error: `peers[${i}].nodeId is listed twice` };
    if (lan && (e.url !== undefined || e.serveUrl !== undefined)) return { error: `peers[${i}]: a dial-out pairing has no url or serveUrl` };
    const dnsName = lan ? (lan.link.host ?? DIAL_OUT_NAME) : text(e.dnsName, 253);
    // A pairing's was judged by checkLan (a link-local relay may carry a zone, which no name has).
    if (!dnsName || (!lan && !NAME_RE.test(dnsName))) return { error: `peers[${i}].dnsName must be a tailnet name or IP` };
    if (e.label !== undefined && !text(e.label)) return { error: `peers[${i}].label must be a non-empty string (≤ 80)` };
    const url = e.url === undefined ? null : checkUrl(e.url);
    if (url && "error" in url) return { error: `peers[${i}].url ${url.error}` };
    if (e.priority !== undefined && !Number.isFinite(e.priority)) return { error: `peers[${i}].priority must be a number` };
    const serve = e.serveUrl === undefined || e.serveUrl === null ? null : checkUrl(e.serveUrl);
    if (serve && "error" in serve) return { error: `peers[${i}].serveUrl ${serve.error}` };
    if (e.browserAccess !== undefined && e.browserAccess !== false && e.browserAccess !== true) return { error: `peers[${i}].browserAccess must be true or false` };
    for (const k of ["pairedAt", "labelAt", "browserAccessAt"] as const) {
      if (e[k] !== undefined && !isTime(e[k])) return { error: `peers[${i}].${k} must be a time (ms epoch)` };
    }
    ids.add(e.id);
    nodes.add(nodeId);
    peers.push({
      id: e.id,
      label: text(e.label) ?? e.id,
      nodeId,
      dnsName: dnsName.replace(/\.$/, ""),
      ...(url ? { url: url.url } : {}),
      ...(e.priority !== undefined ? { priority: e.priority as number } : {}),
      ...(serve ? { serveUrl: serve.url } : {}),
      ...(e.pairedAt !== undefined ? { pairedAt: e.pairedAt as number } : {}),
      ...(e.labelAt !== undefined ? { labelAt: e.labelAt as number } : {}),
      // A dial-out pairing never has a browser address (§mesh.lan/pairing).
      ...(e.browserAccess === false || lan ? { browserAccess: false as const } : {}),
      ...(e.browserAccessAt !== undefined ? { browserAccessAt: e.browserAccessAt as number } : {}),
      ...(lan ? { lan: lan.link } : {}),
    });
  }
  const syncRaw = r.sync ?? {};
  if (typeof syncRaw !== "object" || syncRaw === null || Array.isArray(syncRaw)) return { error: "sync must be an object" };
  const sync: Partial<Record<SyncCategory, boolean>> = {};
  for (const [k, v] of Object.entries(syncRaw)) {
    if (!(SYNC_CATEGORIES as readonly string[]).includes(k)) return { error: `sync.${k} is not a sync category` };
    if (typeof v !== "boolean") return { error: `sync.${k} must be true or false` };
    sync[k as SyncCategory] = v;
  }
  let frontDoor: string | null = null;
  if (r.frontDoor !== undefined && r.frontDoor !== null) {
    const fd = checkUrl(r.frontDoor);
    if ("error" in fd) return { error: `frontDoor ${fd.error}` };
    frontDoor = fd.url;
  }
  // Ids that are no longer hosts (a removed peer) are tolerated in both lists and skipped where used.
  const frontDoorOrder = hostIds(r.frontDoorOrder, "frontDoorOrder");
  if (frontDoorOrder && "error" in frontDoorOrder) return frontDoorOrder;
  const frontDoorExclude = hostIds(r.frontDoorExclude, "frontDoorExclude");
  if (frontDoorExclude && "error" in frontDoorExclude) return frontDoorExclude;
  if (r.loginKinds !== undefined && r.loginKinds !== null && r.loginKinds !== "all" && r.loginKinds !== "api-keys") {
    return { error: 'loginKinds must be "all" or "api-keys"' };
  }
  const apiKeysOnly = r.loginKinds === "api-keys";
  const self = {
    id: selfId,
    label: text(selfRaw.label) ?? selfId,
    ...(selfServe ? { serveUrl: selfServe.url } : {}),
    ...(selfRaw.labelAt !== undefined ? { labelAt: selfRaw.labelAt as number } : {}),
    ...(typeof selfRaw.browserAccess === "boolean" ? { browserAccess: selfRaw.browserAccess } : {}),
    ...(selfRaw.browserAccessAt !== undefined ? { browserAccessAt: selfRaw.browserAccessAt as number } : {}),
    ...(relay ? { relay: relay.relay } : {}),
  };
  return {
    config: {
      self,
      peers,
      sync,
      frontDoor,
      ...(frontDoorOrder ? { frontDoorOrder } : {}),
      ...(frontDoorExclude?.length ? { frontDoorExclude } : {}),
      ...(apiKeysOnly ? { loginKinds: "api-keys" as const } : {}),
    },
  };
}

/**
 * Whether this host has a browser address: its own setting once made, else SOVA_BROWSER_ACCESS
 * ("off" declares none; the phone installer writes it). A label only: nothing opens or closes.
 */
export function selfBrowserAccess(config: PeersConfig | null): boolean {
  return config?.self.browserAccess ?? process.env.SOVA_BROWSER_ACCESS?.trim().toLowerCase() !== "off";
}

/** Whether this host's Browser access differs from the default, so peers must be told it. */
export const browserAccessSet = (config: PeersConfig | null): boolean =>
  config?.self.browserAccess !== undefined || process.env.SOVA_BROWSER_ACCESS?.trim().toLowerCase() === "off";

/** A new name's stamp: now, but always past the last one, so a clock that stepped back can't
    make a rename every peer ignores (they take only a newer stamp). */
export const nextLabelAt = (prev: number | undefined, now = Date.now()): number => Math.max(now, (prev ?? 0) + 1);

const isTime = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v > 0;

/** What an accepted pairing shows where a tailnet peer shows its name (it has no address here). */
export const DIAL_OUT_NAME = "dial-out";
const isPort = (v: unknown, zero = false): v is number => Number.isInteger(v) && (v as number) >= (zero ? 0 : 1) && (v as number) <= 65535;

function checkLan(raw: unknown): { link: LanLink } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "must be an object" };
  const r = raw as Record<string, unknown>;
  if (r.role !== "dial" && r.role !== "accept") return { error: 'role must be "dial" or "accept"' };
  const pin = parsePin(r.pin);
  if (!pin) return { error: "pin must be 32 hex digits" };
  if (r.role === "accept") {
    if (r.host !== undefined || r.port !== undefined) return { error: "an accepted pairing has no host or port" };
    return { link: { role: "accept", pin } };
  }
  const host = text(r.host, 253);
  if (!host) return { error: "host must be the relay's name or IP" };
  // An IP literal must be a relay address (never public, never every interface); a name is judged
  // by what it resolves to, at each dial (lan-tls.ts).
  const ip = relayAddress(host);
  if (parseIp(host) || isIP(host)) {
    if ("error" in ip) return { error: `host ${JSON.stringify(host)}: ${ip.error}` };
  } else if (!NAME_RE.test(host) || host.includes(":") || /^[0-9.]+$/.test(host)) return { error: "host must be the relay's name or IP" };
  if (!isPort(r.port)) return { error: "port must be 1–65535" };
  return { link: { role: "dial", pin, host: "address" in ip ? ip.address : host.replace(/\.$/, ""), port: r.port } };
}

/** The relay setting (§mesh.lan/pairing): a loopback, private or link-local IP, never every interface
    or a public address, and never "internet" until the separate accept process exists. */
function checkRelay(raw: unknown): { relay: RelaySetting } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "must be an object" };
  const r = raw as Record<string, unknown>;
  if (r.exposure === "internet") return { error: 'exposure "internet" is not available: an internet relay needs the separate accept process, which Sova doesn\'t have yet' };
  if (r.exposure !== undefined && r.exposure !== "lan") return { error: 'exposure must be "lan"' };
  if (typeof r.host !== "string") return { error: "host must be one IP address of this host" };
  const host = relayAddress(r.host);
  if ("error" in host) return { error: `host ${JSON.stringify(r.host)}: ${host.error}` };
  if (!isPort(r.port, true)) return { error: "port must be 0–65535" };
  return { relay: { host: host.address, port: r.port } };
}

/** A list of host ids (absent/null → undefined), or why it isn't one. */
function hostIds(v: unknown, name: string): string[] | { error: string } | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !PEER_ID_RE.test(x))) return { error: `${name} must be a list of host ids` };
  if (new Set(v).size !== v.length) return { error: `${name} lists a host twice` };
  return v as string[];
}

/** The file, parsed and validated. Missing → `missing: true`; anything else wrong → its reason. */
export function readPeers(file = peersFile()): PeersRead {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, error: "no peers.json", missing: true };
    return { ok: false, error: `${file}: ${(err as Error).message}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `${file}: not JSON (${(err as Error).message})` };
  }
  const v = validatePeers(json);
  return "error" in v ? { ok: false, error: `${file}: ${v.error}` } : { ok: true, config: v.config };
}

/** Write the file atomically at 0600 (tmp + rename). The caller has validated `config`. */
export function writePeers(config: PeersConfig, file = peersFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  const doc = {
    version: 1,
    self: config.self,
    peers: config.peers,
    sync: config.sync,
    frontDoor: config.frontDoor,
    ...(config.frontDoorOrder ? { frontDoorOrder: config.frontDoorOrder } : {}),
    ...(config.frontDoorExclude?.length ? { frontDoorExclude: config.frontDoorExclude } : {}),
    ...(config.loginKinds ? { loginKinds: config.loginKinds } : {}),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600); // an existing tmp keeps its old mode through writeFileSync
  renameSync(tmp, file);
}
