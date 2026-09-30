import { request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { PREVIEW_LIMITS } from "../../shared/public-links";
import { keptPreview } from "../preview-kept";
import { findPreview, findPreviewByHash, onPreviewEnded, type PreviewRecord, previewState } from "../preview-links";
import { staticServes } from "../preview-serve";
import { previewAnswer, previewUpgradeAnswer } from "./preview-pages";

/**
 * The minting host's reverse proxy for its own previews (§mesh.public/preview-proxy): the one place
 * a preview's request reaches the app, always at 127.0.0.1:<port>, else [::1]:<port>, never any
 * other address. It makes the app see a browser on this computer (Host, Origin and Referer on
 * localhost, no forwarding header at all) and the visitor see the app at the root of its preview
 * origin (Location, Access-Control-Allow-Origin, Set-Cookie's Domain, Cache-Control and a default
 * Referrer-Policy), and it never reads or rewrites a body: both directions stream. A websocket is
 * passed through byte for byte once the app answered the upgrade.
 *
 * The record is judged on every request (unknown 404, off or expired 410), and open connections
 * are cut when their preview is turned off (onPreviewEnded) or found expired by the sweep.
 */

// ---- the header transforms ------------------------------------------------------------------------

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade", "expect"]);
/** Never sent to the app: forwarding, identity and Sova's own headers (any case). */
const FORWARDING = /^(forwarded|x-forwarded-.*|x-real-ip|cf-.*|true-client-ip|tailscale-.*|x-sova-.*|cdn-loop)$/;

const connectionNamed = (v: string | string[] | undefined): Set<string> =>
  new Set(
    (Array.isArray(v) ? v : [v ?? ""])
      .flatMap((x) => x.split(","))
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );

const localOrigin = (port: number) => `http://localhost:${port}`;

/** The request headers the app gets: a browser on this computer's, with the preview's origin
    swapped for localhost in Origin and Referer, and nothing forwarded. */
export function appRequestHeaders(headers: IncomingHttpHeaders, port: number, publicOrigin: string): Record<string, string | string[]> {
  const named = connectionNamed(headers.connection);
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const k = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(k) || named.has(k) || FORWARDING.test(k) || k === "host") continue;
    out[k] = Array.isArray(value) ? [...value] : value;
  }
  out.host = `localhost:${port}`;
  if (typeof out.origin === "string" && out.origin.toLowerCase() === publicOrigin) out.origin = localOrigin(port);
  if (typeof out.referer === "string" && (out.referer === publicOrigin || out.referer.startsWith(`${publicOrigin}/`) || out.referer.startsWith(`${publicOrigin}?`)))
    out.referer = localOrigin(port) + out.referer.slice(publicOrigin.length);
  return out;
}

/** `http(s)://localhost|127.0.0.1|[::1]:<port>` at the start of a URL (no port for 80/443 too). */
function localPrefix(port: number): RegExp {
  const p = port === 80 || port === 443 ? `(?::${port})?` : `:${port}`;
  return new RegExp(`^https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])${p}(?=$|[/?#])`, "i");
}

/** Cache-Control as the visitor gets it: never cacheable by a shared cache. */
export function privateCacheControl(value: string | undefined): string {
  const parts = (value ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d && !/^public$/i.test(d) && !/^s-maxage\s*=/i.test(d) && !/^proxy-revalidate$/i.test(d));
  if (!parts.some((d) => /^(private|no-store)(\s*=.*)?$/i.test(d))) parts.unshift("private");
  return parts.join(", ");
}

/** Set-Cookie without its Domain attribute, so it stays on the preview's own host. */
export function hostOnlyCookie(value: string): string {
  const [first, ...attrs] = value.split(";");
  return [first, ...attrs.filter((a) => !/^\s*domain\s*=/i.test(a))].join(";");
}

/** The response headers the visitor gets, as a flat [name, value, …] list for writeHead; null
    when the answer carries an x-sova-* header (a Sova port: never passed on). */
