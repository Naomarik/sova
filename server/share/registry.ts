import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type RegistryAck, REGISTRY_LIMITS, REGISTRY_LINK_KINDS, type RegistryLink, type RegistryLinkKind, type RoutedHost, type ShareGatewaySetting } from "../../shared/public-links";
import type { PeerEntry } from "../mesh/peers";
import { parsePublicUrl, previewPin, publicLinksFile, readPublicLinks, sharePin } from "../public-links";
import { stateRoot } from "../state-root";
import { type SnapshotCheck, type SnapshotContext, validateSnapshot } from "./registry-validation";

/**
 * A gateway's registry (§mesh.public/registry, store side): which routed host registered which
 * token hash, kept in `<stateRoot>/share-gateway.json` (0600, atomic). Each accepted snapshot
 * replaces the caller's rows in one synchronous step (validate, split collisions, write, swap), so
 * a reader never sees half of one. Rows are keyed by the caller's StableID, never a peer id (a
 * peer can be renamed here). Rows of a peer no longer in peers.json, or no longer accepted, never
 * route and are dropped at the next commit; rows past their `exp` never route.
 *
 * This file imports nothing from the mesh (server/mesh/hello.ts imports it): whoever asks passes
 * which peers are live.
 */

// ---- the gateway setting ------------------------------------------------------------------------

let settingCache: { stamp: string; gateway: ShareGatewaySetting | null } | null = null;

function stampOf(file: string): string {
  try {
    const st = statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return "missing";
  }
}

/** An https origin exactly as the URL parser writes it: Core's parsePublicUrl rule
    (server/public-links.ts, the one validator), with no trailing slash or surrounding space
    either, for an address that comes from elsewhere (a peer's hello). */
export function isPublicUrl(v: unknown): v is string {
  try {
    return parsePublicUrl(v) === v;
  } catch {
    return false;
  }
}

/** This host's gateway block, only when the setting's route is "self"; null otherwise. The file
    is read by the setting's own strict reader (readPublicLinks: anything malformed reads as off,
    with a warning), re-read only when the file changes (one stat). */
export function gatewaySetting(): ShareGatewaySetting | null {
  const stamp = stampOf(publicLinksFile());
  if (settingCache?.stamp === stamp) return settingCache.gateway;
  const file = readPublicLinks();
  const gateway = file.route === "self" && file.gateway ? file.gateway : null;
  settingCache = { stamp, gateway };
  return gateway;
}

/** The public URL this gateway answers on, or null when this host is no gateway. The
    SOVA_SHARE_PUBLIC_URL pin wins over the setting's, by the setting's own rule (sharePin: a pin
    that isn't a bare origin is ignored, with a warning, and the setting decides), but never
    makes a host a gateway by itself. What hello advertises and the ack carries. */
export function gatewayPublicUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const g = gatewaySetting();
  if (!g) return null;
  return sharePin(env) ?? g.publicUrl;
}

/** The preview address this gateway serves (§mesh.public/preview-address): the
    SOVA_SHARE_PREVIEW_URL pin, else the setting's; null when this host is no gateway or has none.
    What the edge splits by Host and GatewayInfo.previewUrl carries. */
export function gatewayPreviewUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const g = gatewaySetting();
  if (!g) return null;
  return previewPin(env) ?? g.previewUrl ?? null;
}

/** Whether the gateway accepts links from this node. */
export function acceptsNode(g: ShareGatewaySetting, nodeId: string): boolean {
  return g.acceptFrom === "all" || g.acceptFrom.includes(nodeId);
}

// ---- the gateway's own links ----------------------------------------------------------------------

function hashesIn(name: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(stateRoot(), name), "utf8")) as { links?: { hash?: unknown }[] };
    return Array.isArray(raw.links) ? raw.links.map((l) => l?.hash).filter((h): h is string => typeof h === "string") : [];
  } catch {
    return [];
  }
}

/** Every token hash this host minted (hand-off, owner and session links, live or not): the first
    claimant of each, whatever a peer registers. Read from the link stores' files. */
export function localShareHashes(): Set<string> {
  return new Set(
    [...hashesIn("baton-links.json"), ...hashesIn("person-links.json"), ...hashesIn("session-shares.json"), ...hashesIn("preview-links.json")].map((h) => h.toLowerCase()),
  );
}

// ---- the store ----------------------------------------------------------------------------------

/** One routed host's stored snapshot: the accepted rows only, and the hashes it lost. */
export interface HostRows {
  nodeId: string;
  seq: number;
  links: RegistryLink[];
  assets: string[];
  ingressPort: number;
  collisions: string[];
  /** When it was stored, ms epoch. */
  at: number;
}

