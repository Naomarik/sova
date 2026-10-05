import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync, closeSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { hostname as osHostname, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { agentRoot } from "./state-root";
import type { Context } from "hono";
import { consumeCode, mintCode } from "./auth-devices";
import { isDirectLocal } from "./compression";
import { DEFAULT_SERVE_PORT } from "./mesh/front-door";
import { localRequest } from "./mesh/proxy";

// The main listener's gate (§app.access/token, §app.access/gate): one per-install token, carried
// as the install's cookie or an x-sova-token header, plus a Host rule and a cross-site rule that
// hold even when the token is valid. A call with no socket (app.request: the Overseer, the
// schedule keeper, tests) and a call on the peer listener (c.env.meshPeer, already answered by
// Tailscale identity) are never asked.

/** The header a non-browser caller (the link extension's tools, scripts) sends the token in. */
export const TOKEN_HEADER = "x-sova-token";

/** On every main-listener response, refusals and the static shell included: the preview proxy
    refuses any answer carrying an x-sova-* header, so no preview can front a Sova port. */
export const SERVER_HEADER = "X-Sova-Server";

/** The token file: `<agent dir>/sova/auth-token`. Deleting it and restarting revokes every browser. */
export const tokenFile = (): string => join(agentRoot(), "sova", "auth-token");

/** Per install, so two Sovas on one host name (4800 beside a hermetic 4810: cookies ignore
    ports) never overwrite each other's cookie. Derived from the agent dir, not the token. */
export const AUTH_COOKIE = `sova_token_${createHash("sha256").update(resolve(agentRoot())).digest("hex").slice(0, 8)}`;

const COOKIE_MAX_AGE = 365 * 24 * 60 * 60;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,}$/;

// SOVA_TOKEN pins the token for a test rig; read once here and taken out of the environment so
// no runtime, tool or child process this server starts inherits it.
const pinned = process.env.SOVA_TOKEN?.trim() || null;
delete process.env.SOVA_TOKEN;

let cached: { file: string; token: string | null; problem: string | null } | null = null;
class DamagedTokenError extends Error {}

function readToken(file: string): string | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  // Fail closed: a damaged file is never silently replaced (that would be a rotation nobody asked for).
  if (!TOKEN_RE.test(text)) throw new DamagedTokenError(`${file} does not hold a Sova token: delete it and restart to mint a new one`);
  try {
    if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
  } catch {
    // best effort: the content is what counts
  }
  return text;
}

/** First creation is exclusive: the token is written to a private temp file and hard-linked into
    place, which fails if the file exists, so a concurrent start's mint wins and both re-read it. A
    reader never sees a half-written file. Where links aren't supported or are refused (EPERM,
    ENOTSUP, EXDEV, or EACCES as on Android), an O_EXCL create instead: still exclusive, and a
    directory that truly denies writes fails it too, so the mint still fails closed. */
let link: (src: string, dest: string) => void = linkSync;
/** Tests stand in for the hard link (a refusing filesystem); null restores linkSync. */
export function setLinkForTest(fn: ((src: string, dest: string) => void) | null): void {
  link = fn ?? linkSync;
}

