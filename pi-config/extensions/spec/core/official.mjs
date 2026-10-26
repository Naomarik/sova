// Whether a draft is official: the one rule the draft tool's `drafts` and `prune --official` and a host's own
// readiness call (see DRAFTS.md, "Official"). Node builtins and this directory only; files alone, no Git, no process.
//
// A draft is official in a work tree when every claim it changed reads, in that tree's current spec, what the draft
// says or what a promotion recorded in that tree wrote for it, other than what the draft started from; prose also
// counts when its blocks carry the draft's change, as a Git merge of another change to the same claim leaves it. A
// claim is a unit of one spec file: `r:§id` a record (in manifest.json, or a format 2 record file), `m:key` another manifest key, `t:§id` a
// declaration's prose span, and `f:<file>` a file's non-blank lines outside every declaration (a whole file that is
// neither). Each promotion receipt records `claims`: {unit: [hash the draft said, hash written]}; a receipt without
// it counts, for the ids and files it names, what its own draft now says.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { declarationSpans } from "./sova-spec.mjs";
import { ROOT_FILE, assemble, isRecordFile } from "./layout.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const obj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : obj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
const readOr = (p) => { try { return readFileSync(p); } catch { return null; } };

// One declaration's lines grouped into blocks, the units a Git merge driver merges a declaration by when both sides
// changed it: a list item with its wrapped lines (a nested item starts its own), a table row, a heading, a fenced
// block's lines one by one, a paragraph, a blank line. → [block text without its last newline] | null (can't)
export function blocksOf(text) {
  if (text.includes("\uE000") || text.includes("\uE001") || !text.endsWith("\n")) return null;
  const out = []; let fence = false, open = false;
  for (const l of text.slice(0, -1).split("\n")) {
    const isFence = /^\s*(```|~~~)/.test(l);
    const starts = fence || isFence || !l.trim() || /^\s*([-*+]|\d+[.)])\s/.test(l) || /^\s*\|/.test(l) || /^#{1,6}\s/.test(l);
    if (isFence) fence = !fence;
    if (open && !starts) out[out.length - 1] += "\n" + l;
    else out.push(l);
    open = !isFence && !fence && !!l.trim() && !/^#{1,6}\s/.test(l) && !/^\s*\|/.test(l);
  }
  return out;
}

/** One spec file cut into claims: units (unit → hash) and each declaration's prose (unit → text). Absent file: none. */
function cut(rel, buf) {
  const units = new Map(), texts = new Map();
  if (!buf) return { units, texts };
  // Records, in either layout (layout.mjs): the root file's settings and, in format 1, its records; a format 2
  // record file beside a claim file holds records only.
  if (rel === ROOT_FILE || isRecordFile(rel)) {
    let v = null;
    try { v = JSON.parse(buf.toString("utf8")); } catch {}
    if (obj(v)) {
      const { meta, records } = rel === ROOT_FILE ? assemble(v) : { meta: {}, records: v };
      for (const [k, x] of Object.entries(meta)) units.set(`m:${k}`, sha(JSON.stringify(sortKeys(x))));
      for (const [id, rec] of Object.entries(records)) units.set(`r:${id}`, sha(JSON.stringify(sortKeys(rec))));
      return { units, texts };
    }
  } else if (rel.endsWith(".md")) {
    const lines = buf.toString("utf8").split(/\r?\n/), inSpan = new Array(lines.length).fill(false);
    for (const d of declarationSpans(lines.join("\n"))) {
      const text = lines.slice(d.lines[0] - 1, d.lines[1]).join("\n") + "\n";
      units.set(`t:${d.id}`, sha(text));
      texts.set(`t:${d.id}`, text);
      for (let i = d.lines[0] - 1; i < d.lines[1]; i++) inSpan[i] = true;
    }
    units.set(`f:${rel}`, sha(lines.filter((l, i) => !inSpan[i] && l.trim()).join("\n")));
    return { units, texts };
  }
  units.set(`f:${rel}`, sha(buf));
  return { units, texts };
}
/** One spec file's claims, unit → hash (absent file: none). */
export const claimUnits = (rel, buf) => cut(rel, buf).units;

/** The units `prop` changes from `base` in one file → [unit]. */
const changedUnits = (b, p) => [...new Set([...b.keys(), ...p.keys()])].filter((k) => b.get(k) !== p.get(k)).sort();

/** Whether prose `c` carries the change from `b` to `p`: each block `p` added is there, each it removed is gone. */
function carries(b, c, p) {
  const [B, C, P] = [b ?? "", c, p].map((t) => blocksOf(t));
  if (!B || !C || !P) return false;
  const n = (xs, x) => xs.filter((y) => y === x).length;
  return [...new Set([...B, ...P])].every((x) => { const d = n(P, x) - n(B, x); return d === 0 || (d > 0 ? n(C, x) >= n(P, x) : n(C, x) <= n(P, x)); });
}

/** What a promotion of one file records: {unit: [said, wrote]} for each unit the draft changed there. */
export function promotionClaims(rel, baseBuf, propBuf, wroteBuf) {
  const b = claimUnits(rel, baseBuf), p = claimUnits(rel, propBuf), w = claimUnits(rel, wroteBuf);
  return Object.fromEntries(changedUnits(b, p).map((k) => [k, [p.get(k) ?? null, w.get(k) ?? null]]));
}

function filesUnder(dir, rel = "") {
  let entries;
  try { entries = readdirSync(join(dir, rel), { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((e) => { const r = rel ? `${rel}/${e.name}` : e.name; return e.isDirectory() ? filesUnder(dir, r) : e.isFile() ? [r] : []; });
}
const idOf = (unit) => (/^[rt]:/.test(unit) ? unit.slice(2) : null);
const draftJson = (dir) => { try { const d = JSON.parse(readFileSync(join(dir, "draft.json"), "utf8")); return obj(d) ? d : null; } catch { return null; } };

/**
 * Whether the draft in `draftDir` is official against the spec in `specDir`, counting the promotion receipts of every
 * draft in `draftsDir` (its own included). → undefined (not a readable draft) | {official, changed: how many claims it
 * changed, notOfficial: [§ id], read: [every path it read]}; a unit outside any § (a manifest key, a file's lines
 * outside its declarations) that isn't official makes the draft not official without naming an id.
 */
export function draftOfficial(specDir, draftDir, draftsDir) {
  const d = draftJson(draftDir);
  if (!d || !obj(d.base?.files)) return undefined;
  const own = join(draftDir, "spec"), base = join(draftDir, "base");
  let others = [];
  try { others = readdirSync(draftsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => join(draftsDir, e.name)).filter((x) => x !== draftDir); } catch {}
  const receipts = [{ d, mine: true }, ...others.map((dir) => ({ dir, d: draftJson(dir) }))].filter((x) => Array.isArray(x.d?.promotions));
  const read = [join(draftDir, "draft.json"), ...others.map((x) => join(x, "draft.json"))], notOfficial = new Set();
  let official = true, changed = 0, recs = null;
  const curRecords = () => {
    if (recs) return recs;
    recs = new Map();
    for (const rel of [ROOT_FILE, ...filesUnder(specDir, "claims").filter((f) => isRecordFile(f))]) {
      read.push(join(specDir, rel));
      for (const [k, h] of claimUnits(rel, readOr(join(specDir, rel)))) if (k.startsWith("r:")) recs.set(k, h);
    }
    return recs;
  };
  for (const rel of [...new Set([...filesUnder(own), ...Object.keys(d.base.files)])].sort()) {
    const mine = readOr(join(own, rel));
    if ((mine ? sha(mine) : undefined) === d.base.files[rel]) continue; // not changed by this draft
    read.push(join(own, rel), join(base, rel), join(specDir, rel));
    const [p, b, cur] = [mine, readOr(join(base, rel)), readOr(join(specDir, rel))].map((buf) => cut(rel, buf));
    // Every unit hash a promotion in this tree wrote in this file: its own only as the draft still says it; another's
    // receipt from before claims were recorded, as that draft says it now, for the ids it names.
    const wrote = new Set(), add = (k, h) => h && wrote.add(`${k}\0${h}`);
    for (const { dir, d: w, mine: self } of receipts) {
      let theirs = null;
      for (const pr of w.promotions) {
        const said = pr?.claims; // the receipt's {unit: [said, wrote]}, not spec records
        if (obj(said)) { for (const [k, v] of Object.entries(said)) if (Array.isArray(v) && (!self || v[0] === (p.units.get(k) ?? null))) add(k, v[1]); continue; }
        if (self || !Array.isArray(pr?.files) || !pr.files.includes(rel)) continue;
        if (!theirs) { read.push(join(dir, "spec", rel)); theirs = claimUnits(rel, readOr(join(dir, "spec", rel))); }
        const ids = new Set(Array.isArray(pr.ids) ? pr.ids : []);
        for (const [k, h] of theirs) if (!idOf(k) || ids.has(idOf(k))) add(k, h);
      }
    }
    for (const k of changedUnits(b.units, p.units)) {
      changed++;
      // A write the draft started from (an earlier promotion its baseline already had) speaks for nothing it changed.
      // A record reads wherever current keeps it (format 1's manifest.json or a format 2 record file).
      const c = k.startsWith("r:") ? curRecords().get(k) : cur.units.get(k);
      if (c === p.units.get(k) || (c && c !== b.units.get(k) && wrote.has(`${k}\0${c}`))) continue;
      if (c && p.texts.has(k) && carries(b.texts.get(k), cur.texts.get(k), p.texts.get(k))) continue;
      official = false;
      if (idOf(k)) notOfficial.add(idOf(k));
    }
  }
  return { official, changed, notOfficial: [...notOfficial].sort(), read };
}
