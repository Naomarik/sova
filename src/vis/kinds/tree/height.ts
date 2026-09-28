/**
 * `vis tree`: the drawing's height at a given `.vis-body` content width, before the View draws, so
 * the figure can reserve its space. It repeats tree.css's fixed geometry (keep the two in step):
 * 22px lines, rows padded 2px × 4px, 20px of indent per level; the name, then the note on the same
 * line when it fits, else below it. Pure: no DOM.
 */

import { emphasisMap } from "../../core/emphasis";
import type { Emphasis } from "../../core/grammar";
import { looksLikePath, wrap } from "../../core/text";
import { htmlMeasure, type WeightedMeasure } from "./measure";
import type { TreeNode, TreeSpec } from "./parse";

const LINE = 22;
const INDENT = 20;
const NAME_PX = 14.5;
const NOTE_PX = 12.5;
const GAP = 8;
const BADGE = 18 + GAP;

export function estimateHeight(spec: TreeSpec, width: number, measure: WeightedMeasure = htmlMeasure): number {
  const em = emphasisMap(spec);
  let h = 0;
  const walk = (ns: TreeNode[], depth: number) => {
    for (const n of ns) {
      h += 4 + LINE * rowLines(n, width - INDENT * depth - 8, em.get(n.key), measure);
      walk(n.children, depth + 1);
    }
  };
  walk(spec.roots, 0);
  return Math.ceil(h);
}

function rowLines(n: TreeNode, avail: number, e: Emphasis | undefined, measure: WeightedMeasure): number {
  const badged = e?.n !== undefined;
  const room = Math.max(1, avail - (badged ? BADGE : 0));
  const mono = looksLikePath(n.name) || n.name.endsWith("/");
  const px = mono ? 12.5 : NAME_PX;
  // A marked name is semibold; others medium. Notes are regular.
  const name = measure(e ? 600 : 530);
  const note = measure(400);
  const nameLines = wrap(n.name, room, 99, px, name, mono).length;
  if (!n.note) return nameLines;
  const nameW = name(n.name, px, mono);
  const noteW = note(n.note, NOTE_PX);
  if (nameLines === 1 && nameW + GAP + noteW <= room) return 1;
  return nameLines + wrap(n.note, Math.max(1, avail), 99, NOTE_PX, note).length;
}
