import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { SyncCategory } from "../../shared/protocol";
import { stateRoot } from "../state-root";

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
}

export const SYNC_CATEGORIES: readonly SyncCategory[] = ["settings", "themes", "extensions", "logins"];

export interface PeersConfig {
  /** `labelAt`: when this host last renamed itself (ms epoch); absent: never, since recorded. */
  self: { id: string; label: string; serveUrl?: string; labelAt?: number };
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
  const selfServe = selfRaw.serveUrl === undefined || selfRaw.serveUrl === null ? null : checkUrl(selfRaw.serveUrl);
  if (selfServe && "error" in selfServe) return { error: `self.serveUrl ${selfServe.error}` };
  if (r.peers !== undefined && !Array.isArray(r.peers)) return { error: "peers must be an array" };
  const peers: PeerEntry[] = [];
  const ids = new Set([selfId]);
  const nodes = new Set<string>();
  for (const [i, p] of ((r.peers as unknown[] | undefined) ?? []).entries()) {
    if (typeof p !== "object" || p === null || Array.isArray(p)) return { error: `peers[${i}] is not an object` };
    const e = p as Record<string, unknown>;
    if (typeof e.id !== "string" || !PEER_ID_RE.test(e.id)) return { error: `peers[${i}].id must match ${PEER_ID_RE}` };
    if (ids.has(e.id)) return { error: `peers[${i}].id ${e.id} is not unique (or is the self id)` };
    const nodeId = text(e.nodeId, 128);
    if (!nodeId) return { error: `peers[${i}].nodeId is required` };
    if (nodes.has(nodeId)) return { error: `peers[${i}].nodeId is listed twice` };
    const dnsName = text(e.dnsName, 253);
    if (!dnsName || !NAME_RE.test(dnsName)) return { error: `peers[${i}].dnsName must be a tailnet name or IP` };
    if (e.label !== undefined && !text(e.label)) return { error: `peers[${i}].label must be a non-empty string (≤ 80)` };
    const url = e.url === undefined ? null : checkUrl(e.url);
    if (url && "error" in url) return { error: `peers[${i}].url ${url.error}` };
    if (e.priority !== undefined && !Number.isFinite(e.priority)) return { error: `peers[${i}].priority must be a number` };
    const serve = e.serveUrl === undefined || e.serveUrl === null ? null : checkUrl(e.serveUrl);
    if (serve && "error" in serve) return { error: `peers[${i}].serveUrl ${serve.error}` };
    for (const k of ["pairedAt", "labelAt"] as const) {
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

/** A new name's stamp: now, but always past the last one, so a clock that stepped back can't
    make a rename every peer ignores (they take only a newer stamp). */
export const nextLabelAt = (prev: number | undefined, now = Date.now()): number => Math.max(now, (prev ?? 0) + 1);

const isTime = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v > 0;

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