/** share-gateway.json. `hosts` is an array in first-registration order: the first host to list
    an asset is its source. */
interface StoreFile {
  version: 1;
  hosts: HostRows[];
}

/** Where a routed hash or asset goes: the host's StableID and its ingress port. */
export interface RegistryHit {
  nodeId: string;
  ingressPort: number;
}

export interface CommitContext extends SnapshotContext {
  /** The gateway's own token hashes (localShareHashes). */
  local: ReadonlySet<string>;
  /** Whether a stored host may still route: listed in peers.json and accepted. */
  live: (nodeId: string) => boolean;
}

export interface RegistryOptions {
  file?: () => string;
  /** The snapshot check. Default: validateSnapshot (server/share/registry-validation.ts). */
  validate?: (body: unknown, ctx: SnapshotContext) => SnapshotCheck;
}

export class GatewayRegistry {
  private readonly file: () => string;
  private readonly validate: (body: unknown, ctx: SnapshotContext) => SnapshotCheck;
  private loaded: { path: string; stamp: string; hosts: HostRows[]; broken?: string } | null = null;
  private byHash = new Map<string, { host: HostRows; kind: RegistryLinkKind; exp: number }>();
  private changed: (() => void)[] = [];
  /** `p` hashes a live host withdrew from its snapshot (turned off there), until their old expiry:
      answered 410 rather than 404 (§mesh.public/preview-offline). Memory only. */
  private withdrawnPreviews = new Map<string, number>();

  constructor(opts: RegistryOptions = {}) {
    this.file = opts.file ?? (() => join(stateRoot(), "share-gateway.json"));
    this.validate = opts.validate ?? validateSnapshot;
  }

  /**
   * The stored hosts, re-read when the file changes (one stat; PI_CODING_AGENT_DIR moves in
   * tests). A missing file is an empty registry. A file that can't be read, isn't JSON or breaks
   * any stored-state rule (validateStore) fails closed: nothing routes, no commit overwrites it,
   * and a warning names the rule, until the operator fixes or removes it.
   */
  private hosts(): HostRows[] {
    const path = this.file();
    const stamp = stampOf(path);
    if (this.loaded?.path === path && this.loaded.stamp === stamp) return this.loaded.hosts;
    let hosts: HostRows[] = [];
    let broken: string | undefined;
    if (stamp !== "missing") {
      try {
        const checked = validateStore(JSON.parse(readFileSync(path, "utf8")));
        if ("hosts" in checked) hosts = checked.hosts;
        else broken = checked.why;
      } catch (err) {
        broken = err instanceof SyntaxError ? "not JSON" : `unreadable (${err instanceof Error ? err.name : typeof err})`;
      }
    }
    if (broken) console.warn(`[share] share-gateway.json is invalid (${broken}): no registered link routes until it is fixed or removed`);
    this.swap(path, stamp, hosts, broken);
    return hosts;
  }

  private swap(path: string, stamp: string, hosts: HostRows[], broken?: string): void {
    const byHash = new Map<string, { host: HostRows; kind: RegistryLinkKind; exp: number }>();
    for (const host of hosts) for (const l of host.links) if (!byHash.has(l.h)) byHash.set(l.h, { host, kind: l.kind, exp: l.exp });
    this.loaded = { path, stamp, hosts, ...(broken ? { broken } : {}) };
    this.byHash = byHash;
  }

  /** Why the stored registry is refused, or null when it is usable. */
  broken(): string | null {
    this.hosts();
    return this.loaded?.broken ?? null;
  }

  /** The seq stored for a node, or null. */
  seqOf(nodeId: string): number | null {
    return this.hosts().find((h) => h.nodeId === nodeId)?.seq ?? null;
  }

