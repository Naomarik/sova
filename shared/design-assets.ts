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

/** What a describing model said about an image. */
export interface DesignAssetDescription {
  kind: string;
  description: string;
  placement: string;
  usage: string;
  model?: string;
  at: string;
}

/** What a describing helper may call an image. The first four belong to the whole site, the rest to one page. */
export const DESIGN_ASSET_KINDS = ["logo", "icon", "background", "decorative", "hero", "product", "photo", "embed"] as const;
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
  /** The kind the user chose, over the helper's. */
  chosenKind?: string;
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
