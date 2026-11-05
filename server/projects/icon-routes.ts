import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { OrgError } from "../org-error";
import { isSenderSecret, OVERSEER_SENDER_HEADER } from "../overseer-sender";
import { IconError, iconBytes, iconInfo, removeUpload, saveUpload, setLetters, UPLOAD_MAX_BYTES } from "./icon";
import { readProject } from "./spaces";

/**
 * A project's icon (§app.projects/icon; shapes in shared/projects.ts). The picture is served fresh from disk as an inert
 * image (a CSP sandbox, nosniff); writes are the operator's own gesture on the page or a script, never the Overseer's.
 */

const NO_STORE = { "Cache-Control": "no-store" };

const handle =
  (fn: (c: Context) => Promise<Response> | Response) =>
  async (c: Context): Promise<Response> => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof IconError) return c.json({ error: err.message }, err.status);
      if (err instanceof OrgError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  };

/** The project's root, or a 404 for an unknown project. */
const rootOf = (c: Context): { pid: string; root: string } => {
  const pid = c.req.param("pid") ?? "";
  return { pid, root: readProject(pid).root };
};

/** Writes refuse the Overseer's in-process calls: choosing a project's picture is the operator's. */
const operatorOnly = (c: Context): Response | null => (isSenderSecret(c.req.header(OVERSEER_SENDER_HEADER)) ? c.json({ error: "Only you can change a project's icon." }, 403) : null);

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    if (typeof b === "object" && b !== null && !Array.isArray(b)) return b;
  } catch {}
  throw new IconError("Expected a JSON object body", 400);
}

export function registerIconRoutes(app: Hono<any>): void {
  app.get(
    "/api/projects/:pid/icon",
    handle((c) => {
      const { pid, root } = rootOf(c);
      const got = iconBytes(pid, root);
      if (!got) return c.json({ error: "This project shows its letters." }, 404, NO_STORE);
      const cache = c.req.query("v") === got.v ? "private, max-age=31536000, immutable" : "no-store";
      return new Response(new Uint8Array(got.bytes), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Cache-Control": cache,
        },
      });
    }),
  );
  app.get(
    "/api/projects/:pid/icon/info",
    handle((c) => {
      const { pid, root } = rootOf(c);
      return c.json(iconInfo(pid, root), 200, NO_STORE);
    }),
  );
  app.put(
    "/api/projects/:pid/icon",
    // A 1 MB PNG is ~1.37 MB of base64, plus the JSON around it.
    bodyLimit({ maxSize: Math.ceil((UPLOAD_MAX_BYTES * 4) / 3) + 1024, onError: (c) => c.json({ error: "The image is over 1 MB." }, 413) }),
    handle(async (c) => {
      const refused = operatorOnly(c);
      if (refused) return refused;
      const { pid, root } = rootOf(c);
      return c.json(saveUpload(pid, root, (await jsonBody(c)).png), 200, NO_STORE);
    }),
  );
  app.patch(
    "/api/projects/:pid/icon",
    handle(async (c) => {
      const refused = operatorOnly(c);
      if (refused) return refused;
      const { pid, root } = rootOf(c);
      return c.json(setLetters(pid, root, (await jsonBody(c)).letters), 200, NO_STORE);
    }),
  );
  app.delete(
    "/api/projects/:pid/icon",
    handle((c) => {
      const refused = operatorOnly(c);
      if (refused) return refused;
      const { pid, root } = rootOf(c);
      return c.json(removeUpload(pid, root), 200, NO_STORE);
    }),
  );
}