  /**
   * One snapshot from `nodeId` (the verified caller), all or nothing. A stale or equal seq changes
   * nothing and reports what is stored. Otherwise every row is split into accepted and colliding
   * ones (a hash the gateway minted, or one another live host holds, is a collision; a collision
   * never moves a hash), and the caller's rows are replaced by the accepted ones in one write.
   * Removed or unaccepted hosts and expired rows are dropped in the same write. A failed write
   * throws and leaves the store as it was.
   */
  commit(nodeId: string, body: unknown, publicUrl: string, ctx: CommitContext): RegistryAck {
    const hosts = this.hosts();
    if (this.loaded?.broken) throw new RegistryUnavailable(this.loaded.broken);
    // The caller's own acceptance, judged now (it may have been withdrawn while its body arrived).
    if (!ctx.live(nodeId)) return { ok: false, error: "not-accepted" };
    const check = this.validate(body, { now: ctx.now });
    if (!check.ok) return { ok: false, error: "bad-snapshot" };
    const snap = check.snapshot;
    const prev = hosts.find((h) => h.nodeId === nodeId);
    if (prev && snap.seq <= prev.seq) return ack(prev, publicUrl);

    const others = hosts
      .filter((h) => h.nodeId !== nodeId && ctx.live(h.nodeId))
      .map((h) => ({ ...h, links: h.links.filter((l) => l.exp > ctx.now) }));
    const taken = new Set<string>();
    for (const h of others) for (const l of h.links) taken.add(l.h);
    const accepted: RegistryLink[] = [];
    const collisions: string[] = [];
    for (const l of snap.links) {
      if (ctx.local.has(l.h) || taken.has(l.h)) collisions.push(l.h);
      else accepted.push({ h: l.h, exp: l.exp, kind: l.kind });
    }
    const mine: HostRows = { nodeId, seq: snap.seq, links: accepted, assets: [...snap.assets], ingressPort: snap.ingressPort, collisions, at: ctx.now };
    // The caller keeps its place in the order; a new host goes last.
    const next = hosts.flatMap((h) => (h === prev ? [mine] : others.filter((o) => o.nodeId === h.nodeId)));
    if (!prev) next.push(mine);
    const kept = new Set(accepted.map((l) => l.h));
    for (const l of prev?.links ?? []) if (l.kind === "p" && l.exp > ctx.now && !kept.has(l.h)) this.withdrawnPreviews.set(l.h, l.exp);
    for (const h of kept) this.withdrawnPreviews.delete(h);
    for (const [h, exp] of this.withdrawnPreviews) if (exp <= ctx.now) this.withdrawnPreviews.delete(h);
    const path = this.file();
    writeStore(path, { version: 1, hosts: next });
    this.swap(path, stampOf(path), next);
    for (const fn of this.changed) {
      try {
        fn();
      } catch (err) {
        console.warn(`[share] registry listener failed (${err instanceof Error ? err.name : typeof err})`);
      }
    }
    return ack(mine, publicUrl);
  }

  /** Run `fn` after every commit that stored something. Returns the unsubscribe. */
  onChange(fn: () => void): () => void {
    this.changed.push(fn);
    return () => {
      this.changed = this.changed.filter((f) => f !== fn);
    };
  }

  /** Every stored host, in first-registration order (a copy). */
  stored(): readonly HostRows[] {
    return [...this.hosts()];
  }

  /** Where a hash goes for a route of `kind`, or null: unknown, expired, of another kind, or its
      host no longer live. */
  lookup(h: string, kind: "h" | "i" | "s" | "p", now: number, live: (nodeId: string) => boolean): RegistryHit | null {
    this.hosts();
    const row = this.byHash.get(h);
    if (!row || row.kind !== kind || row.exp <= now || !live(row.host.nodeId)) return null;
    return { nodeId: row.host.nodeId, ingressPort: row.host.ingressPort };
  }

  /** Whether a live host withdrew this preview hash from its snapshot before its expiry. */
  previewWithdrawn(h: string, now: number): boolean {
    const exp = this.withdrawnPreviews.get(h);
    return exp !== undefined && exp > now;
  }

  /** Every live host that listed an asset name, in first-registration order. */
  assetSources(name: string, live: (nodeId: string) => boolean): RegistryHit[] {
    return this.hosts()
      .filter((h) => h.assets.includes(name) && live(h.nodeId))
      .map((h) => ({ nodeId: h.nodeId, ingressPort: h.ingressPort }));
  }

  /** Tests: forget what was read, so the next call reads the file again. */
  reset(): void {
    this.loaded = null;
    this.byHash = new Map();
  }
}

function ack(host: HostRows, publicUrl: string): RegistryAck {
  return { ok: true, seq: host.seq, publicUrl, ...(host.collisions.length ? { collisions: [...host.collisions] } : {}) };
}

/** A commit refused because the stored registry is invalid (validateStore); the route answers 503. */
export class RegistryUnavailable extends Error {
  constructor(why: string) {
    super(`share-gateway.json is invalid (${why})`);
    this.name = "RegistryUnavailable";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));
const isPort = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535;
const isSeq = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isTime = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const isHash = (v: unknown): v is string => typeof v === "string" && REGISTRY_LIMITS.hash.test(v);
const isAsset = (v: unknown): v is string => typeof v === "string" && REGISTRY_LIMITS.asset.test(v) && !v.includes("..");

/**
 * share-gateway.json as this file writes it, checked whole on every read: exact keys, the
 * snapshot bounds (hash shape, kinds, ports, seq, link and asset counts, asset names), `exp` no
 * further past its commit than a snapshot may reach, no node twice, no hash held twice, no asset
 * twice per host. One failure rejects the whole file; expired rows are valid (they never route).
 */
