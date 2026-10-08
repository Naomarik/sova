import { existsSync } from "node:fs";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  SESSION_SHARE_IMAGE_TYPES,
  type SessionShare,
  type SessionShareActivity,
  type SessionShareMinted,
  type SessionShareMode,
  type SessionSharePreview,
  type SessionShareRecipient,
} from "../shared/session-share";
import { resolveSessionPath } from "./paths";
import { presenceOf } from "./session-share-presence";
import { currentLeaf, sessionShareImage, sessionShareOutline, sessionShareView, shareSpan, sliceBounds, type ShareSource } from "./session-share-view";
import {
  addRecipient,
  boundsOf,
  checkRecipients,
  cleanTitle,
  createShare,
  extendShare,
  getShare,
  linkState,
  listShares,
  liveEnd,
  patchShare,
  relinkRecipient,
  revokeRecipient,
  ShareError,
  type ShareLinkRecord,
  type ShareRecord,
  stopShare,
  stopSharesOfSession,
  StoreUnavailable,
  validDays,
} from "./session-shares";
import { cachedTitleOf, getSessionSummary, indexedSessionPaths, listSessions, onSessionArchived } from "./sessions-index";
import { sharesOverview } from "./shares-overview";
import { tokenFor } from "./link-tokens";
import { awaitShareLinks } from "./share/links-events";
import { linkUrl, sessionLinkWarning } from "./share/listener";
import { closeLinks, pushShareView, startSessionShareLive } from "./share/session-live";
import { sourceOf } from "./share/session-routes";
import { closeShare } from "./session-share-presence";
import { readSessionVisits, visitSummary } from "./visits";

/**
 * The operator's session share routes (§app.session-share/link; shapes in shared/session-share.ts).
 * Ordinary operator API: served on the main listener and, through the pane's host scope, to a
 * verified peer (a session is shared by the host that holds its file, §mesh.remote-sessions). The
 * share listener never has them: its app is server/share/routes.ts alone.
 */

const small = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "Too large", code: "too-large" }, 413) });
const NO_STORE = { "Cache-Control": "no-store" };

/** A session's file on this host, by id: the listing cache first, then one real listing. */
async function sessionPathOf(sessionId: string): Promise<string | null> {
  let path = indexedSessionPaths().get(sessionId);
  if (!path) {
    await listSessions().catch(() => []);
    path = indexedSessionPaths().get(sessionId);
  }
  const resolved = path ? resolveSessionPath(path) : null;
  return resolved && existsSync(resolved) ? resolved : null;
}

async function sessionTitleOf(path: string): Promise<string> {
  const cached = cachedTitleOf(path);
  if (cached) return cached;
  return (await getSessionSummary(path).catch(() => null))?.title ?? "Untitled";
}

/** A recipient's row: their newest link, its state, presence now and visits; while it is live
    and its token is kept, the link itself, on the address as it is now (§app.session-share/link). */
function recipientsOf(share: ShareRecord, links: ShareLinkRecord[], now: number): SessionShareRecipient[] {
  const newest = new Map<string, ShareLinkRecord>();
  for (const l of links) newest.set(l.recipientId, l);
  return [...newest.values()].map((l) => {
    const visits = visitSummary(readSessionVisits(share.id, l.recipientId));
    const state = linkState(l, share, now);
    const token = state === "live" ? tokenFor(l.hash, "s") : null;
    return {
      id: l.recipientId,
      label: l.label,
      ...(l.anyone ? { anyone: true as const } : {}),
      state,
      createdAt: l.createdAt,
      expiresAt: l.expiresAt,
      ...(l.revokedAt ? { revokedAt: l.revokedAt } : {}),
      presence: presenceOf(share.id, l.recipientId),
      ...visits,
      ...(token ? { link: linkUrl("s", token) } : {}),
    };
  });
}

/** The operator's view of a share (a slice's span is read from the session file). */
export async function shareInfo(share: ShareRecord, links: ShareLinkRecord[], now = Date.now()): Promise<SessionShare> {
  const src = sourceOf(share);
  const span = await shareSpan(src).catch(() => undefined);
  return {
    id: share.id,
    sessionId: share.sessionId,
    sessionTitle: cachedTitleOf(share.sessionPath) ?? share.title,
    title: share.title,
    mode: share.mode,
    cutAt: share.mode === "snapshot" ? (share.cut?.at ?? null) : null,
    ...(src.cutEntryId ? { cut: src.cutEntryId } : {}),
    ...(src.from ? { from: src.from } : {}),
    ...(span ? { span } : {}),
    createdAt: share.createdAt,
    ...(share.stoppedAt ? { stoppedAt: share.stoppedAt } : {}),
    ...(existsSync(share.sessionPath) ? {} : { missing: true as const }),
    recipients: recipientsOf(share, links, now),
  };
}

