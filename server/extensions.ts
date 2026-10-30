import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { STATUS_CODES } from "node:http";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import type { Context } from "hono";
import { proxy } from "hono/proxy";
import { getMimeType } from "hono/utils/mime";
import { WebSocket } from "ws";
import { cappedWebSocket, cappedWebSocketServer, connectionRefused, errorCode } from "./runtime-quirks";
import type { ExtensionInfo, ExtensionOffers } from "../shared/protocol";
import { offersOf } from "../shared/extension-offers";
import { extCommandsFrom, type ExtCommandEntry } from "../shared/commands-ext";
import { stateRoot } from "./state-root";
import { viewOffersOf } from "./extension-views";
import { isExtensionKey, sovaToken } from "./auth";

// The generic extension host (ext-contract-v1.17: v1.15 plus each backend's own key, server/extension-keys.ts, and a command's optional `menu` key, src/lib/menu-place.ts, v1.16; card types and drawing kinds in chat transcripts, server/extension-views.ts, v1.17). An extension is a static UI (`dist`) plus a
// loopback HTTP backend (`api`), both named in a manifest the user installs; Sova never writes it.
// Sova serves the UI at /ext/<id>/, proxies /ext/<id>/api/* and /ext/<id>/ws/* to the backend,
// and lists the extensions (with a cached health probe, and what each declares it offers) at
// GET /api/extensions. Sova knows nothing about what any extension does.

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

/** Where each backend's key is written (server/extension-keys.ts), and the file of their hashes:
    never served as an extension's file. */
export const extensionKeyDir = (): string => join(stateRoot(), "extension-keys");
export const extensionKeyHashFile = (): string => join(stateRoot(), "extension-key-hashes.json");

// Each distinct complaint is logged once per process: the manifest is re-read per request, and a
// bad entry would otherwise log on every poll of the overview.
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

/** One manifest record → an entry, or the reason it is dropped. Unknown keys are ignored. `offers`
    is what its `commands` and `screens` validly declare (shared/extension-offers.ts), absent when
    nothing; it is kept apart from the entry, which is also what the mesh publishes to peers, so
    only this host's own list ever carries it. */
export function validateExtension(raw: unknown): { entry: ExtensionEntry; offers?: ExtensionOffers } | { error: string } {
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
  // A bad `commands` or `screens` leaves out only what is bad, never the entry.
  const { offers: base, dropped } = offersOf(r.id, r);
  // Its card types and drawing kinds (v1.17), each checked on its own against its dist.
  const views = viewOffersOf(entry, r);
  for (const why of [...dropped, ...views.dropped]) warnOnce(`${r.id}: left out ${why}`);
  const offers = base || views.offers.cards || views.offers.drawings ? { ...(base ?? {}), ...views.offers } : null;
  return offers ? { entry, offers } : { entry };
}

/** The valid entries, in manifest order. A missing file is no extensions; a malformed one is too,
    logged. A later duplicate of an id is dropped. */
export const readExtensions = (): ExtensionEntry[] => readManifest().map((m) => m.entry);

/**
 * Every installed extension's own catalogue entries (`ext.<id>.<name>`, §app.served-commands/route),
 * in manifest order: for each entry this server keeps, exactly the commands its `offers` names, built
 * whole (params included) by the same rule that made the offers. Reads the manifest, probes nothing.
 */
export function installedExtensionCommands(): ExtCommandEntry[] {
  const out: ExtCommandEntry[] = [];
  for (const { entry, offers, commands } of readManifest()) {
    if (!offers?.commands) continue;
    const named = new Set(offers.commands.map((c) => c.name));
    for (const c of extCommandsFrom(entry.id, commands)) if (named.has(c.id.slice(`ext.${entry.id}.`.length))) out.push(c);
  }
  return out;
}

/** Every installed entry with what it offers (its card types and drawing kinds among them): a chat's snapshot reads it. */
export const readExtensionsWithOffers = (): Array<{ entry: ExtensionEntry; offers?: ExtensionOffers }> => readManifest().map(({ entry, offers }) => (offers ? { entry, offers } : { entry }));

/** readExtensions, each entry with what it offers (and its raw `commands`, for the full entries). */
function readManifest(): Array<{ entry: ExtensionEntry; offers?: ExtensionOffers; commands?: unknown }> {
  return manifestEntries() ?? [];
}

/**
 * The ids the keys follow (server/extension-keys.ts): the installed ids, `[]` when there is no
 * manifest, and null when there is one that can't be read whole (unreadable, not JSON, not
 * `{version: 1, extensions: [...]}`, a write caught half-done), so a bad save never revokes a key.
 */
export function installedIdsForKeys(): string[] | null {
  return manifestEntries()?.map((m) => m.entry.id) ?? null;
}

