/**
 * `vis flow` and `vis state`: nodes, edges, shapes and tones. See vis-mode.md § flow for the syntax
 * the model is taught. `== label ==` lines split one fence into panels: independent graphs, each
 * laid out on its own and drawn side by side (./sections.ts). Ids are local to their panel: the same
 * id in two panels is two nodes (the later one's key gets an `@<panel>` suffix no id can contain).
 *
 * Labels, two styles, chosen per fence. With `node` lines, a string after an edge's target is the
 * EDGE's label (`a -> b "x"`). Once any chain line has a string right after its source
 * (`a "A" -> b "B"`), the fence is inline-style: the first string after an id labels that node
 * when it has no label yet (no `node` line in its panel, no earlier inline label), and the next
 * string labels the edge (`a "A" -> b "B" "edge"`, `b --> a "reply"`). Repeating a node's inline
 * label is not an edge label. Shape and tone words may follow (`gate "Approve" decision`).
 *
 * `group "Label" a b c` (also frame/subgraph/cluster; no arrow on the line) draws a frame around
 * some nodes of one graph (./layout.ts keeps them together); per panel, flat, a node in one at most.
 */

import { applyMarks, byIdOrLabel, takeMarks } from "../../core/emphasis";
import { divider, fail, id, isTone, lines, modifiers, takeSettings, text, tokenize, warn, type Arrow, type Line, type Token, type Tone, type VisBase } from "../../core/grammar";

export const SHAPES = ["box", "round", "store", "decision", "circle", "start", "end"] as const;
export type Shape = (typeof SHAPES)[number];

export interface FlowNode {
  id: string;
  label: string;
  /** A second, quieter line under the label. */
  note?: string;
  shape: Shape;
  tone?: Tone;
}
export interface FlowEdge {
  from: string;
  to: string;
  label?: string;
  dashed: boolean;
  /** `<->`: arrowheads at both ends. */
  both: boolean;
}
export interface FlowSpec extends VisBase {
  kind: "flow";
  /** Which way ranks advance. */
  dir: "down" | "right";
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Present only when the fence has `== label ==` lines: its panels, in order. nodes/edges hold them all. */
  sections?: FlowSection[];
  /** Present only when the fence has `group` lines: frames drawn around some of one graph's nodes. Node keys; a node is in at most one. */
  groups?: FlowGroup[];
}
export interface FlowGroup {
  label: string;
  nodes: string[];
}
/** One panel: a graph of its own. Every node and edge is in exactly one. */
export interface FlowSection {
  label: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  groups?: FlowGroup[];
}
const GROUP_WORDS = ["group", "frame", "subgraph", "cluster"];
const MAX_GROUPS = 6;
/** `group "Label" a b c`: a group word, one string, then ids (commas allowed), and no arrow. */
const isGroupLine = (t: Token[]) => t[0]?.t === "word" && GROUP_WORDS.includes(t[0].v) && t[1]?.t === "str" && !t.some((x) => x.t === "arrow");

const MAX_NODES = 30;
const MAX_EDGES = 48;
const MAX_SECTIONS = 4;


