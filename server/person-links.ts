import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashToken, TOKEN_RE } from "./baton-links";
import { dropTokens, keepTokens } from "./link-tokens";
import { shareLinksChanged } from "./share/links-events";
import { stateRoot } from "./state-root";

/**
 * Person links (§app.owner-page/link): `/i/<token>`, one door per person. Today only the owner
 * scope: an org's owner reads the Owner page through it. The same shape and hashing as a hand-off
 * link (32 random bytes, base64url; this store keeps the SHA-256, compared in constant time), in
 * `<stateRoot>/person-links.json` (0600), NEVER in the workspace repo: a restored repo carries no
 * capability, and an attach elsewhere mints new links. The token itself is kept in link-tokens.json
 * (server/link-tokens.ts) until the link is turned off; this file's keys never change.
 *
 * One live owner link per org: minting turns the older one off at once. It turns itself off after
 * OWNER_IDLE_DAYS unused: `expiresAt` is that deadline, moved forward by each use (noteOwnerLinkUse,
 * at most once an hour, `lastUsedAt`); there is no absolute expiry. A link that turned off unused may
 * ask the operator for a new one, at most once a day (`askedAt`). Turned off also when the owner changes, leaves, or the
 * org is detached (server/owner.ts).
 *
 * The file also keeps the host's handle key: the Owner page names projects and conversations by
 * an HMAC of their id under it (`q_…`, `k_…`), so no id leaves the server and a handle means
 * nothing on another host.
 */

/** Days unused after which an owner link turns itself off (al_1 q13). */
export const OWNER_IDLE_DAYS = 7;
export const OWNER_IDLE_MS = OWNER_IDLE_DAYS * 86_400_000;
/** A use moves the deadline at most this often (one write an hour, not one per page read). */
export const OWNER_USE_WRITE_MS = 3_600_000;

export type PersonLinkWhy = "rotated" | "off" | "owner-changed" | "left" | "detached";

export interface PersonLinkRecord {
  /** SHA-256 of the token, hex. */
  hash: string;
  orgId: string;
  personId: string;
  scope: "owner";
  /** 1 for the org's first owner link on this host, then +1 per mint. */
  gen: number;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokedWhy?: PersonLinkWhy;
  /** The last use by a person (written at most once an hour; `expiresAt` is it + OWNER_IDLE_MS). */
  lastUsedAt?: string;
  /** When the owner, holding this link after it turned off unused, last asked for a new one. On a link
      the Overseer's send made (`undelivered`), the ask it carries until its message went. */
  askedAt?: string;
  /** Made by the Overseer's send (§app.owner-page/send) and not yet delivered: a failed or unknown send
      leaves it, so the owner's ask stays in Needs you. A delivered send clears it (markOwnerLinkDelivered). */
  undelivered?: true;
}

interface Store {
  key: string;
  links: PersonLinkRecord[];
}

const file = () => join(stateRoot(), "person-links.json");

function read(): Store {
  try {
    const raw = JSON.parse(readFileSync(file(), "utf8"));
    const links = Array.isArray(raw?.links) ? raw.links.filter((l: unknown) => l && typeof (l as PersonLinkRecord).hash === "string" && (l as PersonLinkRecord).scope === "owner") : [];
    return { key: typeof raw?.key === "string" && raw.key.length >= 32 ? raw.key : "", links };
  } catch {
    return { key: "", links: [] };
  }
}

function write(store: Store): void {
  mkdirSync(dirname(file()), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, ...store }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file());
}

// ---- handles -------------------------------------------------------------------------------------

let keyCache: { file: string; key: string } | null = null;

function handleKey(): string {
  if (keyCache?.file === file()) return keyCache.key;
  const store = read();
  if (!store.key) {
    store.key = randomBytes(32).toString("base64url");
    write(store);
  }
  keyCache = { file: file(), key: store.key };
  return store.key;
}

const HANDLE_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
/** A handle as it may appear in a URL. */
export const HANDLE_RE = /^[qkvr]_[a-z2-9]{8}$/;

/** The Owner page's name for a project (`q`), a conversation (`k`), a version (`v`, a running copy) or a
    request (`r`): stable on this host, meaningless elsewhere. */
export function handleOf(kind: "q" | "k" | "v" | "r", id: string): string {
  const mac = createHmac("sha256", handleKey()).update(`${kind}:${id}`).digest();
  let s = "";
  for (let i = 0; i < 8; i++) s += HANDLE_ALPHABET[mac[i]! % HANDLE_ALPHABET.length];
  return `${kind}_${s}`;
}

// ---- links ---------------------------------------------------------------------------------------

