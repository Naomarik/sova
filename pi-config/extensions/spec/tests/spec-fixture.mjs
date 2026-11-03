// Spec fixture writer for tests: one spec, written in either record layout. Node stdlib only.
//
//   writeSpec(root, { layout: 1|2, meta, records, claims, spec = ".sova/spec" })
//
// meta: every top-level manifest key except `claims` (formatVersion is set from layout).
// records: { "§id": record }. claims: { "<path under the claims root>.md": text }.
// Layout 1: manifest.json holds the records under `claims`, in the given order.
// Layout 2: manifest.json holds meta plus the CLAIMS_POINTER string; each record goes to
// <claimsRoot>/<path>.json beside <path>.md, ids sorted by code point, 2-space indent, trailing newline.
//
// The placement below is a second, independent copy of the core's idToFile on purpose: a test that
// compares the tools' own output with it cannot be satisfied by the tools agreeing with themselves.
// SPEC_TEST_LAYOUT=2 makes layoutFromEnv() return 2, for a second pass of a v1 suite.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

export const CLAIMS_POINTER = "records live beside each claim file, in claims/**/*.json";
export const layoutFromEnv = () => (process.env.SPEC_TEST_LAYOUT === "2" ? 2 : 1);

/** The claim file (without extension) an id lives in, relative to the claims root. */
export function areaPathOf(id, dirKinds = ["section"]) {
  const m = /^§([a-z][a-z-]*(?:\.[a-z][a-z-]*)?)\/([a-z][a-z-]*)$/.exec(id);
  if (!m) throw new Error(`not a § id: ${id}`);
  const parts = m[1].split(".");
  if (dirKinds.includes(parts[0])) return [...parts, m[2]].join("/");
  return parts.length > 1 ? `${parts[0]}/${parts[1]}` : `${parts[0]}/${m[2]}`;
}

/** Code-point order (never localeCompare). */
export const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const put = (root, rel, text) => { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
const claimsRootOf = (meta) => String(meta?.grammar?.claimsRoot ?? "claims/").replace(/\/+$/, "");

/** The record files of a layout-2 spec: { "<claimsRoot>/<path>.json": text }, relative to the spec dir. */
export function recordFiles(meta, records) {
  const dirKinds = meta?.grammar?.directoryKinds ?? ["section"];
  const byFile = new Map();
  for (const id of Object.keys(records)) {
    const rel = `${claimsRootOf(meta)}/${areaPathOf(id, dirKinds)}.json`;
    if (!byFile.has(rel)) byFile.set(rel, []);
    byFile.get(rel).push(id);
  }
  const out = {};
  for (const [rel, ids] of [...byFile].sort(([a], [b]) => byCodePoint(a, b))) {
    const obj = {};
    for (const id of ids.sort(byCodePoint)) obj[id] = records[id];
    out[rel] = JSON.stringify(obj, null, 2) + "\n";
  }
  return out;
}

/** The manifest.json text of a spec in a layout. */
export function manifestText(layout, meta = {}, records = {}) {
  const { claims: _drop, formatVersion: _v, ...rest } = meta;
  const m = layout === 2 ? { formatVersion: 2, ...rest, claims: CLAIMS_POINTER } : { formatVersion: 1, ...rest, claims: records };
  return JSON.stringify(m, null, 2) + "\n";
}

export function writeSpec(root, { layout = 1, meta = {}, records = {}, claims = {}, spec = ".sova/spec" } = {}) {
  put(root, `${spec}/manifest.json`, manifestText(layout, meta, records));
  for (const [rel, text] of Object.entries(claims)) put(root, `${spec}/${claimsRootOf(meta)}/${rel}`, text);
  if (layout === 2) for (const [rel, text] of Object.entries(recordFiles(meta, records))) put(root, `${spec}/${rel}`, text);
  return root;
}
