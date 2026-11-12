// A picture's main colours, measured from its pixels with no model: what a pasted screenshot's swatches show. Pure, so
// it runs wherever the pixels are (the darkroom's confined child), and the server never decodes an image itself.
//
// A screen's look lives as much in its small colours as in its large ones: an accent on a 2px tab underline, a status
// colour on a few labels, the text. So neutrals and saturated colours are clustered apart, saturated ones keep slots of
// their own however small, and the text colour is found by contrast with the background on thin strokes.

export interface MeasuredColor {
  /** #rrggbb. */
  hex: string;
  /** Of the picture's opaque pixels, 0..1, three decimals. */
  share: number;
  /** How colourful it is, 0 (grey) to 1, two decimals. */
  saturation?: number;
  /** It sits mostly on thin strokes (text, lines, borders, small marks) rather than filling areas. */
  thin?: true;
}

export const PALETTE_LIMITS = Object.freeze({
  /** Colours kept. */
  colors: 8,
  /** The long edge the pixels are read at, at most: a screenshot near its own size, so a 2px line stays whole pixels. */
  edge: 1600,
  /** A neutral under this share is noise or anti-aliasing, unless it is the text colour. */
  neutralShare: 0.01,
  /** A saturated colour needs only this share, and this many pixels: an accent may be a single thin line. */
  saturatedShare: 0.00001,
  saturatedPixels: 24,
  /** Slots kept for saturated colours, at most. */
  saturatedSlots: 3,
  /** RGB chroma (max - min channel, 0..255) at or above which a colour is saturated. */
  chroma: 48,
  /** Two neutrals closer than this (RGB distance) are one; saturated ones are one within this many degrees of hue, so a
      line's anti-aliased edge joins its colour. */
  mergeNeutral: 10,
  mergeHue: 20,
  /** Text candidates merge loosely: anti-aliased strokes spread one colour over many shades. */
  mergeText: 28,
  /** The text colour: at least this luminance contrast with the background, and mostly on strokes. */
  textContrast: 0.25,
  textShare: 0.002,
  /** A colour with at least this share of its pixels on an edge (a neighbour of another colour) is thin. */
  thinEdges: 0.5,
});

const hex2 = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

interface Cluster {
  n: number;
  r: number;
  g: number;
  b: number;
  edges: number;
  saturated: boolean;
  /** Its largest bin's colour: for a thin colour, the stroke's core rather than its blend into the background. */
  peak: readonly [number, number, number];
  /** The bins it was made of, largest first. */
  members?: Cluster[];
}