/** What else follows an owner link (its owner-bound versions, server/owner-versions.ts): told when links stop or a use moves a deadline. */
export type OwnerLinkEvent = { kind: "ended"; hashes: string[] } | { kind: "used"; hash: string; expiresAt: string };
const linkListeners = new Set<(e: OwnerLinkEvent) => void>();
export function onOwnerLinkEvent(cb: (e: OwnerLinkEvent) => void): () => void {
  linkListeners.add(cb);
  return () => linkListeners.delete(cb);
}
function tell(e: OwnerLinkEvent): void {
  for (const cb of linkListeners)
    try {
      cb(e);
    } catch (err) {
      console.warn(`[person-links] a listener failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

export const personLinkDead = (l: PersonLinkRecord, now = Date.now()): boolean => !!l.revokedAt || Date.parse(l.expiresAt) <= now;

export function personLinkState(l: PersonLinkRecord, now = Date.now()): "live" | "expired" | "off" {
  if (l.revokedAt) return "off";
  return Date.parse(l.expiresAt) <= now ? "expired" : "live";
}

/** Mint the org's owner link for `personId`; every older owner link of the org stops working now. Returns the token (kept, server/link-tokens.ts).
    `undelivered` (the Overseer's send, §app.owner-page/send): the new link carries the owner's pending ask
    (their newest link's `askedAt`, when it turned off unused) until its message went. */
export function mintOwnerLink(orgId: string, personId: string, now = Date.now(), opts: { undelivered?: boolean } = {}): { token: string; record: PersonLinkRecord } {
  const store = read();
  const at = new Date(now).toISOString();
  let gen = 0;
  const off: string[] = [];
  // The ask the owner's newest link carries now (before the rotation below turns it off).
  const newest = store.links.filter((l) => l.orgId === orgId && l.personId === personId).at(-1);
  const ask = opts.undelivered && newest?.askedAt && !newest.revokedAt ? newest.askedAt : undefined;
  for (const l of store.links)
    if (l.orgId === orgId) {
      gen = Math.max(gen, l.gen || 0);
      if (!l.revokedAt) {
        l.revokedAt = at;
        l.revokedWhy = "rotated";
        off.push(l.hash);
      }
    }
  const token = randomBytes(32).toString("base64url");
  const record: PersonLinkRecord = {
    hash: hashToken(token),
    orgId,
    personId,
    scope: "owner",
    gen: gen + 1,
    createdAt: at,
    expiresAt: new Date(now + OWNER_IDLE_MS).toISOString(),
    ...(opts.undelivered ? { undelivered: true as const } : {}),
    ...(ask ? { askedAt: ask } : {}),
  };
  store.links.push(record);
  if (!store.key) store.key = handleKey();
  write(store);
  dropTokens(off);
  keepTokens("i", [token]);
  shareLinksChanged({ kind: "i", cause: "mint" });
  if (off.length) tell({ kind: "ended", hashes: off });
  return { token, record };
}

/** The record a presented token names, in constant time per stored hash; null when none. */
export function findPersonLink(token: string): PersonLinkRecord | null {
  if (!TOKEN_RE.test(token)) return null;
  const want = Buffer.from(hashToken(token), "hex");
  let hit: PersonLinkRecord | null = null;
  for (const l of read().links) {
    const have = Buffer.from(l.hash, "hex");
    if (have.length === want.length && timingSafeEqual(have, want)) hit = l;
  }
  return hit;
}

/** A use of a live link (a person's read, message or Open): its deadline moves to OWNER_IDLE_MS from
    now, written at most once an hour. A dead link's use changes nothing. */
export function noteOwnerLinkUse(hash: string, now = Date.now()): void {
  const store = read();
  const l = store.links.find((x) => x.hash === hash);
  if (!l || personLinkDead(l, now)) return;
  const want = now + OWNER_IDLE_MS;
  if (want - Date.parse(l.expiresAt) < OWNER_USE_WRITE_MS) return;
  l.expiresAt = new Date(want).toISOString();
  l.lastUsedAt = new Date(now).toISOString();
  write(store);
  tell({ kind: "used", hash, expiresAt: l.expiresAt });
}

/** Asking again inside this window answers the same and records nothing. */
export const ASK_AGAIN_MS = 86_400_000;

/** The owner asked for a new link through `hash` (a link that turned off unused): at most once a day. Returns the ask's time. */
export function recordAsk(hash: string, now = Date.now()): string | null {
  const store = read();
  const l = store.links.find((x) => x.hash === hash);
  if (!l) return null;
  if (l.askedAt && now - Date.parse(l.askedAt) < ASK_AGAIN_MS) return l.askedAt;
  l.askedAt = new Date(now).toISOString();
  write(store);
  return l.askedAt;
}

/** The Overseer's send of this link went (§app.owner-page/send): it answers the owner's ask. Changes nothing
    else, so a link of anyone else (a new owner's) is never touched. */
export function markOwnerLinkDelivered(hash: string): void {
  const store = read();
  const l = store.links.find((x) => x.hash === hash);
  if (!l?.undelivered) return;
  delete l.undelivered;
  delete l.askedAt;
  write(store);
}

/** Turn off every live owner link matching; returns how many. */
export function revokePersonLinks(match: (l: PersonLinkRecord) => boolean, why: PersonLinkWhy, now = Date.now()): number {
  const store = read();
  const off: string[] = [];
  for (const l of store.links)
    if (!l.revokedAt && match(l)) {
      l.revokedAt = new Date(now).toISOString();
      l.revokedWhy = why;
      off.push(l.hash);
    }
  const n = off.length;
  if (n) {
    write(store);
    dropTokens(off);
    shareLinksChanged({ kind: "i", cause: "revoke" });
    tell({ kind: "ended", hashes: off });
  }
  return n;
}

/** Every owner link of an org on this host, in minting order. */
export const ownerLinksOf = (orgId: string): PersonLinkRecord[] => read().links.filter((l) => l.orgId === orgId);

/** Forget the cached handle key (tests: a fresh state root). */
export function resetPersonLinkCache(): void {
  keyCache = null;
}
