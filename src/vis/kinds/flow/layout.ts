/**
 * Layered ("Sugiyama-lite") layout for `vis flow` / `vis state`, without a library:
 *   1. break cycles by reversing DFS back edges (drawn with their arrow at the true target);
 *   2. rank by longest path on a doubled grid — real nodes on even ranks, and every edge crosses at
 *      least one odd rank, where its label (if any) sits as a node of its own, so a label never
 *      overlaps another label or a box;
 *   3. a virtual node on every rank an edge crosses;
 *   4. order each rank by barycenter sweeps plus adjacent swaps, keeping the fewest crossings;
 *   5. place along each rank by isotonic regression toward the neighbours' mean (order and minimum
 *      gaps kept exactly), alternating down and up;
 *   6. route each edge as S-curves through its virtual points.
 * Worked in a "down" frame (across = x, along = y); `dir: right` swaps the axes at the end.
 * Pure and deterministic: the same spec always draws the same picture.
 */

import type { Tone } from "../../core/grammar";
import { estimateWidth, wrap, widest, type Measure } from "../../core/text";
import type { FlowSpec, Shape } from "./parse";

export const FLOW_FONT = { label: 13, note: 11.5, edge: 11.5 } as const;
const LINE = { label: 17, note: 15, edge: 15 };
const PAD = { x: 14, y: 9 };
const MAX_TEXT = 168;
const MAX_EDGE_TEXT = 140;
const RANK_GAP = 18;
const NODE_GAP = 28;
const VIRTUAL_GAP = 12;
const MARGIN = 12;

export interface PlacedFlowNode {
  id: string;
  /** Center. */
  x: number;
  y: number;
  w: number;
  h: number;
  shape: Shape;
  tone?: Tone;
  lines: string[];
  noteLines: string[];
  /** Full text, for a <title> when lines were cut. */
  full: string;
}
export interface PlacedFlowEdge {
  path: string;
  dashed: boolean;
  both: boolean;
  /** Label box, center and size. */
  label?: { x: number; y: number; w: number; h: number; lines: string[] };
}
export interface FlowLayout {
  width: number;
  height: number;
  nodes: PlacedFlowNode[];
  edges: PlacedFlowEdge[];
}

interface LNode {
  key: number;
  /** Index into spec.nodes, or -1 for a virtual node. */
  real: number;
  rank: number;
  across: number;
  along: number;
  /** Extra room on the + side of across (self-loops). */
  extra: number;
  pos: number;
  order: number;
  up: number[];
  down: number[];
}

interface Chain {
  edge: number;
  /** Layout keys from the upper end to the lower end. */
  keys: number[];
  reversed: boolean;
  labelKey: number | null;
}