function infoOf(shareId: string): Promise<SessionShare> {
  const hit = getShare(shareId);
  if (!hit) throw new ShareError(404, "not-found", "No such share.");
  return shareInfo(hit.share, hit.links);
}

/** Every share on this host (optionally one session's), newest first. */
export function allShareInfos(sessionId?: string): Promise<SessionShare[]> {
  const { shares, links } = listShares(sessionId);
  const now = Date.now();
  return Promise.all(
    shares.map((s) =>
      shareInfo(
        s,
        links.filter((l) => l.shareId === s.id),
        now,
      ),
    ),
  );
}

/** A route's failure as the operator sees it. */
function failed(c: Context, err: unknown): Response {
  if (err instanceof ShareError) return c.json({ error: err.message, code: err.code }, err.status);
  if (err instanceof StoreUnavailable) {
    console.warn(`[session-share] ${err.message}`);
    return c.json({ error: "The session shares file can't be read. Fix or remove it, then try again.", code: "store-unavailable" }, 503);
  }
  throw err;
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ShareError(400, "bad-request", "Expected a JSON body.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ShareError(400, "bad-request", "Expected a JSON object.");
  return body as Record<string, unknown>;
}

function beforeOf(c: Context): number | undefined {
  const raw = c.req.query("before");
  if (raw === undefined) return undefined;
  if (!/^(0|[1-9][0-9]{0,6})$/.test(raw)) throw new ShareError(400, "bad-request", "Bad page.");
  return Number(raw);
}

/** A cut at the session's current leaf, for a snapshot. */
async function cutNow(path: string): Promise<{ entryId: string; at: string | null }> {
  const leaf = await currentLeaf(path);
  if (!leaf) throw new ShareError(400, "empty-session", "This session has nothing to share yet.");
  return leaf;
}

/** A cut as the preview answers it: an entry id. */
const CUT_RE = /^[A-Za-z0-9_-]{1,64}$/;

const STALE = "The session changed. Preview it again.";
/** Update to now (or Follow live) on a slice whose start left the branch. */
const START_GONE = "The start of this share is no longer in the session.";

/** A previewed cut, still in the file with a readable branch; else the preview is stale. */
async function previewedCut(path: string, entryId: string): Promise<{ entryId: string; at: string | null }> {
  const bounds = await sliceBounds({ sessionPath: path, cutEntryId: entryId, from: null });
  if (!bounds) throw new ShareError(409, "stale-preview", STALE);
  return { entryId, at: bounds.through };
}

/** A slice's start as the store keeps it, checked on the branch it will be read from (the cut's,
    or the current one); off it, 409 stale-preview with `why`. null: no start. */
async function startOn(path: string, cutEntryId: string | null, from: string | null, why = STALE): Promise<{ entryId: string; at: string | null } | null> {
  if (from === null) return null;
  const bounds = await sliceBounds({ sessionPath: path, cutEntryId, from });
  if (!bounds) throw new ShareError(409, "stale-preview", why);
  return { entryId: from, at: bounds.fromAt };
}

/** A body's `from`: an entry id, null (from the first message), or undefined (not given). */
function fromOf(given: unknown): string | null | undefined {
  if (given === undefined || given === null) return given;
  if (typeof given !== "string" || !CUT_RE.test(given)) throw new ShareError(400, "bad-from", "Bad start.");
  return given;
}

/** A previewed cut when one is given, else the current leaf. */
const cutFrom = (path: string, given: unknown): Promise<{ entryId: string; at: string | null }> => {
  if (given === undefined) return cutNow(path);
  if (typeof given !== "string" || !CUT_RE.test(given)) throw new ShareError(400, "bad-cut", "Bad preview.");
  return previewedCut(path, given);
};

/** The image answer for the operator's Preview: the bytes as they will be shared. */
async function imageAnswer(c: Context, src: Pick<ShareSource, "sessionPath" | "cutEntryId" | "from">): Promise<Response> {
  const n = Number(c.req.param("n"));
  if (!/^(0|[1-9][0-9]{0,4})$/.test(c.req.param("n") ?? "")) throw new ShareError(404, "not-found", "No such image.");
  const img = await sessionShareImage(src, n);
  if (!img || !(SESSION_SHARE_IMAGE_TYPES as readonly string[]).includes(img.mime)) throw new ShareError(404, "not-found", "No such image.");
  return c.body(new Uint8Array(img.bytes), 200, { "Content-Type": img.mime, "Content-Security-Policy": "default-src 'none'; sandbox", "X-Content-Type-Options": "nosniff", ...NO_STORE });
}

const minted = (share: SessionShare, tokens: { recipientId: string; label: string; token: string }[], warning: ReturnType<typeof sessionLinkWarning>): SessionShareMinted => ({
  share,
  links: tokens.map((t) => ({ recipientId: t.recipientId, label: t.label, link: linkUrl("s", t.token) })),
  ...warning,
});

/** Tests' seam: runs after a PATCH's validation reads, right before its guarded write (a write landing there must refuse it). */
export const patchHooks: { validated?: () => void | Promise<void> } = {};

export function registerSessionShareRoutes(app: Hono): void {
  startSessionShareLive();
  // Archiving a session stops its shares (§app.session-share/link).
  onSessionArchived((sessionId) => {
    try {
      for (const id of stopSharesOfSession(sessionId).shares) closeShare(id);
    } catch (err) {
      console.warn(`[session-share] stopping an archived session's shares failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  app.get("/api/session-shares", async (c) => {
    const session = c.req.query("session");
    return c.json(await allShareInfos(session || undefined), 200, NO_STORE);
  });

  app.get("/api/shares-overview", async (c) => c.json(await sharesOverview(await allShareInfos()), 200, NO_STORE));

  // Preview before any link exists: the session as a recipient would see it, bound to a cut. The
  // first read fixes the cut at the current leaf and answers it (`cut`); every later read (Show
  // earlier, images) passes `&cut=`, and the mint passes the same cut, so the snapshot minted is
  // exactly the one previewed, images included. `&from=` slices it (§app.session-share/slice);
  // `&outline=1` answers the share page's picker instead: the whole session at the cut.
  const previewSource = async (c: Context): Promise<ShareSource> => {
    const sessionId = c.req.query("session") ?? "";
    const path = sessionId ? await sessionPathOf(sessionId) : null;
    if (!path) throw new ShareError(404, "not-found", "No such session on this host.");
    const asked = c.req.query("cut");
    if (asked !== undefined && !CUT_RE.test(asked)) throw new ShareError(400, "bad-cut", "Bad preview.");
    const cut = asked ?? (await cutNow(path)).entryId;
    const from = c.req.query("from");
    if (from !== undefined && !CUT_RE.test(from)) throw new ShareError(400, "bad-from", "Bad start.");
    return { sessionPath: path, cutEntryId: cut, from: from ?? null, title: await sessionTitleOf(path), sharedAt: new Date().toISOString(), mode: "snapshot" };
  };
  app.get("/api/session-shares/preview", async (c) => {
    try {
      const src = await previewSource(c);
      if (c.req.query("outline") === "1") {
        const outline = await sessionShareOutline({ sessionPath: src.sessionPath, cutEntryId: src.cutEntryId! });
        if (!outline) throw new ShareError(409, "stale-preview", STALE);
        return c.json(outline, 200, NO_STORE);
      }
      const view = await sessionShareView(src, { before: beforeOf(c) });
      if (!view) throw new ShareError(409, "stale-preview", STALE);
      const answer: SessionSharePreview = { ...view, cut: src.cutEntryId!, ...(src.from ? { from: src.from } : {}) };
      return c.json(answer, 200, NO_STORE);
    } catch (err) {
      return failed(c, err);
    }
  });
  app.get("/api/session-shares/preview/img/:n", async (c) => {
    try {
      return await imageAnswer(c, await previewSource(c));
    } catch (err) {
      return failed(c, err);
    }
  });

  app.post("/api/session-shares", small, async (c) => {
    try {
      const body = await jsonBody(c);
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const path = sessionId ? await sessionPathOf(sessionId) : null;
      if (!path) throw new ShareError(404, "not-found", "No such session on this host.");
      const title = cleanTitle(body.title);
      if (!title) throw new ShareError(400, "bad-title", "Give the share a title.");
      const mode = body.mode;
      if (mode !== "snapshot" && mode !== "live") throw new ShareError(400, "bad-mode", "Choose Snapshot or Follow live.");
      if (!validDays(body.expiresInDays)) throw new ShareError(400, "bad-expiry", "Choose 1, 7, 30 or 90 days.");
      const recipients = checkRecipients(body.recipients, body.anyone);
      const fromId = fromOf(body.from) ?? null;
      // A snapshot is the previewed one: its cut comes from the preview, never "now" (a session
      // that moved on after the preview would publish content, images included, nobody saw).
      // Follow live is consent to later content, so it needs none.
      let cut: { entryId: string; at: string | null } | null = null;
      // An end makes a snapshot: Follow live with one is refused, never read as "no end".
      if (mode === "live" && body.cut !== undefined) throw liveEnd();
      if (mode === "snapshot") {
        if (typeof body.cut !== "string" || !CUT_RE.test(body.cut)) throw new ShareError(400, "preview-required", "Preview the session before sharing it.");
        cut = await previewedCut(path, body.cut);
      }
      // A slice's start must be on the branch it reads: the previewed cut's, or (live) the current one.
      const from = await startOn(path, cut?.entryId ?? null, fromId);
      const { result, outcome } = await awaitShareLinks(() =>
        createShare({ sessionId, sessionPath: path, title, mode: mode as SessionShareMode, cut, from, days: body.expiresInDays as never, labels: recipients.labels, anyone: recipients.anyone }),
      );
      return c.json(minted(await infoOf(result.share.id), result.tokens, sessionLinkWarning(outcome)), 201, NO_STORE);
    } catch (err) {
      return failed(c, err);
    }
  });

  app.get("/api/session-shares/:id/preview", async (c) => {
    try {
      const hit = getShare(c.req.param("id"));
      if (!hit) throw new ShareError(404, "not-found", "No such share.");
      const view = await sessionShareView(sourceOf(hit.share), { before: beforeOf(c) });
      if (!view) throw new ShareError(404, "missing", "This session can't be read any more.");
      return c.json(view, 200, NO_STORE);
    } catch (err) {
      return failed(c, err);
    }
  });
  app.get("/api/session-shares/:id/preview/img/:n", async (c) => {
    try {
      const hit = getShare(c.req.param("id"));
      if (!hit) throw new ShareError(404, "not-found", "No such share.");
      return await imageAnswer(c, sourceOf(hit.share));
    } catch (err) {
      return failed(c, err);
    }
  });

  app.patch("/api/session-shares/:id", small, async (c) => {
    try {
      const id = c.req.param("id");
      const body = await jsonBody(c);
      if (Object.keys(body).some((k) => k !== "title" && k !== "mode" && k !== "cut" && k !== "from")) throw new ShareError(400, "bad-request", "Only the title, mode and slice can change.");
      const hit = getShare(id);
      if (!hit) throw new ShareError(404, "not-found", "No such share.");
      const share = hit.share;
      const patch: Parameters<typeof patchShare>[1] = {};
      if (body.title !== undefined) {
        const t = cleanTitle(body.title);
        if (!t) throw new ShareError(400, "bad-title", "Give the share a title.");
        patch.title = t;
      }
      if (body.mode !== undefined && body.mode !== "snapshot" && body.mode !== "live") throw new ShareError(400, "bad-mode", "Choose Snapshot or Follow live.");
      const mode: SessionShareMode = (body.mode as SessionShareMode | undefined) ?? share.mode;
      if (body.mode !== undefined) patch.mode = mode;
      if (mode === "live" && body.cut !== undefined) throw liveEnd();
      // Follow live off: the snapshot is the session as it is now (or the previewed cut). On a
      // snapshot, a cut given is the slice's new end (Save Slice), a previewed one.
      if (mode === "snapshot" && (share.mode === "live" || body.cut !== undefined)) patch.cut = await cutFrom(share.sessionPath, body.cut);
      const given = fromOf(body.from);
      const was = share.from?.entryId ?? null;
      const from = given === undefined ? was : given;
      // The start (new, or kept across a new end or mode) must be on the branch the share will read.
      if (given !== undefined || patch.cut || patch.mode) {
        const end = mode === "live" ? null : (patch.cut?.entryId ?? share.cut?.entryId ?? null);
        const checked = await startOn(share.sessionPath, end, from, given === undefined ? START_GONE : STALE);
        if (given !== undefined) patch.from = checked;
      }
      await patchHooks.validated?.();
      // Written only if the mode, end and start are still the ones validated above.
      patchShare(id, patch, boundsOf(share));
      await pushShareView(id);
      return c.json(await infoOf(id), 200, NO_STORE);
    } catch (err) {
      return failed(c, err);
    }
  });

  app.post("/api/session-shares/:id/update", small, async (c) => {
    try {
      const id = c.req.param("id");
      const hit = getShare(id);
      if (!hit) throw new ShareError(404, "not-found", "No such share.");
      // Optional body { cut }: the previewed cut to move to; without one, the current leaf.
      const body = c.req.header("content-type")?.includes("json") ? await jsonBody(c) : {};
      // A live share has no end: one given is refused, never dropped. With none, it just re-pushes.
      if (hit.share.mode === "live" && body.cut !== undefined) throw liveEnd();
      if (hit.share.mode === "snapshot") {
        // The start stays: a new end whose branch lost it is refused, and nothing changes.
        const cut = await cutFrom(hit.share.sessionPath, body.cut);
        await startOn(hit.share.sessionPath, cut.entryId, hit.share.from?.entryId ?? null, START_GONE);
        patchShare(id, { cut }, boundsOf(hit.share));
      }
      await pushShareView(id);
      return c.json(await infoOf(id), 200, NO_STORE);
    } catch (err) {
      return failed(c, err);
    }
  });

  app.post("/api/session-shares/:id/recipients", small, async (c) => {
    try {
      const id = c.req.param("id");
      const body = await jsonBody(c);
      const who = body.anyone === true && Object.keys(body).length === 1 ? { anyone: true as const } : typeof body.label === "string" && Object.keys(body).length === 1 ? { label: body.label } : null;
      if (!who) throw new ShareError(400, "bad-request", "Expected { label } or { anyone: true }.");
      const { result, outcome } = await awaitShareLinks(() => addRecipient(id, who));
      return c.json(minted(await infoOf(id), [result], sessionLinkWarning(outcome)), 201, NO_STORE);
    } catch (err) {
      return failed(c, err);
    }
  });

  app.post("/api/session-shares/:id/recipients/:rid/relink", async (c) => {
    try {
      const id = c.req.param("id");
      const rid = c.req.param("rid");
      const old = getShare(id)?.links.filter((l) => l.recipientId === rid && !l.revokedAt).map((l) => l.hash) ?? [];
      // The old link's pages close with the store's own change, before any wait on the gateway:
      // a slow or absent publication of the new link never extends the old one.
      const { result, outcome } = await awaitShareLinks(() => {
        const minted = relinkRecipient(id, rid);
        closeLinks(old);
        return minted;
      });
      return c.json(minted(await infoOf(id), [result], sessionLinkWarning(outcome)), 200, NO_STORE);
    } catch (err) {
      return failed(c, err);
    }
  });

  app.post("/api/session-shares/:id/recipients/:rid/revoke", async (c) => {
    try {
      const id = c.req.param("id");
      closeLinks(revokeRecipient(id, c.req.param("rid")));
      return c.json(await infoOf(id), 200, NO_STORE);
    } catch (err) {
      return failed(c, err);
    }
  });

  app.post("/api/session-shares/:id/stop", async (c) => {
    try {
      const id = c.req.param("id");
      stopShare(id);
      closeShare(id);
      return c.json(await infoOf(id), 200, NO_STORE);
    } catch (err) {
      return failed(c, err);
    }
  });

  app.post("/api/session-shares/:id/extend", small, async (c) => {
    try {
      const id = c.req.param("id");
      const body = await jsonBody(c);
      if (!validDays(body.days)) throw new ShareError(400, "bad-expiry", "Choose 1, 7, 30 or 90 days.");
      await awaitShareLinks(() => extendShare(id, body.days as never));
      return c.json(await infoOf(id), 200, NO_STORE);
    } catch (err) {
      return failed(c, err);
    }
  });

  app.get("/api/session-shares/:id/activity", (c) => {
    try {
      const hit = getShare(c.req.param("id"));
      if (!hit) throw new ShareError(404, "not-found", "No such share.");
      // Each recipient's newest link: its createdAt and state tell an open sheet when the row it shows
      // was relinked, turned off or stopped elsewhere.
      const newest = new Map<string, ShareLinkRecord>();
      for (const l of hit.links) newest.set(l.recipientId, l);
      const now = Date.now();
      const activity: SessionShareActivity = {
        shareId: hit.share.id,
        recipients: [...newest.values()].map((l) => {
          const visits = readSessionVisits(hit.share.id, l.recipientId);
          return { recipientId: l.recipientId, presence: presenceOf(hit.share.id, l.recipientId), ...visitSummary(visits), visits, createdAt: l.createdAt, state: linkState(l, hit.share, now) };
        }),
      };
      return c.json(activity, 200, NO_STORE);
    } catch (err) {
      return failed(c, err);
    }
  });
}
