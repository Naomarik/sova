import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ANYONE_LABEL,
  RECIPIENT_LABEL_MAX,
  RECIPIENTS_MAX,
  SESSION_SHARE_DAYS,
  SHARE_TITLE_MAX,
  type SessionShareDays,
  type SessionShareLinkState,
  type SessionShareMode,
} from "../shared/session-share";
import { hashToken, TOKEN_RE } from "./baton-links";
import { shareLinksChanged } from "./share/links-events";
import { stateRoot } from "./state-root";

/**
 * Session shares (§app.session-share/link): `<stateRoot>/session-shares.json` (0600, atomic),
 * host-local, never synced or committed. A share names a session file and a cut (snapshot) or
 * none (Follow live); each recipient has its own `/s/<token>` link, built like a hand-off link (32
 * random bytes, base64url; only the SHA-256 is kept, compared in constant time). The link rows keep
 * the baton store's shape (`hash`, `expiresAt`, `revokedAt`), so the registry push reads them as
 * kind `s` rows unchanged.
 *
 * The file is parsed strictly: one that fails serves no link, and no mutation overwrites it
 * (StoreUnavailable) until the operator fixes or removes it.
 */

export const SESSION_SHARES_FILE = "session-shares.json";

export type ShareLinkWhy = "off" | "relinked" | "stopped" | "archived";

export interface ShareRecord {
  /** ss_… */
  id: string;
  sessionId: string;
  sessionPath: string;
  title: string;
  mode: SessionShareMode;
  /** Snapshot: the leaf entry at mint (or the last Update to now) and its time; null while live. */
  cut: { entryId: string; at: string | null } | null;
  createdAt: string;
  stoppedAt?: string;
}

export interface ShareLinkRecord {
  /** SHA-256 of the token, hex. */
  hash: string;
  shareId: string;
  /** r_…: stays the same across a relink. */
  recipientId: string;
  label: string;
  anyone?: true;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokedWhy?: ShareLinkWhy;
}

interface StoreFile {
  version: 1;
  shares: ShareRecord[];
  links: ShareLinkRecord[];
}

/** The store file is present but breaks a rule: nothing is served from it and nothing overwrites it. */
export class StoreUnavailable extends Error {
  constructor(why: string) {
    super(`session-shares.json is unreadable (${why})`);
    this.name = "StoreUnavailable";
  }
}

/** A request the store refuses: its `code` and HTTP status go to the operator. */
export class ShareError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ShareError";
  }
}

export const sharesFile = (): string => join(stateRoot(), SESSION_SHARES_FILE);

const ISO = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));
const SHARE_ID = /^ss_[A-Za-z0-9_-]{16}$/;
const RECIPIENT_ID = /^r_[A-Za-z0-9_-]{12}$/;

/** The whole file checked, or why not. */
export function validateSharesFile(raw: unknown): StoreFile | { why: string } {
  if (!isObj(raw) || !onlyKeys(raw, ["version", "shares", "links"]) || raw.version !== 1 || !Array.isArray(raw.shares) || !Array.isArray(raw.links)) return { why: "document shape" };
  const ids = new Set<string>();
  for (const [i, s] of (raw.shares as unknown[]).entries()) {
    const bad = (what: string) => ({ why: `share ${i}: ${what}` });
    if (!isObj(s) || !onlyKeys(s, ["id", "sessionId", "sessionPath", "title", "mode", "cut", "createdAt", "stoppedAt"])) return bad("keys");
    if (typeof s.id !== "string" || !SHARE_ID.test(s.id) || ids.has(s.id)) return bad("id");
    ids.add(s.id);
    if (typeof s.sessionId !== "string" || !s.sessionId || typeof s.sessionPath !== "string" || !s.sessionPath.startsWith("/")) return bad("session");
    if (typeof s.title !== "string" || s.title.length > SHARE_TITLE_MAX) return bad("title");
    if (s.mode !== "snapshot" && s.mode !== "live") return bad("mode");
    if (s.cut !== null && !(isObj(s.cut) && onlyKeys(s.cut, ["entryId", "at"]) && typeof s.cut.entryId === "string" && s.cut.entryId && (s.cut.at === null || ISO(s.cut.at)))) return bad("cut");
    if (s.mode === "snapshot" && s.cut === null) return bad("snapshot without a cut");
    if (!ISO(s.createdAt) || (s.stoppedAt !== undefined && !ISO(s.stoppedAt))) return bad("times");
  }
  const hashes = new Set<string>();
  for (const [i, l] of (raw.links as unknown[]).entries()) {
    const bad = (what: string) => ({ why: `link ${i}: ${what}` });
    if (!isObj(l) || !onlyKeys(l, ["hash", "shareId", "recipientId", "label", "anyone", "createdAt", "expiresAt", "revokedAt", "revokedWhy"])) return bad("keys");
    if (typeof l.hash !== "string" || !/^[0-9a-f]{64}$/.test(l.hash) || hashes.has(l.hash)) return bad("hash");
    hashes.add(l.hash);
    if (typeof l.shareId !== "string" || !ids.has(l.shareId)) return bad("shareId");
    if (typeof l.recipientId !== "string" || !RECIPIENT_ID.test(l.recipientId)) return bad("recipientId");
    if (typeof l.label !== "string" || !l.label || l.label.length > RECIPIENT_LABEL_MAX) return bad("label");
    if (l.anyone !== undefined && l.anyone !== true) return bad("anyone");
    if (!ISO(l.createdAt) || !ISO(l.expiresAt) || (l.revokedAt !== undefined && !ISO(l.revokedAt))) return bad("times");
    if (l.revokedWhy !== undefined && !["off", "relinked", "stopped", "archived"].includes(l.revokedWhy as string)) return bad("revokedWhy");
  }
  return raw as unknown as StoreFile;
}