export function visitorResponseHeaders(raw: string[], port: number, publicOrigin: string): string[] | null {
  const named = new Set<string>();
  for (let i = 0; i < raw.length; i += 2) if (raw[i]!.toLowerCase() === "connection") for (const t of connectionNamed(raw[i + 1])) named.add(t);
  const local = localPrefix(port);
  const out: string[] = [];
  let cache: string | undefined;
  let referrer = false;
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i]!;
    let value = raw[i + 1] ?? "";
    const k = name.toLowerCase();
    if (k.startsWith("x-sova-")) return null;
    if (HOP_BY_HOP.has(k) || named.has(k)) continue;
    if (k === "cache-control") {
      cache = cache === undefined ? value : `${cache}, ${value}`;
      continue;
    }
    if (k === "location" || k === "content-location" || k === "access-control-allow-origin") value = value.replace(local, publicOrigin);
    else if (k === "set-cookie") value = hostOnlyCookie(value);
    else if (k === "referrer-policy") referrer = true;
    out.push(name, value);
  }
  out.push("Cache-Control", privateCacheControl(cache));
  if (!referrer) out.push("Referrer-Policy", "same-origin");
  return out;
}

// ---- dialing -----------------------------------------------------------------------------------------

const DIAL_MS = 5000;

/** A connected socket to the app: 127.0.0.1 first, then ::1; `refused` when neither listens. */
export function dialLoopback(port: number, hosts: readonly string[] = ["127.0.0.1", "::1"]): Promise<Socket | "refused"> {
  return new Promise((resolve) => {
    const next = (i: number): void => {
      if (i >= hosts.length) return resolve("refused");
      const s = connect({ host: hosts[i]!, port });
      const timer = setTimeout(() => {
        s.destroy();
        next(i + 1);
      }, DIAL_MS);
      s.once("connect", () => {
        clearTimeout(timer);
        s.removeAllListeners("error");
        resolve(s);
      });
      s.once("error", () => {
        clearTimeout(timer);
        s.destroy();
        next(i + 1);
      });
    };
    next(0);
  });
}

// ---- open connections ----------------------------------------------------------------------------------

/** Open HTTP requests and websockets, per preview and across all (§mesh.public/preview-limits). */
export class PreviewSlots {
  private http = new Map<string, number>();
  private ws = new Map<string, number>();
  private totals = { http: 0, ws: 0 };
  constructor(
    private readonly limits: { httpPerPreview: number; wsPerPreview: number; httpTotal: number; wsTotal: number } = PREVIEW_LIMITS,
  ) {}
  /** A release function, or null when a cap is reached. */
  take(key: string, kind: "http" | "ws"): (() => void) | null {
    const map = kind === "http" ? this.http : this.ws;
    const per = kind === "http" ? this.limits.httpPerPreview : this.limits.wsPerPreview;
    const total = kind === "http" ? this.limits.httpTotal : this.limits.wsTotal;
    const n = map.get(key) ?? 0;
    if (n >= per || this.totals[kind] >= total) return null;
    map.set(key, n + 1);
    this.totals[kind]++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const m = (map.get(key) ?? 1) - 1;
      if (m > 0) map.set(key, m);
      else map.delete(key);
      this.totals[kind]--;
    };
  }
  total(kind: "http" | "ws"): number {
    return this.totals[kind];
  }
}

/** Every open connection of a preview, so a turn-off or expiry cuts them at once. */
export class OpenConnections {
  private byKey = new Map<string, Set<() => void>>();
  add(key: string, kill: () => void): () => void {
    let set = this.byKey.get(key);
    if (!set) this.byKey.set(key, (set = new Set()));
    set.add(kill);
    return () => {
      set!.delete(kill);
      if (!set!.size && this.byKey.get(key) === set) this.byKey.delete(key);
    };
  }
  close(key: string): void {
    for (const kill of [...(this.byKey.get(key) ?? [])]) kill();
    this.byKey.delete(key);
  }
  closeWhere(match: (key: string) => boolean): void {
    for (const key of [...this.byKey.keys()]) if (match(key)) this.close(key);
  }
  keys(): string[] {
    return [...this.byKey.keys()];
  }
  count(key: string): number {
    return this.byKey.get(key)?.size ?? 0;
  }
}

