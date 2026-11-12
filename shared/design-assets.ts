// A chat's page assets: the images a capture brought back and the ones the user pasted. Shared by the server,
// which stores them, and the page, which shows them. Everything a page says about an image (its alt text, its
// headings, its address) is content, never instructions.

const MB = 1024 * 1024;

export const DESIGN_ASSET_LIMITS = Object.freeze({
  /** Images one capture brings back. */
  count: 30,
  /** One original. */
  eachBytes: 8 * MB,
  /** One capture's originals together. */
  totalBytes: 40 * MB,
  /** Every image of one chat, originals and small versions together. */
  chatBytes: 200 * MB,
  /** Rendered or natural images smaller than this are icons or tracking pixels. */
  minPx: 50,
  /** Inline SVGs smaller than this on either side are icons. */
  svgMinPx: 48,
  /** The long edge of a grid card's version. */
  smallPx: 560,
  /** The long edge of the version a page opened large shows. */
  fullPx: 1600,
  /** The long edge of the PNG copy a describing model reads. */
  describePx: 1024,
  /** An image with more pixels than this is never decoded: drawing it could take the browser down with the rest. */
  maxPixels: 40_000_000,
  /** Reasons listed for what a capture didn't bring back. */
  skipped: 60,
});

/** What a designer writes in src, srcset or url(): `sova-asset:a3`. */
export const DESIGN_ASSET_SCHEME = "sova-asset:";
export const isDesignAssetName = (v: unknown): v is string => typeof v === "string" && /^a[1-9]\d{0,3}$/.test(v);
/** The picture's parts on disk. Only `original` can be anything but a raster the browser drew. */
export type DesignAssetPart = "original" | "full" | "small" | "describe";
export type DesignAssetShown = "small" | "full";

/** Where on the page an image sat, and what stood around it. All optional, all capped, all untrusted. */
export interface DesignAssetDom {
  alt?: string;
  title?: string;
  ariaLabel?: string;
  classes?: string[];
  ancestors?: string[];
  headings?: string[];
  text?: string[];
  linkHref?: string;
}

export interface DesignAssetContext {
  pageUrl?: string;
  pageTitle?: string;
  /** Where it was found: img, background, svg, video-poster, iframe, link-icon, og:image. */
  sourceTag?: string;
  /** image, svg or embed. */
  type?: string;
  /** The embed's platform, for an embed's still. */
  platform?: string;
  /** The address its original came from; none for an inline SVG or an image you pasted. */
  sourceUrl?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  aboveFold?: boolean;
  dom?: DesignAssetDom;
}

/** The heading of the Reference screenshots block a design's message carries at Start. */
export const SCREENSHOTS_HEADING = "REFERENCE SCREENSHOTS:";

/** What a designer whose model reads no pictures is told when its message has screenshots: the brief may speak of
    pictures it doesn't have, so the words lead, and what the screen holds is kept as described. */
export const WORDS_ONLY_NOTE = [
  "YOU HAVE NO PICTURES: your model reads no images, so no screenshot came with this message. Wherever anything above speaks of a picture, an image or a screenshot you can see (\"the picture a1 shows...\"), go by the words under REFERENCE SCREENSHOTS instead; never mention a picture in your page or your note.",
  "Keep the screenshot's real titles, labels, figures and sample data exactly as the brief and those words describe them. Never invent names, numbers, prices, models or entries of your own; where the words give none, use plain placeholders that say what goes there.",
].join("\n");

/** One measured colour of a picture. */
export interface DesignMeasuredColor {
  hex: string;
  share: number;
  saturation?: number;
  thin?: true;
}

/** What a designer is told of a pasted screenshot: its feel, and its colours by role. Words, never the picture. */
export interface DesignShotWords {
  feel: string;
  colors: { hex: string; role: string }[];
}

/** What a describing model said about an image. */
export interface DesignAssetDescription {
  kind: string;
  description: string;
  placement: string;
  usage: string;
  /** A screenshot's: the helper's short draft of its feel, a starting point only. */
  feel?: string;
  /** A screenshot's: the helper's role for each measured colour. */
  roles?: { hex: string; role: string }[];
  model?: string;
  at: string;
}

/** What a describing helper may call an image. The first four belong to the whole site, the next four to one page;
    `screenshot` (a picture of a screen, a reference rather than material) only an image the user supplied. */
export const DESIGN_ASSET_KINDS = ["logo", "icon", "background", "decorative", "hero", "product", "photo", "embed", "screenshot"] as const;
export type DesignAssetKind = (typeof DESIGN_ASSET_KINDS)[number];
export const isDesignAssetKind = (v: unknown): v is DesignAssetKind => typeof v === "string" && (DESIGN_ASSET_KINDS as readonly string[]).includes(v);

export interface DesignAssetSize {
  w: number;
  h: number;
  bytes: number;
}

