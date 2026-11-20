// Lookup: the claims for a source file (ranked by the interface tokens they share with it) or for a name.
// Node stdlib only; reads the parsed graph and, for a path, that one file through the core's refusal rules.
import { posix } from "node:path";
import { whatOf, titleOf, fingerprintOf, boundedRefusal, emit } from "./toc.mjs";
import { lookArgs, openSpec, refuse, indexOf, labelsOf, labelText, occurs, nameRe, paged, pageFields } from "./graph.mjs";
import { topicIndex, topicRank } from "./topic.mjs";
import { splitOf, topicOf, unitOf } from "./parts.mjs";

const WHERE_NOTICE = "A shared token is a literal name match, never proof that the claim covers that code. Only a record's code list maps a file.";
const TOPIC_NOTICE = "A topic row is a ranked match of the query's words in the claim's text, never proof of what the claim covers: read it to judge.";
const TOP = 10, SHOW = 8;
const ticks = (ts) => ts.slice(0, SHOW).map((t) => `\`${t}\``).join(", ") + (ts.length > SHOW ? ` … +${ts.length - SHOW}` : "");

const claimLine = (ix, id) => {
  const rec = ix.ctx.claims.get(id);
  return { id, title: titleOf(ix.ctx.decls.get(id)), kind: rec.kind, ...labelsOf(rec) };
};
const partLine = (ix, id) => ({ id, title: titleOf(ix.ctx.decls.get(id)), ...labelsOf(ix.ctx.claims.get(id)) });
// The lookups' view of the claims: a split topic and its parts are one claim, its interface tokens theirs together,
// each once, and a token's weight counts topics, never parts. With nothing split it is the index itself.
function lookupView(ix) {
  const split = splitOf(ix.ctx);
  if (!split.up.size) return { ...ix, split };
  // Built at the first file lookup: a word search never weighs a token.
  let iface, df;
  const built = () => {
    if (iface) return;
    iface = new Map(); df = new Map();
    for (const id of ix.ids) if (!split.up.has(id)) {
      const ts = [...new Set(unitOf(split, id).flatMap((x) => ix.ifaceOf(x)))];
      iface.set(id, ts);
      for (const t of ts) df.set(t, (df.get(t) ?? 0) + 1);
    }
  };
  return { ...ix, split, ids: ix.ids.filter((id) => !split.up.has(id)),
    ifaceOf: (id) => (built(), iface.get(id)), weight: (t) => (built(), Math.log((iface.size + 1) / (df.get(t) ?? 1))) };
}
// Interface tokens of id that occur in text, heaviest (rarest) first, with the score they sum to.
function shared(ix, id, text) {
  const hit = ix.ifaceOf(id).filter((t) => occurs(text, t)).sort((a, b) => ix.weight(b) - ix.weight(a) || (a < b ? -1 : 1));
  return { shared: hit, score: Math.round(hit.reduce((s, t) => s + ix.weight(t), 0) * 100) / 100 };
}
const ranked = (a, b) => b.score - a.score || (a.id < b.id ? -1 : 1);

// A path: every claim whose code lists it, ranked; or, when none does, unmapped candidates. A split topic is listed
// once, when it or any of its parts lists the file, saying how many of its parts do.
function byPath(ix, path, read) {
  const split = ix.split, own = ix.code.get(path) ?? [];
  const listed = [...new Set(own.map((id) => topicOf(split, id)))];
  const partsOf = (id) => {
    const ps = split.down.get(id);
    return ps ? { parts: { listing: ps.filter((p) => own.includes(p)).length, of: ps.length, ...(own.includes(id) ? {} : { topic: false }) } } : {};
  };
  if (!listed.length) {
    if (read.text === undefined) return { list: [], counts: { claims: 0, ranked: 0, unranked: 0, candidates: 0 } };
    const cands = ix.ids.map((id) => ({ ...claimLine(ix, id), ...shared(ix, id, read.text) })).filter((c) => c.shared.length).sort(ranked);
    const list = cands.slice(0, TOP).map((c) => ({ type: "candidate", ...c }));
    return { list, counts: { claims: 0, ranked: 0, unranked: 0, candidates: cands.length } };
  }
  const rows = listed.map((id) => ({ ...claimLine(ix, id), tokens: ix.ifaceOf(id).length, ...(read.text === undefined ? { shared: [], score: 0 } : shared(ix, id, read.text)), ...partsOf(id) }));
  const hit = rows.filter((r) => r.shared.length).sort(ranked), rest = rows.filter((r) => !r.shared.length).sort((a, b) => (a.id < b.id ? -1 : 1));
  const list = [...hit.map((r) => ({ type: "ranked", ...r })), ...rest.map((r) => ({ type: "unranked", ...r }))];
  return { list, counts: { claims: listed.length, ranked: hit.length, unranked: rest.length } };
}