/**
 * Whether a preview's port may be dialed now (§mesh.public/preview-serve): a folder preview only while
 * Sova itself serves that folder on it, so another program that took the port is never shown; any other
 * preview always.
 */
export function previewDialable(record: PreviewRecord): boolean {
  if (keptPreview(record.id)?.target.kind !== "static") return true;
  return staticServes().some((s) => s.id === record.id && s.port === record.port);
}

// ---- the proxy -----------------------------------------------------------------------------------------

export interface PreviewProxyOptions {
  /** The record for a label (any state). Default: the store. */
  find?: (label: string) => PreviewRecord | null;
  findByHash?: (hash: string) => PreviewRecord | null;
  /** The preview's public origin, `<scheme>://<label>.<zone>`; null when no preview address is known. */
  origin: (label: string) => string | null;
  /** The loopback addresses to try, in order (tests). */
  hosts?: readonly string[];
  /** Whether a record's port may be dialed now; not: the not-running answer. Default previewDialable. */
  dialable?: (record: PreviewRecord) => boolean;
  headersMs?: number;
  bodyMax?: number;
  slots?: PreviewSlots;
  /** 0: no sweep timer (tests call sweep). */
  sweepMs?: number;
  now?: () => number;
}

export interface PreviewProxy {
  dispatch(req: IncomingMessage, res: ServerResponse, label: string): void;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, label: string): void;
  /** Cut every open connection whose preview is no longer active. */
  sweep(): void;
  /** Open connections of one preview (tests). */
  openCount(hash: string): number;
  dispose(): void;
}

const HEAD_MAX = 64 * 1024;

