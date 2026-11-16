// Comparing two screenshots by changed pixels: every PNG row filter decodes to the same pixels, and the share counts
// pixels, not channels.
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { test } from "node:test";
import { pngDifference } from "./png-diff";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};

/** An RGB picture, each row written with the given filter (0 to 4), as an encoder would. */
function png(w: number, h: number, pixel: (x: number, y: number) => [number, number, number], filter: number): Uint8Array {
  const bpp = 3;
  const rows = Array.from({ length: h }, (_, y) => Buffer.from(Array.from({ length: w }, (_, x) => pixel(x, y)).flat()));
  const out: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = rows[y]!;
    const prev = y > 0 ? rows[y - 1]! : Buffer.alloc(row.length);
    const f = Buffer.alloc(row.length + 1);
    f[0] = filter;
    for (let i = 0; i < row.length; i++) {
      const a = i >= bpp ? row[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const pred = [0, a, b, (a + b) >> 1, paeth][filter]!;
      f[i + 1] = (row[i]! - pred) & 0xff;
    }
    out.push(f);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(out))), chunk("IEND", Buffer.alloc(0))]));
}

const base = (x: number, y: number): [number, number, number] => [(x * 37 + y * 11) & 0xff, (x * 5) & 0xff, (y * 9 + 100) & 0xff];
// Three pixels changed, one of them only in its blue channel.
const touched = (x: number, y: number): [number, number, number] => {
  const p = base(x, y);
  if ((x === 2 && y === 3) || (x === 9 && y === 9)) return [255 - p[0], p[1], p[2]];
  if (x === 0 && y === 0) return [p[0], p[1], p[2] ^ 1];
  return p;
};

test("whatever filter each picture's rows were written with, the same pixels compare equal and three changed pixels of 100 read 0.03", () => {
  for (let f = 0; f <= 4; f++)
    for (let g = 0; g <= 4; g++) {
      assert.equal(pngDifference(png(10, 10, base, f), png(10, 10, base, g)), 0, `filters ${f}, ${g}`);
      assert.equal(pngDifference(png(10, 10, base, f), png(10, 10, touched, g)), 0.03, `filters ${f}, ${g}`);
    }
});

test("pictures that can't be compared differ wholly", () => {
  assert.equal(pngDifference(png(10, 10, base, 0), png(10, 9, base, 0)), 1);
  assert.equal(pngDifference(new TextEncoder().encode("not a picture"), png(10, 10, base, 0)), 1);
});
