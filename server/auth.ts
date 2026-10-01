import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync, closeSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { hostname as osHostname, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Context } from "hono";

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
export const tokenFile = (): string => join(getAgentDir(), "sova", "auth-token");

/** Per install, so two Sovas on one host name (4800 beside a hermetic 4810: cookies ignore
    ports) never overwrite each other's cookie. Derived from the agent dir, not the token. */
export const AUTH_COOKIE = `sova_token_${createHash("sha256").update(resolve(getAgentDir())).digest("hex").slice(0, 8)}`;

const COOKIE_MAX_AGE = 365 * 24 * 60 * 60;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,}$/;

// SOVA_TOKEN pins the token for a test rig; read once here and taken out of the environment so
// no runtime, tool or child process this server starts inherits it.
const pinned = process.env.SOVA_TOKEN?.trim() || null;
delete process.env.SOVA_TOKEN;

let cached: { file: string; token: string } | null = null;

function readToken(file: string): string | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  // Fail closed: a damaged file is never silently replaced (that would be a rotation nobody asked for).
  if (!TOKEN_RE.test(text)) throw new Error(`${file} does not hold a Sova token: delete it and restart to mint a new one`);
  try {
    if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
  } catch {
    // best effort: the content is what counts
  }
  return text;
}

/** First creation is exclusive: the token is written to a private temp file and hard-linked into
    place, which fails if the file exists, so a concurrent start's mint wins and both re-read it. A
    reader never sees a half-written file. Where links aren't supported, an O_EXCL create instead. */
function mint(file: string): string {
  mkdirSync(dirname(file), { recursive: true });
  const token = randomBytes(32).toString("base64url");
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${token}\n`, { mode: 0o600, flag: "wx" });
    linkSync(tmp, file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV") throw err;
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

/** This install's token: SOVA_TOKEN if it was set at start, else the token file, minted on the
    first start that finds none. Held for the process's life; the file is never rewritten. */
export function sovaToken(): string {
  if (pinned) return pinned;
  const file = tokenFile();
  if (cached?.file === file) return cached.token;
  const token = readToken(file) ?? mint(file);
  cached = { file, token };
  return token;
}

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

function tokenMatches(candidate: string): boolean {
  return timingSafeEqual(digest(candidate), digest(sovaToken()));
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
    app names it in Host even while the mesh is off and its own name unknown (no peers.json). */
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

/** The origins a page of this app is served from, matched exactly (scheme, host and port), never
    by host alone: the loopback names on this process's port, this machine's hostname on it (and,
    on a wildcard bind, each of its addresses), the mesh's own MagicDNS name on any port, the front
    door, this host's and each peer's serve URL, and SOVA_ALLOWED_ORIGINS. */
export function originAllowed(origin: string, host?: string): boolean {
  const o = originOf(origin);
  if (!o) return false; // "null" (a sandboxed page, a file://) and anything unparsable
  // Through tailscale serve with the mesh off: the page's own https origin, exactly the real Host
  // (name and port), so another tailnet's or a funnel's ts.net page is still another site.
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

/** Another site acting through the person's browser: an Origin outside the allowed set, or fetch
    metadata saying same-site (a page on another port of this host) or cross-site without one. No
    Origin and no such metadata is a caller that isn't a browser page, or a same-origin read. */
function crossSite(a: Asked): boolean {
  const origin = a.header("origin");
  if (origin !== undefined) return !originAllowed(origin, a.header("host"));
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

/** The gate for a main-listener request: null to answer it, else the refusal to send. A call with
    no socket (app.request) or from the peer listener (c.env.meshPeer) is never asked. */
export function authGate(c: Context): Response | null {
  const env = c.env as { incoming?: unknown; meshPeer?: unknown } | undefined;
  if (!env?.incoming || env.meshPeer) return null;
  const status = verdict({ method: c.req.method, path: new URL(c.req.url).pathname, header: (n) => c.req.header(n) }, { exempt: true });
  if (!status) return null;
  return new Response(JSON.stringify(REFUSALS[status]), {
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
    const json = JSON.stringify(REFUSALS[status]);
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

/** POST /api/auth/unlock {token}: the right token sets the cookie, the wrong one is a 401. The
    gate has already checked Host and the cross-site rule. The token is never echoed. */
export async function unlock(c: Context): Promise<Response> {
  let token: unknown;
  try {
    token = ((await c.req.json()) as { token?: unknown } | null)?.token;
  } catch {
    token = undefined;
  }
  if (typeof token !== "string" || !tokenMatches(token.trim())) return c.json(REFUSALS[401], 401);
  const secure = servedOverHttps(c) ? "; Secure" : "";
  c.header("Set-Cookie", `${AUTH_COOKIE}=${token.trim()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}${secure}`);
  c.header("Cache-Control", "no-store");
  return c.json({ ok: true });
}
