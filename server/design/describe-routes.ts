// The page's routes for what is said about one image: Describe Again, and the user's own note and kind. Each is the
// user's click on the brief's image grid, and none of them starts a turn in any chat.
import type { Context, Hono } from "hono";
import { notPage } from "../page-only";
import type { DesignParent } from "./batch";
import { describeAgain, setAssetNote } from "./describe";

const BAD_PATH = "Invalid or missing ?path= (must be a .jsonl under the pi sessions dir)";
const YOUR_CLICK = "Only your own click on the image in Sova's page changes this.";

const orNull = (v: unknown): string | null | undefined => (typeof v === "string" || v === null ? v : undefined);

export function mountDescribeRoutes(app: Hono, parentOf: (c: Context) => DesignParent | null): void {
  app.post("/api/design/images/:name/describe", (c) => {
    if (notPage(c)) return c.json({ error: YOUR_CLICK }, 403);
    const p = parentOf(c);
    if (!p) return c.json({ error: BAD_PATH }, 400);
    try {
      describeAgain(p, c.req.param("name"));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  app.patch("/api/design/images/:name", async (c) => {
    if (notPage(c)) return c.json({ error: YOUR_CLICK }, 403);
    const p = parentOf(c);
    if (!p) return c.json({ error: BAD_PATH }, 400);
    let sent: Record<string, unknown>;
    try {
      sent = ((await c.req.json()) ?? {}) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Expected { note?, kind?, words? }." }, 400);
    }
    const note = orNull(sent.note);
    const kind = orNull(sent.kind);
    const words = sent.words;
    if (note === undefined && kind === undefined && words === undefined) return c.json({ error: "Expected { note?, kind?, words? }." }, 400);
    try {
      setAssetNote(p.sessionId, c.req.param("name"), { ...(note !== undefined ? { note } : {}), ...(kind !== undefined ? { kind } : {}), ...(words !== undefined ? { words } : {}) });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });
}
