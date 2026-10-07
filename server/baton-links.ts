import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dropTokens, keepTokens } from "./link-tokens";
import { nudgeMarks } from "./session-feed";
import { shareLinksChanged } from "./share/links-events";
import { stateRoot } from "./state-root";

/**
 * Hand-off links (§app.baton/links). A link is `/h/<token>`: 32 random bytes, base64url. This store
 * keeps the token's SHA-256, bound to (org, session, hand-off, person), in
 * `<stateRoot>/baton-links.json` (0600) — NEVER in the org's workspace repo, so a restored repo
 * carries no capability and a new host mints new links. The token itself is kept host-local in
 * link-tokens.json (server/link-tokens.ts) from its mint until it is turned off, so the operator can
 * copy it again; this file's keys never change. Lookup hashes the presented token and
 * compares in constant time against every stored hash (the list is small).
 */

export const LINK_TTL_MS = 14 * 86_400_000;

export interface LinkRecord {
  /** SHA-256 of the token, hex. */
  hash: string;
  orgId: string;
  sessionId: string;
  /** The hand-off this link belongs to. */
  n: number;
  personId: string;
  /** Set on an offer's links: one per invitee, all of hand-off `n`. */
  offerId?: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  /** Set when it was turned off because its offer went to someone else (the page may say so). */
  revokedWhy?: "withdrawn";
  /** The baton statechart's effect that minted it (its key): a re-run of that effect mints nothing twice. */
  key?: string;
}

const file = () => join(stateRoot(), "baton-links.json");

export const hashToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

/** A token as it may appear in a URL: base64url of 32 bytes. Anything else is never looked up. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** The first 6 characters, for logs. */
export const tokenTag = (token: string): string => `${token.slice(0, 6)}…`;

function read(): LinkRecord[] {
  try {
    const raw = JSON.parse(readFileSync(file(), "utf8"));
    return Array.isArray(raw?.links) ? raw.links.filter((l: unknown) => l && typeof (l as LinkRecord).hash === "string") : [];
  } catch {
    return [];
  }
}

function write(links: LinkRecord[]): void {
  mkdirSync(dirname(file()), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, links }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file());
  // A link's life is part of Needs you ("Send <name> their link"): re-diff the session list now.
  nudgeMarks();
}

/** Mint a link for hand-off `n` of a session to `personId`. Returns the token (kept, server/link-tokens.ts). */
export function mintLink(input: { orgId: string; sessionId: string; n: number; personId: string; offerId?: string; key?: string }, now = Date.now()): string {
  const token = randomBytes(32).toString("base64url");
  const rec: LinkRecord = {
    hash: hashToken(token),
    ...input,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + LINK_TTL_MS).toISOString(),
  };
  write([...read(), rec]);
  keepTokens("h", [token]);
  shareLinksChanged({ kind: "h", cause: "mint" });
  return token;
}

/** The record a presented token names, in constant time per stored hash; null when none. The
    caller decides what revoked or expired means for the route (410). */
export function findLink(token: string): LinkRecord | null {
  if (!TOKEN_RE.test(token)) return null;
  const want = Buffer.from(hashToken(token), "hex");
  let hit: LinkRecord | null = null;
  for (const l of read()) {
    const have = Buffer.from(l.hash, "hex");
    if (have.length === want.length && timingSafeEqual(have, want)) hit = l;
  }
  return hit;
}

export const linkDead = (l: LinkRecord, now = Date.now()): boolean => !!l.revokedAt || Date.parse(l.expiresAt) <= now;

/** Why a dead link is dead, when the page may say it; undefined for a live link and for every
    other reason (turned off, its person left). */
export function deadWhy(l: LinkRecord, now = Date.now()): "expired" | "withdrawn" | undefined {
  if (l.revokedAt) return l.revokedWhy === "withdrawn" ? "withdrawn" : undefined;
  return Date.parse(l.expiresAt) <= now ? "expired" : undefined;
}

/** Revoke every live link matching `match`. Returns how many were revoked. */
export function revokeLinks(match: (l: LinkRecord) => boolean, now = Date.now(), why?: "withdrawn"): number {
  const links = read();
  const off: string[] = [];
  for (const l of links)
    if (!l.revokedAt && match(l)) {
      l.revokedAt = new Date(now).toISOString();
      if (why) l.revokedWhy = why;
      off.push(l.hash);
    }
  const n = off.length;
  if (n) {
    write(links);
    dropTokens(off);
    shareLinksChanged({ kind: "h", cause: "revoke" });
  }
  return n;
}

/** Live (unrevoked, unexpired) links of a session's hand-off `n`. */
export function liveLinks(sessionId: string, n: number, now = Date.now()): LinkRecord[] {
  return read().filter((l) => l.sessionId === sessionId && l.n === n && !linkDead(l, now));
}

/** The links an effect (by its key) minted. */
export function linksOfKey(key: string): LinkRecord[] {
  return read().filter((l) => l.key === key);
}

/** Every link of an org on this host (live or not), in minting order. */
export function linksOfOrg(orgId: string): LinkRecord[] {
  return read().filter((l) => l.orgId === orgId);
}

/** Every link of a person in an org on this host (live or not), in minting order. */
export function linksOfPerson(orgId: string, personId: string): LinkRecord[] {
  return linksOfOrg(orgId).filter((l) => l.personId === personId);
}

/** Turn off every live link of a person in an org, or only those of one hand-off (`only`). Returns
    the sessions whose links changed. */
export function revokePersonLinks(orgId: string, personId: string, only?: { sessionId: string; n: number }, now = Date.now()): string[] {
  const sessions = new Set<string>();
  revokeLinks((l) => {
    if (l.orgId !== orgId || l.personId !== personId || linkDead(l, now)) return false;
    if (only && (l.sessionId !== only.sessionId || l.n !== only.n)) return false;
    sessions.add(l.sessionId);
    return true;
  }, now);
  return [...sessions];
}
