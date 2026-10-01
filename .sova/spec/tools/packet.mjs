// Bounded stateless navigation over exact scope results. Node stdlib only; never reads or writes.
import { createHash } from "node:crypto";

export const PACKET_PARTS = ["prose", "inventory", "frontier", "code", "findings"];
export const PACKET_HELP = "packet §ns/name [--part prose|inventory|frontier|code|findings] [--cursor TOKEN] [--budget BYTES] [--root DIR] [--spec DIR] [--read-policy review]; default budget 12000, supported integers 1024..32768";
const NOTICE = "Declared labels and closure only; done is this stream, not completeness or proof of earlier reading. Code locations and provenance are not specifications or semantic coverage.";
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const serializePacket = (value) => JSON.stringify(value) + "\n";
const size = (value) => Buffer.byteLength(serializePacket(value));

export function packetBudget(raw) {
  if (raw === undefined) return 12000;
  return /^\d+$/.test(String(raw)) && Number.isSafeInteger(Number(raw)) && Number(raw) >= 1024 && Number(raw) <= 32768 ? Number(raw) : null;
}
export function packetError(code, budget = 1024) {
  return { tool: "sova-spec", command: "packet", exit: 2, status: "refused", budget, code };
}

// Orientation-only emission is not expansion. A later declared edge to that parent still expands it.
export function packetOrder(ctx, seed, passages, parentOf) {
  const byId = new Map(passages.map((p) => [p.id, p])), emitted = new Set(), queued = new Set([seed]);
  const queue = [seed], ordered = [];
  const emit = (id) => { if (byId.has(id) && !emitted.has(id)) { emitted.add(id); ordered.push(byId.get(id)); } };
  for (let n = 0; n < queue.length; n++) {
    const id = queue[n], parent = parentOf(id, ctx.dirKinds);
    if (id === seed) { emit(id); emit(parent); }
    else { emit(parent); emit(id); }
    const rec = ctx.claims.get(id);
    const nearby = rec.kind === "section" ? rec.members ?? [] : ctx.children.get(id) ?? [];
    for (const to of [...[...nearby].sort(), ...[...(rec.requires ?? [])].sort()]) {
      if (!ctx.claims.has(to) || queued.has(to)) continue;
      queued.add(to); queue.push(to);
    }
  }
  if (ordered.length !== passages.length) throw new Error("packet closure mismatch");
  return ordered;
}

const tokenFor = (fingerprint, part, index, offset) => Buffer.from(JSON.stringify([1, fingerprint, part, index, offset])).toString("base64url");
function decodeToken(raw) {
  if (typeof raw !== "string" || raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) return null;
    const token = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(token) || token.length !== 5 || token[0] !== 1 || !/^[a-f0-9]{64}$/.test(token[1]) ||
        !PACKET_PARTS.includes(token[2]) || !Number.isSafeInteger(token[3]) || !Number.isSafeInteger(token[4])) return null;
    // Tokens have a single canonical serialization, not merely a canonical base64 encoding.
    return tokenFor(...token.slice(1)) === raw ? token : null;
  } catch { return null; }
}
const boundary = (bytes, n) => n === 0 || n === bytes.length || (bytes[n] & 0xc0) !== 0x80;
const floorBoundary = (bytes, n) => { while (n > 0 && !boundary(bytes, n)) n--; return n; };

export function packetPage({ identity, inputs, result, findings, passages, part = "prose", cursor, budget }) {
  if (!PACKET_PARTS.includes(part)) return packetError("usage", budget);
  const streams = {
    prose: passages,
    inventory: passages.map(({ text, ...metadata }) => ({ ...metadata, bytes: Buffer.byteLength(text) })),
    frontier: result.frontier, code: result.code, findings,
  };
  const counts = Object.fromEntries(PACKET_PARTS.map((key) => [key, streams[key].length]));
  const fingerprint = digest({ identity, inputs, result, findings, streams });
  const records = streams[part], isProse = part === "prose";
  const source = (i) => Buffer.from(isProse ? records[i].text : JSON.stringify(records[i]));
  let index = 0, offset = 0;
  if (cursor !== undefined) {
    const token = decodeToken(cursor);
    if (!token) return packetError("token-malformed", budget);
    if (token[1] !== fingerprint || token[2] !== part) return packetError("token-mismatch-or-stale", budget);
    [index, offset] = token.slice(3);
    if (index < 0 || index >= records.length || offset < 0) return packetError("token-range", budget);
    const bytes = source(index);
    if (offset >= bytes.length || !boundary(bytes, offset)) return packetError("token-range", budget);
  }
  const warned = findings.some((f) => f.severity === "warn");
  const envelope = (items, at, byteOffset) => {
    const more = at < records.length;
    return { tool: "sova-spec", command: "packet", exit: more || warned ? 1 : 0, status: more ? "more" : "done",
      budget, id: identity.id, part, counts, remaining: records.length - at, items,
      next: more ? tokenFor(fingerprint, part, at, byteOffset) : null, notice: NOTICE };
  };
  const items = [];
  if (size(envelope(items, index, offset)) > budget) return packetError("budget-refused", budget);
  while (index < records.length) {
    const bytes = source(index), total = bytes.length;
    const item = (end, wholeRecord = false) => {
      if (!isProse && wholeRecord) return { index, value: records[index] };
      const fragment = { start: offset, end, total, complete: offset === 0 && end === total };
      const text = bytes.subarray(offset, end).toString("utf8");
      return isProse ? { index, id: records[index].id, kind: records[index].kind,
        ...(records[index].labels ? { labels: records[index].labels } : {}), text, fragment } : { index, json: text, fragment };
    };
    const fits = (entry, end) => size(envelope([...items, entry], end === total ? index + 1 : index, end === total ? 0 : end)) <= budget;
    const whole = item(total, !isProse && offset === 0);
    if (fits(whole, total)) { items.push(whole); index++; offset = 0; continue; }
    // Search byte positions, rounding down to scalar boundaries. Measurement includes escaped JSON and next.
    let low = offset + 1, high = total - 1, best = offset;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2), end = floorBoundary(bytes, mid);
      if (end <= offset) { low = mid + 1; continue; }
      if (fits(item(end), end)) { best = end; low = mid + 1; }
      else high = mid - 1;
    }
    if (best > offset) { items.push(item(best)); offset = best; }
    break;
  }
  if (!items.length && index < records.length) return packetError("budget-refused", budget);
  return envelope(items, index, offset);
}
