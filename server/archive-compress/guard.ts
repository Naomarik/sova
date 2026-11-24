/**
 * A compressed chat is never opened or read (§app.session-list/archive-compression "Never opened"): every
 * /api route asked about one, by a `path` in its query or its JSON body, answers 409 with the one
 * sentence. Clean Up's own route is the exception: it deletes a compressed chat. Free while nothing is
 * compressed (the store is checked first, from memory).
 */
import type { MiddlewareHandler } from "hono";
import { resolveSessionPath } from "../paths";
import { COMPRESSED_REFUSAL, compressedAt, compressedRows, isCompressedId } from "./store";

/** The routes that may name a compressed chat: Clean Up deletes it. */
const ALLOWED = new Set(["/api/sessions/cleanup"]);
/** The largest JSON body read for a path. */
const BODY_CAP = 64 * 1024;

/** True when `raw` names a compressed chat or one of its helpers' files: by its path or its session id, or
    a list of them (a `paths` body). */
export function namesCompressed(raw: unknown): boolean {
  if (Array.isArray(raw)) return raw.slice(0, 200).some(namesCompressed);
  if (typeof raw !== "string" || !raw) return false;
  if (isCompressedId(raw)) return true;
  if (!raw.endsWith(".jsonl")) return false;
  const path = resolveSessionPath(raw);
  return !!path && compressedAt(path) !== undefined;
}

export function compressedGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (compressedRows().size === 0 || ALLOWED.has(c.req.path)) return next();
    if (namesCompressed(c.req.query("path")) || namesCompressed(c.req.query("session")) || namesCompressed(c.req.query("sessionId"))) return c.json({ error: COMPRESSED_REFUSAL }, 409);
    const type = c.req.header("content-type") ?? "";
    // A path field never needs much: a big body (an upload, a long draft) is never parsed twice.
    const length = Number(c.req.header("content-length") ?? "0");
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && type.includes("application/json") && !(length > BODY_CAP)) {
      let body: unknown;
      try {
        body = JSON.parse(await c.req.raw.clone().text());
      } catch {
        return next(); // the route answers a bad body itself
      }
      const b = body as { path?: unknown; paths?: unknown; session?: unknown; sessionId?: unknown; sessionPath?: unknown } | null;
      if (b && typeof b === "object" && [b.path, b.paths, b.session, b.sessionId, b.sessionPath].some(namesCompressed)) return c.json({ error: COMPRESSED_REFUSAL }, 409);
    }
    return next();
  };
}
