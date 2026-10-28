// layout: the one reader and writer of a spec's records, in either layout. Node stdlib only; it never writes a file
// itself (serialize returns bytes, the caller writes them).
//   Layout 1 (formatVersion 1): manifest.json holds the project settings and every record under `claims`.
//   Layout 2 (formatVersion 2): manifest.json holds the settings and `"claims": CLAIMS_POINTER` (a string, so an older
//     branch's merge-manifest driver refuses it and Git reports a conflict instead of a quiet merge); each area's
//     records sit beside its claim file, claims/<path>.json beside claims/<path>.md, where <path> comes from the id
//     exactly as the claim file does. A record file is a plain JSON object of § id → record, ids in code-point order,
//     2-space indent and a trailing newline; an area with no records has no record file.
// A spec that holds records both ways is mixed: every reader refuses it with the one command that finishes it.
import { readFileSync, readdirSync, lstatSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, posix } from "node:path";

export const ROOT_FILE = "manifest.json";
export const CLAIMS_POINTER = "records live beside each claim file, in claims/**/*.json";
export const DEFAULT_SPEC = ".sova/spec";
const ID_RE = /^§[a-z][a-z-]*(?:\.[a-z][a-z-]*)?\/[a-z][a-z-]*$/;
const obj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const toPosix = (p) => String(p).split("\\").join("/");
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : obj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
export const canonRecord = (v) => (v === undefined ? null : JSON.stringify(sortKeys(v)));
export const canonRecords = (records) => JSON.stringify(sortKeys(obj(records) ? records : Object.fromEntries(records ?? [])));
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- the root and placement
export const layoutOf = (rootObj) => (obj(rootObj) && rootObj.formatVersion === 2 ? 2 : 1);
export function claimsRootOf(rootObj) {
  const g = obj(rootObj) ? rootObj.grammar : undefined;
  const c = (obj(g) ? g.claimsRoot : undefined) ?? "claims/";
  if (typeof c !== "string" || !c || c.includes("\0")) return null;
  const n = posix.normalize(toPosix(c)).replace(/\/+$/, "");
  return !n || n === "." || n.startsWith("..") || n.startsWith("/") ? null : n;
}
export function dirKindsOf(rootObj) {
  const d = obj(rootObj) && obj(rootObj.grammar) ? rootObj.grammar.directoryKinds : undefined;
  return Array.isArray(d) ? d : ["section"];
}
// The claim file an id is declared in, relative to the claims root (the core's idToFile).
export function claimFileOf(id, dirKinds = ["section"]) {
  const [ns, name] = id.slice(1).split("/");
  const parts = ns.split(".");
  if (dirKinds.includes(parts[0])) return [...parts, `${name}.md`].join("/");
  return parts.length > 1 ? `${parts[0]}/${parts[1]}.md` : `${ns}/${name}.md`;
}
// The record file an id's record lives in (layout 2), relative to the claims root.
export const recordFileOf = (id, dirKinds = ["section"]) => claimFileOf(id, dirKinds).replace(/\.md$/, ".json");
// Is `rel` (relative to the spec directory) a layout-2 record file? A `.json` under the claims root.
export function isRecordFile(rel, claimsRoot = "claims") {
  const r = toPosix(rel);
  return r.startsWith(`${claimsRoot}/`) && r.endsWith(".json");
}
// Does the text look like a § record map (layout 1 never has one under claims/, so one there means mixed)?
function recordMapOf(text) {
  try { const v = JSON.parse(text); return obj(v) && Object.keys(v).some((k) => k.startsWith("§")) ? v : null; } catch { return null; }
}

// The one command that finishes a mixed spec: `where` = {root, draft?, merging?}.
export function mixedFix({ root, draft, merging } = {}) {
  const r = root ? ` --root ${JSON.stringify(root).slice(1, -1).includes(" ") ? JSON.stringify(root) : root}` : "";
  if (merging) return `sova-spec-draft.mjs merge-manifest${r} --write`;
  return `sova-spec-draft.mjs migrate${r}${draft ? ` --draft ${draft}` : ""} --write`;
}