function mint(file: string): string {
  mkdirSync(dirname(file), { recursive: true });
  const token = randomBytes(32).toString("base64url");
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${token}\n`, { mode: 0o600, flag: "wx" });
    link(tmp, file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES" && code !== "ENOTSUP" && code !== "EXDEV") throw err;
    if (code !== "EEXIST") {
      try {
        const fd = openSync(file, "wx", 0o600);
        try {
          writeSync(fd, `${token}\n`);
        } finally {
          closeSync(fd);
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  const won = readToken(file);
  if (!won) throw new Error(`${file}: the token vanished while it was minted`);
  return won;
}

/** Initialize before listening. A damaged file leaves the shell reachable, but no credential
    can match: remember and log its problem once, never mint over it or retry on each request. */
export function initAuthToken(): { token: string | null; problem: string | null } {
  if (pinned) return { token: pinned, problem: null };
  const file = tokenFile();
  if (cached?.file === file) return cached;
  try {
    cached = { file, token: readToken(file) ?? mint(file), problem: null };
  } catch (err) {
    if (!(err instanceof DamagedTokenError)) throw err;
    cached = { file, token: null, problem: err.message };
    console.error(`[auth] ${err.message}`);
  }
  return cached;
}

/** This install's token for trusted callers that need the credential itself. Never hand them
    a placeholder when the file is damaged; startup and the gate use initAuthToken instead. */
export function sovaToken(): string {
  const state = initAuthToken();
  if (state.token === null) throw new Error(state.problem!);
  return state.token;
}

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

function tokenMatches(candidate: string): boolean {
  const token = initAuthToken().token;
  return token !== null && timingSafeEqual(digest(candidate), digest(token));
}

// ---- where this server is bound, and the names it answers to ----------------------------------

const boundHost = (): string => (process.env.HOST || "127.0.0.1").toLowerCase().replace(/^\[|\]$/g, "");
const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const isLoopbackName = (h: string): boolean => LOOPBACK_NAMES.has(h);
const isWildcardBind = (h: string): boolean => h === "0.0.0.0" || h === "::";
const loopbackBind = (): boolean => {
  const h = boundHost();
  return isLoopbackName(h) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
};

/** Whether the token is asked for at all. SOVA_AUTH=off turns it off for a test rig, and only on
    a loopback bind: an exposed server always asks. The Host and cross-site rules hold either way. */
export function serverAuthEnabled(): boolean {
  return !(process.env.SOVA_AUTH === "off" && loopbackBind());
}

/** What the mesh knows of this host's names: its own MagicDNS name, its own URLs (the front door,
    its serve URL) and the peers' serve URLs. */
export interface AuthNames {
  magicDns?: string | null | undefined;
  own?: Array<string | null | undefined>;
  peers?: Array<string | null | undefined>;
}
type NameSource = () => AuthNames;
let nameSource: NameSource = () => ({});

/** Read per request, so a mesh coming up or a peers.json edit counts at once. */
export function setAuthHosts(source: NameSource): void {
  nameSource = source;
}

function meshNames(): AuthNames {
  try {
    return nameSource();
  } catch {
    return {}; // a source that fails names nothing
  }
}

let listenPort = Number(process.env.PORT) || 4800;
/** The port this process listens on (known for certain only once it is bound: PORT=0 in tests). */
export function setAuthPort(port: number): void {
  listenPort = port;
}

/** `name`, `name:port`, `[v6]:port` or a URL → the bare lower-case host name, or null. */
function hostnameOf(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  try {
    const url = new URL(v.includes("://") ? v : `http://${v}`);
    return url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

let lanCache: { at: number; names: Set<string> } | null = null;
function lanAddresses(): Set<string> {
  if (lanCache && Date.now() - lanCache.at < 30_000) return lanCache.names;
  const names = new Set<string>();
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) names.add(a.address.toLowerCase().replace(/%.*$/, ""));
  lanCache = { at: Date.now(), names };
  return names;
}

function extraHosts(): Set<string> {
  const names = new Set<string>();
  for (const v of (process.env.SOVA_ALLOWED_HOSTS ?? "").split(/[\s,]+/)) {
    const h = v && hostnameOf(v);
    if (h) names.add(h);
  }
  const known = meshNames();
  for (const v of [known.magicDns, ...(known.own ?? [])]) {
    const h = v && hostnameOf(v);
    if (h) names.add(h);
  }
  return names;
}

/** A host name this app is reachable at: loopback names on any port, a MagicDNS (ts.net) name, this machine's hostname,
    the bound address (every interface's address on a wildcard bind), the registered names and
    SOVA_ALLOWED_HOSTS. A name that merely resolves here is not one. */
