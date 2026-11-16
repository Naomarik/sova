// How much two screenshots differ, in pixels: enough PNG decoding for what Chrome's screenshots are (8 bits per channel,
// grey, RGB or RGBA, not interlaced). A click that changes nothing still leaves its control hovered, so "the screen didn't
// change" is a count of changed pixels, not equal bytes.
import { inflateSync } from "node:zlib";

interface Raster {
  w: number;
  h: number;
  /** Bytes per pixel. */
  bpp: number;
  rows: Uint8Array;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

function decode(png: Uint8Array): Raster | null {
  const b = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47 || b.toString("ascii", 12, 16) !== "IHDR") return null;
  const w = b.readUInt32BE(16);
  const h = b.readUInt32BE(20);
  const [depth, color, , , interlace] = [b[24], b[25], b[26], b[27], b[28]];
  const channels = CHANNELS[color ?? -1];
  if (depth !== 8 || !channels || interlace !== 0 || !w || !h || w * h > 40_000_000) return null;
  const parts: Buffer[] = [];
  for (let at = 8; at + 8 <= b.length; ) {
    const len = b.readUInt32BE(at);
    const type = b.toString("ascii", at + 4, at + 8);
    if (type === "IDAT") parts.push(b.subarray(at + 8, at + 8 + len));
    if (type === "IEND") break;
    at += 12 + len;
  }
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(parts));
  } catch {
    return null;
  }
  const bpp = channels;
  const stride = w * bpp;
  if (raw.length < h * (stride + 1)) return null;
  const rows = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? rows[out + x - bpp]! : 0;
      const up = y > 0 ? rows[out - stride + x]! : 0;
      const c = x >= bpp && y > 0 ? rows[out - stride + x - bpp]! : 0;
      const v = raw[src + x]!;
      let r: number;
      if (filter === 0) r = v;
      else if (filter === 1) r = v + a;
      else if (filter === 2) r = v + up;
      else if (filter === 3) r = v + ((a + up) >> 1);
      else if (filter === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c);
      } else return null;
      rows[out + x] = r & 0xff;
    }
  }
  return { w, h, bpp, rows };
}

/** The share of pixels (0 to 1) that differ between two screenshots of one size; 1 when they can't be compared. */
export function pngDifference(a: Uint8Array, b: Uint8Array): number {
  if (a.length === b.length && a.every((x, i) => x === b[i])) return 0;
  const x = decode(a);
  const y = decode(b);
  if (!x || !y || x.w !== y.w || x.h !== y.h || x.bpp !== y.bpp) return 1;
  let changed = 0;
  for (let p = 0; p < x.w * x.h; p++) {
    const at = p * x.bpp;
    for (let k = 0; k < x.bpp; k++)
      if (x.rows[at + k] !== y.rows[at + k]) {
        changed++;
        break;
      }
  }
  return changed / (x.w * x.h);
}
