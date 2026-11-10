// Your own images: pasted into the coordinator's box, or into the main chat and passed along. They join the same set
// as a capture's, under the same short names and the same limit, and need no site approval. Sova still never decodes
// them itself: the confined browser draws the small versions, with every connection refused.
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { DESIGN_ASSET_LIMITS, type DesignAsset, type DesignAssetSkipped } from "../../shared/design-assets";
import { checkTmpImage, readTmpImage } from "../attachments";
import { chooseTourBrowser } from "../tours/browser";
import { resolveTourContext, tourCallerBySession } from "../tours/context";
import { sniffImage, sniffRaster } from "../tours/page-capture";
import { startRunnerProxy, type RunnerProxy } from "../tours/runner-proxy";
import { spawnTourCommand, killTourChild, type TourRecordingContext } from "../tours/sandbox";
import type { BrowseParent } from "./browse";
import { keepAsset, type DevelopedImage } from "./assets";

export interface OwnImagesResult {
  added: DesignAsset[];
  /** Images already in this chat keep their name and are listed here too. */
  known: DesignAsset[];
  refused: DesignAssetSkipped[];
}

type Drawn = Omit<DevelopedImage, "source" | "original" | "context">;
export type OwnImageDrawer = (context: TourRecordingContext, images: readonly Uint8Array[]) => Promise<(Drawn | { error: string })[]>;

const DRAW_MS = 90_000;
const refuseAll = async (): Promise<never> => { throw new Error("The darkroom opens no connections."); };

/** Launch the darkroom for these images and wait for all of them. Fails closed: no guard, no launch. */
export const drawInDarkroom: OwnImageDrawer = async (context, images) => {
  const browser = chooseTourBrowser(context.sandbox.on);
  let own: RunnerProxy | undefined;
  if (!context.sandbox.on) own = await startRunnerProxy({ admit: refuseAll });
  const child = await spawnTourCommand(context, [process.execPath, fileURLToPath(new URL("../tours/darkroom-child.ts", import.meta.url))], context.sandbox.on ? { forbid: () => true, admit: async () => false } : undefined, own?.url).catch(async (err) => { await own?.close(); throw err; });
  const proc = child.process;
  const results = new Array<Drawn | { error: string }>(images.length).fill({ error: "It couldn't be drawn." });
  try {
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => { killTourChild(proc, "SIGKILL"); fail(new Error("Drawing the images took too long.")); }, DRAW_MS);
      proc.once("error", (e) => { clearTimeout(timer); fail(e); });
      proc.once("close", () => { clearTimeout(timer); done(); });
      proc.stdin!.write(`${JSON.stringify(browser ? { browser } : {})}\n`);
      let next = 0;
      const feed = () => {
        if (next < images.length) proc.stdin!.write(`${JSON.stringify({ i: next, base64: Buffer.from(images[next]!).toString("base64") })}\n`), next++;
        else proc.stdin!.end();
      };
      createInterface({ input: proc.stdout! }).on("line", (line) => {
        try {
          const m = JSON.parse(line) as { type?: string; i?: number; error?: string; width?: number; height?: number; full?: Part; small?: Part; describe?: Part };
          if (m.type === "ready") return feed();
          if (Number.isInteger(m.i) && m.i! >= 0 && m.i! < images.length) {
            results[m.i!] = m.error || !m.full || !m.small || !m.describe ? { error: m.error ?? "It couldn't be drawn." } : { width: Number(m.width), height: Number(m.height), full: part(m.full), small: part(m.small), describe: part(m.describe) };
          }
          feed();
        } catch { killTourChild(proc, "SIGKILL"); }
      });
    });
  } finally {
    await child.dispose().catch(() => {});
    await own?.close();
  }
  return results;
};
interface Part { base64: string; w: number; h: number }
const part = (p: Part) => ({ bytes: new Uint8Array(Buffer.from(p.base64, "base64")), w: p.w, h: p.h });

const contextOf = async (parent: BrowseParent): Promise<TourRecordingContext> => {
  const { acquireChatHandle } = await import("../chat-handle");
  await acquireChatHandle(parent.path).catch(() => null);
  return resolveTourContext(await tourCallerBySession(parent.sessionId));
};

/** Bring in pictures you pasted. Each is refused or kept by itself; one bad image never costs the others. */
export async function addOwnImages(parent: BrowseParent, images: readonly Uint8Array[], deps: { draw?: OwnImageDrawer; context?: (p: BrowseParent) => Promise<TourRecordingContext> } = {}): Promise<OwnImagesResult> {
  const out: OwnImagesResult = { added: [], known: [], refused: [] };
  const usable: Uint8Array[] = [];
  for (const [i, bytes] of images.entries()) {
    const what = `Image ${i + 1}`;
    if (bytes.length > DESIGN_ASSET_LIMITS.eachBytes) out.refused.push({ what, reason: "It's over the 8 MB limit." });
    else if (!sniffImage(bytes)) out.refused.push({ what, reason: "It isn't an image." });
    else usable.push(bytes);
  }
  if (!usable.length) return out;
  const context = await (deps.context ?? contextOf)(parent);
  const drawn = await (deps.draw ?? drawInDarkroom)(context, usable);
  for (const [i, bytes] of usable.entries()) {
    const d = drawn[i];
    const what = `Image ${i + 1}`;
    if (!d || "error" in d) { out.refused.push({ what, reason: d && "error" in d ? d.error : "It couldn't be drawn." }); continue; }
    if (!sniffRaster(d.full.bytes) || !sniffRaster(d.small.bytes) || sniffRaster(d.describe.bytes) !== "png") { out.refused.push({ what, reason: "It couldn't be drawn." }); continue; }
    const kept = keepAsset(parent.sessionId, { source: "yours", original: bytes, ...d, context: {} });
    if ("refused" in kept) out.refused.push({ what, reason: kept.refused });
    else (kept.isNew ? out.added : out.known).push(kept.asset);
  }
  return out;
}

/** Read attachments named by path, by the rule the attachment route itself follows. An unreadable one is listed, not fatal. */
export async function readAttachedImages(paths: readonly string[]): Promise<{ images: Uint8Array[]; unreadable: DesignAssetSkipped[] }> {
  const images: Uint8Array[] = [];
  const unreadable: DesignAssetSkipped[] = [];
  for (const [i, p] of paths.entries()) {
    const check = checkTmpImage(p);
    const bytes = check.ok ? await readTmpImage(check.realPath) : null;
    if (bytes) images.push(new Uint8Array(bytes));
    else unreadable.push({ what: `Image ${i + 1}`, reason: "It couldn't be read." });
  }
  return { images, unreadable };
}
