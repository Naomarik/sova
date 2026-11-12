// Page-asset capture: what the confined browser brings back of one screen (no model, one visit, desktop width):
// its images, ranked, and its colors and font names as notes. This file holds what both sides of the attempt need:
// the child runs the capture, the parent checks everything the child reports. Text from a page is content, never
// instructions, and every field of it is capped.
import { createHash } from "node:crypto";
import type { Browser, Page, Response } from "playwright-core";
import { DESIGN_ASSET_LIMITS, type DesignAssetContext, type DesignAssetDom, type DesignAssetSkipped, type DesignPageNotes } from "../../shared/design-assets";

export type TourRaster = "png" | "jpeg" | "webp";

/** The formats a page's image may be, read from its bytes. */
export function sniffImage(b: Uint8Array): { mime: string; ext: string } | null {
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: "image/png", ext: "png" };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { mime: "image/gif", ext: "gif" };
  const text = (from: number, to: number) => Buffer.from(b.subarray(from, to)).toString("latin1");
  if (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return { mime: "image/webp", ext: "webp" };
  if (text(4, 12) === "ftypavif" || text(4, 12) === "ftypavis") return { mime: "image/avif", ext: "avif" };
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return { mime: "image/x-icon", ext: "ico" };
  const head = Buffer.from(b.subarray(0, 512)).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return { mime: "image/svg+xml", ext: "svg" };
  return null;
}

/**
 * An image's size as its header states it, read without decoding. Null for a format whose size isn't in a fixed
 * header (SVG, ICO), and for a header that can't be read: the caller decides what null means.
 */
export function imageDimensions(b: Uint8Array): { w: number; h: number } | null {
  const k = sniffImage(b)?.ext;
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  const at = (n: number) => n < buf.length;
  try {
    if (k === "png") return at(23) ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } : null;
    if (k === "gif") return at(9) ? { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) } : null;
    if (k === "webp") {
      const chunk = buf.toString("latin1", 12, 16);
      if (chunk === "VP8 " && at(29)) return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === "VP8L" && at(24)) return { w: 1 + (((buf[22]! & 0x3f) << 8) | buf[21]!), h: 1 + (((buf[24]! & 0xf) << 10) | (buf[23]! << 2) | ((buf[22]! & 0xc0) >> 6)) };
      if (chunk === "VP8X" && at(29)) return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
      return null;
    }
    if (k === "jpg") {
      for (let i = 2; at(i + 8); ) {
        if (buf[i] !== 0xff) return null;
        const m = buf[i + 1]!;
        if (m === 0xff) { i++; continue; }
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
      return null;
    }
    if (k === "avif") {
      // Every image item states its size in an 'ispe' box; the largest is the one that costs memory.
      let best: { w: number; h: number } | null = null;
      for (let i = buf.indexOf("ispe", 0, "latin1"); i >= 0 && at(i + 15); i = buf.indexOf("ispe", i + 4, "latin1")) {
        const w = buf.readUInt32BE(i + 8), h = buf.readUInt32BE(i + 12);
        if (!best || w * h > best.w * best.h) best = { w, h };
      }
      return best;
    }
  } catch { return null; }
  return null;
}

/** Why an image mustn't be decoded, or null. A raster whose size can't be read is refused, never guessed at. */
export function drawProblem(b: Uint8Array): string | null {
  const k = sniffImage(b)?.ext;
  if (!k) return "It isn't an image.";
  if (k === "svg" || k === "ico") return null;
  const d = imageDimensions(b);
  if (!d || !d.w || !d.h) return "Its size couldn't be read, so it wasn't drawn.";
  if (d.w * d.h > DESIGN_ASSET_LIMITS.maxPixels) return `It's ${d.w} \u00d7 ${d.h} pixels, too large to draw safely.`;
  return null;
}

/** An image the darkroom wouldn't draw, with the reason a person reads. */
export class DarkroomRefusal extends Error {}

/** A version the browser drew: only these are ever shown. */
export function sniffRaster(b: Uint8Array): TourRaster | null {
  const k = sniffImage(b)?.ext;
  return k === "png" ? "png" : k === "jpg" ? "jpeg" : k === "webp" ? "webp" : null;
}

/** A CDN's address for the original of a resized picture; the address unchanged when no rule applies. */
export function originalAssetUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "static.wixstatic.com") {
      const m = /^\/media\/[^/]+/.exec(u.pathname);
      if (m) return `${u.origin}${m[0]}`;
    }
    if (u.hostname.endsWith("squarespace-cdn.com") || u.hostname.endsWith("squarespace.com")) {
      u.search = "";
      return u.href;
    }
    if (u.hostname.endsWith("cdn.shopify.com")) {
      u.pathname = u.pathname.replace(/_(\d+x\d*|\d*x\d+)(@\dx)?(\.[a-z0-9]+)$/i, "$3");
      return u.href;
    }
    if (u.hostname.includes("cloudinary.com")) {
      u.pathname = u.pathname.replace(/\/upload\/[^/]*(w_|h_|c_|q_|f_)[^/]*\//, "/upload/");
      return u.href;
    }
    return url;
  } catch {
    return url;
  }
}

