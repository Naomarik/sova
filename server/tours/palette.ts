// A picture's main colours, measured from its pixels with no model: what a pasted screenshot's swatches show. Pure, so
// it runs wherever the pixels are (the darkroom's confined child), and the server never decodes an image itself.

export interface MeasuredColor {
  /** #rrggbb. */
  hex: string;
  /** Of the picture's opaque pixels, 0..1, two decimals. */
  share: number;
}

export const PALETTE_LIMITS = Object.freeze({
  /** Colours kept. */
  colors: 6,
  /** The long edge the pixels are read at: plenty for a palette, and cheap to send. */
  edge: 128,
  /** A colour under this share is noise (anti-aliasing, a speck), never a theme colour. */
  minShare: 0.01,
  /** Two colours closer than this (RGB distance) are one. */
  merge: 28,
});

const hex2 = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

/**
 * The main colours of RGBA pixels: each pixel binned to 4 bits a channel, near bins merged (the larger keeps its place,
 * its colour the average of what joined it), the largest first. Transparent pixels don't count.
 */
export function paletteOf(rgba: ArrayLike<number>, max: number = PALETTE_LIMITS.colors): MeasuredColor[] {
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3]! < 128) continue;
    const r = rgba[i]!, g = rgba[i + 1]!, b = rgba[i + 2]!;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bin.n++;
    bin.r += r;
    bin.g += g;
    bin.b += b;
    bins.set(key, bin);
    total++;
  }
  if (!total) return [];
  const sorted = [...bins.values()].sort((x, y) => y.n - x.n);
  const kept: { n: number; r: number; g: number; b: number }[] = [];
  const mean = (c: { n: number; r: number; g: number; b: number }) => [c.r / c.n, c.g / c.n, c.b / c.n] as const;
  for (const bin of sorted) {
    const [r, g, b] = mean(bin);
    const near = kept.find((k) => {
      const [kr, kg, kb] = mean(k);
      return Math.hypot(kr - r, kg - g, kb - b) < PALETTE_LIMITS.merge;
    });
    if (near) {
      near.n += bin.n;
      near.r += bin.r;
      near.g += bin.g;
      near.b += bin.b;
    } else kept.push({ ...bin });
  }
  return kept
    .sort((x, y) => y.n - x.n)
    .filter((k) => k.n / total >= PALETTE_LIMITS.minShare)
    .slice(0, max)
    .map((k) => {
      const [r, g, b] = mean(k);
      return { hex: `#${hex2(r)}${hex2(g)}${hex2(b)}`, share: Math.round((k.n / total) * 100) / 100 };
    });
}

/** A palette as a message carries it: only well-formed colours, at most the limit. */
export function cleanPalette(v: unknown): MeasuredColor[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((c): c is MeasuredColor => !!c && typeof c === "object" && typeof (c as MeasuredColor).hex === "string" && /^#[0-9a-f]{6}$/.test((c as MeasuredColor).hex) && typeof (c as MeasuredColor).share === "number" && (c as MeasuredColor).share >= 0 && (c as MeasuredColor).share <= 1)
    .slice(0, PALETTE_LIMITS.colors)
    .map((c) => ({ hex: c.hex, share: c.share }));
  return out.length ? out : undefined;
}
