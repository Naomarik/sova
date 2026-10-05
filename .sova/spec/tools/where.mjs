// Lookup: the claims for a source file (ranked by the interface tokens they share with it) or for a name.
// Node stdlib only; reads the parsed graph and, for a path, that one file through the core's refusal rules.
import { posix } from "node:path";
import { whatOf, titleOf, fingerprintOf, boundedRefusal, emit } from "./toc.mjs";
import { lookArgs, openSpec, refuse, indexOf, labelsOf, labelText, occurs, nameRe, paged, pageFields } from "./graph.mjs";

const WHERE_NOTICE = "A shared token is a literal name match, never proof that the claim covers that code. Only a record's code list maps a file.";
const TOP = 10, SHOW = 8;
const ticks = (ts) => ts.slice(0, SHOW).map((t) => `\`${t}\``).join(", ") + (ts.length > SHOW ? ` … +${ts.length - SHOW}` : "");

const claimLine = (ix, id) => {
  const rec = ix.ctx.claims.get(id);
  return { id, title: titleOf(ix.ctx.decls.get(id)), kind: rec.kind, ...labelsOf(rec) };
};
// Interface tokens of id that occur in text, heaviest (rarest) first, with the score they sum to.
function shared(ix, id, text) {
  const hit = ix.ifaceOf(id).filter((t) => occurs(text, t)).sort((a, b) => ix.weight(b) - ix.weight(a) || (a < b ? -1 : 1));
  return { shared: hit, score: Math.round(hit.reduce((s, t) => s + ix.weight(t), 0) * 100) / 100 };
}
const ranked = (a, b) => b.score - a.score || (a.id < b.id ? -1 : 1);

// A path: every claim whose code lists it, ranked; or, when none does, unmapped candidates.
function byPath(ix, path, read) {
  const listed = ix.code.get(path) ?? [];
  if (!listed.length) {
    if (read.text === undefined) return { list: [], counts: { claims: 0, ranked: 0, unranked: 0, candidates: 0 } };
    const cands = ix.ids.map((id) => ({ ...claimLine(ix, id), ...shared(ix, id, read.text) })).filter((c) => c.shared.length).sort(ranked);
    const list = cands.slice(0, TOP).map((c) => ({ type: "candidate", ...c }));
    return { list, counts: { claims: 0, ranked: 0, unranked: 0, candidates: cands.length } };
  }
  const rows = listed.map((id) => ({ ...claimLine(ix, id), tokens: ix.ifaceOf(id).length, ...(read.text === undefined ? { shared: [], score: 0 } : shared(ix, id, read.text)) }));
  const hit = rows.filter((r) => r.shared.length).sort(ranked), rest = rows.filter((r) => !r.shared.length).sort((a, b) => (a.id < b.id ? -1 : 1));
  const list = [...hit.map((r) => ({ type: "ranked", ...r })), ...rest.map((r) => ({ type: "unranked", ...r }))];
  return { list, counts: { claims: listed.length, ranked: hit.length, unranked: rest.length } };
}

// A token: the claims whose backticked spans equal it or hold it as a whole name; heading or first sentence = defines.
function byToken(ix, token) {
  const re = nameRe(token), defines = [], mentions = [];
  for (const id of ix.ids) {
    const spans = ix.tokens.get(id).filter((s) => s.token === token || (s.token.includes(token) && re.test(s.token)));
    if (!spans.length) continue;
    const what = whatOf(ix.ctx.decls.get(id)).what;
    const def = spans.some((s) => s.head || what.includes("`" + s.token));
    (def ? defines : mentions).push({ type: def ? "defines" : "mentions", ...claimLine(ix, id), spans: spans.map((s) => s.token) });
  }
  return { list: [...defines, ...mentions], counts: { claims: defines.length + mentions.length, defines: defines.length, mentions: mentions.length } };
}

const HEADS = { ranked: "ranked by interface tokens shared with the file", unranked: "listing the file, no interface token shared (code list only)",
  candidate: "UNMAPPED CANDIDATES: no record lists this file; these claims' interface tokens occur in it (a name match, not a mapping)",
  defines: "defines it (in its heading or first sentence)", mentions: "mentions it" };
