// Computed views over the whole graph: the shared index (areas, interface tokens, code and reverse maps),
// `graph` (one paged payload) and `impact --near` (one reverse hop). Node stdlib only; never writes.
// map.mjs and where.mjs build on the index here.
import { posix } from "node:path";
import { mask, mentionsOf, whatOf, whyOf, titleOf, sizeOf, kb, fingerprintOf, tokenFor, decodeToken, boundedRefusal, emit, sizeIn }
  from "./toc.mjs";

const ID_RE = /^§[a-z][a-z-]*(?:\.[a-z][a-z-]*)?\/[a-z][a-z-]*$/;

// ---------------------------------------------------------------- dispatch
const OWN_VALUE_FLAGS = ["--root", "--spec", "--budget", "--cursor"];
// Every flag of the core and the pull commands that takes a value, so the first positional word is found wherever flags sit.
const CORE_VALUE_FLAGS = [...OWN_VALUE_FLAGS, "--dir", "--base", "--head", "--read-policy", "--part", "--own-base", "--drafts"];
export const LOOK_COMMANDS = ["map", "where", "graph"];
// → {command: "map"|"where"|"graph"|"impact-near", rest} when the first positional names one, else null.
// `impact` is taken only with --near, so plain impact and its usage errors stay the core's.
export function lookCommand(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (CORE_VALUE_FLAGS.includes(argv[i])) { i++; continue; }
    if (argv[i].startsWith("-")) continue;
    const rest = [...argv.slice(0, i), ...argv.slice(i + 1)];
    if (LOOK_COMMANDS.includes(argv[i])) return { command: argv[i], rest };
    return argv[i] === "impact" && argv.includes("--near") ? { command: "impact-near", rest: rest.filter((a) => a !== "--near") } : null;
  }
  return null;
}

// Flags shared by the look commands; `bools` names the extra switches a command accepts.
export function lookArgs(argv, command, { bools = [], defaultBudget = 12000 } = {}) {
  const o = { json: false, pos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else if (bools.includes(a)) o[a.slice(2)] = true;
    else if (OWN_VALUE_FLAGS.includes(a)) {
      if (i + 1 >= argv.length) { o.usage ??= `${a} needs a value`; break; }
      o[a.slice(2)] = argv[++i];
    } else if (a.startsWith("-")) o.usage ??= `unknown flag ${a}`;
    else o.pos.push(a);
  }
  const raw = o.budget;
  o.budget = raw === undefined ? defaultBudget : /^\d+$/.test(String(raw)) && Number(raw) >= 1024 && Number(raw) <= 32768 ? Number(raw) : null;
  if (!o.usage && o.budget === null) o.usage = `${command} --budget takes an integer from 1024 to 32768`;
  return o;
}
// "§a.b" names §a/b, as the core reads its alias. → {id, alias?} | null
export function idArg(raw) {
  if (/^§[a-z][a-z-]*\.[a-z][a-z-]*$/.test(raw)) return { id: raw.replace(".", "/"), alias: raw };
  return ID_RE.test(raw) ? { id: raw } : null;
}

// The graph through the core's own loader. core: { findSpec, load, specDir, parentOf, findings: () => [], exitOf, DEFAULT_SPEC, readSource }
export function openSpec(o, core) {
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
  return { root, ctx };
}
export const refuse = (command, budget, g) =>
  boundedRefusal(command, budget, g.refused, { ...(g.cause ? { cause: g.cause } : {}), ...(g.message ? { message: g.message } : {}) });

// ---------------------------------------------------------------- the index
export const namespaceOf = (id) => id.slice(1).split(/[./]/)[0];
export function labelsOf(rec) {
  const l = {};
  if (rec.authority !== undefined) l.authority = rec.authority;
  if (rec.evidence !== undefined) l.evidence = rec.evidence;
  return Object.keys(l).length ? { labels: l } : {};
}
export const labelText = (l) => (l ? [l.authority ?? "-", l.evidence ?? "-"].join("/") : "unlabelled");

