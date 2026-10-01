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
 * label is not an edge label. Shape and tone words may follow (`gate "Approve" decision`). A second
 * string after a chain's source, before its first arrow, is that node's second line
 * (`a "A" "second" -> b`). A line `a "A" ["second"] [words]` with no arrow is a `node` line without
 * the word: it counts as one for the style too (a string after `a` as a target is the edge's).
 *
 * `group "Label" a b c` (also frame/subgraph/cluster; no arrow on the line) draws a frame around
 * some nodes of one graph (./layout.ts keeps them together); per panel, flat, a node in one at most.
 */

import { applyMarks, byIdOrLabel, takeMarks } from "../../core/emphasis";
import { divider, fail, id, isTone, lines, modifiers, slug, takeSettings, text, tokenize, warn, type Arrow, type Line, type Token, type Tone, type VisBase } from "../../core/grammar";

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
/** `a1 "Label" ["second"] [shape] [tone]` with no arrow: a `node` line without the word (checked after isGroupLine). */
const isDeclLine = (t: Token[]) => t[0]?.t === "word" && t[0].v !== "node" && t[1]?.t === "str" && !t.some((x) => x.t === "arrow");
const isShape = (w: string) => (SHAPES as readonly string[]).includes(w);
/** `node end done`: a shape, then a word that is no tone or shape, so it can only be the id (no arrow on the line). */
const isShapeFirst = (t: Token[]) => t[0]?.t === "word" && t[0].v === "node" && t[1]?.t === "word" && isShape(t[1].v) && t[2]?.t === "word" && !isTone(t[2].v) && !isShape(t[2].v) && !t.some((x) => x.t === "arrow");
/** `node "In progress" [second] [shape] [tone]`: a node line naming its node by label, no arrow. */
const isLabelFirst = (t: Token[]) => t[0]?.t === "word" && t[0].v === "node" && t[1]?.t === "str" && !isNL(t[1]) && t.slice(2).every((x) => x.t === "str" || (x.t === "word" && (isTone(x.v) || isShape(x.v))));

/** Mermaid's dotted arrow `-.->` (tokenized as the word `-.` and `->`) is a dashed edge, `-->`. */
const dotted = (t: Token[]): Token[] =>
  t.flatMap((x, i): Token[] => {
    const next = t[i + 1];
    if (x.t === "word" && (x.v === "-." || x.v === "<-.") && next?.t === "arrow" && next.v === "->") return [{ t: "arrow", v: x.v === "-." ? "-->" : "<-->" }];
    const prev = t[i - 1];
    if (x.t === "arrow" && x.v === "->" && prev?.t === "word" && (prev.v === "-." || prev.v === "<-.")) return [];
    return [x];
  });

/** Words for a shape (§chat.markdown/vis-lenience-content), read where a shape word goes. */
const SHAPE_WORDS: Readonly<Record<string, Shape>> = {
  diamond: "decision", rhombus: "decision", condition: "decision", choice: "decision",
  cylinder: "store", database: "store", db: "store", cache: "store",
  rounded: "round", pill: "round", stadium: "round", oval: "round",
  rect: "box", rectangle: "box", square: "box",
};
const DIRS: Readonly<Record<string, "down" | "right">> = { lr: "right", rl: "right", horizontal: "right", "left-right": "right", across: "right", td: "down", tb: "down", bt: "down", vertical: "down", "top-down": "down" };

/** A node label a Mermaid bracket gave (`A[Label]`): marked inside the string so it labels the node in any style. */
const NL = "\uE000";
/** An edge label written on its arrow (`-->|yes|`, `-- yes -->`) or after a colon (`b: yes`). */
type ELabel = { t: "elabel"; v: string };
type FTok = Token | ELabel;
const BRACKETS: [string, string, Shape | ""][] = [["([", "])", "round"], ["[(", ")]", "store"], ["((", "))", "circle"], ["{{", "}}", ""], ["[", "]", ""], ["(", ")", "round"], ["{", "}", "decision"]];

/**
 * Mermaid's node brackets, outside quotes: `A[Label]` is `A "Label"`, `A{Label}` adds decision, and
 * so on (BRACKETS). Only a line that couldn't be read otherwise has them (an id never holds a bracket).
 */
function brackets(t: string): string {
  let out = "";
  for (let i = 0; i < t.length; ) {
    if (t[i] === '"') {
      const end = t.indexOf('"', i + 1);
      const j = end < 0 ? t.length : end + 1;
      out += t.slice(i, j);
      i = j;
      continue;
    }
    const idm = /^[\p{L}\p{N}_][\p{L}\p{N}\p{M}_.\/-]*/u.exec(t.slice(i));
    const prev = t[i - 1];
    if (idm && (prev === undefined || /[\s>&-]/.test(prev))) {
      const after = i + idm[0].length;
      const b = BRACKETS.find(([open]) => t.startsWith(open, after));
      const close = b ? t.indexOf(b[1], after + b[0].length) : -1;
      if (b && close > after) {
        const inner = t.slice(after + b[0].length, close).trim().replace(/^"(.*)"$/s, "$1").replace(/(?<!\\)"/g, '\\"');
        out += `${idm[0]} "${NL}${inner}"${b[2] ? ` ${b[2]}` : ""}`;
        i = close + b[1].length;
        continue;
      }
      out += idm[0];
      i = after;
      continue;
    }
    out += t[i++];
  }
  return out;
}

/** A line as Mermaid writes it, made readable (§chat.markdown/vis-lenience-content); null to drop it. Only lines that fail as written change. */
function mermaidLine(line: Line, first: boolean, setDir: (d: "down" | "right") => void): Line | null {
  let t = line.text;
  const head = /^(?:graph|flowchart)(?:\s+(TD|TB|BT|LR|RL))?\s*;?$/i.exec(t);
  if (first && head) {
    if (head[1]) setDir(DIRS[head[1].toLowerCase()]!);
    return null;
  }
  if (first && /^stateDiagram(-v2)?\s*$/i.test(t)) return null;
  if (/^(classDef|class|style|linkStyle|click)\s+[^"\s]/.test(t) && !/-->|->|<->/.test(t)) return null;
  if (/^%%/.test(t) || /^direction\s+(TB|TD|BT|LR|RL)\s*$/i.test(t)) return null;
  const st = /^state\s+"((?:[^"\\]|\\.)*)"\s+as\s+(\S+)\s*$/.exec(t);
  if (st) t = `node ${st[2]} "${st[1]}"`;
  if (/;\s*$/.test(t) && (t.match(/(?<!\\)"/g)?.length ?? 0) % 2 === 0) t = t.replace(/\s*;\s*$/, "");
  if (/[\p{L}\p{N}_][[({]/u.test(t)) t = brackets(t);
  return t === line.text ? line : { ...line, raw: t, text: t };
}

/**
 * Token-level Mermaid habits and words, all on tokens today's reading refuses: a string marked by
 * brackets() becomes the node's label; `[*]` a start or end dot; an edge label on its arrow or after
 * a colon moves after the edge's target as an ELabel; a shape word's synonym becomes the shape.
 */
function mermaidTokens(toks: Token[]): FTok[] {
  let t: FTok[] = [...toks];
  // `a -- text --> b`: the text rides the arrow.
  const dashes = t.findIndex((x, i) => i > 0 && x.t === "word" && x.v === "--");
  if (dashes > 0) {
    const arrow = t.findIndex((x, i) => i > dashes && x.t === "arrow");
    if (arrow > dashes + 1 && t[arrow + 1]) {
      const text = t.slice(dashes + 1, arrow).map((x) => x.v).join(" ");
      t = [...t.slice(0, dashes), t[arrow]!, t[arrow + 1]!, { t: "elabel", v: text }, ...t.slice(arrow + 2)];
    }
  }
  // `a -->|text| b`.
  for (let i = 0; i < t.length; i++) {
    const x = t[i]!;
    const next = t[i + 1];
    if (x.t !== "arrow" || next?.t !== "word" || !next.v.startsWith("|")) continue;
    let j = i + 1;
    while (j < t.length && !(t[j]!.t === "word" && t[j]!.v.endsWith("|") && (j > i + 1 || t[j]!.v.length > 1))) j++;
    if (j >= t.length || !t[j + 1]) break;
    const text = t.slice(i + 1, j + 1).map((y) => y.v).join(" ").replace(/^\|\s*|\s*\|$/g, "");
    t = [...t.slice(0, i + 1), t[j + 1]!, { t: "elabel", v: text }, ...t.slice(j + 2)];
  }
  // `a -> b: text` and `b : text`, after the line's last target.
  const last = t.map((x) => x.t).lastIndexOf("arrow");
  const target = t[last + 1];
  if (last >= 0 && target?.t === "word") {
    const glued = target.v.length > 1 && target.v.endsWith(":");
    const sep = t[last + 2]?.t === "word" && (t[last + 2] as { v: string }).v.startsWith(":");
    if (glued || sep) {
      const rest = t.slice(last + 2).map((x) => x.v);
      if (sep) rest[0] = rest[0]!.slice(1);
      const text = rest.join(" ").trim();
      t = [...t.slice(0, last + 1), { t: "word", v: glued ? target.v.slice(0, -1) : target.v }, ...(text ? [{ t: "elabel", v: text } as ELabel] : [])];
    }
  }
  // `[*]`: the start dot as a source, the end dot as a target; synonyms where a shape word goes (a
  // group line holds only ids).
  if (isGroupLine(t as Token[])) return t;
  const out: FTok[] = [];
  t.forEach((x, i) => {
    const prev = t[i - 1];
    const idSpot = i === 0 || prev?.t === "arrow" || (i === 1 && prev?.t === "word" && prev.v === "node");
    if (x.t === "word" && x.v === "[*]") out.push(...(i === 0 ? [{ t: "word", v: "__start" }, { t: "word", v: "start" }] : [{ t: "word", v: "__end" }, { t: "word", v: "end" }]) as FTok[]);
    else if (x.t === "word" && !idSpot && Object.hasOwn(SHAPE_WORDS, x.v.toLowerCase())) out.push({ t: "word", v: SHAPE_WORDS[x.v.toLowerCase()]! });
    else out.push(x);
  });
  return out;
}
/** A string brackets() marked: the node's label, whatever the fence's style. */
const isNL = (x: FTok | undefined): boolean => x?.t === "str" && x.v.startsWith(NL);
const nlText = (x: { v: string }) => x.v.slice(NL.length);

/** Labels that are just the dot's own name: `node s0 start "Start"` stays a dot. */
const DOT_WORDS = /^(start|begin|end|done|finish|stop)$/i;

const MAX_NODES = 30;
const MAX_EDGES = 48;
const MAX_SECTIONS = 4;


function parseFlowLines(ls: Line[], defaultShape: Shape): FlowSpec {
  const spec: FlowSpec = { kind: "flow", dir: "down", nodes: [], edges: [] };
  const { rest: settled, values } = takeSettings(ls, ["dir"], spec, { caseless: true, aliases: { direction: "dir" } });
  const { rest: marked, marks } = takeMarks(settled);
  const dir = values.get("dir");
  if (dir) {
    const d = dir.value === "down" || dir.value === "right" ? dir.value : DIRS[dir.value.toLowerCase()];
    if (!d) fail(dir.n, `dir: is down or right, not "${dir.value}"`);
    spec.dir = d!;
  }
  // Mermaid's lines, made readable or dropped (a `graph LR` head sets dir: unless dir: is set).
  const rest = marked.flatMap((l, i) => {
    const m = mermaidLine(l, i === 0, (d) => {
      if (!dir) spec.dir = d;
    });
    return m ? [m] : [];
  });
  const toksOf = (line: Line): FTok[] => mermaidTokens(dotted(tokenize(line, { wide: true })));
  const hasSections = rest.some((l) => divider(l) !== null);
  // A pre-pass for the label style: which ids have a `node` line (per panel), and whether any chain
  // line carries a string right after its source. A line it can't read is left to the main loop.
  const nodeLines = new Set<string>();
  let inlineStyle = false;
  let at = -1;
  // Ids written in chains, and `node end done` lines (shape first), per panel.
  const chainIds = new Set<string>();
  const shapeFirst: { line: Line; at: number; shape: string; nid: string }[] = [];
  for (const line of rest) {
    if (divider(line) !== null) {
      at++;
      continue;
    }
    let t: Token[];
    try {
      t = toksOf(line) as Token[];
    } catch {
      continue;
    }
    if (t[0]?.t !== "word" || isGroupLine(t)) continue;
    if (t[0].v === "node" && t[1]?.t !== "arrow") {
      if (isShapeFirst(t)) shapeFirst.push({ line, at, shape: (t[1] as { v: string }).v, nid: (t[2] as { v: string }).v });
      else if (t[1]?.t === "word") nodeLines.add(`${at}\0${t[1].v}`);
    } else if (isDeclLine(t)) nodeLines.add(`${at}\0${t[0].v}`);
    // A bracket's label (`A[Label]`) labels its node in either style, so it sets neither.
    else if (t[1]?.t === "str" && !isNL(t[1])) inlineStyle = true;
    if (t[0].v === "node" && t[1]?.t !== "arrow") continue;
    t.forEach((x, i) => {
      if (x.t === "word" && (i === 0 || t[i - 1]?.t === "arrow")) chainIds.add(`${at}\0${x.v}`);
    });
  }
  // `node end done` is `node done end` when nothing else names `end` as a node (§chat.markdown/vis-lenience-content).
  const swapped = new Set<Line>();
  for (const s of shapeFirst) {
    const named = (x: string) => chainIds.has(`${s.at}\0${x}`) || nodeLines.has(`${s.at}\0${x}`);
    if (named(s.shape)) nodeLines.add(`${s.at}\0${s.shape}`);
    else {
      swapped.add(s.line);
      nodeLines.add(`${s.at}\0${s.nid}`);
    }
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
  // A chain source's second string (a "A" "second line" -> b): the node's note, by key.
  const inlineNote = new Map<string, string>();
  const inlineLabel = (k: string, v: string, n: number) => {
    const prev = inline.get(k);
    if (prev === undefined) inline.set(k, v);
    else if (prev !== v) warn(n, `node ${written.get(k)} is labelled "${prev}" and "${v}": kept "${prev}"`);
  };
  // A "label" where an id belongs (`"Browser" -> "API"`): the node with that label in this panel, else
  // a new one whose id is made from it.
  const nodeByLabel = (label: string, n: number): string => {
    const sec = sections.length - 1;
    for (const [k, v] of inline) if (v === label && home.get(k) === sec) return written.get(k)!;
    for (const [k, node] of declared) if (node.label === label && home.get(k) === sec) return written.get(k)!;
    const sid = slug(label, (x) => scoped.has(`${sec}\0${x}`) || nodeLines.has(`${sec}\0${x}`));
    inlineLabel(key(sid, n), label, n);
    return sid;
  };
  // Tones written after an edge's target (a -> b "label" error): they colour the target node.
  const chainTone = new Map<string, { tone: Tone; n: number }>();
  // Shapes written in a chain (gate "Approve" decision, delivered -> done end).
  const chainShape = new Map<string, { shape: Shape; n: number }>();
  const branches: { key: string; label: string; edge: number; n: number; nodeLine: boolean }[] = [];
  const shapedByLine = new Set<string>();
  /** Tone and shape words after an id in a chain; returns the next index. */
  const chainWords = (toks: Token[], k: number, nid: string, key: string, n: number): number => {
    let tone = false;
    let shape = false;
    for (let w = toks[k]; w?.t === "word"; w = toks[++k]) {
      if (isTone(w.v) && !tone) {
        // A second, different tone keeps the first (§chat.markdown/vis-lenience-content).
        const prev = chainTone.get(key);
        if (prev && prev.tone !== w.v) warn(n, `node ${nid} is toned ${prev.tone} and ${w.v}: kept ${prev.tone}`);
        else chainTone.set(key, { tone: w.v, n });
        tone = true;
      } else if ((SHAPES as readonly string[]).includes(w.v) && !shape) {
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
    const toks = toksOf(line) as Token[];
    if (toks.length === 0) continue;
    if (isGroupLine(toks)) {
      const ids = toks.slice(2).flatMap((t) => (t.t === "word" ? t.v.split(",").filter(Boolean) : fail(line.n, `group: after its "label", only node ids (group "Label" a b c)`)));
      if (ids.length === 0) fail(line.n, `group "${(toks[1] as { v: string }).v}" names no nodes: group "Label" a b c`);
      if (hasSections && sections.length === 0) fail(line.n, "put the group under a == section == line, with its nodes");
      groupLines.push({ label: (toks[1] as { v: string }).v, ids: ids.map((x) => id({ t: "word", v: x }, line.n, "a node id")), n: line.n, sec: sections.length - 1 });
      continue;
    }
    const first = toks[0]!;
    // `node a "A"`, or the same without the word (`a "A" round`, no arrow on the line).
    // `node -> db` is a chain from a node whose id is node.
    const idAt = first.t === "word" && first.v === "node" && toks[1]?.t !== "arrow" ? 1 : isDeclLine(toks) ? 0 : -1;
    if (idAt >= 0) {
      // `node end done` is `node done end`; `node "In progress"` names its node by label, as a chain does.
      if (swapped.has(line)) [toks[1], toks[2]] = [toks[2]!, toks[1]!];
      else if (idAt === 1 && isLabelFirst(toks)) {
        const sid = nodeByLabel((toks[1] as { v: string }).v, line.n);
        nodeLines.add(`${sections.length - 1}\0${sid}`);
        toks.splice(1, 0, { t: "word", v: sid });
      }
      const nid = id(toks[idAt], line.n, "a node id after node");
      const k0 = key(nid, line.n);
      const again = declared.get(k0);
      let label = nid;
      let note: string | undefined;
      // Strings (the label, then a second line) and words (shape, tone), strings first or after the words.
      const strs = toks.slice(idAt + 1).filter((t) => t.t === "str");
      const words = toks.slice(idAt + 1).filter((t) => t.t !== "str");
      if (strs.length > 2) fail(line.n, `unexpected "${strs[2]!.v}"`);
      if (strs[0]) label = isNL(strs[0]) ? nlText(strs[0]) : strs[0].v;
      if (strs[1]) note = strs[1].v;
      const mods = modifiers(words, line.n, SHAPES);
      if (again) {
        // The same `node` line written again is that node (§chat.markdown/vis-lenience-content).
        const same = again.label === label && again.note === note && again.shape === (mods.word ?? defaultShape) && again.tone === mods.tone && shapedByLine.has(k0) === !!mods.word;
        if (!same) fail(line.n, `node ${nid} is declared twice`);
        continue;
      }
      if (mods.word) shapedByLine.add(k0);
      declared.set(k0, { id: k0, label, ...(note ? { note } : {}), shape: mods.word ?? defaultShape, ...(mods.tone ? { tone: mods.tone } : {}) });
      continue;
    }
    // An edge chain: a -> b "label" --> c ...; inline-style: a "A" -> b "B" --> c ...
    if (first.t === "str" && !isNL(first)) toks[0] = { t: "word", v: nodeByLabel(first.v, line.n) };
    const src = id(toks[0], line.n, "node or an edge (a -> b)");
    let from = key(src, line.n);
    used.push(from);
    let k = 1;
    // A string after a source labelled otherwise already, when it may be a decision's branch
    // (`days "yes" -> damaged`): settled once shapes are known, below.
    let branch: string | undefined;
    const labelOf = (key: string) => inline.get(key) ?? declared.get(key)?.label;
    if (toks[k]?.t === "str" && !isNL(toks[k]) && toks[k + 1]?.t !== "str" && labelOf(from) !== undefined && labelOf(from) !== toks[k]!.v && (!hasNodeLine(src) || declared.get(from)?.shape === "decision")) branch = (toks[k++] as { v: string }).v;
    else if (toks[k]?.t === "str") {
      if (hasNodeLine(src)) fail(line.n, `${src} has a node line: its label goes there, not after the id`);
      const tok = toks[k++]!;
      const label = isNL(tok) ? nlText(tok) : tok.v;
      inlineLabel(from, label, line.n);
      // Before the first arrow a second string can't be an edge's: it is the node's second line.
      if (toks[k]?.t === "str") {
        const note = toks[k++]!.v;
        if (toks[k]?.t === "str") {
          const arrow = toks.findIndex((t) => t.t === "arrow");
          const to = arrow < 0 ? "" : ` ${toks[arrow]!.v} ${toks[arrow + 1]?.t === "word" ? toks[arrow + 1]!.v : "…"}`;
          fail(line.n, `${src} takes a label and one second line before its arrow: ${src} "${label}" "${note}"${to}`);
        }
        const prev = inlineNote.get(from);
        if (prev === undefined) inlineNote.set(from, note);
        else if (prev !== note) warn(line.n, `node ${src} has the second lines "${prev}" and "${note}": kept "${prev}"`);
      }
    }
    k = chainWords(toks, k, src, from, line.n);
    if (toks[k]?.t !== "arrow") fail(line.n, toks.length === 1 ? `a lone id: declare it with node ${src} "Label"` : `expected an arrow (-> --> <->) after ${src}`);
    if (branch !== undefined) branches.push({ key: from, label: branch, edge: spec.edges.length, n: line.n, nodeLine: hasNodeLine(src) });
    while (k < toks.length) {
      const arrow = toks[k];
      if (arrow?.t !== "arrow") fail(line.n, `expected an arrow (-> --> <->), found ${arrow?.v}`);
      const target = toks[k + 1];
      if (target?.t === "str" && !isNL(target)) toks[k + 1] = { t: "word", v: nodeByLabel(target.v, line.n) };
      const dst = id(toks[k + 1], line.n, "a target id after the arrow");
      const to = key(dst, line.n);
      used.push(to);
      const dstAt = k + 1;
      k += 2;
      let label: string | undefined;
      let named = false;
      // A bracket's label and an edge label written on the arrow or after a colon, in either order.
      let fixed: string | undefined;
      for (let x = toks[k] as FTok | undefined; x && (isNL(x) || x.t === "elabel"); x = toks[++k] as FTok | undefined) {
        if (x.t === "elabel") fixed = x.v;
        else {
          inlineLabel(to, nlText(x), line.n);
          named = true;
        }
      }
      if (fixed !== undefined) {
        label = fixed;
        // A string after the target then labels it, when it can (`a -->|yes| b "B"`).
        const s1 = toks[k];
        if (!named && s1?.t === "str" && !hasNodeLine(dst) && (!inline.has(to) || inline.get(to) === s1.v)) {
          inlineLabel(to, s1.v, line.n);
          named = true;
          k++;
        }
      } else if (inlineStyle && !hasNodeLine(dst)) {
        // The first string labels the node if it has none yet (or repeats its label); the next is the edge's.
        const s1 = toks[k];
        if (s1?.t === "str" && (!inline.has(to) || inline.get(to) === s1.v)) {
          inlineLabel(to, s1.v, line.n);
          named = true;
          k++;
        }
        if (toks[k]?.t === "str") label = toks[k++]!.v;
      } else if (toks[k]?.t === "str") label = toks[k++]!.v;
      // A target labelled already (earlier inline, or by its node line): a second string is the
      // edge's too, its label's second line (`-> api "Notify completion" "POST /confirm"`).
      if (label !== undefined && fixed === undefined && !named && (inlineStyle || hasNodeLine(dst)) && toks[k]?.t === "str" && toks[k + 1]?.t !== "str") label = `${label}\n${toks[k++]!.v}`;
      const strings = k;
      k = chainWords(toks, k, dst, to, line.n);
      // A string after the words, with no edge label yet, when it can't be the target's label (the
      // target is labelled already, or strings after targets are edge labels): the edge's.
      if (k > strings && label === undefined && (inline.has(to) || hasNodeLine(dst) || !inlineStyle) && toks[k]?.t === "str" && toks[k + 1]?.t !== "str") {
        label = toks[k++]!.v;
        k = chainWords(toks, k, dst, to, line.n);
      }
      // `dashed` or `dotted` after the target's strings and words: the edge is dashed (§chat.markdown/vis-lenience-content).
      let dashedWord = false;
      while (toks[k]?.t === "word" && /^(dashed|dotted)$/.test((toks[k] as { v: string }).v)) {
        dashedWord = true;
        k = chainWords(toks, k + 1, dst, to, line.n);
      }
      const stray = toks[k];
      if (stray?.t === "str") {
        // Say what to write instead, quoting the target as it should read.
        const head = `unexpected "${stray.v}" after ${dst}`;
        const q = (s: string) => `"${s.replace(/\n/g, "\\n")}"`;
        const arrowV = (arrow as { v: Arrow }).v;
        if (k > strings) {
          const strs = toks.slice(dstAt + 1, strings).map((t) => q(t.v));
          const words = toks.slice(strings, k).map((t) => t.v);
          fail(line.n, `${head}: strings go before shape and tone words: ${arrowV} ${[dst, ...strs, q(stray.v), ...words].join(" ")}`);
        }
        if (named) fail(line.n, `${head}: one label and one edge label per target; for a second line use node ${dst} ${q(inline.get(to)!)} ${q(stray.v)}`);
        const already = inlineStyle && !hasNodeLine(dst) ? `${dst} is labelled ${q(inline.get(to)!)} already, so ${q(label!)} labels the edge; ` : "";
        fail(line.n, `${head}: ${already}one string per edge label (\\n breaks a line): ${arrowV} ${dst} ${q(`${label}\n${stray.v}`)}`);
      }
      if (stray && stray.t !== "arrow") fail(line.n, `unexpected ${stray.v} after ${dst}`);
      const a = (arrow as { v: Arrow }).v;
      spec.edges.push({ from, to, ...(label ? { label } : {}), dashed: dashedWord || a === "-->" || a === "<-->", both: a.startsWith("<") });
      edgeHome.push(sections.length - 1);
      from = to;
    }
  }
  for (const [k, { tone, n }] of chainTone) {
    const node = declared.get(k);
    if (node?.tone && node.tone !== tone) warn(n, `node ${written.get(k)} is toned ${node.tone} and ${tone}: kept ${node.tone}`);
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
    const note = inlineNote.get(u);
    const node: FlowNode = { id: u, label: inline.get(u) ?? written.get(u)!, ...(note ? { note } : {}), shape: chainShape.get(u)?.shape ?? defaultShape };
    const tone = chainTone.get(u)?.tone;
    if (tone) node.tone = tone;
    declared.set(u, node);
    spec.nodes.push(node);
  }
  for (const node of spec.nodes) if (!node.tone && chainTone.has(node.id)) node.tone = chainTone.get(node.id)!.tone;
  // A decision's branch string labels the line's first edge when that has no label; otherwise it is
  // a second label for the node, dropped as ever (§chat.markdown/vis-lenience-content).
  for (const b of branches) {
    const edge = spec.edges[b.edge]!;
    if (declared.get(b.key)?.shape === "decision" && edge.label === undefined) edge.label = b.label;
    else if (b.nodeLine) fail(b.n, `${written.get(b.key)} has a node line: its label goes there, not after the id`);
    else warn(b.n, `node ${written.get(b.key)} is labelled "${inline.get(b.key)}" and "${b.label}": kept "${inline.get(b.key)}"`);
  }
  // A start or end dot with a label of its own (`node pending start "Pending payment"`): the state
  // it names, round, with its own unlabelled dot and an edge between them.
  for (const node of [...spec.nodes]) {
    if ((node.shape !== "start" && node.shape !== "end") || node.label === written.get(node.id) || DOT_WORDS.test(node.label)) continue;
    const shape = node.shape;
    const dot = `${node.id}:${shape}`;
    node.shape = "round";
    spec.nodes.splice(spec.nodes.indexOf(node) + (shape === "end" ? 1 : 0), 0, { id: dot, label: "", shape });
    home.set(dot, home.get(node.id)!);
    spec.edges.push(shape === "start" ? { from: dot, to: node.id, dashed: false, both: false } : { from: node.id, to: dot, dashed: false, both: false });
    edgeHome.push(home.get(node.id)!);
  }
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
  // A number or range names a node whose id it is (`mark 1`).
  const byNode = byIdOrLabel(spec.nodes.map((n) => ({ key: n.id, id: n.id, label: n.label })));
  applyMarks(spec, marks, (t) => byNode(t.t === "number" || t.t === "range" ? { t: "id", text: t.text } : t), "node");
  return spec;
}

/** ```vis flow: boxes default to box. */
export const parseFlow = (body: string) => parseFlowLines(lines(body), "box");
/** ```vis state: a flow whose nodes default to round (states), with start/end dots available. */
export const parseState = (body: string) => parseFlowLines(lines(body), "round");
