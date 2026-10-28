import assert from "node:assert/strict";
import { test } from "node:test";
import { CARD_VIEW_BASE_CSS } from "./card-box-css";

/**
 * A view's box starts with Sova's base styles (§chat.transcript-cards/sealed-box, "Sova's look"):
 * every native control a view may write is drawn on the theme's tokens, never the browser's own
 * look, and nothing in them loads a file (the box's policy refuses every request).
 */

/** Each rule's selector list, split on commas, and its declarations. */
const rules = (css: string) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1]!.split(",").map((s) => s.trim()), body: m[2]! }));

const declsFor = (selector: string): string => {
  const hit = rules(CARD_VIEW_BASE_CSS).filter((r) => r.selectors.includes(selector));
  assert.ok(hit.length > 0, `no rule styles ${selector}`);
  return hit.map((r) => r.body).join(";");
};

test("every native control a view may write has a rule of its own", () => {
  for (const selector of [
    "button",
    "input",
    "select",
    "textarea",
    "input[type=checkbox]",
    "input[type=radio]",
    "input[type=checkbox]:checked",
    "input[type=range]",
    "input[type=range]::-webkit-slider-runnable-track",
    "input[type=range]::-webkit-slider-thumb",
    "input[type=range]::-moz-range-track",
    "input[type=range]::-moz-range-thumb",
    "button:focus-visible",
    "input:focus-visible",
    "select:focus-visible",
  ])
    declsFor(selector);
});

test("the controls drop the browser's own look, so the theme's colours show in dark and light alike", () => {
  for (const selector of ["select", "input[type=checkbox]", "input[type=radio]", "input[type=range]", "input[type=range]::-webkit-slider-thumb"]) {
    assert.match(declsFor(selector), /(^|;)\s*(-webkit-)?appearance:none/, `${selector} keeps the browser's own look`);
  }
  assert.match(declsFor("input[type=range]::-webkit-slider-thumb"), /background:var\(--color-accent\)/);
  assert.match(declsFor("input[type=range]::-webkit-slider-runnable-track"), /background:var\(--color-sunken\)/);
  assert.match(declsFor("input[type=checkbox]:checked"), /background:var\(--color-accent\)/);
  assert.match(declsFor("select"), /background:var\(--color-surface\)|background-image/);
});

test("every colour is a theme token, and nothing loads a file", () => {
  for (const { selectors, body } of rules(CARD_VIEW_BASE_CSS)) {
    assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, `${selectors.join(",")} has a literal colour`);
    assert.doesNotMatch(body, /url\(/, `${selectors.join(",")} loads a file`);
  }
});
