/**
 * The Ideas panel's link graph, laid out without a library: nodes seeded on a ring of namespace
 * clusters, then relaxed by a fixed number of force steps (springs along links, repulsion between
 * every pair, a pull back to the node's own cluster). Pure and deterministic — the same ideas
 * always draw the same picture, so a refetch that changed nothing never moves a node.
 */

export interface GraphNode {
  id: string;
  /** The cluster it seeds into: the idea's namespace. */
  group: string;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface PlacedNode extends GraphNode {
  x: number;
  y: number;
  /** Which side of the dot its label sits: right ("start") or, near the right edge, left ("end"). */
  anchor: "start" | "end";
}

export interface PlacedEdge extends GraphEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface GraphLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  /** Links whose target is not an idea on the graph (a typo, or an idea not filed yet). */
  dangling: GraphEdge[];
  width: number;
  height: number;
}

export interface LayoutOptions {
  width: number;
  height: number;
  /** Kept clear at every edge, so a node's label is never cut off. */
  pad?: number;
  iterations?: number;
  /** A label's width in px. Given, labels are placed so no two label boxes overlap. */
  labelWidth?(id: string): number;
}

/** Label geometry (px): the gap between dot and text, and the half-height of a label's box. */
export const LABEL_GAP = 11;
const LABEL_HALF = 9;

/**
 * Place `nodes` and route `edges` inside a `width` × `height` box. Self-links and duplicate
 * links (either direction) draw once; links to ids not in `nodes` come back as `dangling`.
 */