export function hostAllowed(name: string): boolean {
  if (isLoopbackName(name) || isTailnetName(name)) return true;
  const self = osHostname().toLowerCase();
  if (name === self || name === self.split(".")[0]) return true;
  const bound = boundHost();
  if (name === bound && !isWildcardBind(bound)) return true;
  if (isWildcardBind(bound) && lanAddresses().has(name)) return true;
  return extraHosts().has(name);
}

/** A MagicDNS name (`*.ts.net`), which only Tailscale resolves: `tailscale serve` in front of this
    app can name it in Host or the guarded forwarded Host, even with no mesh (no peers.json). */
function isTailnetName(name: string): boolean {
  return name.toLowerCase().replace(/\.$/, "").endsWith(".ts.net");
}

// ---- the decision ---------------------------------------------------------------------------

/** What the gate reads of a request, from Hono or a raw upgrade alike. */
interface Asked {
  method: string;
  path: string;
  header: (name: string) => string | undefined;
}

/** Never asked for the token: the static shell and its assets (GET/HEAD outside the app's
    dynamic families), the health check and the unlock route itself. */
const DYNAMIC = /^\/(?:api|ext|peer|explain|design|ws)(?:\/|$)/;
const isShell = (a: Asked): boolean => (a.method === "GET" || a.method === "HEAD") && !DYNAMIC.test(a.path);
const tokenExempt = (a: Asked): boolean =>
  isShell(a) || ((a.method === "GET" || a.method === "HEAD") && a.path === "/api/health") || (a.method === "POST" && a.path === "/api/auth/unlock");

function cookieValues(header: string | undefined, name: string): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    let v = part.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out.push(v);
  }
  return out;
}

/** Whether the request presents the token: the header, or any of the install's cookies (a page
    on another port of the same host can plant a second one beside the real one). */
function presentsToken(a: Asked): boolean {
  const header = a.header(TOKEN_HEADER);
  if (header && tokenMatches(header.trim())) return true;
  let hit = false;
  for (const v of cookieValues(a.header("cookie"), AUTH_COOKIE)) if (tokenMatches(v)) hit = true;
  return hit;
}

/** `scheme://host[:port]` exactly as a browser sends it in Origin, or null. */
function originOf(value: string): string | null {
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The origins a page of this app is served from: exact scheme, host and port, except for the
    mesh's own MagicDNS name and the guarded forwarded ts.net name below. Loopback names and this
    machine's hostname use this process's port (as do its addresses on a wildcard bind); the front
    door, this host's and each peer's serve URL, and SOVA_ALLOWED_ORIGINS are exact origins. */
export function originAllowed(origin: string, host?: string, guardedForwardedHost?: string): boolean {
  const o = originOf(origin);
  if (!o) return false; // "null" (a sandboxed page, a file://) and anything unparsable
  // Only the guarded loopback forward may ignore ports. tailscale serve may omit or rewrite
  // the forwarded port; a ts.net name resolves to this node alone, so any port on that name is
  // still this app, just as for the mesh-known MagicDNS name. HTTPS and the normalized name
  // must match; neither another node's name nor HTTP gains admission through this exception.
  const forwardedName = guardedForwardedHost && hostnameOf(guardedForwardedHost);
  if (forwardedName && isTailnetName(forwardedName) && o.startsWith("https://") && hostnameOf(o) === forwardedName) return true;
  // A direct ts.net Host still needs its exact https origin, including the port.
  const own = host ? originOf(`https://${host.trim()}`) : null;
  if (own && o === own && isTailnetName(hostnameOf(own) ?? "")) return true;
  const known = meshNames();
  const magic = known.magicDns && hostnameOf(known.magicDns);
  if (magic && hostnameOf(o) === magic) return true;
  const at = (scheme: string, host: string) => `${scheme}://${host.includes(":") ? `[${host}]` : host}:${listenPort}`;
  const listed: Array<string | null | undefined> = [];
  for (const h of ["127.0.0.1", "localhost", "::1"]) listed.push(at("http", h), at("https", h));
  listed.push(at("http", osHostname().toLowerCase()));
  const bound = boundHost();
  if (isWildcardBind(bound)) for (const addr of lanAddresses()) listed.push(at("http", addr));
  else if (!isLoopbackName(bound)) listed.push(at("http", bound));
  listed.push(...(known.own ?? []), ...(known.peers ?? []), ...(process.env.SOVA_ALLOWED_ORIGINS ?? "").split(/[\s,]+/));
  return listed.some((v) => !!v && originOf(v) === o);
}

/** The real Host was allowed first. tailscale serve may rewrite it to this listener's loopback
    address: only there, on this process's port, use an allowed forwarded host for the origin
    check. A page cannot forge X-Forwarded-Host on a simple cross-origin request: no-cors drops
    non-safelisted headers, and a CORS preflight is never answered with permission here. This
    changes no token check and never admits a foreign real Host. */
function forwardedOriginHost(a: Asked): string | undefined {
  const host = a.header("host");
  const forwarded = a.header("x-forwarded-host");
  if (!host || !forwarded) return undefined;
  // A Host is one authority, not a URL, a credentials field or a list of proxy hops.
  const authority = /^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::[0-9]+)?$/i;
  const loopback = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::([0-9]+))?$/i.exec(host);
  if (!loopback || Number(loopback[1] || 80) !== listenPort || !authority.test(forwarded)) return undefined;
  const name = hostnameOf(forwarded);
  return name && hostAllowed(name) ? forwarded : undefined;
}

