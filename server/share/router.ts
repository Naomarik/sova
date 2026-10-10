import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { ASSET_MAX_BYTES, ASSET_NAME_TYPES, ASSET_TYPES, type ShareGatewaySetting } from "../../shared/public-links";
import { FRAME_HOST_NAME, frameHostHeaders } from "../../shared/vis-frame-host";
import { SESSION_SHARE_IMAGE_MAX_BYTES } from "../../shared/session-share";
import { findLink, hashToken } from "../baton-links";
import { meshApi } from "../mesh";
import { REFUSED_HEADER } from "../mesh/hello";
import type { PeerEntry } from "../mesh/peers";
import { notePeerReach, preflight, watchStall } from "../mesh/proxy";
import { findPersonLink } from "../person-links";
import { findShareLink } from "../session-shares";
import { verifiedAddress } from "./destination";
import { hashLabel, previewHashKnown } from "../preview-links";
import { FILE_UPLOAD_TIMEOUT_MS, inProcessShare, UPLOAD_TIMEOUT_MS, type PreviewHooks, type ShareDispatch, type ShareRequestContext, type ShareUpgrade } from "./edge";
import { gatewayPreviewMatch, localPreviewOrigin } from "./preview-address";
import { previewHopHeaders, previewHttpHop, previewUpgradeHop } from "./preview-hop";
import { previewAnswer, previewUpgradeAnswer } from "./preview-pages";
import { createPreviewProxy, type PreviewProxy, PreviewSlots } from "./preview-proxy";
import { offlineKind, offlineResponse, offlineUpgrade } from "./offline";
import { acceptsNode, type GatewayRegistry, gatewayPublicUrl, gatewaySetting, type RegistryHit, shareRegistry } from "./registry";
import { shareDist } from "./share-dist";
import { stripForwarded } from "./security";
import { onPublicLinksChanged } from "./setting-events";
import { createWsHop, WS_HOP_WITHDRAW_GRACE_MS, type WsHop } from "./ws-hop";

/**
 * A gateway's router (§mesh.public/routing): the share listener's `dispatch` and `upgrade`. The
 * edge (server/share/edge.ts) has already judged the path, counted the address and capped the
 * body. Then, by token:
 *
 * 1. a token this host minted (any state: the store answers 410 for a dead one) is served
 *    in-process, as it always was;
 * 2. else, on a gateway, a hash a live, accepted routed host registered for this route's kind is
 *    forwarded to that host's ingress, at a literal tailnet address verified to belong to the
 *    row's StableID (server/share/destination.ts): never a name, nothing from a snapshot but its
 *    port;
 * 3. anything else is in-process too, which answers 404 for an unknown token's API and socket
 *    (and serves the shell, as it always has: the shell never looks at the token). An unknown hash
 *    is never asked of any host.
 *
 * Authorization is judged again after every asynchronous step (address, preflight) and before
 * anything is sent, and for as long as a hop stays open: every open hop, HTTP or WebSocket, is
 * closed once its host no longer holds its hash (the gateway setting gone, the host out of
 * peers.json or acceptFrom, its snapshot withdrawing the row, the row expired), checked on each
 * registry commit, each setting change and every HOP_SWEEP_MS. dispose() closes them all.
 *
 * A hop that can't reach its host, has no verified address, is refused by its gate, gets 502/504
 * or a redirect, or has no response headers in time answers the offline 503
 * (server/share/offline.ts). A hop is tried once: a POST is never retried or replayed. Every hop
 * answer carries no-store, no-referrer and nosniff, and never a cookie. A hashed asset comes from
 * this host's own share build first, else from the live host whose snapshot listed it, streamed
 * with a 5 MB cap and a sandbox CSP; a name several live hosts listed is served only once all of
 * them answered the same bytes (agreedAsset). No hop passes back a header that would act on the
 * whole share origin (a cookie, Service-Worker-Allowed, Clear-Site-Data). This file never binds.
 *
 * Preview hosts (kind `p`, §mesh.public/preview) come through `preview`: a label this host minted
 * goes to its own preview proxy; a hash a live, accepted host registered as `p` is hopped to that
 * host's ingress (server/share/preview-hop.ts) with the same checks, judged again the same way and
 * closed by the same sweep; a hash a live host withdrew is 410; anything else the preview 404.
 */

/** How long a hop waits for the routed host's response headers before it counts as down (504). */
export const HOP_HEADERS_MS = 15_000;
/** How often open hops are checked against the setting and peers.json (a registry commit and a
    setting change check at once). peers.json has no change event, so this bounds a removal. */