/** The store as it is on disk: empty when there is no file; StoreUnavailable when it breaks a rule. */
function read(): StoreFile {
  const file = sharesFile();
  if (!existsSync(file)) return { version: 1, shares: [], links: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new StoreUnavailable("not JSON");
  }
  const checked = validateSharesFile(raw);
  if ("why" in checked) throw new StoreUnavailable(checked.why);
  return checked;
}

/** The store for a read path: a broken file serves nothing (logged once per reason). */
let warned = "";
function readOrEmpty(): StoreFile {
  try {
    return read();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (why !== warned) {
      warned = why;
      console.warn(`[session-share] ${why}; no session link opens until it is fixed or removed`);
    }
    return { version: 1, shares: [], links: [] };
  }
}

function write(store: StoreFile): void {
  const file = sharesFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600); // an existing tmp keeps its old mode through writeFileSync
  renameSync(tmp, file);
}

const DAY_MS = 86_400_000;
const newId = (prefix: string, bytes: number): string => `${prefix}${randomBytes(bytes).toString("base64url")}`;
const iso = (ms: number): string => new Date(ms).toISOString();

export const linkState = (l: ShareLinkRecord, share: ShareRecord | undefined, now = Date.now()): SessionShareLinkState =>
  l.revokedAt || !share || share.stoppedAt ? "off" : Date.parse(l.expiresAt) <= now ? "expired" : "live";

/** A label as stored: trimmed, inner whitespace folded; null when empty or too long. */
export function cleanLabel(label: unknown): string | null {
  if (typeof label !== "string") return null;
  const s = label.replace(/\s+/g, " ").trim();
  return s && s.length <= RECIPIENT_LABEL_MAX ? s : null;
}

export function cleanTitle(title: unknown): string | null {
  if (typeof title !== "string") return null;
  const s = title.replace(/\s+/g, " ").trim();
  return s && s.length <= SHARE_TITLE_MAX ? s : null;
}

export const validDays = (d: unknown): d is SessionShareDays => (SESSION_SHARE_DAYS as readonly unknown[]).includes(d);

/** One minted token, shown once. */
export interface MintedToken {
  recipientId: string;
  label: string;
  token: string;
}

function mintLink(store: StoreFile, shareId: string, recipient: { id?: string; label: string; anyone?: true }, expiresAt: string, now: number): MintedToken {
  const token = randomBytes(32).toString("base64url");
  const recipientId = recipient.id ?? newId("r_", 9);
  store.links.push({
    hash: hashToken(token),
    shareId,
    recipientId,
    label: recipient.label,
    ...(recipient.anyone ? { anyone: true as const } : {}),
    createdAt: iso(now),
    expiresAt,
  });
  return { recipientId, label: recipient.label, token };
}

/** The share's live recipients (one live link each). */
const liveLinksOf = (store: StoreFile, share: ShareRecord, now: number): ShareLinkRecord[] =>
  store.links.filter((l) => l.shareId === share.id && linkState(l, share, now) === "live");

function shareOf(store: StoreFile, id: string): ShareRecord {
  const s = store.shares.find((x) => x.id === id);
  if (!s) throw new ShareError(404, "not-found", "No such share.");
  return s;
}

function liveShareOf(store: StoreFile, id: string): ShareRecord {
  const s = shareOf(store, id);
  if (s.stoppedAt) throw new ShareError(409, "stopped", "This share is stopped.");
  return s;
}

