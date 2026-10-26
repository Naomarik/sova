import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { Hono, type Context } from "hono";
import { FILES_PER_MESSAGE, SHARE_TEXT_MAX, type GoneWhy } from "../../shared/baton";
import { FRAME_HOST_NAME, FRAME_HOST_PATH, frameHostHeaders } from "../../shared/vis-frame-host";
import { linkAccess, nameOf, noteMessage, sessionPathOf, undoNote } from "../baton";
import { filesFor } from "../baton-files";
import { countFileUpload, ensureFilesSweep, FileRefusal, fileLine, receiveFiles, reserveUpload, stageFile, takeStagedFiles, type FileRecord } from "../project-files";
import { findLink, hashToken, tokenTag } from "../baton-links";
import { acquireChatHandle } from "../chat-handle";
import { OrgError } from "../orgs";
import { imageForToken, refreshShare, viewForToken } from "./hub";
import { assertBudget, countUpload, dropStaged, ensureSweep, isPhotoType, photoCount, PhotoRefusal, photosFor, stagePhoto, takeStaged, type SdkImage } from "../baton-images";
import { askForNewLink, noteOwnerUse, ownerAccess } from "../owner";
import { attentionChanged } from "../attention-memo";
import { ownerConversationOlder, ownerVersionOf, ownerView } from "../owner-page";
import { openVersion, STARTING_PAGE } from "../owner-versions";
import { AssistantRefusal, assistantOlder, assistantPhoto, assistantPhotoLimits, assistantStagingKey, assistantView, sendOwnerMessage } from "../project-assistant";
import { assistantReady } from "../project-assistant-ready";
import { ASSISTANT_TEXT_MAX } from "../../shared/project-assistant";
import { mountSessionShareRoutes } from "./session-routes";
import { mountPublicTourRoutes } from "./tour-routes";
import { mountBatonTourRoutes } from "../tours/bindings-routes";
import { classify, recordOpen, recordRefused, recordShellFetch, type VisitLink } from "../visits";
import { noteShareVisit } from "../visitor-identity";
import { RateLimiter } from "./rate-limit";
import { OWNER_READS_PER_MINUTE, ownerReadTokenLimited } from "./tour-limits";
import { ensureAssetsCurrent } from "./registry-push";
import { shareDist } from "./share-dist";

/**
 * The share listener's whole API (§app.baton/share-listener). Its own Hono app: nothing of the
 * operator app is registered here, so a route missing from this file does not exist on the share
 * port. The listener (server/share/listener.ts) has already refused every path outside the allowlist
 * before a request gets here.
 */

export const MESSAGES_PER_MINUTE = 10;
const perToken = new RateLimiter(MESSAGES_PER_MINUTE);