export const HOP_SWEEP_MS = 1_000;
/** HTTP hops open at once across the gateway; one more is the offline 503, never dialed. */
export const HTTP_HOPS_TOTAL = 256;

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
/** Never passed back from a hop: the share origin is shared by every routed host (a cookie, a
    worker's widened scope or a wipe of the origin's storage would reach every host's links). */
const DROPPED_RESPONSE = /^(set-cookie|set-cookie2|x-sova-.*|service-worker-allowed|clear-site-data)$/;
/** Stamped on every hop answer, whatever the origin sent (an old or misconfigured one included). */
const SHARE_RESPONSE_HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } as const;
/** On every forwarded asset but the frame host: a script or SVG opened as a page runs nothing on the
    share origin; loaded by the page as a subresource it works as ever. */
export const ASSET_CSP = "sandbox; default-src 'none'";

export interface GatewayRouterOptions {
  /** This host's own share. Default: inProcessShare(). */
  local?: { dispatch: ShareDispatch; upgrade: ShareUpgrade };
  registry?: GatewayRegistry;
  /** This host's gateway setting, or null when it is no gateway. */
  setting?: () => ShareGatewaySetting | null;
  /** The public URL the hop's X-Forwarded-Host comes from. */
  publicUrl?: () => string | null;
  /** peers.json's peers now. */
  peers?: () => PeerEntry[];
  /** The literal address a peer's hop may dial, verified as its StableID's; null refuses. */
  resolve?: (peer: PeerEntry) => Promise<string | null>;
  /** Whether this host minted a token for a route of `kind`. */
  isLocal?: (token: string, kind: TokenKind) => boolean;
  /** Whether this host's own share build has an asset. */
  hasAsset?: (name: string) => boolean;
  /** The hop's request headers before the gateway sets its own (M2's stripForwarded). */
  strip?: (headers: IncomingHttpHeaders) => Record<string, string | string[]>;
  /** Whether to try a host at all (server/mesh/proxy.ts preflight). */
  preflight?: (url: string) => Promise<boolean | "recent">;
  wsHop?: WsHop;
  now?: () => number;
  headersMs?: number;
  assetMaxBytes?: number;
  /** The most bytes a hopped session share image may carry (SESSION_SHARE_IMAGE_MAX_BYTES). */
  imageMaxBytes?: number;
  /** 0: no timer (tests call `sweep`). */
  sweepMs?: number;
  /** How long a `/ws/h` or `/ws/s` hop whose host withdrew its row waits for that host's own close. */
  withdrawGraceMs?: number;
  httpTotal?: number;
  /** This host's own preview proxy. Default: one on the store, at this host's preview address. */
  previewLocal?: PreviewProxy;
  /** Whether this host minted a preview hash. */
  isLocalPreview?: (hash: string) => boolean;
  /** Which preview a request is for (null: the share host). Default: its Host under this gateway's zone. */
  previewMatch?: (req: IncomingMessage) => string | null;
  /** The caps of preview hops (§mesh.public/preview-limits). */
  previewSlots?: PreviewSlots;
  previewHeadersMs?: number;
}

export interface GatewayRouter {
  dispatch: ShareDispatch;
  upgrade: ShareUpgrade;
  /** Preview hosts: the edge's split (§mesh.public/preview-address). */
  preview: PreviewHooks;
  /** Close every open hop whose host no longer holds its hash. */
  sweep: () => void;
  /** Close every open hop, stop the timer and listeners, and route nothing from here on (a
      rebind or shutdown). */
  dispose: () => void;
}

/** The token kinds a route may serve (never `x`). */
type TokenKind = "h" | "i" | "s";
type Route = { kind: TokenKind; token: string } | { kind: "asset"; name: string };
/** Whether a hop's target still stands: `same`, `moved` (the link routes elsewhere now: the
    hop is retried by the page, the offline answer), or `gone` (it routes nowhere: an unknown
    token's answer). */
type Standing = "same" | "moved" | "gone";

const TOKEN = "([A-Za-z0-9_-]{43})";
const H_ROUTE = new RegExp(`^/(?:api/)?h/${TOKEN}(?:/message|/image|/file|/img/(?:0|[1-9][0-9]{0,3}))?$`);
const I_ROUTE = new RegExp(`^/(?:api/)?i/${TOKEN}(?:/[pc]/[a-z]_[a-z2-9]{8})?$`);
const S_ROUTE = new RegExp(`^/(?:api/)?s/${TOKEN}(?:/img/(?:0|[1-9][0-9]{0,4}))?$`);

