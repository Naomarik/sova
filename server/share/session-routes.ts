import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import { SESSION_SHARE_DESIGN_MAX_BYTES, SESSION_SHARE_GONE_CLOSE, SESSION_SHARE_IMAGE_TYPES } from "../../shared/session-share";
import { refuse } from "../extensions";
import { addViewer } from "../session-share-presence";
import { sessionShareDesign, sessionShareImage, sessionShareView, sourceReadable, type ShareSource } from "../session-share-view";
import { designDocumentHeaders, isShareDesignKind } from "../session-share-designs";
import { designCutOf } from "../session-share-design-cuts";
import { findShareLink, shareAccess, type ShareAccess, type ShareLinkRecord, type ShareRecord } from "../session-shares";
import { classify, recordOpen, recordRefused, recordShellFetch, type SessionVisitLink } from "../visits";
import { noteShareVisit } from "../visitor-identity";
import { RateLimiter, type ShareUpgrade } from "./edge";
import { cappedWebSocketServer } from "../runtime-quirks";
import { ensureAssetsCurrent } from "./registry-push";
import { ensureDesignPushes } from "./session-live";

/**
 * The share listener's session share routes (§app/session-share): read-only, no POST.
 *
 * GET /s/<token>               the share build's shell (never looks at the token, except to log a
 *                              known link previewer's fetch)
 * GET /api/s/<token>           -> SessionShareView (`?v=` the tab's visit id, `?before=` a page back)
 * GET /api/s/<token>/img/<n>   -> one image embedded in the shared messages
 * GET /api/s/<token>/d/<label>/<n>/<kind> -> one shown design version's walled document
 * WS  /ws/s?token=&v=          presence (the page's visibility) and view pushes
 *
 * A token that doesn't open answers 404 (unknown) or 410 (dead: only "expired" is ever named). A
 * live link whose session file is gone, or whose cut or start is no longer on it, answers the
 * generic 410.
 */

/** View reads per token per minute (the page reads once, then again on reconnect or Show earlier). */
export const SESSION_VIEW_GETS_PER_MINUTE = 120;
/** Image reads per token per minute. */
export const SESSION_IMAGE_GETS_PER_MINUTE = 240;
/** Design document reads per token per minute (a block's tiles, the full-size view, its versions). */
export const SESSION_DESIGN_GETS_PER_MINUTE = 240;
/** Design document bytes per token per minute: a few full Lookbooks' worth, pictures inlined. */
export const SESSION_DESIGN_BYTES_PER_MINUTE = 256 * 1024 * 1024;

const ROBOTS = { "X-Robots-Tag": "noindex, nofollow" } as const;
/** An image answer runs nothing and embeds nothing, whatever its bytes are. */
const IMAGE_CSP = "default-src 'none'; sandbox";

const refusal = (code: string, message: string, why?: "expired") => ({ error: message, code, ...(why ? { why } : {}) });
const GONE = refusal("gone", "This link is no longer active.");
const EXPIRED = refusal("gone", "This link has expired.", "expired");
const NOT_FOUND = refusal("not-found", "Unknown link.");

export const visitLinkOf = (link: Pick<ShareLinkRecord, "shareId" | "recipientId">): SessionVisitLink => ({ via: "session", shareId: link.shareId, recipientId: link.recipientId });

/** What the view builder needs of a share. */
export const sourceOf = (share: ShareRecord): ShareSource => ({
  sessionPath: share.sessionPath,
  cutEntryId: share.mode === "live" ? null : (share.cut?.entryId ?? null),
  from: share.from?.entryId ?? null,
  lineageKey: share.id,
  title: share.title,
  sharedAt: share.createdAt,
  mode: share.mode,
  sessionId: share.sessionId,
  designsAt: designCutOf(share),
});

/** What a build of the share's view depends on: a build is published only while this is unchanged
    (a narrowed share, live → snapshot, a new cut or start, or a stopped one, never gets an older
    build). */
export const sourceKey = (share: ShareRecord): string =>
  JSON.stringify([share.mode, share.mode === "live" ? null : (share.cut?.entryId ?? null), share.from?.entryId ?? null, share.title, share.stoppedAt ?? null, designCutOf(share)]);

/**
 * Run `build` against the share `token` opens, and answer only while that still holds: after the
 * await, the token must still open and the share's source be the same one the build read; a
 * changed source is built once more, and anything else is the dead link. Nothing produced for a
 * source the link no longer grants leaves the host.
 */
