// Contents view: one hop of neighbours around a § id, one line each (what, why, size). Node stdlib only;
// never reads anything but the parsed graph and never writes. Shared pull helpers for read.mjs live here too.
import { createHash } from "node:crypto";
import { embedsOf, embeddedBy, aboutNotes, frameOf, frameSummary, frameLine } from "./fields.mjs";

export const DIRS = ["out", "in", "down", "up", "mentions"];
const ID_RE = /^§[a-z][a-z-]*(?:\.[a-z][a-z-]*)?\/[a-z][a-z-]*$/;
const WHAT_MAX = 200, WHY_MAX = 240;
export const NOT_MENTIONED = "not mentioned in this claim's text";
const TOC_NOTICE = "Contents only: no passage is delivered here. Read one with read §id. A why is the first sentence naming the link, never proof of a dependency.";

// ---------------------------------------------------------------- arguments
const VALUE_FLAGS = ["--root", "--spec", "--budget", "--cursor", "--dir"];
// Every flag of the core that takes a value, so the first positional word is found wherever the flags sit.
const CORE_VALUE_FLAGS = [...VALUE_FLAGS, "--base", "--head", "--read-policy", "--part", "--own-base", "--drafts"];
// → {command: "toc"|"read", rest: argv without the command word} when the first positional is a pull command, else null.
export function pullCommand(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (CORE_VALUE_FLAGS.includes(argv[i])) { i++; continue; }
    if (argv[i].startsWith("-")) continue;
    return argv[i] === "toc" || argv[i] === "read" ? { command: argv[i], rest: [...argv.slice(0, i), ...argv.slice(i + 1)] } : null;
  }
  return null;
}
export function pullArgs(argv, command) {
  const o = { json: false, pos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--whole" && command === "read") o.whole = true;
    else if (a === "--frame" && command === "read") o.frame = true;
    else if (a === "--no-frame" && command === "read") o.noFrame = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else if (VALUE_FLAGS.includes(a) && (a !== "--dir" || command === "toc")) {
      if (i + 1 >= argv.length) { o.usage ??= `${a} needs a value`; break; }
      o[a.slice(2)] = argv[++i];
    } else if (a.startsWith("-")) o.usage ??= `unknown flag ${a}`;
    else o.pos.push(a);
  }
  // read's default fits any single passage in one call; toc's matches packet's page.
  o.budget = budgetOf(o.budget, DEFAULT_BUDGET[command]);
  if (o.usage || o.help) return o;
  if (o.budget === null) { o.usage = `${command} --budget takes an integer from 1024 to 32768`; return o; }
  if (o.frame) { if (o.pos.length || o.whole || o.noFrame) o.usage = "read --frame takes no §id, --whole or --no-frame"; return o; }
  if (o.pos.length !== 1) { o.usage = `${command} takes one §id`; return o; }
  const raw = o.pos[0];
  if (/^§[a-z][a-z-]*\.[a-z][a-z-]*$/.test(raw)) { o.alias = raw; o.id = raw.replace(".", "/"); }
  else if (ID_RE.test(raw)) o.id = raw;
  else o.usage = `not a § identifier: ${raw}`;
  if (!o.usage && command === "toc" && !DIRS.includes(o.dir)) o.usage = `toc needs --dir ${DIRS.join("|")}`;
  return o;
}
export const DEFAULT_BUDGET = { toc: 12000, read: 32768 };
const budgetOf = (raw, fallback) => raw === undefined ? fallback
  : /^\d+$/.test(String(raw)) && Number(raw) >= 1024 && Number(raw) <= 32768 ? Number(raw) : null;

// ---------------------------------------------------------------- the graph, through the core's own parser
// core: { findSpec, load, specDir, parentOf, findings: () => [], exitOf, DEFAULT_SPEC }
export function openGraph(o, core) {
  if (o.spec !== undefined) {
    const s = core.specDir(o.spec);
    if (s.why) return { refused: "usage", message: `--spec ${JSON.stringify(o.spec)}: ${s.why}` };
    o.spec = s.rel;
  }
  o.spec ??= core.DEFAULT_SPEC;
  const root = core.findSpec(o);
  if (!root) return { refused: "graph-untrusted", cause: "manifest-not-found" };
  const ctx = core.load(root, o.spec);
  const findings = core.findings();
  if (!ctx || core.exitOf(findings) === 2)
    return { refused: "graph-untrusted", ...(findings.some((f) => f.code === "manifest-not-found") ? { cause: "manifest-not-found" } : {}) };
  if (o.id !== undefined && (!ctx.claims.has(o.id) || !ctx.decls.has(o.id))) return { refused: "unknown-id", message: `${o.id} has no manifest record` };
  return { root, ctx };
}