// A token: the claims whose backticked spans equal it or hold it as a whole name; heading or first sentence = defines.
// A split topic is one claim: its row is the topic's, naming the part that holds the name (one defining it first).
function byToken(ix, token) {
  const re = nameRe(token), defines = [], mentions = [], split = ix.split;
  const hitOf = (id) => {
    const spans = ix.tokens.get(id).filter((s) => s.token === token || (s.token.includes(token) && re.test(s.token)));
    if (!spans.length) return null;
    const what = whatOf(ix.ctx.decls.get(id)).what;
    return { id, def: spans.some((s) => s.head || what.includes("`" + s.token)), spans: spans.map((s) => s.token) };
  };
  for (const id of ix.ids) {
    const hits = unitOf(split, id).map(hitOf).filter(Boolean);
    if (!hits.length) continue;
    const def = hits.some((h) => h.def), parts = hits.filter((h) => h.id !== id), part = parts.find((h) => h.def) ?? parts[0];
    (def ? defines : mentions).push({ type: def ? "defines" : "mentions", ...claimLine(ix, id), spans: [...new Set(hits.flatMap((h) => h.spans))],
      ...(part ? { part: partLine(ix, part.id) } : {}) });
  }
  return { list: [...defines, ...mentions], counts: { claims: defines.length + mentions.length, defines: defines.length, mentions: mentions.length } };
}

const HEADS = { ranked: "ranked by interface tokens shared with the file", unranked: "listing the file, no interface token shared (code list only)",
  candidate: "UNMAPPED CANDIDATES: no record lists this file; these claims' interface tokens occur in it (a name match, not a mapping)",
  defines: "defines it (in its heading or first sentence)", mentions: "mentions it",
  topic: "TOPIC MATCHES: ranked by the query's words in heading, first sentence, names, prose and area heading (a word match, not a name match or a mapping)" };
const partsText = (p) => (!p ? "" : p.topic === false ? ` · listed by ${p.listing} of its ${p.of} parts` : p.listing ? ` · ${p.listing} of its ${p.of} parts list it too` : ` · none of its ${p.of} parts lists it`);
export function renderWhere(out) {
  const L = [], c = out.counts;
  if (out.mode === "path") {
    const f = out.file;
    L.push(c.claims ? `${out.query}: ${c.claims} claim(s) list this file in their code` : `${out.query}: no claim lists this file`);
    if (f.state !== "read") L.push(`could not read ${out.query} (${f.state}): claims are listed from code lists only, unranked`);
    else if (!c.claims) L.push(c.candidates ? `${c.candidates} claim(s) have interface tokens that occur in it; ${Math.min(c.candidates, TOP)} shown` : "no claim's interface tokens occur in it either");
  } else {
    if (out.note) L.push(out.note);
    L.push(c.claims ? `${out.query}: ${c.claims} claim(s) use it in backticks · defines ${c.defines} · mentions ${c.mentions}` : `${out.query}: no claim uses it in backticks`);
    L.push(c.topic ? `as a topic: ${c.topic} more claim(s) match its words` : out.topicTerms?.length ? "as a topic: no other claim matches its words" : "as a topic: no word in it to search");
  }
  let head = null;
  for (const e of out.lines) {
    if (e.type !== head) { head = e.type; L.push(HEADS[head]); }
    const base = `  ${e.id} — ${e.title}  ${e.kind} · ${labelText(e.labels)}`;
    if (e.type === "ranked" || e.type === "candidate") L.push(`${base} · score ${e.score}${partsText(e.parts)}`, `    shares: ${ticks(e.shared)}`);
    else if (e.type === "topic") L.push(`${base} · score ${e.score}`, `    matched: ${e.matched.join(", ")}`);
    else if (e.type === "unranked") L.push(`${base}${e.tokens ? "" : " · no interface token"}${partsText(e.parts)}`);
    else L.push(`${base}`, `    as: ${ticks(e.spans)}`);
    if (e.part) L.push(`    ${e.type === "topic" ? "best part" : "in part"}: ${e.part.id} — ${e.part.title}`);
  }
  if (out.notShown) L.push(`${out.notShown} more not shown: ${out.hint}`);
  if (out.next) L.push(`more: where '${out.query}'${out.mode === "token" ? " --token" : ""}${out.all ? " --all" : ""} --cursor ${out.next}`);
  L.push(`exit ${out.exit}`);
  return L.join("\n") + "\n";
}