// Order every record the way promotion would have put them into one list (layout 1's order for a fresh list):
// before the first record of the same area that sorts after it, else after that area's last; an area's first
// record before the first record whose area sorts after its own, or last. Records already there keep their place.
const areaOf = (id) => id.slice(0, id.indexOf("/") >>> 0);
export function withNewRecords(claims, added) {
  const keys = Object.keys(claims);
  for (const id of Object.keys(added).sort()) {
    const area = areaOf(id), own = keys.flatMap((k, i) => (areaOf(k) === area ? [i] : []));
    let at = own.length ? own.find((i) => keys[i] > id) ?? own.at(-1) + 1 : keys.findIndex((k) => areaOf(k) > area);
    if (at < 0) at = keys.length;
    keys.splice(at, 0, id);
  }
  return Object.fromEntries(keys.map((k) => [k, k in added ? added[k] : claims[k]]));
}

// withNewRecords({}, records) in O(n log n): areas in order, ids in order within each (what it gives a fresh list).
// Grouped by area, then the default sort (UTF-16 code units, as `<` compares), with no comparator to call.
export function freshOrder(records) {
  const byArea = new Map();
  for (const id of Object.keys(records)) {
    const a = areaOf(id), g = byArea.get(a);
    if (g) g.push(id); else byArea.set(a, [id]);
  }
  const out = {};
  for (const a of [...byArea.keys()].sort()) for (const id of byArea.get(a).sort()) out[id] = records[id];
  return out;
}

// ---------------------------------------------------------------- assemble (both readers end here)
// rootObj: the parsed manifest.json. recordTexts: Map(rel to the claims root → text) of every *.json under the claims
// root. claimFiles: the *.md files under the claims root (rel to it). fix: the mixed-layout fix text.
// → {layout, manifest (settings plus every record under `claims`, as layout 1 holds it), meta, records (object),
//    fileOf: Map(id → record file rel to the spec dir) | null, recordFiles: [rel to the spec dir], problems: [...]}
// Problems are {code, message, file?, id?}; every one is an error (a reader that meets one refuses the spec).
export function assemble(rootObj, recordTexts = new Map(), claimFiles = new Set(), { fix = mixedFix(), specRel = DEFAULT_SPEC } = {}) {
  const problems = [], layout = layoutOf(rootObj), croot = claimsRootOf(rootObj) ?? "claims", dirKinds = dirKindsOf(rootObj);
  const fixText = typeof fix === "function" ? fix : () => fix;
  const at = (rel) => `${specRel}/${croot}/${rel}`;
  const meta = Object.fromEntries(Object.entries(rootObj).filter(([k]) => k !== "claims"));
  const rels = [...recordTexts.keys()].sort(byCodePoint);
  if (layout === 1) {
    const stray = rels.filter((rel) => recordMapOf(recordTexts.get(rel)));
    if (stray.length) problems.push({ code: "layout-mixed", file: `${specRel}/${ROOT_FILE}`,
      message: `${specRel} holds records two ways: in manifest.json "claims" (format version 1) and in ${stray.length} per-area record file(s) (${stray.slice(0, 3).map(at).join(", ")}${stray.length > 3 ? ", …" : ""}); no tool reads a mixed spec. One command finishes it: ${fixText()}` });
    return { layout, manifest: rootObj, meta, records: obj(rootObj.claims) ? rootObj.claims : {}, fileOf: null, recordFiles: [], problems };
  }
  if (obj(rootObj.claims)) {
    problems.push({ code: "layout-mixed", file: `${specRel}/${ROOT_FILE}`,
      message: `${specRel} holds records two ways: format version 2 keeps them beside each claim file, but manifest.json "claims" holds ${Object.keys(rootObj.claims).length} record(s); no tool reads a mixed spec. One command finishes it: ${fixText()}` });
    return { layout, manifest: null, meta, records: {}, fileOf: new Map(), recordFiles: rels.map((r) => `${croot}/${r}`), problems };
  }
  if (typeof rootObj.claims !== "string")
    problems.push({ code: "manifest-unreadable", file: `${specRel}/${ROOT_FILE}`,
      message: `a format version 2 manifest.json keeps "claims": ${JSON.stringify(CLAIMS_POINTER)} (so an older merge driver stops with a conflict); it has ${rootObj.claims === undefined ? "none" : JSON.stringify(rootObj.claims)}` });
  const all = {}, fileOf = new Map();
  for (const rel of rels) {
    let v;
    try { v = JSON.parse(recordTexts.get(rel)); } catch (e) { problems.push({ code: "records-unreadable", file: at(rel), message: `${at(rel)}: ${e.message}` }); continue; }
    if (!obj(v)) { problems.push({ code: "records-unreadable", file: at(rel), message: `${at(rel)} is not an object of § id → record` }); continue; }
    const md = rel.replace(/\.json$/, ".md");
    if (!claimFiles.has(md)) problems.push({ code: "records-orphaned", file: at(rel), message: `${at(rel)} has no claim file ${at(md)} beside it; its records have no declarations` });
    for (const id of Object.keys(v)) {
      if (fileOf.has(id)) { problems.push({ code: "record-duplicate", id, file: at(rel), message: `${id} has a record in ${at(rel)} and in ${specRel}/${fileOf.get(id)}` }); continue; }
      if (ID_RE.test(id) && recordFileOf(id, dirKinds) !== rel)
        problems.push({ code: "record-misfiled", id, file: at(rel), message: `${id}'s record belongs in ${at(recordFileOf(id, dirKinds))}, not ${at(rel)}` });
      fileOf.set(id, `${croot}/${rel}`);
      all[id] = v[id];
    }
  }
  const records = freshOrder(all);
  const manifest = {};
  for (const [k, v] of Object.entries(rootObj)) manifest[k] = k === "claims" ? records : v;
  if (!("claims" in manifest)) manifest.claims = records;
  return { layout, manifest, meta, records, fileOf, recordFiles: rels.map((r) => `${croot}/${r}`), problems };
}