// Title from the declaring heading: "# §id — Title".
export function titleOf(decl) {
  const first = decl.text.split("\n", 1)[0];
  const rest = first.replace(/^ {0,3}#{1,2}[ \t]+\S+[ \t]*/, "").replace(/^[—–:-]+[ \t]*/, "").replace(/[ \t]+#+[ \t]*$/, "");
  return rest.trim();
}

// Children of an H1 in declaration order (the core indexes them by id).
export function childrenInOrder(ctx, id) {
  return [...(ctx.children.get(id) ?? [])].filter((c) => ctx.decls.get(c)?.file === ctx.decls.get(id).file)
    .sort((a, b) => ctx.decls.get(a).line - ctx.decls.get(b).line);
}
export const bytesOf = (ctx, id) => Buffer.byteLength(ctx.decls.get(id).text);
// An H1 with children: its own span is the lede; whole = lede + every child span.
export function sizeOf(ctx, id) {
  const d = ctx.decls.get(id), bytes = Buffer.byteLength(d.text);
  if (d.level !== 1 || !(ctx.children.get(id) ?? []).length) return { bytes };
  return { bytes, whole: childrenInOrder(ctx, id).reduce((n, c) => n + bytesOf(ctx, c), bytes) };
}

// ---------------------------------------------------------------- masking (string indices preserved)
const blank = (s) => s.replace(/[^\n]/g, " ");
// Fenced blocks and HTML comments always; double-backtick spans when asked (L2's mask). On the heading
// line only the declaring markup ("## §id —") is masked, so a § named in a title is still a mention;
// `heading: true` masks the whole heading line instead.
export function mask(text, { doubleTicks = true, comments = true, heading = false } = {}) {
  const lines = text.split("\n");
  let fence = null;
  const out = lines.map((ln, i) => {
    if (i === 0) return heading ? blank(ln) : ln.replace(/^ {0,3}#{1,6}[ \t]+\S+(?:[ \t]+[—–:-]+)?[ \t]*/, blank);
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(ln);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !ln.trim().slice(f[1].length).trim()) fence = null; return blank(ln); }
    if (f) { fence = f[1]; return blank(ln); }
    return ln;
  }).join("\n");
  let m = comments ? out.replace(/<!--[\s\S]*?(?:-->|$)/g, blank) : out;
  if (doubleTicks) m = m.replace(/``[\s\S]*?``/g, blank);
  return m;
}

// § mentions in masked prose: full ids, and §a.b (no slash) read as §a/b, as the core reads its alias.
const MENTION_RE = /§([a-z][a-z-]*)(?:\.([a-z][a-z-]*))?(\/[a-z][a-z-]*)?/g;
export function mentionsOf(masked) {
  const out = [];
  for (const m of masked.matchAll(MENTION_RE)) {
    const next = masked[m.index + m[0].length];
    if (next && /[a-z0-9_]/.test(next)) continue;
    if (m[3]) out.push({ id: m[0], index: m.index });
    else if (m[2]) out.push({ id: `§${m[1]}/${m[2]}`, index: m.index });
  }
  return out;
}

