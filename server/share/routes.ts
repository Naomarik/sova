import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { Hono } from "hono";
import { SHARE_TEXT_MAX } from "../../shared/baton";
import { BudgetSpent, linkAccess, noteMessage, sessionPathOf, undoNote } from "../baton";
import { findLink, tokenTag } from "../baton-links";
import { budgetStop, recordNoted } from "../baton-loadout";
import { acquireChat } from "../chat-manager";
import { OrgError } from "../orgs";
import { refreshShare, viewForToken } from "./hub";
import { classify, recordOpen, recordRefused, recordShellFetch } from "../visits";

/**
 * The share listener's whole API (§app.baton/share-listener). Its own Hono app: nothing of the
 * operator app is registered here, so a route missing from this file does not exist on the share
 * port. The listener (server/share/listener.ts) has already refused every path outside the allowlist
 * before a request gets here.
 */

/** The share page's own build (vite build --mode share). Never the operator app's dist/. */
export const SHARE_DIST = resolve(import.meta.dirname, "..", "..", "dist-share");

export const MESSAGES_PER_MINUTE = 10;
const perToken = new Map<string, number[]>();

/** Visit logging (server/visits.ts) never fails or delays a request past its own write. */
export function logVisit(token: string, what: string, fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    console.warn(`[share] visit log (${what}) on ${tokenTag(token)} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Sliding one-minute window per token; true when this message is over the limit. Tokens with no
    message inside the window are dropped on the way, so the map holds only recent writers. */
export function tokenLimited(token: string, now = Date.now()): boolean {
  for (const [k, v] of perToken) if (k !== token && !v.some((t) => now - t < 60_000)) perToken.delete(k);
  const recent = (perToken.get(token) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= MESSAGES_PER_MINUTE) {
    perToken.set(token, recent);
    return true;
  }
  recent.push(now);
  perToken.set(token, recent);
  return false;
}

/** How many tokens the per-token window holds (tests). */
export const tokenWindowSize = (): number => perToken.size;

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  // The token is in the URL: never send it anywhere as a referrer.
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};
const PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
};

const refusal = (code: string, message: string) => ({ error: message, code });

export function createShareApp(): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v);
  });

  app.get("/h/assets/:name", (c) => {
    const name = c.req.param("name");
    const file = join(SHARE_DIST, "assets", name);
    if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name) || !existsSync(file)) return c.json({ error: "Not found" }, 404);
    return c.body(readFileSync(file), 200, { "Content-Type": MIME[extname(name)] ?? "application/octet-stream" });
  });

  app.get("/h/:token", (c) => {
    const index = join(SHARE_DIST, "index.html");
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
      return c.json(view.status === 410 ? refusal("gone", "This link is no longer active.") : refusal("not-found", "Unknown link."), view.status);
    }
    logVisit(token, "open", () => {
      const link = findLink(token);
      if (link) recordOpen(link, { tab: c.req.query("v"), userAgent: ua });
    });
    return c.json(view);
  });

  app.post("/api/h/:token/message", async (c) => {
    const token = c.req.param("token");
    const access = linkAccess(token);
    if (!access.ok) return c.json(access.status === 410 ? refusal("gone", "This link is no longer active.") : refusal("not-found", "Unknown link."), access.status);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(refusal("bad-request", "Expected JSON { text }."), 400);
    }
    // Only { text }: no sender, no images, nothing else. The sender IS the token's person.
    if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some((k) => k !== "text"))
      return c.json(refusal("bad-request", "Only { text } is accepted."), 400);
    const text = typeof (body as { text?: unknown }).text === "string" ? (body as { text: string }).text.trim() : "";
    if (!text) return c.json(refusal("bad-request", "Write something first."), 400);
    if (text.length > SHARE_TEXT_MAX) return c.json(refusal("too-long", `Messages are limited to ${SHARE_TEXT_MAX} characters.`), 413);
    if (text.startsWith("/")) return c.json(refusal("bad-request", "Messages can't start with /."), 400);
    const sessionId = access.row.sessionId;
    const limit = (message: string) => {
      // At the limit the baton goes to the operator and the session needs them (§app.baton/goal-and-loadout).
      void budgetStop(sessionId);
      return c.json(refusal("budget", message), 409);
    };
    if (access.reason === "budget") return limit(new BudgetSpent().message);
    if (!access.canWrite) return c.json(refusal(access.reason ?? "not-holder", "It's not your turn in this conversation right now."), 409);
    if (tokenLimited(token)) return c.json(refusal("rate-limited", "Too many messages. Wait a minute."), 429);
    const by = access.link.personId;
    const busy = (err: unknown) => {
      console.warn(`[share] message on ${tokenTag(token)} refused: ${err instanceof Error ? err.message : String(err)}`);
      return c.json(refusal("busy", "The conversation can't take a message right now. Try again in a moment."), 503);
    };
    // Nothing is counted or claimed until the runtime is open and would take the message.
    let chat;
    try {
      chat = await acquireChat(sessionPathOf(access.dir, access.row));
      chat.assertModelAllowed();
    } catch (err) {
      return busy(err);
    }
    // From here to the hand-over, one synchronous stretch: nothing interleaves. The lock
    // (§app.baton/offers-and-leases): noteMessage decides whether this message may enter — and on
    // an open offer, that this sender now holds it; a runtime refusal then undoes exactly that.
    let noted;
    try {
      noted = noteMessage(sessionId, by);
    } catch (err) {
      if (err instanceof BudgetSpent) return limit(err.message);
      if (err instanceof OrgError) {
        const now = linkAccess(token);
        return c.json(refusal(now.ok && now.reason ? now.reason : "not-holder", err.message), err.status === 404 ? 404 : 409);
      }
      throw err;
    }
    try {
      const r = chat.acceptPrompt(text, undefined, "server", undefined, { sentByBaton: { by } });
      void r.turn.catch((err) => chat.reportTurnFailure(err));
    } catch (err) {
      undoNote(sessionId, noted);
      return busy(err);
    }
    recordNoted(chat, by, noted);
    refreshShare(sessionId);
    return c.json({ ok: true }, 202);
  });

  app.all("*", (c) => c.json({ error: "Not found" }, 404));
  return app;
}
