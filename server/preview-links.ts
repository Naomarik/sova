import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FORBIDDEN_PREVIEW_PORTS, PREVIEW_DAYS_DEFAULT, PREVIEW_DAYS_MAX, PREVIEW_LABEL_RE } from "../shared/public-links";
import type { PreviewErrorCode, PreviewState, PreviewView } from "../shared/preview-links";
import { shareLinksChanged } from "./share/links-events";
import { stateRoot } from "./state-root";

/**
 * Preview links (§mesh.public/preview): `<stateRoot>/preview-links.json` (0600, atomic, strict),
 * host-local, never synced or committed. A preview names one loopback port of this host; its
 * label (the secret, and its host name `<label>.<zone>`) is 32 random bytes as 52 lowercase base32
 * characters, and only its SHA-256 is kept. The link rows keep the baton store's field names
 * (`hash`, `expiresAt`, `revokedAt`), so the registry push reads them as kind `p` rows.
 *
 * A file that breaks a rule serves no preview, and no mutation overwrites it (PreviewUnavailable)
 * until the operator fixes or removes it. Revoke and expiry reach the proxy through onPreviewEnded,
 * which closes every open connection of that preview at once.
 */

export const PREVIEW_LINKS_FILE = "preview-links.json";

export interface PreviewRecord {
  /** pv_… */
  id: string;
  /** SHA-256 of the label, hex. */
  hash: string;
  orgId: string;
  projectId: string;
  port: number;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  /** `operator` or `session:<id>`. */
  createdBy: string;
  /** A person's own link to another preview (§app.outreach/links): its port, never past its expiry,
      turned off with it. */
  siblingOf?: string;
  /** The roster person it was sent to (a sibling's). */
  sentTo?: string;
}

interface StoreFile {
  version: 1;
  links: PreviewRecord[];
}

export class PreviewUnavailable extends Error {
  constructor(why: string) {
    super(`preview-links.json is unreadable (${why})`);
    this.name = "PreviewUnavailable";
  }
}

/** A mint or change the store refuses: its code goes to the operator (400). */
export class PreviewRefused extends Error {
  constructor(
    readonly code: PreviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PreviewRefused";
  }
}

export const previewLinksFile = (): string => join(stateRoot(), PREVIEW_LINKS_FILE);

const ISO = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));
const PREVIEW_ID = /^pv_[A-Za-z0-9_-]{16}$/;
const REF = /^[A-Za-z0-9_.:-]{1,128}$/;
const isPort = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;
const isDays = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= PREVIEW_DAYS_MAX;

/** The whole file checked, or why not. */
export function validatePreviewFile(raw: unknown): StoreFile | { why: string } {
  if (!isObj(raw) || !onlyKeys(raw, ["version", "links"]) || raw.version !== 1 || !Array.isArray(raw.links)) return { why: "document shape" };
  const ids = new Set<string>();
  const hashes = new Set<string>();
  for (const [i, l] of (raw.links as unknown[]).entries()) {
    const bad = (what: string) => ({ why: `link ${i}: ${what}` });
    if (!isObj(l) || !onlyKeys(l, ["id", "hash", "orgId", "projectId", "port", "createdAt", "expiresAt", "revokedAt", "createdBy", "siblingOf", "sentTo"])) return bad("keys");
    if (typeof l.id !== "string" || !PREVIEW_ID.test(l.id) || ids.has(l.id)) return bad("id");
    ids.add(l.id);
    if (typeof l.hash !== "string" || !/^[0-9a-f]{64}$/.test(l.hash) || hashes.has(l.hash)) return bad("hash");
    hashes.add(l.hash);
    if (typeof l.orgId !== "string" || !REF.test(l.orgId) || typeof l.projectId !== "string" || !REF.test(l.projectId)) return bad("project");
    if (!isPort(l.port)) return bad("port");
    if (!ISO(l.createdAt) || !ISO(l.expiresAt) || (l.revokedAt !== undefined && !ISO(l.revokedAt))) return bad("times");
    if (typeof l.createdBy !== "string" || !(l.createdBy === "operator" || /^session:[A-Za-z0-9_.-]{1,128}$/.test(l.createdBy))) return bad("createdBy");
    if ((l.siblingOf !== undefined && (typeof l.siblingOf !== "string" || !PREVIEW_ID.test(l.siblingOf))) || (l.sentTo !== undefined && (typeof l.sentTo !== "string" || !REF.test(l.sentTo)))) return bad("sibling");
  }
  return { version: 1, links: raw.links as PreviewRecord[] };
}