/** Visit logging (server/visits.ts) never fails or delays a request past its own write. */
export function logVisit(token: string, what: string, fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    console.warn(`[share] visit log (${what}) on ${tokenTag(token)} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Sliding one-minute window per token; true when this message is over the limit. Tokens with no
    message inside the window are dropped on the way (on every call while few are held, at most
    once a second under a flood: server/share/rate-limit.ts), so the map holds only recent writers. */
export const tokenLimited = (token: string, now = Date.now()): boolean => perToken.limited(token, now);

/** How many tokens the per-token window holds (tests). */
export const tokenWindowSize = (): number => perToken.size;

/** Photo reads per token per minute (§app.baton/images): a thread full of photos, re-read on a reload. */
export const IMAGE_GETS_PER_MINUTE = 240;
const imageGets = new RateLimiter(IMAGE_GETS_PER_MINUTE);

/** Sliding one-minute window of photo reads per token; true when this one is over the limit. */
export const imageTokenLimited = (token: string, now = Date.now()): boolean => imageGets.limited(token, now);

/** A photo's own CSP: nothing runs, even if a browser were talked into rendering it as a page. */
const IMAGE_CSP = "default-src 'none'; sandbox";

/** Owner page reads per token per minute (a page re-reads every 60 s; this is the ceiling). */
export const OWNER_GETS_PER_MINUTE = OWNER_READS_PER_MINUTE;

/** Sliding one-minute window of Owner page reads per token; true when this one is over the limit. */
export const ownerTokenLimited = (token: string, now = Date.now()): boolean => ownerReadTokenLimited(token, now);

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  // The token is in the URL: never send it anywhere as a referrer.
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};
// frame-src: only the frame host (§chat.markdown/visuals), and it confines the frame's own
// navigations to this host; never a blob: or data: frame.
export const PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
};

const refusal = (code: string, message: string, why?: GoneWhy) => ({ error: message, code, ...(why ? { why } : {}) });
/** A dead or unknown link's answer: 410 says only whether it expired or its offer went elsewhere. */
const deadLink = (status: 404 | 410, why?: GoneWhy) => (status === 410 ? refusal("gone", "This link is no longer active.", why) : refusal("not-found", "Unknown link."));

export function createShareApp(): Hono {
  const app = new Hono();
  // Staged photos of closed sessions and old ones go even when nobody uploads again.
  ensureSweep();
  // And staged files no message sent (§app/file-intake).
  ensureFilesSweep();
  app.use("*", async (c, next) => {
    await next();
    // The frame host alone may be framed, by its own host (frameHostHeaders): every other answer, never.
    const framable = c.req.path === FRAME_HOST_PATH && c.res.status === 200;
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!(framable && k === "X-Frame-Options")) c.header(k, v);
  });

  app.get("/h/assets/:name", (c) => {
    const name = c.req.param("name");
    const file = join(shareDist(), "assets", name);
    if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name) || !existsSync(file)) return c.json({ error: "Not found" }, 404);
    // The one HTML asset: the frame host of a share page's interactive drawings (§chat.markdown/visuals).
    if (name === FRAME_HOST_NAME) return c.body(readFileSync(file), 200, frameHostHeaders());
    return c.body(readFileSync(file), 200, { "Content-Type": MIME[extname(name)] ?? "application/octet-stream" });
  });

  app.get("/h/:token", async (c) => {
    // A rebuilt page names assets its gateway may not have been told of: tell it first.
    await ensureAssetsCurrent();
    const index = join(shareDist(), "index.html");
    if (!existsSync(index)) return c.text("The share page is not built on this host.", 503);
    // The shell never looks at the token (no validity oracle), except for a known link previewer's
    // fetch, which the person's page lists as "Link preview by <service>" (§app.baton/visits).
    const ua = c.req.header("user-agent");
    if (classify(ua).kind === "preview")
      logVisit(c.req.param("token"), "preview", () => {
        const link = findLink(c.req.param("token"));
        if (link) recordShellFetch(link, ua);
      });
    return c.body(readFileSync(index, "utf8"), 200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PAGE_CSP });
  });

  app.get("/api/h/:token", async (c) => {
    const token = c.req.param("token");
    const view = await viewForToken(token);
    const ua = c.req.header("user-agent");
    if ("status" in view) {
      if (view.status === 410)
        logVisit(token, "refused", () => {
          const link = findLink(token);
          if (link) recordRefused(link, ua);
        });
      return c.json(deadLink(view.status, view.why), view.status);
    }
    logVisit(token, "open", () => {
      const link = findLink(token);
      if (link) noteShareVisit(recordOpen(link, { tab: c.req.query("v"), userAgent: ua }), c.env);
    });
    return c.json(view);
  });

  app.post("/api/h/:token/message", async (c) => {
    const token = c.req.param("token");
    const access = linkAccess(token);
    if (!access.ok) return c.json(deadLink(access.status, access.why), access.status);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(refusal("bad-request", "Expected JSON { text }."), 400);
    }
    // Only { text, images?, files? }: no sender, nothing else. The sender IS the token's person;
    // images are ids of photos this link staged (§app.baton/images), files ids of files it staged
    // (§app.baton/files), never bytes.
    if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some((k) => k !== "text" && k !== "images" && k !== "files"))
      return c.json(refusal("bad-request", "Only { text, images, files } is accepted."), 400);
    const ids = (body as { images?: unknown }).images;
    if (ids !== undefined && (!Array.isArray(ids) || ids.some((x) => typeof x !== "string"))) return c.json(refusal("bad-request", "images is a list of photo ids."), 400);
    const photoIds = (ids ?? []) as string[];
    const fids = (body as { files?: unknown }).files;
    if (fids !== undefined && (!Array.isArray(fids) || fids.some((x) => typeof x !== "string"))) return c.json(refusal("bad-request", "files is a list of file ids."), 400);
    const fileIds = (fids ?? []) as string[];
    if (fileIds.length > FILES_PER_MESSAGE) return c.json(refusal("too-many", `Up to ${FILES_PER_MESSAGE} files per message.`), 400);
    const text = typeof (body as { text?: unknown }).text === "string" ? (body as { text: string }).text.trim() : "";
    if (!text && !photoIds.length && !fileIds.length) return c.json(refusal("bad-request", "Write something first."), 400);
    if (text.length > SHARE_TEXT_MAX) return c.json(refusal("too-long", `Messages are limited to ${SHARE_TEXT_MAX} characters.`), 413);
    if (text.startsWith("/")) return c.json(refusal("bad-request", "Messages can't start with /."), 400);
    const sessionId = access.row.sessionId;
    // At the limit the baton goes to the operator and the session needs them (the statechart's budget stop,
    // §app.baton/goal-and-loadout); the page says why.
    const limit = (message: string) => c.json(refusal("budget", message), 409);
    if (access.reason === "budget") return limit("This conversation has reached its message limit. The operator has been told.");
    if (!access.canWrite) return c.json(refusal(access.reason ?? "not-holder", "It's not your turn in this conversation right now."), 409);
    if (tokenLimited(token)) return c.json(refusal("rate-limited", "Too many messages. Wait a minute."), 429);
    const by = access.link.personId;
    const photos = photoIds.length ? await photosFor(access.row, access.dir).catch(() => null) : null;
    if (photoIds.length && !photos) return c.json(refusal("no-photos", "This conversation can't take photos right now."), 409);
    if (photos && photoIds.length > photos.perMessage) return c.json(refusal("too-many", `Up to ${photos.perMessage} photos per message.`), 400);
    // Files only while the session takes them (§app.baton/files); never a question of vision.
    if (fileIds.length && !filesFor(access.row)) return c.json(refusal("no-files", "This conversation can't take files right now."), 409);
    const busy = (err: unknown) => {
      console.warn(`[share] message on ${tokenTag(token)} refused: ${err instanceof Error ? err.message : String(err)}`);
      return c.json(refusal("busy", "The conversation can't take a message right now. Try again in a moment."), 503);
    };
    // Nothing is counted or claimed until the runtime is open and would take the message.
    let chat;
    try {
      chat = await acquireChatHandle(sessionPathOf(access.dir, access.row));
      await chat.assertModelAllowed();
    } catch (err) {
      return busy(err);
    }
    // The photos, read before anything is counted: an expired one sends the page back to upload it.
    let images: SdkImage[] | undefined;
    if (photos && photoIds.length) {
      if (photoCount(await chat.branch()) + photoIds.length > photos.perConversation)
        return c.json(refusal("photo-limit", "This conversation has reached its photo limit."), 409);
      try {
        images = takeStaged(sessionId, by, photoIds);
      } catch (err) {
        if (err instanceof PhotoRefusal) return c.json(refusal(err.code, err.message), err.status);
        throw err;
      }
    }
    // The files, read before anything is counted: one gone sends the page back to upload it.
    let files: FileRecord[] = [];
    if (fileIds.length) {
      try {
        files = takeStagedFiles(access.row.projectId, sessionId, by, fileIds);
      } catch (err) {
        if (err instanceof FileRefusal) return c.json(refusal(err.code, err.message), err.status);
        throw err;
      }
    }
    // One line per file after the person's text: what the model reads, never bytes.
    const sender = nameOf(access.row.orgId, by);
    const said = files.length ? [text, ...files.map((f) => fileLine(sender, f))].filter(Boolean).join("\n") : text;
    // From here to the hand-over, one synchronous stretch: nothing interleaves (the chat takes or
    // refuses the message inside the send call; only its answer comes later). The lock
    // (§app.baton/offers-and-leases): noteMessage decides whether this message may enter — and on
    // an open offer, that this sender now holds it; a runtime refusal then undoes exactly that.
    try {
      noteMessage(sessionId, by);
    } catch (err) {
      if (err instanceof OrgError && err.code === "budget") return limit(err.message);
      // A workspace problem is the operator's to fix; a person gets today's runtime answer (design §5.4).
      if (err instanceof OrgError && err.code === "workspace") return busy(err);
      if (err instanceof OrgError) {
        const now = linkAccess(token);
        return c.json(refusal(now.ok && now.reason ? now.reason : (err.code ?? "not-holder"), err.message), err.status === 404 ? 404 : 409);
      }
      return busy(err);
    }
    try {
      await chat.send({ text: said, ...(images ? { images } : {}), origin: "server", sentByBaton: { by } });
    } catch (err) {
      // Refused: its staged photos stay for the retry.
      undoNote(sessionId);
      return busy(err);
    }
    // In the transcript now, inline: the staged copies go.
    if (images) dropStaged(sessionId, photoIds);
    // Its files are received now: their ledger lines, and the session's view (§app/file-intake).
    if (files.length)
      try {
        receiveFiles(access.row.projectId, files);
      } catch (err) {
        console.warn(`[share] recording files on ${tokenTag(token)} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    // Its reply started with the accepted message (the statechart's reply region); the chat layer tells it the rest.
    refreshShare(sessionId);
    return c.json({ ok: true }, 202);
  });

  // ---- photos (§app.baton/images) ---------------------------------------------------------------

  app.post("/api/h/:token/image", async (c) => {
    const token = c.req.param("token");
    const access = linkAccess(token);
    if (!access.ok) return c.json(deadLink(access.status, access.why), access.status);
    if (access.reason === "budget") return c.json(refusal("budget", "This conversation has reached its message limit. The operator has been told."), 409);
    if (!access.canWrite) return c.json(refusal(access.reason ?? "not-holder", "It's not your turn in this conversation right now."), 409);
    const photos = await photosFor(access.row, access.dir).catch(() => null);
    if (!photos) return c.json(refusal("no-photos", "This conversation can't take photos right now."), 409);
    const mime = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!isPhotoType(mime)) return c.json(refusal("bad-type", "This photo's format can't be sent."), 400);
    const declared = Number(c.req.header("content-length"));
    if (!Number.isFinite(declared) || declared > photos.maxBytes) return c.json(refusal("too-large", `Over ${Math.round(photos.maxBytes / (1024 * 1024))} MB.`), 413);
    try {
      countUpload(hashToken(token), photos.perConversation);
      assertBudget(declared);
      const staged = await stagePhoto({ sessionId: access.row.sessionId, personId: access.link.personId, mime, body: c.req.raw.body as AsyncIterable<Uint8Array> | null, maxBytes: photos.maxBytes });
      return c.json(staged, 201);
    } catch (err) {
      if (err instanceof PhotoRefusal) {
        console.warn(`[share] photo on ${tokenTag(token)} refused: ${err.code}`);
        return c.json(refusal(err.code, err.message), err.status);
      }
      throw err;
    }
  });

  // ---- files (§app.baton/files): a route of its own, never the photo route's -------------------

  app.post("/api/h/:token/file", async (c) => {
    const token = c.req.param("token");
    const access = linkAccess(token);
    if (!access.ok) return c.json(deadLink(access.status, access.why), access.status);
    if (access.reason === "budget") return c.json(refusal("budget", "This conversation has reached its message limit. The operator has been told."), 409);
    if (!access.canWrite) return c.json(refusal(access.reason ?? "not-holder", "It's not your turn in this conversation right now."), 409);
    const files = filesFor(access.row);
    if (!files) return c.json(refusal("no-files", "This conversation can't take files right now."), 409);
    const declared = Number(c.req.header("content-length"));
    if (!Number.isFinite(declared) || declared > files.maxBytes) return c.json(refusal("too-large", `Over ${Math.round(files.maxBytes / (1024 * 1024))} MB.`), 413);
    let name = "";
    try {
      name = decodeURIComponent(c.req.header("x-file-name") ?? "");
    } catch {
      name = "";
    }
    let release: (() => void) | undefined;
    try {
      countFileUpload(hashToken(token));
      // Checked and reserved in one step, uploads in flight counted: parallel uploads can't all pass.
      release = reserveUpload(access.row.projectId, access.row.sessionId, access.link.personId, declared);
      const staged = await stageFile({
        release,
        projectId: access.row.projectId,
        sessionId: access.row.sessionId,
        personId: access.link.personId,
        name,
        type: (c.req.header("content-type") ?? "").split(";")[0]!.trim(),
        body: c.req.raw.body as AsyncIterable<Uint8Array> | null,
        maxBytes: files.maxBytes,
      });
      return c.json(staged, 201);
    } catch (err) {
      if (err instanceof FileRefusal) {
        console.warn(`[share] file on ${tokenTag(token)} refused: ${err.code}`);
        return c.json(refusal(err.code, err.message), err.status);
      }
      throw err;
    } finally {
      // stageFile releases it already; this covers a throw before it ran (idempotent).
      release?.();
    }
  });

  app.get("/api/h/:token/img/:n", async (c) => {
    const token = c.req.param("token");
    if (imageTokenLimited(token)) return c.json(refusal("rate-limited", "Too many requests. Wait a minute."), 429);
    const n = Number(c.req.param("n"));
    const got = await imageForToken(token, n);
    if (got && "status" in got) return c.json(deadLink(got.status, got.why), got.status);
    if (!got || !isPhotoType(got.mimeType)) return c.json(refusal("not-found", "No such photo."), 404);
    return c.body(new Uint8Array(Buffer.from(got.data, "base64")), 200, { "Content-Type": got.mimeType, "Content-Security-Policy": IMAGE_CSP, "Content-Disposition": "inline" });
  });

  // ---- the Owner page (§app.owner-page): read-only ------------------------------------------------

  const ownerVisit = (l: { orgId: string; personId: string; gen: number }): VisitLink => ({ orgId: l.orgId, personId: l.personId, via: "owner", gen: l.gen });

  app.get("/i/:token", async (c) => {
    // A rebuilt page names assets its gateway may not have been told of: tell it first.
    await ensureAssetsCurrent();
    const index = join(shareDist(), "index.html");
    if (!existsSync(index)) return c.text("The share page is not built on this host.", 503);
    // As /h/: the shell never looks at the token, except to log a known link previewer's fetch.
    const ua = c.req.header("user-agent");
    if (classify(ua).kind === "preview")
      logVisit(c.req.param("token"), "preview", () => {
        const a = ownerAccess(c.req.param("token"));
        if (a.ok) recordShellFetch(ownerVisit(a.link), ua);
      });
    return c.body(readFileSync(index, "utf8"), 200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PAGE_CSP });
  });

  /** A dead or unknown owner link's answer (§app.owner-page/link): only turning off unused is named; no org or person, ever. */
  const ownerDead = (c: import("hono").Context, access: ReturnType<typeof ownerAccess>) => {
    if (access.ok || access.status === 404) return c.json(refusal("not-found", "This link doesn't open anything."), 404);
    return c.json(access.why === "idle" ? { ...refusal("gone", "This link turned off after a week without use.", "expired"), ...(access.link?.askedAt ? { asked: true } : {}) } : refusal("gone", "This link is no longer active."), 410);
  };

  const ownerRead = (what: (c: import("hono").Context) => { project?: string; conversation?: string }) => async (c: import("hono").Context) => {
    const token = c.req.param("token") ?? "";
    if (ownerTokenLimited(token)) return c.json(refusal("rate-limited", "Too many requests. Wait a minute."), 429);
    const access = ownerAccess(token);
    const ua = c.req.header("user-agent");
    if (!access.ok) {
      const dead = access.link;
      if (access.status === 410 && dead) logVisit(token, "refused", () => recordRefused(ownerVisit(dead), ua));
      return ownerDead(c, access);
    }
    let view;
    try {
      view = await ownerView(access.orgId, what(c));
    } catch (err) {
      // An unknown handle, a hidden conversation and a project switched off answer alike.
      if (err instanceof OrgError && err.status === 404) return c.json(refusal("missing", "Not found."), 404);
      throw err;
    }
    logVisit(token, "open", () => noteShareVisit(recordOpen(ownerVisit(access.link), { tab: c.req.query("v"), userAgent: ua }), c.env));
    // A person's read is a use: the link's 7 days start again (never a previewer's or a script's).
    if (classify(ua).kind === "person") noteOwnerUse(access);
    return c.json(view);
  };
  // The Project Assistant (§app.project-assistant/chat): its conversation as the owner reads it, and their messages.
  app.get("/api/i/:token/assistant", async (c) => {
    const token = c.req.param("token");
    if (ownerTokenLimited(token)) return c.json(refusal("rate-limited", "Too many requests. Wait a minute."), 429);
    const access = ownerAccess(token);
    if (!access.ok) return ownerDead(c, access);
    if (classify(c.req.header("user-agent")).kind === "person") noteOwnerUse(access);
    return c.json(await assistantView(access.orgId));
  });
  // Earlier pages (§app.project-assistant/chat, Paged; §app.owner-page/page): the chat's, and a conversation's.
  const beforeOf = (c: Context): number | null => {
    const raw = c.req.query("before") ?? "";
    return /^(?:0|[1-9][0-9]{0,6})$/.test(raw) ? Number(raw) : null;
  };
  app.get("/api/i/:token/assistant/older", async (c) => {
    const token = c.req.param("token");
    if (ownerTokenLimited(token)) return c.json(refusal("rate-limited", "Too many requests. Wait a minute."), 429);
    const access = ownerAccess(token);
    if (!access.ok) return ownerDead(c, access);
    const before = beforeOf(c);
    if (before === null) return c.json(refusal("bad-request", "before is a message number."), 400);
    if (classify(c.req.header("user-agent")).kind === "person") noteOwnerUse(access);
    return c.json(await assistantOlder(access.orgId, before));
  });
  app.get("/api/i/:token/c/:handle/older", async (c) => {
    const token = c.req.param("token");
    if (ownerTokenLimited(token)) return c.json(refusal("rate-limited", "Too many requests. Wait a minute."), 429);
    const access = ownerAccess(token);
    if (!access.ok) return ownerDead(c, access);
    const before = beforeOf(c);
    if (before === null) return c.json(refusal("bad-request", "before is a position."), 400);
    try {
      const page = await ownerConversationOlder(access.orgId, c.req.param("handle"), before);
      if (classify(c.req.header("user-agent")).kind === "person") noteOwnerUse(access);
      return c.json(page);
    } catch (err) {
      // An unknown handle, a hidden conversation and a project switched off answer alike.
      if (err instanceof OrgError && err.status === 404) return c.json(refusal("missing", "Not found."), 404);
      throw err;
    }
  });
  app.post("/api/i/:token/assistant", async (c) => {
    const token = c.req.param("token");
    const access = ownerAccess(token);
    if (!access.ok) return ownerDead(c, access);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(refusal("bad-request", "Expected JSON { text }."), 400);
    }
    // Only { text, images? }: no sender, nothing else. The sender IS the link's owner; images are ids of
    // photos this link staged (§app.project-assistant/photos), never bytes.
    if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some((k) => k !== "text" && k !== "images"))
      return c.json(refusal("bad-request", "Only { text, images } is accepted."), 400);
    const ids = (body as { images?: unknown }).images;
    if (ids !== undefined && (!Array.isArray(ids) || ids.some((x) => typeof x !== "string"))) return c.json(refusal("bad-request", "images is a list of photo ids."), 400);
    const text = (body as { text?: unknown }).text;
    if (typeof text === "string" && text.trim().length > ASSISTANT_TEXT_MAX) return c.json(refusal("too-long", `Messages are limited to ${ASSISTANT_TEXT_MAX} characters.`), 413);
    if (tokenLimited(token)) return c.json(refusal("rate-limited", "Too many messages. Wait a minute."), 429);
    noteOwnerUse(access);
    try {
      await sendOwnerMessage(access.orgId, text, (ids ?? []) as string[]);
    } catch (err) {
      if (err instanceof AssistantRefusal) return c.json(refusal(err.code, err.message), err.status);
      console.warn(`[share] assistant message on ${tokenTag(token)} refused: ${err instanceof Error ? err.message : String(err)}`);
      return c.json(refusal("busy", "The Project Assistant can't take a message right now. Try again in a moment."), 503);
    }
    return c.json({ ok: true }, 202);
  });
  // The owner's photos (§app.project-assistant/photos): staged at attach, per org and owner.
  app.post("/api/i/:token/assistant/image", async (c) => {
    const token = c.req.param("token");
    const access = ownerAccess(token);
    if (!access.ok) return ownerDead(c, access);
    if (!(await assistantReady(access.orgId))) return c.json(refusal("not-ready", "The Project Assistant isn't ready yet."), 409);
    const photos = await assistantPhotoLimits(access.orgId).catch(() => null);
    if (!photos) return c.json(refusal("no-photos", "Photos can't be sent here."), 409);
    const mime = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!isPhotoType(mime)) return c.json(refusal("bad-type", "This photo's format can't be sent."), 400);
    const declared = Number(c.req.header("content-length"));
    if (!Number.isFinite(declared) || declared > photos.maxBytes) return c.json(refusal("too-large", `Over ${Math.round(photos.maxBytes / (1024 * 1024))} MB.`), 413);
    try {
      // No total or daily limit (§app.project-assistant/photos): only the per-minute window.
      countUpload(`i:${hashToken(token)}`, Number.POSITIVE_INFINITY);
      assertBudget(declared);
      const personId = access.link.personId;
      const staged = await stagePhoto({ sessionId: assistantStagingKey(access.orgId, personId), personId, mime, body: c.req.raw.body as AsyncIterable<Uint8Array> | null, maxBytes: photos.maxBytes });
      noteOwnerUse(access);
      return c.json(staged, 201);
    } catch (err) {
      if (err instanceof PhotoRefusal) {
        console.warn(`[share] owner photo on ${tokenTag(token)} refused: ${err.code}`);
        return c.json(refusal(err.code, err.message), err.status);
      }
      throw err;
    }
  });
  app.get("/api/i/:token/assistant/img/:n", async (c) => {
    const token = c.req.param("token");
    if (imageTokenLimited(token)) return c.json(refusal("rate-limited", "Too many requests. Wait a minute."), 429);
    const access = ownerAccess(token);
    if (!access.ok) return ownerDead(c, access);
    const got = await assistantPhoto(access.orgId, Number(c.req.param("n")));
    if (!got || !isPhotoType(got.mimeType)) return c.json(refusal("not-found", "No such photo."), 404);
    return c.body(new Uint8Array(Buffer.from(got.data, "base64")), 200, { "Content-Type": got.mimeType, "Content-Security-Policy": IMAGE_CSP, "Content-Disposition": "inline" });
  });

  // A version to try (§app.project-assistant/versions): the link and the copy checked again, then on to
  // its owner-bound preview. The address goes only into this redirect, never into a JSON answer.
  app.get("/i/:token/v/:handle", async (c) => {
    const token = c.req.param("token");
    if (ownerTokenLimited(token)) return c.json(refusal("rate-limited", "Too many requests. Wait a minute."), 429);
    const access = ownerAccess(token);
    if (!access.ok) return ownerDead(c, access);
    const v = await ownerVersionOf(access.orgId, c.req.param("handle")).catch(() => null);
    if (!v) return c.json(refusal("missing", "Not found."), 404);
    // A link previewer's fetch never opens a version; only a person's Open is a use.
    const kind = classify(c.req.header("user-agent")).kind;
    if (kind === "preview") return c.json(refusal("missing", "Not found."), 404);
    if (kind === "person") noteOwnerUse(access);
    // A copy start_version started that hasn't answered yet: a page that reloads itself until it does; a failed one says so.
    if (v.state === "starting") return c.html(STARTING_PAGE, 200, { Refresh: "3", "Cache-Control": "no-store", "Content-Security-Policy": PAGE_CSP });
    if (v.state === "failed") return c.text("This version didn't start. The team knows.", 409, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    const live = ownerAccess(token);
    const url = live.ok ? await openVersion(v, live.link).catch((err) => {
      console.warn(`[share] owner version on ${tokenTag(token)} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }) : null;
    if (!url) return c.text("This version isn't running right now. Go back and try again later.", 409, { "Content-Type": "text/plain; charset=utf-8" });
    return c.redirect(url, 302);
  });

  // Ask for a new link (§app.owner-page/link): only a link that turned off unused; at most once a day.
  app.post("/i/:token/ask-link", (c) => {
    const token = c.req.param("token");
    if (ownerTokenLimited(token)) return c.json(refusal("rate-limited", "Too many requests. Wait a minute."), 429);
    const r = askForNewLink(token);
    if (r.status === 202) {
      attentionChanged();
      return c.json({ ok: true, askedAt: r.askedAt }, 202);
    }
    if (r.status === 409) return c.json(refusal("live", "This link still works."), 409);
    return ownerDead(c, ownerAccess(token));
  });
  // The owner's own feature request chat (§app.project-assistant/feature-chats): their message, and End Chat. Only a
  // chat this person opened while they are the owner; anything else answers 404, as a handle that never existed.
  const featureRoute = (act: (orgId: string, personId: string, handle: string, body: Record<string, unknown>) => Promise<void>, keys: readonly string[]) => async (c: Context) => {
    const token = c.req.param("token") ?? "";
    const access = ownerAccess(token);
    if (!access.ok) return ownerDead(c, access);
    let body: unknown = {};
    if (keys.length)
      try {
        body = await c.req.json();
      } catch {
        return c.json(refusal("bad-request", "Expected JSON { text }."), 400);
      }
    if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some((k) => !keys.includes(k))) return c.json(refusal("bad-request", `Only { ${keys.join(", ")} } is accepted.`), 400);
    if (tokenLimited(token)) return c.json(refusal("rate-limited", "Too many messages. Wait a minute."), 429);
    try {
      await act(access.orgId, access.link.personId, c.req.param("handle") ?? "", body as Record<string, unknown>);
    } catch (err) {
      if (err instanceof OrgError) {
        if (err.code === "busy") return c.json(refusal("busy", "The chat can't take a message right now. Try again in a moment."), 503);
        if (err.status === 404) return c.json(refusal("missing", "Not found."), 404);
        return c.json(refusal(err.code ?? "refused", err.message), err.status === 400 ? (err.code === "too-long" ? 413 : 400) : 409);
      }
      console.warn(`[share] feature chat on ${tokenTag(token)} refused: ${err instanceof Error ? err.message : String(err)}`);
      return c.json(refusal("busy", "The chat can't take a message right now. Try again in a moment."), 503);
    }
    noteOwnerUse(access);
    return c.json({ ok: true }, 202);
  };
  // The owner's message: in their feature request chat, or their answer to a conversation that waits on them
  // (§app.owner-page/content, Answering on the page), taken as a hand-off link's would be.
  app.post(
    "/api/i/:token/c/:handle/message",
    featureRoute(async (orgId, personId, handle, body) => (await import("../owner-answer")).sendOwnerPageMessage(orgId, personId, handle, body.text), ["text"]),
  );
  app.post(
    "/api/i/:token/c/:handle/end",
    featureRoute(async (orgId, personId, handle) => {
      const f = await import("../feature-chats");
      await f.ownerEndsFeatureChat(orgId, f.ownersChatByHandle(orgId, personId, handle).sessionId);
    }, []),
  );
  // The owner closes or reopens their own request (§app.project-assistant/closing), by its page handle.
  app.post(
    "/api/i/:token/requests/:handle",
    featureRoute(async (orgId, personId, handle, body) => {
      await (await import("../owner-request-close")).ownerRequestAction(orgId, personId, handle, body.action);
    }, ["action"]),
  );
  app.get("/api/i/:token", ownerRead(() => ({})));
  app.get("/api/i/:token/p/:handle", ownerRead((c) => ({ project: c.req.param("handle") ?? "" })));
  app.get("/api/i/:token/c/:handle", ownerRead((c) => ({ conversation: c.req.param("handle") ?? "" })));

  // ---- session shares (§app/session-share): read-only ------------------------------------------

  mountSessionShareRoutes(app, shareDist, PAGE_CSP);
  mountPublicTourRoutes(app, PAGE_CSP);
  mountBatonTourRoutes(app);

  app.all("*", (c) => c.json({ error: "Not found" }, 404));
  return app;
}