/** The manifest's valid entries; [] when it is missing, null when it is there but unreadable. */
function manifestEntries(): Array<{ entry: ExtensionEntry; offers?: ExtensionOffers; commands?: unknown }> | null {
  const file = extensionsFile();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    warnOnce(`${file}: ${(err as Error).message}`);
    return null;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    warnOnce(`${file}: not JSON (${(err as Error).message})`);
    return null;
  }
  const d = doc as { version?: unknown; extensions?: unknown } | null;
  if (!d || d.version !== 1 || !Array.isArray(d.extensions)) {
    warnOnce(`${file}: expected {"version": 1, "extensions": [...]}`);
    return null;
  }
  const out: Array<{ entry: ExtensionEntry; offers?: ExtensionOffers; commands?: unknown }> = [];
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
    out.push({ ...v, commands: (raw as { commands?: unknown }).commands });
  }
  return out;
}

/**
 * A peer host's extension (server/sync/extensions.ts), listed here only while the mesh syncs
 * extensions, and ONLY listed: never served, probed or proxied. Its `dist` and `api` are paths and
 * ports on the peer; here the same dist could be any directory ("/") and the same port any local
 * service, so serving one would hand a peer this host's files and loopback. To use it here, the
 * user installs it in this host's own manifest (which then wins its id).
 */
export interface PeerExtensionEntry {
  entry: ExtensionEntry;
  /** Its dist is a directory on this host too (shown in the reason, never acted on). */
  installed: boolean;
}
let peerExtensions: (() => PeerExtensionEntry[]) | null = null;
/** Set by server/sync while extensions sync is on; null (the default) = this host's manifest alone. */
export const setPeerExtensions = (fn: (() => PeerExtensionEntry[]) | null): void => {
  peerExtensions = fn;
};

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
  if (connectionRefused(err)) return "connection refused";
  return errorCode(err) ?? e.cause?.message ?? e.message ?? String(err);
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
  const local = await Promise.all(
    readManifest().map(async ({ entry: e, offers }) => {
      const info: ExtensionInfo = { id: e.id, title: e.title, ...(await health(e)) };
      if (e.description) info.description = e.description;
      if (e.icon) info.icon = e.icon;
      if (offers) info.offers = offers;
      return info;
    }),
  );
  if (!peerExtensions) return local;
  const peers = peerExtensions().map(({ entry: e, installed }) => {
    const info: ExtensionInfo = {
      id: e.id,
      title: e.title,
      status: "down",
      error: installed ? "on another host; add it to this host's extensions.json to use it here" : "not installed on this host",
    };
    if (e.description) info.description = e.description;
    if (e.icon) info.icon = e.icon;
    return info;
  });
  return [...local, ...peers];
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
  if (isKeyFile(file)) return new Response("Not found", { status: 404 });
  const type = getMimeType(file) ?? "application/octet-stream";
  const headers: Record<string, string> = { "Content-Type": type };
  if (type.startsWith("text/html")) headers["Cache-Control"] = "no-cache";
  return new Response(readFileSync(file), { headers });
}

/** Whether `file`, once links are followed (symbolic or hard), is a backend's key or the file of their hashes
    (§app.extensions/backend-key): a `dist` that holds them, or links to them, never serves them. */
export function isKeyFile(file: string): boolean {
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    return true; // it was a file a moment ago: unsure is not served
  }
  const real0 = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const dir = real0(extensionKeyDir());
  if (real === real0(extensionKeyHashFile()) || real.startsWith(dir + sep)) return true;
  // A hard link to a key under another name: only a file with more than one link is compared.
  try {
    const st = statSync(real);
    if (st.nlink < 2) return false;
    for (const name of readdirSync(dir)) {
      const k = statSync(join(dir, name), { throwIfNoEntry: false });
      if (k && k.ino === st.ino && k.dev === st.dev) return true;
    }
  } catch {
    // no key folder: nothing to link to
  }
  return false;
}

// ---- HTTP proxy (ANY /ext/<id>/api/...) -------------------------------------------------------

/** The port this server listens on, for X-Sova-Origin; set once the listener is up. */
let sovaPort = Number(process.env.PORT) || 4800;
export const setSovaPort = (port: number): void => {
  sovaPort = port;
};
export const sovaOrigin = (): string => `http://127.0.0.1:${sovaPort}`;

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

/** Every install's auth cookie is `sova_token_<id>`; a browser sends them all to any port. */
const AUTH_COOKIE_RE = /^sova_token(_|$)/;

/**
 * Drop Sova's own credentials from headers bound for an extension backend: every install's auth
 * cookie (other cookies stay), `x-sova-token`, and an `Authorization` that carries this install's
 * token or any extension's key (an extension's own Authorization passes). A backend is a separate
 * program; one that calls Sova back sends its own key (docs/customization.md). An extension's key
 * rides in x-sova-token, so it is dropped with it.
 */
