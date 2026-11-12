// A chat's page assets on disk: <design folder>/assets/ holds catalogue.json and each image by the hash of its
// bytes, with the small versions the confined browser drew beside it. Removed only when the chat is deleted.
//
// The server never decodes an image: it reads the first bytes to know the type, and serves only the versions the
// confined browser drew. An original (which may be an SVG) leaves only as an attachment, so it can never run here.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DESIGN_ASSET_LIMITS, DESIGN_ASSET_SCHEME, isDesignAssetName, type DesignMeasuredColor, type DesignAsset, type DesignAssetCatalogue, type DesignAssetContext, type DesignAssetPart, type DesignAssetShown, type DesignAssetSize } from "../../shared/design-assets";
import { sniffImage, sniffRaster } from "../tours/page-capture";
import { announceDesignChange, designChatDeleted, designDirOf } from "./store";

interface Disk extends DesignAssetCatalogue {
  v: 1;
  /** Names given so far in this chat: never goes down, so a name is never given twice. */
  named: number;
}

const empty = (): Disk => ({ v: 1, named: 0, assets: [], captures: [], signedInConsent: [] });
const assetsDir = (sessionId: string): string => join(designDirOf(sessionId), "assets");
const catalogueFile = (sessionId: string): string => join(assetsDir(sessionId), "catalogue.json");
const SHA = /^[0-9a-f]{64}$/;

function readDisk(sessionId: string): Disk {
  try {
    const v = JSON.parse(readFileSync(catalogueFile(sessionId), "utf8")) as Disk;
    if (v?.v === 1 && Array.isArray(v.assets) && Number.isInteger(v.named)) return { ...empty(), ...v };
  } catch {
    // Nothing yet. A broken file reads as no images, and its files stay on disk until the chat goes.
  }
  return empty();
}

function writeDisk(sessionId: string, d: Disk): void {
  if (designChatDeleted(sessionId)) return;
  mkdirSync(assetsDir(sessionId), { recursive: true, mode: 0o700 });
  const f = catalogueFile(sessionId);
  writeFileSync(`${f}.tmp`, JSON.stringify(d), { mode: 0o600 });
  renameSync(`${f}.tmp`, f);
  announceDesignChange(sessionId);
}

/** The chat's images and captures, for reading only. */
export const readAssets = (sessionId: string): Readonly<DesignAssetCatalogue> => readDisk(sessionId);
export const assetOf = (sessionId: string, name: string): DesignAsset | undefined => (isDesignAssetName(name) ? readDisk(sessionId).assets.find((a) => a.name === name) : undefined);

/** Change the catalogue and save it. Synchronous, so two changes never interleave. */
export function changeAssets<T>(sessionId: string, fn: (c: DesignAssetCatalogue) => T): T {
  const d = readDisk(sessionId);
  const out = fn(d);
  writeDisk(sessionId, d);
  return out;
}

const partName = (a: Pick<DesignAsset, "sha256" | "ext">, part: DesignAssetPart): string => (part === "original" ? `${a.sha256}.${a.ext}` : `${a.sha256}.${part}`);

/** The file of one of an asset's parts: what the describers read (`describe`, a PNG) and the routes serve. */
export function assetPath(sessionId: string, a: Pick<DesignAsset, "sha256" | "ext">, part: DesignAssetPart): string {
  if (!SHA.test(a.sha256) || !/^[a-z]{3,4}$/.test(a.ext)) throw new Error("Not an asset of this chat.");
  return join(assetsDir(sessionId), partName(a, part));
}

export function readAssetPart(sessionId: string, a: Pick<DesignAsset, "sha256" | "ext">, part: DesignAssetPart): Uint8Array | null {
  try {
    return new Uint8Array(readFileSync(assetPath(sessionId, a, part)));
  } catch {
    return null;
  }
}

/** An image the browser has finished with: its original and the versions it drew. */
export interface DevelopedImage {
  source: DesignAsset["source"];
  original: Uint8Array;
  full: { bytes: Uint8Array; w: number; h: number };
  small: { bytes: Uint8Array; w: number; h: number };
  describe: { bytes: Uint8Array; w: number; h: number };
  width: number;
  height: number;
  context: DesignAssetContext;
  /** Its main colours, measured in the darkroom from the version it drew (a pasted image's); absent when not measured. */
  palette?: DesignMeasuredColor[];
}

const sizeOf = (v: DevelopedImage["full"]): DesignAssetSize => ({ w: v.w, h: v.h, bytes: v.bytes.length });
const chatBytes = (d: Disk): number => d.assets.reduce((n, a) => n + a.bytes + a.small.bytes + a.full.bytes + a.describe.bytes, 0);

