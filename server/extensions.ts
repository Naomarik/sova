import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { STATUS_CODES } from "node:http";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import type { Context } from "hono";
import { proxy } from "hono/proxy";
import { getMimeType } from "hono/utils/mime";
import { WebSocket, WebSocketServer } from "ws";
import type { ExtensionInfo } from "../shared/protocol";
import { stateRoot } from "./state-root";

// The generic extension host (ext-contract-v1.1). An extension is a static UI (`dist`) plus a
// loopback HTTP backend (`api`), both named in a manifest the user installs; Sova never writes it.
// Sova serves the UI at /ext/<id>/, proxies /ext/<id>/api/* and /ext/<id>/ws/* to the backend,
// and lists the extensions (with a cached health probe) at GET /api/extensions. Sova knows
// nothing about what any extension does.

export interface ExtensionEntry {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  /** Absolute directory holding index.html. */
  dist: string;
  /** http(s)://127.0.0.1|localhost:<port>[/prefix], no trailing slash. */
  api: string;
}

export const EXTENSION_ID_RE = /^[A-Za-z0-9._-]+$/;
/** An icon name becomes a `url(/icons/<name>.svg)` in a style attribute: nothing but a plain name. */
const ICON_RE = /^[a-z0-9-]+$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

/** The manifest: SOVA_EXTENSIONS_FILE (a test instance's own file), else `<state root>/extensions.json`.
    Read per call, like every state path. */
export const extensionsFile = (): string => process.env.SOVA_EXTENSIONS_FILE || join(stateRoot(), "extensions.json");

// Each distinct complaint is logged once per process: the manifest is re-read per request, and a
// bad entry would otherwise log on every poll of the welcome screen.
const logged = new Set<string>();
function warnOnce(message: string): void {
  if (logged.has(message)) return;
  logged.add(message);
  console.warn(`[extensions] ${message}`);
}

/** `api` → its URL when it is an allowed backend address, else the reason it isn't. */
function checkApi(api: unknown): string | null {
  if (typeof api !== "string") return "api is not a string";
  let url: URL;
  try {
    url = new URL(api);
  } catch {
    return "api is not a URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "api must be http(s)";
  if (!LOOPBACK_HOSTS.has(url.hostname)) return "api must be 127.0.0.1 or localhost";
  if (!url.port) return "api must name its port";
  if (url.username || url.password || url.search || url.hash) return "api must be scheme, host, port and an optional path";
  if (api.endsWith("/")) return "api must not end with a slash";
  return null;
}

/** One manifest record → an entry, or the reason it is dropped. Unknown keys are ignored. */
export function validateExtension(raw: unknown): { entry: ExtensionEntry } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "entry is not an object" };
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !EXTENSION_ID_RE.test(r.id) || r.id === "." || r.id === "..") {
    return { error: `bad id ${JSON.stringify(r.id)}` };
  }
  if (typeof r.dist !== "string" || !isAbsolute(r.dist)) return { error: `${r.id}: dist must be an absolute path` };
  const apiError = checkApi(r.api);
  if (apiError) return { error: `${r.id}: ${apiError}` };
  const entry: ExtensionEntry = {
    id: r.id,
    title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : r.id,
    dist: resolve(r.dist),
    api: r.api as string,
  };
  if (typeof r.description === "string" && r.description.trim()) entry.description = r.description.trim();
  if (typeof r.icon === "string" && ICON_RE.test(r.icon)) entry.icon = r.icon;
  return { entry };
}

/** The valid entries, in manifest order. A missing file is no extensions; a malformed one is too,
    logged. A later duplicate of an id is dropped. */
export function readExtensions(): ExtensionEntry[] {
  const file = extensionsFile();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") warnOnce(`${file}: ${(err as Error).message}`);
    return [];
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    warnOnce(`${file}: not JSON (${(err as Error).message})`);
    return [];
  }
  const d = doc as { version?: unknown; extensions?: unknown } | null;
  if (!d || d.version !== 1 || !Array.isArray(d.extensions)) {
    warnOnce(`${file}: expected {"version": 1, "extensions": [...]}`);
    return [];
  }
  const out: ExtensionEntry[] = [];
  const seen = new Set<string>();
  for (const raw of d.extensions) {
    const v = validateExtension(raw);
    if ("error" in v) {
      warnOnce(`${file}: dropped an entry: ${v.error}`);
      continue;
    }
    if (seen.has(v.entry.id)) {
      warnOnce(`${file}: dropped a second entry with id ${v.entry.id}`);
      continue;
    }
    seen.add(v.entry.id);
    out.push(v.entry);
  }
  return out;
}

export const findExtension = (id: string): ExtensionEntry | undefined => readExtensions().find((e) => e.id === id);