export function stripSovaCredentials(headers: Headers): void {
  headers.delete("x-sova-token");
  headers.delete("x-sova-caller"); // a chat's key (§app.command-audit/keys) never reaches a backend
  const authorization = headers.get("authorization");
  // The token, or any extension's key (§app.extensions/backend-key): one backend never gets another's.
  if (authorization !== null && (authorization.includes(sovaToken()) || authorization.split(/[\s,]+/).some(isExtensionKey))) headers.delete("authorization");
  const cookie = headers.get("cookie");
  if (cookie === null) return;
  const kept = cookie
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p && !AUTH_COOKIE_RE.test(p.split("=")[0]!.trim()));
  if (kept.length) headers.set("cookie", kept.join("; "));
  else headers.delete("cookie");
}

/**
 * Forward the request to `<api><tail><search>`, where `tail` is `/api/...` (the path after
 * `/ext/<id>`, still encoded). Every request header goes along except `host` (fetch sets the
 * backend's), the hop-by-hop ones and Sova's own credential (stripSovaCredentials); the response
 * comes back as the backend sent it. A backend
 * that can't be reached is a 502. Node's fetch gives up connecting after 10 s; there is no read
 * timeout of ours, so a streamed body runs as long as the backend keeps it open.
 */
export async function proxyExtension(c: Context, entry: ExtensionEntry, tail: string): Promise<Response> {
  const incoming = new URL(c.req.url);
  const headers = new Headers(c.req.raw.headers);
  const host = headers.get("host");
  headers.delete("host");
  for (const h of HOP_BY_HOP) headers.delete(h);
  stripSovaCredentials(headers);
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
export function refuse(socket: Duplex, status: number, body: object): void {
  if (socket.destroyed) return;
  const json = JSON.stringify(body);
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(json)}\r\nConnection: close\r\n\r\n${json}`,
  );
}

// The subprotocol the backend picked, handed to the client-side handshake.
const chosenProtocol = new WeakMap<IncomingMessage, string>();
const extWss = cappedWebSocketServer({
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
  const headers: Record<string, string> = { "X-Sova-Origin": sovaOrigin() };
  if (req.headers.host) headers["X-Forwarded-Host"] = req.headers.host;
  proxySocket(req, socket, head, extensionSocketUrl(entry, tail, search), headers, {
    onError: (err) => {
      console.warn(`[extensions] ${id}: ws ${tail} failed: ${whyDown(err)}`);
      return [502, { error: "extension down", id }];
    },
  });
}

export interface ProxySocketOptions {
  /** The dial failed (no answer, handshake timeout, a non-101 answer when `onResponse` is absent)
      → the HTTP status and JSON body the browser is refused with. */
  onError: (err: Error) => [number, object];
  /** The upstream answered the handshake with a non-101 response → the refusal; without it such
      an answer is an error like any other. */
  onResponse?: (res: IncomingMessage) => [number, object];
  /** How long the upstream may take to accept, default 10 s. */
  handshakeTimeout?: number;
  /** Aborting it before the upstream has accepted fails the dial (onError); after, it is ignored. */
  signal?: AbortSignal;
  /** The upstream accepted. */
  onOpen?: () => void;
  /** How the upstream socket is made, when not by dialing `url` (a dial-out pairing's stream). */
  dial?: (url: string, protocols: string[], opts: { headers: Record<string, string>; handshakeTimeout: number }) => WebSocket;
}

/**
 * The transparent WS proxy under the extension host and the mesh (server/mesh/proxy.ts): dial
 * `url` first, with the browser's subprotocols; only once the upstream has accepted is the
 * browser's socket upgraded, so an upstream that is down or refuses answers the browser with a
 * plain HTTP error and no WebSocket ever opens. Frames pass both ways untouched (text stays text,
 * binary stays binary) and each side is closed the way the other closed (mirrorClose).
 */
export function proxySocket(req: IncomingMessage, socket: Duplex, head: Buffer, url: string, headers: Record<string, string>, opts: ProxySocketOptions): void {
  const protocols = String(req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const dialOpts = { headers, handshakeTimeout: opts.handshakeTimeout ?? 10_000 };
  const upstream = opts.dial ? opts.dial(url, protocols, dialOpts) : cappedWebSocket(url, protocols, dialOpts);
  let upgraded = false;
  let refused = false;
  const refuseOnce = ([status, body]: [number, object]) => {
    if (refused) return;
    refused = true;
    refuse(socket, status, body);
  };
  // The browser went away while we were still dialing.
  const onSocketClose = () => {
    if (!upgraded) upstream.terminate();
  };
  socket.once("close", onSocketClose);
  socket.on("error", () => {}); // a reset during the dial; the close handler cleans up

  // What the upstream sends or does between its open and the browser's handshake completing.
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
    if (!upgraded && !refused) refuseOnce(opts.onError(err));
  });
  if (opts.onResponse) {
    const onResponse = opts.onResponse;
    upstream.on("unexpected-response", (_request, res) => {
      refuseOnce(onResponse(res));
      res.resume();
      upstream.terminate();
    });
  }
  opts.signal?.addEventListener("abort", () => {
    if (!upgraded) upstream.terminate();
  });
  upstream.once("open", () => {
    opts.onOpen?.();
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