// ---------------------------------------------------------------- sentences
// Units: a paragraph, list item, table row, quote line or heading; within a unit, sentences end at
// . ! ? (optionally closed by quotes, brackets or emphasis) followed by space and a non-lowercase start.
function units(masked, { title = true } = {}) {
  const res = [];
  let start = -1, at = 0, first = true;
  for (const ln of masked.split("\n")) {
    const end = at + ln.length, t = ln.trim();
    // In a whole passage the heading's title (line 1) is a unit of its own; the lines after it open a new
    // one. A unit's own text (title: false) never splits at its line ends.
    const opens = first || (title && at === masked.indexOf("\n") + 1) || /^(?:[-*+]|\d+[.)])\s|^[|>#]/.test(t);
    first = false;
    // A thematic break (---, ***, ___) ends a unit and is never prose itself.
    if (/^ {0,3}([-*_])( *\1){2,} *$/.test(ln)) { if (start >= 0) res.push([start, at - 1]); start = -1; at = end + 1; continue; }
    if (!t) { if (start >= 0) res.push([start, at - 1]); start = -1; }
    else if (opens || start < 0) { if (start >= 0) res.push([start, at - 1]); start = at; }
    at = end + 1;
  }
  if (start >= 0) res.push([start, masked.length]);
  return res;
}
export function sentences(masked, opts) {
  const out = [];
  for (const [a, b] of units(masked, opts)) {
    const u = masked.slice(a, b);
    let s = 0;
    while (s < u.length && /\s/.test(u[s])) s++; // past masked markup, so quotes never include it
    // Punctuation inside a code span (`a: b`) never ends a sentence.
    const v = u.replace(/`[^`\n]*`/g, (c) => "`" + "x".repeat(c.length - 2) + "`");
    for (const m of v.matchAll(/[.!?:]["'”’)\]*_`]*(?=\s)/g)) {
      const e = m.index + m[0].length;
      if (/\b(?:e\.g|i\.e|etc|vs|cf)\.$/.test(u.slice(Math.max(0, e - 5), e))) continue;
      out.push([a + s, a + e]); s = e;
      while (s < u.length && /\s/.test(u[s])) s++;
    }
    if (s < u.length) out.push([a + s, b]);
  }
  return out.filter(([a, b]) => masked.slice(a, b).trim());
}
const squash = (s) => s.replace(/\s+/g, " ").trim();
// Cut to max characters with a visible "…". With around (and len), the window always keeps s[around, around + len).
function clip(s, max, around = -1, len = 0) {
  if (s.length <= max) return s;
  const cut = s.lastIndexOf(" ", max - 1) > max / 2 ? s.lastIndexOf(" ", max - 1) : max - 1;
  if (around < 0 || around + len <= cut) return s.slice(0, cut) + "…";
  const from = Math.max(0, around + len - (max - 2), Math.min(around - Math.floor(max / 3), s.length - max + 2));
  return "…" + s.slice(from, from + max - 2) + "…";
}
// Where text names target (its own id, else the §a.b alias of an H1): [index, length], or [-1, 0].
function spanOf(text, target) {
  const hit = mentionsOf(text).find((x) => x.id === target);
  if (!hit) return [-1, 0];
  return [hit.index, target.length]; // the alias §a.b is as long as §a/b
}
const stripMarker = (s) => s.replace(/^(?:[-*+]|\d+[.)])\s+/, "");

// The first sentence of a unit, at least WHAT_MIN characters: a short run-in ("**Auto-grow.**") takes the next too.
const WHAT_MIN = 20;
function firstSentence(unit) {
  const ss = sentences(unit, { title: false });
  if (!ss.length) return null;
  let k = 0;
  while (k + 1 < ss.length && squash(unit.slice(ss[0][0], ss[k][1]).replace(/[*_]/g, "")).length < WHAT_MIN) k++;
  return clip(stripMarker(squash(unit.slice(ss[0][0], ss[k][1]))), WHAT_MAX);
}

