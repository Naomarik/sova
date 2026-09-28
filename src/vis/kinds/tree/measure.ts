/**
 * Text widths for the HTML kinds' height estimates (tree, layers): the width the browser will lay the
 * text out at, so the estimate wraps where the page wraps. Unlike core/text's canvasMeasure (one
 * weight, 3% slack so an SVG box never clips) it takes the text's real weight and adds nothing.
 * Off the DOM (node tests) it is core/text's estimate. Pure apart from the guarded canvas.
 */

import { estimateWidth } from "../../core/text";

/** (text, px, mono) → width, at one weight: what core/text's wrap() takes. */
export type Measure = (text: string, px: number, mono?: boolean) => number;
export type WeightedMeasure = (weight: number) => Measure;

let ctx: CanvasRenderingContext2D | null | undefined;
const memo = new Map<string, number>();

export const htmlMeasure: WeightedMeasure = (weight) => (text, px, mono = false) => {
  if (ctx === undefined) ctx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!ctx) return estimateWidth(text, px, mono);
  const key = `${weight}${mono ? "m" : "s"}${px}|${text}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  ctx.font = mono ? `400 ${px}px "JetBrains Mono", ui-monospace, monospace` : `${weight} ${px}px Inter, system-ui, sans-serif`;
  const w = ctx.measureText(text).width;
  if (memo.size > 4000) memo.clear();
  memo.set(key, w);
  return w;
};

/** The same measure at every weight: for tests. */
export const unweighted = (m: Measure): WeightedMeasure => () => m;