// ---- Health (GET /api/extensions) -------------------------------------------------------------

const HEALTH_TIMEOUT_MS = 1500;
const HEALTH_TTL_MS = 10_000;
type Health = Pick<ExtensionInfo, "status" | "error">;
/** Keyed by id AND api, so an edited manifest never shows the old backend's answer. */
const healthCache = new Map<string, { at: number; health: Promise<Health> }>();

/** A fetch failure in the words the card shows. */
function whyDown(err: unknown): string {
  const e = err as { name?: string; code?: string; cause?: { code?: string; message?: string }; message?: string };
  if (e.name === "TimeoutError" || e.name === "AbortError") return `no answer in ${HEALTH_TIMEOUT_MS / 1000} s`;
  const code = e.cause?.code ?? e.code; // fetch wraps the socket error; ws hands it over as is
  if (code === "ECONNREFUSED") return "connection refused";
  return code ?? e.cause?.message ?? e.message ?? String(err);
}

async function probe(entry: ExtensionEntry): Promise<Health> {
  try {
    const res = await fetch(`${entry.api}/api/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    await res.body?.cancel();
    return res.ok ? { status: "ok" } : { status: "down", error: `health check answered HTTP ${res.status}` };
  } catch (err) {
    return { status: "down", error: whyDown(err) };
  }
}

function health(entry: ExtensionEntry): Promise<Health> {
  const key = `${entry.id}\n${entry.api}`;
  const hit = healthCache.get(key);
  if (hit && Date.now() - hit.at < HEALTH_TTL_MS) return hit.health;
  const fresh = { at: Date.now(), health: probe(entry) };
  healthCache.set(key, fresh);
  return fresh.health;
}

/** For tests: forget every cached health answer. */
export const clearHealthCache = (): void => healthCache.clear();

export async function listExtensions(): Promise<ExtensionInfo[]> {
  return Promise.all(
    readExtensions().map(async (e) => {
      const info: ExtensionInfo = { id: e.id, title: e.title, ...(await health(e)) };
      if (e.description) info.description = e.description;
      if (e.icon) info.icon = e.icon;
      return info;
    }),
  );
}

// ---- Static UI (GET /ext/<id>/...) ------------------------------------------------------------

/**
 * `rest` is the raw (still percent-encoded) path after `/ext/<id>/`. A file under `dist` is served
 * as is; a path whose last segment has no dot is a client-side route and gets index.html; anything
 * else missing, or reaching outside `dist`, is a 404.
 */
export function serveExtensionFile(entry: ExtensionEntry, rest: string): Response {
  let segments: string[];
  try {
    segments = rest.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (segments.some((s) => s === ".." || s.includes("/") || s.includes("\\") || s.includes("\0"))) {
    return new Response("Not found", { status: 404 });
  }
  const root = entry.dist;
  const indexHtml = join(root, "index.html");
  let file = segments.length ? join(root, ...segments) : indexHtml;
  if (file !== root && !file.startsWith(root + sep)) return new Response("Not found", { status: 404 });
  const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
  if (!isFile(file)) {
    const last = segments.at(-1) ?? "";
    if (last.includes(".")) return new Response("Not found", { status: 404 });
    file = indexHtml;
  }
  if (!isFile(file)) return new Response(`Extension "${entry.id}" has no index.html in ${root}`, { status: 404 });
  const type = getMimeType(file) ?? "application/octet-stream";
  const headers: Record<string, string> = { "Content-Type": type };
  if (type.startsWith("text/html")) headers["Cache-Control"] = "no-cache";
  return new Response(readFileSync(file), { headers });
}

// ---- HTTP proxy (ANY /ext/<id>/api/...) -------------------------------------------------------

/** The port this server listens on, for X-Sova-Origin; set once the listener is up. */
let sovaPort = Number(process.env.PORT) || 4800;
export const setSovaPort = (port: number): void => {
  sovaPort = port;
};
export const sovaOrigin = (): string => `http://127.0.0.1:${sovaPort}`;

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

/**
 * Forward the request to `<api><tail><search>`, where `tail` is `/api/...` (the path after
 * `/ext/<id>`, still encoded). Every request header goes along except `host` (fetch sets the
 * backend's) and the hop-by-hop ones; the response comes back as the backend sent it. A backend
 * that can't be reached is a 502. Node's fetch gives up connecting after 10 s; there is no read
 * timeout of ours, so a streamed body runs as long as the backend keeps it open.
 */
export async function proxyExtension(c: Context, entry: ExtensionEntry, tail: string): Promise<Response> {
  const incoming = new URL(c.req.url);
  const headers = new Headers(c.req.raw.headers);
  const host = headers.get("host");
  headers.delete("host");
  for (const h of HOP_BY_HOP) headers.delete(h);
  if (host) headers.set("X-Forwarded-Host", host);
  headers.set("X-Sova-Origin", sovaOrigin());
  try {
    return await proxy(`${entry.api}${tail}${incoming.search}`, { raw: c.req.raw, headers });
  } catch (err) {
    console.warn(`[extensions] ${entry.id}: ${c.req.method} ${tail} failed: ${whyDown(err)}`);
    return c.json({ error: "extension down", id: entry.id }, 502);
  }
}

// ---- WS proxy (GET /ext/<id>/ws/... with Upgrade) ---------------------------------------------

const EXT_WS_RE = /^\/ext\/([^/]+)(\/ws(?:\/.*)?)$/;

/** `/ext/<id>/ws/...` → [id, `/ws/...`], else null. */
export function extensionSocketRoute(pathname: string): [string, string] | null {
  const m = EXT_WS_RE.exec(pathname);
  return m ? [m[1]!, m[2]!] : null;
}

/** The backend's WS URL: the api URL (prefix kept) with ws/wss for http/https, plus the tail. */
export const extensionSocketUrl = (entry: ExtensionEntry, tail: string, search: string): string =>
  `${entry.api.replace(/^http/, "ws")}${tail}${search}`;

/** Answer a not-yet-upgraded socket with a plain HTTP error and close it. */
function refuse(socket: Duplex, status: number, body: object): void {
  if (socket.destroyed) return;
  const json = JSON.stringify(body);
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(json)}\r\nConnection: close\r\n\r\n${json}`,
  );
}

// The subprotocol the backend picked, handed to the client-side handshake.
const chosenProtocol = new WeakMap<IncomingMessage, string>();
const extWss = new WebSocketServer({
  noServer: true,
  handleProtocols: (_protocols, req) => chosenProtocol.get(req) || false,
});

/** Close `to` the way `from` closed: same code and reason; a closure with no code or no close
    frame (1005, 1006) is reproduced as one. */
function mirrorClose(to: WebSocket, code: number, reason: Buffer): void {
  if (to.readyState === WebSocket.CLOSED || to.readyState === WebSocket.CLOSING) return;
  if (code === 1006) to.terminate();
  else if (code === 1005) to.close();
  else to.close(code, reason);
}

/**
 * Dial the backend first; only once it has accepted is the browser's socket upgraded, so a
 * backend that is down answers the browser with a 502 and no WebSocket ever opens. Frames pass
 * both ways untouched (text stays text, binary stays binary).
 */
export function upgradeExtensionSocket(req: IncomingMessage, socket: Duplex, head: Buffer, id: string, tail: string, search: string): void {
  const entry = findExtension(id);
  if (!entry) {
    refuse(socket, 404, { error: "Unknown extension" });
    return;
  }
  const protocols = String(req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const headers: Record<string, string> = { "X-Sova-Origin": sovaOrigin() };
  if (req.headers.host) headers["X-Forwarded-Host"] = req.headers.host;
  const upstream = new WebSocket(extensionSocketUrl(entry, tail, search), protocols, { headers, handshakeTimeout: 10_000 });
  let upgraded = false;
  // The browser went away while we were still dialing.
  const onSocketClose = () => {
    if (!upgraded) upstream.terminate();
  };
  socket.once("close", onSocketClose);
  socket.on("error", () => {}); // a reset during the dial; the close handler cleans up

  // What the backend sends or does between its open and the browser's handshake completing.
  const early: Array<[Buffer, boolean]> = [];
  let earlyClose: [number, Buffer] | null = null;
  let client: WebSocket | null = null;
  upstream.on("message", (data: Buffer, isBinary: boolean) => {
    if (client) client.send(data, { binary: isBinary });
    else early.push([data, isBinary]);
  });
  upstream.on("close", (code: number, reason: Buffer) => {
    if (client) mirrorClose(client, code, reason);
    else earlyClose = [code, reason];
  });
  upstream.on("error", (err) => {
    if (!upgraded) {
      console.warn(`[extensions] ${id}: ws ${tail} failed: ${whyDown(err)}`);
      refuse(socket, 502, { error: "extension down", id });
    }
  });
  upstream.once("open", () => {
    if (socket.destroyed) {
      upstream.terminate();
      return;
    }
    upgraded = true;
    socket.off("close", onSocketClose);
    if (upstream.protocol) chosenProtocol.set(req, upstream.protocol);
    extWss.handleUpgrade(req, socket, head, (ws) => {
      client = ws;
      for (const [data, isBinary] of early.splice(0)) ws.send(data, { binary: isBinary });
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      });
      ws.on("close", (code, reason) => mirrorClose(upstream, code, reason));
      ws.on("error", () => {});
      if (earlyClose) mirrorClose(ws, ...earlyClose);
    });
  });
}