// Backticked spans of a passage outside fenced code and HTML comments, the heading's included, in order.
// → [{token, head}] where head marks a span in the heading line.
export function spansOf(decl) {
  const nl = decl.text.indexOf("\n");
  const head = nl < 0 ? decl.text : decl.text.slice(0, nl);
  const body = mask(decl.text, { doubleTicks: false });
  const out = [], seen = new Set();
  const take = (text, inHead) => {
    for (const m of text.matchAll(/(`+)([^`\n]*?[^`\n ][^`\n]*?)\1(?!`)/g)) {
      const token = m[2].trim();
      if (token && !seen.has(token)) { seen.add(token); out.push({ token, head: inHead }); }
    }
  };
  take(head, true);
  take(body, false);
  return out;
}
// A name the code uses: a separator, bracket or sigil, a capital after the first letter, or upper case.
export const isInterface = (t) => t.length >= 3 && /[A-Za-z]/.test(t) &&
  (/[\/._:#()$<>{}=\[\]-]/.test(t) || /[A-Z]/.test(t.slice(1)) || /^[A-Z][A-Z0-9_]+$/.test(t));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Occurs with no letter, digit, _ or $ on either side.
export const nameRe = (t) => new RegExp(`(?<![A-Za-z0-9_$])${esc(t)}(?![A-Za-z0-9_$])`);
export const occurs = (text, t) => text.includes(t) && nameRe(t).test(text);

// The § a passage names in prose (fences, comments and double-backtick spans masked) and in its heading
// after its own id; never itself.
export function mentionsIn(decl, self) {
  const nl = decl.text.indexOf("\n");
  const head = (nl < 0 ? decl.text : decl.text.slice(0, nl)).replace(/^ {0,3}#{1,2}[ \t]+\S+/, "");
  const seen = new Set();
  for (const { id } of [...mentionsOf(head.replace(/``[\s\S]*?``/g, " ")), ...mentionsOf(mask(decl.text))]) if (id !== self) seen.add(id);
  return [...seen];
}

// One pass over the parsed graph. Every list is sorted, so every view built on it is deterministic.
export function indexOf(ctx, parentOf) {
  const ids = [...ctx.decls.keys()].filter((id) => ctx.claims.has(id)).sort();
  const areaOf = (id) => (ctx.decls.get(id).level === 2 ? parentOf(id, ctx.dirKinds) ?? id : id);
  const areas = ids.filter((id) => ctx.decls.get(id).level === 1);
  const members = new Map(areas.map((a) => [a, []]));
  for (const id of ids) members.get(areaOf(id))?.push(id);
  // An area lists its H1 first, then its H2s in declaration order.
  for (const m of members.values()) m.sort((a, b) => ctx.decls.get(a).level - ctx.decls.get(b).level || ctx.decls.get(a).line - ctx.decls.get(b).line);
  const code = new Map(), rev = new Map(), tokens = new Map(), df = new Map();
  for (const id of ids) {
    const rec = ctx.claims.get(id);
    for (const c of new Set((rec.code ?? []).map((p) => posix.normalize(p.split("\\").join("/"))))) code.set(c, [...(code.get(c) ?? []), id]);
    for (const t of new Set(rec.requires ?? [])) rev.set(t, [...(rev.get(t) ?? []), id]);
    const spans = spansOf(ctx.decls.get(id));
    tokens.set(id, spans);
    for (const s of spans) if (isInterface(s.token)) df.set(s.token, (df.get(s.token) ?? 0) + 1);
  }
  const weight = (t) => Math.log((ids.length + 1) / (df.get(t) ?? 1));
  const ifaceOf = (id) => tokens.get(id).filter((s) => isInterface(s.token)).map((s) => s.token);
  return { ctx, ids, areas, members, areaOf, code, rev, tokens, df, weight, ifaceOf, parentOf };
}

// ---------------------------------------------------------------- bounded pages
// Lines that fit the budget, then a cursor bound to every computed line. build(lines, at) → envelope.
export function paged({ command, o, fp, list, build, render }) {
  const done = (out) => emit(out, o.json, render);
  let index = 0;
  if (o.cursor !== undefined) {
    const t = decodeToken(o.cursor, fp, command);
    if (t.code) return done(boundedRefusal(command, o.budget, t.code));
    if (t.index < 0 || t.index >= list.length || t.offset !== 0) return done(boundedRefusal(command, o.budget, "token-range"));
    index = t.index;
  }
  const next = (at) => (at < list.length ? tokenFor(fp, command, at) : null);
  const lines = [];
  if (sizeIn(build(lines, index, next(index)), o.json, render) > o.budget) return done(boundedRefusal(command, o.budget, "budget-refused"));
  while (index < list.length && sizeIn(build([...lines, list[index]], index + 1, next(index + 1)), o.json, render) <= o.budget) lines.push(list[index++]);
  if (!lines.length && index < list.length) return done(boundedRefusal(command, o.budget, "budget-refused"));
  return done(build(lines, index, next(index)));
}
export const pageFields = (list, lines, at, next) => ({ status: at < list.length ? "more" : "done", remaining: list.length - at, lines, next });

// ---------------------------------------------------------------- graph
const GRAPH_NOTICE = "Computed from the manifest and claim files on each call; never stored. Concatenate nodes and edges across pages in order to rebuild the one payload.";
const EDGE_KINDS = ["requires", "member", "contains", "mentions", "code"];

export function graphPayload(ix) {
  const { ctx } = ix;
  const nodes = ix.ids.map((id) => {
    const d = ctx.decls.get(id), rec = ctx.claims.get(id), w = whatOf(d);
    return { id, kind: rec.kind, level: d.level, namespace: namespaceOf(id), area: ix.areaOf(id), title: titleOf(d), what: w.what, whatSource: w.whatSource,
      ...labelsOf(rec), ...sizeOf(ctx, id), file: d.file, lines: d.lines, requires: rec.requires === undefined ? null : rec.requires.length, code: (rec.code ?? []).length };
  });
  const edges = [];
  const known = (to) => (ctx.claims.has(to) && ctx.decls.has(to) ? {} : { dangling: true });
  for (const id of ix.ids) {
    const rec = ctx.claims.get(id);
    for (const to of [...new Set(rec.requires ?? [])].sort()) edges.push({ kind: "requires", from: id, to, ...known(to) });
    for (const to of [...new Set(rec.members ?? [])].sort()) edges.push({ kind: "member", from: id, to, ...known(to) });
    for (const to of ix.members.get(id) ?? []) if (to !== id) edges.push({ kind: "contains", from: id, to });
    for (const to of mentionsIn(ctx.decls.get(id), id).sort()) edges.push({ kind: "mentions", from: id, to, ...known(to) });
    for (const to of [...new Set(rec.code ?? [])].sort()) edges.push({ kind: "code", from: id, to });
  }
  const byKind = Object.fromEntries(EDGE_KINDS.map((k) => [k, edges.filter((e) => e.kind === k).length]));
  return { nodes, edges, counts: { nodes: nodes.length, edges: edges.length, byKind } };
}

export function renderGraph(out) {
  const c = out.counts;
  return [`graph: ${c.nodes} nodes, ${c.edges} edges (${Object.entries(c.byKind).map(([k, n]) => `${k} ${n}`).join(" · ")})`,
    "the payload itself prints with --json, paged by --budget", `exit ${out.exit}`].join("\n") + "\n";
}

export function graphMain(argv, core) {
  const o = lookArgs(argv, "graph", { defaultBudget: 32768 });
  const done = (out) => emit(out, o.json, renderGraph);
  const budget = o.budget ?? 1024;
  if (o.help) return done({ tool: "sova-spec", command: "graph", exit: 0, status: "done", budget,
    help: "graph [--json] [--budget BYTES] [--cursor TOKEN] [--root DIR] [--spec DIR]; --json pages the payload: nodes, then edges; default budget 32768, supported 1024..32768" });
  if (o.usage || o.pos.length) return done(boundedRefusal("graph", budget, "usage", { message: o.usage ?? "graph takes no arguments" }));
  const g = openSpec(o, core);
  if (g.refused) return done(refuse("graph", budget, g));
  const p = graphPayload(indexOf(g.ctx, core.parentOf));
  const base = { tool: "sova-spec", command: "graph", budget, counts: p.counts };
  if (!o.json) return done({ ...base, exit: 0, status: "done" });
  const list = [...p.nodes.map((n) => ["node", n]), ...p.edges.map((e) => ["edge", e])];
  const fp = fingerprintOf({ root: g.root, spec: o.spec, list });
  return paged({ command: "graph", o, fp, list, render: renderGraph, build: (lines, at, next) => ({ ...base, exit: at < list.length ? 1 : 0,
    status: at < list.length ? "more" : "done", remaining: list.length - at,
    nodes: lines.filter(([k]) => k === "node").map(([, v]) => v), edges: lines.filter(([k]) => k === "edge").map(([, v]) => v), next, notice: GRAPH_NOTICE }) });
}

// ---------------------------------------------------------------- impact --near
const NEAR_NOTICE = "One reverse hop over requires, plus code neighbours and mentions, named. A why is the first sentence naming the link, never proof of a dependency.";
const NEAR_GROUPS = ["consumer", "container", "frontier", "next", "mentioned", "code"];
const NEAR_HEADS = { consumer: "consumers (one hop: their requires name the family)", container: "sections listing it", frontier: "frontier: no requires key, in or mentioning the family",
  next: "next hop (require a consumer; named only)", mentioned: "mentioned by (named only)", code: "code neighbours (files the family lists; fewest other records first)" };
const CODE_IDS = 12;

// The seed's family: an H1 and its H2s, or an H2 alone. → {family, parent}
export function familyOf(ix, id) {
  const d = ix.ctx.decls.get(id);
  if (d.level === 1) return { family: [id, ...(ix.members.get(id) ?? []).filter((x) => x !== id)], parent: null };
  const p = ix.areaOf(id);
  return { family: [id], parent: p !== id && ix.ctx.claims.has(p) ? p : null };
}

export function nearImpact(ix, seed) {
  const { ctx } = ix, { family, parent } = familyOf(ix, seed), fam = new Set(family);
  const line = (id) => {
    const d = ctx.decls.get(id), rec = ctx.claims.get(id);
    return { id, title: titleOf(d), kind: rec.kind, ...labelsOf(rec), ...sizeOf(ctx, id), ...whatOf(d) };
  };
  const consumers = new Map();
  for (const f of family) for (const c of ix.rev.get(f) ?? []) if (!fam.has(c)) consumers.set(c, [...(consumers.get(c) ?? []), f]);
  if (parent) for (const c of ix.rev.get(parent) ?? []) if (!fam.has(c) && !consumers.has(c)) consumers.set(c, [parent]);
  const list = [];
  for (const c of [...consumers.keys()].sort()) {
    // The why is the first family member it requires whose link its text explains, prose before comment.
    const via = consumers.get(c), ws = via.map((t) => whyOf(ctx.decls.get(c), t));
    const w = ws.find((x) => x.whySource === "prose") ?? ws.find((x) => x.whySource === "comment") ?? ws[0];
    list.push({ group: "consumer", ...line(c), requires: via, ...(via[0] === parent ? { via: "parent" } : {}), why: w.why, whySource: w.whySource });
  }
  for (const [id, rec] of [...ctx.claims].sort(([a], [b]) => (a < b ? -1 : 1)))
    if (rec.kind === "section" && (rec.members ?? []).some((m) => fam.has(m))) list.push({ group: "container", id, members: rec.members.filter((m) => fam.has(m)) });
  const mentioners = ix.ids.filter((id) => !fam.has(id) && mentionsIn(ctx.decls.get(id), id).some((m) => fam.has(m)));
  const open = ix.ids.filter((id) => ctx.claims.get(id).kind === "behavior" && ctx.claims.get(id).requires === undefined);
  const near = open.filter((id) => fam.has(id) || mentioners.includes(id));
  for (const id of near) list.push({ group: "frontier", ...line(id), reason: fam.has(id) ? "in-family" : "mentions-family" });
  const next = new Map();
  for (const c of consumers.keys()) for (const n of ix.rev.get(c) ?? []) if (!fam.has(n) && !consumers.has(n)) next.set(n, [...(next.get(n) ?? []), c]);
  for (const n of [...next.keys()].sort()) list.push({ group: "next", id: n, requires: next.get(n) });
  for (const id of mentioners) list.push({ group: "mentioned", id });
  const files = [...new Set(family.flatMap((f) => (ctx.claims.get(f).code ?? []).map((p) => posix.normalize(p.split("\\").join("/")))))];
  const shared = files.map((path) => ({ path, others: (ix.code.get(path) ?? []).filter((x) => !fam.has(x)) })).filter((f) => f.others.length)
    .sort((a, b) => a.others.length - b.others.length || (a.path < b.path ? -1 : 1));
  for (const f of shared) list.push({ group: "code", path: f.path, records: f.others.length, ids: f.others.slice(0, CODE_IDS), more: Math.max(0, f.others.length - CODE_IDS) });
  list.sort((a, b) => NEAR_GROUPS.indexOf(a.group) - NEAR_GROUPS.indexOf(b.group));
  const groups = Object.fromEntries(NEAR_GROUPS.map((g) => [g, list.filter((e) => e.group === g).length]));
  const far = open.length - near.length;
  const codeRecords = new Set(shared.flatMap((f) => f.others)).size;
  return { family, ...(parent ? { parent } : {}), list, counts: { entries: list.length, groups, codeRecords, uninvestigatedElsewhere: far } };
}

export function renderNear(out) {
  const L = [], s = out.seed;
  L.push(`impact --near ${s.id} — ${s.title}  family ${out.family.length} (${out.family.length > 1 ? "the H1 and its H2s" : out.parent ? `an H2; claims requiring ${out.parent} count too` : "itself"})`);
  let group = null;
  for (const e of out.lines) {
    if (e.group !== group) { group = e.group; L.push(`${NEAR_HEADS[group]} (${out.counts.groups[group]})`); }
    if (e.group === "consumer") {
      L.push(`  ${e.id} — ${e.title}  ${e.kind}${e.labels ? ` · ${labelText(e.labels)}` : ""} · ${kb(e.bytes)} · requires ${e.requires.join(", ")}${e.via ? " (via parent)" : ""}`,
        `    what: ${e.what}`, e.whySource === "comment" ? `    why (comment): ${e.why}` : `    why:  ${e.why}`);
    } else if (e.group === "frontier") L.push(`  ${e.id} — ${e.title}  ${e.reason === "in-family" ? "in the family" : "mentions the family"}`, `    what: ${e.what}`);
    else if (e.group === "container") L.push(`  ${e.id} (members ${e.members.join(", ")})`);
    else if (e.group === "next") L.push(`  ${e.id} (requires ${e.requires.join(", ")})`);
    else if (e.group === "code") L.push(`  ${e.path} — ${e.records} other record(s): ${e.ids.join(", ")}${e.more ? ` … +${e.more}: where ${e.path} --all` : ""}`);
    else L.push(`  ${e.id}`);
  }
  for (const g of NEAR_GROUPS) if (!out.counts.groups[g] && g !== "container") L.push(`${NEAR_HEADS[g]}: none`);
  if (out.counts.uninvestigatedElsewhere) L.push(`${out.counts.uninvestigatedElsewhere} more behavior(s) have no requires key and don't name the family: impact '${s.id}' lists them`);
  L.push(`delivered: no passage · listed ${out.lines.length} · not listed ${out.remaining}`);
  if (out.next) L.push(`more: impact '${s.id}' --near --cursor ${out.next}`);
  L.push(`exit ${out.exit}`);
  return L.join("\n") + "\n";
}

export function nearMain(argv, core) {
  const o = lookArgs(argv, "impact");
  const done = (out) => emit(out, o.json, renderNear);
  const budget = o.budget ?? 1024;
  if (o.help) return done({ tool: "sova-spec", command: "impact", near: true, exit: 0, status: "done", budget,
    help: "impact §id --near [--json] [--budget BYTES] [--cursor TOKEN] [--root DIR] [--spec DIR]; default budget 12000, supported 1024..32768" });
  const arg = o.pos.length === 1 ? idArg(o.pos[0]) : null;
  if (o.usage || !arg) return done(boundedRefusal("impact", budget, "usage", { message: o.usage ?? (o.pos.length === 1 ? `not a § identifier: ${o.pos[0]}` : "impact takes one §id") }));
  const g = openSpec(o, core);
  if (g.refused) return done(refuse("impact", budget, g));
  if (!g.ctx.claims.has(arg.id) || !g.ctx.decls.has(arg.id)) return done(boundedRefusal("impact", budget, "unknown-id", { message: `${arg.id} has no manifest record` }));
  const ix = indexOf(g.ctx, core.parentOf), r = nearImpact(ix, arg.id), d = g.ctx.decls.get(arg.id);
  const seed = { id: arg.id, title: titleOf(d), kind: g.ctx.claims.get(arg.id).kind, level: d.level };
  const fp = fingerprintOf({ root: g.root, spec: o.spec, seed, r });
  return paged({ command: "impact", o, fp, list: r.list, render: renderNear, build: (lines, at, next) => ({ tool: "sova-spec", command: "impact", near: true,
    exit: at < r.list.length || r.counts.uninvestigatedElsewhere || r.counts.groups.frontier ? 1 : 0, budget, id: arg.id, ...(arg.alias ? { alias: arg.alias } : {}),
    seed, family: r.family, ...(r.parent ? { parent: r.parent } : {}), counts: r.counts, ...pageFields(r.list, lines, at, next), notice: NEAR_NOTICE }) });
}
