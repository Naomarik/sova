// Run: pnpm test server/tours/palette.test.ts. A picture's main colours, measured from its pixels with no model.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanPalette, paletteOf } from "./palette";

const pixels = (parts: [number, number, number, number, number][]): number[] => parts.flatMap(([r, g, b, a, n]) => Array.from({ length: n }, () => [r, g, b, a]).flat());

test("the main colours, largest first, near shades merged, specks and transparency left out", () => {
  const p = paletteOf(pixels([[242, 242, 247, 255, 600], [244, 244, 249, 255, 100], [74, 67, 216, 255, 200], [23, 23, 28, 255, 95], [255, 0, 0, 255, 5], [0, 255, 0, 0, 500]]));
  assert.equal(p.length, 3);
  assert.deepEqual(p.map((c) => c.share), [0.7, 0.2, 0.1]);
  assert.match(p[0]!.hex, /^#f[23]f[23]f[78]$/);
  assert.equal(p[1]!.hex, "#4a43d8");
  assert.equal(p[2]!.hex, "#17171c");
  assert.deepEqual(paletteOf([]), []);
  assert.equal(paletteOf(pixels(Array.from({ length: 10 }, (_, i) => [i * 25, 255 - i * 25, (i * 70) % 256, 255, 10] as [number, number, number, number, number]))).length, 6);
});

test("a palette from the child is kept only as well-formed colours", () => {
  assert.deepEqual(cleanPalette([{ hex: "#4a43d8", share: 0.4 }, { hex: "red", share: 0.1 }, { hex: "#000000", share: 2 }]), [{ hex: "#4a43d8", share: 0.4 }]);
  assert.equal(cleanPalette("x"), undefined);
  assert.equal(cleanPalette([]), undefined);
});
