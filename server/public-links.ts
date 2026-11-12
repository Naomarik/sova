import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PREVIEW_URL_RE, SHARE_PORT_DEFAULT, type CloudflareAccountSetting, type PublicLinksFile, type PublicLinksReading, type ShareFront, type ShareGatewaySetting, type ShareRoute } from "../shared/public-links";
import { stateRoot } from "./state-root";
import { problemOf } from "../shared/form-rules";
import { INGRESS_PORT_RULE, PREVIEW_URL_RULE, PUBLIC_URL_RULE, SHARE_PORT_RULE } from "../shared/public-links-limits";

/**
 * The Public links setting (§mesh.public/setting): `<stateRoot>/public-links.json`, 0600, written
 * atomically, parsed strictly (an unknown key or a wrong type rejects the whole file). Separate
 * from peers.json, so a host that is its own gateway works with the mesh off.
 *
 * What every reader sees is the effective setting (readPublicLinksSetting, PublicLinksReading in
 * shared/public-links.ts): a missing file, or an Off saved before the Cloudflare Free default (no
 * `offChosenAt`), reads as `quick`; an Off a PUT saved (`offChosenAt`) is `off` with sharing off
 * entirely; a file that can't be read or parsed is logged and read as `off`, `broken`, never
 * half-applied and never `quick` (no tunnel starts for a setup the user saved and we can't read).
 * SOVA_QUICK_TUNNEL=off (the test runner sets it) keeps the old default: a missing file is off.
 *
 * `lastKnownUrl`, `verifiedAt` and `offChosenAt` are written only by the server; a PUT's patch
 * can't carry them. The SOVA_SHARE_* variables win over the file (pinnedByEnv).
 */

export const OFF: PublicLinksFile = { version: 1, route: "off" };

const FRONTS: readonly ShareFront[] = ["vhost", "caddy", "funnel", "cloudflared"];
const FILE_KEYS = ["version", "route", "gateway", "ingressPort", "lastKnownUrl", "verifiedAt", "account", "offChosenAt"];
const PATCH_KEYS = ["route", "gateway", "ingressPort", "account"];
const GATEWAY_KEYS = ["publicUrl", "front", "sharePort", "acceptFrom", "previewUrl"];
const ACCOUNT_KEYS = ["publicUrl", "previewUrl"];
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

/**
 * An https origin in its canonical form: `https://<host>[:<port>]`, optionally with one trailing
 * slash, exactly as the URL parser would print its origin (lowercase, no default port). Anything
 * the parser would rewrite is refused rather than normalized: a backslash (read as a slash), a tab
 * or newline (dropped), `.`/`%2e` segments, an empty `?` or `#`, missing slashes, credentials.
 * Returned without the trailing slash.
 */
export function parsePublicUrl(v: unknown): string {
  const bad = "publicUrl must be just an https:// address, like https://share.example.com";
  if (typeof v !== "string") return fail(bad);
  const text = v.trim();
  if (!text || /[\\\s\x00-\x1f\x7f]/.test(text)) return fail(bad);
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return fail(bad);
  }
  if (u.protocol !== "https:") fail("publicUrl must start with https://");
  if (u.username || u.password || u.search || u.hash || u.pathname !== "/") fail(bad);
  if (text !== u.origin && text !== `${u.origin}/`) fail(`${bad} (written ${u.origin})`);
  return u.origin;
}

