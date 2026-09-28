/**
 * `vis sequence` geometry: one column per actor, one row per step. Columns start at their minimum
 * spacing and widen only where a message label, a self-message or a note needs the room, the
 * deficit spread evenly over the gaps it spans. Given the width it has (`fit`), text wraps tighter
 * until the drawing fits, so a phone gets taller rows rather than a sideways scroll. Pure.
 */

import { estimateWidth, widest, wrap, type Measure } from "../../core/text";
import type { SequenceSpec } from "./parse";

export const SEQ_FONT = { actor: 12.5, msg: 12, note: 12 } as const;
export const SEQ_LINE = 15;
const HEAD_H = 32;
const ACTOR_GAP = 20;
/** Room a self-message's loop takes right of its lifeline before its label starts. */
export const SELF_LOOP = 28;
const SELF_LABEL = SELF_LOOP + 8;
/** Wrap widths, widest first: [message, self-message, note over one actor, note over two, actor head]. */
const WRAPS = [
  [220, 220, 170, 260, 130],
  [170, 130, 140, 200, 110],
  [130, 90, 110, 150, 90],
  [110, 72, 90, 120, 72],
  [96, 64, 80, 110, 64],
] as const;

export interface SeqActor {
  id: string;
  x: number;
  w: number;
  lines: string[];
  tone?: string;
}
/** A box around a row, for its emphasis band and badge. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type SeqRow =
  | {
      type: "msg";
      x1: number;
      x2: number;
      y: number;
      dashed: boolean;
      lines: string[];
      labelY: number;
      self: boolean;
      /** A self-message on the last actor loops (and puts its label) to the left, inside the drawing. */
      left: boolean;
      box: Box;
    }
  | { type: "note"; x: number; y: number; w: number; h: number; lines: string[]; box: Box }
  | { type: "divider"; y: number; label: string; labelW: number; box: Box };
export interface SequenceLayout {
  width: number;
  height: number;
  headH: number;
  /** Top of the actor heads. */
  headY: number;
  actors: SeqActor[];
  /** One per spec step, in order. */
  rows: SeqRow[];
  lifelineEnd: number;
  /**
   * The step-through step of each row: step k is message k (0-based), so "Step 3" is the third
   * message, the number `mark 3` names. A divider goes with the message after it, a note with the
   * message before it. A sequence without messages steps row by row.
   */
  stepOf: number[];
  steps: number;
}

/** Row → step for the step-through control (see SequenceLayout.stepOf). */
export function stepsOf(spec: SequenceSpec): { stepOf: number[]; steps: number } {
  const msgs = spec.steps.filter((s) => s.type === "msg").length;
  if (msgs === 0) return { stepOf: spec.steps.map((_, i) => i), steps: spec.steps.length };
  const stepOf: number[] = [];
  let seen = 0;
  spec.steps.forEach((s, i) => {
    if (s.type === "msg") stepOf.push(seen++);
    else if (s.type === "note") stepOf.push(Math.max(0, seen - 1));
    else {
      // A divider opens the next message's step; a trailing one closes the last.
      const next = spec.steps.slice(i + 1).some((t) => t.type === "msg");
      stepOf.push(next ? seen : seen - 1);
    }
  });
  return { stepOf, steps: msgs };
}

export function layoutSequence(spec: SequenceSpec, measure: Measure = estimateWidth, fit = 0): SequenceLayout {
  let out = layoutAt(spec, measure, 0);
  for (let level = 1; fit > 0 && out.width > fit && level < WRAPS.length; level++) out = layoutAt(spec, measure, level);
  return out;
}