export function createPreviewProxy(opts: PreviewProxyOptions): PreviewProxy {
  const find = opts.find ?? findPreview;
  const findByHash = opts.findByHash ?? findPreviewByHash;
  const hosts = opts.hosts ?? ["127.0.0.1", "::1"];
  const dialable = opts.dialable ?? previewDialable;
  const headersMs = opts.headersMs ?? PREVIEW_LIMITS.headersMs;
  const bodyMax = opts.bodyMax ?? PREVIEW_LIMITS.bodyMaxBytes;
  const slots = opts.slots ?? new PreviewSlots();
  const now = opts.now ?? Date.now;
  const open = new OpenConnections();
  let disposed = false;

  /** The record when it may be served now; otherwise the answer was written. */
  const judge = (label: string): { record: PreviewRecord; origin: string } | "unknown" | "gone" | "no-origin" => {
    const record = find(label);
    if (!record) return "unknown";
    if (previewState(record, now()) !== "active") return "gone";
    const origin = opts.origin(label);
    return origin ? { record, origin: origin.toLowerCase() } : "no-origin";
  };

  const dispatch = (req: IncomingMessage, res: ServerResponse, label: string): void => {
    if (disposed) return previewAnswer(req, res, "busy");
    const j = judge(label);
    if (j === "unknown") return previewAnswer(req, res, "unknown");
    if (j === "gone") return previewAnswer(req, res, "gone");
    if (j === "no-origin") return previewAnswer(req, res, "busy");
    const { record, origin } = j;
    if (!dialable(record)) return previewAnswer(req, res, "notRunning");
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > bodyMax) return previewAnswer(req, res, "tooLarge");
    const release = slots.take(record.hash, "http");
    if (!release) return previewAnswer(req, res, "busy");
    let up: ReturnType<typeof request> | null = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      release();
      forget();
      clearTimeout(timer);
    };
    const forget = open.add(record.hash, () => {
      up?.destroy();
      req.destroy();
      res.destroy();
      finish();
    });
    const timer = setTimeout(() => {
      up?.destroy();
      previewAnswer(req, res, "slow");
      finish();
    }, headersMs);
    res.on("close", () => {
      if (!res.writableFinished) up?.destroy();
      finish();
    });
    void dialLoopback(record.port, hosts).then((sock) => {
      if (done || res.destroyed) {
        if (sock !== "refused") sock.destroy();
        return;
      }
      if (sock === "refused") {
        previewAnswer(req, res, "notRunning");
        return finish();
      }
      const headers = appRequestHeaders(req.headers, record.port, origin);
      up = request({ method: req.method, path: req.url, headers, createConnection: () => sock });
      up.on("error", () => {
        if (!res.headersSent) previewAnswer(req, res, "notRunning");
        else res.destroy();
        finish();
      });
      up.on("response", (r) => {
        clearTimeout(timer);
        const out = visitorResponseHeaders(r.rawHeaders, record.port, origin);
        if (!out) {
          r.resume();
          up?.destroy();
          previewAnswer(req, res, "notRunning");
          return finish();
        }
        res.writeHead(r.statusCode ?? 502, r.statusMessage, out);
        r.on("error", () => res.destroy());
        r.pipe(res);
      });
      let seen = 0;
      req.on("data", (chunk: Buffer) => {
        seen += chunk.length;
        if (seen > bodyMax) {
          up?.destroy();
          if (!res.headersSent) previewAnswer(req, res, "tooLarge");
          else res.destroy();
          finish();
        }
      });
      req.pipe(up);
    });
  };

  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer, label: string): void => {
    if (disposed) return previewUpgradeAnswer(socket, "busy");
    const j = judge(label);
    if (j === "unknown") return previewUpgradeAnswer(socket, "unknown");
    if (j === "gone") return previewUpgradeAnswer(socket, "gone");
    if (j === "no-origin") return previewUpgradeAnswer(socket, "busy");
    const { record, origin } = j;
    if (!dialable(record)) return previewUpgradeAnswer(socket, "notRunning");
    const release = slots.take(record.hash, "ws");
    if (!release) return previewUpgradeAnswer(socket, "busy");
    let upstream: Socket | null = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      release();
      forget();
      clearTimeout(timer);
      upstream?.destroy();
      socket.destroy();
    };
    const forget = open.add(record.hash, finish);
    const timer = setTimeout(() => {
      if (!socket.destroyed) previewUpgradeAnswer(socket, "slow");
      finish();
    }, headersMs);
    socket.on("error", finish);
    socket.on("close", finish);
    void dialLoopback(record.port, hosts).then((sock) => {
      if (done || socket.destroyed) {
        if (sock !== "refused") sock.destroy();
        return finish();
      }
      if (sock === "refused") {
        previewUpgradeAnswer(socket, "notRunning");
        return finish();
      }
      upstream = sock;
      sock.on("error", finish);
      sock.on("close", finish);
      const headers = appRequestHeaders(req.headers, record.port, origin);
      // An upgrade keeps its own two hop-by-hop headers.
      const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`, "Connection: Upgrade", `Upgrade: ${String(req.headers.upgrade ?? "websocket")}`];
      for (const [k, v] of Object.entries(headers)) for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
      sock.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) sock.write(head);
      // The app's answer head is read whole before anything reaches the visitor (a Sova port is
      // never passed on); after it, bytes flow both ways untouched.
      let buf = Buffer.alloc(0);
      const onHead = (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) {
          if (buf.length > HEAD_MAX) finish();
          return;
        }
        sock.off("data", onHead);
        clearTimeout(timer);
        const headText = buf.subarray(0, end).toString("latin1");
        if (/\r\nx-sova-/i.test(headText)) {
          previewUpgradeAnswer(socket, "notRunning");
          return finish();
        }
        socket.write(buf);
        sock.pipe(socket);
        socket.pipe(sock);
      };
      sock.on("data", onHead);
    });
  };

  const sweep = (): void => {
    const t = now();
    open.closeWhere((hash) => {
      const r = findByHash(hash);
      return !r || previewState(r, t) !== "active";
    });
  };
  const offEnded = onPreviewEnded((hash) => open.close(hash));
  const sweepMs = opts.sweepMs ?? 1000;
  const sweepTimer = sweepMs > 0 ? setInterval(() => (open.keys().length ? sweep() : undefined), sweepMs) : null;
  sweepTimer?.unref();

  return {
    dispatch,
    upgrade,
    sweep,
    openCount: (hash) => open.count(hash),
    dispose() {
      disposed = true;
      offEnded();
      if (sweepTimer) clearInterval(sweepTimer);
      open.closeWhere(() => true);
    },
  };
}