export function whereMain(argv, core) {
  const o = lookArgs(argv, "where", { bools: ["--all", "--token"] });
  const done = (out) => emit(out, o.json, renderWhere);
  const budget = o.budget ?? 1024;
  if (o.help) return done({ tool: "sova-spec", command: "where", exit: 0, status: "done", budget,
    help: "where <path|token|topic words…> [--token] [--all] [--json] [--budget BYTES] [--cursor TOKEN] [--root DIR] [--spec DIR]; several words are one query; top 10 unless --all; default budget 12000, supported 1024..32768" });
  if (o.usage || !o.pos.join(" ").trim()) return done(boundedRefusal("where", budget, "usage", { message: o.usage ?? "where takes a path, a token or topic words" }));
  const g = openSpec(o, core);
  if (g.refused) return done(refuse("where", budget, g));
  const ix = lookupView(indexOf(g.ctx, core.parentOf)), query = o.pos.join(" ");
  const path = posix.normalize(query.split("\\").join("/")).replace(/^\.\//, "");
  let mode = "token", read = {}, r;
  // Only a single argument can be a file; several words are one token and topic query.
  if (!o.token && o.pos.length === 1) {
    try { read = { state: "read", text: core.readSource(g.root, path) }; } catch (e) { read = { state: e.code ?? "unreadable" }; }
    if (ix.code.has(path) || read.state === "read") mode = "path";
  }
  if (mode === "path") r = byPath(ix, path, read);
  else r = byToken(ix, query.trim());
  let full = o.all ? r.list : r.list.slice(0, TOP), total = r.list.length, cut = total - full.length, topic = null;
  if (mode === "token") {
    // Topic rows follow the name rows; a claim already listed by name is not repeated.
    const named = new Set(r.list.map((e) => e.id));
    topic = topicRank(topicIndex(ix), query.trim());
    const rows = topic.rows.filter((t) => !named.has(t.id)).map((t) => ({ type: "topic", ...claimLine(ix, t.id), score: t.score, matched: t.matched, ...(t.part ? { part: partLine(ix, t.part) } : {}) }));
    r.counts.topic = rows.length;
    // Name rows keep their top ten unchanged; topic rows fill only the places they leave free.
    const names = o.all ? r.list.length : Math.min(r.list.length, TOP);
    full = [...r.list.slice(0, names), ...(o.all ? rows : rows.slice(0, TOP - names))];
    total = r.list.length + rows.length; cut = r.list.length - names;
  }
  // A path-shaped argument that is no file under the root and no record's: say so in both forms, never a silent token search.
  const pathLike = mode === "token" && !o.token && /^[\w.-][^\s]*\/[^\s/]+\.[A-Za-z0-9]+$/.test(path);
  const absent = pathLike ? { file: { path, state: read.state === "missing" ? "absent" : read.state, mapped: false },
    note: read.state === "missing" ? `no file ${path} under the root and no record lists it: searched as a token` : `${path} was not read (${read.state}) and no record lists it: searched as a token` } : {};
  const notShown = total - full.length, q = mode === "path" ? path : query.trim();
  const head = { tool: "sova-spec", command: "where", budget, query: q, mode, all: !!o.all,
    ...(mode === "path" ? { file: { path, state: read.state, mapped: ix.code.has(path) } } : {}), ...(pathLike ? { pathLike: true, ...absent } : {}),
    ...(topic ? { topicTerms: topic.terms } : {}), counts: r.counts, total, shown: full.length,
    ...(notShown ? { notShown, hint: `where '${q}'${mode === "token" ? " --token" : ""} --all` } : {}) };
  // Cut name or path rows leave the answer incomplete; topic rows past the ten are the ranking's tail.
  const unknown = cut > 0 || pathLike || (mode === "path" ? read.state !== "read" || !r.counts.claims : !r.counts.claims && !r.counts.topic);
  const fp = fingerprintOf({ root: g.root, spec: o.spec, head, list: full });
  return paged({ command: "where", o, fp, list: full, render: renderWhere,
    build: (lines, at, next) => ({ ...head, exit: at < full.length || unknown ? 1 : 0, ...pageFields(full, lines, at, next), notice: WHERE_NOTICE, ...(topic ? { topicNotice: TOPIC_NOTICE } : {}) }) });
}
