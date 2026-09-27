// An image's size read from its own header, straight out of a base64 data URL, so a thumbnail can
// hold its final box before the browser has decoded a byte (components/ImageStrip) and a row's
// height estimate can count it (lib/tail-render). Only the few bytes each format needs are decoded:
// base64 maps every 3 bytes to 4 characters, so any byte range is read without decoding what comes
// before it, and a JPEG's segments are skipped by their lengths, unread.

/** An image's laid-out size in CSS pixels: its pixel size, turned as the browser turns it. */
export interface ImageSize {
  w: number;
  h: number;
}

/** A JPEG's markers are scanned no further into the file than this. */
const MAX_SCAN_BYTES = 512 * 1024;
/** Nor through more segments (or PNG chunks) than this. */
const MAX_SEGMENTS = 128;

/** Bytes of the data URL's payload, decoded on demand by range. Null reads past the end, and throws nothing. */
class Payload {
  constructor(
    private readonly src: string,
    private readonly start: number,
  ) {}

  /** `len` bytes from byte `at`, or null when the payload doesn't have them or they don't decode.
      `partial` takes fewer at the end of the payload, at least one. */
  read(at: number, len: number, partial = false): Uint8Array | null {
    if (at < 0 || len <= 0) return null;
    const first = Math.floor(at / 3);
    const last = Math.ceil((at + len) / 3);
    const from = this.start + first * 4;
    const chars = this.src.slice(from, Math.min(this.start + last * 4, this.src.length));
    let bin: string;
    try {
      bin = atob(chars);
    } catch {
      return null;
    }
    const skip = at - first * 3;
    if (bin.length < skip + len) {
      if (!partial || bin.length <= skip) return null;
      len = bin.length - skip;
    }
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(skip + i);
    return out;
  }
}

/** A byte, 0 past the end: each format checks it has the bytes it reads before it reads them. */
const byte = (b: Uint8Array, i: number): number => b[i] ?? 0;
const u16be = (b: Uint8Array, i: number) => (byte(b, i) << 8) | byte(b, i + 1);
const u16le = (b: Uint8Array, i: number) => byte(b, i) | (byte(b, i + 1) << 8);
const u24le = (b: Uint8Array, i: number) => byte(b, i) | (byte(b, i + 1) << 8) | (byte(b, i + 2) << 16);
const u32be = (b: Uint8Array, i: number) => ((byte(b, i) << 24) >>> 0) + ((byte(b, i + 1) << 16) | (byte(b, i + 2) << 8) | byte(b, i + 3));
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(p: Payload, head: Uint8Array): ImageSize | null {
  if (head.length < 24 || !PNG_SIG.every((v, i) => byte(head, i) === v) || ascii(head, 12, 4) !== "IHDR") return null;
  const size = { w: u32be(head, 16), h: u32be(head, 20) };
  // An eXIf chunk may turn or rescale the image in the browser: leave that one to the browser.
  let at = 8;
  for (let n = 0; n < MAX_SEGMENTS; n++) {
    const chunk = p.read(at, 8);
    if (!chunk) return null;
    const type = ascii(chunk, 4, 4);
    if (type === "eXIf") return null;
    if (type === "IDAT" || type === "IEND") return size;
    at += 12 + u32be(chunk, 0);
    if (at > MAX_SCAN_BYTES) return null;
  }
  return null;
}

function gif(head: Uint8Array): ImageSize | null {
  const sig = ascii(head, 0, 6);
  if (head.length < 10 || (sig !== "GIF87a" && sig !== "GIF89a")) return null;
  return { w: u16le(head, 6), h: u16le(head, 8) };
}