export interface CreateInput {
  sessionId: string;
  sessionPath: string;
  title: string;
  mode: SessionShareMode;
  cut: { entryId: string; at: string | null } | null;
  days: SessionShareDays;
  labels: string[];
  anyone: boolean;
}

/** Validate the recipients of a new share: cleaned labels, none twice (case-insensitively), no
    label equal to the anyone row's, at least one link, at most RECIPIENTS_MAX. */
export function checkRecipients(labels: unknown, anyone: unknown): { labels: string[]; anyone: boolean } {
  if (!Array.isArray(labels) || typeof anyone !== "boolean") throw new ShareError(400, "bad-recipients", "Recipients must be a list of names.");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of labels) {
    const c = cleanLabel(l);
    if (!c) throw new ShareError(400, "bad-label", `A name must be 1 to ${RECIPIENT_LABEL_MAX} characters.`);
    const key = c.toLowerCase();
    if (seen.has(key) || key === ANYONE_LABEL.toLowerCase()) throw new ShareError(400, "duplicate-label", "Each name can be used once.");
    seen.add(key);
    out.push(c);
  }
  if (!out.length && !anyone) throw new ShareError(400, "no-recipients", "Add a name, or Anyone with the link.");
  if (out.length + (anyone ? 1 : 0) > RECIPIENTS_MAX) throw new ShareError(400, "too-many", `A share has at most ${RECIPIENTS_MAX} links.`);
  return { labels: out, anyone };
}

/** Create a share and one link per recipient. */
export function createShare(input: CreateInput, now = Date.now()): { share: ShareRecord; tokens: MintedToken[] } {
  const store = read();
  const share: ShareRecord = {
    id: newId("ss_", 12),
    sessionId: input.sessionId,
    sessionPath: input.sessionPath,
    title: input.title,
    mode: input.mode,
    cut: input.mode === "snapshot" ? input.cut : null,
    createdAt: iso(now),
  };
  if (share.mode === "snapshot" && !share.cut) throw new ShareError(400, "empty-session", "This session has nothing to share yet.");
  store.shares.push(share);
  const expiresAt = iso(now + input.days * DAY_MS);
  const tokens = input.labels.map((label) => mintLink(store, share.id, { label }, expiresAt, now));
  if (input.anyone) tokens.push(mintLink(store, share.id, { label: ANYONE_LABEL, anyone: true }, expiresAt, now));
  write(store);
  shareLinksChanged({ kind: "s", cause: "mint", hashes: tokens.map((t) => hashToken(t.token)) });
  return { share, tokens };
}

/** The expiry a new link of a share gets: its live links' latest, else `days` from now. */
function expiryForNew(store: StoreFile, share: ShareRecord, now: number): string {
  const live = liveLinksOf(store, share, now).map((l) => Date.parse(l.expiresAt));
  return live.length ? iso(Math.max(...live)) : iso(now + 30 * DAY_MS);
}

/** Add one recipient (a name, or the anyone row) to a live share. */
/**
 * Why `candidate` can't be live beside `live` (the share's other live links), or null. The limits
 * every write keeps: at most RECIPIENTS_MAX live links, one live Anyone row, no live name twice
 * (case-insensitively). Add, relink and extend all judge through this, so no write path (a
 * renewal of an expired link included) makes a share hold more than they allow.
 */
function limitConflict(live: readonly ShareLinkRecord[], candidate: { label: string; anyone?: true }): ShareError | null {
  if (live.length >= RECIPIENTS_MAX) return new ShareError(400, "too-many", `A share has at most ${RECIPIENTS_MAX} links.`);
  if (candidate.anyone) return live.some((l) => l.anyone) ? new ShareError(409, "anyone-exists", "Anyone with the link is already on.") : null;
  const key = candidate.label.toLowerCase();
  if (key === ANYONE_LABEL.toLowerCase() || live.some((l) => !l.anyone && l.label.toLowerCase() === key)) return new ShareError(409, "duplicate-label", "Each name can be used once.");
  return null;
}

export function addRecipient(shareId: string, who: { label: string } | { anyone: true }, now = Date.now()): MintedToken {
  const store = read();
  const share = liveShareOf(store, shareId);
  const live = liveLinksOf(store, share, now);
  let recipient: { label: string; anyone?: true };
  if ("anyone" in who) recipient = { label: ANYONE_LABEL, anyone: true };
  else {
    const label = cleanLabel(who.label);
    if (!label) throw new ShareError(400, "bad-label", `A name must be 1 to ${RECIPIENT_LABEL_MAX} characters.`);
    recipient = { label };
  }
  const conflict = limitConflict(live, recipient);
  if (conflict) throw conflict;
  const minted = mintLink(store, share.id, recipient, expiryForNew(store, share, now), now);
  write(store);
  shareLinksChanged({ kind: "s", cause: "mint", hashes: [hashToken(minted.token)] });
  return minted;
}

