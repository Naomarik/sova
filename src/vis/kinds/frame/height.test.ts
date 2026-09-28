import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_HTML_HEIGHT, estimateHeight, frameHash, rememberHeight, resetHeightCache } from "./height";
import type { FrameSpec } from "./parse";

const html = (source: string): FrameSpec => ({ kind: "html", source });
const svg = (source: string): FrameSpec => ({ kind: "svg", source });
const WIDTHS = [296, 322, 390, 600, 900];

test("hash: stable, and differs by kind and by source", () => {
  assert.equal(frameHash(html("<p>a</p>")), frameHash(html("<p>a</p>")));
  assert.notEqual(frameHash(html("<p>a</p>")), frameHash(html("<p>b</p>")));
  assert.notEqual(frameHash(html("<svg></svg>")), frameHash(svg("<svg></svg>")));
});

test("html: the default until the frame has reported; then what it reported, at the nearest width", () => {
  resetHeightCache();
  const s = html("<p>hello</p>");
  for (const w of WIDTHS) assert.equal(estimateHeight(s, w), DEFAULT_HTML_HEIGHT);
  rememberHeight(s, 692, 184);
  rememberHeight(s, 322, 230);
  assert.equal(estimateHeight(s, 692), 184);
  assert.equal(estimateHeight(s, 700), 184);
  assert.equal(estimateHeight(s, 322), 230);
  assert.equal(estimateHeight(s, 330), 230);
  assert.equal(estimateHeight(s, 1000), 184, "far from every width seen: still the nearest one, not the default");
  assert.equal(estimateHeight(html("<p>other</p>"), 692), DEFAULT_HTML_HEIGHT);
  rememberHeight(s, 692, 99999);
  assert.equal(estimateHeight(s, 692), 1400, "clamped to the frame's cap");
});

test("svg: its drawn height from the viewBox and width attribute, plus the body padding; sane over widths", () => {
  resetHeightCache();
  // No width attribute: natural size is the viewBox width (460), shrunk to the room.
  const wide = svg('<svg viewBox="0 0 460 210" role="img"><rect stroke-width="2"/></svg>');
  assert.equal(estimateHeight(wide, 692), Math.ceil(210 + 24));
  assert.equal(estimateHeight(wide, 322), Math.ceil((306 * 210) / 460 + 16));
  // A width attribute is the natural size.
  assert.equal(estimateHeight(svg('<svg viewBox="0 0 120 60" width="120" height="60"></svg>'), 900), 60 + 24);
  assert.equal(estimateHeight(svg('<svg viewBox="0 0 900 100" width="900" height="100"></svg>'), 692), Math.ceil((668 * 100) / 900 + 24));
  // No viewBox: width and height attributes give the aspect.
  assert.equal(estimateHeight(svg('<svg width="200" height="100"></svg>'), 900), 100 + 24);
  // Neither: the default.
  assert.equal(estimateHeight(svg("<svg></svg>"), 900), DEFAULT_HTML_HEIGHT);
  let last = 0;
  for (const w of WIDTHS.filter((w) => w > 420)) {
    const h = estimateHeight(wide, w);
    assert.ok(h >= last && h <= 1400, `${w}: ${h}`);
    last = h;
  }
  // Once it has reported, the report wins.
  rememberHeight(wide, 692, 236);
  assert.equal(estimateHeight(wide, 692), 236);
});