export function renderWhere(out) {
  const L = [], c = out.counts;
  if (out.mode === "path") {
    const f = out.file;
    L.push(c.claims ? `${out.query}: ${c.claims} claim(s) list this file in their code` : `${out.query}: no claim lists this file`);
    if (f.state !== "read") L.push(`could not read ${out.query} (${f.state}): claims are listed from code lists only, unranked`);
    else if (!c.claims) L.push(c.candidates ? `${c.candidates} claim(s) have interface tokens that occur in it; ${Math.min(c.candidates, TOP)} shown` : "no claim's interface tokens occur in it either");
  } else {
    if (out.pathLike) L.push(`no file ${out.query} under the root and no record lists it: searched as a token`);
    L.push(c.claims ? `${out.query}: ${c.claims} claim(s) use it in backticks · defines ${c.defines} · mentions ${c.mentions}` : `${out.query}: no claim uses it in backticks`);
  }
  let head = null;
  for (const e of out.lines) {
    if (e.type !== head) { head = e.type; L.push(HEADS[head]); }
    const base = `  ${e.id} — ${e.title}  ${e.kind} · ${labelText(e.labels)}`;
    if (e.type === "ranked" || e.type === "candidate") L.push(`${base} · score ${e.score}`, `    shares: ${ticks(e.shared)}`);
    else if (e.type === "unranked") L.push(`${base}${e.tokens ? "" : " · no interface token"}`);
    else L.push(`${base}`, `    as: ${ticks(e.spans)}`);
  }
  if (out.shown < out.total) L.push(`${out.total - out.shown} more not shown: where '${out.query}'${out.mode === "token" ? " --token" : ""} --all`);
  if (out.next) L.push(`more: where '${out.query}'${out.mode === "token" ? " --token" : ""}${out.all ? " --all" : ""} --cursor ${out.next}`);
  L.push(`exit ${out.exit}`);
  return L.join("\n") + "\n";
}

export function whereMain(argv, core) {
  const o = lookArgs(argv, "where", { bools: ["--all", "--token"] });
  const done = (out) => emit(out, o.json, renderWhere);
  const budget = o.budget ?? 1024;
  if (o.help) return done({ tool: "sova-spec", command: "where", exit: 0, status: "done", budget,
    help: "where <path|token> [--token] [--all] [--json] [--budget BYTES] [--cursor TOKEN] [--root DIR] [--spec DIR]; top 10 unless --all; default budget 12000, supported 1024..32768" });
  if (o.usage || o.pos.length !== 1 || !o.pos[0].trim()) return done(boundedRefusal("where", budget, "usage", { message: o.usage ?? "where takes one path or token" }));
  const g = openSpec(o, core);
  if (g.refused) return done(refuse("where", budget, g));
  const ix = indexOf(g.ctx, core.parentOf), query = o.pos[0];
  const path = posix.normalize(query.split("\\").join("/")).replace(/^\.\//, "");
  let mode = "token", read = {}, r;
  if (!o.token) {
    try { read = { state: "read", text: core.readSource(g.root, path) }; } catch (e) { read = { state: e.code ?? "unreadable" }; }
    if (ix.code.has(path) || read.state === "read") mode = "path";
  }
  if (mode === "path") r = byPath(ix, path, read);
  else r = byToken(ix, query.trim());
  const total = r.list.length, full = o.all ? r.list : r.list.slice(0, TOP);
  const head = { tool: "sova-spec", command: "where", budget, query: mode === "path" ? path : query.trim(), mode, all: !!o.all,
    ...(mode === "path" ? { file: { path, state: read.state, mapped: ix.code.has(path) } } : {}), ...(mode === "token" && !o.token && /^[\w.-][^\s]*\/[^\s/]+\.[A-Za-z0-9]+$/.test(path) ? { pathLike: true } : {}), counts: r.counts, total, shown: full.length };
  const unknown = mode === "path" ? read.state !== "read" || !r.counts.claims : !r.counts.claims;
  const fp = fingerprintOf({ root: g.root, spec: o.spec, head, list: full });
  return paged({ command: "where", o, fp, list: full, render: renderWhere,
    build: (lines, at, next) => ({ ...head, exit: at < full.length || unknown ? 1 : 0, ...pageFields(full, lines, at, next), notice: WHERE_NOTICE }) });
}