export function layoutFlow(spec: FlowSpec, measure: Measure = estimateWidth): FlowLayout {
  const right = spec.dir === "right";
  const index = new Map(spec.nodes.map((n, i) => [n.id, i]));

  // ---- boxes -------------------------------------------------------------------------------
  const boxes = spec.nodes.map((n) => {
    const tiny = n.shape === "start" || n.shape === "end";
    const maxText = n.shape === "decision" ? 120 : MAX_TEXT;
    const lines = tiny ? [] : wrap(n.label, maxText, 3, FLOW_FONT.label, measure);
    const noteLines = tiny || !n.note ? [] : wrap(n.note, maxText, 2, FLOW_FONT.note, measure);
    const tw = Math.max(widest(lines, FLOW_FONT.label, measure), widest(noteLines, FLOW_FONT.note, measure));
    const th = lines.length * LINE.label + noteLines.length * LINE.note;
    let w = Math.max(64, tw + 2 * PAD.x);
    let h = th + 2 * PAD.y;
    if (tiny) w = h = n.shape === "start" ? 18 : 22;
    else if (n.shape === "decision") {
      w = Math.max(88, 2 * tw + 16);
      h = Math.max(48, 2 * th + 10);
    } else if (n.shape === "circle") w = h = Math.max(w, h, 56);
    else if (n.shape === "store") h += 10;
    return { w, h, lines, noteLines };
  });

  // ---- edges: self-loops aside, cycles broken ----------------------------------------------
  const loops: number[] = [];
  const edges: { e: number; u: number; v: number }[] = [];
  spec.edges.forEach((e, i) => {
    const u = index.get(e.from)!;
    const v = index.get(e.to)!;
    if (u === v) loops.push(i);
    else edges.push({ e: i, u, v });
  });
  const reversed = new Set<number>();
  {
    const state = new Array<number>(spec.nodes.length).fill(0); // 0 new, 1 on stack, 2 done
    const out = new Map<number, typeof edges>();
    for (const ed of edges) out.set(ed.u, [...(out.get(ed.u) ?? []), ed]);
    const visit = (u: number) => {
      state[u] = 1;
      for (const ed of out.get(u) ?? []) {
        if (state[ed.v] === 1) reversed.add(ed.e);
        else if (state[ed.v] === 0) visit(ed.v);
      }
      state[u] = 2;
    };
    // Roots first (declaration order), so a cycle breaks at the edge that closes it.
    const hasIn = new Set(edges.map((ed) => ed.v));
    for (let u = 0; u < spec.nodes.length; u++) if (!hasIn.has(u) && state[u] === 0) visit(u);
    for (let u = 0; u < spec.nodes.length; u++) if (state[u] === 0) visit(u);
  }
  const dag = edges.map((ed) => (reversed.has(ed.e) ? { e: ed.e, u: ed.v, v: ed.u } : ed));

  // ---- ranks: longest path on the doubled grid, then sources pulled down to their targets ---
  const rank = new Array<number>(spec.nodes.length).fill(0);
  {
    const indeg = new Array<number>(spec.nodes.length).fill(0);
    for (const ed of dag) indeg[ed.v]!++;
    const queue = rank.map((_, i) => i).filter((i) => indeg[i] === 0);
    while (queue.length) {
      const u = queue.shift()!;
      for (const ed of dag) {
        if (ed.u !== u) continue;
        rank[ed.v] = Math.max(rank[ed.v]!, rank[u]! + 2);
        if (--indeg[ed.v]! === 0) queue.push(ed.v);
      }
    }
    for (let u = 0; u < spec.nodes.length; u++) {
      if (dag.some((ed) => ed.v === u)) continue;
      const outs = dag.filter((ed) => ed.u === u).map((ed) => rank[ed.v]!);
      if (outs.length) rank[u] = Math.min(...outs) - 2;
    }
    const min = Math.min(...rank);
    for (let u = 0; u < rank.length; u++) rank[u]! -= min;
  }

  // ---- layout graph with virtual nodes -----------------------------------------------------
  const L: LNode[] = [];
  const add = (real: number, r: number, across: number, along: number): number => {
    L.push({ key: L.length, real, rank: r, across, along, extra: 0, pos: 0, order: 0, up: [], down: [] });
    return L.length - 1;
  };
  spec.nodes.forEach((_, i) => add(i, rank[i]!, right ? boxes[i]!.h : boxes[i]!.w, right ? boxes[i]!.w : boxes[i]!.h));
  const labelBoxes = new Map<number, { w: number; h: number; lines: string[] }>();
  const chains: Chain[] = dag.map((ed) => {
    const label = spec.edges[ed.e]!.label;
    let lb: { w: number; h: number; lines: string[] } | null = null;
    if (label) {
      const lines = wrap(label, MAX_EDGE_TEXT, 2, FLOW_FONT.edge, measure);
      lb = { w: widest(lines, FLOW_FONT.edge, measure) + 10, h: lines.length * LINE.edge + 4, lines };
    }
    const keys = [ed.u];
    const ru = rank[ed.u]!;
    const rv = rank[ed.v]!;
    // The label rides the odd rank nearest the middle of the edge.
    const mid = ru + 1 + 2 * Math.floor((rv - ru - 2) / 4);
    let labelKey: number | null = null;
    for (let r = ru + 1; r < rv; r++) {
      const isLabel = lb !== null && r === mid;
      const k = add(-1, r, isLabel ? (right ? lb!.h : lb!.w) + 8 : 2, isLabel ? (right ? lb!.w : lb!.h) : 0);
      if (isLabel) {
        labelKey = k;
        labelBoxes.set(k, lb!);
      }
      keys.push(k);
    }
    keys.push(ed.v);
    for (let i = 0; i + 1 < keys.length; i++) {
      L[keys[i]!]!.down.push(keys[i + 1]!);
      L[keys[i + 1]!]!.up.push(keys[i]!);
    }
    return { edge: ed.e, keys, reversed: reversed.has(ed.e), labelKey };
  });
  // Self-loops need room on one side of their node.
  const loopLabels = new Map<number, { w: number; h: number; lines: string[] }>();
  for (const e of loops) {
    const u = index.get(spec.edges[e]!.from)!;
    const label = spec.edges[e]!.label;
    let extra = 26;
    if (label) {
      const lines = wrap(label, MAX_EDGE_TEXT, 2, FLOW_FONT.edge, measure);
      const lb = { w: widest(lines, FLOW_FONT.edge, measure) + 10, h: lines.length * LINE.edge + 4, lines };
      loopLabels.set(e, lb);
      extra += (right ? lb.h : lb.w) + 4;
    }
    L[u]!.extra = Math.max(L[u]!.extra, extra);
  }

  // ---- ordering ----------------------------------------------------------------------------
  const maxRank = Math.max(...L.map((n) => n.rank));
  const layers: number[][] = Array.from({ length: maxRank + 1 }, () => []);
  // Initial order: DFS from the roots in declaration order, so the author's order mostly survives.
  {
    const seen = new Set<number>();
    const dfs = (k: number) => {
      if (seen.has(k)) return;
      seen.add(k);
      layers[L[k]!.rank]!.push(k);
      for (const d of L[k]!.down) dfs(d);
    };
    for (let i = 0; i < spec.nodes.length; i++) if (L[i]!.up.length === 0) dfs(i);
    for (let i = 0; i < L.length; i++) dfs(i);
  }
  const setOrder = () => layers.forEach((layer) => layer.forEach((k, i) => (L[k]!.order = i)));
  setOrder();
  const crossings = () => {
    let c = 0;
    for (let r = 0; r < maxRank; r++) {
      const segs: [number, number][] = [];
      for (const k of layers[r]!) for (const d of L[k]!.down) segs.push([L[k]!.order, L[d]!.order]);
      for (let i = 0; i < segs.length; i++)
        for (let j = i + 1; j < segs.length; j++) {
          const [a1, b1] = segs[i]!;
          const [a2, b2] = segs[j]!;
          if ((a1 - a2) * (b1 - b2) < 0) c++;
        }
    }
    return c;
  };
  let best = layers.map((l) => [...l]);
  let bestC = crossings();
  const sortBy = (r: number, dirUp: boolean) => {
    const layer = layers[r]!;
    const bary = new Map<number, number>();
    for (const k of layer) {
      const nb = dirUp ? L[k]!.up : L[k]!.down;
      bary.set(k, nb.length ? nb.reduce((s, n) => s + L[n]!.order, 0) / nb.length : L[k]!.order);
    }
    layer.sort((a, b) => bary.get(a)! - bary.get(b)! || L[a]!.order - L[b]!.order);
    layer.forEach((k, i) => (L[k]!.order = i));
  };
  const transpose = () => {
    let improved = true;
    let guard = 0;
    while (improved && guard++ < 8) {
      improved = false;
      for (let r = 0; r <= maxRank; r++) {
        const layer = layers[r]!;
        for (let i = 0; i + 1 < layer.length; i++) {
          const before = crossings();
          [layer[i], layer[i + 1]] = [layer[i + 1]!, layer[i]!];
          layer.forEach((k, j) => (L[k]!.order = j));
          if (crossings() < before) improved = true;
          else {
            [layer[i], layer[i + 1]] = [layer[i + 1]!, layer[i]!];
            layer.forEach((k, j) => (L[k]!.order = j));
          }
        }
      }
    }
  };
  for (let it = 0; it < 6 && bestC > 0; it++) {
    for (let r = 1; r <= maxRank; r++) sortBy(r, true);
    for (let r = maxRank - 1; r >= 0; r--) sortBy(r, false);
    if (L.length <= 90) transpose();
    const c = crossings();
    if (c < bestC) {
      bestC = c;
      best = layers.map((l) => [...l]);
    }
  }
  best.forEach((l, r) => (layers[r] = l));
  setOrder();

  // ---- placement across each rank ---------------------------------------------------------
  const sep = (a: LNode, b: LNode) => (a.across / 2 + a.extra) + b.across / 2 + (a.real >= 0 && b.real >= 0 ? NODE_GAP : VIRTUAL_GAP);
  const place = (layer: number[], desired: (n: LNode) => number) => {
    if (layer.length === 0) return;
    // q_i = p_i − offset_i turns "p_{i+1} ≥ p_i + sep" into "q nondecreasing": pool adjacent violators.
    const offsets = [0];
    for (let i = 1; i < layer.length; i++) offsets.push(offsets[i - 1]! + sep(L[layer[i - 1]!]!, L[layer[i]!]!));
    const blocks: { sum: number; n: number; from: number }[] = [];
    layer.forEach((k, i) => {
      blocks.push({ sum: desired(L[k]!) - offsets[i]!, n: 1, from: i });
      while (blocks.length > 1 && blocks[blocks.length - 2]!.sum / blocks[blocks.length - 2]!.n > blocks[blocks.length - 1]!.sum / blocks[blocks.length - 1]!.n) {
        const b = blocks.pop()!;
        const a = blocks[blocks.length - 1]!;
        a.sum += b.sum;
        a.n += b.n;
      }
    });
    blocks.forEach((b, bi) => {
      const to = bi + 1 < blocks.length ? blocks[bi + 1]!.from : layer.length;
      for (let i = b.from; i < to; i++) L[layer[i]!]!.pos = b.sum / b.n + offsets[i]!;
    });
  };
  const mean = (ks: number[], self: LNode) => (ks.length ? ks.reduce((s, k) => s + L[k]!.pos, 0) / ks.length : self.pos);
  for (const layer of layers) place(layer, () => 0);
  for (let it = 0; it < 8; it++) {
    for (let r = 1; r <= maxRank; r++) place(layers[r]!, (n) => mean(n.up, n));
    for (let r = maxRank - 1; r >= 0; r--) place(layers[r]!, (n) => mean(n.down, n));
  }
  for (let r = 0; r <= maxRank; r++) place(layers[r]!, (n) => mean([...n.up, ...n.down], n));

  // ---- along: rank thickness and offsets ---------------------------------------------------
  const thick = layers.map((layer) => Math.max(0, ...layer.map((k) => L[k]!.along)));
  const at: number[] = [];
  let cursor = MARGIN;
  for (let r = 0; r <= maxRank; r++) {
    at.push(cursor + thick[r]! / 2);
    cursor += thick[r]! + (r < maxRank ? RANK_GAP : 0);
  }
  const alongSize = cursor + MARGIN;
  const minAcross = Math.min(...L.map((n) => n.pos - n.across / 2));
  const shift = MARGIN - minAcross;
  for (const n of L) n.pos += shift;
  const acrossSize = Math.max(...L.map((n) => n.pos + n.across / 2 + n.extra)) + MARGIN;

  // ---- to screen ---------------------------------------------------------------------------
  const pt = (across: number, along: number) => (right ? { x: along, y: across } : { x: across, y: along });
  const nodes: PlacedFlowNode[] = spec.nodes.map((n, i) => {
    const c = pt(L[i]!.pos, at[L[i]!.rank]!);
    return { id: n.id, x: c.x, y: c.y, w: boxes[i]!.w, h: boxes[i]!.h, shape: n.shape, ...(n.tone ? { tone: n.tone } : {}), lines: boxes[i]!.lines, noteLines: boxes[i]!.noteLines, full: n.note ? `${n.label} — ${n.note}` : n.label };
  });

  // Ports: edges leaving (or entering) one side of a node fan out along it, in the order of the
  // node at their other end, so parallel edges don't share a pixel.
  const portOffset = new Map<string, number>();
  const fan = (k: number, side: "up" | "down") => {
    const nbs = side === "down" ? L[k]!.down : L[k]!.up;
    const sorted = [...nbs.keys()].sort((a, b) => L[nbs[a]!]!.pos - L[nbs[b]!]!.pos);
    const span = Math.min(14, (L[k]!.across - 16) / Math.max(1, nbs.length));
    sorted.forEach((idx, j) => portOffset.set(`${k}:${side}:${idx}`, (j - (nbs.length - 1) / 2) * Math.max(0, span)));
  };
  for (let i = 0; i < spec.nodes.length; i++) {
    fan(i, "down");
    fan(i, "up");
  }
  /** Where an edge meets node i's boundary, on the down (+along) or up side, `off` across center. */
  const boundary = (i: number, side: 1 | -1, off: number) => {
    const n = L[i]!;
    const half = n.along / 2;
    const shape = spec.nodes[i]!.shape;
    let a = half;
    if (shape === "decision") a = half * Math.max(0.15, 1 - Math.abs(off) / (n.across / 2));
    else if (shape === "circle" || shape === "start" || shape === "end") a = Math.sqrt(Math.max(0, half * half - off * off));
    return { across: n.pos + off, along: at[n.rank]! + side * a };
  };

  const edgesOut: PlacedFlowEdge[] = [];
  for (const ch of chains) {
    const e = spec.edges[ch.edge]!;
    const pts: { across: number; along: number }[] = [];
    const first = ch.keys[0]!;
    const last = ch.keys[ch.keys.length - 1]!;
    const offDown = portOffset.get(`${first}:down:${L[first]!.down.indexOf(ch.keys[1]!)}`) ?? 0;
    const offUp = portOffset.get(`${last}:up:${L[last]!.up.indexOf(ch.keys[ch.keys.length - 2]!)}`) ?? 0;
    pts.push(boundary(first, 1, offDown));
    for (const k of ch.keys.slice(1, -1)) {
      const n = L[k]!;
      const t = thick[n.rank]!;
      pts.push({ across: n.pos, along: at[n.rank]! - t / 2 });
      if (t > 0) pts.push({ across: n.pos, along: at[n.rank]! + t / 2 });
    }
    const end = boundary(last, -1, offUp);
    // Leave a hair of room so the arrowhead tip touches, not overlaps, the box.
    pts.push(end);
    const screen = (ch.reversed ? [...pts].reverse() : pts).map((p) => pt(p.across, p.along));
    const placed: PlacedFlowEdge = { path: curve(screen, right), dashed: e.dashed, both: e.both };
    if (ch.labelKey !== null) {
      const n = L[ch.labelKey]!;
      const lb = labelBoxes.get(ch.labelKey)!;
      const c = pt(n.pos, at[n.rank]!);
      placed.label = { x: c.x, y: c.y, w: lb.w, h: lb.h, lines: lb.lines };
    }
    edgesOut.push(placed);
  }
  for (const e of loops) {
    const i = index.get(spec.edges[e]!.from)!;
    const n = nodes[i]!;
    const lb = loopLabels.get(e);
    const edge = spec.edges[e]!;
    if (right) {
      // Loop under the node.
      const y0 = n.y + n.h / 2;
      const d = `M ${n.x - 8} ${y0} C ${n.x - 14} ${y0 + 24}, ${n.x + 14} ${y0 + 24}, ${n.x + 8} ${y0 + 1}`;
      edgesOut.push({ path: d, dashed: edge.dashed, both: edge.both, ...(lb ? { label: { x: n.x, y: y0 + 22 + lb.h / 2 + 2, ...lb } } : {}) });
    } else {
      const x0 = n.x + n.w / 2;
      const d = `M ${x0} ${n.y - 7} C ${x0 + 26} ${n.y - 14}, ${x0 + 26} ${n.y + 14}, ${x0 + 1} ${n.y + 7}`;
      edgesOut.push({ path: d, dashed: edge.dashed, both: edge.both, ...(lb ? { label: { x: x0 + 24 + lb.w / 2, y: n.y, ...lb } } : {}) });
    }
  }

  const size = pt(acrossSize, alongSize);
  return { width: Math.ceil(size.x), height: Math.ceil(size.y), nodes, edges: edgesOut };
}

/** S-curves with tangents along the rank axis between consecutive points; straight where aligned. */
export function curve(pts: { x: number; y: number }[], right: boolean): string {
  const f = (n: number) => Math.round(n * 10) / 10;
  let d = `M ${f(pts[0]!.x)} ${f(pts[0]!.y)}`;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1]!;
    const q = pts[i]!;
    if ((right ? Math.abs(p.y - q.y) : Math.abs(p.x - q.x)) < 0.5) {
      d += ` L ${f(q.x)} ${f(q.y)}`;
      continue;
    }
    if (right) {
      const mx = (p.x + q.x) / 2;
      d += ` C ${f(mx)} ${f(p.y)}, ${f(mx)} ${f(q.y)}, ${f(q.x)} ${f(q.y)}`;
    } else {
      const my = (p.y + q.y) / 2;
      d += ` C ${f(p.x)} ${f(my)}, ${f(q.x)} ${f(my)}, ${f(q.x)} ${f(q.y)}`;
    }
  }
  return d;
}