function parseRoute(v: unknown): ShareRoute {
  if (v === "off" || v === "quick" || v === "account" || v === "self") return v;
  if (isObj(v)) {
    onlyKeys(v, ["via"], "route");
    const via = v.via;
    if (isObj(via)) {
      onlyKeys(via, ["nodeId"], "route.via");
      if (typeof via.nodeId === "string" && NODE_ID.test(via.nodeId)) return { via: { nodeId: via.nodeId } };
    }
  }
  return fail('route must be "off", "quick", "account", "self" or {via: {nodeId}}');
}

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** A URL as stored: exactly the canonical origin (parsePublicUrl's form, no trailing slash). */
function storedUrl(v: unknown, what: string): string {
  if (parsePublicUrl(v) !== v) fail(`${what} must be written as its bare origin, with no trailing slash`);
  return v as string;
}

/** Every key present, nothing defaulted or deduplicated: the stored gateway as the contract has it. */
function parseGateway(v: unknown): ShareGatewaySetting {
  if (!isObj(v)) return fail("gateway must be an object");
  onlyKeys(v, GATEWAY_KEYS, "gateway");
  const publicUrl = storedUrl(v.publicUrl, "gateway.publicUrl");
  if (!FRONTS.includes(v.front as ShareFront)) fail(`gateway.front must be one of ${FRONTS.join(", ")}`);
  if (!isPort(v.sharePort)) fail("gateway.sharePort must be a port, 1-65535");
  const acceptFrom = v.acceptFrom;
  if (acceptFrom !== "all") {
    if (!Array.isArray(acceptFrom) || acceptFrom.length > ACCEPT_MAX || !acceptFrom.every((x) => typeof x === "string" && NODE_ID.test(x)))
      fail('gateway.acceptFrom must be "all" or a list of node ids');
    if (new Set(acceptFrom as string[]).size !== (acceptFrom as string[]).length) fail("gateway.acceptFrom lists a node twice");
  }
  const out: ShareGatewaySetting = { publicUrl, front: v.front as ShareFront, sharePort: v.sharePort as number, acceptFrom: acceptFrom === "all" ? "all" : [...(acceptFrom as string[])] };
  if (v.previewUrl !== undefined) {
    if (parsePreviewUrl(v.previewUrl, false) !== v.previewUrl) fail("gateway.previewUrl must be written like https://*.example.com, with no path or trailing slash");
    out.previewUrl = v.previewUrl as string;
  }
  return out;
}

/** Cloudflare Account's address, strictly: publicUrl as stored, previewUrl in its exact form. */
function parseAccount(v: unknown): CloudflareAccountSetting {
  if (!isObj(v)) return fail("account must be an object");
  onlyKeys(v, ACCOUNT_KEYS, "account");
  const out: CloudflareAccountSetting = { publicUrl: storedUrl(v.publicUrl, "account.publicUrl") };
  if (v.previewUrl !== undefined) {
    if (parsePreviewUrl(v.previewUrl, false) !== v.previewUrl) fail("account.previewUrl must be written like https://*.example.com, with no path or trailing slash");
    out.previewUrl = v.previewUrl as string;
  }
  return out;
}

/** A PUT's account before the strict parse: publicUrl may carry one trailing slash, previewUrl
    one trailing slash and capitals, and an empty previewUrl is none (as gatewayInput). */
function accountInput(v: unknown): unknown {
  if (!isObj(v)) return v;
  let publicUrl = v.publicUrl;
  try {
    publicUrl = parsePublicUrl(v.publicUrl);
  } catch {
    // left as sent: the strict parse names the problem
  }
  const out: Record<string, unknown> = { ...v, publicUrl };
  if (v.previewUrl === null || (typeof v.previewUrl === "string" && !v.previewUrl.trim())) delete out.previewUrl;
  else if (typeof v.previewUrl === "string") out.previewUrl = parsePreviewUrl(v.previewUrl.trim().toLowerCase().replace(/\/$/, ""), false) ?? v.previewUrl;
  return out;
}

/** A PUT's gateway before the strict parse: the port and acceptFrom may be left out (their
    defaults), and publicUrl may carry one trailing slash. Nothing else is forgiven. */
function gatewayInput(v: unknown): unknown {
  if (!isObj(v)) return v;
  let publicUrl = v.publicUrl;
  try {
    publicUrl = parsePublicUrl(v.publicUrl);
  } catch {
    // left as sent: the strict parse names the problem
  }
  const out: Record<string, unknown> = { sharePort: SHARE_PORT_DEFAULT, acceptFrom: "all", ...v, publicUrl };
  // An empty preview address is none; a written one may carry one trailing slash and capitals.
  if (v.previewUrl === null || (typeof v.previewUrl === "string" && !v.previewUrl.trim())) delete out.previewUrl;
  else if (typeof v.previewUrl === "string") out.previewUrl = parsePreviewUrl(v.previewUrl.trim().toLowerCase().replace(/\/$/, ""), false) ?? v.previewUrl;
  return out;
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
  if (raw.lastKnownUrl !== undefined) out.lastKnownUrl = storedUrl(raw.lastKnownUrl, "lastKnownUrl");
  if (raw.verifiedAt !== undefined) {
    if (!isTime(raw.verifiedAt)) fail("verifiedAt must be a time");
    out.verifiedAt = raw.verifiedAt as number;
  }
  if (raw.account !== undefined) out.account = parseAccount(raw.account);
  if (raw.offChosenAt !== undefined) {
    if (!isTime(raw.offChosenAt)) fail("offChosenAt must be a time");
    if (out.route !== "off") fail('offChosenAt goes only with route "off"');
    out.offChosenAt = raw.offChosenAt as number;
  }
  if (out.route === "self" && !out.gateway) fail('route "self" needs a gateway setting');
  if (out.route === "account" && !out.account) fail('route "account" needs the Cloudflare Account address');
  return out;
}

/** Whether a Cloudflare Free tunnel may be the default: false under SOVA_QUICK_TUNNEL=off (the
    test runner's), where a missing setting reads as off and no Free tunnel ever starts. */
export function quickTunnelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SOVA_QUICK_TUNNEL?.trim().toLowerCase() !== "off";
}

