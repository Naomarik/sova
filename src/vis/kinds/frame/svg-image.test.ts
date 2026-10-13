// `vis svg` as a still image on share and owner pages (§app.baton/outsider-view): the document only
// ever inside the image's data URL, with the page's tokens and font first so its own styles win.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { tokenCss } from "./srcdoc";
import { SVG_IMAGE_FONT, svgDefaultsCss, svgImageDocument, svgImageSrc, svgNaturalWidth } from "./svg-image";

const TOKENS = tokenCss({ "--color-ink": "#e8e8e8", "--color-ink-muted": "#9a9a9a" }, "dark");

test("the defaults are the first child of the root, so the drawing's own <style> comes after them and wins", () => {
  const doc = svgImageDocument('<svg viewBox="0 0 9 9"><style>text{fill:red}</style><text>hi</text></svg>', TOKENS);
  assert.equal(doc, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 9 9"><style>${svgDefaultsCss(TOKENS)}</style><style>text{fill:red}</style><text>hi</text></svg>`);
  assert.ok(doc.indexOf("--color-ink-muted:#9a9a9a") < doc.indexOf("text{fill:red}"));
});

test("the defaults carry the tokens on :root and a font, size and colour that never outrank the drawing's", () => {
  const css = svgDefaultsCss(TOKENS);
  assert.match(css, /^:root\{--color-ink:#e8e8e8;--color-ink-muted:#9a9a9a;color-scheme:dark\}/);
  // Zero specificity, and only for a root without its own attribute: a root `font-size="9"` or a
  // model `svg{…}` rule keeps its value.
  assert.ok(css.includes(`:where(svg:not([font-family])){font-family:${SVG_IMAGE_FONT}}`));
  assert.ok(css.includes(":where(svg:not([font-size])){font-size:14px}"));
  assert.ok(css.includes(":where(svg:not([color])){color:var(--color-ink)}"));
  assert.match(SVG_IMAGE_FONT, /sans-serif$/);
});

test("a root tag is read whole: its own namespace kept, an xml declaration, quoted '>' and a self-closing root", () => {
  const ns = svgImageDocument('<svg xmlns="http://www.w3.org/2000/svg" data-x="a>b" viewBox="0 0 9 9"><g/></svg>', TOKENS);
  assert.ok(ns.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" data-x="a>b" viewBox="0 0 9 9"><style>`));
  assert.equal(ns.match(/xmlns=/g)!.length, 1);
  const decl = svgImageDocument('<?xml version="1.0"?>\n<svg\n  viewBox="0 0 9 9"\n><rect/></svg>', TOKENS);
  assert.match(decl, /^<\?xml version="1\.0"\?>\n<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"\n {2}viewBox="0 0 9 9"><style>[^<]+<\/style><rect\/><\/svg>$/);
  assert.match(svgImageDocument('<svg viewBox="0 0 9 9"/>', TOKENS), /^<svg xmlns="[^"]+" viewBox="0 0 9 9"><style>[^<]+<\/style><\/svg>$/);
});

test("nothing from a token can close the style: tokenCss drops markup, and the defaults strip any < or &", () => {
  const evil = tokenCss({ "--color-ink": "red</style><script>alert(1)</script>" }, "light");
  assert.doesNotMatch(evil, /</);
  assert.doesNotMatch(svgImageDocument('<svg viewBox="0 0 1 1"></svg>', ":root{--x:a<b&c}"), /a<b|&c/);
});

test("the image's src is the document as a data URL, and nothing of it is markup outside the URL", () => {
  const svg = '<svg viewBox="0 0 336 244"><script>alert(1)</script><g style="fill:var(--color-ink-muted)"><text>1 · "q" & a</text></g></svg>';
  const src = svgImageSrc(svg, TOKENS);
  assert.ok(src.startsWith("data:image/svg+xml;charset=utf-8,"));
  assert.doesNotMatch(src, /[<>"' ]/, "an attribute value that can't end its attribute or open a tag");
  assert.equal(decodeURIComponent(src.slice(src.indexOf(",") + 1)), svgImageDocument(svg, TOKENS));
});

test("the natural width is the viewBox's when the root has no width of its own", () => {
  assert.equal(svgNaturalWidth('<svg viewBox="0 0 336 244" xmlns="http://www.w3.org/2000/svg">'), 336);
  assert.equal(svgNaturalWidth("<svg viewBox='-10,0,120.5,40'></svg>"), 120.5);
  assert.equal(svgNaturalWidth('<svg width="200" viewBox="0 0 336 244"></svg>'), undefined);
  assert.equal(svgNaturalWidth("<svg></svg>"), undefined);
  assert.equal(svgNaturalWidth('<svg viewBox="0 0 0 10"></svg>'), undefined);
  assert.equal(svgNaturalWidth('<svg data-width="5" viewBox="0 0 40 10"></svg>'), 40);
});

test("the share View puts the document only in the image's src, never in the page", () => {
  const view = readFileSync(new URL("./ImageView.tsx", import.meta.url), "utf8");
  assert.match(view, /<img src=\{url\(\)\}/);
  assert.match(view, /svgImageSrc\(props\.spec\.source,/);
  assert.doesNotMatch(view, /innerHTML|outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment/);
  // And the share build mounts it for svg.
  assert.match(readFileSync(new URL("../../share-views.ts", import.meta.url), "utf8"), /export \{ default as svg \} from "\.\/kinds\/frame\/ImageView";/);
});
