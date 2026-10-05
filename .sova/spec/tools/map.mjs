// Orientation: every area on one page (`map`), one namespace (`map ns`), or one area (`map §ns/name`).
// Node stdlib only; reads the parsed graph only and never writes.
import { whatOf, titleOf, fingerprintOf, boundedRefusal, emit } from "./toc.mjs";
import { lookArgs, idArg, openSpec, refuse, indexOf, namespaceOf, labelsOf, labelText, isInterface, paged, pageFields } from "./graph.mjs";

const MAP_NOTICE = "Computed from declared records and claim text; counts are declarations, never proof. Agreement (agreed, not built) is not recorded in this spec format yet.";
const AGREED = { code: "agreed-not-recorded", message: "agreed-not-built: not available (no agreed field yet)" };
const HUBS = 10;

// Counts by declared label over ids: {authority: {accepted: n}, evidence: {…}, unlabelled: n}.
function labelCounts(ctx, ids) {
  const c = { authority: {}, evidence: {}, unlabelled: 0 };
  for (const id of ids) {
    const r = ctx.claims.get(id);
    for (const k of ["authority", "evidence"]) if (r[k] !== undefined) c[k][r[k]] = (c[k][r[k]] ?? 0) + 1;
    if (r.authority === undefined && r.evidence === undefined) c.unlabelled++;
  }
  for (const k of ["authority", "evidence"]) c[k] = Object.fromEntries(Object.entries(c[k]).sort(([a], [b]) => (a < b ? -1 : 1)));
  return c;
}
const countsText = (c) => [...Object.entries(c.authority), ...Object.entries(c.evidence), ...(c.unlabelled ? [["unlabelled", c.unlabelled]] : [])]
  .map(([k, n]) => `${k} ${n}`).join(" · ") || "no labels";

// requires edges from ids to claims outside them, and from outside into them. → {out: [{from, to}], in: [...]}
function crossing(ix, ids) {
  const inside = new Set(ids), out = [], into = [];
  for (const id of ids) for (const to of [...new Set(ix.ctx.claims.get(id).requires ?? [])].sort()) if (!inside.has(to)) out.push({ from: id, to });
  for (const id of ids) for (const from of ix.rev.get(id) ?? []) if (!inside.has(from)) into.push({ from, to: id });
  into.sort((a, b) => (a.from + a.to < b.from + b.to ? -1 : 1));
  return { out, in: into };
}

function gaps(ix, ids) {
  const { ctx } = ix;
  return {
    uninvestigated: ids.filter((id) => ctx.claims.get(id).kind === "behavior" && ctx.claims.get(id).requires === undefined).length,
    noCode: ids.filter((id) => !(ctx.claims.get(id).code ?? []).length).length,
    noProse: ids.filter((id) => whatOf(ctx.decls.get(id)).whatSource === "none").length,
    noInterfaceToken: ids.filter((id) => !ix.ifaceOf(id).length).length,
  };
}
const gapsText = (g) => `gaps: ${g.uninvestigated} behavior(s) with no requires key · ${g.noCode} record(s) with no code · ${g.noProse} passage(s) with no prose sentence · ${g.noInterfaceToken} record(s) with no interface token`;

function hubs(ix, ids) {
  const inside = new Set(ids);
  return [...ix.code].map(([path, by]) => ({ path, records: by.filter((x) => inside.has(x)).length })).filter((h) => h.records)
    .sort((a, b) => b.records - a.records || (a.path < b.path ? -1 : 1)).slice(0, HUBS);
}