const EMBEDS: { platform: string; re: RegExp; thumb: (id: string) => string | null }[] = [
  { platform: "youtube", re: /(?:youtube\.com\/embed\/|youtube-nocookie\.com\/embed\/|youtu\.be\/)([A-Za-z0-9_-]{6,})/, thumb: (id) => `https://img.youtube.com/vi/${id}/hqdefault.jpg` },
];

export interface PageCandidate {
  type: "image" | "svg" | "embed";
  sourceTag: string;
  sourceSrc: string;
  /** What the page actually drew, when `sourceSrc` is a better version of it. */
  drawn?: string;
  markup?: string;
  bounds: { x: number; y: number; width: number; height: number } | null;
  natural?: { width: number; height: number };
  aboveFold: boolean;
  dom: DesignAssetDom;
  platform?: string;
  thumbnail?: string | null;
}

/** Largest and highest first. An icon or a sharing picture is kept, near the end. */
export function rankPageCandidates<T extends Pick<PageCandidate, "bounds" | "natural" | "aboveFold" | "sourceTag" | "type">>(all: readonly T[]): T[] {
  const score = (c: T) => {
    const area = c.bounds ? c.bounds.width * c.bounds.height : 0;
    const natural = c.natural ? c.natural.width * c.natural.height : 0;
    let s = Math.max(area, natural / 4);
    if (c.aboveFold) s *= 1.5;
    if (c.sourceTag === "link-icon") s = 2000;
    if (c.sourceTag === "og:image") s = 3000;
    if (c.type === "svg") s *= 1.2;
    return s;
  };
  return all.map((c) => ({ c, s: score(c) })).sort((a, b) => b.s - a.s).map((x) => x.c);
}