const meanOf = (c: Pick<Cluster, "n" | "r" | "g" | "b">) => [c.r / c.n, c.g / c.n, c.b / c.n] as const;
const chromaOf = (rgb: readonly [number, number, number]): number => Math.max(...rgb) - Math.min(...rgb);
const lumaOf = ([r, g, b]: readonly [number, number, number]): number => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
function hueOf([r, g, b]: readonly [number, number, number]): number {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 0;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
/** A saturated cluster's truest shade: of its bins with a real count (not a speck), the most colourful. Blends into the
    background are duller, so the stroke's own colour wins. */
function purest(c: Cluster): readonly [number, number, number] {
  const members = c.members ?? [c];
  const floor = Math.max(3, members[0]!.n * 0.15);
  return members.filter((m) => m.n >= floor).reduce((best, m) => (chromaOf(m.peak) > chromaOf(best) ? m.peak : best), members[0]!.peak);
}
/** A text group's own shade: of its bins with a real count, the one furthest from the background in lightness. A
    stroke's edges blend toward the background, so its core is the starkest. */
function starkest(c: Cluster, bgLuma: number): readonly [number, number, number] {
  const members = c.members ?? [c];
  const floor = Math.max(3, members[0]!.n * 0.15);
  return members.filter((m) => m.n >= floor).reduce((best, m) => (Math.abs(lumaOf(m.peak) - bgLuma) > Math.abs(lumaOf(best) - bgLuma) ? m.peak : best), members[0]!.peak);
}
const hueGap = (a: number, b: number): number => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

/**
 * The main colours of RGBA pixels (`width` wide, for telling strokes from areas), largest first: up to 5 neutral areas
 * at 1% or more, the text colour, and up to 3 saturated colours however small, then whatever is largest of the rest.
 * Transparent pixels don't count.
 */
export function paletteOf(rgba: ArrayLike<number>, width = 0, max: number = PALETTE_LIMITS.colors): MeasuredColor[] {
  const count = Math.floor(rgba.length / 4);
  const keys = new Int32Array(count).fill(-1);
  const bins = new Map<number, Cluster>();
  let total = 0;
  for (let p = 0; p < count; p++) {
    const i = p * 4;
    if (rgba[i + 3]! < 128) continue;
    const r = rgba[i]!, g = rgba[i + 1]!, b = rgba[i + 2]!;
    // 5 bits a channel: fine enough that a page and the surface on it stay apart.
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    keys[p] = key;
    const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0, edges: 0, saturated: false, peak: [0, 0, 0] as const };
    bin.n++;
    bin.r += r;
    bin.g += g;
    bin.b += b;
    bins.set(key, bin);
    total++;
  }
  if (!total) return [];
  // A pixel on an edge has a 4-neighbour of a different colour: what strokes are made of.
  if (width > 0) {
    const height = Math.floor(count / width);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const k = keys[p]!;
        if (k < 0) continue;
        const differs = (q: number) => keys[q]! >= 0 && keys[q] !== k;
        if ((x > 0 && differs(p - 1)) || (x < width - 1 && differs(p + 1)) || (y > 0 && differs(p - width)) || (y < height - 1 && differs(p + width))) bins.get(k)!.edges++;
      }
  }
  for (const bin of bins.values()) {
    bin.peak = meanOf(bin);
    bin.saturated = chromaOf(bin.peak) >= PALETTE_LIMITS.chroma;
  }
  const sortedBins = [...bins.values()].sort((x, y) => y.n - x.n);
  /** Bins merged into clusters, largest first: a bin joins the first cluster `near` says it belongs to. */
  const clusterOf = (list: readonly Cluster[], near: (c: Cluster, bin: Cluster) => boolean): Cluster[] => {
    const out: Cluster[] = [];
    for (const bin of list) {
      const c = out.find((x) => near(x, bin));
      if (c) {
        c.n += bin.n;
        c.r += bin.r;
        c.g += bin.g;
        c.b += bin.b;
        c.edges += bin.edges;
        c.members!.push(bin);
      } else out.push({ ...bin, members: [bin] });
    }
    return out.sort((x, y) => y.n - x.n);
  };
  const clusters = clusterOf(sortedBins, (c, bin) => c.saturated === bin.saturated && (bin.saturated ? hueGap(hueOf(c.peak), hueOf(bin.peak)) < PALETTE_LIMITS.mergeHue : dist(meanOf(c), bin.peak) < PALETTE_LIMITS.mergeNeutral));
  const share = (c: Cluster) => c.n / total;
  const thin = (c: Cluster) => width > 0 && c.edges / c.n >= PALETTE_LIMITS.thinEdges;
  const picked = new Set<Cluster>();
  const background = clusters[0]!;
  const neutrals = clusters.filter((c) => !c.saturated && share(c) >= PALETTE_LIMITS.neutralShare).slice(0, 5);
  for (const c of neutrals) picked.add(c);
  // The text: neutral shades far from the background in lightness, merged loosely (strokes are anti-aliased), the
  // largest such group, told by its purest shade.
  const bgLuma = lumaOf(meanOf(background));
  const contrasting = sortedBins.filter((b) => !b.saturated && Math.abs(lumaOf(b.peak) - bgLuma) >= PALETTE_LIMITS.textContrast);
  const textGroups = clusterOf(contrasting, (c, bin) => dist(c.peak, bin.peak) < PALETTE_LIMITS.mergeText).filter((c) => share(c) >= PALETTE_LIMITS.textShare && (width === 0 || thin(c)) && !neutrals.some((n) => dist(n.peak, c.peak) < PALETTE_LIMITS.mergeNeutral));
  // The most text, and the strongest contrast (primary text, where the most is muted): one or two colours.
  const strongest = [...textGroups].sort((x, y) => Math.abs(lumaOf(y.peak) - bgLuma) - Math.abs(lumaOf(x.peak) - bgLuma))[0];
  const texts = new Set([textGroups[0], strongest].filter((c): c is Cluster => !!c));
  const text = textGroups[0];
  for (const t of texts) picked.add(t);
  const saturated = clusters.filter((c) => c.saturated && share(c) >= PALETTE_LIMITS.saturatedShare && c.n >= PALETTE_LIMITS.saturatedPixels).slice(0, PALETTE_LIMITS.saturatedSlots);
  for (const c of saturated) picked.add(c);
  for (const c of clusters) {
    if (picked.size >= max) break;
    if (share(c) >= PALETTE_LIMITS.neutralShare) picked.add(c);
  }
  // Keep the slots' colours when trimming: the largest neutral areas give way first.
  let kept = [...picked];
  while (kept.length > max) {
    const drop = [...kept].reverse().find((c) => !c.saturated && !texts.has(c) && c !== background) ?? kept.at(-1)!;
    kept = kept.filter((c) => c !== drop);
  }
  return kept
    .sort((x, y) => y.n - x.n)
    .map((c) => {
      // A saturated colour and the text by their core shade; an area by its average.
      const rgb = c.saturated ? purest(c) : texts.has(c) ? starkest(c, bgLuma) : meanOf(c);
      return {
        hex: `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}`,
        share: Math.max(0.001, Math.round(share(c) * 1000) / 1000),
        saturation: Math.round((chromaOf(rgb) / 255) * 100) / 100,
        ...(thin(c) ? { thin: true as const } : {}),
      };
    });
}

/** A palette as a message carries it: only well-formed colours, at most the limit. */
export function cleanPalette(v: unknown): MeasuredColor[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((c): c is MeasuredColor => !!c && typeof c === "object" && typeof (c as MeasuredColor).hex === "string" && /^#[0-9a-f]{6}$/.test((c as MeasuredColor).hex) && typeof (c as MeasuredColor).share === "number" && (c as MeasuredColor).share >= 0 && (c as MeasuredColor).share <= 1)
    .slice(0, PALETTE_LIMITS.colors)
    .map((c) => ({
      hex: c.hex,
      share: c.share,
      ...(typeof c.saturation === "number" && c.saturation >= 0 && c.saturation <= 1 ? { saturation: c.saturation } : {}),
      ...(c.thin === true ? { thin: true as const } : {}),
    }));
  return out.length ? out : undefined;
}