// The overview: one line per area, then the hubs.
function overview(ix, namespace) {
  const { ctx } = ix;
  const areas = ix.areas.filter((a) => !namespace || namespaceOf(a) === namespace);
  const ids = areas.flatMap((a) => ix.members.get(a));
  const namespaces = {};
  for (const a of areas) {
    const n = (namespaces[namespaceOf(a)] ??= { areas: 0, claims: 0 });
    n.areas++; n.claims += ix.members.get(a).length;
  }
  const list = areas.map((a) => {
    const d = ctx.decls.get(a), m = ix.members.get(a), x = crossing(ix, m);
    return { type: "area", id: a, namespace: namespaceOf(a), title: titleOf(d), ...whatOf(d), claims: m.length, labels: labelCounts(ctx, m),
      requiresOut: x.out.length, requiresIn: x.in.length };
  });
  for (const h of hubs(ix, ids)) list.push({ type: "hub", ...h });
  return { list, counts: { namespaces, areas: areas.length, claims: ids.length, labels: labelCounts(ctx, ids), gaps: gaps(ix, ids) } };
}

// One area: its claims, the edges crossing its boundary, the tokens it defines.
function area(ix, id) {
  const { ctx } = ix, m = ix.members.get(id), x = crossing(ix, m), inside = new Set(m);
  const list = m.map((c) => {
    const rec = ctx.claims.get(c);
    return { type: "claim", id: c, title: titleOf(ctx.decls.get(c)), kind: rec.kind, ...labelsOf(rec), code: (rec.code ?? []).length,
      requires: rec.requires === undefined ? null : rec.requires.length, requiredBy: (ix.rev.get(c) ?? []).length };
  });
  for (const e of x.out) list.push({ type: "out", ...e });
  for (const e of x.in) list.push({ type: "in", ...e });
  // Defined: an interface token in a claim's heading or first sentence, the claims elsewhere that use it counted.
  const defs = new Map();
  for (const c of m) {
    const what = whatOf(ctx.decls.get(c)).what;
    for (const s of ix.tokens.get(c)) if (isInterface(s.token) && (s.head || what.includes("`" + s.token)))
      defs.set(s.token, [...(defs.get(s.token) ?? []), c]);
  }
  for (const [token, by] of [...defs].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const elsewhere = ix.ids.filter((o) => !inside.has(o) && ix.tokens.get(o).some((s) => s.token === token)).length;
    list.push({ type: "token", token, definedBy: by, usedElsewhere: elsewhere });
  }
  const counts = { claims: m.length, labels: labelCounts(ctx, m), code: new Set(m.flatMap((c) => ctx.claims.get(c).code ?? [])).size,
    requiresOut: x.out.length, requiresIn: x.in.length, tokens: defs.size, gaps: gaps(ix, m) };
  return { list, counts };
}

const HEADS = { claim: "claims", out: "requires out of the area", in: "required from other areas", token: "interface tokens it defines (heading or first sentence)", hub: "hubs: the code files the most records list" };
export function renderMap(out) {
  const L = [], c = out.counts;
  if (out.area) {
    const a = out.area;
    L.push(`${a.id} — ${a.title}  ${c.claims} claim(s) · ${countsText(c.labels)} · ${c.code} code file(s) · requires out ${c.requiresOut} · in ${c.requiresIn}`, `  what: ${a.what}`);
  } else L.push(`map${out.namespace ? ` ${out.namespace}` : ""}: ${c.claims} claim(s) in ${c.areas} area(s), ${Object.keys(c.namespaces).length} namespace(s) · ${countsText(c.labels)}`);
  for (const n of out.notes) L.push(n.code === AGREED.code ? n.message : `note ${n.code}: ${n.message}`);
  let head = null, ns = null;
  for (const e of out.lines) {
    if (e.type === "area") {
      if (e.namespace !== ns) { ns = e.namespace; L.push(`${ns} (${c.namespaces[ns].areas} area(s), ${c.namespaces[ns].claims} claim(s))`); }
      L.push(`  ${e.id} — ${e.title}  ${e.claims} claim(s) · ${countsText(e.labels)} · requires out ${e.requiresOut} · in ${e.requiresIn}`, `    what: ${e.what}`);
      continue;
    }
    if (e.type !== head) { head = e.type; L.push(`${HEADS[head]}${out.area && head !== "claim" ? ` (${c[{ out: "requiresOut", in: "requiresIn", token: "tokens" }[head]]})` : ""}`); }
    if (e.type === "hub") L.push(`  ${e.path}  ${e.records}`);
    else if (e.type === "claim") L.push(`  ${e.id} — ${e.title}  ${e.kind} · ${labelText(e.labels)} · code ${e.code} · requires ${e.requires === null ? "uninvestigated" : e.requires} · required by ${e.requiredBy}`);
    else if (e.type === "out" || e.type === "in") L.push(`  ${e.from} → ${e.to}`);
    else if (e.type === "token") L.push(`  \`${e.token}\` — ${e.definedBy.join(", ")}${e.usedElsewhere ? ` · used by ${e.usedElsewhere} claim(s) elsewhere` : ""}`);
  }
  L.push(gapsText(c.gaps));
  L.push(`listed ${out.lines.length} · not listed ${out.remaining}`);
  if (out.next) L.push(`more: map${out.arg ? ` '${out.arg}'` : ""} --cursor ${out.next}`);
  L.push(`exit ${out.exit}`);
  return L.join("\n") + "\n";
}