/** Another site acting through the person's browser: an Origin outside the allowed set, or fetch
    metadata saying same-site (a page on another port of this host) or cross-site without one. No
    Origin and no such metadata is a caller that isn't a browser page, or a same-origin read. */
function crossSite(a: Asked): boolean {
  const origin = a.header("origin");
  if (origin !== undefined) return !originAllowed(origin, a.header("host"), forwardedOriginHost(a));
  const site = a.header("sec-fetch-site");
  return site === "same-site" || site === "cross-site";
}

/** A browser opening a page (a link, a typed URL), not a script fetching one. */
const isNavigation = (a: Asked): boolean => a.header("sec-fetch-mode") === "navigate" || a.header("sec-fetch-dest") === "document";

/** null: answer it; 401: no token; 403: a host or caller refused whatever it carries. */
function verdict(a: Asked, opts: { exempt: boolean }): 401 | 403 | null {
  const host = a.header("host");
  const name = host ? hostnameOf(host) : null;
  if (!host || !name || !hostAllowed(name)) return 403;
  if (crossSite(a)) {
    // A link from another site may open the shell, which holds no data and shows the unlock
    // screen; nothing else is reachable that way.
    return opts.exempt && isShell(a) && isNavigation(a) ? null : 403;
  }
  if (opts.exempt && tokenExempt(a)) return null;
  if (!serverAuthEnabled()) return null;
  return presentsToken(a) ? null : 401;
}

const REFUSALS = {
  401: { error: "Unauthorized - reload the page to unlock", locked: true, hint: "This Sova needs its token: reload the page to unlock it (`sova token` prints it)." },
  403: { error: "Forbidden" },
} as const;

function refusal(status: 401 | 403) {
  if (status === 403) return REFUSALS[403];
  const problem = initAuthToken().problem;
  return problem ? { error: problem, locked: true, hint: problem } : REFUSALS[401];
}

/** The install's cookie on an answer that earns it, as it rides from then on. */
const setAuthCookie = (c: Context, token: string): void => {
  const secure = servedOverHttps(c) ? "; Secure" : "";
  c.header("Set-Cookie", `${AUTH_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}${secure}`);
  c.header("Cache-Control", "no-store");
};