/** The recipient's newest link (live or not). */
function recipientLink(store: StoreFile, shareId: string, recipientId: string): ShareLinkRecord {
  const rows = store.links.filter((l) => l.shareId === shareId && l.recipientId === recipientId);
  const newest = rows[rows.length - 1];
  if (!newest) throw new ShareError(404, "not-found", "No such recipient.");
  return newest;
}

/** A new link for a recipient; the old one stops at once. Keeps the recipient's expiry when it is
    still ahead, else the share's. */
export function relinkRecipient(shareId: string, recipientId: string, now = Date.now()): MintedToken {
  const store = read();
  const share = liveShareOf(store, shareId);
  const old = recipientLink(store, shareId, recipientId);
  // The new link must fit beside the share's OTHER live links (an expired or turned-off
  // recipient coming back counts as a new one); refused before anything is written.
  const conflict = limitConflict(
    liveLinksOf(store, share, now).filter((l) => l.recipientId !== recipientId),
    { label: old.label, ...(old.anyone ? { anyone: true as const } : {}) },
  );
  if (conflict) throw conflict;
  const expiresAt = Date.parse(old.expiresAt) > now ? old.expiresAt : expiryForNew(store, share, now);
  for (const l of store.links)
    if (l.shareId === shareId && l.recipientId === recipientId && !l.revokedAt) {
      l.revokedAt = iso(now);
      l.revokedWhy = "relinked";
    }
  const minted = mintLink(store, share.id, { id: recipientId, label: old.label, ...(old.anyone ? { anyone: true as const } : {}) }, expiresAt, now);
  write(store);
  shareLinksChanged({ kind: "s", cause: "mint", hashes: [hashToken(minted.token)] });
  return minted;
}

/** Turn off one recipient's links; returns the hashes turned off. */
export function revokeRecipient(shareId: string, recipientId: string, now = Date.now()): string[] {
  const store = read();
  shareOf(store, shareId);
  recipientLink(store, shareId, recipientId);
  const off: string[] = [];
  for (const l of store.links)
    if (l.shareId === shareId && l.recipientId === recipientId && !l.revokedAt) {
      l.revokedAt = iso(now);
      l.revokedWhy = "off";
      off.push(l.hash);
    }
  if (off.length) {
    write(store);
    shareLinksChanged({ kind: "s", cause: "revoke" });
  }
  return off;
}

/** Stop shares: every link off, `stoppedAt` set. Returns the hashes turned off. */
function stopWhere(match: (s: ShareRecord) => boolean, why: ShareLinkWhy, now: number): { shares: string[]; hashes: string[] } {
  const store = read();
  const shares: string[] = [];
  const hashes: string[] = [];
  for (const s of store.shares)
    if (!s.stoppedAt && match(s)) {
      s.stoppedAt = iso(now);
      shares.push(s.id);
    }
  const stopped = new Set(shares);
  for (const l of store.links)
    if (stopped.has(l.shareId) && !l.revokedAt) {
      l.revokedAt = iso(now);
      l.revokedWhy = why;
      hashes.push(l.hash);
    }
  if (shares.length) {
    write(store);
    shareLinksChanged({ kind: "s", cause: "revoke" });
  }
  return { shares, hashes };
}

export function stopShare(shareId: string, now = Date.now()): { shares: string[]; hashes: string[] } {
  shareOf(read(), shareId);
  return stopWhere((s) => s.id === shareId, "stopped", now);
}

/** Archiving a session stops its shares. */
export const stopSharesOfSession = (sessionId: string, now = Date.now()): { shares: string[]; hashes: string[] } => stopWhere((s) => s.sessionId === sessionId, "archived", now);

/**
 * Every live link of the share then expires `days` from now. An expired recipient's newest link
 * (not turned off) opens again only while the limits still hold beside the links live by then:
 * newest first, and one that would be a second Anyone row, a name twice or a 21st link stays
 * expired (the operator can turn another off and extend again). Returns how many were renewed and
 * how many expired links stayed expired.
 */
