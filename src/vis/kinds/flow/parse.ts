/**
 * `vis flow` and `vis state`: nodes, edges, shapes and tones. See vis-mode.md § flow for the syntax
 * the model is taught. `== label ==` lines split one fence into panels: independent graphs, each
 * laid out on its own and drawn side by side (./sections.ts). Ids stay unique across the fence.
 */

import { applyMarks, byIdOrLabel, takeMarks } from "../../core/emphasis";
import { divider, fail, id, isTone, lines, modifiers, takeSettings, tokenize, type Arrow, type Line, type Tone, type VisBase } from "../../core/grammar";

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
}
/** One panel: a graph of its own. Every node and edge is in exactly one. */
export interface FlowSection {
  label: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

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
  const declared = new Map<string, FlowNode>();
  const used: string[] = [];
  // Tones written after an edge's target (a -> b "label" error): they colour the target node.
  const chainTone = new Map<string, { tone: Tone; n: number }>();
  // Sections: which one each node belongs to (where it is declared, else first used), and each edge.
  const sections: { label: string; n: number }[] = [];
  const home = new Map<string, number>();
  const edgeHome: number[] = [];
  const hasSections = rest.some((l) => divider(l) !== null);
  const claim = (nid: string, n: number) => {
    const at = sections.length - 1;
    if (!hasSections) return;
    if (at < 0) fail(n, "put the nodes and edges under a == section == line: once a flow has sections, everything drawn belongs to one");
    if (!home.has(nid)) home.set(nid, at);
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
    const first = toks[0]!;
    if (first.t === "word" && first.v === "node") {
      const nid = id(toks[1], line.n, "a node id after node");
      if (declared.has(nid)) fail(line.n, `node ${nid} is declared twice`);
      if (hasSections && home.has(nid) && home.get(nid) !== sections.length - 1) fail(line.n, `node ${nid} is already used in section "${sections[home.get(nid)!]!.label}": ids are unique across the fence`);
      claim(nid, line.n);
      let k = 2;
      let label = nid;
      let note: string | undefined;
      if (toks[k]?.t === "str") label = toks[k++]!.v;
      if (toks[k]?.t === "str") note = toks[k++]!.v;
      const mods = modifiers(toks.slice(k), line.n, SHAPES);
      declared.set(nid, { id: nid, label, ...(note ? { note } : {}), shape: mods.word ?? defaultShape, ...(mods.tone ? { tone: mods.tone } : {}) });
      continue;
    }
    // An edge chain: a -> b "label" --> c ...
    let from = id(first, line.n, "node or an edge (a -> b)");
    used.push(from);
    claim(from, line.n);
    let k = 1;
    if (toks[k]?.t !== "arrow") {
      if (toks[k]?.t === "str") fail(line.n, `to label a node write node ${from} "Label"; edge labels go after the target: a -> b "label"`);
      fail(line.n, toks.length === 1 ? `a lone id: declare it with node ${from} "Label"` : `expected an arrow (-> --> <->) after ${from}`);
    }
    while (k < toks.length) {
      const arrow = toks[k];
      if (arrow?.t !== "arrow") fail(line.n, `expected an arrow (-> --> <->), found ${arrow?.v}`);
      const to = id(toks[k + 1], line.n, "a target id after the arrow");
      used.push(to);
      claim(to, line.n);
      k += 2;
      let label: string | undefined;
      if (toks[k]?.t === "str") label = toks[k++]!.v;
      const toneTok = toks[k];
      if (toneTok?.t === "word" && isTone(toneTok.v)) {
        const tone = toneTok.v as Tone;
        const prev = chainTone.get(to);
        if (prev && prev.tone !== tone) fail(line.n, `node ${to} is toned ${prev.tone} and ${tone}: give it one tone`);
        chainTone.set(to, { tone, n: line.n });
        k++;
      }
      const stray = toks[k];
      if (stray && stray.t !== "arrow") fail(line.n, `unexpected ${stray.v} after ${to}`);
      const a = (arrow as { v: Arrow }).v;
      if (hasSections && (home.get(from) !== sections.length - 1 || home.get(to) !== sections.length - 1)) {
        const other = sections[home.get(from) !== sections.length - 1 ? home.get(from)! : home.get(to)!]!.label;
        fail(line.n, `${from} -> ${to} crosses from section "${other}" to "${sections[sections.length - 1]!.label}": sections are separate drawings, so edges stay inside one`);
      }
      spec.edges.push({ from, to, ...(label ? { label } : {}), dashed: a === "-->" || a === "<-->", both: a.startsWith("<") });
      edgeHome.push(sections.length - 1);
      from = to;
    }
  }
  for (const [nid, { tone, n }] of chainTone) {
    const node = declared.get(nid);
    if (node?.tone && node.tone !== tone) fail(n, `node ${nid} is toned ${node.tone} on its node line and ${tone} in an edge chain: give it one tone`);
  }
  for (const node of declared.values()) spec.nodes.push(node);
  for (const u of used) {
    if (declared.has(u)) continue;
    const node: FlowNode = { id: u, label: u, shape: defaultShape };
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
  applyMarks(spec, marks, byIdOrLabel(spec.nodes.map((n) => ({ key: n.id, id: n.id, label: n.label }))), "node");
  return spec;
}

/** ```vis flow: boxes default to box. */
export const parseFlow = (body: string) => parseFlowLines(lines(body), "box");
/** ```vis state: a flow whose nodes default to round (states), with start/end dots available. */
export const parseState = (body: string) => parseFlowLines(lines(body), "round");