/** Runs inside the page. Everything it returns is treated as the page's say-so. */
/* v8 ignore next */
function collectInPage(a: { minPx: number; svgMinPx: number; viewportHeight: number; maxCandidates: number }) {
  const LANDMARKS = new Set(["header", "main", "nav", "footer", "aside", "section", "article", "form", "figure"]);
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  const abs = (u: string | null | undefined) => { try { return u ? new URL(u, location.href).href : null; } catch { return null; } };
  const clean = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const bounds = (el: Element) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) }; };
  const domOf = (el: Element) => {
    const ancestors: string[] = [];
    let p = el.parentElement;
    for (let depth = 0; p && depth < 8 && p !== document.body; depth++) {
      const tag = p.tagName.toLowerCase();
      ancestors.push(`${tag}${p.id ? `#${p.id.slice(0, 40)}` : ""}${[...p.classList].filter((c) => c.length < 40).slice(0, 3).map((c) => `.${c}`).join("")}`);
      if (LANDMARKS.has(tag)) break;
      p = p.parentElement;
    }
    const box = el.closest("section, article, header, footer, nav, aside, main, li, figure") ?? el.parentElement ?? document.body;
    const link = el.closest("a[href]");
    return {
      alt: clean(el.getAttribute("alt"), 200),
      title: clean(el.getAttribute("title"), 120),
      ariaLabel: clean(el.getAttribute("aria-label"), 120),
      classes: [...el.classList].filter((c) => c.length < 40).slice(0, 4),
      ancestors,
      headings: [...box.querySelectorAll("h1, h2, h3, h4")].map((h) => clean(h.textContent, 120)).filter(Boolean).slice(0, 3),
      text: [...box.querySelectorAll("p, a, span, li")].map((n) => clean(n.textContent, 160)).filter((t) => t.length > 10).slice(0, 3),
      linkHref: link ? abs(link.getAttribute("href")) ?? "" : "",
    };
  };
  const push = (c: Record<string, unknown> & { sourceSrc: string; bounds: { y: number } | null }) => {
    if (seen.has(c.sourceSrc) || out.length >= a.maxCandidates) return;
    seen.add(c.sourceSrc);
    out.push({ ...c, aboveFold: c.bounds ? c.bounds.y < a.viewportHeight : false });
  };
  // Commas inside a CDN's path (w_290,h_323) stay part of the address: only a comma before a space splits.
  const bestOf = (srcset: string | null) => {
    if (!srcset) return null;
    let best: { url: string | null; size: number } | null = null;
    for (const part of srcset.split(/,\s+/)) {
      const [u, d] = part.trim().split(/\s+/);
      if (!u) continue;
      const size = d ? parseFloat(d) * (d.endsWith("x") ? 1000 : 1) : 0;
      if (!best || size > best.size) best = { url: abs(u), size };
    }
    return best?.url ?? null;
  };
  const web = (u: string | null) => !!u && /^https?:/.test(u);
  for (const img of [...document.images]) {
    const b = bounds(img);
    if (Math.max(b.width, b.height) < a.minPx && Math.max(img.naturalWidth, img.naturalHeight) < a.minPx) continue;
    if (!b.width && !b.height) continue;
    const drawn = abs(img.currentSrc || img.src);
    const sources = img.closest("picture") ? [...img.closest("picture")!.querySelectorAll("source")] : [];
    const better = bestOf(img.getAttribute("srcset")) ?? sources.map((s) => bestOf(s.getAttribute("srcset"))).find(Boolean) ?? null;
    const src = better ?? drawn;
    if (!web(src)) continue;
    push({ type: "image", sourceTag: "img", sourceSrc: src!, drawn: web(drawn) ? drawn : undefined, bounds: b, natural: { width: img.naturalWidth, height: img.naturalHeight }, dom: domOf(img) });
  }
  for (const el of [...document.querySelectorAll("body *")].slice(0, 20_000)) {
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === "none") continue;
    const m = /url\(["']?([^"')]+)["']?\)/.exec(bg);
    if (!m) continue;
    const b = bounds(el);
    if (Math.max(b.width, b.height) < a.minPx) continue;
    const src = abs(m[1]);
    if (web(src)) push({ type: "image", sourceTag: "background", sourceSrc: src!, bounds: b, dom: domOf(el) });
  }
  let svgs = 0;
  for (const svg of [...document.querySelectorAll("svg")]) {
    if (svg.parentElement?.closest("svg")) continue;
    const b = bounds(svg);
    if (b.width < a.svgMinPx || b.height < a.svgMinPx) continue;
    let markup = svg.outerHTML;
    if (markup.length > 300_000) continue;
    const defs = [...svg.querySelectorAll("use")].flatMap((u) => { const h = u.getAttribute("href") ?? u.getAttribute("xlink:href"); const sym = h?.startsWith("#") ? document.getElementById(h.slice(1)) : null; return sym ? [sym.outerHTML] : []; });
    if (defs.length) markup = markup.replace(/<svg([^>]*)>/, `<svg$1><defs>${defs.join("")}</defs>`);
    if (!/xmlns=/.test(markup)) markup = markup.replace(/<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
    push({ type: "svg", sourceTag: "svg", sourceSrc: `inline-svg:${++svgs}`, markup, bounds: b, dom: domOf(svg) });
  }
  for (const v of [...document.querySelectorAll("video[poster]")]) {
    const b = bounds(v);
    const src = abs(v.getAttribute("poster"));
    if (web(src) && Math.max(b.width, b.height) >= a.minPx) push({ type: "image", sourceTag: "video-poster", sourceSrc: src!, bounds: b, dom: domOf(v) });
  }
  for (const f of [...document.querySelectorAll("iframe[src]")]) {
    const src = abs(f.getAttribute("src"));
    if (web(src)) push({ type: "embed", sourceTag: "iframe", sourceSrc: src!, bounds: bounds(f), dom: domOf(f) });
  }
  const noDom = (title = "") => ({ headings: title ? [title] : [], text: [], ancestors: ["head"] });
  const icon = [...document.querySelectorAll('link[rel~="apple-touch-icon"], link[rel~="icon"]')]
    .map((l) => ({ href: abs(l.getAttribute("href")), size: parseInt((l.getAttribute("sizes") ?? "").split("x")[0] ?? "", 10) || (l.getAttribute("rel")?.includes("apple") ? 180 : 0) }))
    .filter((i) => web(i.href) && i.size >= 64).sort((x, y) => y.size - x.size)[0];
  if (icon) push({ type: "image", sourceTag: "link-icon", sourceSrc: icon.href!, bounds: null, dom: noDom() });
  const og = abs(document.querySelector('meta[property="og:image"], meta[name="og:image"]')?.getAttribute("content"));
  if (web(og)) push({ type: "image", sourceTag: "og:image", sourceSrc: og!, bounds: null, dom: noDom(clean(document.title, 120)) });

  // Colors and fonts, read off what is really drawn, weighted by how much of the page each one covers.
  const hex = (v: string) => {
    const m = /^rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)(?:[,/ ]+([\d.]+))?\)/.exec(v);
    if (!m || (m[4] !== undefined && Number(m[4]) < 0.6)) return null;
    return `#${[m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, "0")).join("")}`;
  };
  const colors = new Map<string, { share: number; role: string }>();
  const fonts = new Map<string, { share: number; role: string }>();
  const addColor = (c: string | null, share: number, role: string) => { if (!c) return; const v = colors.get(`${role}${c}`) ?? { share: 0, role }; v.share += share; colors.set(`${role}${c}`, v); };
  const pageArea = Math.max(1, document.documentElement.scrollWidth * document.documentElement.scrollHeight);
  addColor(hex(getComputedStyle(document.documentElement).backgroundColor) ?? hex(getComputedStyle(document.body).backgroundColor) ?? "#ffffff", 0.05, "background");
  for (const el of [...document.querySelectorAll("body, body *")].slice(0, 8000)) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none") continue;
    const area = (r.width * r.height) / pageArea;
    const button = el.matches('button, [role="button"], a[class*="btn" i], a[class*="button" i]');
    addColor(hex(st.backgroundColor), button ? Math.max(area, 0.002) : area, button ? "accent" : "background");
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent ?? "").join("").trim().length;
    if (!own) continue;
    addColor(hex(st.color), own / 1000, "text");
    const family = st.fontFamily.split(",")[0]?.replace(/["']/g, "").trim() ?? "";
    if (!family || /^(serif|sans-serif|monospace|system-ui|cursive|fantasy|math|emoji|fangsong|ui-[a-z-]+|-apple-system|inherit)$/i.test(family)) continue;
    const role = /^H[1-3]$/.test(el.tagName) ? "heading" : /^(P|LI|SPAN|TD|DIV|A)$/.test(el.tagName) ? "body" : "other";
    const v = fonts.get(`${role}${family}`) ?? { share: 0, role };
    v.share += own;
    fonts.set(`${role}${family}`, v);
  }
  return {
    title: clean(document.title, 200),
    candidates: out,
    colors: [...colors.entries()].map(([k, v]) => ({ hex: k.slice(v.role.length), ...v })).sort((x, y) => y.share - x.share).slice(0, 16),
    fonts: [...fonts.entries()].map(([k, v]) => ({ family: k.slice(v.role.length), ...v })).sort((x, y) => y.share - x.share).slice(0, 12),
  };
}