function webp(head: Uint8Array): ImageSize | null {
  if (head.length < 25 || ascii(head, 0, 4) !== "RIFF" || ascii(head, 8, 4) !== "WEBP") return null;
  const chunk = ascii(head, 12, 4);
  if (chunk === "VP8 ") {
    // The frame tag (3 bytes), then the key frame's start code, then 14-bit width and height.
    if (head.length < 30 || byte(head, 23) !== 0x9d || byte(head, 24) !== 0x01 || byte(head, 25) !== 0x2a) return null;
    return { w: u16le(head, 26) & 0x3fff, h: u16le(head, 28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (byte(head, 20) !== 0x2f) return null;
    const bits = byte(head, 21) | (byte(head, 22) << 8) | (byte(head, 23) << 16) | (byte(head, 24) << 24);
    return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    // EXIF (flag 0x08) may turn the image in the browser: leave that one to the browser.
    if (head.length < 30 || byte(head, 20) & 0x08) return null;
    return { w: u24le(head, 24) + 1, h: u24le(head, 27) + 1 };
  }
  return null;
}

/** Start-of-frame markers: every SOFn but DHT (C4), JPG (C8) and DAC (CC). */
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/**
 * What a JPEG's EXIF (an APP1 segment's payload, from its "Exif\0\0") does to its laid-out size:
 * "swap" for an orientation that turns it a quarter, "keep" for none, "unknown" when it sets a
 * resolution other than 72 dpi (the browser may scale the image by it) or can't be read.
 */
function exifEffect(p: Payload, at: number, len: number): "keep" | "swap" | "unknown" {
  const tiff = at + 6;
  const head = p.read(tiff, 8);
  if (!head) return "unknown";
  const order = ascii(head, 0, 2);
  if (order !== "II" && order !== "MM") return "unknown";
  const le = order === "II";
  const u16 = (b: Uint8Array, i: number) => (le ? u16le(b, i) : u16be(b, i));
  const u32 = (b: Uint8Array, i: number) => (le ? (byte(b, i) | (byte(b, i + 1) << 8) | (byte(b, i + 2) << 16)) + byte(b, i + 3) * 2 ** 24 : u32be(b, i));
  if (u16(head, 2) !== 42) return "unknown";
  const ifd = tiff + u32(head, 4);
  const count = p.read(ifd, 2);
  if (!count) return "unknown";
  const n = Math.min(u16(count, 0), 256);
  const entries = p.read(ifd + 2, n * 12);
  if (!entries || ifd + 2 + n * 12 > at + len) return "unknown";
  let effect: "keep" | "swap" = "keep";
  for (let i = 0; i < n; i++) {
    const e = i * 12;
    const tag = u16(entries, e);
    if (tag === 0x0112) {
      const o = u16(entries, e + 8);
      if (o >= 5 && o <= 8) effect = "swap";
    } else if (tag === 0x011a || tag === 0x011b) {
      // XResolution / YResolution: a RATIONAL stored at an offset.
      const r = p.read(tiff + u32(entries, e + 8), 8);
      if (!r) return "unknown";
      const num = u32(r, 0);
      const den = u32(r, 4);
      if (den === 0 || num !== 72 * den) return "unknown";
    }
  }
  return effect;
}

function jpeg(p: Payload, head: Uint8Array): ImageSize | null {
  if (byte(head, 0) !== 0xff || byte(head, 1) !== 0xd8) return null;
  let at = 2;
  let swap = false;
  for (let n = 0; n < MAX_SEGMENTS && at < MAX_SCAN_BYTES; n++) {
    const m = p.read(at, 4);
    if (!m || byte(m, 0) !== 0xff) return null;
    const marker = byte(m, 1);
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2; // no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image, or scan data, before any frame
    const len = u16be(m, 2);
    if (len < 2) return null;
    if (isSof(marker)) {
      const sof = p.read(at + 4, 5);
      if (!sof) return null;
      const h = u16be(sof, 1);
      const w = u16be(sof, 3);
      return swap ? { w: h, h: w } : { w, h };
    }
    if (marker === 0xe1) {
      const id = p.read(at + 4, 6);
      if (id && ascii(id, 0, 4) === "Exif" && byte(id, 4) === 0 && byte(id, 5) === 0) {
        const effect = exifEffect(p, at + 4, len - 2);
        if (effect === "unknown") return null;
        swap = effect === "swap";
      }
    }
    at += 2 + len;
  }
  return null;
}

function parse(src: string): ImageSize | null {
  if (!src.startsWith("data:")) return null;
  const comma = src.indexOf(",");
  if (comma < 0 || !src.slice(5, comma).split(";").includes("base64")) return null;
  const p = new Payload(src, comma + 1);
  // Enough for every format's fixed header. A shorter payload is read to its end, and each format
  // checks it has the bytes it reads.
  const head = p.read(0, 30, true);
  if (!head || head.length < 4) return null;
  const size =
    byte(head, 0) === 0x89 ? png(p, head)
    : byte(head, 0) === 0x47 ? gif(head)
    : byte(head, 0) === 0x52 ? webp(head)
    : byte(head, 0) === 0xff ? jpeg(p, head)
    : null;
  return size && size.w > 0 && size.h > 0 ? size : null;
}

/** How many sizes are remembered. */
const MEMO_MAX = 500;
const memo = new Map<string, ImageSize | null>();

/**
 * The memo's key for a data URL: its length and a hash of its head and tail. Never a slice of the
 * string itself, which could keep the whole (megabytes long) URL alive after its row is gone.
 */
function keyOf(src: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  const mix = (c: number) => {
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 13);
  };
  const head = Math.min(src.length, 512);
  for (let i = 0; i < head; i++) mix(src.charCodeAt(i));
  for (let i = Math.max(head, src.length - 128); i < src.length; i++) mix(src.charCodeAt(i));
  return `${src.length}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`;
}

/**
 * The size an image in a data URL lays out at, from its PNG, GIF, WebP or JPEG header; null for
 * anything else (not a base64 data URL, another format, a malformed or truncated header, or a
 * header that lets the browser turn or rescale the image in ways not read here). Never throws.
 */
export function dataUrlSize(src: string): ImageSize | null {
  if (!src.startsWith("data:")) return null;
  const key = keyOf(src);
  if (memo.has(key)) {
    const hit = memo.get(key)!;
    memo.delete(key);
    memo.set(key, hit);
    return hit;
  }
  let size: ImageSize | null;
  try {
    size = parse(src);
  } catch {
    size = null;
  }
  memo.set(key, size);
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value!);
  return size;
}

/** A single thread image fits inside this box (base.css `.message-images-single`), 1px border outside it. */
export const THUMB_MAX_W = 320;
export const THUMB_MAX_H = 240;
/** The two thumbnail borders (`--stroke-thin`), which the box adds to the image. */
const THUMB_BORDERS = 2;

/** The width a single image lays out at under the height cap alone: the width and column caps are CSS's. */
export const thumbWidth = (size: ImageSize): number => Math.min(size.w, (THUMB_MAX_H * size.w) / size.h);

/** A single image's box height, border included, where the 320px cap binds before the column's. */
export const thumbBoxHeight = (size: ImageSize): number =>
  Math.min(size.h, THUMB_MAX_H, ((THUMB_MAX_W - THUMB_BORDERS) * size.h) / size.w) + THUMB_BORDERS;
