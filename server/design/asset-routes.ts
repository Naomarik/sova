// The page's routes for a chat's images. A small version or the catalogue is served to anyone who can read the chat;
// bringing images in or agreeing to a signed-in capture is the person's own click. Only rasters the confined browser
// drew are served as pictures. An original goes out only as a download, so a hostile SVG never runs on Sova's address.
import type { Context, Hono } from "hono";
import { isDesignAssetName, type DesignAssetShown } from "../../shared/design-assets";
import { isTourOrigin } from "../../shared/tour";
import { notPage } from "../page-only";
import { assetOf, noteSignedInConsent, rasterMime, readAssetPart, readAssets } from "./assets";
import type { BrowseParent } from "./browse";
import { addOwnImages, readAttachedImages, type OwnImagesResult } from "./own-images";
import { describeAssets } from "./describe";

const BAD_PATH = "Invalid or missing ?path= (must be a .jsonl under the pi sessions dir)";
const YOUR_CLICK = "Only your own click on the Design card in Sova's page answers this.";
const SHOWN: readonly DesignAssetShown[] = ["small", "full"];
const SEALED = { "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600", "Content-Security-Policy": "default-src 'none'; sandbox" };

let ownImageDeps: Parameters<typeof addOwnImages>[2] = {};
/** Tests only: draw pasted images without a browser. */
export const setOwnImageDepsForTest = (d: Parameters<typeof addOwnImages>[2] | null): void => void (ownImageDeps = d ?? {});

/** Bring images named by path into the chat's set. Shared by the coordinator's box and the main chat's hand-off. */
export async function addAttachedImages(p: BrowseParent, paths: readonly string[]): Promise<OwnImagesResult> {
  const { images, unreadable } = await readAttachedImages(paths);
  const out = await addOwnImages(p, images, ownImageDeps);
  if (out.added.length) describeAssets(p, out.added.map((x) => x.name));
  return { ...out, refused: [...unreadable, ...out.refused] };
}

/** One line for the coordinator about images just brought in: the names and what was left out, no picture. */
export async function ownImagesLine(p: BrowseParent, paths: readonly string[]): Promise<string> {
  const out = await addAttachedImages(p, paths);
  const names = [...out.added, ...out.known].map((a) => a.name);
  return [names.length ? `[The user added ${names.length === 1 ? "an image" : `${names.length} images`} of their own: ${names.join(", ")}. Their descriptions follow when they're ready.]` : "", ...out.refused.map((r) => `[${r.what} wasn't added: ${r.reason}]`)].filter(Boolean).join("\n");
}

export function mountDesignAssetRoutes(app: Hono, parentOf: (c: Context) => BrowseParent | null): void {
  app.get("/api/design/assets", (c) => {
    const p = parentOf(c);
    if (!p) return c.json({ error: BAD_PATH }, 400);
    return c.json(readAssets(p.sessionId), 200, { "Cache-Control": "no-store" });
  });

  app.post("/api/design/assets/own", async (c) => {
    if (notPage(c)) return c.json({ error: YOUR_CLICK }, 403);
    const p = parentOf(c);
    if (!p) return c.json({ error: BAD_PATH }, 400);
    const b = (await c.req.json().catch(() => null)) as { paths?: unknown } | null;
    if (!Array.isArray(b?.paths) || !b.paths.length || b.paths.length > 20 || !b.paths.every((x) => typeof x === "string")) return c.json({ error: "Expected { paths } naming up to 20 uploaded images." }, 400);
    try {
      return c.json(await addAttachedImages(p, b.paths as string[]));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Those images couldn't be added." }, 500);
    }
  });

  app.post("/api/design/assets/signed-in-consent", async (c) => {
    if (notPage(c)) return c.json({ error: YOUR_CLICK }, 403);
    const p = parentOf(c);
    if (!p) return c.json({ error: BAD_PATH }, 400);
    const b = (await c.req.json().catch(() => null)) as { origin?: unknown } | null;
    if (typeof b?.origin !== "string" || !isTourOrigin(b.origin)) return c.json({ error: "Expected the exact origin of the signed-in site." }, 400);
    noteSignedInConsent(p.sessionId, b.origin);
    return c.json({ ok: true });
  });

  app.get("/api/design/assets/:name/original", (c) => {
    const p = parentOf(c);
    if (!p) return c.json({ error: BAD_PATH }, 400);
    const name = c.req.param("name");
    const a = isDesignAssetName(name) ? assetOf(p.sessionId, name) : undefined;
    const bytes = a ? readAssetPart(p.sessionId, a, "original") : null;
    if (!a || !bytes) return c.json({ error: "No such image." }, 404);
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, { ...SEALED, "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${a.name}.${a.ext}"` });
  });

  app.get("/api/design/assets/:name/:shown", (c) => {
    const p = parentOf(c);
    if (!p) return c.json({ error: BAD_PATH }, 400);
    const name = c.req.param("name");
    const shown = c.req.param("shown") as DesignAssetShown;
    if (!isDesignAssetName(name) || !SHOWN.includes(shown)) return c.json({ error: "No such image." }, 404);
    const a = assetOf(p.sessionId, name);
    const bytes = a ? readAssetPart(p.sessionId, a, shown) : null;
    const mime = bytes && rasterMime(bytes);
    if (!a || !bytes || !mime) return c.json({ error: "No such image." }, 404);
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, { ...SEALED, "Content-Type": mime });
  });
}