/** "A browser on this machine is not asked": the request a person makes by opening the app's own
    address at the keyboard. The socket is loopback and carries NO proxy header at all
    (isDirectLocal) — the proxy headers are what separate this machine's browser from the tailnet,
    which reaches this listener through loopback via `tailscale serve` — the Host names this
    process's own port, and the fetch metadata is the browser's own navigation: `Sec-Fetch-Mode:
    navigate` with `Sec-Fetch-Site` either `same-origin` (a link inside the app) or `none` (a
    typed address or a bookmark, which is how a person usually arrives). The Sec-Fetch headers are
    forbidden to fetch and forms, so a page cannot forge them. `none` grants nothing more: a write
    still can't ride it in, because the cookie is SameSite=Strict and the silent path only ever
    hands the cookie to the browser that just navigated here — never answers a fetch for one.
    Everything else — a proxy-headered request, a cross-site or same-site one, a socket upgrade, a
    curl with no metadata — keeps the rules above, token included. */
function silentLocal(a: Asked, incoming: unknown): boolean {
  if (a.method !== "GET" && a.method !== "HEAD") return false;
  const site = a.header("sec-fetch-site");
  if ((site !== "same-origin" && site !== "none") || a.header("sec-fetch-mode") !== "navigate") return false;
  const port = /:(\d+)$/.exec(a.header("host") ?? "")?.[1];
  if (Number(port ?? 80) !== listenPort) return false;
  return isDirectLocal(incoming as IncomingMessage);
}

/** The gate for a main-listener request: null to answer it, else the refusal to send. A call with
    no socket (app.request) or from the peer listener (c.env.meshPeer) is never asked. */
export function authGate(c: Context): Response | null {
  const env = c.env as { incoming?: unknown; meshPeer?: unknown } | undefined;
  if (!env?.incoming || env.meshPeer) return null;
  const a: Asked = { method: c.req.method, path: new URL(c.req.url).pathname, header: (n: string) => c.req.header(n) };
  const status = verdict(a, { exempt: true });
  // A browser on this machine opening the app's own address is answered — and handed the install's
  // cookie — instead of meeting the unlock screen (silentLocal says why it's only the person at
  // the keyboard). A foreign host or cross-site request (a 403) never earns it, and a damaged
  // token file stays the recovery refusal below.
  if (status !== 403 && silentLocal(a, env.incoming)) {
    const token = initAuthToken().token;
    if (token) {
      setAuthCookie(c, token);
      return null;
    }
  }
  if (!status) return null;
  return new Response(JSON.stringify(refusal(status)), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", [SERVER_HEADER]: "sova" },
  });
}

function upgradeStatus(req: IncomingMessage): 401 | 403 | null {
  const header = (n: string): string | undefined => {
    const v = req.headers[n];
    return Array.isArray(v) ? v.join(n === "cookie" ? "; " : ", ") : v;
  };
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  return verdict({ method: "GET", path, header }, { exempt: false });
}

/** A WebSocket upgrade on the main listener: the token plus the same Host and Origin rules. For
    attachWebSockets only; the peer listener's own upgrades never come here. */
export function upgradeAllowed(req: IncomingMessage): boolean {
  return upgradeStatus(req) === null;
}

/** Refuse an upgrade the gate refused, with its status (attachWebSockets). False when allowed. */
export function refuseUpgrade(req: IncomingMessage, socket: Duplex): boolean {
  const status = upgradeStatus(req);
  if (!status) return false;
  if (!socket.destroyed) {
    const json = JSON.stringify(refusal(status));
    socket.end(
      `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Forbidden"}\r\nContent-Type: application/json\r\n${SERVER_HEADER}: sova\r\n` +
        `Content-Length: ${Buffer.byteLength(json)}\r\nConnection: close\r\n\r\n${json}`,
    );
  }
  return true;
}

