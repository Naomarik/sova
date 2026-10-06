// Fullness plumbing shared by scenarios f and g and the agent arm: the harness's own index of a spec's
// passages (independent of the tools under test), span arithmetic, need probes, and reading a tool's
// streams. Node stdlib only.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every H1/H2 § declaration under `<root>/.sova/spec/claims`, parsed the way the core documents it: fenced
 * blocks never declare; a passage runs from its heading to the line before the next H1/H2, trailing blank
 * lines dropped; its text is those lines plus a newline. Files are walked in sorted order.
 * → { passages: Map<id, {id, file, rel, level, lines: [a, b], text, bytes}>, files: Map<rel, string[]> }
 */
export function specIndex(root) {
  const claims = join(root, ".sova/spec/claims");
  const passages = new Map(), files = new Map();
  const walk = (dir) => {
    for (const n of readdirSync(dir).sort()) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".md")) parseFile(p.slice(claims.length + 1), readFileSync(p, "utf8"));
    }
  };
  const parseFile = (rel, body) => {
    const lines = body.split(/\r?\n/);
    files.set(rel, lines);
    const heads = [];
    let fence = null;
    lines.forEach((ln, i) => {
      const f = /^ {0,3}(`{3,}|~{3,})/.exec(ln);
      if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !ln.trim().slice(f[1].length).trim()) fence = null; return; }
      if (f) { fence = f[1]; return; }
      const h = /^ {0,3}(#{1,2})[ \t]+(§\S+)/.exec(ln);
      if (h) heads.push({ id: h[2], level: h[1].length, line: i + 1 });
    });
    heads.forEach((h, k) => {
      let end = (heads[k + 1]?.line ?? lines.length + 1) - 1;
      while (end > h.line && !lines[end - 1].trim()) end--;
      const text = lines.slice(h.line - 1, end).join("\n") + "\n";
      passages.set(h.id, { id: h.id, file: `.sova/spec/claims/${rel}`, rel, level: h.level, lines: [h.line, end], text, bytes: Buffer.byteLength(text) });
    });
  };
  walk(claims);
  return { passages, files };
}

/** The passage holding `rel:line` (a verdict location, relative to claims/), or null. */
export function passageAt(index, at) {
  const [rel, n] = at.split(":");
  for (const p of index.passages.values()) if (p.rel === rel && +n >= p.lines[0] && +n <= p.lines[1]) return p.id;
  return null;
}

/**
 * Merge spans [{rel, from, to}] per file; touching or overlapping ranges join. Files keep the order they first appear
 * in (a slice lists its seed's file first), lines ascend within a file. The first probe hit is searched in this
 * order, as the research did, so a hit lands in the seed's own file before a far one.
 */
export function mergeSpans(spans) {
  const by = new Map();
  for (const s of spans) by.set(s.rel, [...(by.get(s.rel) ?? []), [s.from, s.to]]);
  const out = [];
  for (const rel of by.keys()) {
    const rs = by.get(rel).sort((a, b) => a[0] - b[0]);
    let cur = null;
    for (const [a, b] of rs) {
      if (cur && a <= cur[1] + 1) cur[1] = Math.max(cur[1], b);
      else { if (cur) out.push({ rel, from: cur[0], to: cur[1] }); cur = [a, b]; }
    }
    if (cur) out.push({ rel, from: cur[0], to: cur[1] });
  }
  return out;
}

export const spansOf = (index, ids) => [...ids].map((id) => index.passages.get(id)).filter(Boolean).map((p) => ({ rel: p.rel, from: p.lines[0], to: p.lines[1] }));
export const inSpans = (spans, at) => { const [rel, n] = at.split(":"); return spans.some((s) => s.rel === rel && +n >= s.from && +n <= s.to); };

/**
 * The first line in `spans` (merged) where `re` matches; a sentence wrapped onto the next line counts when the
 * joined pair matches and the next line alone doesn't. → "rel:line" | null
 */
export function search(index, spans, re) {
  for (const s of mergeSpans(spans)) {
    const lines = index.files.get(s.rel).slice(s.from - 1, s.to);
    for (let i = 0; i < lines.length; i++) {
      const one = lines[i], next = lines[i + 1] ?? "", two = `${one} ${next.trim()}`;
      if (re.test(one) || (re.test(two) && !re.test(next))) return `${s.rel}:${s.from + i}`;
    }
  }
  return null;
}

/** GRADING.md, "Ground rules reached": a passage carries a rule when a prose body line (its heading excluded, list
 *  items included; fenced code, HTML comments, table rows and blockquotes skipped; inline code and quoted strings
 *  removed) holds must, never, always, don't or do not. A breadcrumb or a bare lede carries none. */
export function carriesRule(text) {
  let fence = false, comment = false;
  for (const raw of text.split("\n").slice(1)) {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue; }
    if (fence) continue;
    let l = raw;
    if (comment) { if (!l.includes("-->")) continue; l = l.slice(l.indexOf("-->") + 3); comment = false; }
    l = l.replace(/<!--[\s\S]*?-->/g, "");
    if (l.includes("<!--")) { comment = true; l = l.slice(0, l.indexOf("<!--")); }
    if (/^\s*[|>]/.test(l)) continue;
    l = l.replace(/`[^`]*`/g, "").replace(/"[^"]*"|“[^”]*”/g, "");
    if (/\b(?:must|never|always|don['’]t|do not)\b/i.test(l)) return true;
  }
  return false;
}

export const wholeTree = (index) => [...index.files.entries()].map(([rel, lines]) => ({ rel, from: 1, to: lines.length }));

/** The parent H1 of an H2 id (`§a.b/c` → `§a/b`), or null for an H1. */
export function parentOf(id) {
  const m = /^§([a-z0-9-]+)\.([a-z0-9-]+)\/[a-z0-9-]+$/.exec(id);
  return m ? `§${m[1]}/${m[2]}` : null;
}

/**
 * Is a contents line's "what" a whole sentence of its passage? Checked against the passage's own text, not the
 * tool's splitter: a what that ends in terminal punctuation (closing quotes, brackets or emphasis allowed), with
 * no ( or [ left open, or in "…" is whole. One that ends without it is whole only if its source unit (paragraph, list item, quote line) ends
 * right there too; if the unit runs on, the sentence was cut. A what found nowhere in the passage can't be
 * checked and counts against the tool, and so does an empty one. → "whole" | "cut" | "unlocated" | "empty"
 */
export function cutWhat(what, text) {
  const w = typeof what === "string" ? what.replace(/\s+/g, " ").trim() : "";
  if (!w) return "empty";
  // Punctuation inside a bracket still open ("(or its arguments:") ends no sentence; code spans don't count.
  const bare = w.replace(/`[^`]*`/g, "");
  const open = (a, b) => bare.split(a).length - bare.split(b).length > 0;
  if (w.endsWith("…") || (/[.!?:;]["'”’)\]`*_]*$/.test(w) && !open("(", ")") && !open("[", "]"))) return "whole";
  // Quote markers drop; unit breaks (blank lines, list items, headings, table rows) become \0; other whitespace collapses.
  const body = text.split("\n").slice(1).map((ln) => ln.replace(/^[ \t]*>[ \t]?/, "")).join("\n")
    .replace(/\n[ \t]*(?:\n|(?=(?:[-*+]|\d+[.)])[ \t]|#|\|))/g, "\0")
    .replace(/(^|\0)[ \t\n]*(?:[-*+]|\d+[.)])[ \t]+/g, "$1")
    .replace(/[ \t\n]+/g, " ");
  const at = body.indexOf(w);
  if (at < 0) return "unlocated";
  const rest = body.slice(at + w.length).replace(/^ +/, "");
  return !rest || rest.startsWith("\0") ? "whole" : "cut";
}

/** A hand verdict's anchor {passage, snippet} → its claims-relative `file:line` in this spec, or null when the line is gone. */
export function anchorAt(index, { passage, snippet }) {
  const p = index.passages.get(passage);
  const k = p ? p.text.split("\n").findIndex((l) => l.includes(snippet)) : -1;
  return k < 0 ? null : `${p.rel}:${p.lines[0] + k}`;
}

/**
 * Score one need against a slice.
 * - `delivered`: Set of ids whose exact text the arm handed over; `named`: Set of ids it named without text;
 *   `extraSpans`: line ranges [{rel, from, to}] read some other way (a file read by line).
 * - A hand verdict's status `n/a` skips the need; `absent` scores 0. A verdict location is checked against the
 *   slice; otherwise the probe regex is searched in it. Partial verdicts score 0.5.
 * - A verdict location is found by its anchor (passage id and a quoted line; `anchors` lists several, any one holds), so it survives lines moving; one
 *   whose line is gone is `unanchored` (0, listed for a new hand verdict), never re-scored by the probe.
 * → { status: in|partial|missed|absent|unanchored|n/a, value, at, passage, named }
 */
export function scoreNeed(index, need, delivered, named, extraSpans = []) {
  const v = need.verdict;
  if (v?.status === "n/a" || !need.probe) return { status: "n/a", value: 0 };
  const re = new RegExp(need.probe.source, need.probe.flags);
  // A need marked `rule` is answered only in a passage that carries a rule (GRADING.md), so a heading alone never meets it.
  const ruled = (ids) => [...ids].filter((id) => !need.rule || carriesRule(index.passages.get(id)?.text ?? ""));
  const spans = [...spansOf(index, ruled(delivered)), ...(need.rule ? [] : extraSpans)];
  // `anchors` lists every place the verdict holds (a re-verdict adds the draft's line and keeps the base's); any one found counts.
  const anchors = v?.anchors ?? (v?.anchor ? [v.anchor] : null);
  const vat = anchors ? anchors.map((a) => anchorAt(index, a)).find(Boolean) ?? null : v?.at;
  if (anchors && !vat) return { status: "unanchored", value: 0, at: null, passage: anchors[0].passage, named: false };
  const where = vat ?? search(index, need.rule ? spansOf(index, ruled(index.passages.keys())) : wholeTree(index), re);
  const passage = where ? passageAt(index, where) : null;
  if (v?.status === "absent") return { status: "absent", value: 0, at: null, passage: null, named: false };
  const hit = vat ? (inSpans(spans, vat) ? vat : null) : search(index, spans, re);
  if (hit) {
    const partial = v?.status === "partial";
    return { status: partial ? "partial" : "in", value: partial ? 0.5 : 1, at: hit, passage: passageAt(index, hit), named: false };
  }
  if (!where) return { status: "absent", value: 0, at: null, passage: null, named: false };
  const isNamed = Boolean(passage && (named.has(passage) || named.has(parentOf(passage) ?? "")));
  return { status: "missed", value: 0, at: where, passage, named: isNamed };
}

/**
 * Every page of one packet stream, following `next` at the tool's default budget.
 * → { calls, exits: Set, items: [...], refused: code|null }
 */
export async function readStream(tools, root, home, args) {
  const items = [];
  const exits = new Set();
  let r = await tools.runAsync(root, home, args), calls = 1;
  if (r.json?.status === "refused" || r.json?.exit === 2 || !r.json) return { calls, exits: new Set([r.status]), items, refused: r.json?.code ?? `no-json(status ${r.status})` };
  for (;;) {
    exits.add(r.json.exit);
    items.push(...(r.json.items ?? []));
    if (!r.json.next || calls >= 1000) break;
    r = await tools.runAsync(root, home, [...args, "--cursor", r.json.next]);
    calls++;
    if (!r.json || r.json.status === "refused") { exits.add(`refused:${r.json?.code ?? r.status}`); break; }
  }
  return { calls, exits, items, refused: null };
}

/**
 * Does this tree's `sova-spec.mjs` have `cmd` (toc, read)? Asked without arguments: a tree that lacks it answers
 * `unknown command <cmd>` (exit 2, usage). → "absent" | "present" | "broken" (no JSON at all: never n/a).
 */
export async function capability(tools, root, home, cmd) {
  const r = await tools.runAsync(root, home, [cmd]);
  if (!r.json) return "broken";
  const unknown = (r.json.findings ?? []).some((f) => f.code === "usage" && new RegExp(`^unknown command ${cmd}\\b`).test(f.message ?? ""));
  return r.json.exit === 2 && unknown ? "absent" : "present";
}

/**
 * Does this tree accept `args` (a command, or a command with a new flag)? A tree that lacks it answers with a
 * usage finding `unknown command <x>` or `unknown flag <x>` (exit 2). → "absent" | "present" | "broken"
 */
export async function accepts(tools, root, home, args) {
  const r = await tools.runAsync(root, home, args);
  if (!r.json) return "broken";
  // The refusal names it in a finding (sova-spec.mjs) or at the top level (the toc/read modules).
  const said = (x) => x?.code === "usage" && /^unknown (command|flag) /.test(x.message ?? "");
  const unknown = said(r.json) || (r.json.findings ?? []).some(said);
  return r.json.exit === 2 && unknown ? "absent" : "present";
}

/** Every page of a command answering `{lines, next}`. → { ok, refused, lines, first, calls, bytes } */
export async function readLines(tools, root, home, args) {
  let r = await tools.runAsync(root, home, args), calls = 1, bytes = Buffer.byteLength(r.stdout);
  const lines = [], first = r.json;
  if (!first || first.status === "refused" || first.exit === 2 || !Array.isArray(first.lines)) return { ok: false, refused: first?.code ?? `no-json(status ${r.status})`, lines, first, calls, bytes };
  for (;;) {
    lines.push(...r.json.lines);
    if (!r.json.next || calls >= 200) break;
    r = await tools.runAsync(root, home, [...args, "--cursor", r.json.next]);
    calls++;
    bytes += Buffer.byteLength(r.stdout);
    if (!r.json || !Array.isArray(r.json.lines)) return { ok: false, refused: r.json?.code ?? "page-unreadable", lines, first, calls, bytes };
  }
  return { ok: true, refused: null, lines, first, calls, bytes };
}

/** Every page of `toc <id> --dir <dir>`, following `next`. → { ok, refused, lines, seed, footer, calls, bytes } */
export async function readToc(tools, root, home, id, dir) {
  const args = ["toc", id, "--dir", dir];
  let r = await tools.runAsync(root, home, args), calls = 1, bytes = Buffer.byteLength(r.stdout);
  const lines = [], first = r.json;
  if (!first || first.status === "refused" || first.exit === 2 || !Array.isArray(first.lines)) return { ok: false, refused: first?.code ?? `no-json(status ${r.status})`, lines, seed: null, footer: null, calls, bytes };
  for (;;) {
    lines.push(...(r.json.lines ?? []));
    if (!r.json.next || calls >= 200) break;
    r = await tools.runAsync(root, home, [...args, "--cursor", r.json.next]);
    calls++;
    bytes += Buffer.byteLength(r.stdout);
    if (!r.json || r.json.status === "refused" || !Array.isArray(r.json.lines)) return { ok: false, refused: r.json?.code ?? "page-unreadable", lines, seed: first.seed, footer: first.footer, calls, bytes };
  }
  return { ok: true, refused: null, lines, seed: first.seed ?? null, footer: r.json.footer ?? first.footer ?? null, calls, bytes };
}

/** `read <id>` (`--whole` when asked), fragments joined across pages. → { ok, refused, text, calls, bytes, footer } */
export async function readPassage(tools, root, home, id, { whole = false } = {}) {
  const args = ["read", id, ...(whole ? ["--whole"] : [])];
  let r = await tools.runAsync(root, home, args), calls = 1, bytes = Buffer.byteLength(r.stdout);
  if (!r.json || r.json.status === "refused" || r.json.exit === 2 || !Array.isArray(r.json.items)) return { ok: false, refused: r.json?.code ?? `no-json(status ${r.status})`, text: null, calls, bytes, footer: null };
  const items = [];
  for (;;) {
    items.push(...r.json.items);
    if (!r.json.next || calls >= 200) break;
    r = await tools.runAsync(root, home, [...args, "--cursor", r.json.next]);
    calls++;
    bytes += Buffer.byteLength(r.stdout);
    if (!r.json || !Array.isArray(r.json.items)) return { ok: false, refused: r.json?.code ?? "page-unreadable", text: null, calls, bytes, footer: null };
  }
  return { ok: true, refused: null, text: proseTexts(items).get(id) ?? null, texts: proseTexts(items), calls, bytes, footer: r.json.footer ?? null };
}

/** Reassemble prose items (fragments joined in order) by id. */
export function proseTexts(items) {
  const texts = new Map();
  for (const it of items) if (typeof it.text === "string") texts.set(it.id, (texts.get(it.id) ?? "") + it.text);
  return texts;
}

/** `fn` over `items`, at most `limit` at a time; results in input order. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
}

export const median =(xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

/** Every § id appearing in a JSON value: in an `id` field, or as a whole string in an array. */
export function idsIn(value, out = new Set()) {
  if (Array.isArray(value)) for (const v of value) { if (typeof v === "string" && /^§\S+$/.test(v)) out.add(v); else idsIn(v, out); }
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { if (k === "id" && typeof v === "string" && v.startsWith("§")) out.add(v); else idsIn(v, out); }
  return out;
}
