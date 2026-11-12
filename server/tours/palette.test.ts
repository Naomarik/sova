// Run: pnpm test server/tours/palette.test.ts. A picture's main colours, measured from its pixels with no model.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanPalette, paletteOf, type MeasuredColor } from "./palette";

type RGB = [number, number, number];
const hexOf = (c: RGB) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const rgbOf = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;
const nearest = (p: MeasuredColor[], want: RGB) => p.map((c) => ({ c, d: Math.hypot(...rgbOf(c.hex).map((v, i) => v - want[i]!)) })).sort((a, b) => a.d - b.d)[0]!;

/** A canvas to paint rectangles on. */
function canvas(w: number, h: number, fill: RGB) {
  const px = new Uint8Array(w * h * 4);
  const rect = (x: number, y: number, rw: number, rh: number, c: RGB) => {
    for (let j = y; j < Math.min(h, y + rh); j++)
      for (let i = x; i < Math.min(w, x + rw); i++) px.set([...c, 255], (j * w + i) * 4);
  };
  rect(0, 0, w, h, fill);
  return { px, rect };
}

test("a dark screen keeps its light text, a 2px indigo line and small amber marks, beside its page and surface greys", () => {
  const W = 1024, H = 640;
  const page: RGB = [0x1e, 0x1e, 0x26], surface: RGB = [0x2c, 0x2c, 0x38], divider: RGB = [0x3b, 0x3b, 0x49];
  const text: RGB = [0xe8, 0xe8, 0xee], indigo: RGB = [0x8e, 0x88, 0xff], amber: RGB = [0xe0, 0xa0, 0x30];
  const { px, rect } = canvas(W, H, page);
  rect(200, 60, 800, 560, surface);
  // Rows: a divider each, and a line of "text" made of 1-2px strokes.
  for (let row = 0; row < 12; row++) {
    const y = 90 + row * 44;
    rect(200, y + 40, 800, 1, divider);
    for (let x = 230; x < 700; x += 7) rect(x, y + 12, 2, 1 + (x % 3), text), rect(x + 2, y + 16, 1, 6, text);
    // An amber mark on a few rows: a 3px left edge and a short label.
    if (row % 4 === 0) rect(200, y, 3, 40, amber), rect(720, y + 14, 30, 2, amber);
  }
  // The active tab's underline: 2px of indigo, 120px long.
  rect(240, 56, 120, 2, indigo);
  const p = paletteOf(px, W);
  assert.ok(p.length <= 8, `${p.length} colours`);
  for (const [name, want] of Object.entries({ page, surface, text, indigo, amber })) {
    const hit = nearest(p, want);
    assert.ok(hit.d < 14, `${name} ${hexOf(want)}: nearest ${hit.c.hex} (${hit.d.toFixed(1)}) in ${p.map((c) => c.hex).join(" ")}`);
  }
  // What each sits on: the accents and the text on strokes, the background on an area; saturation says which are colours.
  assert.equal(nearest(p, indigo).c.thin, true);
  assert.equal(nearest(p, text).c.thin, true);
  assert.equal(nearest(p, page).c.thin, undefined);
  assert.ok(nearest(p, amber).c.saturation! > 0.5);
  assert.ok(nearest(p, surface).c.saturation! < 0.1);
  assert.equal(p[0]!.hex, nearest(p, surface).c.hex, "largest first");
});

test("the main colours, largest first, specks and transparency left out", () => {
  const pixels = (parts: [number, number, number, number, number][]): number[] => parts.flatMap(([r, g, b, a, n]) => Array.from({ length: n }, () => [r, g, b, a]).flat());
  const p = paletteOf(pixels([[242, 242, 247, 255, 700], [74, 67, 216, 255, 200], [23, 23, 28, 255, 95], [255, 0, 0, 255, 5], [0, 255, 0, 0, 500]]));
  assert.deepEqual(p.map((c) => c.hex), ["#f2f2f7", "#4a43d8", "#17171c"]);
  assert.deepEqual(p.map((c) => c.share), [0.7, 0.2, 0.095]);
  assert.deepEqual(paletteOf([]), []);
});

test("a palette from the child is kept only as well-formed colours", () => {
  assert.deepEqual(cleanPalette([{ hex: "#4a43d8", share: 0.4, saturation: 0.6, thin: true }, { hex: "red", share: 0.1 }, { hex: "#000000", share: 2 }]), [{ hex: "#4a43d8", share: 0.4, saturation: 0.6, thin: true }]);
  assert.equal(cleanPalette("x"), undefined);
  assert.equal(cleanPalette([]), undefined);
});