const NOTE_COLORS = 8;
const NOTE_FONTS = 6;

/** The page's say-so about colors and fonts, as fields nothing can hide in. */
export function cleanNotes(raw: { colors?: unknown; fonts?: unknown }): DesignPageNotes {
  const list = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]).filter((x) => x && typeof x === "object") : []);
  const share = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const totals = (xs: Record<string, unknown>[]) => xs.reduce((n, x) => n + share(x.share), 0) || 1;
  const colors = list(raw.colors).filter((c) => typeof c.hex === "string" && /^#[0-9a-f]{6}$/.test(c.hex) && (c.role === "background" || c.role === "text" || c.role === "accent"));
  const fonts = list(raw.fonts).filter((f) => typeof f.family === "string" && /^[\p{L}\p{N} _.'-]{1,60}$/u.test(f.family) && (f.role === "heading" || f.role === "body" || f.role === "other"));
  const ct = totals(colors), ft = totals(fonts);
  return {
    colors: colors.slice(0, NOTE_COLORS).map((c) => ({ hex: c.hex as string, role: c.role as DesignPageNotes["colors"][number]["role"], share: Math.round((share(c.share) / ct) * 100) / 100 })),
    fonts: fonts.slice(0, NOTE_FONTS).map((f) => ({ family: f.family as string, role: f.role as DesignPageNotes["fonts"][number]["role"], share: Math.round((share(f.share) / ft) * 100) / 100 })),
  };
}

// ---- The darkroom ------------------------------------------------------------------------------------------

export interface DevelopedSizes {
  width: number;
  height: number;
  full: { bytes: Buffer; w: number; h: number };
  small: { bytes: Buffer; w: number; h: number };
  describe: { bytes: Buffer; w: number; h: number };
}

/** Runs inside the darkroom's blank page: an image drawn to fit `edge`, its pixels binned by palette.ts binPixels' rule
    ([key, count, r, g, b, edges] flat, 5 bits a channel), so a few KB of bins leave the page instead of megabytes of pixels.
    Self-contained: it is sent to the page as source. */
/* v8 ignore next */
async function binsInPage(a: { dataUrl: string; edge: number }) {
  const img = new Image();
  await new Promise<void>((ok, no) => { img.onload = () => ok(); img.onerror = () => no(new Error("decode")); img.src = a.dataUrl; });
  const scale = Math.min(1, a.edge / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
  const w = Math.max(1, Math.round((img.naturalWidth || 1) * scale)), h = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const count = w * h;
  const keys = new Int32Array(count).fill(-1);
  const at = new Map<number, number>();
  const out: number[] = [];
  for (let p = 0; p < count; p++) {
    const i = p * 4;
    if (data[i + 3]! < 128) continue;
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    keys[p] = key;
    let j = at.get(key);
    if (j === undefined) { j = out.length; at.set(key, j); out.push(key, 0, 0, 0, 0, 0); }
    out[j + 1]!++; out[j + 2]! += r; out[j + 3]! += g; out[j + 4]! += b;
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const k = keys[p]!;
      if (k < 0) continue;
      const differs = (q: number) => keys[q]! >= 0 && keys[q] !== k;
      if ((x > 0 && differs(p - 1)) || (x < w - 1 && differs(p + 1)) || (y > 0 && differs(p - w)) || (y < h - 1 && differs(p + w))) out[at.get(k)! + 5]!++;
    }
  return { w, h, bins: out };
}

/** Runs inside the darkroom's blank page: an image's RGBA pixels, scaled to fit `edge`, as base64. Tests compare the
    page's binning against binPixels with it. */
/* v8 ignore next */
async function pixelsInPage(a: { dataUrl: string; edge: number }) {
  const img = new Image();
  await new Promise<void>((ok, no) => { img.onload = () => ok(); img.onerror = () => no(new Error("decode")); img.src = a.dataUrl; });
  const scale = Math.min(1, a.edge / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
  const cw = Math.max(1, Math.round((img.naturalWidth || 1) * scale)), ch = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
  const c = document.createElement("canvas");
  c.width = cw; c.height = ch;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, cw, ch);
  const data = ctx.getImageData(0, 0, cw, ch).data;
  let s = "";
  for (let i = 0; i < data.length; i += 8192) s += String.fromCharCode(...data.subarray(i, i + 8192));
  return { w: cw, h: ch, b64: btoa(s) };
}

/** Runs inside the darkroom's blank page. */
/* v8 ignore next */
async function drawInPage(a: { dataUrl: string; fallbackW: number; fallbackH: number; edges: { full: number; small: number; describe: number } }) {
  const img = new Image();
  img.decoding = "async";
  await new Promise<void>((ok, no) => { img.onload = () => ok(); img.onerror = () => no(new Error("decode")); img.src = a.dataUrl; });
  const w = img.naturalWidth || a.fallbackW;
  const h = img.naturalHeight || a.fallbackH;
  const draw = (edge: number, type: string, quality?: number) => {
    const scale = Math.min(1, edge / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
    const c = document.createElement("canvas");
    c.width = cw; c.height = ch;
    c.getContext("2d")!.drawImage(img, 0, 0, cw, ch);
    const url = c.toDataURL(type, quality);
    return { data: url.slice(url.indexOf(",") + 1), w: cw, h: ch };
  };
  return { width: w, height: h, full: draw(a.edges.full, "image/webp", 0.82), small: draw(a.edges.small, "image/webp", 0.75), describe: draw(a.edges.describe, "image/png") };
}

/**
 * The room images are drawn in: a browser context of its own, offline, every request refused, showing a blank page.
 * What an image is (an SVG with scripts, say) can't reach the network or the site's page from here, and comes out as
 * pixels. The server itself never decodes an image.
 */
export async function openDarkroom(browser: Browser) {
  const context = await browser.newContext({ offline: true, serviceWorkers: "block", acceptDownloads: false, colorScheme: "light" });
  await context.route("**/*", (r) => r.abort("blockedbyclient"));
  const blank = async () => { const p = await context.newPage(); await p.goto("about:blank"); return p; };
  let page = await blank();
  const edges = { full: DESIGN_ASSET_LIMITS.fullPx, small: DESIGN_ASSET_LIMITS.smallPx, describe: DESIGN_ASSET_LIMITS.describePx };
  return {
    /** Tests: the room itself, to prove each of its two walls on its own. */
    context,
    /** Draws one image, or refuses it alone: one bad image never costs the others. */
    async develop(bytes: Uint8Array, mime: string, fallback: { w: number; h: number }): Promise<DevelopedSizes> {
      const problem = drawProblem(bytes);
      if (problem) throw new DarkroomRefusal(problem);
      const dataUrl = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const r = await Promise.race([
        page.evaluate(drawInPage, { dataUrl, fallbackW: fallback.w, fallbackH: fallback.h, edges }),
        new Promise<never>((_, no) => { timer = setTimeout(() => no(new DarkroomRefusal("It took too long to draw.")), DRAW_ONE_MS); }),
      ]).catch(async (err) => {
        // A page stuck on one image is thrown away, so the next image starts clean.
        const stuck = page;
        page = await blank();
        void stuck.close().catch(() => {});
        throw err;
      }).finally(() => clearTimeout(timer));
      const part = (p: { data: string; w: number; h: number }) => ({ bytes: Buffer.from(p.data, "base64"), w: p.w, h: p.h });
      return { width: r.width, height: r.height, full: part(r.full), small: part(r.small), describe: part(r.describe) };
    },
    /** An image's pixels, at most `edge` on its long side, as RGBA: what a palette is measured from. Drawn in this same
        offline room, under the same checks as develop, so the server never decodes it. */
    async pixels(bytes: Uint8Array, mime: string, edge: number): Promise<{ width: number; height: number; rgba: Uint8Array }> {
      const problem = drawProblem(bytes);
      if (problem) throw new DarkroomRefusal(problem);
      const dataUrl = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
      const r = await page.evaluate(pixelsInPage, { dataUrl, edge });
      return { width: r.w, height: r.h, rgba: new Uint8Array(Buffer.from(r.b64, "base64")) };
    },
    /** An image's colour bins (binPixels' shape), drawn to fit `edge` in this same offline room under develop's
        checks: what a palette is measured from, without its pixels leaving the page. */
    async bins(bytes: Uint8Array, mime: string, edge: number): Promise<{ width: number; height: number; bins: number[] }> {
      const problem = drawProblem(bytes);
      if (problem) throw new DarkroomRefusal(problem);
      const dataUrl = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
      const r = await page.evaluate(binsInPage, { dataUrl, edge });
      return { width: r.w, height: r.h, bins: r.bins };
    },
    close: () => context.close(),
  };
}

// ---- The capture, inside the confined child ------------------------------------------------------------------

export interface PageCaptureItem {
  /** Names this image's files in the same attempt. */
  ref: string;
  width: number;
  height: number;
  full: { w: number; h: number };
  small: { w: number; h: number };
  describe: { w: number; h: number };
  context: DesignAssetContext;
}

export interface PageCaptureReport {
  url: string;
  title: string;
  items: PageCaptureItem[];
  skipped: DesignAssetSkipped[];
  moreSkipped: number;
  notes: DesignPageNotes;
  ms: number;
}

const FETCH_TIMEOUT_MS = 15_000;
const DRAW_ONE_MS = 20_000;
const CONCURRENCY = 6;
const MAX_CANDIDATES = 400;
const SCROLL_STEP_MS = 120;
const SCROLL_STEPS = 200;
const IMAGES_WAIT_MS = 8000;
const SETTLE_MS = 3000;
const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]!, i); } }));
  return out;
}

