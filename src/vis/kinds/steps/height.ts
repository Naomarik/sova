/**
 * `vis steps`: the drawing's height at a given `.vis-body` content width, before the View draws, so
 * the figure can reserve its space. layout.ts picks the layout (the View asks the same function);
 * each layout's estimate repeats steps.css' fixed geometry (keep the two in step):
 * - shared: chips of 18px lines with 2px × 8px padding and a 1px border (a toned step's icon takes
 *   20px of its width); labels of 22px lines after a 16px status mark and a 6px gap (a note number
 *   22px more); lane heads of 18px lines, 8px more above all but the first; items 4px apart.
 * - side: columns 8px apart, cells padded 9px across; heads 7px from the top, each position 18px
 *   (its arrows) above its chips, an empty position 24px; outcomes 10px below; 9px under all.
 * - grid: bands with 1px borders and 6px × 8px padding; a 144px label column, 8px gap, the steps,
 *   and with outcomes 8px and a 120px column (text 3px down); step lines 4px apart.
 * - rail: the band as in the grid; the label, then 4px, then lines 4px apart in a 32px number
 *   column + 8px gap: a chip, a 24px dashed `_` run, a fold or an outcome (each 3px above and below).
 * Pure: no DOM.
 */

import { emphasisMap } from "../../core/emphasis";
import type { Tone } from "../../core/grammar";
import { wrap } from "../../core/text";
import { htmlMeasure, type Measure, type WeightedMeasure } from "../tree/measure";
import { GRID, gridCols, gridStepsWidth, monoPieces, railLines, range, SIDE_GAP, sideLines, stepAt, stepRuns, stepsLayout, type Step } from "./layout";
import type { StepsOutcome, StepsRow, StepsSpec } from "./parse";

export { STEPS_NARROW } from "./layout";

const BODY_PX = 14.5;
const SMALL_PX = 12.5;
const LINE = 18;
const LABEL_LINE = 22;
const GAP = 4;
const MARK = 16 + 6;
const BADGE = 22;
const CHIP_X = 16 + 2;
const CHIP_Y = 4 + 2;
const ICON = 14 + 6;
const BAND_Y = 12 + 2;
const SIDE = { gap: SIDE_GAP, padX: 9, head: 7, conn: 18, gap24: 24, out: 10, foot: 9 } as const;
const RAIL = { top: 4, num: 32 + 8, pad: 6 } as const;
/** The tones a step or outcome shows an icon for (icons.ts' TONE_ICON). */
const ICONED = new Set<Tone>(["ok", "warn", "error", "info"]);
const iconW = (tone: Tone | null | undefined) => (tone && ICONED.has(tone) ? ICON : 0);

const lineCount = (s: string, w: number, px: number, measure: Measure) => wrap(s, Math.max(1, w), 99, px, measure).length;

/**
 * How many 18px lines a step's text takes at `w`: words break at spaces and after a hyphen, ids
 * (mono) only after their dashes, and a piece wider than the line anywhere (overflow-wrap).
 */
export function stepLines(text: string, w: number, measure: Measure): number {
  const max = Math.max(1, w);
  // Pieces that may start a line; `glue` is the space before one (0 inside a word).
  const pieces: { s: string; mono: boolean; glue: boolean; joined: boolean }[] = [];
  let space = false;
  for (const run of stepRuns(text)) {
    if (run.mono) {
      monoPieces(run.text).forEach((s, i) => pieces.push({ s, mono: true, glue: i === 0 && space, joined: i === 0 && !space && pieces.length > 0 }));
      space = false;
      continue;
    }
    for (const part of run.text.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        space = true;
        continue;
      }
      part.split(/(?<=-)(?=\D)/).forEach((s, i) => pieces.push({ s, mono: false, glue: i === 0 && space, joined: i === 0 && !space && pieces.length > 0 }));
      space = false;
    }
  }
  // A piece glued to the one before with no break between them (`01a126f0` `:`) travels with it.
  const units: { s: { s: string; mono: boolean }[]; glue: boolean }[] = [];
  for (const p of pieces) {
    const last = units[units.length - 1];
    if (p.joined && last) last.s.push(p);
    else units.push({ s: [p], glue: p.glue });
  }
  const width = (u: { s: string; mono: boolean }[]) => u.reduce((a, p) => a + measure(p.s, SMALL_PX, p.mono), 0);
  const spaceW = measure(" ", SMALL_PX);
  let lines = 1;
  let x = 0;
  const place = (u: { s: string; mono: boolean }[]) => {
    const uw = width(u);
    if (uw <= max) {
      x = uw;
      return;
    }
    // Wider than the line: broken anywhere, character by character.
    x = 0;
    for (const p of u)
      for (const ch of p.s) {
        const cw = measure(ch, SMALL_PX, p.mono);
        if (x > 0 && x + cw > max) {
          lines++;
          x = 0;
        }
        x += cw;
      }
  };
  for (const u of units) {
    const uw = width(u.s);
    const glue = u.glue ? spaceW : 0;
    if (x === 0) place(u.s);
    else if (x + glue + uw <= max) x += glue + uw;
    else {
      lines++;
      x = 0;
      place(u.s);
    }
  }
  return lines;
}

