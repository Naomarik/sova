/**
 * `vis layers`: the drawing's height at a given `.vis-body` content width, before the View draws, so
 * the figure can reserve its space. It repeats layers.css's fixed geometry (keep the two in step):
 * bands with 1px borders, 8px × 12px padding (8px all round on a phone), 4px apart; a 128px label
 * column beside the items (above them on a phone); 22px label lines, chips of 18px lines with 2px
 * padding and a 1px border, 4px apart; 18px note lines. Pure: no DOM.
 */

import { emphasisMap } from "../../core/emphasis";
import { looksLikePath, wrap } from "../../core/text";
import { htmlMeasure, type Measure, type WeightedMeasure } from "../tree/measure";
import type { LayersSpec } from "./parse";

const LABEL_COL = 128;
const BODY_PX = 14.5;
const SMALL_PX = 12.5;
const BORDER = 2;
const GAP = 4;
const BADGE = 22;
/**
 * The phone layout starts when the figure is at most 420px wide. The body pads 8px there and 12px
 * above it, plus the figure's 1px borders, so a content width up to 402px can only be the phone one.
 */
export const LAYERS_NARROW = 402;

const lineCount = (s: string, w: number, px: number, measure: Measure, mono = false) => wrap(s, Math.max(1, w), 99, px, measure, mono).length;

export function estimateHeight(spec: LayersSpec, width: number, measure: WeightedMeasure = htmlMeasure): number {
  const narrow = width <= LAYERS_NARROW;
  const inner = width - BORDER - (narrow ? 16 : 24);
  const labelW = narrow ? inner : LABEL_COL;
  const bodyW = narrow ? inner : inner - LABEL_COL - 8;
  const em = emphasisMap(spec);
  const regular = measure(400);
  const semibold = measure(600);
  const bands = spec.layers.map((l, i) => {
    const badge = em.get(String(i))?.n !== undefined ? BADGE : 0;
    const labelH = 1 + 22 * lineCount(l.label, labelW - badge, BODY_PX, semibold);
    const bodyH = itemsHeight(l.items, bodyW, regular) + (l.note ? (l.items.length ? GAP : 3) + 18 * lineCount(l.note, bodyW, SMALL_PX, regular) : 0);
    // On a phone the body is a second grid row, and the 4px row gap stands even when it's empty.
    return 16 + BORDER + (narrow ? labelH + GAP + bodyH : Math.max(labelH, bodyH));
  });
  return Math.ceil(bands.reduce((a, b) => a + b, 0) + GAP * Math.max(0, bands.length - 1));
}

/** The chips, flowed into rows as flex-wrap does. */
function itemsHeight(items: string[], w: number, measure: Measure): number {
  if (!items.length) return 0;
  let rows = 0;
  let rowH = 0;
  let x = 0;
  let total = 0;
  for (const item of items) {
    const mono = looksLikePath(item);
    const textW = measure(item, SMALL_PX, mono);
    const cw = Math.min(w, textW + 18);
    const ch = 6 + 18 * (textW + 18 > w ? lineCount(item, w - 18, SMALL_PX, measure, mono) : 1);
    if (rows === 0 || x + cw > w) {
      if (rows) total += rowH + GAP;
      rows++;
      rowH = 0;
      x = 0;
    }
    x += cw + GAP;
    rowH = Math.max(rowH, ch);
  }
  return total + rowH;
}