/** What a judged share path is for: a token of a kind, or a hashed asset. */
export function routeOf(pathname: string): Route | null {
  const asset = /^\/h\/assets\/([A-Za-z0-9_-][A-Za-z0-9._-]*)$/.exec(pathname);
  if (asset) return { kind: "asset", name: asset[1]! };
  const h = H_ROUTE.exec(pathname);
  if (h) return { kind: "h", token: h[1]! };
  const i = I_ROUTE.exec(pathname);
  if (i) return { kind: "i", token: i[1]! };
  const sh = S_ROUTE.exec(pathname);
  if (sh) return { kind: "s", token: sh[1]! };
  return null;
}

/** The content type a hashed asset is served with, by its extension, or by its exact name (the
    frame host); null for any other. */
function assetType(name: string): string | null {
  if (Object.hasOwn(ASSET_NAME_TYPES, name)) return ASSET_NAME_TYPES[name]!;
  const dot = name.lastIndexOf(".");
  if (dot < 1 || name.includes("..")) return null;
  const ext = name.slice(dot + 1);
  return Object.hasOwn(ASSET_TYPES, ext) ? ASSET_TYPES[ext]! : null;
}

const bracket = (host: string): string => (host.includes(":") ? `[${host}]` : host);

/** The response headers passed back from a hop: the origin's, minus hop-by-hop ones, any it names
    in Connection, cookies and internal ones, with the share origin's privacy headers stamped. */
function passBack(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const named = new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && !HOP_BY_HOP.has(k) && !named.has(k) && !DROPPED_RESPONSE.test(k)) out[k] = v;
  return { ...out, ...SHARE_RESPONSE_HEADERS };
}

/** A share socket hop's key: the target it went to (the node, its ingress port and its verified
    address), the token's hash and the socket's kind, so a hop is closed when that node no longer
    holds the hash for that kind at that target, even if the row stays or another host claims it
    later. */
const hopKey = (nodeId: string, h: string, port: number, address: string, kind: "h" | "s"): string => `${nodeId} ${h} ${port} ${address} ${kind}`;

/** Every router not yet disposed, so a shutdown or rebind can close them all. */
const routers = new Set<GatewayRouter>();

/** Dispose every gateway router (the share listener's stop and rebind). */
export function disposeGatewayRouters(): void {
  for (const r of [...routers]) r.dispose();
}

