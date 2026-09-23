// Legacy spec/*.md <-> .sova/spec/claims transform. Migration mechanics only, not a product tool.
// Forward inserts "§id — " after the marker of each H1/H2 outside fences and rewrites relative
// links between migrated files. Inverse strips exactly that prefix and rewrites the links back.
// Heading and fence scanning mirror pi-config/extensions/spec/core/sova-spec.mjs.
import { posix } from "node:path";

export const SEP = " — ";
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEAD = /^( {0,3})(#{1,6})([ \t]+)(.*)$/;
const LINK = /\]\(([^)\s#]+)(#[^)\s]*)?\)/g;

// Every heading line outside fences: {i, level, indent, marker, ws, text}.
export function headings(lines) {
  const out = [];
  let fence = null;
  lines.forEach((ln, i) => {
    const f = FENCE.exec(ln);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !ln.trim().slice(f[1].length).trim()) fence = null; return; }
    if (f) { fence = f[1]; return; }
    const h = HEAD.exec(ln);
    if (h) out.push({ i, level: h[2].length, indent: h[1], marker: h[2], ws: h[3], text: h[4] });
    else if (/^ {0,3}#{1,6}$/.test(ln)) out.push({ i, level: ln.trim().length, indent: "", marker: ln.trim(), ws: "", text: "" });
  });
  return out;
}

// Deterministic slug: parentheticals and code ticks dropped, letters only, no digits.
export function slug(text) {
  return text.replace(/\([^)]*\)/g, " ").replace(/`/g, "").toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-+|-+$/g, "");
}

// Rewrite link targets. map: legacy basename -> claims-relative path (and back when inverse).
function relinks(line, fromFile, targetOf) {
  return line.replace(LINK, (all, target, anchor = "") => {
    const to = targetOf(target, fromFile);
    return to === null ? all : `](${to}${anchor})`;
  });
}

// forward(text, {legacy, claimFile, ids: Map(lineIndex -> id), fileMap: legacy basename -> claims path})
export function forward(text, { claimFile, ids, fileMap }) {
  const lines = text.split("\n");
  const links = [];
  const heads = headings(lines);
  const headAt = new Map(heads.map((h) => [h.i, h]));
  const fenced = fencedLines(lines);
  const out = lines.map((ln, i) => {
    const h = headAt.get(i);
    if (h && h.level <= 2) {
      const id = ids.get(i);
      if (!id) throw new Error(`no id for heading at line ${i + 1}`);
      return `${h.indent}${h.marker}${h.ws || " "}${id}${SEP}${h.text}`;
    }
    if (fenced.has(i)) return ln;
    const nl = relinks(ln, claimFile, (target) => {
      if (target.includes("/") || !Object.hasOwn(fileMap, target)) return null;
      return posix.relative(posix.dirname(claimFile), fileMap[target]);
    });
    if (nl !== ln) links.push({ line: i + 1, before: ln, after: nl });
    return nl;
  });
  return { text: out.join("\n"), links };
}

// inverse(text, {claimFile, fileMap}) — fileMap as in forward; its inverse is taken here.
export function inverse(text, { claimFile, fileMap }) {
  const back = Object.fromEntries(Object.entries(fileMap).map(([k, v]) => [v, k]));
  const lines = text.split("\n");
  const headAt = new Map(headings(lines).map((h) => [h.i, h]));
  const fenced = fencedLines(lines);
  return lines.map((ln, i) => {
    const h = headAt.get(i);
    if (h && h.level <= 2) {
      const m = /^(§\S+) — ([\s\S]*)$/.exec(h.text);
      if (!m) throw new Error(`${claimFile}:${i + 1}: H${h.level} without "§id — " prefix`);
      return `${h.indent}${h.marker}${h.ws}${m[2]}`;
    }
    if (fenced.has(i)) return ln;
    return relinks(ln, claimFile, (target) => {
      const abs = posix.normalize(posix.join(posix.dirname(claimFile), target));
      return Object.hasOwn(back, abs) ? back[abs] : null;
    });
  }).join("\n");
}

function fencedLines(lines) {
  const s = new Set();
  let fence = null;
  lines.forEach((ln, i) => {
    const f = FENCE.exec(ln);
    if (fence) { s.add(i); if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !ln.trim().slice(f[1].length).trim()) fence = null; return; }
    if (f) { fence = f[1]; s.add(i); }
  });
  return s;
}