/** The stored file, raw: `missing` (no file), `broken` (there but unreadable or not parsing),
    or the file as written (a legacy Off stays `off` here). */
export type StoredPublicLinks = { kind: "missing" } | { kind: "broken" } | { kind: "ok"; file: PublicLinksFile };

/** The file version last warned about, so a bad file is named once, not on every read. */
let warnedFile: string | null = null;

function warnBroken(version: string, why: string): void {
  if (warnedFile === version) return;
  warnedFile = version;
  console.warn(`[share] public-links.json ignored (read as off, and no Cloudflare tunnel starts for it, until it is fixed or saved again in Settings → Public links): ${why}`);
}

/** The file as stored. A file that can't be read (other than not being there) or doesn't parse is
    `broken`, warned about once per version, never quoting its contents. */
export function readStoredPublicLinks(): StoredPublicLinks {
  let text: string;
  try {
    text = readFileSync(publicLinksFile(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { kind: "missing" };
    warnBroken(`unreadable:${(err as NodeJS.ErrnoException)?.code ?? "?"}`, "it can't be read");
    return { kind: "broken" };
  }
  try {
    return { kind: "ok", file: parsePublicLinks(JSON.parse(text)) };
  } catch (err) {
    warnBroken(`${text.length}:${createHash("sha256").update(text).digest("hex")}`, err instanceof ParseError ? "it breaks the setting's rules" : "not JSON");
    return { kind: "broken" };
  }
}

/** The effective setting of a stored one (PublicLinksReading's rules, shared/public-links.ts). */
export function effectivePublicLinks(stored: StoredPublicLinks, env: NodeJS.ProcessEnv = process.env): PublicLinksReading {
  const implicitRoute = quickTunnelEnabled(env) ? "quick" : "off";
  if (stored.kind === "missing") return { file: { version: 1, route: implicitRoute }, implicit: true, broken: false, sharingOff: false };
  if (stored.kind === "broken") return { file: { ...OFF }, implicit: false, broken: true, sharingOff: false };
  const file = stored.file;
  if (file.route === "off" && file.offChosenAt === undefined) return { file: { ...file, route: implicitRoute }, implicit: true, broken: false, sharingOff: false };
  return { file, implicit: false, broken: false, sharingOff: file.route === "off" && sharePin(env) === null };
}

/** The setting as every reader sees it: the effective file and why (implicit, broken, sharing off). */
export function readPublicLinksSetting(env: NodeJS.ProcessEnv = process.env): PublicLinksReading {
  return effectivePublicLinks(readStoredPublicLinks(), env);
}

/** The effective setting (readPublicLinksSetting's `file`): what every link reader acts on. */
export function readPublicLinks(env: NodeJS.ProcessEnv = process.env): PublicLinksFile {
  return readPublicLinksSetting(env).file;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
const write = (file: PublicLinksFile): void => writeJson(publicLinksFile(), file);

/** The address a Verify vouches for, or null when the route has none of its own. */
const verifiedAddress = (f: PublicLinksFile): string | null =>
  f.route === "self" ? (f.gateway?.publicUrl ?? null) : f.route === "account" ? (f.account ? `account:${f.account.publicUrl}` : null) : null;

/**
 * Apply a PUT's patch: `{file}` (the effective setting as written), or `{error}` and nothing
 * written. Changing the verified address (or leaving "self"/"account") drops `verifiedAt`: a
 * Verify vouches for one address. A patch that sets `route: "off"` stamps `offChosenAt` (sharing
 * off entirely); any other route drops it. A `self` or via file is written without `account`, so
 * an older Sova still reads it. A file that can't be read is replaced (saving again fixes it).
 */
export function patchPublicLinks(patch: unknown, now: number = Date.now()): { file: PublicLinksFile } | { error: string } {
  const stored = readStoredPublicLinks();
  const cur: PublicLinksFile = stored.kind === "ok" ? stored.file : { ...OFF };
  try {
    if (!isObj(patch)) fail("Expected a JSON object body");
    const p = patch as Record<string, unknown>;
    onlyKeys(p, PATCH_KEYS, "body");
    // The form's own rules and words (shared/public-links-limits.ts), ahead of the file's, which name keys.
    const g = isObj(p.gateway) ? p.gateway : {};
    const why =
      (p.ingressPort != null && problemOf(INGRESS_PORT_RULE, p.ingressPort)) ||
      (g.publicUrl !== undefined && problemOf(PUBLIC_URL_RULE, g.publicUrl)) ||
      (g.sharePort !== undefined && problemOf(SHARE_PORT_RULE, g.sharePort)) ||
      (typeof g.previewUrl === "string" && problemOf(PREVIEW_URL_RULE, g.previewUrl));
    if (why) fail(why);
    const next: Record<string, unknown> = { ...cur };
    if ("route" in p) next.route = p.route;
    if ("gateway" in p) next.gateway = gatewayInput(p.gateway);
    if ("ingressPort" in p) next.ingressPort = p.ingressPort;
    if ("account" in p) next.account = accountInput(p.account);
    for (const k of PATCH_KEYS) if (next[k] === null) delete next[k];
    if (next.route !== "off") delete next.offChosenAt;
    else if ("route" in p && !(cur.route === "off" && cur.offChosenAt !== undefined)) next.offChosenAt = now;
    if (next.route === "self" || isObj(next.route)) delete next.account;
    const file = parsePublicLinks(next);
    const addr = verifiedAddress(file);
    if (addr === null || addr !== verifiedAddress(cur)) delete file.verifiedAt;
    write(file);
    return { file: effectivePublicLinks({ kind: "ok", file }).file };
  } catch (err) {
    if (err instanceof ParseError) return { error: err.message };
    throw err;
  }
}

/** The server-written fields: a Verify that passed (`verifiedAt`), a via gateway's URL as learnt
    (`lastKnownUrl`); null removes one. Returns the effective setting as written. A file that
    can't be read is never written over here (only a PUT replaces it): it stays broken. */
export function writeServerFields(fields: { verifiedAt?: number | null; lastKnownUrl?: string | null }): PublicLinksFile {
  const stored = readStoredPublicLinks();
  if (stored.kind === "broken") return effectivePublicLinks(stored).file;
  const file: PublicLinksFile = stored.kind === "ok" ? stored.file : { ...OFF };
  if (fields.verifiedAt !== undefined) {
    if (fields.verifiedAt === null) delete file.verifiedAt;
    else file.verifiedAt = fields.verifiedAt;
  }
  if (fields.lastKnownUrl !== undefined) {
    if (fields.lastKnownUrl === null) delete file.lastKnownUrl;
    else file.lastKnownUrl = parsePublicUrl(fields.lastKnownUrl);
  }
  write(file);
  return effectivePublicLinks({ kind: "ok", file }).file;
}

// ---- Turn On (the one-time consent to public Free tunnels) --------------------------------------

/** <stateRoot>/public-links-consent.json: `{version: 1, consentAt}`, 0600, atomic. Its own file,
    not a key of public-links.json, so a `self` or via file stays readable by an older Sova. */
export const tunnelConsentFile = () => join(stateRoot(), "public-links-consent.json");

/** When the operator pressed Turn On (ms), or null: never, or the file is missing or bad. */
export function readTunnelConsent(): number | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(tunnelConsentFile(), "utf8"));
    if (isObj(raw) && raw.version === 1 && isTime(raw.consentAt) && Object.keys(raw).length === 2) return raw.consentAt;
  } catch {
    // none
  }
  return null;
}

