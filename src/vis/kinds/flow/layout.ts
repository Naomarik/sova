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
import { canvasMeasure, estimateWidth, wrap, widest, type Measure } from "../../core/text";
import type { FlowSpec, Shape } from "./parse";
import { sectionsHeight } from "./sections";

export const FLOW_FONT = { label: 13, note: 11.5, edge: 11.5 } as const;
const LINE = { label: 17, note: 15, edge: 15 };
const RANK_GAP = 18;
/** An edge label wraps rather than loses its end: in a state machine it is the event's name. */
const EDGE_LINES = 4;
/** Spacing and wrap widths by level: 0 roomy; 1 and 2 for a pane the roomier drawing would overflow (a phone). */
const SPACING = [
  { padX: 14, padY: 9, maxText: 168, maxEdgeText: 140, nodeGap: 28, virtualGap: 12, margin: 12, minW: 64 },
  { padX: 10, padY: 8, maxText: 120, maxEdgeText: 100, nodeGap: 14, virtualGap: 6, margin: 6, minW: 48 },
  { padX: 7, padY: 7, maxText: 96, maxEdgeText: 80, nodeGap: 9, virtualGap: 4, margin: 4, minW: 40 },
] as const;
export const FLOW_LEVELS = SPACING.length;

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
export interface PlacedFlowGroup {
  label: string;
  /** The label as drawn: whole, or cut to the frame's width with "…" (dir: right; the View adds a tooltip). */
  title: string;
  /** Top-left corner and size of the frame; its label sits inside, at the top. */
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface FlowLayout {
  width: number;
  height: number;
  nodes: PlacedFlowNode[];
  edges: PlacedFlowEdge[];
  groups?: PlacedFlowGroup[];
}
/** A group's frame: padding around its nodes, and its label's line above them (flow.css: fs-caption semibold). */
export const GROUP = { pad: 10, title: 18, font: 12.5 } as const;
/** The title is set semibold; the measure is medium: room for the difference. */
const SEMIBOLD = 1.06;

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

export function layoutFlow(spec: FlowSpec, measure: Measure = estimateWidth, level = 0): FlowLayout {
  const compact = level > 0;
  const { padX, padY, maxText: MAX_TEXT, maxEdgeText: MAX_EDGE_TEXT, nodeGap: NODE_GAP, virtualGap: VIRTUAL_GAP, margin: MARGIN, minW } = SPACING[Math.min(level, SPACING.length - 1)]!;
  const right = spec.dir === "right";
  const index = new Map(spec.nodes.map((n, i) => [n.id, i]));

  // ---- boxes -------------------------------------------------------------------------------
  const boxes = spec.nodes.map((n) => {
    const tiny = n.shape === "start" || n.shape === "end";
    // A decision wraps early (two short lines make a squarer, narrower diamond), never mid-word.
    const longestWord = Math.max(0, ...n.label.split(/\s+/).map((w) => measure(w, FLOW_FONT.label)));
    const maxText = n.shape === "decision" ? Math.min(MAX_TEXT, Math.max(compact ? 80 : 90, longestWord + 1)) : MAX_TEXT;
    const lines = tiny ? [] : wrap(n.label, maxText, 3, FLOW_FONT.label, measure);
    const noteLines = tiny || !n.note ? [] : wrap(n.note, maxText, 2, FLOW_FONT.note, measure);
    const tw = Math.max(widest(lines, FLOW_FONT.label, measure), widest(noteLines, FLOW_FONT.note, measure));
    const th = lines.length * LINE.label + noteLines.length * LINE.note;
    let w = Math.max(minW, tw + 2 * padX);
    let h = th + 2 * padY;
    if (tiny) w = h = n.shape === "start" ? 18 : 22;
    else if (n.shape === "decision") {
      // The text box fits inside the diamond when tw/w + th/h <= 1: a taller diamond is a narrower one.
      h = Math.max(48, 2.2 * th + 8);
      w = Math.max(88, tw / (1 - th / h) + 18);
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
    // An end state (a sink drawn as the exit dot) sits on the last rank, under everything else.
    const last = Math.max(...rank);
    spec.nodes.forEach((n, u) => {
      if (n.shape === "end" && !dag.some((ed) => ed.u === u)) rank[u] = last;
    });
  }

  // ---- layout graph with virtual nodes -----------------------------------------------------
  const L: LNode[] = [];
  const add = (real: number, r: number, across: number, along: number): number => {
    L.push({ key: L.length, real, rank: r, across, along, extra: 0, pos: 0, order: 0, up: [], down: [] });
    return L.length - 1;
  };
  spec.nodes.forEach((_, i) => add(i, rank[i]!, right ? boxes[i]!.h : boxes[i]!.w, right ? boxes[i]!.w : boxes[i]!.h));
  const labelBoxes = new Map<number, { w: number; h: number; lines: string[] }>();
  const edgeLabel = (label: string | undefined) => {
    if (!label) return null;
    // Never narrower than the longest word: a word split mid-way reads as two.
    const longest = Math.max(0, ...label.split(/\s+/).map((w) => measure(w, FLOW_FONT.edge)));
    const lines = wrap(label, Math.max(MAX_EDGE_TEXT, Math.min(160, longest + 1)), EDGE_LINES, FLOW_FONT.edge, measure);
    return { w: widest(lines, FLOW_FONT.edge, measure) + 10, h: lines.length * LINE.edge + 4, lines };
  };
  const labels = dag.map((ed) => edgeLabel(spec.edges[ed.e]!.label));
  // Each label rides one odd rank its edge crosses. Short edges have one choice; a long edge takes
  // the least crowded of its odd ranks (nearest the middle on a tie), so labels spread out instead
  // of lining up across the busiest rank.
  const labelRank = new Array<number>(dag.length).fill(-1);
  {
    const load = new Map<number, number>();
    const order = dag.map((_, i) => i).sort((a, b) => rank[dag[a]!.v]! - rank[dag[a]!.u]! - (rank[dag[b]!.v]! - rank[dag[b]!.u]!) || a - b);
    for (const i of order) {
      const lb = labels[i];
      if (!lb) continue;
      const ru = rank[dag[i]!.u]!;
      const rv = rank[dag[i]!.v]!;
      const mid = (ru + rv) / 2;
      let best = -1;
      for (let r = ru + 1; r < rv; r += 2) {
        const cost = (load.get(r) ?? 0) * 1000 + Math.abs(r - mid);
        const bestCost = best < 0 ? Infinity : (load.get(best) ?? 0) * 1000 + Math.abs(best - mid);
        if (cost < bestCost) best = r;
      }
      labelRank[i] = best;
      load.set(best, (load.get(best) ?? 0) + (right ? lb.h : lb.w));
    }
  }
  const chains: Chain[] = dag.map((ed, di) => {
    const lb = labels[di]!;
    const keys = [ed.u];
    const ru = rank[ed.u]!;
    const rv = rank[ed.v]!;
    const mid = labelRank[di]!;
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
      const lines = wrap(label, MAX_EDGE_TEXT, EDGE_LINES, FLOW_FONT.edge, measure);
      const lb = { w: widest(lines, FLOW_FONT.edge, measure) + 10, h: lines.length * LINE.edge + 4, lines };
      loopLabels.set(e, lb);
      extra += (right ? lb.h : lb.w) + 4;
    }
    L[u]!.extra = Math.max(L[u]!.extra, extra);
  }

  // ---- groups: which frame each layout node sits in (-1: none) ------------------------------
  const groups = spec.groups ?? [];
  const grp = new Array<number>(L.length).fill(-1);
  groups.forEach((g, gi) => g.nodes.forEach((id) => (grp[index.get(id)!] = gi)));
  // A frame spans its nodes' ranks. An edge's bends (and label) sit inside a frame on the ranks it
  // spans when an end of the edge is in it (an edge enters, then runs inside); elsewhere outside.
  const grpRanks = groups.map((_, gi) => {
    const rs = L.filter((n) => grp[n.key] === gi).map((n) => n.rank);
    return { from: Math.min(...rs), to: Math.max(...rs) };
  });
  for (const ch of chains) {
    const ends = [grp[ch.keys[ch.keys.length - 1]!]!, grp[ch.keys[0]!]!].filter((g) => g >= 0);
    for (const k of ch.keys.slice(1, -1)) {
      const r = L[k]!.rank;
      grp[k] = ends.find((g) => r >= grpRanks[g]!.from && r <= grpRanks[g]!.to) ?? -1;
    }
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
  // A group's members sit side by side on every rank, and groups keep one left-to-right order on all
  // ranks (else two frames would cross). The global order: each group's mean relative position.
  let groupOrder: number[] = [];
  const rankGroups = () => {
    const at = groups.map((_, gi) => {
      const ms = L.filter((n) => grp[n.key] === gi);
      return ms.reduce((a, n) => a + (n.order + 0.5) / layers[n.rank]!.length, 0) / Math.max(1, ms.length);
    });
    groupOrder = groups.map((_, gi) => gi).sort((a, b) => at[a]! - at[b]! || a - b);
  };
  const cluster = (r: number) => {
    if (!groups.length) return;
    const layer = layers[r]!;
    const blocks: { g: number; at: number; keys: number[] }[] = [];
    const byG = new Map<number, { g: number; at: number; keys: number[] }>();
    for (const k of layer) {
      const g = grp[k]!;
      if (g < 0) blocks.push({ g, at: L[k]!.order, keys: [k] });
      else {
        let b = byG.get(g);
        if (!b) byG.set(g, (b = { g, at: 0, keys: [] })), blocks.push(b);
        b.keys.push(k);
      }
    }
    for (const b of byG.values()) b.at = b.keys.reduce((a, k) => a + L[k]!.order, 0) / b.keys.length;
    blocks.sort((a, b) => a.at - b.at);
    // The slots groups took, handed out again in the global group order.
    const slots = blocks.map((b, i) => (b.g >= 0 ? i : -1)).filter((i) => i >= 0);
    const inOrder = groupOrder.filter((g) => byG.has(g)).map((g) => byG.get(g)!);
    slots.forEach((slot, j) => (blocks[slot] = inOrder[j]!));
    layers[r] = blocks.flatMap((b) => b.keys);
    layers[r]!.forEach((k, i) => (L[k]!.order = i));
  };
  const clustered = (r: number) => {
    const seen: number[] = [];
    let last = -2;
    for (const k of layers[r]!) {
      const g = grp[k]!;
      if (g >= 0 && g !== last) {
        if (seen.includes(g)) return false;
        seen.push(g);
      }
      last = g;
    }
    const want = groupOrder.filter((g) => seen.includes(g));
    return want.every((g, i) => g === seen[i]);
  };
  if (groups.length) {
    rankGroups();
    for (let r = 0; r < layers.length; r++) cluster(r);
  }
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
    cluster(r);
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
          if (crossings() < before && clustered(r)) improved = true;
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
  const titleAcross = right ? GROUP.title : 0;
  const framePad = (a: LNode, b: LNode) => {
    const ga = grp[a.key]!;
    const gb = grp[b.key]!;
    return (ga >= 0 && ga !== gb ? GROUP.pad + NODE_GAP / 2 : 0) + (gb >= 0 && gb !== ga ? GROUP.pad + titleAcross + NODE_GAP / 2 : 0);
  };
  const sep = (a: LNode, b: LNode) => (a.across / 2 + a.extra) + b.across / 2 + (a.real >= 0 && b.real >= 0 ? NODE_GAP : VIRTUAL_GAP) + framePad(a, b);
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

  // ---- groups: a frame is one rectangle over all its ranks, so every other node on those ranks
  // must sit left or right of its span. Pushes only ever move things right (a node, a frame and
  // what lies after them), in the one left-to-right order of groups, so this settles.
  const titleW = groups.map((g) => measure(g.label, GROUP.font) * SEMIBOLD + 2 * GROUP.pad);
  const span = (gi: number) => {
    const ms = L.filter((n) => grp[n.key] === gi);
    let lo = Math.min(...ms.map((n) => n.pos - n.across / 2)) - GROUP.pad - titleAcross;
    let hi = Math.max(...ms.map((n) => n.pos + n.across / 2 + n.extra)) + GROUP.pad;
    if (!right && hi - lo < titleW[gi]!) hi = lo + titleW[gi]!;
    return { lo, hi };
  };
  const gap = (n: LNode) => (n.real >= 0 ? NODE_GAP : VIRTUAL_GAP) / 2;
  const rightEdge = (n: LNode) => n.pos + n.across / 2 + n.extra;
  const orderOf = (g: number) => (g < 0 ? -1 : groupOrder.indexOf(g));
  /** Where frame gi sits on rank r: the index of its first node, or where it would go (nodes of groups before it, and plain nodes left of its middle, stay before it). */
  const slot = (gi: number, r: number, mid: number) => {
    const layer = layers[r]!;
    const own = layer.findIndex((k) => grp[k] === gi);
    if (own >= 0) return own;
    let s = 0;
    layer.forEach((k, i) => {
      const g = grp[k]!;
      if ((g >= 0 && orderOf(g) < orderOf(gi)) || (g < 0 && L[k]!.pos < mid)) s = i + 1;
    });
    return s;
  };
  /** Move frame gi and everything after it on its ranks right by `by`. */
  const shiftFrame = (gi: number, by: number, mid: number) => {
    for (let r = grpRanks[gi]!.from; r <= grpRanks[gi]!.to; r++) {
      const layer = layers[r]!;
      for (let i = slot(gi, r, mid); i < layer.length; i++) L[layer[i]!]!.pos += by;
    }
  };
  let guard = 0;
  for (; groups.length && guard < 100; guard++) {
    let moved = false;
    for (const gi of groupOrder) {
      for (let r = grpRanks[gi]!.from; r <= grpRanks[gi]!.to; r++) {
        const { lo, hi } = span(gi);
        const layer = layers[r]!;
        const at = slot(gi, r, (lo + hi) / 2);
        let end = at;
        while (end < layer.length && grp[layer[end]!] === gi) end++;
        // Something before the frame reaches into it: the frame (and all after it) moves right.
        if (at > 0) {
          const n = L[layer[at - 1]!]!;
          const over = rightEdge(n) + gap(n) - lo;
          if (over > 0.5) {
            shiftFrame(gi, over, (lo + hi) / 2);
            moved = true;
            continue;
          }
        }
        // Something after it starts inside it: that (and all after it) moves right.
        if (end < layer.length) {
          const n = L[layer[end]!]!;
          const over = hi + gap(n) - (n.pos - n.across / 2);
          if (over > 0.5) {
            for (let i = end; i < layer.length; i++) L[layer[i]!]!.pos += over;
            moved = true;
          }
        }
      }
    }
    // Two frames that share ranks: the later one in the group order moves right until they are a
    // gap apart (a frame's width can come from a rank other than the one where they meet).
    for (const [i, gi] of groupOrder.entries())
      for (const hj of groupOrder.slice(i + 1)) {
        if (grpRanks[gi]!.to < grpRanks[hj]!.from || grpRanks[hj]!.to < grpRanks[gi]!.from) continue;
        const a = span(gi);
        const b = span(hj);
        const over = a.hi + NODE_GAP - b.lo;
        if (over > 0.5 && b.hi > a.lo) {
          shiftFrame(hj, over, (b.lo + b.hi) / 2);
          moved = true;
        }
      }
    if (!moved) break;
  }

  // ---- along: rank thickness and offsets ---------------------------------------------------
  const thick = layers.map((layer) => Math.max(0, ...layer.map((k) => L[k]!.along)));
  const at: number[] = [];
  let cursor = MARGIN;
  const before = new Array<number>(maxRank + 1).fill(0);
  const after = new Array<number>(maxRank + 1).fill(0);
  // Nested ranks of several frames stack their pads; one frame's title and pad sit in the gap above it.
  grpRanks.forEach(({ from, to }) => {
    before[from] = Math.max(before[from]!, GROUP.pad + (right ? 0 : GROUP.title));
    after[to] = Math.max(after[to]!, GROUP.pad);
  });
  for (let r = 0; r <= maxRank; r++) {
    cursor += before[r]!;
    at.push(cursor + thick[r]! / 2);
    cursor += thick[r]! + after[r]! + (r < maxRank ? RANK_GAP : 0);
  }
  const alongSize = cursor + MARGIN;
  const frameSpans = groups.map((_, gi) => span(gi));
  const minAcross = Math.min(...L.map((n) => n.pos - n.across / 2), ...frameSpans.map((f) => f.lo));
  const shift = MARGIN - minAcross;
  for (const n of L) n.pos += shift;
  const acrossSize = Math.max(...L.map((n) => n.pos + n.across / 2 + n.extra), ...frameSpans.map((f) => f.hi + shift)) + MARGIN;

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

  const placedGroups: PlacedFlowGroup[] = groups.map((g, gi) => {
    const f = frameSpans[gi]!;
    const { from, to } = grpRanks[gi]!;
    const a0 = at[from]! - thick[from]! / 2 - GROUP.pad - (right ? 0 : GROUP.title);
    const a1 = at[to]! + thick[to]! / 2 + GROUP.pad;
    const p0 = pt(f.lo + shift, a0);
    const p1 = pt(f.hi + shift, a1);
    const w = Math.abs(p1.x - p0.x);
    const fit = (w - 2 * GROUP.pad) / SEMIBOLD;
    const title = measure(g.label, GROUP.font) <= fit ? g.label : wrap(g.label, Math.max(1, fit), 1, GROUP.font, measure)[0] ?? "";
    return { label: g.label, title, x: Math.min(p0.x, p1.x), y: Math.min(p0.y, p1.y), w, h: Math.abs(p1.y - p0.y) };
  });
  const size = pt(acrossSize, alongSize);
  return { width: Math.ceil(size.x), height: Math.ceil(size.y), nodes, edges: edgesOut, ...(placedGroups.length ? { groups: placedGroups } : {}) };
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

/**
 * The height SvgScroll (svg.tsx) gives a drawing in a pane `width` px wide: natural size, shrinking
 * with the pane down to 80% of it (rounded, as SvgScroll's min-width is), then scrolling sideways at
 * that size. A width of 0 (not measured yet) means natural size.
 */
export function scrolledHeight(l: { width: number; height: number }, width: number): number {
  if (width <= 0 || width >= l.width) return l.height;
  return (l.height * Math.max(Math.round(l.width * 0.8), width)) / l.width;
}

/**
 * The layout FlowView draws in a pane `width` px wide (0: not measured, the natural one). One that
 * would scroll is laid out again to fit: a `dir: right` one downwards first, then compact, then
 * tighter still; if nothing fits, the narrowest one scrolls.
 */
export function fitFlow(spec: FlowSpec, measure: Measure, width: number, natural: FlowLayout = layoutFlow(spec, measure)): FlowLayout {
  const fits = (l: FlowLayout) => l.width * 0.8 <= width;
  if (width <= 0 || fits(natural)) return natural;
  const right = spec.dir === "right";
  const at = right ? { ...spec, dir: "down" as const } : spec;
  let best = natural;
  for (let level = right ? 0 : 1; level < FLOW_LEVELS; level++) {
    const l = layoutFlow(at, measure, level);
    if (fits(l)) return l;
    if (l.width < best.width) best = l;
  }
  return best;
}

/**
 * The px height FlowView renders in a `.vis-body` whose content box is `width` px wide, for the
 * shell to reserve before the View loads. Exact: the same measure, layout choice and shrink the
 * View uses. (A drawing that still has to scroll may add a desktop scrollbar's height.)
 */
export function estimateHeight(spec: FlowSpec, width: number): number {
  if (spec.sections) return sectionsHeight(spec, width);
  return scrolledHeight(fitFlow(spec, canvasMeasure, width), width);
}
