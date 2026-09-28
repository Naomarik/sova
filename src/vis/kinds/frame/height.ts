/**
 * How tall a free-form frame will be before it has said so. A frame reports its height only after
 * its document has run, so the shell reserves a guess: the height this same source reported before
 * (this tab, any visit: an in-memory map mirrored to sessionStorage), else, for an svg, its
 * viewBox's aspect at the width it will have, else a default. Pure: no Solid, DOM or CSS; the
 * storage is feature-tested, so node tests run it with the map alone.
 */
import type { FrameSpec } from "./parse";
import { MAX_FRAME_HEIGHT } from "./srcdoc";

export const DEFAULT_HTML_HEIGHT = 240;
export const MIN_FRAME_HEIGHT = 40;
const STORE_KEY = "sova.vis.frame-heights";
const MAX_ENTRIES = 200;

/** A short stable hash (FNV-1a, 32-bit) of the kind and source: the cache key's first half. */
export function frameHash(spec: Pick<FrameSpec, "kind" | "source">): string {
  let h = 0x811c9dc5;
  const s = `${spec.kind}\n${spec.source}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** hash → (width → height). Heights depend on width, so each width a source was seen at is kept. */
const mem = new Map<string, Map<number, number>>();
let loaded = false;

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = storage()?.getItem(STORE_KEY);
    const data = raw ? (JSON.parse(raw) as Record<string, Record<string, number>>) : {};
    for (const [hash, byWidth] of Object.entries(data)) mem.set(hash, new Map(Object.entries(byWidth).map(([w, h]) => [Number(w), h])));
  } catch {
    // A corrupt entry costs only the guess.
  }
}

function save() {
  const s = storage();
  if (!s) return;
  const out: Record<string, Record<string, number>> = {};
  for (const [hash, byWidth] of mem) out[hash] = Object.fromEntries(byWidth);
  try {
    s.setItem(STORE_KEY, JSON.stringify(out));
  } catch {
    // Full or refused: the in-memory map still serves this page.
  }
}

const clamp = (h: number) => Math.max(MIN_FRAME_HEIGHT, Math.min(MAX_FRAME_HEIGHT, Math.ceil(h)));

/** Remember what a frame reported at a width. */
export function rememberHeight(spec: Pick<FrameSpec, "kind" | "source">, width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0) return;
  load();
  const hash = frameHash(spec);
  const byWidth = mem.get(hash) ?? new Map<number, number>();
  const w = Math.round(width);
  if (byWidth.get(w) === clamp(height)) return;
  byWidth.set(w, clamp(height));
  mem.delete(hash);
  mem.set(hash, byWidth); // newest last, so the oldest go first
  while (mem.size > MAX_ENTRIES) mem.delete(mem.keys().next().value!);
  save();
}

/** The body's padding in the frame (srcdoc.ts BASE_CSS): 12px, 8px at 420px and under. */
const bodyPad = (width: number) => (width <= 420 ? 8 : 12);

/** An svg's drawn height from its width attribute or viewBox, at the frame's width; null if unknown. */
function svgHeight(source: string, width: number): number | null {
  const tag = /<svg\b[^>]*>/i.exec(source)?.[0];
  if (!tag) return null;
  const vb = /\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(tag);
  const attr = (name: string) => {
    const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, "i").exec(tag);
    return m ? Number(m[1]) : null;
  };
  const vw = vb ? Number(vb[1]) : attr("width");
  const vh = vb ? Number(vb[2]) : attr("height");
  if (!vw || !vh) return null;
  const room = width - 2 * bodyPad(width);
  // Drawn at its width attribute, else its viewBox width (srcdoc.ts never scales up), capped to the room.
  const drawn = Math.min(room, attr("width") ?? vw);
  const h = (drawn * vh) / vw;
  return h + 2 * bodyPad(width);
}

/**
 * The px height of the frame at `width` (the drawing only). The cached height at the nearest width
 * this source was seen at, when within 40px of it; else an svg's computed height; else the height
 * cached at any width; else the default.
 */
export function estimateHeight(spec: FrameSpec, width: number): number {
  load();
  const byWidth = mem.get(frameHash(spec));
  let near: [number, number] | null = null;
  for (const [w, h] of byWidth ?? []) if (!near || Math.abs(w - width) < Math.abs(near[0] - width)) near = [w, h];
  if (near && Math.abs(near[0] - width) <= 40) return near[1];
  const svg = spec.kind === "svg" ? svgHeight(spec.source, width) : null;
  if (svg !== null) return clamp(svg);
  return near ? near[1] : DEFAULT_HTML_HEIGHT;
}

/** For tests: forget everything cached in memory. */
export function resetHeightCache(): void {
  mem.clear();
  loaded = false;
}