/** Record Turn On; only the operator's own click in Sova's page calls this, never an agent.
    Once given it stays: returns the first time recorded. */
export function recordTunnelConsent(at: number = Date.now()): number {
  const prior = readTunnelConsent();
  if (prior !== null) return prior;
  writeJson(tunnelConsentFile(), { version: 1, consentAt: at });
  return at;
}

/** Whether a Free tunnel may start: Free is enabled (quickTunnelEnabled) and Turn On was pressed.
    The one gate every Free tunnel start, share and preview alike, passes. */
export function quickTunnelAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return quickTunnelEnabled(env) && readTunnelConsent() !== null;
}

/** A routed host's via gateway URL as learnt (its hello or ack): kept as `lastKnownUrl`, so links
    point there while the gateway is out of reach. Re-reads the file and writes it atomically;
    throws on a URL that isn't a bare https origin. */
export function recordLastKnownUrl(url: string): PublicLinksFile {
  return writeServerFields({ lastKnownUrl: url });
}

/** The SOVA_SHARE_* variables that are set, and so win over the setting. */
export const SHARE_ENV = ["SOVA_SHARE_PUBLIC_URL", "SOVA_SHARE_HOST", "SOVA_SHARE_PORT", "SOVA_SHARE_PREVIEW_URL"] as const;
export function pinnedByEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return SHARE_ENV.filter((k) => (k === "SOVA_SHARE_PUBLIC_URL" ? sharePin(env) !== null : k === "SOVA_SHARE_PREVIEW_URL" ? previewPin(env) !== null : !!env[k]?.trim()));
}