function put(file: string, bytes: Uint8Array): void {
  writeFileSync(`${file}.tmp`, bytes, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** The reason an image can't be kept, or null. Refused on what its bytes are, whatever anyone said they were. */
export function developedProblem(v: DevelopedImage): string | null {
  if (v.original.length > DESIGN_ASSET_LIMITS.eachBytes) return "It's over the 8 MB limit.";
  if (!sniffImage(v.original)) return "It isn't an image.";
  if (v.describe.bytes.length && sniffRaster(v.describe.bytes) !== "png") return "It couldn't be drawn.";
  if (!sniffRaster(v.full.bytes) || !sniffRaster(v.small.bytes)) return "It couldn't be drawn.";
  return null;
}

/**
 * Keep one image. The same bytes keep their name and whatever was said about them; a new image gets the next
 * name. Refuses, naming why, an image that isn't one or that the chat has no room for.
 */
export function keepAsset(sessionId: string, v: DevelopedImage): { asset: DesignAsset; isNew: boolean } | { refused: string } {
  if (designChatDeleted(sessionId)) return { refused: "This chat was deleted." };
  const problem = developedProblem(v);
  if (problem) return { refused: problem };
  const sha256 = createHash("sha256").update(v.original).digest("hex");
  const d = readDisk(sessionId);
  const known = d.assets.find((a) => a.sha256 === sha256);
  if (known) {
    // Pasted again after palettes began: it gains the colours it was kept without.
    if (!known.palette && v.palette?.length) {
      known.palette = v.palette;
      writeDisk(sessionId, d);
    }
    return { asset: known, isNew: false };
  }
  const room = DESIGN_ASSET_LIMITS.chatBytes - chatBytes(d);
  if (v.original.length + v.full.bytes.length + v.small.bytes.length + v.describe.bytes.length > room) return { refused: "This chat has reached its 200 MB of images." };
  const kind = sniffImage(v.original)!;
  const asset: DesignAsset = {
    name: `a${++d.named}`,
    sha256,
    source: v.source,
    mime: kind.mime,
    ext: kind.ext,
    bytes: v.original.length,
    width: v.width,
    height: v.height,
    small: sizeOf(v.small),
    full: sizeOf(v.full),
    describe: sizeOf(v.describe),
    context: v.context,
    ...(v.palette?.length ? { palette: v.palette } : {}),
    addedAt: new Date().toISOString(),
  };
  mkdirSync(assetsDir(sessionId), { recursive: true, mode: 0o700 });
  put(assetPath(sessionId, asset, "original"), v.original);
  put(assetPath(sessionId, asset, "full"), v.full.bytes);
  put(assetPath(sessionId, asset, "small"), v.small.bytes);
  put(assetPath(sessionId, asset, "describe"), v.describe.bytes);
  d.assets.push(asset);
  writeDisk(sessionId, d);
  return { asset, isNew: true };
}

const MIME_OF = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const;
/** A drawn version's type, read from its bytes. Never an original's: only rasters the browser drew are shown. */
export const rasterMime = (bytes: Uint8Array): string | null => {
  const r = sniffRaster(bytes);
  return r ? MIME_OF[r] : null;
};

// ---- A page's names ----------------------------------------------------------------------------------------

const token = (): RegExp => new RegExp(`${DESIGN_ASSET_SCHEME}(a[1-9]\\d{0,3})(?![\\w-])`, "g");

/** The asset names a page uses, once each, in order. */
export function assetNamesIn(html: string): string[] {
  return [...new Set([...html.matchAll(token())].map((m) => m[1]!))];
}

/** Why a page names an image the chat doesn't have, or null; the message names the ones it may use. */
export function assetNamesProblem(sessionId: string, html: string): string | null {
  const used = assetNamesIn(html);
  if (!used.length) return null;
  const names = readDisk(sessionId).assets.map((a) => a.name);
  const have = new Set(names);
  const missing = used.filter((n) => !have.has(n));
  if (!missing.length) return null;
  return `This page names ${missing.slice(0, 5).map((n) => DESIGN_ASSET_SCHEME + n).join(", ")}, which ${missing.length === 1 ? "isn't" : "aren't"} one of this chat's images. ${names.length ? `Its images are ${names.slice(0, 40).join(", ")}.` : "This chat has no images."}`;
}

/** A page opened large stays within this, an image used over and over included. */
const SHOWN_BYTES: Record<DesignAssetShown, number> = { full: 24 * 1024 * 1024, small: 8 * 1024 * 1024 };
/** What stands in for a picture past the limit: one transparent pixel. */
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** Pictures in a chat's finished page, ready to draw. A name the chat doesn't have stays as written. */
export function showAssets(sessionId: string, html: string, size: DesignAssetShown): string {
  const used = assetNamesIn(html);
  if (!used.length) return html;
  const known = new Map(readDisk(sessionId).assets.map((a) => [a.name, a]));
  const uri = new Map<string, string | null>();
  let spent = 0;
  const limit = SHOWN_BYTES[size];
  const dataFor = (name: string, part: DesignAssetShown): string | null => {
    const a = known.get(name);
    if (!a) return null;
    const bytes = readAssetPart(sessionId, a, part);
    const mime = bytes && rasterMime(bytes);
    return bytes && mime ? `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` : null;
  };
  return html.replace(token(), (_whole, name: string) => {
    // The tools refuse a name the chat doesn't have; a page that got here another way shows nothing rather than a broken image.
    if (!known.has(name)) return PIXEL;
    if (!uri.has(name)) uri.set(name, dataFor(name, size));
    let d = uri.get(name) ?? null;
    if (d && spent + d.length > limit && size === "full") d = dataFor(name, "small");
    if (!d || spent + d.length > limit) return PIXEL;
    spent += d.length;
    return d;
  });
}

// ---- A capture's say-so ------------------------------------------------------------------------------------

export const signedInConsented = (sessionId: string, origin: string): boolean => readDisk(sessionId).signedInConsent.some((c) => c.origin === origin);

export function noteSignedInConsent(sessionId: string, origin: string): void {
  changeAssets(sessionId, (c) => {
    if (!c.signedInConsent.some((x) => x.origin === origin)) c.signedInConsent.push({ origin, at: new Date().toISOString() });
  });
}
