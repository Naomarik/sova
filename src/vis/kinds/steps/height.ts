/**
 * `vis steps`: the drawing's height at a given `.vis-body` content width, before the View draws, so
 * the figure can reserve its space. It repeats steps.css' fixed geometry (keep the two in step):
 * rows with 1px borders and 6px × 8px padding, 4px apart; a 144px label column (above the chain on a
 * phone, 4px over it) whose 22px lines follow a 16px status mark and a 6px gap; chips of 18px lines
 * with 2px × 8px padding and a 1px border, each after the first led by a 20px arrow, wrapping 4px
 * apart; lane heads of 18px lines, 8px more above all but the first item. Pure: no DOM.
 */

import { emphasisMap } from "../../core/emphasis";
import { looksLikePath, wrap } from "../../core/text";
import { htmlMeasure, type Measure, type WeightedMeasure } from "../tree/measure";
import type { StepsSpec } from "./parse";

const LABEL_COL = 144;
const BODY_PX = 14.5;
const SMALL_PX = 12.5;
const GAP = 4;
const MARK = 16 + 6;
const BADGE = 22;
const ARROW = 20;
const CHIP_X = 16 + 2;
/** The phone layout: the figure at most 420px wide, so a content width up to 402px (as layers). */
export const STEPS_NARROW = 402;

const lineCount = (s: string, w: number, px: number, measure: Measure, mono = false) => wrap(s, Math.max(1, w), 99, px, measure, mono).length;

export function estimateHeight(spec: StepsSpec, width: number, measure: WeightedMeasure = htmlMeasure): number {
  const narrow = width <= STEPS_NARROW;
  const inner = width - 2 - 16;
  const labelW = narrow ? inner : LABEL_COL;
  const chainW = narrow ? inner : inner - LABEL_COL - 8;
  const em = emphasisMap(spec);
  const heights = spec.items.map((it, i) => {
    if (it.type === "lane") return (i === 0 ? 0 : 8) + 18 * lineCount(it.label, width, SMALL_PX, measure(600));
    const badge = em.get(String(i))?.n !== undefined ? BADGE : 0;
    const labelH = 22 * lineCount(it.label, labelW - MARK - badge, BODY_PX, measure(600));
    const chainH = chainHeight(it.steps, chainW, measure(400));
    return 12 + 2 + (narrow ? labelH + GAP + chainH : Math.max(labelH, chainH));
  });
  return Math.ceil(heights.reduce((a, b) => a + b, 0) + GAP * Math.max(0, heights.length - 1));
}

/** The chips, each after the first led by its arrow, flowed into rows as flex-wrap does. */
function chainHeight(steps: string[], w: number, measure: Measure): number {
  let rows = 0;
  let rowH = 0;
  let x = 0;
  let total = 0;
  steps.forEach((step, i) => {
    const lead = i === 0 ? 0 : ARROW;
    const mono = looksLikePath(step);
    const textW = measure(step, SMALL_PX, mono);
    const iw = Math.min(w, lead + textW + CHIP_X);
    const ih = 6 + 18 * (lead + textW + CHIP_X > w ? lineCount(step, w - lead - CHIP_X, SMALL_PX, measure, mono) : 1);
    if (rows === 0 || x + iw > w) {
      if (rows) total += rowH + GAP;
      rows++;
      rowH = 0;
      x = 0;
    }
    x += iw;
    rowH = Math.max(rowH, ih);
  });
  return total + rowH;
}
