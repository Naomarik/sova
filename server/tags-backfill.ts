import { type Context, Hono } from "hono";
import { cleanUserTags, setUserTags } from "./session-tags";

/**
 * The session tags route: the user's own manual tags (§app.decisions/session-tags). The automatic
 * tags, their live pass and their backfill job are retired (§app.decisions/backfill): nothing here
 * asks a decision provider, and a job file left by an older server is never resumed.
 */

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = await c.req.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Mounted at /api/sessions/tags:
 *   POST /   {id, user: string[] | null} → { tags: SessionTags | null }
 */
export const tagRoutes = new Hono();

tagRoutes.post("/", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json({ error: "Expected JSON body { id, user }" }, 400);
  if (typeof body.id !== "string" || !body.id) return c.json({ error: "id must be a session id" }, 400);
  let user: string[] | null = null;
  if (body.user !== null) {
    const clean = cleanUserTags(body.user);
    if (typeof clean === "string") return c.json({ error: clean }, 400);
    user = clean;
  }
  const tags = setUserTags(body.id, user);
  return c.json({ tags: tags ?? null });
});