export function createGatewayRouter(opts: GatewayRouterOptions = {}): GatewayRouter {
  const local = opts.local ?? inProcessShare();
  const registry = opts.registry ?? shareRegistry;
  const setting = opts.setting ?? gatewaySetting;
  const publicUrl = opts.publicUrl ?? (() => gatewayPublicUrl());
  // config() re-reads peers.json when it changed on disk (one stat), so a hand edit counts too.
  const peers = opts.peers ?? (() => meshApi.config()?.peers ?? []);
  const resolve = opts.resolve ?? ((peer: PeerEntry) => verifiedAddress(peer, process.env, peers));
  const isLocal = opts.isLocal ?? ((token, kind) => (kind === "h" ? findLink(token) : kind === "i" ? findPersonLink(token) : findShareLink(token)) !== null);
  const hasAsset = opts.hasAsset ?? ((name) => existsSync(join(shareDist(), "assets", name)));
  const strip = opts.strip ?? stripForwarded;
  const reachable = opts.preflight ?? preflight;
  const wsHop = opts.wsHop ?? createWsHop();
  const now = opts.now ?? Date.now;
  const headersMs = opts.headersMs ?? HOP_HEADERS_MS;
  const assetMax = opts.assetMaxBytes ?? ASSET_MAX_BYTES;
  const imageMax = opts.imageMaxBytes ?? SESSION_SHARE_IMAGE_MAX_BYTES;
  const sweepMs = opts.sweepMs ?? HOP_SWEEP_MS;
  const httpTotal = opts.httpTotal ?? HTTP_HOPS_TOTAL;
  const previewLocal = opts.previewLocal ?? createPreviewProxy({ origin: localPreviewOrigin });
  const isLocalPreview = opts.isLocalPreview ?? previewHashKnown;
  const previewSlots = opts.previewSlots ?? new PreviewSlots();
  let disposed = false;

  /** The gateway's view now: its setting, and each live, accepted peer by StableID. */
  const view = (): { g: ShareGatewaySetting; byNode: Map<string, PeerEntry> } | null => {
    if (disposed) return null;
    const g = setting();
    if (!g) return null;
    const byNode = new Map<string, PeerEntry>();
    for (const p of peers()) if (acceptsNode(g, p.nodeId)) byNode.set(p.nodeId, p);
    return { g, byNode };
  };

  /** Whether hash `h` still routes, for `kind`, to `nodeId` at ingress `port`, judged now:
      `same`; `moved` when it routes elsewhere (a newer snapshot kept the row but moved its port,
      or another host holds it now); `gone` when it no longer routes at all. */
  const holds = (nodeId: string, h: string, kind: TokenKind | "p", port: number): Standing => {
    const v = view();
    const hit = v && registry.lookup(h, kind, now(), (n) => v.byNode.has(n));
    return !hit ? "gone" : hit.nodeId === nodeId && hit.ingressPort === port ? "same" : "moved";
  };
  /** The same for a hashed asset's source `nodeId` at `port`. */
  const serves = (nodeId: string, name: string, port: number): Standing => {
    const v = view();
    const sources = v && !hasAsset(name) ? registry.assetSources(name, (n) => v.byNode.has(n)) : [];
    return !sources.length ? "gone" : sources.some((s) => s.nodeId === nodeId && s.ingressPort === port) ? "same" : "moved";
  };
  /** The verified address to dial `nodeId` at now, from its current peers.json entry; null
      refuses. */
  const addressNow = async (nodeId: string): Promise<string | null> => {
    const p = view()?.byNode.get(nodeId);
    return p ? resolve(p).catch(() => null) : null;
  };

  /** The hop's request headers: the client's, stripped, then the gateway's own set. */
  const hopHeaders = (req: IncomingMessage, client: string, host: string, port: number): Record<string, string | string[]> => {
    const url = publicUrl();
    return {
      ...strip(req.headers),
      host: `${bracket(host)}:${port}`,
      "x-forwarded-for": client,
      "x-forwarded-proto": "https",
      ...(url ? { "x-forwarded-host": new URL(url).host } : {}),
    };
  };

  /** Open HTTP hops: their target node and address, what keeps each authorized, how to end it. */
  const active = new Set<{ nodeId: string; address: string; still: () => Standing; kill: () => void }>();
  /** Hops still being prepared (address, preflight): counted against the budget with `active`. */
  let preparing = 0;

  /**
   * One HTTP hop, tried once. `still` is its authorization, the target it was chosen for (node,
   * port) judged after each await, before anything is sent, and for as long as the answer
   * streams; the address is judged again after the preflight. `answer` gets the origin's response
   * when it is one to pass on; every failure before that is the offline 503. A hop whose link no
   * longer routes before it was sent is answered in-process (an unknown token's 404), one whose
   * target moved is the offline 503 (the page retries, and reaches the new one); neither is sent.
   */
  const hop = async (
    req: IncomingMessage,
    res: ServerResponse,
    ctx: ShareRequestContext,
    hit: RegistryHit,
    still: () => Standing,
    answer: (up: IncomingMessage) => void,
  ): Promise<void> => {
    const kind = offlineKind(ctx.url.pathname);
    if (active.size + preparing >= httpTotal) return offlineResponse(res, kind);
    /** After a wait: false when the hop must not go on, having answered it. */
    const stands = (): boolean => {
      const now = still();
      if (now === "same") return true;
      if (now === "gone") void local.dispatch(req, res, ctx);
      else offlineResponse(res, kind);
      return false;
    };
    preparing++;
    let address: string | null;
    let pre: boolean | "recent" = false;
    try {
      address = await addressNow(hit.nodeId);
      if (!stands()) return;
      if (!address || res.destroyed) return offlineResponse(res, kind);
      // The one verified literal serves the preflight and the dial alike.
      pre = await reachable(`http://${bracket(address)}:${hit.ingressPort}`);
      if (!stands()) return;
      // The address is judged again after the wait: a moved one is not what was preflighted.
      const again = await addressNow(hit.nodeId);
      if (!stands()) return;
      if (again !== address) return offlineResponse(res, kind);
    } finally {
      preparing--;
    }
    const base = `http://${bracket(address)}:${hit.ingressPort}`;
    if (pre === false || res.destroyed) return offlineResponse(res, kind);
    const headers = hopHeaders(req, ctx.client, address, hit.ingressPort);
    const up = request({ host: address, port: hit.ingressPort, method: req.method, path: ctx.url.pathname + ctx.url.search, headers });
    let settled = false;
    const fail = () => {
      if (settled) return void res.destroy();
      settled = true;
      up.destroy();
      offlineResponse(res, kind);
    };
    const entry = {
      nodeId: hit.nodeId,
      address,
      still,
      kill: () => {
        settled = true;
        up.destroy();
        res.destroy();
      },
    };
    active.add(entry);
    const answered = pre === "recent" ? watchStall(base, fail) : () => {};
    // The origin answers an upload (a photo's, or a file's, §app.baton/files) only once its whole
    // body is in: that hop waits as long as the edge lets the upload take. Its body was capped at
    // this edge already, at the setting's ceiling: the gateway never knows the origin's setting.
    const upload = req.method === "POST" && /\/image$/.test(ctx.url.pathname);
    const fileUpload = req.method === "POST" && /\/file$/.test(ctx.url.pathname);
    const timer = setTimeout(() => {
      notePeerReach(base, false);
      fail();
    }, upload ? UPLOAD_TIMEOUT_MS + headersMs : fileUpload ? FILE_UPLOAD_TIMEOUT_MS + headersMs : headersMs);
    res.on("close", () => {
      active.delete(entry);
      clearTimeout(timer);
      answered();
      if (!res.writableFinished) up.destroy();
    });
    up.on("error", () => {
      clearTimeout(timer);
      answered();
      if (!settled) notePeerReach(base, false);
      fail();
    });
    up.on("response", (r) => {
      clearTimeout(timer);
      answered();
      notePeerReach(base, true);
      const status = r.statusCode ?? 502;
      const refused = status === 403 && r.headers[REFUSED_HEADER.toLowerCase()] === "refused";
      // A redirect is never followed or passed on: the share origin is every routed host's.
      if (refused || status === 502 || status === 504 || (status >= 300 && status < 400 && status !== 304)) {
        r.resume();
        return fail();
      }
      settled = true;
      r.on("error", () => res.destroy());
      answer(r);
    });
    if (req.method === "POST") req.pipe(up);
    else up.end();
  };

  const forwardAsset = (req: IncomingMessage, res: ServerResponse, ctx: ShareRequestContext, name: string, hit: RegistryHit): Promise<void> => {
    const type = assetType(name)!;
    return hop(req, res, ctx, hit, () => serves(hit.nodeId, name, hit.ingressPort), (up) => {
      if (up.statusCode !== 200) {
        up.resume();
        // A missing asset is the origin's 404; anything else, no source.
        if (up.statusCode === 404) return void res.writeHead(404, { "Content-Type": "application/json", ...SHARE_RESPONSE_HEADERS }).end('{"error":"Not found"}');
        return offlineResponse(res, "asset");
      }
      const declared = Number(up.headers["content-length"]);
      if (Number.isFinite(declared) && declared > assetMax) {
        up.destroy();
        return offlineResponse(res, "asset");
      }
      res.writeHead(200, {
        "Content-Type": type,
        // The frame host carries its own sandbox CSP and SAMEORIGIN, as its origin would send it.
        ...(name === FRAME_HOST_NAME ? frameHostHeaders() : { "Content-Security-Policy": ASSET_CSP }),
        ...SHARE_RESPONSE_HEADERS,
        ...(Number.isFinite(declared) ? { "Content-Length": String(declared) } : {}),
      });
      let seen = 0;
      up.on("data", (chunk: Buffer) => {
        seen += chunk.length;
        if (seen > assetMax) {
          up.destroy();
          res.destroy();
        } else if (!res.write(chunk)) {
          up.pause();
          res.once("drain", () => up.resume());
        }
      });
      up.on("end", () => res.end());
    });
  };

  /** Hashed names more than one live host listed: the SHA-256 every one of those listers answered,
      and which listers (node and port) they were. */
  const agreed = new Map<string, { digest: string; listers: string }>();
  /** What was logged already, so a refused name is logged once per set of listers. */
  const warned = new Set<string>();
  const listersOf = (sources: RegistryHit[]): string => sources.map((s) => `${s.nodeId}:${s.ingressPort}`).sort().join(" ");
  const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

  /** One lister's whole answer for a hashed asset, under the cap, or null: no verified address,
      unreachable, refused, any status but 200, over the cap, or not all in within twice the
      header wait. Nothing of it reaches the visitor until it is judged. */
  const fetchAsset = async (req: IncomingMessage, ctx: ShareRequestContext, name: string, hit: RegistryHit): Promise<Buffer | null> => {
    const address = await addressNow(hit.nodeId);
    if (!address || serves(hit.nodeId, name, hit.ingressPort) !== "same") return null;
    const base = `http://${bracket(address)}:${hit.ingressPort}`;
    if ((await reachable(base)) === false || serves(hit.nodeId, name, hit.ingressPort) !== "same") return null;
    const headers = hopHeaders(req, ctx.client, address, hit.ingressPort);
    // The whole body is wanted: never a range or a conditional answer.
    for (const k of Object.keys(headers)) if (/^(range|if-.*)$/.test(k)) delete headers[k];
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let seen = 0;
      let done = false;
      const up = request({ host: address, port: hit.ingressPort, method: "GET", path: `/h/assets/${name}`, headers });
      const finish = (body: Buffer | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (!body) up.destroy();
        resolve(body);
      };
      const timer = setTimeout(() => {
        notePeerReach(base, false);
        finish(null);
      }, 2 * headersMs);
      up.on("error", () => {
        if (!done) notePeerReach(base, false);
        finish(null);
      });
      up.on("response", (r) => {
        notePeerReach(base, true);
        const declared = Number(r.headers["content-length"]);
        if (r.statusCode !== 200 || (Number.isFinite(declared) && declared > assetMax)) {
          r.resume();
          return finish(null);
        }
        r.on("data", (chunk: Buffer) => {
          seen += chunk.length;
          if (seen > assetMax) finish(null);
          else chunks.push(chunk);
        });
        r.on("end", () => finish(Buffer.concat(chunks)));
        r.on("error", () => finish(null));
      });
      up.end();
    });
  };

  /**
   * A hashed name more than one live host listed (§mesh.public/routing): any of them could claim
   * another build's name, so its bytes are served only once every lister answered the same. The
   * agreed digest is kept per name and set of listers; from then on the first lister whose bytes
   * match it serves them (one lister down is no outage). Until all have answered alike, or while
   * they differ, the asset is the offline 503.
   */
  const agreedAsset = async (req: IncomingMessage, res: ServerResponse, ctx: ShareRequestContext, name: string, sources: RegistryHit[]): Promise<void> => {
    if (active.size + preparing >= httpTotal) return offlineResponse(res, "asset");
    const listers = listersOf(sources);
    const refused = (why: string): void => {
      const key = `${name} ${listers} ${why}`;
      if (!warned.has(key)) {
        warned.add(key);
        console.warn(`[share] asset ${name} not served: ${why} (${sources.map((s) => s.nodeId).join(", ")})`);
      }
      offlineResponse(res, "asset");
    };
    const send = (body: Buffer): void => {
      // The listers are judged again: one that came or went meanwhile was never part of the agreement.
      const v = view();
      const current = v && !hasAsset(name) ? listersOf(registry.assetSources(name, (n) => v.byNode.has(n))) : "";
      if (current !== listers) return offlineResponse(res, "asset");
      if (res.destroyed) return;
      res.writeHead(200, {
        "Content-Type": assetType(name)!,
        "Content-Security-Policy": ASSET_CSP,
        ...SHARE_RESPONSE_HEADERS,
        "Content-Length": String(body.length),
      });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    preparing++;
    try {
      const known = agreed.get(name);
      if (known?.listers === listers) {
        for (const s of sources) {
          const body = await fetchAsset(req, ctx, name, s);
          if (body && sha256(body) === known.digest) return send(body);
        }
        return refused("no lister answered the agreed bytes");
      }
      const bodies = await Promise.all(sources.map((s) => fetchAsset(req, ctx, name, s)));
      if (bodies.some((b) => !b)) return offlineResponse(res, "asset");
      const digests = bodies.map((b) => sha256(b!));
      if (digests.some((d) => d !== digests[0])) return refused("its listers' bytes differ");
      agreed.set(name, { digest: digests[0]!, listers });
      return send(bodies[0]!);
    } finally {
      preparing--;
    }
  };

  const dispatch: ShareDispatch = async (req, res, ctx) => {
    const route = routeOf(ctx.url.pathname);
    const v = route ? view() : null;
    if (!route || !v) return local.dispatch(req, res, ctx);
    const live = (nodeId: string) => v.byNode.has(nodeId);
    if (route.kind === "asset") {
      const name = route.name;
      // Its own build first; a name with no allowed extension never leaves this host; a name no
      // live host listed is this host's own 404.
      if (hasAsset(name) || !assetType(name)) return local.dispatch(req, res, ctx);
      const sources = registry.assetSources(name, live);
      if (!sources.length) return local.dispatch(req, res, ctx);
      // The frame host's name is no hash (each build has its own bytes): it stays the first
      // lister's, under its own sandbox headers.
      if (sources.length === 1 || name === FRAME_HOST_NAME) return forwardAsset(req, res, ctx, name, sources[0]!);
      return agreedAsset(req, res, ctx, name, sources);
    }
    if (isLocal(route.token, route.kind)) return local.dispatch(req, res, ctx);
    const h = hashToken(route.token);
    const kind = route.kind;
    const hit = registry.lookup(h, kind, now(), live);
    if (!hit) return local.dispatch(req, res, ctx);
    // A session share's image, and a gathering's photo (§app.baton/images), are capped here too,
    // counted while streaming (defense in depth: the origin caps it already, but an older or
    // misconfigured one might not).
    const cap = (kind === "s" || kind === "h") && ctx.url.pathname.includes("/img/") ? imageMax : Infinity;
    return hop(req, res, ctx, hit, () => holds(hit.nodeId, h, kind, hit.ingressPort), (up) => {
      const declared = Number(up.headers["content-length"]);
      if (Number.isFinite(declared) && declared > cap) {
        up.destroy();
        return offlineResponse(res, "api");
      }
      res.writeHead(up.statusCode ?? 502, passBack(up.headers));
      if (cap === Infinity) return void up.pipe(res);
      let seen = 0;
      up.on("data", (chunk: Buffer) => {
        seen += chunk.length;
        if (seen > cap) {
          up.destroy();
          res.destroy();
        } else if (!res.write(chunk)) {
          up.pause();
          res.once("drain", () => up.resume());
        }
      });
      up.on("end", () => res.end());
    });
  };

  const upgrade: ShareUpgrade = async (req, socket, head, ctx) => {
    const v = view();
    // The socket's kind comes from its path (/ws/h, /ws/s): a token of another kind never hops.
    const kind = ctx.kind;
    if (!v || isLocal(ctx.token, kind)) return local.upgrade(req, socket, head, ctx);
    const h = hashToken(ctx.token);
    const hit = registry.lookup(h, kind, now(), (nodeId) => v.byNode.has(nodeId));
    if (!hit) return local.upgrade(req, socket, head, ctx);
    const still = () => holds(hit.nodeId, h, kind, hit.ingressPort);
    const address = await addressNow(hit.nodeId);
    const standing = still();
    if (standing === "gone") return local.upgrade(req, socket, head, ctx);
    if (standing === "moved" || !address) return offlineUpgrade(socket);
    // The page's own handshake headers (key, version, extensions) are its socket's with the
    // gateway, never the hop's: the hop's client sets its own.
    const headers: Record<string, string> = {};
    for (const [k, val] of Object.entries(hopHeaders(req, ctx.client, address, hit.ingressPort)))
      if (!/^sec-websocket-/i.test(k)) headers[k] = Array.isArray(val) ? val.join(", ") : val;
    // ws-hop judges the whole target again once the host answered, before it accepts the page:
    // the node and port, and the verified address looked up afresh (a moved address or pin, or a
    // failed lookup, refuses; never a silent redial).
    const authorized = async (): Promise<boolean> => still() === "same" && (await addressNow(hit.nodeId)) === address && still() === "same";
    wsHop.forward(req, socket, head, hopKey(hit.nodeId, h, hit.ingressPort, address, kind), { host: address, port: hit.ingressPort, path: ctx.url.pathname + ctx.url.search, headers }, authorized);
  };

  /** Open preview websocket tunnels, judged by the same sweep as the HTTP hops. */
  const tunnels = new Set<{ nodeId: string; address: string; still: () => Standing; kill: () => void }>();

  /** Where a preview hash goes, or why it doesn't: a live host's row, withdrawn (410), unknown (404). */
  const previewRoute = (h: string): { hit: RegistryHit; still: () => Standing } | "gone" | "unknown" => {
    const v = view();
    const hit = v && registry.lookup(h, "p", now(), (n) => v.byNode.has(n));
    if (!hit) return v && registry.previewWithdrawn(h, now()) ? "gone" : "unknown";
    return { hit, still: () => holds(hit.nodeId, h, "p", hit.ingressPort) };
  };

  /** The verified address for a preview hop, judged after every wait; null: offline. */
  const previewAddressFor = async (hit: RegistryHit, still: () => Standing): Promise<string | null> => {
    const address = await addressNow(hit.nodeId);
    if (still() !== "same" || !address) return null;
    const pre = await reachable(`http://${bracket(address)}:${hit.ingressPort}`);
    if (pre === false || still() !== "same") return null;
    const again = await addressNow(hit.nodeId);
    return again === address && still() === "same" ? address : null;
  };

  const previewDispatch: PreviewHooks["dispatch"] = async (req, res, label, client) => {
    const h = hashLabel(label);
    if (disposed) return previewAnswer(req, res, "busy");
    if (isLocalPreview(h)) return previewLocal.dispatch(req, res, label, client);
    const route = previewRoute(h);
    if (route === "gone") return previewAnswer(req, res, "gone");
    if (route === "unknown") return previewAnswer(req, res, "unknown");
    const release = previewSlots.take(h, "http");
    if (!release) return previewAnswer(req, res, "busy");
    let address: string | null = null;
    try {
      address = await previewAddressFor(route.hit, route.still);
    } catch {
      address = null;
    }
    if (route.still() === "gone") {
      release();
      return previewAnswer(req, res, registry.previewWithdrawn(h, now()) ? "gone" : "unknown");
    }
    if (!address || res.destroyed) {
      release();
      return offlineResponse(res, "page");
    }
    const headers = previewHopHeaders(hopHeaders(req, client, address, route.hit.ingressPort), label);
    const entry = { nodeId: route.hit.nodeId, address, still: route.still, kill: () => {} };
    active.add(entry);
    const handle = previewHttpHop(req, res, { address, port: route.hit.ingressPort, headers }, () => {
      active.delete(entry);
      release();
    }, opts.previewHeadersMs !== undefined ? { headersMs: opts.previewHeadersMs } : {});
    entry.kill = handle.kill;
  };

  const previewUpgrade: PreviewHooks["upgrade"] = async (req, socket, head, label, client) => {
    const h = hashLabel(label);
    if (disposed) return previewUpgradeAnswer(socket, "busy");
    if (isLocalPreview(h)) return previewLocal.upgrade(req, socket, head, label, client);
    const route = previewRoute(h);
    if (route === "gone") return previewUpgradeAnswer(socket, "gone");
    if (route === "unknown") return previewUpgradeAnswer(socket, "unknown");
    const release = previewSlots.take(h, "ws");
    if (!release) return previewUpgradeAnswer(socket, "busy");
    let address: string | null = null;
    try {
      address = await previewAddressFor(route.hit, route.still);
    } catch {
      address = null;
    }
    if (!address || socket.destroyed) {
      release();
      return offlineUpgrade(socket);
    }
    const headers: Record<string, string | string[]> = {};
    for (const [k, val] of Object.entries(previewHopHeaders(hopHeaders(req, client, address, route.hit.ingressPort), label))) headers[k] = val;
    const entry = { nodeId: route.hit.nodeId, address, still: route.still, kill: () => {} };
    tunnels.add(entry);
    const handle = previewUpgradeHop(req, socket, head, { address, port: route.hit.ingressPort, headers }, () => {
      tunnels.delete(entry);
      release();
    }, opts.previewHeadersMs !== undefined ? { headersMs: opts.previewHeadersMs } : {});
    entry.kill = handle.kill;
  };

  /** Cut every open hop whose target's verified address changed (address lookups are async, so
      this runs after the synchronous part of a sweep). */
  const sweepAddresses = async (): Promise<void> => {
    const nodes = new Set<string>([...active, ...tunnels].map((e) => e.nodeId));
    wsHop.closeWhere((key) => {
      nodes.add(key.split(" ")[0]!);
      return false; // only listing the targets here
    });
    if (!nodes.size) return;
    const current = new Map(await Promise.all([...nodes].map(async (n) => [n, await addressNow(n)] as const)));
    for (const entry of [...active, ...tunnels]) if (current.has(entry.nodeId) && current.get(entry.nodeId) !== entry.address) entry.kill();
    wsHop.closeWhere((key) => {
      const [nodeId, , , address] = key.split(" ");
      return current.has(nodeId!) && current.get(nodeId!) !== address;
    });
  };

  const sweep = (): void => {
    for (const entry of [...active, ...tunnels]) if (entry.still() !== "same") entry.kill();
    // A row its own host withdrew (a newer snapshot without it: revoked or expired there) while
    // that host is still live and accepted: its /ws/h and /ws/s hops wait for the host's own close
    // (4410 after a revoke), §mesh.public/withdrawn-hop. Any other lost route closes at once.
    const v = view();
    const withdrawn = new Set<string>();
    wsHop.closeWhere((key) => {
      const [nodeId, h, port, , kind] = key.split(" ");
      const standing = holds(nodeId!, h!, kind === "s" ? "s" : "h", Number(port));
      if (standing === "same") return false;
      if (standing === "gone" && v?.byNode.has(nodeId!)) {
        withdrawn.add(key);
        return false;
      }
      return true;
    });
    if (withdrawn.size) wsHop.drainWhere((key) => withdrawn.has(key), opts.withdrawGraceMs ?? WS_HOP_WITHDRAW_GRACE_MS);
    void sweepAddresses().catch(() => {});
  };
  const unsubscribe = [registry.onChange(sweep), onPublicLinksChanged(() => sweep())];
  const timer = sweepMs > 0 ? setInterval(sweep, sweepMs) : null;
  timer?.unref();

  const router: GatewayRouter = {
    dispatch,
    upgrade,
    preview: { match: opts.previewMatch ?? gatewayPreviewMatch, dispatch: previewDispatch, upgrade: previewUpgrade },
    sweep,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      routers.delete(router);
      if (timer) clearInterval(timer);
      for (const u of unsubscribe) u();
      for (const entry of [...active, ...tunnels]) entry.kill();
      wsHop.dispose();
      previewLocal.dispose();
    },
  };
  routers.add(router);
  return router;
}

/**
 * The share listener's hooks. On a host that is no gateway (or for a token it minted) this is the
 * in-process share, exactly as before. Call once per server: it builds an app, a WebSocket server
 * and a hop pool each time; dispose() it (or disposeGatewayRouters()) when that server stops.
 */
export function gatewayHooks(): GatewayRouter {
  return createGatewayRouter();
}
