/**
 * `vis steps`: which layout a fence takes at a content width, and the pieces every layout shares,
 * computed once here so the View (View.tsx) and the height estimate (height.ts) can't disagree.
 * Pure: no DOM, no Solid (the server imports the parse side).
 *
 * - side: 2–4 rows, no lanes, and at least SIDE_MIN_COL px of content width per row. One column
 *   per row, step N of every row on one line; neighbouring equal steps share one chip.
 * - grid: otherwise wider than STEPS_NARROW. Label column, then equal step columns.
 * - rail: STEPS_NARROW or narrower. Numbered list per row, folds for a shared start and `_` runs.
 */

import type { Tone } from "../../core/grammar";
import { looksLikePath } from "../../core/text";
import type { StepsRow, StepsSpec } from "./parse";

export type StepsLayout = "side" | "grid" | "rail";

/** The phone layout: the figure at most 420px wide, so a content width up to 402px (as layers). */
export const STEPS_NARROW = 402;
/** Side by side: at most this many rows, each given at least this much content width. */
export const SIDE_MAX_ROWS = 4;
export const SIDE_MIN_COL = 180;
/** The gap between side-by-side columns; height.ts and steps.css use the same 8px. */
export const SIDE_GAP = 8;

export function stepsLayout(spec: StepsSpec, width: number): StepsLayout {
  const rows = spec.items.filter((i) => i.type === "row").length;
  const lanes = spec.items.some((i) => i.type === "lane");
  if (!lanes && rows >= 2 && rows <= SIDE_MAX_ROWS && width >= rows * SIDE_MIN_COL + (rows - 1) * SIDE_GAP) return "side";
  return width > STEPS_NARROW ? "grid" : "rail";
}

/** The grid's metrics: the row band's 1px border and 8px padding, the label column and its gap, the outcome column, step columns at least STEP_MIN wide with an ARROW gap between. */
export const GRID = { band: 18, label: 144, gap: 8, out: 120, stepMin: 128, arrow: 20 } as const;

/** How many step columns the grid has at a content width: as many as the longest row, while each gets STEP_MIN. */
export function gridCols(width: number, longest: number, outcomes: boolean): number {
  const steps = gridStepsWidth(width, outcomes);
  return Math.max(1, Math.min(longest, Math.floor((steps + GRID.arrow) / (GRID.stepMin + GRID.arrow))));
}

/** The width the grid's step columns share. */
export const gridStepsWidth = (width: number, outcomes: boolean): number => width - GRID.band - GRID.label - GRID.gap - (outcomes ? GRID.out + GRID.gap : 0);

/** One step as drawn: its text and tone, or an empty position. */
export interface Step {
  text: string;
  tone: Tone | null;
  gap: boolean;
}

export const stepAt = (row: StepsRow, k: number): Step | undefined =>
  k < row.steps.length ? { text: row.steps[k]!, tone: row.stepTones?.[k] ?? null, gap: !!row.gaps?.includes(k) } : undefined;

/** Two real steps that draw the same: same text, same tone. */
export const sameStep = (a: Step | undefined, b: Step | undefined): boolean => !!a && !!b && !a.gap && !b.gap && a.text === b.text && a.tone === b.tone;

/** A cell of the side layout: the step at one position, spanning `span` neighbouring columns from `col`. */
export interface SideCell {
  step: Step;
  col: number;
  span: number;
}

/** The side layout's lines: for each position, its cells, neighbours with the same step merged. */
export function sideLines(rows: StepsRow[]): SideCell[][] {
  const longest = Math.max(0, ...rows.map((r) => r.steps.length));
  const lines: SideCell[][] = [];
  for (let k = 0; k < longest; k++) {
    const out: SideCell[] = [];
    rows.forEach((r, c) => {
      const s = stepAt(r, k);
      if (!s) return;
      const last = out[out.length - 1];
      if (last && last.col + last.span === c && sameStep(last.step, s)) last.span++;
      else out.push({ step: s, col: c, span: 1 });
    });
    lines.push(out);
  }
  return lines;
}

/**
 * Where arrows run into a cell from the line above: one per cell above that overlaps it, at the
 * middle of the overlap, as a share of the cell's width (0–1), with no two at the same place.
 */