// What: the first sentence of the passage's own prose. Fenced code, HTML comments, tables and headings
// are skipped; a blockquote is used only when there is no other prose. Verbatim, whitespace collapsed.
export function whatOf(decl) {
  const m = mask(decl.text, { doubleTicks: false, heading: true });
  let quote = null;
  for (const [a, b] of units(m)) {
    const unit = m.slice(a, b), t = unit.trim();
    if (!t || /^[|#]/.test(t)) continue;
    if (t.startsWith(">")) { quote ??= firstSentence(unit.replace(/^([ \t]*)>[ \t]?/gm, "$1")); continue; }
    const s = firstSentence(unit);
    if (s) return { what: s, whatSource: "prose" };
  }
  if (quote) return { what: quote, whatSource: "blockquote" };
  const code = decl.text.split("\n").slice(1).join("\n");
  return { what: /^ {0,3}(?:`{3,}|~{3,})/m.test(code) ? `no prose sentence: ${Buffer.byteLength(code.trim())} B of code` : "no prose sentence", whatSource: "none" };
}

// Why: the first visible-prose sentence of a passage naming target (fences, comments, double-backtick
// spans masked), else an HTML comment naming it (author-facing, so labelled), else none.
export function whyOf(decl, target) {
  const m = mask(decl.text);
  const hit = mentionsOf(m).find((x) => x.id === target);
  if (hit) {
    const s = sentences(m).find(([a, b]) => hit.index >= a && hit.index < b);
    const text = stripMarker(squash(decl.text.slice(s[0], s[1])));
    return { why: clip(text, WHY_MAX, ...spanOf(text, target)), whySource: "prose" };
  }
  const body = blank(decl.text.split("\n", 1)[0]) + decl.text.slice(Math.max(0, decl.text.indexOf("\n")));
  for (const c of body.matchAll(/<!--([\s\S]*?)(?:-->|$)/g))
    if (mentionsOf(c[1]).some((x) => x.id === target)) {
      const text = squash(c[1]);
      return { why: clip(text, WHY_MAX, ...spanOf(text, target)), whySource: "comment" };
    }
  return { why: NOT_MENTIONED, whySource: "none" };
}

// The § a passage names in prose (masked), in order of first mention, without itself.
export function namedIn(decl, self) {
  const seen = new Set();
  for (const { id } of mentionsOf(mask(decl.text))) if (id !== self) seen.add(id);
  return [...seen];
}

// ---------------------------------------------------------------- bounded pages
const digest = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export const fingerprintOf = digest;
export const tokenFor = (fp, command, index, offset = 0) => Buffer.from(JSON.stringify([1, fp, command, index, offset])).toString("base64url");
export function decodeToken(raw, fp, command) {
  if (typeof raw !== "string" || raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) return { code: "token-malformed" };
  let t;
  try { t = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); } catch { return { code: "token-malformed" }; }
  if (!Array.isArray(t) || t.length !== 5 || t[0] !== 1 || typeof t[1] !== "string" || !Number.isSafeInteger(t[3]) || !Number.isSafeInteger(t[4]) ||
      tokenFor(t[1], t[2], t[3], t[4]) !== raw) return { code: "token-malformed" };
  if (t[1] !== fp || t[2] !== command) return { code: "token-mismatch-or-stale" };
  return { index: t[3], offset: t[4] };
}
export const refusal = (command, budget, code, extra = {}) => ({ tool: "sova-spec", command, exit: 2, status: "refused", budget, code, ...extra });
// Refusals and help are always compact JSON; pages render as text unless --json.
const asText = (out, json, render) => (json || out.status === "refused" || out.help ? JSON.stringify(out) + "\n" : render(out));
export function emit(out, json, render) {
  process.stdout.write(asText(out, json, render));
  return out.exit;
}
export const sizeIn = (out, json, render) => Buffer.byteLength(asText(out, json, render));
// Errors carry a message only when it fits the smallest budget.
export function boundedRefusal(command, budget, code, extra = {}) {
  const r = refusal(command, budget, code, extra);
  return Buffer.byteLength(JSON.stringify(r) + "\n") <= budget ? r : refusal(command, budget, code);
}

// ---------------------------------------------------------------- toc
const GROUPS = {
  out: ["requires", "embeds", "about", "named"], in: ["required-by", "required-through-parent", "embedded-by", "embedded-through-parent", "about-it"], down: ["children", "members"], up: ["parent"], mentions: ["mentioned-by"],
};
const HEADS = { requires: "requires", embeds: "embeds (drawn inside it; read delivers them whole)", about: "about (notes that serve it)",
  named: "named in its text, not required", "required-by": "required by", "required-through-parent": "required through its H1", "embedded-by": "embedded by", "embedded-through-parent": "embedded through its H1", "about-it": "notes about it",
  children: "children", members: "members", parent: "parent", "mentioned-by": "mentioned by" };
function labelsOf(rec) {
  const l = {};
  if (rec.authority !== undefined) l.authority = rec.authority;
  if (rec.evidence !== undefined) l.evidence = rec.evidence;
  return Object.keys(l).length ? { labels: l } : {};
}

// The ids one hop from id in a direction: [{id, group, src?}], src being the passage whose text gives the why.
function neighbours(ctx, id, dir, parentOf) {
  const rec = ctx.claims.get(id), seed = ctx.decls.get(id);
  if (dir === "out") {
    const emb = [...new Set(rec.embeds ?? [])].sort(), req = [...new Set(rec.requires ?? [])].filter((x) => !emb.includes(x)).sort();
    // Notes about the claim, then notes about its H1 (marked via), each note once.
    const p = parentOf(id, ctx.dirKinds), about = aboutNotes(ctx, [id]);
    if (p) for (const n of aboutNotes(ctx, [p])) if (!about.some((a) => a.id === n.id)) about.push({ ...n, via: p });
    const named = namedIn(seed, id).filter((x) => !req.includes(x) && !emb.includes(x) && !about.some((a) => a.id === x)).sort();
    return [...req.map((to) => ({ id: to, group: "requires", src: seed, target: to })),
      ...emb.map((to) => ({ id: to, group: "embeds", src: seed, target: to })),
      ...about.map((n) => ({ id: n.id, group: "about", src: ctx.decls.get(n.id), target: n.target, ...(n.via ? { via: n.via } : {}) })),
      ...named.map((to) => ({ id: to, group: "named", src: seed, target: to }))];
  }
  if (dir === "in") {
    const by = (t) => [...ctx.claims].filter(([, r]) => (r.requires ?? []).includes(t)).map(([k]) => k).sort();
    const direct = by(id), p = seed.level === 2 ? parentOf(id, ctx.dirKinds) : null;
    // Requiring an H1 brings every H2 of it, so those claims reach an H2 through its parent.
    const through = p && ctx.claims.has(p) ? by(p).filter((k) => k !== id && !direct.includes(k)) : [];
    return [...direct.map((k) => ({ id: k, group: "required-by", src: ctx.decls.get(k), target: id })),
      ...through.map((k) => ({ id: k, group: "required-through-parent", src: ctx.decls.get(k), target: p, via: p })),
      ...embeddedBy(ctx, id).map((k) => ({ id: k, group: "embedded-by", src: ctx.decls.get(k), target: id })),
      // Embedding an H1 draws all of it, so its embedders reach each H2 too; notes serve it or its H1.
      ...(p && ctx.claims.has(p) ? embeddedBy(ctx, p).filter((k) => k !== id && !embeddedBy(ctx, id).includes(k)) : [])
        .map((k) => ({ id: k, group: "embedded-through-parent", src: ctx.decls.get(k), target: p, via: p })),
      ...aboutLines(ctx, id, p)];
  }
  if (dir === "down") return rec.kind === "section" ? (rec.members ?? []).map((m) => ({ id: m, group: "members" }))
    : childrenInOrder(ctx, id).map((c) => ({ id: c, group: "children" }));
  if (dir === "up") { const p = parentOf(id, ctx.dirKinds); return p && ctx.claims.has(p) ? [{ id: p, group: "parent" }] : []; }
  const alias = seed.level === 1 && /^§[a-z][a-z-]*\/[a-z][a-z-]*$/.test(id) ? id.replace("/", ".") : null, out = [];
  for (const from of [...ctx.decls.keys()].sort()) {
    const d = ctx.decls.get(from);
    if (from === id || !(d.text.includes(id) || (alias && d.text.includes(alias)))) continue;
    if (mentionsOf(mask(d.text)).some((x) => x.id === id)) out.push({ id: from, group: "mentioned-by", src: d, target: id });
  }
  return out;
}

function aboutLines(ctx, id, p) {
  const about = aboutNotes(ctx, [id]);
  if (p) for (const n of aboutNotes(ctx, [p])) if (!about.some((a) => a.id === n.id)) about.push({ ...n, via: p });
  return about.map((n) => ({ id: n.id, group: "about-it", src: ctx.decls.get(n.id), target: n.target, about: true, ...(n.via ? { via: n.via } : {}) }));
}

// A record's agreed {by, at}, and whether it is built: code plus evidence reviewed or verified (the
// draft tool's BUILT_LABELS rule). → {agreed} | {}
export function agreedOf(rec) {
  const a = rec?.agreed;
  if (!a || typeof a !== "object" || typeof a.by !== "string" || typeof a.at !== "string") return {};
  return { agreed: { by: a.by, at: a.at, built: !!rec.code?.length && ["reviewed", "verified"].includes(rec.evidence) } };
}
export const agreedText = (x) => (x.agreed ? ` · agreed (decision) ${x.agreed.at} by ${x.agreed.by}, ${x.agreed.built ? "built" : "not built"}` : "");

function line(ctx, n) {
  const d = ctx.decls.get(n.id), rec = ctx.claims.get(n.id), w = n.src ? whyOf(n.src, n.target) : null;
  const why = w ? { why: w.why, whySource: w.whySource } : {};
  // A note's about field is itself a written reason for the link.
  if ((n.about || n.group === "about") && why.whySource === "none") Object.assign(why, { why: `about ${n.target} (declared on the note)`, whySource: "declared" });
  if (!d || !rec) return { id: n.id, group: n.group, ...(n.via ? { via: n.via } : {}), dangling: true, ...why };
  return { id: n.id, group: n.group, ...(n.via ? { via: n.via } : {}), title: titleOf(d), kind: rec.kind, level: d.level, ...labelsOf(rec), ...agreedOf(rec), ...sizeOf(ctx, n.id), ...whatOf(d), ...why };
}

export function tocStream(ctx, id, dir, parentOf) {
  const seed = ctx.decls.get(id), rec = ctx.claims.get(id), unknowns = [];
  const list = neighbours(ctx, id, dir, parentOf).map((n) => line(ctx, n));
  const order = GROUPS[dir];
  list.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  if (dir === "out" && rec.kind === "behavior" && rec.requires === undefined)
    unknowns.push({ code: "requires-uninvestigated", message: `dependencies uninvestigated: ${id} has no requires key, so they are unknown, not none` });
  if (dir === "in") {
    const open = [...ctx.claims].filter(([k, r]) => r.kind === "behavior" && r.requires === undefined && k !== id).length;
    if (open) unknowns.push({ code: "requires-uninvestigated", message: `${open} behavior(s) have no requires key and could also require it (impact lists them)` });
  }
  const dangling = list.filter((e) => e.dangling).map((e) => e.id);
  if (dangling.length) unknowns.push({ code: "unknown", message: `unknown: no record or span for ${dangling.join(", ")}`, ids: dangling });
  // An H1 whose own record requires nothing can still have H2s that require claims outside it.
  let childRequires;
  if (dir === "out" && seed.level === 1 && (ctx.children.get(id) ?? []).length) {
    const inside = new Set([id, ...ctx.children.get(id)]), outside = new Set();
    let h2s = 0;
    for (const c of ctx.children.get(id)) {
      const ext = (ctx.claims.get(c)?.requires ?? []).filter((t) => !inside.has(t));
      if (ext.length) h2s++;
      ext.forEach((t) => outside.add(t));
    }
    childRequires = { h2s, claims: outside.size };
  }
  const otherDirections = Object.fromEntries(DIRS.filter((d) => d !== dir).map((d) => [d, neighbours(ctx, id, d, parentOf).length]));
  return { seed: { id, title: titleOf(seed), kind: rec.kind, level: seed.level, ...labelsOf(rec), ...agreedOf(rec), codeFiles: Array.isArray(rec.code) ? rec.code.length : 0, file: seed.file, lines: seed.lines, ...sizeOf(ctx, id), ...whatOf(seed),
    ...(dir === "out" ? { requires: rec.requires === undefined ? null : rec.requires.length } : {}), ...(childRequires ? { childRequires } : {}) }, list, unknowns, otherDirections };
}

export const kb = (n) => (n < 1000 ? `${n} B` : `${(n / 1000).toFixed(1)} KB`);
const sizeText = (e) => (e.whole !== undefined ? `H1 · lede ${kb(e.bytes)} · whole ${kb(e.whole)}` : kb(e.bytes));
const lab = (e) => (e.labels ? ` · ${[e.labels.authority ?? "-", e.labels.evidence ?? "-"].join("/")}` : "");

export function renderToc(out) {
  const L = [], s = out.seed, D = out.dir.toUpperCase();
  L.push(`${s.id} — ${s.title}  ${s.kind}${lab(s)} · ${sizeText(s)}${s.codeFiles ? ` · code ${s.codeFiles} file(s), read names them` : ""}${agreedText(s)}`, `  what: ${s.what}`);
  if (out.dir === "out" && !out.counts.groups.requires && !out.counts.groups.embeds)
    L.push(`${D}: requires: ${s.requires === null && s.kind === "behavior" ? "dependencies uninvestigated (no requires key)" : "none declared"}`);
  if (s.childRequires) L.push(`${D}: its ${s.childRequires.h2s} H2(s) require ${s.childRequires.claims} claim(s) outside it: toc each H2 --dir out, or map '${s.id}'`);
  let group = null;
  for (const e of out.lines) {
    if (e.group !== group) { group = e.group; L.push(`${D}: ${HEADS[group]}${group.endsWith("-through-parent") ? " " + e.via : ""} (${out.counts.groups[group]})`); }
    if (e.dangling) L.push(`  ${e.id} — unknown: no record or span`);
    else L.push(`  ${e.id} — ${e.title}  ${e.kind}${lab(e)} · ${sizeText(e)}${e.via && (e.group === "about" || e.group === "about-it") ? ` · about its H1 ${e.via}` : ""}${agreedText(e)}`, `    what: ${e.what}`);
    if (e.why !== undefined) L.push(e.whySource === "comment" ? `    why (comment): ${e.why}` : `    why:  ${e.why}`);
  }
  if (!out.counts.entries && out.dir !== "out") L.push(`${D}: none`);
  for (const n of out.notes) L.push(`note ${n.code}: ${n.message}`);
  const f = out.footer;
  L.push(`delivered: no passage (contents only; read '§id' delivers one) · listed ${f.listed} · not listed ${f.notListed}`,
    `other directions: ${Object.entries(f.otherDirections).map(([d, n]) => `${d} ${n}`).join(" · ")}`, ...f.unknowns.map((u) => u.message));
  if (out.frame) L.push(frameLine(out.frame));
  if (out.next) L.push(`more: toc '${out.id}' --dir ${out.dir} --cursor ${out.next}`);
  L.push(`exit ${out.exit}`);
  return L.join("\n") + "\n";
}

export function tocMain(argv, core) {
  const o = pullArgs(argv, "toc"), budget = o.budget ?? 1024;
  const done = (out) => emit(out, o.json, renderToc);
  if (o.help) return done({ tool: "sova-spec", command: "toc", exit: 0, status: "done", budget,
    help: "toc §id --dir out|in|down|up|mentions [--json] [--budget BYTES] [--cursor TOKEN] [--root DIR] [--spec DIR]; default budget 12000, supported 1024..32768" });
  if (o.usage) return done(boundedRefusal("toc", budget, "usage", { message: o.usage }));
  const g = openGraph(o, core);
  if (g.refused) return done(boundedRefusal("toc", budget, g.refused, { ...(g.cause ? { cause: g.cause } : {}), ...(g.message ? { message: g.message } : {}) }));
  const { ctx, root } = g;
  const { seed, list, unknowns, otherDirections } = tocStream(ctx, o.id, o.dir, core.parentOf);
  const notes = o.alias ? [{ code: "id-alias", message: `${o.alias} is not a § identifier; read as ${o.id}` }] : [];
  if (o.dir === "up" && !list.length) notes.push({ code: "no-parent", message: `${o.id} is an H1: it has no parent` });
  const groups = {};
  for (const e of list) groups[e.group] = (groups[e.group] ?? 0) + 1;
  const frame = frameSummary(frameOf(ctx));
  const fp = digest({ root, spec: o.spec, id: o.id, dir: o.dir, seed, list, unknowns, otherDirections, ...(frame ? { frame } : {}) });
  let index = 0;
  if (o.cursor !== undefined) {
    const t = decodeToken(o.cursor, fp, "toc");
    if (t.code) return done(boundedRefusal("toc", budget, t.code));
    if (t.index < 0 || t.index >= list.length || t.offset !== 0) return done(boundedRefusal("toc", budget, "token-range"));
    index = t.index;
  }
  const envelope = (lines, at) => {
    const more = at < list.length;
    return { tool: "sova-spec", command: "toc", exit: more || unknowns.length ? 1 : 0, status: more ? "more" : "done", budget, id: o.id, dir: o.dir,
      seed, counts: { entries: list.length, groups }, remaining: list.length - at, lines, notes,
      footer: { delivered: [], listed: lines.length, notListed: list.length - at, otherDirections, unknowns }, ...(frame ? { frame } : {}),
      next: more ? tokenFor(fp, "toc", at) : null, notice: TOC_NOTICE };
  };
  const lines = [];
  if (sizeIn(envelope(lines, index), o.json, renderToc) > budget) return done(boundedRefusal("toc", budget, "budget-refused"));
  while (index < list.length && sizeIn(envelope([...lines, list[index]], index + 1), o.json, renderToc) <= budget) lines.push(list[index++]);
  if (!lines.length && index < list.length) return done(boundedRefusal("toc", budget, "budget-refused"));
  return done(envelope(lines, index));
}