type Fetched = { bytes: Buffer; mime: string; url?: string } | { reason: string };

/** Every picture the page's own requests brought, by each address of its redirect chain. */
export function watchPageResponses(context: { on(event: "response", fn: (r: Response) => void): void }): Map<string, Response> {
  const seen = new Map<string, Response>();
  context.on("response", (r) => {
    try {
      if (seen.size > 4000 || r.status() !== 200 || r.request().method() !== "GET") return;
      const type = r.request().resourceType();
      if (type !== "image" && type !== "media" && type !== "other" && !(r.headers()["content-type"] ?? "").startsWith("image/")) return;
      seen.set(r.url(), r);
      for (let q = r.request().redirectedFrom(); q; q = q.redirectedFrom()) seen.set(q.url(), r);
    } catch { /* a response from a page already gone */ }
  });
  return seen;
}

/**
 * The capture of the screen showing now: scroll it, list what it shows, bring the best version of each image through
 * the page's own browser (so every contact meets the attempt's route and proxy), and draw the small versions.
 * `send` hands each file to the parent as it's made, so the child never holds a whole capture's pictures at once.
 */
export async function capturePage(a: { page: Page; browser: Browser; responses: Map<string, Response>; viewportHeight: number; send: (key: string, bytes: Uint8Array) => void; assertSafe: () => void }): Promise<PageCaptureReport> {
  const started = performance.now();
  const { page, responses, viewportHeight, assertSafe } = a;
  /* v8 ignore start */
  await page.evaluate(async ({ stepMs, steps }) => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (const img of [...document.images]) if (img.loading === "lazy") img.loading = "eager";
    let y = 0;
    for (let i = 0; y < document.documentElement.scrollHeight && i < steps; i++) { scrollTo(0, y); y += innerHeight; await sleep(stepMs); }
    scrollTo(0, document.documentElement.scrollHeight);
    await sleep(stepMs);
    scrollTo(0, 0);
    await sleep(stepMs);
  }, { stepMs: SCROLL_STEP_MS, steps: SCROLL_STEPS });
  await page.evaluate(async (limit) => {
    const pending = [...document.images].filter((i) => !(i.complete && i.naturalWidth > 0));
    await Promise.race([Promise.all(pending.map((i) => new Promise((r) => { i.addEventListener("load", r, { once: true }); i.addEventListener("error", r, { once: true }); }))), new Promise((r) => setTimeout(r, limit))]);
  }, IMAGES_WAIT_MS);
  /* v8 ignore stop */
  await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => {});
  assertSafe();

  const seen = await page.evaluate(collectInPage, { minPx: DESIGN_ASSET_LIMITS.minPx, svgMinPx: DESIGN_ASSET_LIMITS.svgMinPx, viewportHeight, maxCandidates: MAX_CANDIDATES });
  const pageUrl = page.url();
  const notes = cleanNotes(seen);
  const skipped: DesignAssetSkipped[] = [];
  const skip = (what: string, reason: string) => skipped.push({ what: what.slice(0, 300), reason });

  const candidates = (seen.candidates as unknown as PageCandidate[]).filter((c) => typeof c?.sourceSrc === "string" && (c.type === "image" || c.type === "svg" || c.type === "embed"));
  for (const c of candidates) {
    if (c.type !== "embed") continue;
    for (const e of EMBEDS) {
      const m = e.re.exec(c.sourceSrc);
      if (m) { c.platform = e.platform; c.thumbnail = e.thumb(m[1]!); break; }
    }
  }
  const ranked = rankPageCandidates(candidates.filter((c) => c.type !== "embed" || c.thumbnail));
  for (const c of ranked.slice(DESIGN_ASSET_LIMITS.count)) skip(c.type === "svg" ? "A drawing on the page" : c.sourceSrc, `Only the ${DESIGN_ASSET_LIMITS.count} largest images are kept.`);
  const chosen = ranked.slice(0, DESIGN_ASSET_LIMITS.count);

  /** Ask the page for an address it hasn't loaded yet, as an image: the same route, the same proxy, the same page's referrer. */
  const loadThroughPage = (url: string) => page.evaluate(({ url, limit }) => new Promise<boolean>((ok) => {
    const i = new Image();
    const end = (v: boolean) => { clearTimeout(t); ok(v); };
    const t = setTimeout(() => end(false), limit);
    i.onload = () => end(true);
    i.onerror = () => end(false);
    i.src = url;
  }), { url, limit: FETCH_TIMEOUT_MS }).catch(() => false);

  const bodyOf = async (url: string): Promise<Fetched> => {
    if (!responses.has(url)) await loadThroughPage(url);
    const r = responses.get(url);
    if (!r) return { reason: "It couldn't be downloaded." };
    const said = Number(r.headers()["content-length"]);
    if (Number.isFinite(said) && said > DESIGN_ASSET_LIMITS.eachBytes) return { reason: `It's ${mb(said)}, over the 8 MB limit.` };
    const bytes = await r.body().catch(() => null);
    if (!bytes) return { reason: "It couldn't be read back from the page." };
    if (bytes.length > DESIGN_ASSET_LIMITS.eachBytes) return { reason: `It's ${mb(bytes.length)}, over the 8 MB limit.` };
    const kind = sniffImage(bytes);
    if (!kind) return { reason: "It isn't an image." };
    // Too many pixels to draw: the next candidate (what the page itself drew) may be fine.
    const problem = drawProblem(bytes);
    if (problem) return { reason: problem };
    return { bytes, mime: kind.mime, url };
  };

  const fetched = await mapLimit(chosen, CONCURRENCY, async (c): Promise<Fetched> => {
    if (c.type === "svg") {
      const bytes = Buffer.from(c.markup ?? "", "utf8");
      return sniffImage(bytes) ? { bytes, mime: "image/svg+xml" } : { reason: "It isn't an image." };
    }
    const tries = [...new Set(c.type === "embed" ? [c.thumbnail!] : [originalAssetUrl(c.sourceSrc), c.sourceSrc, ...(c.drawn ? [c.drawn] : [])])];
    let last: Fetched = { reason: "It couldn't be downloaded." };
    for (const u of tries) {
      last = await bodyOf(u);
      if ("bytes" in last) return last;
    }
    return last;
  });
  assertSafe();

  const darkroom = await openDarkroom(a.browser);
  const items: PageCaptureItem[] = [];
  const hashes = new Set<string>();
  let total = 0;
  try {
    for (const [i, got] of fetched.entries()) {
      const c = chosen[i]!;
      const what = c.type === "svg" ? "A drawing on the page" : c.sourceSrc;
      if ("reason" in got) { skip(what, got.reason); continue; }
      const sha = createHash("sha256").update(got.bytes).digest("hex");
      if (hashes.has(sha)) continue;
      if (total + got.bytes.length > DESIGN_ASSET_LIMITS.totalBytes) { skip(what, `The page's images passed the capture's ${mb(DESIGN_ASSET_LIMITS.totalBytes)} total.`); continue; }
      let drawn: DevelopedSizes;
      try { drawn = await darkroom.develop(got.bytes, got.mime, { w: c.bounds?.width || 512, h: c.bounds?.height || 512 }); }
      catch (err) { skip(what, err instanceof DarkroomRefusal ? err.message : "It couldn't be drawn."); continue; }
      if (Math.max(drawn.width, drawn.height) < DESIGN_ASSET_LIMITS.minPx) continue;
      hashes.add(sha);
      total += got.bytes.length;
      const ref = `c${items.length + 1}`;
      a.send(`${ref}.original`, got.bytes);
      a.send(`${ref}.full`, drawn.full.bytes);
      a.send(`${ref}.small`, drawn.small.bytes);
      a.send(`${ref}.describe`, drawn.describe.bytes);
      items.push({
        ref, width: drawn.width, height: drawn.height,
        full: { w: drawn.full.w, h: drawn.full.h }, small: { w: drawn.small.w, h: drawn.small.h }, describe: { w: drawn.describe.w, h: drawn.describe.h },
        context: { pageUrl, pageTitle: seen.title, sourceTag: c.sourceTag, type: c.type, ...(c.platform ? { platform: c.platform } : {}), ...(got.url ? { sourceUrl: got.url } : {}), ...(c.bounds ? { bounds: c.bounds } : {}), aboveFold: !!c.aboveFold, dom: c.dom },
      });
    }
  } finally { await darkroom.close().catch(() => {}); }
  return { url: pageUrl, title: seen.title, items, skipped: skipped.slice(0, DESIGN_ASSET_LIMITS.skipped), moreSkipped: Math.max(0, skipped.length - DESIGN_ASSET_LIMITS.skipped), notes, ms: Math.round(performance.now() - started) };
}