// ---------------------------------------------------------------- serialize
// The files a spec is written as, relative to the spec directory: Map(rel → string | null), null = delete.
// manifest: settings plus every record under `claims` (layout 1's shape; for layout 1, its key order is kept as is).
// prevRecordFiles: the record files the tree holds now (rel to the spec dir), so an emptied or moved one is deleted.
export function serialize(layout, manifest, { prevRecordFiles = [] } = {}) {
  const out = new Map();
  const croot = claimsRootOf(manifest) ?? "claims", dirKinds = dirKindsOf(manifest);
  if (layout === 1) {
    const m = { ...manifest, ...(obj(manifest.claims) ? {} : { claims: {} }) };
    if (m.formatVersion === 2) m.formatVersion = 1;
    out.set(ROOT_FILE, JSON.stringify(m, null, 2) + "\n");
    for (const rel of prevRecordFiles) out.set(rel, null);
    return out;
  }
  const records = obj(manifest.claims) ? manifest.claims : {};
  const root = {};
  for (const [k, v] of Object.entries(manifest)) root[k] = k === "claims" ? CLAIMS_POINTER : k === "formatVersion" ? 2 : v;
  if (!("formatVersion" in root)) Object.assign(root, { formatVersion: 2 });
  if (!("claims" in root)) root.claims = CLAIMS_POINTER;
  out.set(ROOT_FILE, JSON.stringify(root, null, 2) + "\n");
  const groups = new Map();
  for (const id of Object.keys(records)) {
    const rel = `${croot}/${recordFileOf(id, dirKinds)}`;
    if (!groups.has(rel)) groups.set(rel, {});
    groups.get(rel)[id] = records[id];
  }
  for (const rel of prevRecordFiles) if (!groups.has(rel)) out.set(rel, null);
  for (const rel of [...groups.keys()].sort(byCodePoint)) out.set(rel, recordFileText(groups.get(rel)));
  return out;
}
export function recordFileText(records) {
  const o = {};
  for (const id of Object.keys(records).sort(byCodePoint)) o[id] = records[id];
  return JSON.stringify(o, null, 2) + "\n";
}
// Layout 1 ↔ 2 for migrate: the files of the other layout, from one assembled manifest.
export const split = (manifest, prevRecordFiles = []) => serialize(2, manifest, { prevRecordFiles });
export const join1 = (manifest, prevRecordFiles = []) => serialize(1, manifest, { prevRecordFiles });