function parseFlowLines(ls: Line[], defaultShape: Shape): FlowSpec {
  const spec: FlowSpec = { kind: "flow", dir: "down", nodes: [], edges: [] };
  const { rest: settled, values } = takeSettings(ls, ["dir"], spec);
  const { rest, marks } = takeMarks(settled);
  const dir = values.get("dir");
  if (dir) {
    if (dir.value !== "down" && dir.value !== "right") fail(dir.n, `dir: is down or right, not "${dir.value}"`);
    spec.dir = dir.value as "down" | "right";
  }
  const hasSections = rest.some((l) => divider(l) !== null);
  // A pre-pass for the label style: which ids have a `node` line (per panel), and whether any chain
  // line carries a string right after its source. A line it can't read is left to the main loop.
  const nodeLines = new Set<string>();
  let inlineStyle = false;
  let at = -1;
  for (const line of rest) {
    if (divider(line) !== null) {
      at++;
      continue;
    }
    let t: Token[];
    try {
      t = tokenize(line);
    } catch {
      continue;
    }
    if (t[0]?.t !== "word" || isGroupLine(t)) continue;
    if (t[0].v === "node") {
      if (t[1]?.t === "word") nodeLines.add(`${at}\0${t[1].v}`);
    } else if (t[1]?.t === "str") inlineStyle = true;
  }
  // Sections: each panel's ids are its own. `key` is the node's id in the spec: the id as written,
  // or, for an id an earlier panel already has, `id@<panel>` (no written id contains @).
  const sections: { label: string; n: number }[] = [];
  // Which panel each node (by key) and each edge belongs to.
  const home = new Map<string, number>();
  const edgeHome: number[] = [];
  const scoped = new Map<string, string>();
  const written = new Map<string, string>();
  const key = (nid: string, n: number): string => {
    const sec = sections.length - 1;
    if (hasSections && sec < 0) fail(n, "put the nodes and edges under a == section == line: once a flow has sections, everything drawn belongs to one");
    const scope = `${sec}\0${nid}`;
    let k = scoped.get(scope);
    if (k === undefined) {
      k = written.has(nid) ? `${nid}@${sec + 1}` : nid;
      scoped.set(scope, k);
      written.set(k, nid);
      home.set(k, sec);
    }
    return k;
  };
  const hasNodeLine = (nid: string) => nodeLines.has(`${sections.length - 1}\0${nid}`);
  const declared = new Map<string, FlowNode>();
  const groupLines: { label: string; ids: string[]; n: number; sec: number }[] = [];
  const used: string[] = [];
  // Inline-style node labels, by key (the first one wins).
  const inline = new Map<string, string>();
  const inlineLabel = (k: string, v: string, n: number) => {
    const prev = inline.get(k);
    if (prev === undefined) inline.set(k, v);
    else if (prev !== v) warn(n, `node ${written.get(k)} is labelled "${prev}" and "${v}": kept "${prev}"`);
  };
  // Tones written after an edge's target (a -> b "label" error): they colour the target node.
  const chainTone = new Map<string, { tone: Tone; n: number }>();
  // Inline-style only: shapes written in a chain (gate "Approve" decision).
  const chainShape = new Map<string, { shape: Shape; n: number }>();
  const shapedByLine = new Set<string>();
  /** Tone (and, inline-style, shape) words after an id in a chain; returns the next index. */
  const chainWords = (toks: Token[], k: number, nid: string, key: string, n: number): number => {
    let tone = false;
    let shape = false;
    for (let w = toks[k]; w?.t === "word"; w = toks[++k]) {
      if (isTone(w.v) && !tone) {
        const prev = chainTone.get(key);
        if (prev && prev.tone !== w.v) fail(n, `node ${nid} is toned ${prev.tone} and ${w.v}: give it one tone`);
        chainTone.set(key, { tone: w.v, n });
        tone = true;
      } else if (inlineStyle && (SHAPES as readonly string[]).includes(w.v) && !shape) {
        const sh = w.v as Shape;
        const prev = chainShape.get(key);
        if (prev && prev.shape !== sh) fail(n, `node ${nid} is shaped ${prev.shape} and ${sh}: give it one shape`);
        chainShape.set(key, { shape: sh, n });
        shape = true;
      } else break;
    }
    return k;
  };
  for (const line of rest) {
    const div = divider(line);
    if (div !== null) {
      if (!div) fail(line.n, "a section needs a label: == Before ==");
      if (sections.some((s) => s.label === div)) fail(line.n, `section "${div}" appears twice`);
      sections.push({ label: div, n: line.n });
      continue;
    }
    const toks = tokenize(line);
    if (toks.length === 0) continue;
    if (isGroupLine(toks)) {
      const ids = toks.slice(2).flatMap((t) => (t.t === "word" ? t.v.split(",").filter(Boolean) : fail(line.n, `group: after its "label", only node ids (group "Label" a b c)`)));
      if (ids.length === 0) fail(line.n, `group "${(toks[1] as { v: string }).v}" names no nodes: group "Label" a b c`);
      if (hasSections && sections.length === 0) fail(line.n, "put the group under a == section == line, with its nodes");
      groupLines.push({ label: (toks[1] as { v: string }).v, ids: ids.map((x) => id({ t: "word", v: x }, line.n, "a node id")), n: line.n, sec: sections.length - 1 });
      continue;
    }
    const first = toks[0]!;
    if (first.t === "word" && first.v === "node") {
      const nid = id(toks[1], line.n, "a node id after node");
      const k0 = key(nid, line.n);
      if (declared.has(k0)) fail(line.n, `node ${nid} is declared twice`);
      let k = 2;
      let label = nid;
      let note: string | undefined;
      if (toks[k]?.t === "str") label = toks[k++]!.v;
      if (toks[k]?.t === "str") note = toks[k++]!.v;
      const mods = modifiers(toks.slice(k), line.n, SHAPES);
      if (mods.word) shapedByLine.add(k0);
      declared.set(k0, { id: k0, label, ...(note ? { note } : {}), shape: mods.word ?? defaultShape, ...(mods.tone ? { tone: mods.tone } : {}) });
      continue;
    }
    // An edge chain: a -> b "label" --> c ...; inline-style: a "A" -> b "B" --> c ...
    const src = id(first, line.n, "node or an edge (a -> b)");
    let from = key(src, line.n);
    used.push(from);
    let k = 1;
    if (toks[k]?.t === "str") {
      if (hasNodeLine(src)) fail(line.n, `${src} has a node line: its label goes there, not after the id`);
      inlineLabel(from, toks[k++]!.v, line.n);
    }
    if (inlineStyle) k = chainWords(toks, k, src, from, line.n);
    if (toks[k]?.t !== "arrow") fail(line.n, toks.length === 1 ? `a lone id: declare it with node ${src} "Label"` : `expected an arrow (-> --> <->) after ${src}`);
    while (k < toks.length) {
      const arrow = toks[k];
      if (arrow?.t !== "arrow") fail(line.n, `expected an arrow (-> --> <->), found ${arrow?.v}`);
      const dst = id(toks[k + 1], line.n, "a target id after the arrow");
      const to = key(dst, line.n);
      used.push(to);
      k += 2;
      let label: string | undefined;
      if (inlineStyle && !hasNodeLine(dst)) {
        // The first string labels the node if it has none yet (or repeats its label); the next is the edge's.
        const s1 = toks[k];
        if (s1?.t === "str" && (!inline.has(to) || inline.get(to) === s1.v)) {
          inlineLabel(to, s1.v, line.n);
          k++;
        }
        if (toks[k]?.t === "str") label = toks[k++]!.v;
      } else if (toks[k]?.t === "str") label = toks[k++]!.v;
      k = chainWords(toks, k, dst, to, line.n);
      const stray = toks[k];
      if (stray && stray.t !== "arrow") fail(line.n, `unexpected ${stray.v} after ${dst}`);
      const a = (arrow as { v: Arrow }).v;
      spec.edges.push({ from, to, ...(label ? { label } : {}), dashed: a === "-->" || a === "<-->", both: a.startsWith("<") });
      edgeHome.push(sections.length - 1);
      from = to;
    }
  }
  for (const [k, { tone, n }] of chainTone) {
    const node = declared.get(k);
    if (node?.tone && node.tone !== tone) fail(n, `node ${written.get(k)} is toned ${node.tone} on its node line and ${tone} in an edge chain: give it one tone`);
  }
  for (const [k, { shape, n }] of chainShape) {
    const node = declared.get(k);
    if (!node) continue;
    if (shapedByLine.has(k) && node.shape !== shape) fail(n, `node ${written.get(k)} is shaped ${node.shape} on its node line and ${shape} in an edge chain: give it one shape`);
    node.shape = shape;
  }
  for (const node of declared.values()) spec.nodes.push(node);
  for (const u of used) {
    if (declared.has(u)) continue;
    const node: FlowNode = { id: u, label: inline.get(u) ?? written.get(u)!, shape: chainShape.get(u)?.shape ?? defaultShape };
    const tone = chainTone.get(u)?.tone;
    if (tone) node.tone = tone;
    declared.set(u, node);
    spec.nodes.push(node);
  }
  for (const node of spec.nodes) if (!node.tone && chainTone.has(node.id)) node.tone = chainTone.get(node.id)!.tone;
  if (spec.nodes.length === 0) fail(0, "nothing to draw: add nodes and edges (a -> b)");
  if (spec.nodes.length > MAX_NODES) fail(0, `${spec.nodes.length} nodes; at most ${MAX_NODES}: split it, or summarise`);
  if (spec.edges.length > MAX_EDGES) fail(0, `${spec.edges.length} edges; at most ${MAX_EDGES}`);
  if (hasSections) {
    if (sections.length > MAX_SECTIONS) fail(sections[MAX_SECTIONS]!.n, `${sections.length} sections; at most ${MAX_SECTIONS}`);
    spec.sections = sections.map((sec, i) => {
      const nodes = spec.nodes.filter((n) => home.get(n.id) === i);
      if (nodes.length === 0) fail(sec.n, `section "${sec.label}" is empty: give it nodes, or drop the line`);
      return { label: sec.label, nodes, edges: spec.edges.filter((_, e) => edgeHome[e] === i) };
    });
  }
  if (groupLines.length) {
    if (groupLines.length > MAX_GROUPS) fail(groupLines[MAX_GROUPS]!.n, `${groupLines.length} groups; at most ${MAX_GROUPS}`);
    const inGroup = new Map<string, string>();
    const groups = groupLines.map((g) => {
      const nodes = g.ids.map((nid) => {
        const k = scoped.get(`${g.sec}\0${nid}`);
        if (k === undefined) fail(g.n, `group "${g.label}": no node ${nid}${hasSections ? " in this section" : ""}`);
        const prev = inGroup.get(k!);
        if (prev !== undefined) fail(g.n, `node ${nid} is in group "${prev}" and "${g.label}": a node sits in one group`);
        inGroup.set(k!, g.label);
        return k!;
      });
      return { label: text(g.label, g.n), nodes, sec: g.sec };
    });
    if (spec.sections) spec.sections.forEach((s, i) => { const gs = groups.filter((g) => g.sec === i).map(({ label, nodes }) => ({ label, nodes })); if (gs.length) s.groups = gs; });
    spec.groups = groups.map(({ label, nodes }) => ({ label, nodes }));
  }
  applyMarks(spec, marks, byIdOrLabel(spec.nodes.map((n) => ({ key: n.id, id: n.id, label: n.label }))), "node");
  return spec;
}

/** ```vis flow: boxes default to box. */
export const parseFlow = (body: string) => parseFlowLines(lines(body), "box");
/** ```vis state: a flow whose nodes default to round (states), with start/end dots available. */
export const parseState = (body: string) => parseFlowLines(lines(body), "round");