export function validateStore(raw: unknown): { hosts: HostRows[] } | { why: string } {
  if (!isObj(raw) || !onlyKeys(raw, ["version", "hosts"]) || raw.version !== 1 || !Array.isArray(raw.hosts)) return { why: "document shape" };
  const nodes = new Set<string>();
  const held = new Set<string>();
  for (const [i, h] of (raw.hosts as unknown[]).entries()) {
    const bad = (what: string) => ({ why: `host ${i}: ${what}` });
    if (!isObj(h) || !onlyKeys(h, ["nodeId", "seq", "links", "assets", "ingressPort", "collisions", "at"])) return bad("keys");
    if (typeof h.nodeId !== "string" || !h.nodeId || nodes.has(h.nodeId)) return bad("nodeId");
    nodes.add(h.nodeId);
    if (!isSeq(h.seq)) return bad("seq");
    if (!isPort(h.ingressPort)) return bad("ingressPort");
    if (!isTime(h.at)) return bad("at");
    if (!Array.isArray(h.links) || h.links.length > REGISTRY_LIMITS.maxLinks) return bad("links");
    for (const l of h.links as unknown[]) {
      if (!isObj(l) || !onlyKeys(l, ["h", "exp", "kind"]) || !isHash(l.h) || held.has(l.h)) return bad("link hash");
      held.add(l.h);
      if (!isTime(l.exp) || l.exp > (h.at as number) + REGISTRY_LIMITS.maxExpiryAheadMs) return bad("link exp");
      if (!REGISTRY_LINK_KINDS.includes(l.kind as RegistryLinkKind)) return bad("link kind");
    }
    if (!Array.isArray(h.assets) || h.assets.length > REGISTRY_LIMITS.maxAssets || !h.assets.every(isAsset) || new Set(h.assets).size !== h.assets.length) return bad("assets");
    if (!Array.isArray(h.collisions) || h.collisions.length > REGISTRY_LIMITS.maxLinks || !h.collisions.every(isHash)) return bad("collisions");
  }
  return { hosts: raw.hosts as HostRows[] };
}

function writeStore(file: string, doc: StoreFile): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600); // an existing tmp keeps its old mode through writeFileSync
  renameSync(tmp, file);
}

/** The gateway's one registry. */
export const shareRegistry = new GatewayRegistry();

// ---- the routed hosts, for Settings → Public links ------------------------------------------------

export interface RoutedHostsSources {
  setting?: () => ShareGatewaySetting | null;
  registry?: GatewayRegistry;
  /** peers.json's peers now. Default: the mesh's. */
  peers?: () => PeerEntry[];
  /** Whether a peer's hello answers now. Default: the mesh's cached hello probe (up or skewed). */
  up?: (peer: PeerEntry) => Promise<boolean>;
  now?: () => number;
}

/**
 * GET /api/public-links' `routed` (§mesh.public/gateway): on a gateway, every host that registered
 * links here or that `acceptFrom` lists, in that order; null on a host that is no gateway. The mesh
 * is loaded at call time (server/mesh/hello.ts imports this file). Never throws for one peer's
 * probe.
 */
export async function routedHosts(src: RoutedHostsSources = {}): Promise<RoutedHost[] | null> {
  const g = (src.setting ?? gatewaySetting)();
  if (!g) return null;
  const registry = src.registry ?? shareRegistry;
  const now = (src.now ?? Date.now)();
  const peers = src.peers ?? (await import("../mesh")).meshApi.peers;
  let up = src.up;
  if (!up) {
    const { probePeer } = await import("../mesh/hello");
    up = async (p) => {
      const r = await probePeer(p);
      return r.state === "up" || r.state === "skewed";
    };
  }
  const answers = up;
  const byNode = new Map(peers().map((p) => [p.nodeId, p]));
  const stored = registry.stored();
  const nodes = [...stored.map((h) => h.nodeId), ...(g.acceptFrom === "all" ? [] : g.acceptFrom)].filter((n, i, all) => all.indexOf(n) === i);
  return Promise.all(
    nodes.map(async (nodeId): Promise<RoutedHost> => {
      const peer = byNode.get(nodeId) ?? null;
      const host = stored.find((h) => h.nodeId === nodeId);
      return {
        nodeId,
        peer: peer?.id ?? null,
        links: host ? host.links.filter((l) => l.exp > now && l.kind !== "x").length : 0,
        up: peer ? await answers(peer).catch(() => false) : false,
        lastPushAt: host?.at ?? null,
        accepted: acceptsNode(g, nodeId),
      };
    }),
  );
}