export async function whileGranted<T>(token: string, build: (share: ShareRecord) => Promise<T | null>): Promise<{ ok: true; value: T | null; link: ShareLinkRecord } | { ok: false; access: Exclude<ShareAccess, { ok: true }> }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = shareAccess(token);
    if (!before.ok) return { ok: false, access: before };
    const key = sourceKey(before.share);
    const value = await build(before.share);
    const after = shareAccess(token);
    if (!after.ok) return { ok: false, access: after };
    if (sourceKey(after.share) === key) return { ok: true, value, link: after.link };
  }
  return { ok: false, access: { ok: false, status: 404 } };
}

/** Visit logging never fails or delays an answer past its own write. */
function logVisit(what: string, fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    console.warn(`[session-share] visit log (${what}) failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Built on first use: edge.ts imports this file (through routes.ts) before RateLimiter exists.
let limiters: { views: RateLimiter; images: RateLimiter; designs: RateLimiter } | null = null;
const limited = (which: "views" | "images" | "designs", token: string): boolean => {
  limiters ??= { views: new RateLimiter(SESSION_VIEW_GETS_PER_MINUTE), images: new RateLimiter(SESSION_IMAGE_GETS_PER_MINUTE), designs: new RateLimiter(SESSION_DESIGN_GETS_PER_MINUTE) };
  return limiters[which].limited(token);
};

/**
 * A per-key byte budget over a sliding window: `spend` counts an answer's bytes and says whether
 * the key had room for it (an answer that doesn't fit is not counted). Keys with nothing left in
 * their window are forgotten as others spend.
 */
export class ByteBudget {
  private spent = new Map<string, { at: number; bytes: number }[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  spend(key: string, bytes: number, now = Date.now()): boolean {
    for (const [k, v] of this.spent) if (k !== key && !v.some((x) => now - x.at < this.windowMs)) this.spent.delete(k);
    const recent = (this.spent.get(key) ?? []).filter((x) => now - x.at < this.windowMs);
    const used = recent.reduce((n, x) => n + x.bytes, 0);
    const ok = used + bytes <= this.limit;
    if (ok) recent.push({ at: now, bytes });
    this.spent.set(key, recent);
    return ok;
  }
}
let designBytes: ByteBudget | null = null;

/** A design document address's parts, or null: a label, a version from 1, a kind. */
export function designParams(c: Context): { label: string; n: number; kind: Parameters<typeof sessionShareDesign>[3] } | null {
  const label = c.req.param("label") ?? "";
  const raw = c.req.param("n") ?? "";
  const kind = c.req.param("kind");
  if (!/^[A-Z]{1,4}$/.test(label) || !/^[1-9][0-9]{0,3}$/.test(raw) || !isShareDesignKind(kind)) return null;
  return { label, n: Number(raw), kind };
}

/** `?before=` as an item index, or undefined; anything else is refused. */
function beforeOf(c: Context): number | undefined | null {
  const raw = c.req.query("before");
  if (raw === undefined) return undefined;
  return /^(0|[1-9][0-9]{0,6})$/.test(raw) ? Number(raw) : null;
}

export function mountSessionShareRoutes(app: Hono, shareDist: () => string, pageCsp: string): void {
  app.get("/s/:token", async (c) => {
    // As /h/: a rebuilt page's assets are told to the gateway first.
    await ensureAssetsCurrent();
    const index = join(shareDist(), "index.html");
    if (!existsSync(index)) return c.text("The share page is not built on this host.", 503);
    const ua = c.req.header("user-agent");
    if (classify(ua).kind === "preview")
      logVisit("preview", () => {
        const hit = findShareLink(c.req.param("token"));
        if (hit) recordShellFetch(visitLinkOf(hit.link), ua);
      });
    return c.body(readFileSync(index, "utf8"), 200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": pageCsp, ...ROBOTS });
  });

  app.get("/api/s/:token", async (c) => {
    const token = c.req.param("token");
    for (const [k, v] of Object.entries(ROBOTS)) c.header(k, v);
    if (limited("views", token)) return c.json(refusal("rate-limited", "Too many requests. Wait a minute."), 429);
    const before = beforeOf(c);
    if (before === null) return c.json(refusal("bad-request", "Bad page."), 400);
    const ua = c.req.header("user-agent");
    const got = await whileGranted(token, (share) => sessionShareView(sourceOf(share), { before }));
    if (!got.ok) {
      const access = got.access;
      if (access.status === 404) return c.json(NOT_FOUND, 404);
      logVisit("refused", () => recordRefused(visitLinkOf(access.link), ua));
      return c.json(access.why === "expired" ? EXPIRED : GONE, 410);
    }
    if (!got.value) return c.json(GONE, 410);
    logVisit("open", () => noteShareVisit(recordOpen(visitLinkOf(got.link), { tab: c.req.query("v"), userAgent: ua }), c.env));
    return c.json(got.value);
  });

  app.get("/api/s/:token/img/:n", async (c) => {
    const token = c.req.param("token");
    for (const [k, v] of Object.entries(ROBOTS)) c.header(k, v);
    if (limited("images", token)) return c.json(refusal("rate-limited", "Too many requests. Wait a minute."), 429);
    const n = Number(c.req.param("n"));
    const got = await whileGranted(token, (share) => sessionShareImage(sourceOf(share), n));
    if (!got.ok) return got.access.status === 404 ? c.json(NOT_FOUND, 404) : c.json(got.access.why === "expired" ? EXPIRED : GONE, 410);
    const img = got.value;
    if (!img || !(SESSION_SHARE_IMAGE_TYPES as readonly string[]).includes(img.mime)) return c.json(refusal("not-found", "No such image."), 404);
    return c.body(new Uint8Array(img.bytes), 200, { "Content-Type": img.mime, "Content-Security-Policy": IMAGE_CSP, "Content-Disposition": "inline" });
  });

  // A design version's walled document (§app.session-share/lookbook-serving): only one the link's
  // view shows now, judged while granted, under header policies (designDocumentHeaders).
  app.get("/api/s/:token/d/:label/:n/:kind", async (c) => {
    const token = c.req.param("token");
    for (const [k, v] of Object.entries(ROBOTS)) c.header(k, v);
    if (limited("designs", token)) return c.json(refusal("rate-limited", "Too many requests. Wait a minute."), 429);
    const p = designParams(c);
    if (!p) return c.json(refusal("not-found", "No such design."), 404);
    const got = await whileGranted(token, (share) => sessionShareDesign(sourceOf(share), p.label, p.n, p.kind));
    if (!got.ok) return got.access.status === 404 ? c.json(NOT_FOUND, 404) : c.json(got.access.why === "expired" ? EXPIRED : GONE, 410);
    const doc = got.value;
    if (doc === null) return c.json(refusal("not-found", "No such design."), 404);
    const bytes = Buffer.from(doc, "utf8");
    if (bytes.length > SESSION_SHARE_DESIGN_MAX_BYTES) return c.json(refusal("not-found", "No such design."), 404);
    designBytes ??= new ByteBudget(SESSION_DESIGN_BYTES_PER_MINUTE);
    if (!designBytes.spend(token, bytes.length)) return c.json(refusal("rate-limited", "Too many requests. Wait a minute."), 429);
    return c.body(new Uint8Array(bytes), 200, designDocumentHeaders(p.kind));
  });
}

/** The in-process `/ws/s` upgrade: a live link's page joins its share's viewers (presence, pushes).
    Read-only: the page's only frame is its visibility. Call once per server. */
export function sessionShareUpgrade(maxPayload = 1024): ShareUpgrade {
  const wss = cappedWebSocketServer({ noServer: true, maxPayload });
  // Open pages get their Lookbooks' changes pushed wherever this process serves them.
  ensureDesignPushes();
  return async (req, socket, head, { url, token }) => {
    // The link opens AND its share still reads (the file parses, the cut is in it): a socket is
    // admitted only where the API would answer the view.
    const got = await whileGranted(token, (share) => sourceReadable(sourceOf(share)));
    if (!got.ok || !got.value) {
      const a = got.ok ? null : got.access;
      refuse(socket, a?.status === 404 ? 404 : 410, a?.status === 404 ? NOT_FOUND : a?.why === "expired" ? EXPIRED : GONE);
      return;
    }
    const link = got.link;
    const share = { id: link.shareId };
    wss.handleUpgrade(req, socket, head, (ws) => {
      // A frame over maxPayload (or any protocol error): ws closes the socket; without a listener
      // the error would escape as an uncaughtException.
      ws.on("error", (err) => console.warn(`[session-share] socket error: ${err.message}`));
      // Judged again after the handshake: the link may have died meanwhile.
      const now = shareAccess(token);
      if (!now.ok || now.link.hash !== link.hash) return ws.close(SESSION_SHARE_GONE_CLOSE, "gone");
      addViewer({ shareId: share.id, recipientId: link.recipientId, hash: link.hash }, ws, { tab: url.searchParams.get("v"), userAgent: req.headers["user-agent"] ?? null });
    });
  };
}