/** Whether the browser reached this request over https, judged from the socket and the real Host
    only (never X-Forwarded-Proto): a TLS socket, or a default-port Host that is a ts.net name
    (tailscale serve) or the host of a registered https URL (the front door, a serve URL). */
function servedOverHttps(c: Context): boolean {
  if ((c.env as { incoming?: { socket?: { encrypted?: boolean } } } | undefined)?.incoming?.socket?.encrypted) return true;
  let url: URL;
  try {
    url = new URL(`http://${c.req.header("host") ?? ""}`);
  } catch {
    return false;
  }
  if (url.port && url.port !== "443") return false;
  const name = url.hostname.toLowerCase().replace(/\.$/, "");
  if (name.endsWith(".ts.net")) return true;
  return (meshNames().own ?? []).some((v) => !!v && v.trim().toLowerCase().startsWith("https://") && hostnameOf(v) === name);
}

/** POST /api/auth/unlock {token} or {code}: either credential sets the same cookie. The gate
    has already checked Host and the cross-site rule. Neither credential is ever echoed. */
export async function unlock(c: Context): Promise<Response> {
  let body: { token?: unknown; code?: unknown } | null;
  try {
    body = await c.req.json();
  } catch {
    body = null;
  }
  // A damaged install token cannot be recovered by spending a code.
  const token = initAuthToken().token;
  const authorized = token !== null && (
    (typeof body?.token === "string" && tokenMatches(body.token.trim())) ||
    (typeof body?.code === "string" && consumeCode(body.code))
  );
  if (!authorized) return c.json(refusal(401), 401);
  setAuthCookie(c, token);
  return c.json({ ok: true });
}

/** Pair at an origin, never at a literal IP. Loopback still has its honest local-only link. */
function pairOrigin(value: string, local = false): URL | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    const name = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(name)) {
      if (!local || !isLoopbackName(name)) return null;
      url.hostname = "localhost";
    }
    return new URL(url.origin);
  } catch {
    return null;
  }
}

/** Gated, local-only credential routes. Peer identity is not the owner's browser credential. */
export function pair(c: Context): Response {
  c.header("Cache-Control", "no-store");
  if (!localRequest(c)) return c.json({ error: "Forbidden" }, 403);
  const host = c.req.header("host");
  if (!host) return c.json({ error: "Forbidden" }, 403);
  const { code, expiresAt } = mintCode();
  const known = meshNames();
  const serve = pairOrigin(known.own?.[0] ?? "");
  const dns = hostnameOf(known.magicDns ?? "");
  const tailnet = serve?.protocol === "https:" ? serve :
    dns && !isIP(dns) && !isLoopbackName(dns) ? pairOrigin(`https://${dns}:${DEFAULT_SERVE_PORT}`) : null;
  const links: Array<{ label: string; url: string }> = [];
  const add = (origin: URL | null, label: string) => {
    if (!origin) return;
    origin.hash = `c=${code}`;
    const url = origin.href;
    if (!links.some((link) => link.url === url)) links.push({ label, url });
  };
  add(tailnet, "Phone · Tailscale");
  // A browser's Origin retains HTTPS on a non-default serve port. Forwarded headers
  // alone never determine a pairing address, and the real Host remains its authority.
  const browserOrigin = c.req.header("origin");
  const https = servedOverHttps(c) || browserOrigin === `https://${host}` ||
    (serve?.protocol === "https:" && serve.host === host);
  const own = pairOrigin(`${https ? "https" : "http"}://${host}`, true);
  add(own, own?.hostname === "localhost" ? "This machine only" : "This address");
  return c.json({ code, expiresAt, links });
}

/** Deliberate recovery only: never log the credential, and never let a cache retain it. */
export function revealToken(c: Context): Response {
  c.header("Cache-Control", "no-store");
  if (!localRequest(c)) return c.json({ error: "Forbidden" }, 403);
  return c.json({ token: sovaToken() });
}
