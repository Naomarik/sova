import assert from "node:assert/strict";
import { test } from "node:test";
import { fitPlaceholder, type PlaceholderSize } from "./placeholder-fit";

/** Whole-number widths: a character is 9px at the body size and 7px at the caption size. */
const measure = (text: string, size: PlaceholderSize) => text.length * (size === "caption" ? 7 : 9);

/** The composer's streaming placeholder, whose key hint is the part a narrow box can spare. */
const steer = ["Steer the current turn…", "Enter sends"];
/** The group composer's, whose parts are joined by an em dash. */
const group = ["Ask all 4 members…", "Enter sends, Shift+Enter adds a line"];

test("the whole placeholder is shown at the body size while it fits", () => {
  // "Enter sends, Shift+Enter adds a line" with the em dash: 56 characters, 504px.
  const fit = fitPlaceholder({ parts: group, join: "—", avail: 600, measure });
  assert.deepEqual(fit, { text: "Ask all 4 members…—Enter sends, Shift+Enter adds a line", size: "body" });
});

test("a string measuring within a pixel of the box steps down rather than gamble on its last glyph", () => {
  // 11 characters: 99px wide, where the box is 99 then 100. The measurement is not the layout, so
  // the box that leaves no room for rounding takes the caption size instead.
  assert.deepEqual(fitPlaceholder({ parts: ["Enter sends"], avail: 99, measure }), { text: "Enter sends", size: "caption" });
  assert.deepEqual(fitPlaceholder({ parts: ["Enter sends"], avail: 100, measure }), { text: "Enter sends", size: "body" });
});

test("the whole placeholder steps down to the caption size before any of it is dropped", () => {
  // 35 characters with the join: 315px at the body size, 245 at the caption. A 280px box has room
  // for the whole string, one size down, so nothing is given up.
  const fit = fitPlaceholder({ parts: steer, avail: 280, measure });
  assert.deepEqual(fit, { text: "Steer the current turn… Enter sends", size: "caption" });
});

test("below the caption size the key hint goes, not the sentence", () => {
  // 315px and 245 for the whole, 207 and 161 for the sentence alone. In a 220px box the sentence
  // fits at the body size, so the hint is the part the box gives up.
  const fit = fitPlaceholder({ parts: steer, avail: 220, measure });
  assert.deepEqual(fit, { text: "Steer the current turn…", size: "body" });
});

test("the sentence steps down too once the body size can no longer hold it", () => {
  // 207px at the body size, 161 at the caption: a 180px box shows the sentence, one size down.
  const fit = fitPlaceholder({ parts: steer, avail: 180, measure });
  assert.deepEqual(fit, { text: "Steer the current turn…", size: "caption" });
});

test("a box too narrow for either ends the string in an ellipsis, cut back to a whole word", () => {
  // 130px holds 18 characters at the caption size, ellipsis included, which would cut inside
  // "turn"; the last space is past half of that, so "turn" goes whole rather than half said.
  const fit = fitPlaceholder({ parts: steer, avail: 130, measure });
  assert.deepEqual(fit, { text: "Steer the current…", size: "caption" });
});

test("under two characters of room the cut lands inside the word — half a word beats none", () => {
  // A 20px box holds one character and an ellipsis at the caption size, and no whole word fits
  // in that, so the word is cut: a letter and an ellipsis read better than an empty line.
  const fit = fitPlaceholder({ parts: ["Ask all 4 members…"], avail: 20, measure });
  assert.deepEqual(fit, { text: "A…", size: "caption" });
});

test("the ellipsis alone is the floor for a box nothing fits in", () => {
  assert.deepEqual(fitPlaceholder({ parts: steer, avail: 4, measure }), { text: "…", size: "caption" });
});

test("one part is the whole placeholder, so it is never dropped as if it were a hint", () => {
  // "Ask this member…" alone: 153px at the body size, 119 at the caption, in a 100px box. It is
  // cut like a sentence, never treated as a hint that can go.
  const fit = fitPlaceholder({ parts: ["Ask this member…"], avail: 100, measure });
  assert.deepEqual(fit, { text: "Ask this…", size: "caption" });
});

test("no parts is an empty placeholder, not an ellipsis", () => {
  // A read-only composer: nothing to say, and a box of any width shows nothing.
  assert.deepEqual(fitPlaceholder({ parts: ["", ""], avail: 100, measure }), { text: "", size: "body" });
});

test("an empty hint is no hint: the sentence is whole, not cut", () => {
  // Touch mode, where Enter adds a line: the hint is empty, so the box has the sentence alone to
  // fit (207px here) and shows it whole at the body size.
  const fit = fitPlaceholder({ parts: ["Steer the current turn…", ""], avail: 220, measure });
  assert.deepEqual(fit, { text: "Steer the current turn…", size: "body" });
});
