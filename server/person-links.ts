import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OWNER_LINK_DAYS } from "../shared/owner";
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
 * One live owner link per org: minting turns the older one off at once. It lasts
 * OWNER_LINK_DAYS from minting, with no renewal. Turned off also when the owner changes, leaves,
 * or the org is detached (server/owner.ts).
 *
 * The file also keeps the host's handle key: the Owner page names projects and conversations by
 * an HMAC of their id under it (`q_…`, `k_…`), so no id leaves the server and a handle means
 * nothing on another host.
 */

export const OWNER_LINK_TTL_MS = OWNER_LINK_DAYS * 86_400_000;

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
export const HANDLE_RE = /^[qk]_[a-z2-9]{8}$/;

/** The Owner page's name for a project (`q`) or a conversation (`k`): stable on this host, meaningless elsewhere. */
export function handleOf(kind: "q" | "k", id: string): string {
  const mac = createHmac("sha256", handleKey()).update(`${kind}:${id}`).digest();
  let s = "";
  for (let i = 0; i < 8; i++) s += HANDLE_ALPHABET[mac[i]! % HANDLE_ALPHABET.length];
  return `${kind}_${s}`;
}

// ---- links ---------------------------------------------------------------------------------------

export const personLinkDead = (l: PersonLinkRecord, now = Date.now()): boolean => !!l.revokedAt || Date.parse(l.expiresAt) <= now;

export function personLinkState(l: PersonLinkRecord, now = Date.now()): "live" | "expired" | "off" {
  if (l.revokedAt) return "off";
  return Date.parse(l.expiresAt) <= now ? "expired" : "live";
}

/** Mint the org's owner link for `personId`; every older owner link of the org stops working now. Returns the token (kept, server/link-tokens.ts). */
export function mintOwnerLink(orgId: string, personId: string, now = Date.now()): { token: string; record: PersonLinkRecord } {
  const store = read();
  const at = new Date(now).toISOString();
  let gen = 0;
  const off: string[] = [];
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
  const record: PersonLinkRecord = { hash: hashToken(token), orgId, personId, scope: "owner", gen: gen + 1, createdAt: at, expiresAt: new Date(now + OWNER_LINK_TTL_MS).toISOString() };
  store.links.push(record);
  if (!store.key) store.key = handleKey();
  write(store);
  dropTokens(off);
  keepTokens("i", [token]);
  shareLinksChanged({ kind: "i", cause: "mint" });
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
  }
  return n;
}

/** Every owner link of an org on this host, in minting order. */
export const ownerLinksOf = (orgId: string): PersonLinkRecord[] => read().links.filter((l) => l.orgId === orgId);

/** Forget the cached handle key (tests: a fresh state root). */
export function resetPersonLinkCache(): void {
  keyCache = null;
}