// ---- The parent's check of what the child reported ---------------------------------------------------------------

/** One capture file the child sends: an item's ref and one of its parts. */
export const isCaptureFileKey = (v: unknown): v is string => typeof v === "string" && /^c([1-9]|[12]\d|30)\.(original|full|small|describe)$/.test(v);

/** The most any one drawn version may weigh; only a describer's PNG comes near it. */
export const CAPTURE_DRAWN_BYTES = 8 * 1024 * 1024;

const str = (v: unknown, n: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/<<|>>/g, " ").trim().slice(0, n);
  return s || undefined;
};
const strs = (v: unknown, n: number, count: number): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.flatMap((x) => str(x, n) ?? []).slice(0, count);
  return out.length ? out : undefined;
};
const dims = (v: unknown): { w: number; h: number } | null => {
  const o = v as { w?: unknown; h?: unknown } | null;
  return o && Number.isInteger(o.w) && Number.isInteger(o.h) && (o.w as number) > 0 && (o.h as number) > 0 && (o.w as number) <= 40_000 && (o.h as number) <= 40_000 ? { w: o.w as number, h: o.h as number } : null;
};

/** A page's say-so about one image, capped field by field. Only web addresses survive. */
export function cleanContext(raw: unknown): DesignAssetContext {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const url = (v: unknown) => { const s = str(v, 2048); return s && /^https?:\/\//.test(s) ? s : undefined; };
  const b = c.bounds as Record<string, unknown> | null | undefined;
  const nums = (...xs: unknown[]) => xs.every((x) => typeof x === "number" && Number.isFinite(x) && Math.abs(x as number) < 1e7);
  const d = (c.dom && typeof c.dom === "object" ? c.dom : {}) as Record<string, unknown>;
  const dom: DesignAssetDom = {
    ...(str(d.alt, 200) ? { alt: str(d.alt, 200)! } : {}),
    ...(str(d.title, 120) ? { title: str(d.title, 120)! } : {}),
    ...(str(d.ariaLabel, 120) ? { ariaLabel: str(d.ariaLabel, 120)! } : {}),
    ...(strs(d.classes, 40, 4) ? { classes: strs(d.classes, 40, 4)! } : {}),
    ...(strs(d.ancestors, 200, 8) ? { ancestors: strs(d.ancestors, 200, 8)! } : {}),
    ...(strs(d.headings, 120, 3) ? { headings: strs(d.headings, 120, 3)! } : {}),
    ...(strs(d.text, 160, 3) ? { text: strs(d.text, 160, 3)! } : {}),
    ...(url(d.linkHref) ? { linkHref: url(d.linkHref)! } : {}),
  };
  return {
    ...(url(c.pageUrl) ? { pageUrl: url(c.pageUrl)! } : {}),
    ...(str(c.pageTitle, 200) ? { pageTitle: str(c.pageTitle, 200)! } : {}),
    ...(str(c.sourceTag, 40) ? { sourceTag: str(c.sourceTag, 40)! } : {}),
    ...(str(c.type, 20) ? { type: str(c.type, 20)! } : {}),
    ...(str(c.platform, 40) ? { platform: str(c.platform, 40)! } : {}),
    ...(url(c.sourceUrl) ? { sourceUrl: url(c.sourceUrl)! } : {}),
    ...(b && nums(b.x, b.y, b.width, b.height) ? { bounds: { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number } } : {}),
    aboveFold: c.aboveFold === true,
    dom,
  };
}

export interface CheckedCaptureItem {
  original: Uint8Array;
  full: { bytes: Uint8Array; w: number; h: number };
  small: { bytes: Uint8Array; w: number; h: number };
  describe: { bytes: Uint8Array; w: number; h: number };
  width: number;
  height: number;
  context: DesignAssetContext;
}

export interface CheckedCapture {
  url: string;
  title?: string;
  items: CheckedCaptureItem[];
  skipped: DesignAssetSkipped[];
  moreSkipped: number;
  notes: DesignPageNotes;
  ms: number;
}

/**
 * The child's report, checked as the page's say-so: a file that isn't what it claims, or over its limit, costs that
 * one image; a report of the wrong shape, more images than a capture may hold or more bytes than its total costs
 * the capture. Files the report doesn't name are dropped.
 */
export function checkPageCapture(raw: unknown, files: ReadonlyMap<string, Uint8Array>): CheckedCapture {
  const r = raw as Partial<PageCaptureReport> | null;
  if (!r || typeof r !== "object" || !Array.isArray(r.items) || !Array.isArray(r.skipped)) throw new Error("Invalid capture report.");
  if (r.items.length > DESIGN_ASSET_LIMITS.count) throw new Error("The capture reported more images than it may keep.");
  const url = str(r.url, 2048);
  if (!url || !/^https?:\/\//.test(url)) throw new Error("Invalid capture report.");
  const skipped: DesignAssetSkipped[] = r.skipped.slice(0, DESIGN_ASSET_LIMITS.skipped).flatMap((s) => {
    const what = str((s as DesignAssetSkipped)?.what, 300), reason = str((s as DesignAssetSkipped)?.reason, 200);
    return what && reason ? [{ what, reason }] : [];
  });
  const items: CheckedCaptureItem[] = [];
  const refs = new Set<string>();
  let total = 0;
  const lost = (what: unknown, reason: string) => skipped.push({ what: str(what, 300) ?? "An image on the page", reason });
  for (const item of r.items as PageCaptureItem[]) {
    const ref = item?.ref;
    if (typeof ref !== "string" || refs.has(ref) || !isCaptureFileKey(`${ref}.original`)) throw new Error("Invalid capture report.");
    refs.add(ref);
    const context = cleanContext(item.context);
    const what = context.sourceUrl;
    const original = files.get(`${ref}.original`), full = files.get(`${ref}.full`), small = files.get(`${ref}.small`), describe = files.get(`${ref}.describe`);
    const fullD = dims(item.full), smallD = dims(item.small), describeD = dims(item.describe), size = dims({ w: item.width, h: item.height });
    if (!original || !full || !small || !describe || !fullD || !smallD || !describeD || !size) { lost(what, "It couldn't be read back from the page."); continue; }
    if (original.length > DESIGN_ASSET_LIMITS.eachBytes) { lost(what, "It's over the 8 MB limit."); continue; }
    if (!sniffImage(original)) { lost(what, "It isn't an image."); continue; }
    if (!sniffRaster(full) || !sniffRaster(small) || sniffRaster(describe) !== "png" || [full, small, describe].some((p) => p.length > CAPTURE_DRAWN_BYTES)) { lost(what, "It couldn't be drawn."); continue; }
    total += original.length;
    if (total > DESIGN_ASSET_LIMITS.totalBytes) throw new Error("The capture passed its total image limit.");
    items.push({ original, full: { bytes: full, ...fullD }, small: { bytes: small, ...smallD }, describe: { bytes: describe, ...describeD }, width: size.w, height: size.h, context });
  }
  return {
    url,
    ...(str(r.title, 200) ? { title: str(r.title, 200)! } : {}),
    items,
    skipped: skipped.slice(0, DESIGN_ASSET_LIMITS.skipped),
    moreSkipped: (Number.isInteger(r.moreSkipped) && (r.moreSkipped as number) > 0 ? Math.min(r.moreSkipped as number, 10_000) : 0) + Math.max(0, skipped.length - DESIGN_ASSET_LIMITS.skipped),
    notes: cleanNotes((r.notes ?? {}) as { colors?: unknown; fonts?: unknown }),
    ms: Number.isFinite(r.ms) && (r.ms as number) >= 0 ? Math.round(r.ms as number) : 0,
  };
}
