/**
 * `vis sequence` geometry: one column per actor, one row per step. Columns start at their minimum
 * spacing and widen only where a message label, a self-message or a note needs the room, the
 * deficit spread evenly over the gaps it spans. Pure.
 */

import { estimateWidth, widest, wrap, type Measure } from "../../core/text";
import type { SequenceSpec } from "./parse";

export const SEQ_FONT = { actor: 12.5, msg: 12, note: 12 } as const;
const LINE = 15;
const MARGIN = 12;
const HEAD_H = 32;
const ACTOR_GAP = 20;

export interface SeqActor {
  id: string;
  x: number;
  w: number;
  lines: string[];
  tone?: string;
}
export type SeqRow =
  | { type: "msg"; x1: number; x2: number; y: number; dashed: boolean; lines: string[]; labelY: number; self: boolean }
  | { type: "note"; x: number; y: number; w: number; h: number; lines: string[] }
  | { type: "divider"; y: number; label: string; labelW: number };
export interface SequenceLayout {
  width: number;
  height: number;
  headH: number;
  actors: SeqActor[];
  rows: SeqRow[];
  lifelineEnd: number;
}

export function layoutSequence(spec: SequenceSpec, measure: Measure = estimateWidth): SequenceLayout {
  const col = new Map(spec.actors.map((a, i) => [a.id, i]));
  const heads = spec.actors.map((a) => {
    const lines = wrap(a.label, 130, 2, SEQ_FONT.actor, measure);
    return { lines, w: Math.max(72, widest(lines, SEQ_FONT.actor, measure) + 24) };
  });
  const headH = Math.max(...heads.map((h) => h.lines.length)) === 2 ? HEAD_H + LINE : HEAD_H;
  const n = spec.actors.length;
  // gaps[i]: center distance between actor i and i+1.
  const gaps = heads.slice(0, -1).map((h, i) => h.w / 2 + heads[i + 1]!.w / 2 + ACTOR_GAP);
  let rightRoom = 0;
  const need: { a: number; b: number; d: number }[] = [];
  const wrapped = spec.steps.map((s) => {
    if (s.type === "msg") return wrap(s.label ?? "", 220, 3, SEQ_FONT.msg, measure);
    if (s.type === "note") return wrap(s.text, s.over.length === 2 ? 260 : 170, 4, SEQ_FONT.note, measure);
    return [];
  });
  spec.steps.forEach((s, i) => {
    const lines = wrapped[i]!;
    const w = widest(lines, s.type === "note" ? SEQ_FONT.note : SEQ_FONT.msg, measure);
    if (s.type === "msg") {
      const a = col.get(s.from)!;
      const b = col.get(s.to)!;
      if (a === b) {
        // A self-message's label sits right of its loop: room up to the next column.
        if (a === n - 1) rightRoom = Math.max(rightRoom, w + 44);
        else need.push({ a, b: a + 1, d: w + 44 });
      } else need.push({ a: Math.min(a, b), b: Math.max(a, b), d: w + 28 });
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

  const rows: SeqRow[] = [];
  let y = MARGIN + headH + 14;
  let minX = MARGIN;
  let maxX = xs[n - 1]! + heads[n - 1]!.w / 2 + rightRoom;
  spec.steps.forEach((s, i) => {
    const lines = wrapped[i]!;
    if (s.type === "msg") {
      const a = col.get(s.from)!;
      const b = col.get(s.to)!;
      const labelH = lines.filter(Boolean).length * LINE;
      if (a === b) {
        rows.push({ type: "msg", x1: xs[a]!, x2: xs[a]!, y: y + 4, dashed: s.dashed, lines, labelY: y + 2, self: true });
        y += Math.max(30, labelH + 8) + 12;
      } else {
        const labelY = y;
        y += labelH + 4;
        rows.push({ type: "msg", x1: xs[a]!, x2: xs[b]!, y, dashed: s.dashed, lines, labelY, self: false });
        y += 16;
      }
    } else if (s.type === "note") {
      const a = col.get(s.over[0]!)!;
      const b = col.get(s.over[s.over.length - 1]!)!;
      const tw = widest(lines, SEQ_FONT.note, measure) + 20;
      const lo = Math.min(xs[a]!, xs[b]!);
      const hi = Math.max(xs[a]!, xs[b]!);
      const w = Math.max(tw, hi - lo + 40);
      const h = lines.length * LINE + 10;
      const x = (lo + hi) / 2;
      minX = Math.min(minX, x - w / 2 - MARGIN);
      maxX = Math.max(maxX, x + w / 2);
      rows.push({ type: "note", x, y, w, h, lines });
      y += h + 12;
    } else {
      rows.push({ type: "divider", y: y + 6, label: s.label, labelW: measure(s.label, SEQ_FONT.msg) + 16 });
      y += 30;
    }
  });
  // A note wider than the left margin shifts everything right.
  const shift = minX < MARGIN ? MARGIN - minX : 0;
  const sx = (v: number) => v + shift;
  const actors = spec.actors.map((a, i) => ({ id: a.id, x: sx(xs[i]!), w: heads[i]!.w, lines: heads[i]!.lines, ...(a.tone ? { tone: a.tone } : {}) }));
  const shifted = rows.map((r) => (r.type === "msg" ? { ...r, x1: sx(r.x1), x2: sx(r.x2) } : r.type === "note" ? { ...r, x: sx(r.x) } : r));
  return { width: Math.ceil(maxX + shift + MARGIN), height: Math.ceil(y + MARGIN), headH, actors, rows: shifted, lifelineEnd: y };
}