function read(): StoreFile {
  const file = previewLinksFile();
  if (!existsSync(file)) return { version: 1, links: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new PreviewUnavailable("not JSON");
  }
  const checked = validatePreviewFile(raw);
  if ("why" in checked) throw new PreviewUnavailable(checked.why);
  return checked;
}

let warned = "";
/** The last read, by the file's stat: every preview request reads the store, a page load hundreds. */
let cached: { path: string; stamp: string; store: StoreFile } | null = null;
function stampOf(file: string): string {
  try {
    const st = statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return "missing";
  }
}
/** The store for a read path: a broken file serves nothing (logged once per reason). */
function readOrEmpty(): StoreFile {
  const path = previewLinksFile();
  const stamp = stampOf(path);
  if (cached?.path === path && cached.stamp === stamp) return cached.store;
  try {
    const store = read();
    cached = { path, stamp, store };
    return store;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (why !== warned) {
      warned = why;
      console.warn(`[preview] ${why}; no preview opens until it is fixed or removed`);
    }
    return { version: 1, links: [] };
  }
}

function write(store: StoreFile): void {
  cached = null;
  const file = previewLinksFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

const DAY_MS = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const newId = (prefix: string): string => `${prefix}${randomBytes(12).toString("base64url")}`;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A new label: 32 random bytes as 52 lowercase base32 characters (the last one carries 1 bit). */
export function newPreviewLabel(): string {
  const bytes = randomBytes(32);
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export const hashLabel = (label: string): string => createHash("sha256").update(label, "utf8").digest("hex");

export const previewState = (r: PreviewRecord, now = Date.now()): PreviewState => (r.revokedAt ? "off" : Date.parse(r.expiresAt) <= now ? "expired" : "active");

export function viewOf(r: PreviewRecord, now = Date.now()): PreviewView {
  return {
    id: r.id,
    orgId: r.orgId,
    projectId: r.projectId,
    port: r.port,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    ...(r.revokedAt ? { revokedAt: r.revokedAt } : {}),
    createdBy: r.createdBy,
    ...(r.siblingOf ? { siblingOf: r.siblingOf } : {}),
    ...(r.sentTo ? { sentTo: r.sentTo } : {}),
    state: previewState(r, now),
  };
}


// ---- ended previews, for the proxy ---------------------------------------------------------------

const endedListeners = new Set<(hash: string) => void>();
/** Called with a preview's hash when it is turned off (and by the proxy's own sweep on expiry). */
export function onPreviewEnded(cb: (hash: string) => void): () => void {
  endedListeners.add(cb);
  return () => endedListeners.delete(cb);
}
function ended(hash: string): void {
  for (const cb of endedListeners) {
    try {
      cb(hash);
    } catch (err) {
      console.warn(`[preview] ended listener failed (${(err as Error)?.name ?? "error"})`);
    }
  }
}

// ---- reads ---------------------------------------------------------------------------------------

/** The record for a label (any state), or null. */
export function findPreview(label: string): PreviewRecord | null {
  if (!PREVIEW_LABEL_RE.test(label)) return null;
  const h = hashLabel(label);
  return readOrEmpty().links.find((l) => l.hash === h) ?? null;
}

/** The record for a label's hash (any state), or null. */
export function findPreviewByHash(hash: string): PreviewRecord | null {
  return readOrEmpty().links.find((l) => l.hash === hash) ?? null;
}

/** Whether this host minted the hash (any state): it is the only authority on it. */
export function previewHashKnown(hash: string): boolean {
  return readOrEmpty().links.some((l) => l.hash === hash);
}

export function listPreviews(filter: { orgId?: string; projectId?: string } = {}, now = Date.now()): PreviewView[] {
  const match = (x: { orgId: string; projectId: string }) => (!filter.orgId || x.orgId === filter.orgId) && (!filter.projectId || x.projectId === filter.projectId);
  return readOrEmpty().links.filter(match).map((r) => viewOf(r, now));
}

// ---- writes --------------------------------------------------------------------------------------

export interface MintInput {
  orgId: string;
  projectId: string;
  port: unknown;
  days?: unknown;
  createdBy?: string;
}

/**
 * A person's own link to preview `of` (§app.outreach/links): the same org, project and port, expiring
 * with it (never later), and turned off with it. Refused unless `of` is active.
 */
export function mintSibling(of: string, sentTo: string, now = Date.now()): { record: PreviewRecord; label: string } {
  const store = read();
  const o = store.links.find((l) => l.id === of);
  if (!o || previewState(o, now) !== "active") throw new PreviewRefused("bad-project", "That preview is not active.");
  if (!REF.test(sentTo)) throw new PreviewRefused("bad-project", "Name the person it goes to.");
  const label = newPreviewLabel();
  const record: PreviewRecord = {
    id: newId("pv_"),
    hash: hashLabel(label),
    orgId: o.orgId,
    projectId: o.projectId,
    port: o.port,
    createdAt: iso(now),
    expiresAt: o.expiresAt,
    createdBy: "operator",
    siblingOf: o.id,
    sentTo,
  };
  store.links.push(record);
  write(store);
  shareLinksChanged({ kind: "p", cause: "mint", hashes: [record.hash] });
  return { record, label };
}

/** Check a port: an integer 1–65535, not Sova's own defaults, not a port this process uses. */
export function checkPort(port: unknown, sovaPorts: ReadonlySet<number>): number {
  if (!isPort(port)) throw new PreviewRefused("bad-port", "The port must be a whole number from 1 to 65535.");
  if (FORBIDDEN_PREVIEW_PORTS.includes(port) || sovaPorts.has(port)) throw new PreviewRefused("forbidden-port", `Port ${port} is Sova's own, so it can't be previewed.`);
  return port;
}

export function checkDays(days: unknown): number {
  if (days === undefined) return PREVIEW_DAYS_DEFAULT;
  if (!isDays(days)) throw new PreviewRefused("bad-days", `A preview lasts 1 to ${PREVIEW_DAYS_MAX} days.`);
  return days;
}

function checkProject(orgId: unknown, projectId: unknown): { orgId: string; projectId: string } {
  if (typeof orgId !== "string" || !REF.test(orgId) || typeof projectId !== "string" || !REF.test(projectId)) throw new PreviewRefused("bad-project", "Name the project this preview belongs to.");
  return { orgId, projectId };
}

/** Mint one preview. The label is returned once and never stored. Emits a `p` link change. */
export function mintPreview(input: MintInput, sovaPorts: ReadonlySet<number>, now = Date.now()): { record: PreviewRecord; label: string } {
  const { orgId, projectId } = checkProject(input.orgId, input.projectId);
  const port = checkPort(input.port, sovaPorts);
  const days = checkDays(input.days);
  const store = read();
  const label = newPreviewLabel();
  const record: PreviewRecord = {
    id: newId("pv_"),
    hash: hashLabel(label),
    orgId,
    projectId,
    port,
    createdAt: iso(now),
    expiresAt: iso(now + days * DAY_MS),
    createdBy: input.createdBy ?? "operator",
  };
  store.links.push(record);
  write(store);
  shareLinksChanged({ kind: "p", cause: "mint", hashes: [record.hash] });
  return { record, label };
}

/** Turn one off, and every person's sibling of it: 410 from now on, and their open connections closed. Idempotent. */
export function revokePreview(id: string, now = Date.now()): PreviewRecord | null {
  const store = read();
  const r = store.links.find((l) => l.id === id);
  if (!r) return null;
  const off = [r, ...store.links.filter((l) => l.siblingOf === id)];
  const changed = off.filter((l) => !l.revokedAt);
  for (const l of changed) l.revokedAt = iso(now);
  if (changed.length) {
    write(store);
    shareLinksChanged({ kind: "p", cause: "revoke" });
  }
  for (const l of off) ended(l.hash);
  return r;
}

/** Move an active one's expiry to `days` from now. */
export function extendPreview(id: string, days: unknown, now = Date.now()): PreviewRecord | null {
  const d = checkDays(days);
  const store = read();
  const r = store.links.find((l) => l.id === id);
  if (!r) return null;
  if (previewState(r, now) !== "active") throw new PreviewRefused("bad-days", "Only an active preview can be extended.");
  // A sibling never outlives the preview it copies.
  const parent = r.siblingOf ? store.links.find((l) => l.id === r.siblingOf) : undefined;
  const want = now + d * DAY_MS;
  r.expiresAt = iso(parent ? Math.min(want, Date.parse(parent.expiresAt)) : want);
  write(store);
  shareLinksChanged({ kind: "p", cause: "renew" });
  return r;
}