const chipHeight = (step: Step, w: number, measure: Measure) => CHIP_Y + LINE * stepLines(step.text, w - CHIP_X - iconW(step.tone), measure);
const outcomeLines = (o: StepsOutcome, w: number, measure: Measure) => lineCount(o.text, w - iconW(o.tone), SMALL_PX, measure);
const labelHeight = (label: string, w: number, measure: Measure) => LABEL_LINE * lineCount(label, w, BODY_PX, measure);

export function estimateHeight(spec: StepsSpec, width: number, measure: WeightedMeasure = htmlMeasure): number {
  const em = emphasisMap(spec);
  const badge = (i: number) => (em.get(String(i))?.n !== undefined ? BADGE : 0);
  if (stepsLayout(spec, width) === "side") return Math.ceil(sideHeight(spec, width, measure, badge));
  const rail = stepsLayout(spec, width) === "rail";
  const longest = Math.max(1, ...spec.items.map((it) => (it.type === "row" ? it.steps.length : 0)));
  const outcomes = spec.items.some((it) => it.type === "row" && it.outcome);
  const cols = gridCols(width, longest, outcomes);
  const colW = (gridStepsWidth(width, outcomes) - GRID.arrow * (cols - 1)) / cols;
  let above: StepsRow | null = null;
  const heights = spec.items.map((it, i) => {
    if (it.type === "lane") {
      above = null;
      return (i === 0 ? 0 : 8) + LINE * lineCount(it.label, width, SMALL_PX, measure(600));
    }
    const h = rail ? railHeight(it, above, width, measure, badge(i)) : gridHeight(it, cols, colW, measure, badge(i));
    above = it;
    return h;
  });
  return Math.ceil(heights.reduce((a, b) => a + b, 0) + GAP * Math.max(0, heights.length - 1));
}

function sideHeight(spec: StepsSpec, width: number, measure: WeightedMeasure, badge: (i: number) => number): number {
  const keyed = spec.items.flatMap((it, i) => (it.type === "row" ? [{ row: it, i }] : []));
  const n = keyed.length;
  const colW = (width - SIDE.gap * (n - 1)) / n;
  const inner = (span: number) => span * colW + (span - 1) * SIDE.gap - 2 * SIDE.padX;
  const head = Math.max(...keyed.map(({ row, i }) => SIDE.head + labelHeight(row.label, inner(1) - MARK - badge(i), measure(600))));
  const lines = sideLines(keyed.map((k) => k.row)).reduce(
    (sum, line) => sum + SIDE.conn + Math.max(...line.map((c) => (c.step.gap ? SIDE.gap24 : chipHeight(c.step, inner(c.span), measure(400))))),
    0,
  );
  const outs = keyed.filter((k) => k.row.outcome);
  const out = outs.length ? SIDE.out + Math.max(...outs.map((k) => LINE * outcomeLines(k.row.outcome!, inner(1), measure(530)))) : 0;
  return head + lines + out + SIDE.foot;
}

function gridHeight(row: StepsRow, cols: number, colW: number, measure: WeightedMeasure, badge: number): number {
  const labelH = labelHeight(row.label, GRID.label - MARK - badge, measure(600));
  let chain = 0;
  for (let from = 0; from < row.steps.length; from += cols) {
    let h = 0;
    for (let k = from; k < Math.min(row.steps.length, from + cols); k++) {
      const s = stepAt(row, k)!;
      h = Math.max(h, s.gap ? 24 : chipHeight(s, colW, measure(400)));
    }
    chain += (from ? GAP : 0) + h;
  }
  const out = row.outcome ? 3 + LINE * outcomeLines(row.outcome, GRID.out, measure(530)) : 0;
  return BAND_Y + Math.max(labelH, chain, out);
}

function railHeight(row: StepsRow, above: StepsRow | null, width: number, measure: WeightedMeasure, badge: number): number {
  const inner = width - GRID.band;
  const text = inner - RAIL.num;
  const lines = railLines(row, above).map((l) => {
    if (l.type === "gaps") return 24;
    if (l.type === "same") return RAIL.pad + LINE * lineCount(`${l.from === l.to ? "Step 1" : `Steps ${range(l.from, l.to)}`} as in ${l.label}`, text, SMALL_PX, measure(400));
    return chipHeight(l.step, text, measure(400));
  });
  if (row.outcome) lines.push(RAIL.pad + LINE * outcomeLines(row.outcome, text, measure(530)));
  const rail = RAIL.top + lines.reduce((a, b) => a + b, 0) + GAP * (lines.length - 1);
  return BAND_Y + labelHeight(row.label, inner - MARK - badge, measure(600)) + rail;
}
