/**
 * A picture of a drawing card as it shows in the chat, for Copy (Visual.tsx): the title, the drawing in
 * its current state, the numbered notes and the caption, without the head's buttons, the Source view,
 * the step-through controls or the warnings line. Loaded on the first Copy only.
 *
 * The figure is cloned with every element's computed style written inline (so tokens and custom themes
 * are already resolved), its sideways-scrolling boxes opened to their full width, the fonts and images
 * it uses inlined as data URLs, and the whole drawn as an SVG `<foreignObject>` through an `<img>` onto a
 * canvas at twice its size or more. Its logical size is the card's. A `vis svg` frame becomes the
 * still image the share page draws (svg-image.ts). Safari refuses to read back a canvas that drew a
 * foreignObject: that rejects with NoPictureError.
 */
import { appTheme } from "../lib/explain";
import { solidColor, withPngScale } from "./copy-plan";
import { readTokens, tokenCss } from "./kinds/frame/srcdoc";
import { svgImageSrc } from "./kinds/frame/svg-image";

export class NoPictureError extends Error {}

export interface Picture {
  blob: Blob;
  /** The card's size in CSS px; the picture's pixels are `scale` times these. */
  width: number;
  height: number;
  scale: number;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";
/** What stays out of the picture: every head child but the title (an untitled card's whole head), the
    Source view, the warnings, the step-through, a frame's failure line, a wireframe's screen picker (the
    picture shows every screen). */
const DROP = [".vis-source", ".vis-warning", ".vis-stepper", ".vis-frame-failed", ".vis-wf-nav"];
/** Kept as the drawing's own attributes: written as CSS too they'd fight them (an SVG transform's origin). */
/** A focus ring is the page's, never the picture's. */
const NO_RING = new Set(["outline", "outline-color", "outline-style", "outline-width", "outline-offset"]);
const SVG_GEOMETRY = new Set([...NO_RING, "transform", "transform-origin", "x", "y", "cx", "cy", "r", "rx", "ry", "d", "width", "height", "inline-size", "block-size"]);
/** Largest canvas most browsers will hand back (Safari's limit is near 16.7M pixels). */
const MAX_PIXELS = 16_000_000;

let defaultsDoc: Document | undefined;
const defaults = new Map<string, Map<string, string>>();
/** The browser's own style for a bare element of this kind, in an unstyled document. */
function defaultStyle(el: Element): Map<string, string> {
  const key = `${el.namespaceURI}|${el.localName}`;
  let d = defaults.get(key);
  if (d) return d;
  if (!defaultsDoc) {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.cssText = "position:fixed;left:-10000px;top:0;width:100px;height:100px;border:0;visibility:hidden";
    document.body.appendChild(frame);
    defaultsDoc = frame.contentDocument!;
    defaultsDoc.open();
    defaultsDoc.write("<!doctype html><html><body><svg xmlns='http://www.w3.org/2000/svg'></svg></body></html>");
    defaultsDoc.close();
  }
  const isSvg = el.namespaceURI === SVG_NS;
  const host = isSvg && el.localName !== "svg" ? defaultsDoc.querySelector("svg")! : defaultsDoc.body;
  const probe = defaultsDoc.createElementNS(el.namespaceURI ?? XHTML_NS, el.localName);
  host.appendChild(probe);
  const cs = defaultsDoc.defaultView!.getComputedStyle(probe);
  d = new Map();
  for (let i = 0; i < cs.length; i++) d.set(cs[i]!, cs.getPropertyValue(cs[i]!));
  probe.remove();
  defaults.set(key, d);
  return d;
}

/** `cs` as inline CSS, leaving out what the element would get anyway: the default for its kind when it
    also equals what its parent computes (inherited or not, the result is the same). */
function styleText(cs: CSSStyleDeclaration, base: Map<string, string>, parent: CSSStyleDeclaration | null, skip?: Set<string>): string {
  let out = "";
  for (let i = 0; i < cs.length; i++) {
    const name = cs[i]!;
    if (name.startsWith("--") || skip?.has(name)) continue;
    const v = cs.getPropertyValue(name);
    if (parent && v === base.get(name) && v === parent.getPropertyValue(name)) continue;
    out += `${name}:${v};`;
  }
  return out;
}

/** A `::before`/`::after` with content, as a real span the picture can hold. */
function pseudo(orig: Element, clone: Element, which: "::before" | "::after", parent: CSSStyleDeclaration) {
  const cs = getComputedStyle(orig, which);
  const content = cs.getPropertyValue("content");
  if (!content || content === "none" || content === "normal") return;
  const span = document.createElementNS(XHTML_NS, "span");
  let text = "";
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(content);
  if (m) text = m[1]!.replace(/\\(.)/g, "$1");
  span.setAttribute("style", styleText(cs, defaultStyle(span), parent, new Set(["content"])));
  span.textContent = text;
  if (which === "::before") clone.insertBefore(span, clone.firstChild);
  else clone.appendChild(span);
}

/** Writes each element's computed style onto its clone, original and clone walked together. */
function inline(orig: Element, clone: Element, parent: CSSStyleDeclaration | null) {
  const cs = getComputedStyle(orig);
  const isSvg = orig.namespaceURI === SVG_NS;
  const skip = isSvg && orig.localName !== "svg" ? SVG_GEOMETRY : NO_RING;
  (clone as HTMLElement).setAttribute("style", styleText(cs, defaultStyle(orig), parent, skip));
  clone.removeAttribute("class");
  if (cs.display === "none") return;
  const oc = orig.children;
  const cc = clone.children;
  for (let i = 0; i < oc.length; i++) inline(oc[i]!, cc[i]!, cs);
  if (!isSvg) {
    pseudo(orig, clone, "::before", cs);
    pseudo(orig, clone, "::after", cs);
  }
}

const urlCache = new Map<string, Promise<string | null>>();
/** A same-origin file as a data URL (null when it can't be fetched): fonts, icons, images. */
function dataUrl(url: string): Promise<string | null> {
  let p = urlCache.get(url);
  if (!p) {
    p = fetch(url, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => (b ? new Promise<string | null>((done) => {
        const fr = new FileReader();
        fr.onload = () => done(fr.result as string);
        fr.onerror = () => done(null);
        fr.readAsDataURL(b);
      }) : null))
      .catch(() => null);
    urlCache.set(url, p);
  }
  return p;
}

const URL_RE = /url\((["']?)([^"')]+)\1\)/g;

/** Every `url(…)` in the clone's styles and every `<img>` source becomes inline data; a reference to
    this page's own element (an SVG marker) stays a fragment. */
async function inlineUrls(root: Element) {
  const here = location.href.split("#")[0];
  const jobs: Promise<void>[] = [];
  for (const el of [root, ...root.querySelectorAll("*")]) {
    const style = el.getAttribute("style");
    if (style?.includes("url(")) {
      const found = [...style.matchAll(URL_RE)].map((m) => m[2]!);
      jobs.push(
        (async () => {
          let s = style;
          for (const u of new Set(found)) {
            if (u.startsWith("data:") || u.startsWith("#")) continue;
            const abs = new URL(u, location.href);
            const rep = abs.href.split("#")[0] === here && abs.hash ? abs.hash : abs.origin === location.origin ? await dataUrl(abs.href) : null;
            s = s.split(u).join(rep ?? "");
          }
          el.setAttribute("style", s);
        })(),
      );
    }
    if (el.localName === "img") {
      const src = el.getAttribute("src");
      if (src && !src.startsWith("data:")) {
        jobs.push(dataUrl(new URL(src, location.href).href).then((d) => (d ? el.setAttribute("src", d) : el.removeAttribute("src"))));
      }
      el.removeAttribute("srcset");
      el.removeAttribute("loading");
    }
  }
  await Promise.all(jobs);
}

const familyName = (f: string) => f.trim().replace(/^["']|["']$/g, "").toLowerCase();

/** The `@font-face` rules of the families the picture uses, their files inlined. */
async function fontCss(root: Element): Promise<string> {
  const used = new Set<string>();
  for (const el of [root, ...root.querySelectorAll("*")]) {
    const m = /font-family:([^;]+);/.exec(el.getAttribute("style") ?? "");
    if (m) for (const f of m[1]!.split(",")) used.add(familyName(f));
  }
  const rules: CSSFontFaceRule[] = [];
  const walk = (list: CSSRuleList) => {
    for (const r of list) {
      if (r instanceof CSSFontFaceRule) {
        if (used.has(familyName(r.style.getPropertyValue("font-family")))) rules.push(r);
      } else if ("cssRules" in r && (r as CSSGroupingRule).cssRules) walk((r as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules);
    } catch {
      // Another origin's sheet: its faces can't be read, the picture falls back as an image would.
    }
  }
  const out = await Promise.all(
    rules.map(async (r) => {
      let css = r.cssText;
      const base = r.parentStyleSheet?.href ?? location.href;
      for (const m of css.matchAll(URL_RE)) {
        if (m[2]!.startsWith("data:")) continue;
        const d = await dataUrl(new URL(m[2]!, base).href);
        if (d) css = css.split(m[2]!).join(d);
      }
      return css;
    }),
  );
  return out.join("\n");
}

/** What the card sits on: the nearest solid background behind it. */
function backdrop(from: Element | null): string {
  for (let el = from; el; el = el.parentElement) {
    const bg = getComputedStyle(el).backgroundColor;
    if (solidColor(bg)) return bg;
  }
  return appTheme() === "light" ? "#ffffff" : "#000000";
}

/** The clone's element at `o`'s place in `figure` (the clone as cloned, before anything was added). */
function pathIn(clone: Element, figure: Element, o: Element): Element | null {
  const path: number[] = [];
  for (let el: Element = o; el !== figure; el = el.parentElement!) {
    if (!el.parentElement) return null;
    path.unshift([...el.parentElement.children].indexOf(el));
  }
  let c: Element | undefined = clone;
  for (const i of path) {
    c = c?.children[i];
    if (!c) return null;
  }
  return c ?? null;
}

/**
 * Draws `figure` (a `figure.vis` in the page) as a PNG of its own size at `scale` (2, or the screen's
 * density when higher) pixels per CSS px. `svgSource`: a `vis svg` card's document, drawn in place
 * of its frame.
 */
export async function snapshot(figure: HTMLElement, opts: { svgSource?: string } = {}): Promise<Picture> {
  const head = figure.querySelector(".vis-head");
  const titled = !!head?.querySelector(":scope > .vis-title");
  const headLeft = !head ? [] : titled ? [...head.children].filter((c) => !c.matches(".vis-title")) : [head];
  const left = [...headLeft, ...figure.querySelectorAll(DROP.join(","))] as HTMLElement[];
  // What the picture leaves out is taken out of the card's layout for the moment the styles are read,
  // so nothing keeps its room (the step-through's row, a phone head's second line). Put back before the
  // page paints; a focused button it hid gets its focus back.
  const active = document.activeElement;
  const saved = left.map((el) => [el.style.getPropertyValue("display"), el.style.getPropertyPriority("display")] as const);
  for (const el of left) el.style.setProperty("display", "none", "important");
  let rect: DOMRect;
  let clone: HTMLElement;
  let frames: (readonly [HTMLIFrameElement, HTMLElement | null])[];
  let scrolls: (readonly [HTMLElement, HTMLElement | null, number])[];
  let drop: (HTMLElement | null)[];
  let headClone: HTMLElement | null = null;
  try {
    rect = figure.getBoundingClientRect();
    clone = figure.cloneNode(true) as HTMLElement;
    // Found before the styles go in: the walk adds spans for ::before/::after, which would shift the paths.
    const at = (o: Element) => pathIn(clone, figure, o) as HTMLElement | null;
    frames = [...figure.querySelectorAll("iframe")].map((o) => [o, at(o)] as const);
    // A box that scrolls sideways is shown whole: the figure grows by the widest one's hidden part.
    scrolls = [...figure.querySelectorAll<HTMLElement>(".vis-scroll")]
      .map((o) => [o, at(o), o.scrollWidth - o.clientWidth] as const)
      .filter(([, , hidden]) => hidden > 0);
    drop = left.map(at);
    if (head && titled) headClone = at(head);
    inline(figure, clone, null);
  } finally {
    left.forEach((el, i) => el.style.setProperty("display", saved[i]![0], saved[i]![1]));
    if (active instanceof HTMLElement && active.isConnected && document.activeElement !== active) active.focus({ preventScroll: true });
  }
  const extra = Math.max(0, ...scrolls.map(([, , hidden]) => hidden));
  const width = Math.ceil(rect.width + extra);
  const height = Math.ceil(rect.height);

  const tokens = tokenCss(readTokens(document.documentElement), appTheme());
  for (const [o, c] of frames) {
    if (!c) continue;
    // A `vis svg` frame becomes the share page's still image; any other frame an empty box its size.
    const box = o.getBoundingClientRect();
    const img = document.createElementNS(XHTML_NS, "img");
    img.setAttribute("style", `${c.getAttribute("style") ?? ""};display:block;width:${box.width}px;height:${box.height}px;object-fit:contain;object-position:top center`);
    if (opts.svgSource) img.setAttribute("src", svgImageSrc(opts.svgSource, tokens));
    c.replaceWith(img);
  }
  for (const [o, c, hidden] of scrolls) {
    if (!c) continue;
    Object.assign(c.style, { overflow: "visible", width: `${o.scrollWidth}px`, maxWidth: "none" });
    // Its boxes up to the card widen with it (their widths were written in px, as computed).
    for (let a = c.parentElement; a && a !== clone; a = a.parentElement) {
      const w = parseFloat(a.style.width);
      if (Number.isFinite(w)) a.style.width = `${w + hidden}px`;
      a.style.maxWidth = "none";
    }
  }
  // The head's rule runs the picture's full width.
  const hw = headClone ? parseFloat(headClone.style.width) : NaN;
  if (headClone && extra && Number.isFinite(hw)) headClone.style.width = `${hw + extra}px`;
  for (const c of drop) c?.remove();
  Object.assign(clone.style, { margin: "0", width: `${width}px`, maxWidth: "none", height: `${height}px`, boxSizing: "border-box" });

  const wrap = document.createElementNS(XHTML_NS, "div") as HTMLDivElement;
  wrap.setAttribute("style", `width:${width}px;height:${height}px;background:${backdrop(figure.parentElement)};overflow:hidden`);
  wrap.appendChild(clone);
  await inlineUrls(wrap);
  const fonts = await fontCss(wrap);

  const html = new XMLSerializer().serializeToString(wrap);
  const style = fonts ? `<style>${fonts.replace(/[<&]/g, "")}</style>` : "";
  const svg = `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${style}<foreignObject x="0" y="0" width="${width}" height="${height}">${html}</foreignObject></svg>`;

  const img = new Image();
  img.decoding = "sync";
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  try {
    await img.decode();
  } catch {
    throw new NoPictureError("The drawing couldn't be drawn as a picture.");
  }
  let scale = Math.max(2, window.devicePixelRatio || 1);
  if (width * height * scale * scale > MAX_PIXELS) scale = Math.max(1, Math.sqrt(MAX_PIXELS / (width * height)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new NoPictureError("No canvas to draw on.");
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, width, height);
  let blob: Blob | null;
  try {
    blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
  } catch {
    // Safari: a canvas that drew a foreignObject is tainted, and reading it back throws.
    throw new NoPictureError("The browser wouldn't read the picture back.");
  }
  if (!blob) throw new NoPictureError("The browser made no picture.");
  const bytes = withPngScale(new Uint8Array(await blob.arrayBuffer()), scale);
  return { blob: new Blob([bytes as BlobPart], { type: "image/png" }), width, height, scale };
}