export function mapMain(argv, core) {
  const o = lookArgs(argv, "map", { defaultBudget: 32768 });
  const done = (out) => emit(out, o.json, renderMap);
  const budget = o.budget ?? 1024;
  if (o.help) return done({ tool: "sova-spec", command: "map", exit: 0, status: "done", budget,
    help: "map [namespace | §ns/name] [--json] [--budget BYTES] [--cursor TOKEN] [--root DIR] [--spec DIR]; default budget 32768, supported 1024..32768" });
  if (o.usage || o.pos.length > 1) return done(boundedRefusal("map", budget, "usage", { message: o.usage ?? "map takes at most one namespace or §id" }));
  const raw = o.pos[0], id = raw?.startsWith("§") ? idArg(raw) : null;
  if (raw !== undefined && !id && !/^[a-z][a-z-]*$/.test(raw)) return done(boundedRefusal("map", budget, "usage", { message: `not a namespace or § identifier: ${raw}` }));
  const g = openSpec(o, core);
  if (g.refused) return done(refuse("map", budget, g));
  const ix = indexOf(g.ctx, core.parentOf), notes = [AGREED];
  if (id?.alias) notes.push({ code: "id-alias", message: `${id.alias} is not a § identifier; read as ${id.id}` });
  let r, areaId = null;
  if (id) {
    if (!g.ctx.claims.has(id.id) || !g.ctx.decls.has(id.id)) return done(boundedRefusal("map", budget, "unknown-id", { message: `${id.id} has no manifest record` }));
    areaId = ix.areaOf(id.id);
    if (areaId !== id.id) notes.push({ code: "area-of", message: `${id.id} is an H2: showing its area ${areaId}` });
    r = area(ix, areaId);
  } else {
    if (raw !== undefined && !ix.areas.some((a) => namespaceOf(a) === raw)) return done(boundedRefusal("map", budget, "unknown-namespace", { message: `no area in namespace ${raw}` }));
    r = overview(ix, raw);
  }
  const d = areaId && g.ctx.decls.get(areaId);
  const head = { tool: "sova-spec", command: "map", budget, ...(raw !== undefined ? { arg: raw } : {}), ...(raw !== undefined && !id ? { namespace: raw } : {}),
    ...(areaId ? { area: { id: areaId, title: titleOf(d), ...whatOf(d) } } : {}), counts: r.counts, notes };
  const fp = fingerprintOf({ root: g.root, spec: o.spec, head, list: r.list });
  return paged({ command: "map", o, fp, list: r.list, render: renderMap,
    build: (lines, at, next) => ({ ...head, exit: at < r.list.length ? 1 : 0, ...pageFields(r.list, lines, at, next), notice: MAP_NOTICE }) });
}