// ---------------------------------------------------------------- readers
export const hasSpec = (dir, specRel = DEFAULT_SPEC) => existsSync(join(dir, specRel, ROOT_FILE));
function parseRoot(text, specRel) {
  let m;
  try { m = JSON.parse(text); } catch (e) { return { problem: { code: "manifest-unreadable", file: `${specRel}/${ROOT_FILE}`, message: `manifest.json: ${e.message}` } }; }
  if (!obj(m)) return { problem: { code: "manifest-unreadable", file: `${specRel}/${ROOT_FILE}`, message: "manifest.json is not an object" } };
  if (m.formatVersion !== 2 && m.claims !== undefined && !obj(m.claims)) return { problem: { code: "manifest-unreadable", file: `${specRel}/${ROOT_FILE}`, message: "manifest.claims must be an object" } };
  return { m };
}
export const isMerging = (root) => spawnSync("git", ["-C", root, "rev-parse", "-q", "--verify", "MERGE_HEAD"], { stdio: "ignore", env: gitEnv() }).status === 0;
const draftOf = (specRel) => /^\.sova\/spec\/drafts\/([^/]+)\/(?:spec|base)$/.exec(toPosix(specRel))?.[1];
// The fix a reader names for a mixed spec at `specRel` (computed only when one is met).
export const fixFor = (root, specRel = DEFAULT_SPEC) => () => mixedFix({ root, draft: draftOf(specRel), merging: !draftOf(specRel) && isMerging(root) });

// The spec in a directory, read from disk. withProse adds claimBodies: Map(rel to the spec dir → text) of the *.md.
// → {state: "absent"} | {state: "present", rootText, layout, manifest, meta, records, fileOf, recordFiles, claimFiles,
//    claimBodies?, problems}. A symlink anywhere in the claims tree is a problem, never followed.
export function readSpecFs(root, specRel = DEFAULT_SPEC, { withProse = false, read = (rel) => readFileSync(join(root, rel), "utf8") } = {}) {
  const rootRel = `${specRel}/${ROOT_FILE}`;
  if (!existsSync(join(root, rootRel))) return { state: "absent" };
  const rootText = read(rootRel);
  const p = parseRoot(rootText, specRel);
  if (p.problem) return { state: "present", rootText, layout: 1, manifest: null, meta: {}, records: {}, fileOf: null, recordFiles: [], claimFiles: [], problems: [p.problem] };
  const croot = claimsRootOf(p.m) ?? "claims", problems = [];
  const recordTexts = new Map(), claimFiles = new Set(), claimBodies = new Map();
  const walk = (sub) => {
    let names;
    try { names = readdirSync(join(root, specRel, sub)).sort(); } catch { return; }
    for (const n of names) {
      const rel = `${sub}/${n}`, st = lstatSync(join(root, specRel, rel));
      if (st.isSymbolicLink()) { problems.push({ code: "symlink-refused", file: `${specRel}/${rel}`, message: `${specRel}/${rel} is a symlink` }); continue; }
      if (st.isDirectory()) walk(rel);
      else if (st.isFile() && n.endsWith(".json")) recordTexts.set(rel.slice(croot.length + 1), read(`${specRel}/${rel}`));
      else if (st.isFile() && n.endsWith(".md")) { claimFiles.add(rel.slice(croot.length + 1)); if (withProse) claimBodies.set(rel, read(`${specRel}/${rel}`)); }
    }
  };
  if (existsSync(join(root, specRel, croot))) walk(croot);
  const a = assemble(p.m, recordTexts, claimFiles, { fix: fixFor(root, specRel), specRel });
  return { state: "present", rootText, ...a, claimFiles: [...claimFiles].sort().map((f) => `${croot}/${f}`), ...(withProse ? { claimBodies } : {}), problems: [...problems, ...a.problems] };
}

function gitEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}
function git(root, args, input) {
  const r = spawnSync("git", ["-c", "core.fsmonitor=false", "-C", root, ...args], {
    shell: false, input, maxBuffer: 256 * 1024 * 1024, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env: gitEnv() });
  return r.error ? { status: null, err: r.error.code, out: Buffer.alloc(0) } : { status: r.status, out: r.stdout, err: String(r.stderr ?? "") };
}
// Blobs by "rev:path" in one `git cat-file --batch`. → Map(spec → string | null) | {error}
export function gitBlobs(root, specs) {
  const out = new Map();
  if (!specs.length) return out;
  const r = git(root, ["cat-file", "--batch"], specs.map((x) => `${x}\n`).join(""));
  if (r.status !== 0) return { error: `git cat-file: ${r.err.trim?.() ?? r.err}` };
  const buf = r.out;
  let at = 0;
  for (const x of specs) {
    const nl = buf.indexOf(10, at), head = buf.subarray(at, nl).toString("utf8").split(" ");
    at = nl + 1;
    if (head[1] === "missing" || head.length < 3) { out.set(x, null); continue; }
    const size = Number(head[2]);
    out.set(x, head[1] === "blob" ? buf.subarray(at, at + size).toString("utf8") : null);
    at += size + 1;
  }
  return out;
}
// The spec as committed at `commit` (any revision Git names; ":0" style index specs are not supported), read from
// Git objects: one cat-file for the root, one ls-tree of the claims root, one cat-file for every record file (and,
// with withProse, every claim file). prefix: the project root relative to the work-tree top.
// → {state: "absent"} | {state: "error", message} | the same shape as readSpecFs (claimBodies keyed rel to the project root)
export function readSpecGit(root, commit, { prefix = "", specRel = DEFAULT_SPEC, withProse = false, blobs = gitBlobs } = {}) {
  const P = prefix ? `${prefix}/` : "";
  const rootKey = `${commit}:${P}${specRel}/${ROOT_FILE}`;
  const got = blobs(root, [rootKey]);
  if (!(got instanceof Map)) return { state: "error", message: got.error };
  const rootText = got.get(rootKey);
  if (rootText == null) return { state: "absent" };
  const p = parseRoot(rootText, specRel);
  if (p.problem) return { state: "present", rootText, layout: 1, manifest: null, meta: {}, records: {}, fileOf: null, recordFiles: [], claimFiles: [], problems: [p.problem] };
  const croot = claimsRootOf(p.m) ?? "claims", base = `${specRel}/${croot}/`;
  const ls = git(root, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", `${P}${base}`]);
  if (ls.status !== 0) return { state: "error", message: `git ls-tree: ${String(ls.err).trim()}` };
  const problems = [], jsons = [], mds = [];
  for (const e of ls.out.toString("utf8").split("\0").filter(Boolean)) {
    const [m, full] = e.split("\t"), rel = P ? full.slice(P.length) : full;
    if (m.startsWith("120000")) problems.push({ code: "symlink-refused", file: rel, message: `${rel} is a symlink at ${String(commit).slice(0, 12)}; claims are never read through links` });
    else if (m.split(" ")[1] !== "blob") continue;
    else if (rel.endsWith(".json")) jsons.push(rel);
    else if (rel.endsWith(".md")) mds.push(rel);
  }
  jsons.sort(); mds.sort();
  const want = [...jsons, ...(withProse ? mds : [])];
  const bodies = blobs(root, want.map((f) => `${commit}:${P}${f}`));
  if (!(bodies instanceof Map)) return { state: "error", message: bodies.error };
  const text = (f) => bodies.get(`${commit}:${P}${f}`) ?? "";
  const recordTexts = new Map(jsons.map((f) => [f.slice(base.length), text(f)]));
  const claimFiles = new Set(mds.map((f) => f.slice(base.length)));
  const a = assemble(p.m, recordTexts, claimFiles, { fix: mixedFix({ root }), specRel });
  return { state: "present", rootText, ...a, claimFiles: mds.map((f) => f.slice(specRel.length + 1)),
    ...(withProse ? { claimBodies: new Map(mds.map((f) => [f, text(f)])) } : {}), problems: [...problems, ...a.problems] };
}

// Records only, for callers that need nothing else: the spec in a directory (or at a revision) as
// {layout, meta, records} | null when there is no spec. Throws an Error with .code on a problem (layout-mixed among them).
export function readRecords(root, { specRel = DEFAULT_SPEC, at, prefix = "" } = {}) {
  const s = at === undefined ? readSpecFs(root, specRel) : readSpecGit(root, at, { prefix, specRel });
  if (s.state === "absent") return null;
  if (s.state === "error") throw Object.assign(new Error(s.message), { code: "git-failed" });
  const bad = s.problems[0];
  if (bad) throw Object.assign(new Error(bad.message), { code: bad.code, problems: s.problems });
  return { layout: s.layout, meta: s.meta, records: s.records };
}
