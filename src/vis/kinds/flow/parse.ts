/** `vis flow` and `vis state`: nodes, edges, shapes and tones. See vis-mode.md § flow for the syntax the model is taught. */

import { applyMarks, byIdOrLabel, takeMarks } from "../../core/emphasis";
import { fail, id, lines, modifiers, takeSettings, tokenize, type Arrow, type Line, type Tone, type VisBase } from "../../core/grammar";

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
}

const MAX_NODES = 30;
const MAX_EDGES = 48;


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
  for (const line of rest) {
    const toks = tokenize(line);
    if (toks.length === 0) continue;
    const first = toks[0]!;
    if (first.t === "word" && first.v === "node") {
      const nid = id(toks[1], line.n, "a node id after node");
      if (declared.has(nid)) fail(line.n, `node ${nid} is declared twice`);
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
      k += 2;
      let label: string | undefined;
      if (toks[k]?.t === "str") label = toks[k++]!.v;
      if (toks[k] && toks[k]!.t !== "arrow") fail(line.n, `unexpected ${toks[k]!.v} after ${to}`);
      const a = (arrow as { v: Arrow }).v;
      spec.edges.push({ from, to, ...(label ? { label } : {}), dashed: a === "-->" || a === "<-->", both: a.startsWith("<") });
      from = to;
    }
  }
  for (const node of declared.values()) spec.nodes.push(node);
  for (const u of used) {
    if (declared.has(u)) continue;
    const node: FlowNode = { id: u, label: u, shape: defaultShape };
    declared.set(u, node);
    spec.nodes.push(node);
  }
  if (spec.nodes.length === 0) fail(0, "nothing to draw: add nodes and edges (a -> b)");
  if (spec.nodes.length > MAX_NODES) fail(0, `${spec.nodes.length} nodes; at most ${MAX_NODES}: split it, or summarise`);
  if (spec.edges.length > MAX_EDGES) fail(0, `${spec.edges.length} edges; at most ${MAX_EDGES}`);
  applyMarks(spec, marks, byIdOrLabel(spec.nodes.map((n) => ({ key: n.id, id: n.id, label: n.label }))), "node");
  return spec;
}

/** ```vis flow: boxes default to box. */
export const parseFlow = (body: string) => parseFlowLines(lines(body), "box");
/** ```vis state: a flow whose nodes default to round (states), with start/end dots available. */
export const parseState = (body: string) => parseFlowLines(lines(body), "round");
