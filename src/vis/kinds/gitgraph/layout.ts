/**
 * `vis gitgraph` geometry: time runs down, one row per commit, one lane (column) per branch, and
 * the commit's id, message, branch heads and tags to the right of the lanes, wrapped to the width
 * the pane gives. Laid out for one moment of the history (`at`, a row): the heads, tags and ghosts
 * are the ones that held then, so a step-through replays a rebase. Pure: no DOM.
 */

import { estimateWidth, wrap, type Measure } from "../../core/text";
import type { GitCommit, GitgraphSpec } from "./parse";

export const GIT_FONT = { message: 13, id: 12, chip: 11, meta: 12 } as const;
const LH = 18;
const PAD = 4;
const R = 6;
const LANE_W = 20;
const GAP = 12;
const ROW_MIN = 30;
const CHIP_H = 18;
const CHIP_PAD = 7;
const BADGE = 22;
const BEND = 14;

export interface GitChip {
  kind: "branch" | "tag";
  name: string;
  /** What it shows: the name, shortened with "…" when the pane is too narrow for it. */
  label: string;
  /** A branch chip's lane (its colour); a tag's is -1. */
  lane: number;
  x: number;
  y: number;
  w: number;
}
export interface PlacedCommit {
  commit: GitCommit;
  row: number;
  /** The dot. */
  x: number;
  y: number;
  top: number;
  h: number;
  ghost: boolean;
  /** Where the id and message start (after the badge room, when there is a badge). */
  tx: number;
  id?: { x: number; y: number };
  lines: { x: number; y: number; text: string }[];
  meta?: { x: number; y: number; text: string };
  chips: GitChip[];
}
export interface GitEdge {
  path: string;
  /** The child's row: an edge appears with it. */
  row: number;
  lane: number;
  /** Into a ghost, or a copy's link to what it copies. */
  ghost: boolean;
  link: boolean;
}
export interface GitLayout {
  width: number;
  height: number;
  laneX: number[];
  /** Where the text column starts. */
  textX: number;
  commits: PlacedCommit[];
  edges: GitEdge[];
}

/** Where every branch head and tag points at row `at`. */
export function refsAt(spec: GitgraphSpec, at: number) {
  const heads = new Map<string, string | null>();
  for (const h of spec.heads) if (h.at <= at) heads.set(h.name, h.commit);
  return { heads, tags: spec.tags.filter((t) => t.at <= at) };
}

