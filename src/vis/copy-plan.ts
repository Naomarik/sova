/**
 * What a drawing card's Copy does, decided without a DOM (unit-tested in copy-plan.test.ts).
 * Copy follows the card: while the drawing shows it copies a picture of it, while Source is open
 * the fence text; an interactive (`html`) drawing always copies its text. A picture goes on the
 * clipboard where the browser takes one, else it opens in the image viewer to be saved by hand;
 * when no picture can be made at all, the text is copied instead.
 */

export type CopyWhat = "picture" | "source";

/** Which of the two Copy will take, and so its accessible name. */
export function copyWhat(card: { sourceOpen: boolean; kind: string }): CopyWhat {
  return card.sourceOpen || card.kind === "html" ? "source" : "picture";
}

export const COPY_LABEL: Record<CopyWhat, string> = { picture: "Copy picture", source: "Copy source" };

/** What the browser offers for a picture: a secure page, ClipboardItem, and PNG among its types
    (`png` undefined: the browser can't say, so it is tried). */
export interface PictureSupport {
  secure: boolean;
  clipboardItem: boolean;
  png: boolean | undefined;
}

export type CopyRoute = "text" | "clipboard" | "viewer";

/** The first try: the text, the picture on the clipboard, or the picture in the viewer. */
export function copyRoute(what: CopyWhat, support: PictureSupport): CopyRoute {
  if (what === "source") return "text";
  return support.secure && support.clipboardItem && support.png !== false ? "clipboard" : "viewer";
}

/**
 * After a picture try failed, the next one: the picture couldn't be made (`no-picture`: the
 * browser refused to draw the page's elements) leads to the text; the clipboard refusing a picture
 * that was made leads to the viewer. Null: nothing more to try.
 */
export function nextRoute(route: CopyRoute, failure: "no-picture" | "clipboard-refused"): CopyRoute | null {
  if (route === "text") return null;
  if (failure === "no-picture") return "text";
  return route === "clipboard" ? "viewer" : null;
}

/** The words that confirm each outcome, spoken and toasted alike. */
export const COPY_DONE = {
  picture: "Copied the drawing as a picture.",
  source: "Copied the drawing's source.",
  viewer: "This browser won't put a picture on the clipboard here, so it opened in the image viewer to save from there.",
  textInstead: "This browser couldn't make a picture of the drawing, so its source was copied instead.",
} as const;

/** A file name for a saved picture: the card's title or kind, as plain words. */
export function pictureFileName(label: string): string {
  const name = label.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").toLowerCase().slice(0, 60).replace(/-+$/, "");
  return `${name || "drawing"}.png`;
}

/** The HTML that goes beside the PNG: the same picture at the card's size, for a target that pastes HTML
    (a document, a mail) and would otherwise show the PNG's pixels at twice the size. `dataUrl` is the PNG. */
export function pictureHtml(dataUrl: string, width: number, height: number, alt: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<img src="${esc(dataUrl)}" width="${width}" height="${height}" alt="${esc(alt)}">`;
}

/** Whether a computed colour is solid: `transparent`, `rgba(…, a)` and `… / a` with a below 1 are not. */
export function solidColor(color: string): boolean {
  const c = color.trim();
  if (!c || c === "transparent") return false;
  const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(c);
  if (slash) return Number(slash[1]) / (slash[2] ? 100 : 1) >= 1;
  const rgba = /^rgba\((?:[^,]+,){3}\s*([\d.]+)\s*\)$/.exec(c);
  if (rgba) return Number(rgba[1]) >= 1;
  return true;
}

/** A PNG with a pHYs chunk saying it is drawn at `scale` times 72 dpi, so an app that reads it shows it at
    the card's size rather than `scale` times larger. Any pHYs already there is replaced. Returns the bytes
    unchanged when they aren't a PNG. */
export function withPngScale(png: Uint8Array, scale: number): Uint8Array {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  if (png.length < 33 || SIG.some((b, i) => png[i] !== b)) return png;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: Uint8Array[] = [png.subarray(0, 8)];
  let at = 8;
  let ihdrEnd = -1;
  while (at + 12 <= png.length) {
    const len = view.getUint32(at);
    const end = at + 12 + len;
    if (end > png.length) return png;
    const type = String.fromCharCode(png[at + 4]!, png[at + 5]!, png[at + 6]!, png[at + 7]!);
    if (type !== "pHYs") chunks.push(png.subarray(at, end));
    if (type === "IHDR") ihdrEnd = chunks.length;
    at = end;
    if (type === "IEND") break;
  }
  if (ihdrEnd < 0) return png;
  const ppm = Math.round((scale * 72) / 0.0254);
  const chunk = new Uint8Array(21);
  const cv = new DataView(chunk.buffer);
  cv.setUint32(0, 9);
  chunk.set([112, 72, 89, 115], 4); // "pHYs"
  cv.setUint32(8, ppm);
  cv.setUint32(12, ppm);
  chunk[16] = 1; // unit: metre
  cv.setUint32(17, crc32(chunk.subarray(4, 17)));
  chunks.splice(ihdrEnd, 0, chunk);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

let table: Uint32Array | undefined;
export function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