/** The pins already warned about, so a refused one is logged once, not per request. */
const warnedPins = new Set<string>();

/**
 * The SOVA_SHARE_PUBLIC_URL pin as an origin, or null (no pin). It follows parsePublicUrl's rule
 * except that http is allowed (tailnet deployments pin one): no backslash, whitespace or control
 * character, no credentials, query or fragment, no path but "/". A refused pin is logged once and
 * counts as no pin, so the setting decides; it never throws.
 */
export function sharePin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.SOVA_SHARE_PUBLIC_URL;
  const text = raw?.trim();
  if (!text) return null;
  let origin: string | null = null;
  // As written: scheme://authority, then at most "/" (the parser would drop "/." or an empty "?").
  const shape = /^https?:\/\/([^/?#@]+)\/?$/i.test(text);
  if (shape && !/[\\\s\x00-\x1f\x7f]/.test(text)) {
    try {
      const u = new URL(text);
      if ((u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password && !u.search && !u.hash && u.pathname === "/") origin = u.origin;
    } catch {
      origin = null;
    }
  }
  if (origin === null && !warnedPins.has(text)) {
    warnedPins.add(text);
    console.warn("[share] SOVA_SHARE_PUBLIC_URL ignored: it must be just an http:// or https:// address (no path, query, login, spaces or backslashes). Links use the Public links setting instead.");
  }
  return origin;
}

/**
 * A preview address (§mesh.public/preview-address) in its canonical form, or null: `https://*.<host>`
 * (http too when `http` is allowed: a pin), exactly one wildcard label over a lowercase host of at
 * least two labels, an optional port, nothing after it. Nothing is normalized: anything else is null.
 */
export function parsePreviewUrl(v: unknown, http: boolean): string | null {
  if (typeof v !== "string") return null;
  const m = PREVIEW_URL_RE.exec(v);
  if (!m) return null;
  if (m[1] === "http" && !http) return null;
  const port = m[3] === undefined ? null : Number(m[3]);
  if (port !== null && (port < 1 || port > 65535 || String(port) !== m[3] || port === (m[1] === "https" ? 443 : 80))) return null;
  if (m[2]!.length > 253 - 53) return null; // a label, its dot and the zone must fit a DNS name
  return v;
}

/** The SOVA_SHARE_PREVIEW_URL pin, or null; a refused one is logged once and counts as none. */
export function previewPin(env: NodeJS.ProcessEnv = process.env): string | null {
  const text = env.SOVA_SHARE_PREVIEW_URL?.trim();
  if (!text) return null;
  const url = parsePreviewUrl(text.toLowerCase().replace(/\/$/, ""), true);
  if (url === null && !warnedPins.has(`preview:${text}`)) {
    warnedPins.add(`preview:${text}`);
    console.warn("[share] SOVA_SHARE_PREVIEW_URL ignored: it must be like https://*.example.com (one wildcard label, no path). Preview links use the Public links setting instead.");
  }
  return url;
}
