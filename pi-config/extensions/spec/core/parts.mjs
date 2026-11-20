// Split topics: a claim cut into parts reads as one topic again. The views that rank or group claims (topic search,
// name and file lookups, the census's ranking, toc's down) ask here which claims are a topic's parts.
// Node stdlib only; computed from the parsed graph, once per graph, never stored.
import { mask, titleOf } from "./toc.mjs";

// One line of a summary: "- §part — the part's own heading title".
const SUMMARY_LINE = /^- (§[a-z][a-z0-9./-]*[a-z0-9]) — (.+?)\s*$/;
const MIN_PARTS = 2;

// A topic's summary: the bullets that end its prose, outside fenced code and HTML comments, in order.
// → [{id, title, line}] (line: 0-based within the declaration's text), [] when its prose ends otherwise.
export function summaryOf(decl) {
  const lines = mask(decl.text, { doubleTicks: false, heading: true }).split("\n");
  let k = lines.length - 1;
  while (k > 0 && !lines[k].trim()) k--;
  const out = [];
  for (; k > 0; k--) {
    const m = SUMMARY_LINE.exec(lines[k]);
    if (!m) break;
    out.unshift({ id: m[1], title: m[2], line: k });
  }
  return out;
}

const cache = new WeakMap();
// A claim is a split topic when its prose ends in a summary of at least two parts, and each part is a claim declared
// right after it in the same file, in the summary's order, as an H2, that it requires, whose heading the summary
// line repeats word for word, and that is no topic of its own. A summary line naming the claim declared right after
// it, in a list that breaks any of these, is a broken summary: the claim and those claims stay claims of their own.
// → {up: Map(part → topic), down: Map(topic → [parts]), broken: [{id, why}]}
export function splitOf(ctx) {
  let s = cache.get(ctx);
  if (s) return s;
  const byFile = new Map();
  for (const [id, d] of ctx.decls) byFile.set(d.file, [...(byFile.get(d.file) ?? []), id]);
  for (const ids of byFile.values()) ids.sort((a, b) => ctx.decls.get(a).line - ctx.decls.get(b).line);
  const after = (id, n) => { const ids = byFile.get(ctx.decls.get(id).file), i = ids.indexOf(id); return ids.slice(i + 1, i + 1 + n); };
  const found = new Map(), broken = [];
  for (const id of [...ctx.decls.keys()].sort()) {
    const d = ctx.decls.get(id), rec = ctx.claims.get(id);
    // No line could be a summary's: nothing to mask.
    if (!rec || !d.text.includes("\n- §")) continue;
    const sum = summaryOf(d), first = after(id, 1)[0];
    if (!sum.length || first !== sum[0].id) {
      // The claim declared next is listed, but not first in a list that ends the prose: out of order, or prose follows.
      if (first && sum.some((p) => p.id === first)) broken.push({ id, why: `its summary does not list ${first}, the claim declared after it, first` });
      else if (first && !sum.length && mask(d.text, { doubleTicks: false, heading: true }).split("\n").some((l) => SUMMARY_LINE.exec(l)?.[1] === first))
        broken.push({ id, why: "its list of the claims after it is not the end of its prose" });
      continue;
    }
    const next = after(id, sum.length), requires = new Set(rec.requires ?? []);
    const why = sum.length < MIN_PARTS ? `its summary lists one part (a split topic has at least ${MIN_PARTS})`
      : sum.map((p, i) => next[i] !== p.id ? `${p.id} is not the claim declared after ${sum[i - 1].id}`
        : !ctx.claims.has(p.id) ? `${p.id} has no record`
        : ctx.decls.get(p.id).level !== 2 ? `${p.id} is not an H2`
        : !requires.has(p.id) ? `it does not require ${p.id}`
        : titleOf(ctx.decls.get(p.id)) !== p.title ? `its line for ${p.id} says "${p.title}", not the part's heading "${titleOf(ctx.decls.get(p.id))}"`
        : null).find(Boolean);
    if (why) broken.push({ id, why });
    else found.set(id, sum.map((p) => p.id));
  }
  // A part that is itself a topic: the outer summary is broken, the inner topic stands.
  const up = new Map(), down = new Map();
  for (const [id, parts] of found) {
    const inner = parts.find((p) => found.has(p));
    if (inner) { broken.push({ id, why: `its part ${inner} is a split topic itself` }); continue; }
    down.set(id, parts);
    for (const p of parts) up.set(p, id);
  }
  broken.sort((a, b) => (a.id < b.id ? -1 : 1));
  s = { up, down, broken };
  cache.set(ctx, s);
  return s;
}

// The topic an id belongs to: its split topic for a part, else itself.
export const topicOf = (split, id) => split.up.get(id) ?? id;
// A topic and its parts, the topic first; an unsplit claim alone.
export const unitOf = (split, id) => [id, ...(split.down.get(id) ?? [])];
// The summary lines of a topic's own prose (0-based line indexes), which list its parts.
export function summaryLines(split, id, decl) {
  return split.down.has(id) ? new Set(summaryOf(decl).map((p) => p.line)) : new Set();
}
