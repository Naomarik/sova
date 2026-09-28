/** `vis tree`: an indented (or tree-drawn) hierarchy with notes and tones. */

import { commaList, divider, fail, fields, id, isTone, lines, MAX_TEXT, modifiers, popTone, takeSettings, text, tokenize, unquote, type Arrow, type Line, type Tone, type VisBase } from "../../core/grammar";

export interface TreeNode {
  name: string;
  note?: string;
  tone?: Tone;
  children: TreeNode[];
}
export interface TreeSpec extends VisBase {
  kind: "tree";
  roots: TreeNode[];
}


const MAX_ROWS = 80;

// ---- tree --------------------------------------------------------------------------------

const TREE_ART = /^((?:[│|] {3}| {4})*)([├└`]── ?)/;

export function parseTree(body: string): TreeSpec {
  const ls = lines(body);
  const spec: TreeSpec = { kind: "tree", roots: [] };
  const { rest } = takeSettings(ls, [], spec);
  if (rest.length === 0) fail(0, "nothing to draw");
  if (rest.length > MAX_ROWS) fail(0, `${rest.length} rows; at most ${MAX_ROWS}`);
  const art = rest.some((l) => TREE_ART.test(l.raw));
  let unit = 0;
  const stack: TreeNode[] = [];
  for (const line of rest) {
    let depth: number;
    let content: string;
    if (art) {
      const m = TREE_ART.exec(line.raw);
      if (m) {
        depth = m[1]!.length / 4 + 1;
        content = line.raw.slice(m[0].length);
      } else {
        if (/^\s/.test(line.raw)) fail(line.n, "mixes tree-drawing lines with indented ones");
        depth = 0;
        content = line.raw;
      }
    } else {
      const indent = /^ */.exec(line.raw.replace(/\t/g, "  "))![0].length;
      if (indent > 0 && unit === 0) unit = indent;
      if (unit > 0 && indent % unit !== 0) fail(line.n, `indent ${indent} is not a multiple of ${unit}`);
      depth = unit ? indent / unit : 0;
      content = line.text;
    }
    if (depth > stack.length) fail(line.n, "indented more than one level past its parent");
    const node = treeNode(content.trim(), line.n);
    stack.length = depth;
    if (depth === 0) spec.roots.push(node);
    else stack[depth - 1]!.children.push(node);
    stack.push(node);
  }
  return spec;
}

function treeNode(s: string, n: number): TreeNode {
  let name: string;
  let restText: string;
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    if (end < 0) fail(n, "unclosed quote");
    name = s.slice(1, end);
    restText = s.slice(end + 1).trim();
  } else {
    const q = s.indexOf('"');
    name = (q < 0 ? s : s.slice(0, q)).trim();
    restText = q < 0 ? "" : s.slice(q);
    // A trailing tone word on an unquoted name with no note: `util.ts accent`.
    if (q < 0) {
      const m = /^(.*\S)\s+(\S+)$/.exec(name);
      if (m && isTone(m[2]!)) {
        name = m[1]!;
        restText = m[2]!;
      }
    }
  }
  const node: TreeNode = { name: text(name, n), children: [] };
  if (restText) {
    const toks = tokenize({ n, raw: restText, text: restText });
    let k = 0;
    if (toks[0]?.t === "str") node.note = toks[k++]!.v;
    const mods = modifiers(toks.slice(k), n);
    if (mods.tone) node.tone = mods.tone;
  }
  if (!node.name) fail(n, "empty name");
  return node;
}