export function layoutGitgraph(spec: GitgraphSpec, width: number, at = spec.commits.length - 1, measure: Measure = estimateWidth, badged: Set<string> = new Set()): GitLayout {
  const lanes = Math.max(1, ...spec.commits.map((c) => c.lane + 1), spec.branches.length);
  const laneX = Array.from({ length: lanes }, (_, i) => PAD + R + 2 + i * LANE_W);
  const textX = laneX[lanes - 1]! + R + GAP;
  const avail = Math.max(120, width - textX - PAD);
  const { heads, tags } = refsAt(spec, at);
  const chipW = (label: string, kind: GitChip["kind"]) => measure(label, GIT_FONT.chip) + CHIP_PAD * 2 + (kind === "tag" ? 5 : 0);
  const byCommit = new Map<string, GitChip[]>();
  const chip = (commit: string | null, c: Omit<GitChip, "x" | "y" | "w" | "label">) => {
    if (commit === null) return;
    const list = byCommit.get(commit) ?? [];
    list.push({ ...c, label: c.name, x: 0, y: 0, w: chipW(c.name, c.kind) });
    byCommit.set(commit, list);
  };
  spec.branches.forEach((b, i) => heads.has(b.name) && chip(heads.get(b.name)!, { kind: "branch", name: b.name, lane: i }));
  for (const t of tags) chip(t.commit, { kind: "tag", name: t.name, lane: -1 });

  const rowOf = new Map(spec.commits.map((c, i) => [c.id, i]));
  // One id column, so the messages line up whatever the ids' lengths.
  const idCol = Math.max(0, ...spec.commits.filter((c) => c.named).map((c) => measure(c.id, GIT_FONT.id, true) + 8));
  // A numbered mark's badge sits before the id; when any row has one, every row makes room, so the ids stay in line.
  const badgeCol = spec.commits.some((c) => badged.has(c.id));
  const placed: PlacedCommit[] = [];
  let y = PAD;
  let right = textX;
  spec.commits.forEach((c, row) => {
    const ghost = c.ghostAt !== undefined && c.ghostAt <= at;
    const tx = textX + (badgeCol ? BADGE : 0);
    const idW = idCol;
    const msgX = tx + idW;
    const msgW = Math.max(60, avail - (tx - textX) - idW);
    const lines = c.message ? wrap(c.message, msgW, 4, GIT_FONT.message, measure) : [];
    // After the message: the meta phrase and the chips, flowing onto new lines as they need.
    let line = 0;
    let x = lines.length ? msgX + measure(lines[lines.length - 1]!, GIT_FONT.message) + 8 : msgX;
    if (lines.length) line = lines.length - 1;
    const limit = textX + avail;
    const place = (w: number) => {
      if (x + w > limit && x > msgX) {
        line++;
        x = msgX;
      }
      const at = { x, line };
      x += w + 6;
      return at;
    };
    const metaText = meta(c, ghost, spec);
    const metaAt = metaText ? place(measure(metaText, GIT_FONT.meta)) : undefined;
    const chips = (ghost ? [] : (byCommit.get(c.id) ?? [])).map((ch) => {
      // A chip never runs past the pane: a long name loses its end.
      const room = limit - msgX;
      let label = ch.label;
      while (chipW(label, ch.kind) > room && label.length > 1) label = label.slice(0, -1);
      if (label !== ch.label) {
        while (chipW(`${label}…`, ch.kind) > room && label.length > 1) label = label.slice(0, -1);
        label = `${label}…`;
      }
      const w = chipW(label, ch.kind);
      return { ch: { ...ch, label, w }, at: place(w) };
    });
    const nLines = Math.max(1, lines.length, line + 1);
    const h = Math.max(ROW_MIN, nLines * LH + 12);
    const cy = y + 6 + LH / 2;
    const lineY = (i: number) => cy + i * LH;
    const p: PlacedCommit = {
      commit: c,
      row,
      x: laneX[c.lane]!,
      y: cy,
      top: y,
      h,
      ghost,
      tx,
      ...(c.named ? { id: { x: tx, y: cy } } : {}),
      lines: lines.map((text, i) => ({ x: msgX, y: lineY(i), text })),
      ...(metaAt ? { meta: { x: metaAt.x, y: lineY(metaAt.line), text: metaText! } } : {}),
      chips: chips.map(({ ch, at }) => ({ ...ch, x: at.x, y: lineY(at.line) })),
    };
    right = Math.max(right, x - 6, ...p.lines.map((l) => l.x + measure(l.text, GIT_FONT.message)), msgX);
    placed.push(p);
    y += h;
  });

  const edges: GitEdge[] = [];
  for (const p of placed) {
    p.commit.parents.forEach((pid, j) => {
      const q = placed[rowOf.get(pid)!]!;
      edges.push({ path: edgePath(q.x, q.y, p.x, p.y, j === 0), row: p.row, lane: p.commit.lane, ghost: p.ghost, link: false });
    });
    const from = p.commit.from && p.commit.kind !== "rebase" ? placed[rowOf.get(p.commit.from)!] : undefined;
    if (from) edges.push({ path: arc(from.x, from.y, p.x, p.y), row: p.row, lane: p.commit.lane, ghost: false, link: true });
  }
  return { width: Math.ceil(Math.min(width, right + PAD)), height: Math.ceil(y + PAD), laneX, textX, commits: placed, edges };
}

function meta(c: GitCommit, ghost: boolean, spec: GitgraphSpec): string | undefined {
  if (ghost) {
    const copy = spec.commits.find((x) => x.id === c.replacedBy);
    return copy ? (copy.named ? `rebased as ${copy.id}` : "rebased") : "dropped by rebase";
  }
  if (c.kind === "pick") {
    const orig = spec.commits.find((x) => x.id === c.from);
    return orig?.named ? `picked from ${orig.id}` : "cherry-picked";
  }
  return undefined;
}

/**
 * Parent → child. In one lane, a straight line. A fork (first parent in another lane) turns into
 * the child's lane just below the parent, then runs down it; a merge's other parent runs down its
 * own lane and turns in just above the child. Neither crosses a dot.
 */
export function edgePath(px: number, py: number, cx: number, cy: number, fork: boolean): string {
  if (px === cx) return `M${px},${py} L${cx},${cy}`;
  const b = Math.min(BEND, (cy - py) / 2);
  if (fork) return `M${px},${py} C${px},${py + b} ${cx},${py} ${cx},${py + b * 1.6} L${cx},${cy}`;
  return `M${px},${py} L${px},${cy - b * 1.6} C${px},${cy} ${cx},${cy - b} ${cx},${cy}`;
}

/** A copy's link back to what it copies: a gentle arc, so it never lies along a lane. */
export function arc(ax: number, ay: number, bx: number, by: number): string {
  // Start and end at the dots' edges, so the arrowhead shows.
  const d = Math.hypot(bx - ax, by - ay) || 1;
  const s = (R + 3) / d;
  const [x1, y1, x2, y2] = [ax + (bx - ax) * s, ay + (by - ay) * s, bx - (bx - ax) * s, by - (by - ay) * s];
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const k = Math.min(28, len * 0.18);
  return `M${x1},${y1} Q${mx - (dy / len) * k},${my + (dx / len) * k} ${x2},${y2}`;
}
