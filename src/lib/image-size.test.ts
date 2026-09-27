import assert from "node:assert/strict";
import { test } from "node:test";
import { dataUrlSize } from "./image-size";

const url = (mime: string, bytes: number[]) => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >> 8) & 255];
const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const str = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** A PNG chunk: length, type, data, a (never checked) CRC. */
const chunk = (type: string, data: number[]) => [...be32(data.length), ...str(type), ...data, 0, 0, 0, 0];
const png = (w: number, h: number, extra: number[] = []) => [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ...chunk("IHDR", [...be32(w), ...be32(h), 8, 6, 0, 0, 0]),
  ...extra,
  ...chunk("IDAT", [1, 2, 3]),
  ...chunk("IEND", []),
];

const gif = (w: number, h: number) => [...str("GIF89a"), ...le16(w), ...le16(h), 0, 0, 0, 0x3b];

const riff = (body: number[]) => [...str("RIFF"), ...le32(body.length + 4), ...str("WEBP"), ...body];
const webpLossy = (w: number, h: number) =>
  riff([...str("VP8 "), ...le32(10), 0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h), 0, 0]);
const webpLossless = (w: number, h: number) => {
  const bits = (w - 1) | ((h - 1) << 14);
  return riff([...str("VP8L"), ...le32(5), 0x2f, ...le32(bits), 0, 0, 0, 0]);
};
const webpExtended = (w: number, h: number, flags = 0x10) =>
  riff([...str("VP8X"), ...le32(10), flags, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);

/** A JPEG segment: marker, length (counting itself), data. */
const seg = (marker: number, data: number[]) => [0xff, marker, ...be16(data.length + 2), ...data];
const sof = (marker: number, w: number, h: number) => seg(marker, [8, ...be16(h), ...be16(w), 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
const jpeg = (...segments: number[][]) => [0xff, 0xd8, ...segments.flat(), 0xff, 0xda, 0, 2, 0xff, 0xd9];
const app0 = seg(0xe0, [...str("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const dqt = seg(0xdb, new Array(65).fill(1));

/** An APP1 EXIF segment whose IFD0 holds `entries` ([tag, type, count, value]), big- or little-endian,
    plus rationals appended after the IFD (their offsets are filled in). */
function exif(le: boolean, entries: [number, number, number, number][], rationals: [number, number][] = []): number[] {
  const u16 = (n: number) => (le ? le16(n) : be16(n));
  const u32 = (n: number) => (le ? le32(n) : be32(n));
  const ifdEnd = 8 + 2 + entries.length * 12 + 4;
  let r = 0;
  const ifd = entries.flatMap(([tag, type, count, value]) => {
    const v = type === 5 ? u32(ifdEnd + 8 * r++) : type === 3 ? [...u16(value), 0, 0] : u32(value);
    return [...u16(tag), ...u16(type), ...u32(count), ...v];
  });
  const tiff = [...str(le ? "II" : "MM"), ...u16(42), ...u32(8), ...u16(entries.length), ...ifd, 0, 0, 0, 0, ...rationals.flatMap(([n, d]) => [...u32(n), ...u32(d)])];
  return seg(0xe1, [...str("Exif"), 0, 0, ...tiff]);
}

test("PNG: the IHDR size", () => {
  assert.deepEqual(dataUrlSize(url("image/png", png(1920, 1080))), { w: 1920, h: 1080 });
  assert.deepEqual(dataUrlSize(url("image/png", png(1, 70000))), { w: 1, h: 70000 });
  assert.deepEqual(dataUrlSize(url("image/png", png(640, 480, chunk("pHYs", [0, 0, 11, 19, 0, 0, 11, 19, 1])))), { w: 640, h: 480 }, "chunks before IDAT are walked");
});

test("PNG with an eXIf chunk is left to the browser", () => {
  assert.equal(dataUrlSize(url("image/png", png(640, 480, chunk("eXIf", [...str("MM"), 0, 42, 0, 0, 0, 8])))), null);
});

test("GIF: the logical screen size", () => {
  assert.deepEqual(dataUrlSize(url("image/gif", gif(300, 7))), { w: 300, h: 7 });
  assert.deepEqual(dataUrlSize(url("image/gif", [...str("GIF87a"), ...le16(65535), ...le16(2), 0, 0, 0, 0x3b])), { w: 65535, h: 2 });
});

test("WebP: lossy, lossless and extended", () => {
  assert.deepEqual(dataUrlSize(url("image/webp", webpLossy(800, 600))), { w: 800, h: 600 });
  assert.deepEqual(dataUrlSize(url("image/webp", webpLossless(16383, 1))), { w: 16383, h: 1 });
  assert.deepEqual(dataUrlSize(url("image/webp", webpLossless(123, 4567))), { w: 123, h: 4567 });
  assert.deepEqual(dataUrlSize(url("image/webp", webpExtended(5000, 3000))), { w: 5000, h: 3000 });
  assert.equal(dataUrlSize(url("image/webp", webpExtended(5000, 3000, 0x08))), null, "an EXIF flag is left to the browser");
});

test("JPEG: the SOF size, past other segments, for every SOFn", () => {
  assert.deepEqual(dataUrlSize(url("image/jpeg", jpeg(app0, dqt, sof(0xc0, 1024, 768)))), { w: 1024, h: 768 });
  assert.deepEqual(dataUrlSize(url("image/jpeg", jpeg(app0, sof(0xc2, 33, 44)))), { w: 33, h: 44 }, "progressive");
  assert.deepEqual(dataUrlSize(url("image/jpeg", jpeg(seg(0xc4, [0, 1, 2]), sof(0xc1, 5, 6)))), { w: 5, h: 6 }, "DHT (C4) is not a frame");
  assert.deepEqual(dataUrlSize(url("image/jpeg", [0xff, 0xd8, 0xff, 0xff, ...sof(0xc0, 9, 10)])), { w: 9, h: 10 }, "fill bytes");
});

test("JPEG: a segment far into the file is reached without decoding what it skips", () => {
  const big = seg(0xe2, new Array(60000).fill(0x41));
  assert.deepEqual(dataUrlSize(url("image/jpeg", jpeg(app0, big, big, big, sof(0xc0, 4032, 3024)))), { w: 4032, h: 3024 });
});

test("JPEG: an EXIF orientation that turns a quarter swaps width and height", () => {
  for (const le of [true, false]) {
    for (let o = 1; o <= 8; o++) {
      const got = dataUrlSize(url("image/jpeg", jpeg(exif(le, [[0x0112, 3, 1, o]]), sof(0xc0, 400, 300))));
      assert.deepEqual(got, o >= 5 ? { w: 300, h: 400 } : { w: 400, h: 300 }, `orientation ${o} (${le ? "II" : "MM"})`);
    }
  }
});

test("JPEG: an EXIF resolution of 72 dpi is plain; any other is left to the browser", () => {
  const res = (n: number, d: number) => jpeg(exif(true, [[0x011a, 5, 1, 0], [0x011b, 5, 1, 0], [0x0128, 3, 1, 2]], [[n, d], [n, d]]), sof(0xc0, 400, 300));
  assert.deepEqual(dataUrlSize(url("image/jpeg", res(72, 1))), { w: 400, h: 300 });
  assert.deepEqual(dataUrlSize(url("image/jpeg", res(720, 10))), { w: 400, h: 300 });
  assert.equal(dataUrlSize(url("image/jpeg", res(144, 1))), null);
  assert.equal(dataUrlSize(url("image/jpeg", res(72, 0))), null);
});

test("not a base64 data URL, or not an image this reads: null", () => {
  for (const src of [
    "",
    "https://example.com/a.png",
    "/api/attachment?path=%2Ftmp%2Fa.png",
    "data:image/png,rawbytes",
    "data:image/svg+xml;base64," + Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'/>").toString("base64"),
    url("image/avif", [0, 0, 0, 0x1c, ...str("ftypavif"), 0, 0, 0, 0]),
    "data:image/png;base64",
  ]) assert.equal(dataUrlSize(src), null, JSON.stringify(src.slice(0, 40)));
});

test("malformed and truncated headers: null, never a throw", () => {
  const cut = (b: number[], n: number) => b.slice(0, n);
  const inputs: [string, number[]][] = [
    ["png", cut(png(10, 10), 20)],
    ["png", cut(png(10, 10), 33)],
    ["png", png(0, 10)],
    ["png", [...png(10, 10).slice(0, 12), ...str("XXXX"), ...png(10, 10).slice(16)]],
    ["gif", cut(gif(10, 10), 7)],
    ["gif", cut(gif(10, 300), 9)],
    ["png", cut(png(10, 300), 23)],
    ["webp", cut(webpLossless(10, 300), 24)],
    ["webp", cut(webpExtended(10, 300), 29)],
    ["webp", cut(webpLossy(10, 300), 29)],
    ["gif", gif(0, 5)],
    ["webp", cut(webpLossy(10, 10), 24)],
    ["webp", riff([...str("VP8 "), ...le32(10), 0x10, 0x02, 0x00, 0x00, 0x00, 0x00, ...le16(5), ...le16(5), 0, 0])],
    ["webp", riff([...str("VP8L"), ...le32(5), 0x00, 0, 0, 0, 0, 0, 0, 0, 0])],
    ["webp", riff([...str("ALPH"), ...le32(10), ...new Array(14).fill(0)])],
    ["jpeg", [0xff, 0xd8]],
    ["jpeg", cut(jpeg(app0, sof(0xc0, 10, 10)), 25)],
    ["jpeg", jpeg(app0)],
    ["jpeg", [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, ...sof(0xc0, 1, 1)]],
    ["jpeg", [0xff, 0xd8, 0x00, 0x00, ...sof(0xc0, 1, 1)]],
    ["jpeg", jpeg(seg(0xe1, [...str("Exif"), 0, 0, ...str("XX")]), sof(0xc0, 10, 10))],
    ["jpeg", jpeg(seg(0xe1, [...str("Exif"), 0, 0, ...str("II"), 42, 0, 0xff, 0xff, 0, 0]), sof(0xc0, 10, 10))],
  ];
  for (const [kind, bytes] of inputs) assert.equal(dataUrlSize(url(`image/${kind}`, bytes)), null, `${kind} ${bytes.length} bytes`);
  for (const src of ["data:image/png;base64,!!!!", "data:image/png;base64,iVBORw0KGgo=====", "data:image/jpeg;base64,/9j/" + "@".repeat(40)])
    assert.equal(dataUrlSize(src), null, src);
});

test("the MIME type is not trusted: the bytes decide", () => {
  assert.deepEqual(dataUrlSize(url("image/jpeg", png(12, 34))), { w: 12, h: 34 });
  assert.deepEqual(dataUrlSize(url("application/octet-stream", gif(5, 6))), { w: 5, h: 6 });
});

test("a repeated URL answers from the memo, and many distinct ones never grow it without bound", () => {
  const a = url("image/png", png(111, 222));
  assert.deepEqual(dataUrlSize(a), { w: 111, h: 222 });
  assert.equal(dataUrlSize(a), dataUrlSize(a), "same answer object: memoized");
  for (let i = 1; i <= 1200; i++) assert.deepEqual(dataUrlSize(url("image/png", png(i, 7))), { w: i, h: 7 });
  assert.deepEqual(dataUrlSize(a), { w: 111, h: 222 }, "an evicted entry is parsed again");
});