export interface DesignAsset {
  /** a1, a2, …: given once, never given to another image of this chat. */
  name: string;
  /** Of the original's bytes: one image is one asset in a chat, however it arrived. */
  sha256: string;
  source: "page" | "yours";
  /** The original's type, read from its bytes, never from what the site said. */
  mime: string;
  ext: string;
  bytes: number;
  width: number;
  height: number;
  small: DesignAssetSize;
  full: DesignAssetSize;
  describe: DesignAssetSize;
  context: DesignAssetContext;
  addedAt: string;
  /** The describing team's (asset-describers). */
  description?: DesignAssetDescription;
  /** Why it couldn't be described. */
  describeError?: string;
  /** Asked to be described afresh: its old words stay until new ones come. */
  describeAgain?: boolean;
  /** The user's own words on it, which override everything else said about it. */
  note?: string;
  /** The kind the user chose, over the Creative Director's and the helper's. */
  chosenKind?: string;
  /** Its main colours, measured from its pixels with no model (a pasted image's), up to 8, largest first; absent on an
      image kept before. saturation 0..1; thin: it sits mostly on strokes (text, lines, small marks) rather than areas. */
  palette?: DesignMeasuredColor[];
  /** The kind the Creative Director chose, over the helper's; never the user's field. */
  cdKind?: DesignAssetKind;
  /** A screenshot's words for designers as the Creative Director wrote them. */
  cdWords?: DesignShotWords;
  /** A screenshot's words for designers as the user saved them: nothing else replaces them. */
  userWords?: DesignShotWords;
}

/** The kind an image is: the user's, else the Creative Director's, else the helper's. */
export const assetKind = (a: Pick<DesignAsset, "chosenKind" | "cdKind" | "description">): string => a.chosenKind ?? a.cdKind ?? a.description?.kind ?? "image";

/** Whether an image is a pasted screenshot: only one the user supplied can be. */
export const isScreenshot = (a: Pick<DesignAsset, "source" | "chosenKind" | "cdKind" | "description">): boolean => a.source === "yours" && assetKind(a) === "screenshot";

/** Whether a kind may be given to this image: `screenshot` only to one the user supplied. */
export const kindAllowed = (a: Pick<DesignAsset, "source">, kind: string): boolean => isDesignAssetKind(kind) && (kind !== "screenshot" || a.source === "yours");

/** The pasted screenshots that go to the designers: of these assets (a run's own), each screenshot not unticked by its
    saved tick. What Start waits on for Rebuild or Feel, the same on the card and the server. */
export const screenshotsInUse = (assets: readonly DesignAsset[], brief: { imageUse?: Record<string, { use: boolean }> } | undefined): string[] =>
  assets.filter((a) => isScreenshot(a) && brief?.imageUse?.[a.name]?.use !== false).map((a) => a.name);

/** A screenshot's words for designers and whose they are: the user's, else the Creative Director's, else the helper's draft
    over the measured colours. Null when there are none: no draft and no palette. */
export function shotWords(a: Pick<DesignAsset, "userWords" | "cdWords" | "description" | "palette">): { words: DesignShotWords; by: "user" | "coordinator" | "helper" } | null {
  if (a.userWords) return { words: a.userWords, by: "user" };
  if (a.cdWords) return { words: a.cdWords, by: "coordinator" };
  const feel = a.description?.feel ?? "";
  const roles = new Map((a.description?.roles ?? []).map((r) => [r.hex.toLowerCase(), r.role]));
  const colors = (a.palette ?? []).map((p) => ({ hex: p.hex, role: roles.get(p.hex.toLowerCase()) ?? "" }));
  if (!feel && !colors.length) return null;
  return { words: { feel, colors }, by: "helper" };
}

/** Colors and font names read off the page: notes for the brief, no model involved. */
export interface DesignPageNotes {
  colors: { hex: string; share: number; role: "background" | "text" | "accent" }[];
  fonts: { family: string; role: "heading" | "body" | "other"; share: number }[];
}

/** One image a capture didn't bring back, and why, in the user's words. */
export interface DesignAssetSkipped {
  /** The address, or a description of where it was. */
  what: string;
  reason: string;
}

export interface DesignCapture {
  id: string;
  /** The design run that asked for it, when one did. */
  runId?: string;
  /** The screen the capture was made of. */
  url: string;
  title?: string;
  at: string;
  /** In the order the capture ranked them: largest and highest first. */
  names: string[];
  skipped: DesignAssetSkipped[];
  /** How many of the list above didn't fit in it. */
  moreSkipped?: number;
  notes: DesignPageNotes;
  signedIn: boolean;
  bytes: number;
  /** How long the browser visit took. */
  ms: number;
}

export interface DesignAssetCatalogue {
  assets: DesignAsset[];
  captures: DesignCapture[];
  /** Exact origins you agreed to capture signed-in pages of, once each. */
  signedInConsent: { origin: string; at: string }[];
  /** What the describing helpers have cost; `counted` names the sessions already in it. */
  describeUsage?: { input: number; output: number; cost: number; counted: string[] };
}