export function extendShare(shareId: string, days: SessionShareDays, now = Date.now()): { renewed: number; kept: number } {
  const store = read();
  const share = liveShareOf(store, shareId);
  const expiresAt = iso(now + days * DAY_MS);
  const newest = new Map<string, ShareLinkRecord>();
  for (const l of store.links) if (l.shareId === share.id) newest.set(l.recipientId, l);
  const candidates = [...newest.values()].filter((l) => !l.revokedAt);
  const live = candidates.filter((l) => linkState(l, share, now) === "live");
  const expired = candidates.filter((l) => linkState(l, share, now) === "expired").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const renewed = [...live];
  let kept = 0;
  for (const l of expired) {
    if (limitConflict(renewed, { label: l.label, ...(l.anyone ? { anyone: true as const } : {}) })) kept++;
    else renewed.push(l);
  }
  if (!renewed.length) throw new ShareError(409, "no-links", "This share has no link to extend.");
  for (const l of renewed) l.expiresAt = expiresAt;
  write(store);
  // No new capability: a renewal is never a mint's candidate.
  shareLinksChanged({ kind: "s", cause: "renew" });
  return { renewed: renewed.length, kept };
}

/** Change the title, the mode, or the cut (Update to now, or a switch back to snapshot). */
export function patchShare(shareId: string, patch: { title?: string; mode?: SessionShareMode; cut?: { entryId: string; at: string | null } }): ShareRecord {
  const store = read();
  const share = liveShareOf(store, shareId);
  if (patch.title !== undefined) share.title = patch.title;
  if (patch.mode !== undefined) share.mode = patch.mode;
  if (patch.cut !== undefined) share.cut = patch.cut;
  if (share.mode === "live") share.cut = null;
  else if (!share.cut) throw new ShareError(400, "empty-session", "This session has nothing to share yet.");
  write(store);
  return share;
}

// ---- reading ------------------------------------------------------------------------------------

export interface ShareSnapshot {
  shares: ShareRecord[];
  links: ShareLinkRecord[];
}

/** Every share on this host (newest first) and every link row. A broken file reads as none. */
export function listShares(sessionId?: string): ShareSnapshot {
  const store = readOrEmpty();
  const shares = store.shares.filter((s) => !sessionId || s.sessionId === sessionId).reverse();
  const ids = new Set(shares.map((s) => s.id));
  return { shares, links: store.links.filter((l) => ids.has(l.shareId)) };
}

export function getShare(shareId: string): { share: ShareRecord; links: ShareLinkRecord[] } | null {
  const store = readOrEmpty();
  const share = store.shares.find((s) => s.id === shareId);
  return share ? { share, links: store.links.filter((l) => l.shareId === shareId) } : null;
}

/** The share and link a presented token names, in constant time per stored hash; null when none. */
export function findShareLink(token: string): { share: ShareRecord; link: ShareLinkRecord } | null {
  if (!TOKEN_RE.test(token)) return null;
  const want = Buffer.from(hashToken(token), "hex");
  const store = readOrEmpty();
  let hit: ShareLinkRecord | null = null;
  for (const l of store.links) {
    const have = Buffer.from(l.hash, "hex");
    if (have.length === want.length && timingSafeEqual(have, want)) hit = l;
  }
  const share = hit ? store.shares.find((s) => s.id === hit!.shareId) : undefined;
  return hit && share ? { share, link: hit } : null;
}

export type ShareAccess =
  | { ok: true; share: ShareRecord; link: ShareLinkRecord }
  | { ok: false; status: 404 }
  | { ok: false; status: 410; why?: "expired"; share: ShareRecord; link: ShareLinkRecord };

/** Whether a token opens now: 404 unknown; 410 dead (`why: "expired"` only when it expired, never
    what else killed it). The session file's presence is the view's to judge. */
export function shareAccess(token: string, now = Date.now()): ShareAccess {
  const hit = findShareLink(token);
  if (!hit) return { ok: false, status: 404 };
  const state = linkState(hit.link, hit.share, now);
  if (state === "live") return { ok: true, ...hit };
  return { ok: false, status: 410, ...(state === "expired" ? { why: "expired" as const } : {}), ...hit };
}

/** The share and link a stored hash names (a socket's key); null when none. */
export function linkByHash(hash: string): { share: ShareRecord; link: ShareLinkRecord } | null {
  const store = readOrEmpty();
  const link = store.links.find((l) => l.hash === hash);
  const share = link ? store.shares.find((s) => s.id === link.shareId) : undefined;
  return link && share ? { share, link } : null;
}

/** Every link hash in the store (live or not): the gateway's own, first claimant of each. */
export function sessionShareHashes(): string[] {
  return readOrEmpty().links.map((l) => l.hash);
}
