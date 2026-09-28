/**
 * The height TimelineView renders at a given body width, from timeline.css' metrics (tokens: fs-body
 * 14.5 × lh-body 1.55, fs-caption 12.5 × lh-caption 1.45, fs-mono 12.5, fs-micro 11, space-1..3 4/8/12).
 * Pure: the shell reserves this much before the View arrives. Change it with timeline.css.
 */

import { canvasMeasure, wrap, type Measure } from "../../core/text";
import type { TimelineSpec } from "./parse";

const LABEL = { px: 14.5, lh: 14.5 * 1.55 };
const NOTE = { px: 12.5, lh: 12.5 * 1.45 };
const WHEN_LH = 12.5 * 1.55; // mono, wide
const MICRO_LH = 11 * 1.55; // the when above its label on a phone, and section labels
const ROW_PAD = 4 + 4;
const BADGE = 18 + 4;
/** timeline.css' `@container vis-timeline (max-width: 404px)`: the box is as wide as the body. */
export const TIMELINE_NARROW = 404;

export function estimateHeight(spec: TimelineSpec, width: number, measure: Measure = canvasMeasure): number {
  const narrow = width <= TIMELINE_NARROW;
  const em = new Set((spec.emphasis ?? []).filter((e) => e.n).map((e) => Number(e.key)));
  const whenCol = Math.max(14.5 * 2.5, ...spec.items.map((it) => (it.type === "event" ? measure(it.when, 12.5, true) : 0))) + 8;
  // text column: width − [when column] − rail − column gaps − the row's right padding
  const textW = Math.max(40, narrow ? width - 24 - 4 - 8 : width - whenCol - 16 - 2 * 8 - 8);
  const lines = (s: string, px: number, w: number) => wrap(s, w, 99, px, measure).length;
  let h = 0;
  spec.items.forEach((it, i) => {
    if (it.type === "section") {
      h += (i === 0 ? 0 : 12) + 4 + MICRO_LH;
      return;
    }
    // A badge sits inline before the label's first word: it narrows only the first line.
    const label = em.has(i) ? wrap(`\u0000 ${it.label}`, textW, 99, LABEL.px, (t, px) => (t.startsWith("\u0000") ? BADGE + measure(t.slice(2), px) : measure(t, px))).length : lines(it.label, LABEL.px, textW);
    const text = label * LABEL.lh + (it.note ? lines(it.note, NOTE.px, textW) * NOTE.lh : 0);
    h += ROW_PAD + (narrow ? MICRO_LH + text : Math.max(WHEN_LH, text));
  });
  return h;
}
