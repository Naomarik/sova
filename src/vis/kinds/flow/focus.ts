/**
 * Tap-to-follow for `vis flow` / `vis state` (FlowView): one picked shape per figure, its direct
 * neighbours lit, the rest faded, a reading panel of where it comes from and leads to, and the
 * keyboard's cursor that the arrow keys move from shape to shape. Signals only, no DOM: FlowView
 * wires the events and draws the classes; ./focus.browser.test.ts drives this as the View does.
 */

import { createMemo, createSignal, type Accessor } from "solid-js";
import type { Shape } from "./parse";

/** A shape the cursor can stand on: its node key, the panel it is drawn in, and its center there. */
export interface FocusShape {
  id: string;
  panel: number;
  x: number;
  y: number;
  shape: Shape;
  /** Its label, as the panel and its neighbours' buttons show it. */
  label: string;
  /** Its panel's ranks advance downwards (else to the right, a `dir: right` drawing that kept its direction). */
  down: boolean;
}
/** An arrow between two shapes (self-loops included: they add no neighbour). */
export interface FocusEdge {
  from: string;
  to: string;
  label?: string;
}
export interface FocusGraph {
  shapes: FocusShape[];
  edges: FocusEdge[];
}

/** A button in the reading panel: the shape it moves the pick to, and its words. */
export interface Chip {
  id: string;
  text: string;
}
export interface Reading {
  id: string;
  kind: string;
  from: Chip[];
  to: Chip[];
}

/** What a shape is called in the panel and its accessible name: Question, Start, Step, Outcome; State and End in a state machine. */
export function kindWord(shape: Shape, ins: number, outs: number, machine: boolean): string {
  if (shape === "decision") return "Question";
  if (machine) return shape === "start" ? "Start" : shape === "end" ? "End" : "State";
  if (shape === "start" || ins === 0) return "Start";
  if (shape === "end" || outs === 0) return "Outcome";
  return "Step";
}

