import { request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { PREVIEW_HEADER, PREVIEW_LIMITS } from "../../shared/public-links";
import { REFUSED_HEADER } from "../mesh/hello";
import { offlineResponse, offlineUpgrade } from "./offline";
import { isNavigation, previewAnswer } from "./preview-pages";

/**
 * A gateway's hop for a preview another host minted (§mesh.public/routing, kind `p`): the request
 * goes to that host's ingress at the verified literal address the router chose, with the gateway's
 * own forwarding headers and `x-sova-preview: <label>` set after the strip. Unlike a share hop, the
 * answer passes as the minting host sent it (redirects, its 502 not-running page and cookies
 * included), minus hop-by-hop and `x-sova-*` headers, and a websocket is tunneled raw, so the app's
 * subprotocols and frames pass untouched. A host that can't be reached, refuses the gateway or sends
 * no headers in time is the offline 503 (§mesh.public/offline). A hop is tried once.
 */

export interface PreviewHopTarget {
  address: string;
  port: number;
  /** The request headers already stripped and set by the router (Host included). */
  headers: Record<string, string | string[]>;
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

/** The routed host's answer headers as the visitor gets them, flat for writeHead. */
function passPreview(raw: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const k = raw[i]!.toLowerCase();
    if (HOP_BY_HOP.has(k) || k.startsWith("x-sova-")) continue;
    out.push(raw[i]!, raw[i + 1] ?? "");
  }
  return out;
}

/** The hop's headers: the router's, and the preview's label (set last, never the client's). */
export function previewHopHeaders(base: Record<string, string | string[]>, label: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(base)) if (!k.toLowerCase().startsWith("x-sova-")) out[k] = v;
  out[PREVIEW_HEADER] = label;
  return out;
}

export interface HopHandle {
  /** End it now (a revoke, a lost route, dispose). */
  kill: () => void;
}

/** One HTTP request through the hop. `done` runs once whatever happens. */
export function previewHttpHop(req: IncomingMessage, res: ServerResponse, target: PreviewHopTarget, done: () => void, opts: { headersMs?: number; bodyMax?: number } = {}): HopHandle {
  const headersMs = opts.headersMs ?? PREVIEW_LIMITS.headersMs + 5000;
  const bodyMax = opts.bodyMax ?? PREVIEW_LIMITS.bodyMaxBytes;
  const offline = () => offlineResponse(res, isNavigation(req) ? "page" : "asset");
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    done();
  };
  const declared = Number(req.headers["content-length"]);
  const up = request({ host: target.address, port: target.port, method: req.method, path: req.url, headers: target.headers });
  if (Number.isFinite(declared) && declared > bodyMax) {
    up.destroy();
    previewAnswer(req, res, "tooLarge");
    finish();
    return { kill: () => {} };
  }
  const timer = setTimeout(() => {
    up.destroy();
    if (!res.headersSent) offline();
    else res.destroy();
    finish();
  }, headersMs);
  up.on("error", () => {
    if (!res.headersSent) offline();
    else res.destroy();
    finish();
  });
  up.on("response", (r) => {
    clearTimeout(timer);
    const status = r.statusCode ?? 502;
    if (status === 403 && r.headers[REFUSED_HEADER.toLowerCase()] === "refused") {
      r.resume();
      offline();
      return finish();
    }
    res.writeHead(status, r.statusMessage, passPreview(r.rawHeaders));
    r.on("error", () => res.destroy());
    r.pipe(res);
  });
  res.on("close", () => {
    if (!res.writableFinished) up.destroy();
    finish();
  });
  let seen = 0;
  req.on("data", (chunk: Buffer) => {
    seen += chunk.length;
    if (seen > bodyMax) {
      up.destroy();
      if (!res.headersSent) previewAnswer(req, res, "tooLarge");
      else res.destroy();
      finish();
    }
  });
  req.pipe(up);
  return {
    kill: () => {
      up.destroy();
      res.destroy();
      finish();
    },
  };
}

const HEAD_MAX = 64 * 1024;

/** Write a raw HTTP/1.1 upgrade request head. */
export function upgradeHead(req: IncomingMessage, headers: Record<string, string | string[]> | IncomingHttpHeaders): string {
  const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`, "Connection: Upgrade", `Upgrade: ${String(req.headers.upgrade ?? "websocket")}`];
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

/** One websocket (any upgrade) through the hop, tunneled raw once the host answered. */
export function previewUpgradeHop(req: IncomingMessage, socket: Duplex, head: Buffer, target: PreviewHopTarget, done: () => void, opts: { headersMs?: number } = {}): HopHandle {
  const headersMs = opts.headersMs ?? PREVIEW_LIMITS.headersMs + 5000;
  let up: Socket | null = null;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    up?.destroy();
    socket.destroy();
    done();
  };
  const timer = setTimeout(() => {
    offlineUpgrade(socket);
    finish();
  }, headersMs);
  socket.on("error", finish);
  socket.on("close", finish);
  up = connect({ host: target.address, port: target.port });
  up.on("error", () => {
    if (!accepted) offlineUpgrade(socket);
    finish();
  });
  up.on("close", finish);
  let accepted = false;
  up.once("connect", () => {
    up!.write(upgradeHead(req, target.headers));
    if (head.length) up!.write(head);
  });
  let buf = Buffer.alloc(0);
  const onHead = (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) {
      if (buf.length > HEAD_MAX) finish();
      return;
    }
    up!.off("data", onHead);
    clearTimeout(timer);
    const text = buf.subarray(0, end).toString("latin1");
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] ?? 0);
    const refused = status === 403 && new RegExp(`\\r\\n${REFUSED_HEADER}:\\s*refused`, "i").test(text);
    if (refused || status === 0) {
      offlineUpgrade(socket);
      return finish();
    }
    accepted = true;
    socket.write(buf);
    up!.pipe(socket);
    socket.pipe(up!);
  };
  up.on("data", onHead);
  return { kill: finish };
}
