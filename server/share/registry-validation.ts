import { REGISTRY_LIMITS, REGISTRY_LINK_KINDS, type RegistryLink, type RegistryLinkKind, type RegistrySnapshot } from "../../shared/public-links";

/**
 * The registry snapshot check (§mesh.public/registry): pure, all or nothing, against
 * REGISTRY_LIMITS and the RegistrySnapshot rules in shared/public-links.ts. The byte cap is the
 * route's, before parsing; collisions, peer removal and replay are the registry transaction's.
 */

export interface SnapshotContext {
  /** ms epoch the expiry bounds are judged against. */
  now: number;
}

export type SnapshotCheck = { ok: true; snapshot: RegistrySnapshot } | { ok: false; error: "bad-snapshot"; why: string };

const SNAPSHOT_KEYS = ["assets", "ingressPort", "links", "seq", "v"];
const LINK_KEYS = ["exp", "h", "kind"];
const KINDS: readonly RegistryLinkKind[] = REGISTRY_LINK_KINDS;

function plainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Exactly these own keys, no more and no fewer. */
function exactKeys(v: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(v).sort();
  return own.length === keys.length && own.every((k, i) => k === keys[i]);
}

/** The snapshot, rebuilt from checked fields only (so nothing unchecked rides along), or why not. */
export function validateSnapshot(body: unknown, ctx: SnapshotContext): SnapshotCheck {
  const bad = (why: string): SnapshotCheck => ({ ok: false, error: "bad-snapshot", why });
  if (!plainObject(body)) return bad("not an object");
  if (!exactKeys(body, SNAPSHOT_KEYS)) return bad("keys");
  const { v, seq, links, assets, ingressPort } = body;
  if (v !== 1) return bad("v");
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return bad("seq");
  if (typeof ingressPort !== "number" || !Number.isInteger(ingressPort) || ingressPort < 1 || ingressPort > 65535) return bad("ingressPort");
  if (!Array.isArray(links)) return bad("links");
  if (links.length > REGISTRY_LIMITS.maxLinks) return bad("too many links");
  if (!Array.isArray(assets)) return bad("assets");
  if (assets.length > REGISTRY_LIMITS.maxAssets) return bad("too many assets");
  if (!Number.isFinite(ctx.now)) return bad("no clock");
  const latest = ctx.now + REGISTRY_LIMITS.maxExpiryAheadMs;
  const hashes = new Set<string>();
  const outLinks: RegistryLink[] = [];
  for (const link of links as unknown[]) {
    if (!plainObject(link) || !exactKeys(link, LINK_KEYS)) return bad("link keys");
    const { h, exp, kind } = link;
    if (typeof h !== "string" || !REGISTRY_LIMITS.hash.test(h)) return bad("link hash");
    if (hashes.has(h)) return bad("duplicate hash");
    hashes.add(h);
    if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= ctx.now || exp > latest) return bad("link expiry");
    if (typeof kind !== "string" || !KINDS.includes(kind as RegistryLinkKind)) return bad("link kind");
    outLinks.push({ h, exp, kind: kind as RegistryLinkKind });
  }
  const names = new Set<string>();
  for (const name of assets as unknown[]) {
    if (typeof name !== "string" || !REGISTRY_LIMITS.asset.test(name) || name.includes("..")) return bad("asset name");
    if (names.has(name)) return bad("duplicate asset");
    names.add(name);
  }
  return { ok: true, snapshot: { v: 1, seq, links: outLinks, assets: [...names], ingressPort } };
}