/** The arrows into and out of `id`, self-loops aside, one chip per neighbour and label. */
export function neighbours(g: FocusGraph, id: string): { from: Chip[]; to: Chip[] } {
  const name = new Map(g.shapes.map((s) => [s.id, s.label]));
  const chips = (pairs: { id: string; label?: string }[], arrowFirst: boolean) => {
    const seen = new Set<string>();
    const out: Chip[] = [];
    for (const p of pairs) {
      const key = `${p.id}\u0000${p.label ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const target = (name.get(p.id) ?? p.id).replace(/\s*\n\s*/g, " ");
      // An arrow's label leads into the shape it points at: "yes → Project's login".
      out.push({ id: p.id, text: arrowFirst && p.label ? `${p.label} → ${target}` : target });
    }
    return out;
  };
  const real = g.edges.filter((e) => e.from !== e.to);
  return {
    from: chips(real.filter((e) => e.to === id).map((e) => ({ id: e.from })), false),
    to: chips(real.filter((e) => e.from === id).map((e) => ({ id: e.to, ...(e.label ? { label: e.label } : {}) })), true),
  };
}

/** Reading order: panel by panel, top to bottom, left to right. */
const reading = (a: FocusShape, b: FocusShape) => a.panel - b.panel || a.y - b.y || a.x - b.x;

export type Direction = "left" | "right" | "up" | "down";
const DIRS: Record<Direction, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

/**
 * The shape the cursor moves to from `from` by an arrow key, within its panel. Along the ranks
 * (down or up in a downward drawing, right or left in a `dir: right` one) it goes to the nearest
 * rank that way, to the shape there closest across. Across them it goes to the nearest shape on
 * the same rank, else the nearest that way (the distance across counting double). Past the panel's
 * edge: the next panel's first shape (right, down) or the previous panel's last (left, up); else
 * it stays.
 */
export function step(shapes: FocusShape[], from: FocusShape, dir: Direction): FocusShape {
  const [dx, dy] = DIRS[dir];
  const alongRanks = from.down ? dy !== 0 : dx !== 0;
  const cands = shapes
    .filter((s) => s !== from && s.panel === from.panel)
    .map((s) => ({ s, along: (s.x - from.x) * dx + (s.y - from.y) * dy, across: Math.abs((s.x - from.x) * dy) + Math.abs((s.y - from.y) * dx) }))
    .filter((c) => c.along >= 1);
  const pickMin = (cs: typeof cands, score: (c: (typeof cands)[number]) => number) => cs.reduce<(typeof cands)[number] | undefined>((b, c) => (b === undefined || score(c) < score(b) ? c : b), undefined)?.s;
  let best: FocusShape | undefined;
  if (alongRanks) {
    const nearest = Math.min(...cands.map((c) => c.along));
    best = pickMin(
      cands.filter((c) => c.along <= nearest + 1),
      (c) => c.across,
    );
  } else {
    best = pickMin(
      cands.filter((c) => c.across < 1),
      (c) => c.along,
    ) ?? pickMin(cands, (c) => c.along + 2 * c.across);
  }
  if (best) return best;
  const order = [...shapes].sort(reading);
  const forward = dir === "right" || dir === "down";
  const next = forward ? order.find((s) => s.panel > from.panel) : [...order].reverse().find((s) => s.panel < from.panel);
  return next ?? from;
}

/** The part of a keyboard event the drawing reads and may stop. */
export interface KeyLike {
  key: string;
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * One figure's pick and cursor. `reveal(id)` scrolls a shape into view (the View's job); `opened`
 * is told when a pick appears where there was none, so the View can bring its panel into view.
 */
export function createFlowFocus(graph: Accessor<FocusGraph>, opts: { machine?: Accessor<boolean>; reveal?: (id: string) => void; opened?: () => void } = {}) {
  const [picked, setPicked] = createSignal<string | null>(null);
  const [active, setActive] = createSignal<string | null>(null);
  const byId = createMemo(() => new Map(graph().shapes.map((s) => [s.id, s])));
  // A pick or cursor on a shape a re-parse removed is no pick (a new fence is a new drawing, but be safe).
  const pick = () => {
    const p = picked();
    return p !== null && byId().has(p) ? p : null;
  };
  const cursor = () => {
    const a = active();
    return a !== null && byId().has(a) ? a : null;
  };
  const near = createMemo(() => {
    const p = pick();
    if (p === null) return null;
    const ids = new Set<string>();
    for (const e of graph().edges) {
      if (e.from === e.to) continue;
      if (e.from === p) ids.add(e.to);
      if (e.to === p) ids.add(e.from);
    }
    return ids;
  });
  const set = (id: string | null) => {
    const had = pick() !== null;
    setPicked(id);
    if (id !== null) setActive(id);
    if (id !== null && !had) opts.opened?.();
  };
  const first = () => [...graph().shapes].sort(reading)[0]?.id ?? null;
  const toggle = (id: string) => {
    set(pick() === id ? null : id);
    setActive(id);
  };

  return {
    picked: pick,
    active: cursor,
    /** A tap, Enter or Space on a shape: pick it, or clear it when it is the picked one. */
    toggle,
    /** A panel button: the pick (and cursor) move to that shape, scrolled into view. */
    moveTo(id: string) {
      set(id);
      opts.reveal?.(id);
    },
    clear() {
      setPicked(null);
    },
    /** `vis-flow-sel` / `-near` / `-dim` for a shape, or nothing while no shape is picked. */
    nodeState(id: string): "sel" | "near" | "dim" | undefined {
      const p = pick();
      if (p === null) return undefined;
      if (id === p) return "sel";
      return near()!.has(id) ? "near" : "dim";
    },
    /** An arrow touching the picked shape is lit; every other fades. */
    edgeState(e: FocusEdge): "near" | "dim" | undefined {
      const p = pick();
      if (p === null) return undefined;
      return e.from === p || e.to === p ? "near" : "dim";
    },
    /** The panel's content for the picked shape. */
    reading: createMemo((): Reading | null => {
      const p = pick();
      if (p === null) return null;
      const s = byId().get(p)!;
      const g = graph();
      const real = g.edges.filter((e) => e.from !== e.to);
      const { from, to } = neighbours(g, p);
      return { id: p, kind: kindWord(s.shape, real.filter((e) => e.to === p).length, real.filter((e) => e.from === p).length, opts.machine?.() ?? false), from, to };
    }),
    /** The drawing took focus: the cursor stands on the picked shape, else where it was, else the first. */
    focused() {
      if (cursor() === null) setActive(pick() ?? first());
    },
    /** A key on the drawing's one Tab stop. Returns whether it handled the key. */
    key(e: KeyLike): boolean {
      const dir: Direction | undefined = ({ ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" } as Record<string, Direction>)[e.key];
      const shapes = graph().shapes;
      if (dir || e.key === "Home" || e.key === "End") {
        e.preventDefault();
        const at = cursor();
        const order = [...shapes].sort(reading);
        let to: string | null;
        if (e.key === "Home") to = order[0]?.id ?? null;
        else if (e.key === "End") to = order[order.length - 1]?.id ?? null;
        else to = at === null ? first() : step(shapes, byId().get(at)!, dir!).id;
        if (to !== null) {
          setActive(to);
          opts.reveal?.(to);
        }
        return true;
      }
      if (e.key === "Enter" || e.key === " ") {
        const at = cursor() ?? first();
        if (at === null) return false;
        e.preventDefault();
        toggle(at);
        return true;
      }
      if (e.key === "Escape") {
        // Only a pick stops Escape here; with none it goes on to whatever else listens (the side pane).
        if (pick() === null) return false;
        e.preventDefault();
        e.stopPropagation();
        setPicked(null);
        return true;
      }
      return false;
    },
  };
}
export type FlowFocus = ReturnType<typeof createFlowFocus>;
