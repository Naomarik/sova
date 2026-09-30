/** `vis tree`: an indented (or tree-drawn) hierarchy with notes and tones. */

import { applyMarks, takeMarks } from "../../core/emphasis";
import { fail, isTone, lines, modifiers, takeSettings, text, tokenize, VisError, type Tone, type VisBase } from "../../core/grammar";

export interface TreeNode {
  /** Its path of child indexes, "0.2.1": the emphasis key. */
  key: string;
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


const TREE_ART = /^((?:[│|] {3}| {4})*)([├└`]── ?)/;

export function parseTree(body: string): TreeSpec {
  const ls = lines(body);
  const spec: TreeSpec = { kind: "tree", roots: [] };
  const { rest: settled } = takeSettings(ls, [], spec);
  // `mark "Photos"/`: the folder's slash inside the quotes, as on an item line (§chat.markdown/vis-lenience-content).
  const slashIn = (t: string) => t.replace(/("(?:[^"\\]|\\.)*)"\/(?=[\s,]|$)/g, '$1/"');
  const { rest, marks } = takeMarks(settled.map((l) => (/^mark\s/.test(l.raw) ? { ...l, raw: slashIn(l.raw), text: slashIn(l.text) } : l)));
  if (rest.length === 0) fail(0, "nothing to draw");
  if (rest.length > MAX_ROWS) fail(0, `${rest.length} rows; at most ${MAX_ROWS}`);
  const art = rest.some((l) => TREE_ART.test(l.raw));
  // `loose`: each line a child of the nearest less-indented line above it, when the indentation
  // doesn't read as multiples of the first indent (§chat.markdown/vis-lenience-content).
  const build = (loose: boolean): TreeNode[] => {
    const roots: TreeNode[] = [];
    let unit = 0;
    const stack: TreeNode[] = [];
    const indents: number[] = [];
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
      } else if (loose) {
        const indent = /^ */.exec(line.raw.replace(/\t/g, "  "))![0].length;
        let d = indents.length;
        while (d > 0 && indents[d - 1]! >= indent) d--;
        indents.length = d;
        indents.push(indent);
        depth = d;
        content = line.text;
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
      if (depth === 0) roots.push(node);
      else stack[depth - 1]!.children.push(node);
      stack.push(node);
    }
    return roots;
  };
  try {
    spec.roots = build(false);
  } catch (e) {
    if (!(e instanceof VisError) || art) throw e;
    try {
      spec.roots = build(true);
    } catch {
      throw e;
    }
  }
  const walk = (ns: TreeNode[], prefix: string) => ns.forEach((n, i) => {
    n.key = `${prefix}${i}`;
    walk(n.children, `${n.key}.`);
  });
  walk(spec.roots, "");
  // A name as written, else the one item it names with a trailing `/` added or removed (`mark src` for `src/`).
  const all = flatTree(spec.roots);
  applyMarks(spec, marks, (t) => {
    if (t.t === "range") return null;
    const exact = all.find((n) => n.name === t.text);
    if (exact) return exact.key;
    const other = all.filter((n) => n.name === `${t.text}/` || `${n.name}/` === t.text);
    return other.length === 1 ? other[0]!.key : null;
  }, "item");
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
    // `"Docs"/` is the folder `Docs/`: a lone slash right after the quote has one reading.
    if (/^\/(\s|$)/.test(restText)) {
      if (!name.endsWith("/")) name += "/";
      restText = restText.slice(1).trim();
    } else if (restText.startsWith("/")) fail(n, `put the / inside the quotes: "${name}/"${restText.slice(1)}`);
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
  const node: TreeNode = { key: "", name: text(name, n), children: [] };
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

/** Every node, depth first. */
export const flatTree = (ns: TreeNode[]): TreeNode[] => ns.flatMap((n) => [n, ...flatTree(n.children)]);
