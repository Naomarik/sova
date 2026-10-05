// One passage, exact, at its own size: no closure. Node stdlib only; never writes.
import { pullArgs, openGraph, titleOf, childrenInOrder, sizeOf, namedIn, kb, fingerprintOf, tokenFor, decodeToken,
  boundedRefusal, emit, sizeIn } from "./toc.mjs";

const READ_NOTICE = "One passage, exact scope text; nothing it requires, contains or mentions is delivered. The footer names those links. Finish fragments at end == total.";

const boundary = (bytes, n) => n === 0 || n === bytes.length || (bytes[n] & 0xc0) !== 0x80;
const floorBoundary = (bytes, n) => { while (n > 0 && !boundary(bytes, n)) n--; return n; };

function passage(ctx, id) {
  const d = ctx.decls.get(id), rec = ctx.claims.get(id);
  const labels = {};
  if (rec.authority !== undefined) labels.authority = rec.authority;
  if (rec.evidence !== undefined) labels.evidence = rec.evidence;
  return { id, kind: rec.kind, ...(Object.keys(labels).length ? { labels } : {}), title: titleOf(d), file: d.file, lines: d.lines, text: d.text };
}

// The § a passage links to (declared requires, then prose mentions) that the whole read does not deliver.
function namedNotRead(ctx, ids, delivered) {
  const out = [];
  for (const id of ids) {
    const rec = ctx.claims.get(id);
    for (const to of [...(rec.requires ?? []), ...namedIn(ctx.decls.get(id), id)])
      if (!delivered.has(to) && !out.includes(to)) out.push(to);
  }
  return out;
}

export function renderRead(out) {
  const L = [];
  for (const p of out.items) {
    const f = p.fragment, lb = p.labels ? `; ${[p.labels.authority ?? "-", p.labels.evidence ?? "-"].join("/")}` : "";
    const part = f.complete ? kb(f.total) : `bytes ${f.start}-${f.end} of ${f.total}`;
    L.push(`── ${p.id} — ${p.title} [${p.kind}${lb}] ${p.file}:${p.lines[0]}-${p.lines[1]} (${part})`, p.text.replace(/\n$/, ""));
  }
  L.push(`named here, not delivered by this read: ${out.footer.named.join(", ") || "none"}`);
  if (out.footer.children) L.push(`its ${out.footer.children} H2 are not delivered (whole file ${kb(out.footer.wholeBytes)}): read '${out.id}' --whole, or toc '${out.id}' --dir down`);
  if (out.next) L.push(`${out.remaining} passage(s) not finished: read '${out.id}'${out.whole ? " --whole" : ""} --cursor ${out.next}`);
  L.push(`exit ${out.exit}`);
  return L.join("\n") + "\n";
}

export function readMain(argv, core) {
  const o = pullArgs(argv, "read"), budget = o.budget ?? 1024;
  const done = (out) => emit(out, o.json, renderRead);
  if (o.help) return done({ tool: "sova-spec", command: "read", exit: 0, status: "done", budget,
    help: "read §id [--whole] [--json] [--budget BYTES] [--cursor TOKEN] [--root DIR] [--spec DIR]; an H1 gives its lede unless --whole; default budget 32768, supported 1024..32768" });
  if (o.usage) return done(boundedRefusal("read", budget, "usage", { message: o.usage }));
  const g = openGraph(o, core);
  if (g.refused) return done(boundedRefusal("read", budget, g.refused, { ...(g.cause ? { cause: g.cause } : {}), ...(g.message ? { message: g.message } : {}) }));
  const { ctx, root } = g;
  const kids = ctx.decls.get(o.id).level === 1 ? childrenInOrder(ctx, o.id) : [];
  const whole = !!o.whole && ctx.decls.get(o.id).level === 1;
  const ids = whole ? [o.id, ...kids] : [o.id];
  const records = ids.map((id) => passage(ctx, id)), delivered = new Set(ids);
  const fp = fingerprintOf({ root, spec: o.spec, id: o.id, whole, records });
  let index = 0, offset = 0;
  if (o.cursor !== undefined) {
    const t = decodeToken(o.cursor, fp, "read");
    if (t.code) return done(boundedRefusal("read", budget, t.code));
    ({ index, offset } = t);
    const bytes = index >= 0 && index < records.length ? Buffer.from(records[index].text) : null;
    if (!bytes || offset < 0 || offset >= bytes.length || !boundary(bytes, offset)) return done(boundedRefusal("read", budget, "token-range"));
  }
  const envelope = (items, at, byteOffset) => {
    const more = at < records.length;
    const shown = [...new Set(items.map((p) => p.id))];
    return { tool: "sova-spec", command: "read", exit: more ? 1 : 0, status: more ? "more" : "done", budget, id: o.id, whole,
      ...(o.alias ? { alias: o.alias } : {}), counts: { passages: records.length }, remaining: records.length - at, items,
      footer: { named: namedNotRead(ctx, shown, delivered), ...(kids.length && !whole ? { children: kids.length, wholeBytes: sizeOf(ctx, o.id).whole } : {}) }, next: more ? tokenFor(fp, "read", at, byteOffset) : null, notice: READ_NOTICE };
  };
  const size = (out) => sizeIn(out, o.json, renderRead);
  const items = [];
  if (size(envelope(items, index, offset)) > budget) return done(boundedRefusal("read", budget, "budget-refused"));
  while (index < records.length) {
    const r = records[index], bytes = Buffer.from(r.text), total = bytes.length;
    const item = (end) => {
      const { text, ...meta } = r;
      return { index, ...meta, text: bytes.subarray(offset, end).toString("utf8"), fragment: { start: offset, end, total, complete: offset === 0 && end === total } };
    };
    const fits = (it, end) => size(envelope([...items, it], end === total ? index + 1 : index, end === total ? 0 : end)) <= budget;
    if (fits(item(total), total)) { items.push(item(total)); index++; offset = 0; continue; }
    let low = offset + 1, high = total - 1, best = offset;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2), end = floorBoundary(bytes, mid);
      if (end <= offset) { low = mid + 1; continue; }
      if (fits(item(end), end)) { best = end; low = mid + 1; } else high = mid - 1;
    }
    if (best > offset) { items.push(item(best)); offset = best; }
    break;
  }
  if (!items.length && index < records.length) return done(boundedRefusal("read", budget, "budget-refused"));
  return done(envelope(items, index, offset));
}