export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[], opts: LayoutOptions): GraphLayout {
  const { width, height } = opts;
  const pad = opts.pad ?? 24;
  const iterations = opts.iterations ?? 240;
  const ids = new Set(nodes.map((n) => n.id));
  const seen = new Set<string>();
  const kept: GraphEdge[] = [];
  const dangling: GraphEdge[] = [];
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) {
      dangling.push(e);
      continue;
    }
    if (e.from === e.to) continue;
    const key = e.from < e.to ? `${e.from}\0${e.to}` : `${e.to}\0${e.from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(e);
  }

  // Seed: groups on a ring (sorted, so the order never depends on the input's), each group's
  // nodes on a small ring around its centre.
  const cx = width / 2;
  const cy = height / 2;
  const inner = Math.max(0, Math.min(width, height) / 2 - pad);
  const groups = [...new Set(nodes.map((n) => n.group))].sort();
  const members = new Map<string, GraphNode[]>();
  for (const n of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) members.set(n.group, [...(members.get(n.group) ?? []), n]);
  const ringR = groups.length > 1 ? inner * 0.55 : 0;
  const centre = new Map<string, { x: number; y: number }>();
  groups.forEach((g, i) => {
    const a = (2 * Math.PI * i) / groups.length - Math.PI / 2;
    centre.set(g, { x: cx + ringR * Math.cos(a), y: cy + ringR * Math.sin(a) });
  });
  const pos = new Map<string, { x: number; y: number }>();
  for (const [g, list] of members) {
    const c = centre.get(g)!;
    const r = list.length > 1 ? Math.min(inner * 0.35, 18 + 10 * list.length) : 0;
    list.forEach((n, i) => {
      const a = (2 * Math.PI * i) / list.length;
      pos.set(n.id, { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
    });
  }

  // Relax (Fruchterman–Reingold with linear cooling).
  const list = [...pos.keys()];
  const k = list.length ? Math.sqrt(((width - 2 * pad) * (height - 2 * pad)) / list.length) * 0.6 : 0;
  const clampX = (x: number) => Math.min(width - pad, Math.max(pad, x));
  const clampY = (y: number) => Math.min(height - pad, Math.max(pad, y));
  const group = new Map(nodes.map((n) => [n.id, n.group]));
  for (let step = 0; step < iterations && list.length > 1; step++) {
    const temp = (Math.min(width, height) / 10) * (1 - step / iterations);
    const disp = new Map(list.map((id) => [id, { x: 0, y: 0 }]));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const ia = list[i]!;
        const ib = list[j]!;
        const a = pos.get(ia)!;
        const b = pos.get(ib)!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d = Math.hypot(dx, dy);
        if (d < 0.01) {
          // Coincident: nudge apart along a fixed, index-derived direction (never random).
          dx = Math.cos(i + j);
          dy = Math.sin(i + j);
          d = 1;
        }
        const f = (k * k) / d;
        const da = disp.get(ia)!;
        const db = disp.get(ib)!;
        da.x += (dx / d) * f;
        da.y += (dy / d) * f;
        db.x -= (dx / d) * f;
        db.y -= (dy / d) * f;
      }
    }
    for (const e of kept) {
      const a = pos.get(e.from)!;
      const b = pos.get(e.to)!;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d = Math.max(0.01, Math.hypot(dx, dy));
      const f = (d * d) / k;
      const da = disp.get(e.from)!;
      const db = disp.get(e.to)!;
      da.x -= (dx / d) * f;
      da.y -= (dy / d) * f;
      db.x += (dx / d) * f;
      db.y += (dy / d) * f;
    }
    for (const id of list) {
      const p = pos.get(id)!;
      const c = centre.get(group.get(id)!)!;
      const d = disp.get(id)!;
      d.x += (c.x - p.x) * 0.05 * k * 0.1;
      d.y += (c.y - p.y) * 0.05 * k * 0.1;
      const len = Math.hypot(d.x, d.y);
      if (len > 0) {
        p.x = clampX(p.x + (d.x / len) * Math.min(len, temp));
        p.y = clampY(p.y + (d.y / len) * Math.min(len, temp));
      }
    }
  }

  // Labels: right of the dot, or left of it in the right 40% of the box, so none runs off. With
  // their widths known, nudge nodes apart vertically until no two label boxes (dot included)
  // overlap — the forces space dots, not the words beside them.
  const anchor = (x: number): "start" | "end" => (x > width * 0.6 ? "end" : "start");
  if (opts.labelWidth && list.length > 1) {
    const box = (id: string) => {
      const p = pos.get(id)!;
      const w = opts.labelWidth!(id);
      return anchor(p.x) === "start" ? [p.x - 8, p.x + LABEL_GAP + w] : [p.x - LABEL_GAP - w, p.x + 8];
    };
    for (let pass = 0; pass < 60; pass++) {
      let moved = false;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = pos.get(list[i]!)!;
          const b = pos.get(list[j]!)!;
          const [al, ar] = box(list[i]!);
          const [bl, br] = box(list[j]!);
          const dy = b.y - a.y;
          const need = 2 * LABEL_HALF + 2 - Math.abs(dy);
          if (ar! <= bl! || br! <= al! || need <= 0) continue;
          // Apart along y, the upper one up; a tie goes by index, never at random.
          const dir = dy > 0 || (dy === 0 && i < j) ? 1 : -1;
          a.y = clampY(a.y - (dir * need) / 2);
          b.y = clampY(b.y + (dir * need) / 2);
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  const placed: PlacedNode[] = nodes.map((n) => {
    const p = pos.get(n.id)!;
    const x = round(clampX(p.x));
    return { ...n, x, y: round(clampY(p.y)), anchor: anchor(x) };
  });
  const at = new Map(placed.map((n) => [n.id, n]));
  const routed: PlacedEdge[] = kept.map((e) => {
    const a = at.get(e.from)!;
    const b = at.get(e.to)!;
    return { ...e, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  });
  return { nodes: placed, edges: routed, dangling, width, height };
}

const round = (v: number) => Math.round(v * 10) / 10;

/**
 * The ids a highlighted node lights up: itself, what it links to and what links to it, one hop.
 * The graph's hover/selection state; the panel's scope view walks further, on the server.
 */
export function neighbours(id: string, edges: GraphEdge[]): Set<string> {
  const out = new Set([id]);
  for (const e of edges) {
    if (e.from === id) out.add(e.to);
    if (e.to === id) out.add(e.from);
  }
  return out;
}
