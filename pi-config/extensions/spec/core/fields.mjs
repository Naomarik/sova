// Optional record fields: embeds (surfaces drawn inside a claim), core (the always-on frame) and about
// (a note → what it serves). Node stdlib only; reads the parsed graph, never writes. A spec whose records
// carry none of these fields gets no output from here, so every existing output stays unchanged.

export const FRAME_CAP = 12000;
const ID_LIST = ["embeds", "about"];

// Shape errors, checked with the record (a malformed field is a record error, like a malformed requires).
// bad(code, message, id) records the error; idRe is the core's § grammar.
export function fieldShape(rec, id, bad, idRe) {
  for (const key of ID_LIST) {
    if (rec[key] === undefined) continue;
    if (!Array.isArray(rec[key])) { bad("record-invalid", `${key} must be an array`, id); continue; }
    for (const t of rec[key]) if (typeof t !== "string" || !idRe.test(t)) bad("id-invalid", `${key} entry ${JSON.stringify(t)} is not a § identifier`, id);
  }
  if (rec.core !== undefined && typeof rec.core !== "boolean") bad("record-invalid", "core must be true or false", id);
}

// Targets that exist and are the right kind; the frame under its cap. add(severity, code, message, where).
export function checkFields(ctx, add) {
  for (const [id, r] of ctx.claims) {
    // A misplaced about is a misuse to report, not a malformed graph: it never blocks a read.
    if (r.about !== undefined && r.kind !== "note") add("warn", "about-not-note", `${id} is a ${r.kind}; about belongs on notes`, { id });
    for (const t of r.embeds ?? []) {
      if (!ctx.claims.has(t)) add("warn", "dangling-edge", `${id} embeds ${t}, which has no record`, { id });
      else if (ctx.claims.get(t).kind !== "surface") add("warn", "embeds-not-surface", `${id} embeds ${t}, a ${ctx.claims.get(t).kind}; embeds names surfaces`, { id });
    }
    for (const t of r.about ?? []) {
      if (!ctx.claims.has(t)) add("warn", "dangling-edge", `${id} about ${t}, which has no record`, { id });
      else if (!["surface", "behavior"].includes(ctx.claims.get(t).kind)) add("warn", "about-wrong-kind", `${id} about ${t}, a ${ctx.claims.get(t).kind}; about names a surface or behavior`, { id });
    }
  }
  frameFinding(frameOf(ctx), add);
}
export function frameFinding(frame, add) {
  if (frame?.overCap) add("warn", "frame-over-cap", `the frame (core: true records) is ${frame.bytes} B, over the ${FRAME_CAP} B cap; it is delivered whole`);
}

// ---------------------------------------------------------------- embeds
export const embedsOf = (ctx, id) => (ctx.claims.get(id)?.embeds ?? []).filter((t) => ctx.claims.has(t) && ctx.decls.has(t));
export const embeddedBy = (ctx, id) => [...ctx.claims].filter(([, r]) => (r.embeds ?? []).includes(id)).map(([k]) => k).sort();

// ---------------------------------------------------------------- about
// Notes whose about names one of targets: [{id: note, target}], by note id then target order.
export function aboutNotes(ctx, targets) {
  const out = [];
  for (const [id, r] of [...ctx.claims].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!Array.isArray(r.about) || !ctx.decls.has(id)) continue;
    const t = targets.find((x) => r.about.includes(x));
    if (t !== undefined) out.push({ id, target: t });
  }
  return out;
}

// ---------------------------------------------------------------- the frame
// Every core: true record with a span, in file and line order; an H1 gives its own span (its lede).
// → null when the spec flags none, else {passages, bytes, cap, overCap}.
export function frameOf(ctx) {
  const ids = [...ctx.claims].filter(([id, r]) => r.core === true && ctx.decls.has(id)).map(([id]) => id);
  if (!ids.length) return null;
  ids.sort((a, b) => {
    const x = ctx.decls.get(a), y = ctx.decls.get(b);
    return x.file < y.file ? -1 : x.file > y.file ? 1 : x.line - y.line;
  });
  const passages = ids.map((id) => {
    const d = ctx.decls.get(id), r = ctx.claims.get(id), labels = {};
    if (r.authority !== undefined) labels.authority = r.authority;
    if (r.evidence !== undefined) labels.evidence = r.evidence;
    return { id, kind: r.kind, ...(Object.keys(labels).length ? { labels } : {}), file: d.file, lines: d.lines, text: d.text };
  });
  const bytes = passages.reduce((n, p) => n + Buffer.byteLength(p.text), 0);
  return { passages, bytes, cap: FRAME_CAP, overCap: bytes > FRAME_CAP };
}
// What every response prints about the frame: never its text.
export const frameSummary = (frame) => (frame ? { passages: frame.passages.length, bytes: frame.bytes, cap: frame.cap, overCap: frame.overCap } : null);
export const frameLine = (s) => `frame: ${s.passages} passage(s), ${s.bytes} B of the ${s.cap} B cap${s.overCap ? " (OVER the cap, delivered whole)" : ""}: read it with read --frame`;