export function connectors(above: SideCell[] | undefined, cell: SideCell): number[] {
  const at = new Set<string>();
  const out: number[] = [];
  for (const p of above ?? []) {
    const a = Math.max(p.col, cell.col);
    const b = Math.min(p.col + p.span, cell.col + cell.span);
    if (b <= a) continue;
    const x = ((a + b) / 2 - cell.col) / cell.span;
    if (at.has(x.toFixed(3))) continue;
    at.add(x.toFixed(3));
    out.push(x);
  }
  return out;
}

/** A line of the numbered list (rail): a step, a fold of the start shared with the row above, or a run of `_`. */
export type RailLine =
  | { type: "step"; n: number; step: Step }
  | { type: "same"; from: number; to: number; label: string }
  | { type: "gaps"; from: number; to: number };

/** The rail's lines for `row`; `above` is the row above it in its lane, if any. Numbers are 1-based. */
export function railLines(row: StepsRow, above: StepsRow | null): RailLine[] {
  let same = 0;
  // The start it shares with the row above folds into one line; at least one step stays drawn.
  if (above) while (same < row.steps.length - 1 && sameStep(stepAt(row, same), stepAt(above, same))) same++;
  const out: RailLine[] = same ? [{ type: "same", from: 1, to: same, label: above!.label }] : [];
  for (let k = same; k < row.steps.length; k++) {
    const s = stepAt(row, k)!;
    if (!s.gap) {
      out.push({ type: "step", n: k + 1, step: s });
      continue;
    }
    const last = out[out.length - 1];
    if (last?.type === "gaps" && last.to === k) last.to = k + 1;
    else out.push({ type: "gaps", from: k + 1, to: k + 1 });
  }
  return out;
}

/** A position range as the rail numbers it: "3", or "2–5". */
export const range = (from: number, to: number): string => (from === to ? String(from) : `${from}–${to}`);

/**
 * A step's text as the View draws it and the estimate measures it: runs of body text and of mono
 * (ids, hashes, paths), each mono run split at its dashes, where it may break. A step that is a path
 * as a whole is mono throughout, as before.
 */
export interface Run {
  text: string;
  mono: boolean;
}

/** A hex id or hash of 7+ characters, dash-joined parts allowed (`01a126f0-b8d9-763b`). */
const HEX_ID = /^[0-9a-f]{7,}(?:-[0-9a-f]{2,})*$/i;
/** Slash-joined parts: a path when it starts at a root (`/`, `~/`, `./`) or ends in an extension. */
const PATH = /^(?:~|\.{1,2})?\/?[\w@.+-]+(?:\/[\w@.+-]+)+\/?$/;
/** A file name with a common source or data extension. */
const FILE = /^[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|css|html|py|go|rs|rb|java|sh|yml|yaml|toml|lock|sql|txt|log)$/;
const TRAIL = /[:,;.)]+$/;

/** An id, a hash or a path, written as one word (trailing punctuation aside). */
export function isMachineWord(word: string): boolean {
  if (HEX_ID.test(word)) return /\d/.test(word) && /[a-f]/i.test(word);
  if (PATH.test(word)) return /\.[a-z0-9]{1,5}\/?$/i.test(word) || /^(?:~|\.{1,2})?\//.test(word);
  return FILE.test(word);
}

export function stepRuns(text: string): Run[] {
  if (looksLikePath(text)) return [{ text, mono: true }];
  const out: Run[] = [];
  const add = (t: string, mono: boolean) => {
    const last = out[out.length - 1];
    if (last && last.mono === mono && !mono) last.text += t;
    else out.push({ text: t, mono });
  };
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    const trail = TRAIL.exec(part)?.[0] ?? "";
    const word = trail ? part.slice(0, -trail.length) : part;
    if (word && isMachineWord(word)) {
      add(word, true);
      if (trail) add(trail, false);
    } else add(part, false);
  }
  return out;
}

/** A mono run's pieces: it breaks only after its dashes (`01a126f0-` `b8d9-` `763b`). */
export const monoPieces = (text: string): string[] => text.split(/(?<=-)/);