function layoutAt(spec: SequenceSpec, measure: Measure, level: number): SequenceLayout {
  const [msgMax, selfMax, noteMax, note2Max, actorMax] = WRAPS[level]!;
  // Tighter levels also trim the side margins and a label's clearance (the badge still fits).
  const MARGIN = level > 1 ? 7 : 12;
  const clear = level > 2 ? 14 : level > 1 ? 20 : 28;
  const col = new Map(spec.actors.map((a, i) => [a.id, i]));
  const heads = spec.actors.map((a) => {
    const lines = wrap(a.label, actorMax, 2, SEQ_FONT.actor, measure);
    return { lines, w: Math.max(level > 1 ? 56 : 72, widest(lines, SEQ_FONT.actor, measure) + (level > 1 ? 16 : 24)) };
  });
  const headH = Math.max(...heads.map((h) => h.lines.length)) === 2 ? HEAD_H + SEQ_LINE : HEAD_H;
  const n = spec.actors.length;
  // gaps[i]: center distance between actor i and i+1.
  const gaps = heads.slice(0, -1).map((h, i) => h.w / 2 + heads[i + 1]!.w / 2 + (level > 1 ? 12 : ACTOR_GAP));
  const need: { a: number; b: number; d: number }[] = [];
  const wrapped = spec.steps.map((s) => {
    if (s.type === "msg") return s.label ? wrap(s.label, s.from === s.to ? selfMax : msgMax, level > 0 ? 4 : 3, SEQ_FONT.msg, measure) : [];
    if (s.type === "note") return wrap(s.text, s.over.length === 2 ? note2Max : noteMax, level > 0 ? 5 : 4, SEQ_FONT.note, measure);
    return [];
  });
  spec.steps.forEach((s, i) => {
    const lines = wrapped[i]!;
    const w = widest(lines, s.type === "note" ? SEQ_FONT.note : SEQ_FONT.msg, measure);
    if (s.type === "msg") {
      const a = col.get(s.from)!;
      const b = col.get(s.to)!;
      if (a === b) {
        // A self-message's label sits beside its loop: room up to the next column (the last
        // actor's loops to the left, so a phone-width drawing doesn't grow a margin for it).
        if (a === n - 1) need.push({ a: a - 1, b: a, d: SELF_LABEL + w + 8 });
        else need.push({ a, b: a + 1, d: SELF_LABEL + w + 8 });
      } else need.push({ a: Math.min(a, b), b: Math.max(a, b), d: w + clear });
    } else if (s.type === "note") {
      const a = col.get(s.over[0]!)!;
      const b = col.get(s.over[s.over.length - 1]!)!;
      if (a !== b) need.push({ a: Math.min(a, b), b: Math.max(a, b), d: w + 20 - 40 });
    }
  });
  for (let pass = 0; pass < 3; pass++)
    for (const { a, b, d } of need) {
      let have = 0;
      for (let i = a; i < b; i++) have += gaps[i]!;
      if (have >= d) continue;
      const add = (d - have) / (b - a);
      for (let i = a; i < b; i++) gaps[i]! += add;
    }
  const xs = [MARGIN + heads[0]!.w / 2];
  for (let i = 0; i < gaps.length; i++) xs.push(xs[i]! + gaps[i]!);

  const headY = MARGIN;
  const rows: SeqRow[] = [];
  let y = headY + headH + 16;
  let minX = MARGIN;
  let maxX = xs[n - 1]! + heads[n - 1]!.w / 2;
  spec.steps.forEach((s, i) => {
    const lines = wrapped[i]!;
    if (s.type === "msg") {
      const a = col.get(s.from)!;
      const b = col.get(s.to)!;
      const labelH = lines.length * SEQ_LINE;
      if (a === b) {
        const loopH = Math.max(18, labelH - 4);
        const w = widest(lines, SEQ_FONT.msg, measure);
        const left = a === n - 1;
        const bw = SELF_LABEL + w + 16;
        const box = { x: left ? xs[a]! + 8 - bw : xs[a]! - 8, y: y - 4, w: bw, h: loopH + 16 };
        rows.push({ type: "msg", x1: xs[a]!, x2: xs[a]!, y: y + 4, dashed: s.dashed, lines, labelY: y + 2, self: true, left, box });
        y += loopH + 24;
      } else {
        const labelY = y;
        const lo = Math.min(xs[a]!, xs[b]!);
        const hi = Math.max(xs[a]!, xs[b]!);
        y += labelH + (labelH ? 4 : 0);
        const box = { x: lo - 8, y: labelY - 5, w: hi - lo + 16, h: y - labelY + 11 };
        rows.push({ type: "msg", x1: xs[a]!, x2: xs[b]!, y, dashed: s.dashed, lines, labelY, self: false, left: false, box });
        y += 18;
      }
    } else if (s.type === "note") {
      const a = col.get(s.over[0]!)!;
      const b = col.get(s.over[s.over.length - 1]!)!;
      const tw = widest(lines, SEQ_FONT.note, measure) + 20;
      const lo = Math.min(xs[a]!, xs[b]!);
      const hi = Math.max(xs[a]!, xs[b]!);
      const w = Math.max(tw, hi - lo + 40);
      const h = lines.length * SEQ_LINE + 10;
      const x = (lo + hi) / 2;
      minX = Math.min(minX, x - w / 2 - MARGIN);
      maxX = Math.max(maxX, x + w / 2);
      rows.push({ type: "note", x, y, w, h, lines, box: { x: x - w / 2, y, w, h } });
      y += h + 14;
    } else {
      const labelW = measure(s.label, SEQ_FONT.msg) + 20;
      rows.push({ type: "divider", y: y + 6, label: s.label, labelW, box: { x: 0, y: y - 4, w: 0, h: 20 } });
      y += 32;
    }
  });
  // A note wider than the left margin shifts everything right.
  const shift = minX < MARGIN ? MARGIN - minX : 0;
  const width = Math.ceil(maxX + shift + MARGIN);
  const sx = (v: number) => v + shift;
  const sbox = (b: Box): Box => ({ ...b, x: b.x + shift });
  const actors = spec.actors.map((a, i) => ({ id: a.id, x: sx(xs[i]!), w: heads[i]!.w, lines: heads[i]!.lines, ...(a.tone ? { tone: a.tone } : {}) }));
  const shifted = rows.map((r): SeqRow => {
    if (r.type === "msg") return { ...r, x1: sx(r.x1), x2: sx(r.x2), box: sbox(r.box) };
    if (r.type === "note") return { ...r, x: sx(r.x), box: sbox(r.box) };
    // A divider runs the full width; its pill sits in the middle.
    return { ...r, box: { x: width / 2 - r.labelW / 2, y: r.y - 10, w: r.labelW, h: 20 } };
  });
  return { width, height: Math.ceil(y + MARGIN - 6), headH, headY, actors, rows: shifted, lifelineEnd: y - 6, ...stepsOf(spec) };
}
