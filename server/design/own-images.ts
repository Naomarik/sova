// Your own images: pasted into the coordinator's box, or into the main chat and passed along. They join the same set
// as a capture's, under the same short names and the same limit, and need no site approval. Sova still never decodes
// them itself: the confined browser draws the small versions, with every connection refused.
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { DESIGN_ASSET_LIMITS, type DesignAsset, type DesignAssetSkipped } from "../../shared/design-assets";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { attachmentsRoot, checkTmpImage, isAttachmentPath, readTmpImage } from "../attachments";
import { chooseTourBrowser } from "../tours/browser";
import { resolveTourContext, tourCallerBySession } from "../tours/context";
import { sniffImage, sniffRaster } from "../tours/page-capture";
import { startRunnerProxy, type RunnerProxy } from "../tours/runner-proxy";
import { spawnTourCommand, killTourChild, type TourRecordingContext } from "../tours/sandbox";
import type { BrowseParent } from "./browse";
import { keepAsset, type DevelopedImage } from "./assets";
import { cleanPalette, type MeasuredColor } from "../tours/palette";

const paletteField = (p: MeasuredColor[] | undefined): { palette?: MeasuredColor[] } => (p ? { palette: p } : {});

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
          const m = JSON.parse(line) as { type?: string; i?: number; error?: string; width?: number; height?: number; full?: Part; small?: Part; describe?: Part; palette?: unknown };
          if (m.type === "ready") return feed();
          if (Number.isInteger(m.i) && m.i! >= 0 && m.i! < images.length) {
            results[m.i!] = m.error || !m.full || !m.small || !m.describe ? { error: m.error ?? "It couldn't be drawn." } : { width: Number(m.width), height: Number(m.height), full: part(m.full), small: part(m.small), describe: part(m.describe), ...paletteField(cleanPalette(m.palette)) };
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
export async function addOwnImages(parent: BrowseParent, images: readonly Uint8Array[], deps: { draw?: OwnImageDrawer; context?: (p: BrowseParent) => Promise<TourRecordingContext> } = {}, names: readonly string[] = []): Promise<OwnImagesResult> {
  const out: OwnImagesResult = { added: [], known: [], refused: [] };
  const usable: Uint8Array[] = [];
  const usableNames: string[] = [];
  for (const [i, bytes] of images.entries()) {
    const what = names[i] ?? `Image ${i + 1}`;
    if (bytes.length > DESIGN_ASSET_LIMITS.eachBytes) out.refused.push({ what, reason: "It's over the 8 MB limit." });
    else if (!sniffImage(bytes)) out.refused.push({ what, reason: "It isn't an image." });
    else usable.push(bytes), usableNames.push(what);
  }
  if (!usable.length) return out;
  const context = await (deps.context ?? contextOf)(parent);
  const drawn = await (deps.draw ?? drawInDarkroom)(context, usable);
  for (const [i, bytes] of usable.entries()) {
    const d = drawn[i];
    const what = usableNames[i]!;
    if (!d || "error" in d) { out.refused.push({ what, reason: d && "error" in d ? d.error : "It couldn't be drawn." }); continue; }
    if (!sniffRaster(d.full.bytes) || !sniffRaster(d.small.bytes) || sniffRaster(d.describe.bytes) !== "png") { out.refused.push({ what, reason: "It couldn't be drawn." }); continue; }
    const kept = keepAsset(parent.sessionId, { source: "yours", original: bytes, ...d, context: {} });
    if ("refused" in kept) out.refused.push({ what, reason: kept.refused });
    else (kept.isNew ? out.added : out.known).push(kept.asset);
  }
  return out;
}

/** A path as a refusal names it: as given, cut short when long. */
const named = (raw: string): string => (raw.length > 200 ? `${raw.slice(0, 199)}…` : raw);

/** Why a path given as an image wasn't taken, in words: one per reason. */
export const IMAGE_REFUSALS = {
  place: "It isn't in a place images are taken from.",
  missing: "There's no file there.",
  /** A sandboxed chat's /tmp is its own, not the one Sova reads. */
  missingTmp: "There's no file there in Sova's /tmp (if your /tmp is your sandbox's own, put the picture in your shared folder instead).",
  notImage: "It isn't an image (a PNG, JPEG, WebP or GIF).",
  tooBig: "It's over the 8 MB limit.",
  outside: "It leads outside the place it's in (a link elsewhere isn't followed).",
  unreadable: "It couldn't be read.",
} as const;

/** The places a chat's image paths are taken from, in words for a refusal's end. `shared`: the chat's own shared folder. */
export function imagePlacesLine(shared?: string): string {
  return `Images are taken from: a file directly in /tmp; Sova's attachments folder (${attachmentsRoot()}/<chat id>/)${shared ? `; and your shared folder (${shared}/, any folder below it)` : ""}.`;
}

const inside = (root: string, p: string): boolean => p.startsWith(`${root}/`);

/** A file in the chat's shared folder: a regular file whose real path stays inside the folder's real path, within the limit. */
async function readSharedImage(p: string, shared: string): Promise<{ bytes: Uint8Array } | { reason: string }> {
  const { realpath, open } = await import("node:fs/promises");
  const { constants } = await import("node:fs");
  let root: string;
  let real: string;
  try {
    root = await realpath(shared);
  } catch {
    return { reason: IMAGE_REFUSALS.missing };
  }
  try {
    real = await realpath(p);
  } catch {
    return { reason: IMAGE_REFUSALS.missing };
  }
  if (!inside(root, real)) return { reason: IMAGE_REFUSALS.outside };
  let fh;
  try {
    // Opened without following a link, and checked on the open handle: a swap after the check widens nothing.
    fh = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { reason: IMAGE_REFUSALS.unreadable };
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { reason: IMAGE_REFUSALS.notImage };
    if (st.size > DESIGN_ASSET_LIMITS.eachBytes) return { reason: IMAGE_REFUSALS.tooBig };
    const bytes = new Uint8Array(await fh.readFile());
    return sniffImage(bytes) ? { bytes } : { reason: IMAGE_REFUSALS.notImage };
  } finally {
    await fh.close();
  }
}

/** Why checkTmpImage refused a path that is in /tmp or the attachments folder, in IMAGE_REFUSALS' words. */
function tmpRefusal(check: Extract<ReturnType<typeof checkTmpImage>, { ok: false }>, hintShared: boolean, p: string): string {
  if (check.status === 404) return hintShared ? IMAGE_REFUSALS.missingTmp : IMAGE_REFUSALS.missing;
  if (check.status === 400) return IMAGE_REFUSALS.notImage;
  if (check.size !== undefined) return IMAGE_REFUSALS.tooBig;
  // Refused where it resolves: a link to a file in the same folder that isn't an image is no image; anywhere else is outside.
  try {
    return dirname(realpathSync(p)) === realpathSync(dirname(p)) ? IMAGE_REFUSALS.notImage : IMAGE_REFUSALS.outside;
  } catch {
    return IMAGE_REFUSALS.outside;
  }
}

const exists = async (p: string): Promise<boolean> => {
  const { lstat } = await import("node:fs/promises");
  return lstat(p).then(() => true, () => false);
};

/**
 * Read images named by path: a file directly in /tmp or in Sova's attachments folder, by the rule the attachment route
 * itself follows, or (`shared`, for the main chat's own hand-off) one in the chat's shared folder. An unreadable one is
 * listed by the path as given, with why; it is never fatal. `names`: each read image's path as given, in order.
 */
export async function readAttachedImages(paths: readonly string[], opts: { shared?: string; chatTmp?: string | null } = {}): Promise<{ images: Uint8Array[]; names: string[]; unreadable: DesignAssetSkipped[] }> {
  const images: Uint8Array[] = [];
  const names: string[] = [];
  const unreadable: DesignAssetSkipped[] = [];
  const shared = opts.shared?.replace(/\/+$/, "");
  for (const raw of paths) {
    const what = named(raw);
    const p = raw.trim();
    const inTmp = isAbsolute(p) && dirname(p) === "/tmp";
    const inAttachments = inside(attachmentsRoot(), p) || isAttachmentPath(p);
    // A sandboxed chat's /tmp is its own session tmp: a picture it saved there is read from that folder, by the same rules.
    if (opts.chatTmp && isAbsolute(p) && inside("/tmp", normalize(p))) {
      const own = join(opts.chatTmp, relative("/tmp", normalize(p)));
      if (await exists(own)) {
        const got = await readSharedImage(own, opts.chatTmp);
        if ("bytes" in got) images.push(got.bytes), names.push(what);
        else unreadable.push({ what, reason: got.reason });
        continue;
      }
    }
    if (shared && isAbsolute(p) && inside(shared, normalize(p)) && !inTmp && !inAttachments) {
      const got = await readSharedImage(normalize(p), shared);
      if ("bytes" in got) images.push(got.bytes), names.push(what);
      else unreadable.push({ what, reason: got.reason });
      continue;
    }
    const check = checkTmpImage(p);
    if (!check.ok) {
      unreadable.push({ what, reason: inTmp || inAttachments ? tmpRefusal(check, inTmp && !opts.chatTmp, p) : IMAGE_REFUSALS.place });
      continue;
    }
    const bytes = await readTmpImage(check.realPath);
    if (bytes) images.push(new Uint8Array(bytes)), names.push(what);
    else unreadable.push({ what, reason: IMAGE_REFUSALS.unreadable });
  }
  return { images, names, unreadable };
}

/** Read images the Creative Director names by path on disk (a logo it found with its read): each an image file within the
    size limit, read by its real path. The Creative Director reads anywhere, so this lets nothing new out; what it brings in
    joins the chat's set like a pasted image, and reaches designers only as that set's small versions. */
export async function readDiskImages(paths: readonly string[]): Promise<{ images: Uint8Array[]; unreadable: DesignAssetSkipped[] }> {
  const { realpath, stat, readFile } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { isAbsolute, join } = await import("node:path");
  const images: Uint8Array[] = [];
  const unreadable: DesignAssetSkipped[] = [];
  for (const raw of paths) {
    const what = raw.length > 200 ? `${raw.slice(0, 199)}…` : raw;
    const p = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
    if (!isAbsolute(p)) { unreadable.push({ what, reason: "Give its full path." }); continue; }
    try {
      const real = await realpath(p);
      const st = await stat(real);
      if (!st.isFile()) { unreadable.push({ what, reason: "It isn't a file." }); continue; }
      if (st.size > DESIGN_ASSET_LIMITS.eachBytes) { unreadable.push({ what, reason: "It's over the 8 MB limit." }); continue; }
      const bytes = new Uint8Array(await readFile(real));
      if (!sniffImage(bytes)) { unreadable.push({ what, reason: "It isn't an image." }); continue; }
      images.push(bytes);
    } catch {
      unreadable.push({ what, reason: "It couldn't be read." });
    }
  }
  return { images, unreadable };
}
