#!/usr/bin/env node
// sova-spec: read-only core for a project's .sova/spec. Node stdlib only; never writes.
// Commands: check | scope §id | impact §id | census [--changed [--base REV]].  Flags: --root DIR, --spec DIR, --json, --budget BYTES.
// Exit: 0 usable known closure (never completeness), 1 relevant unknown/stale/unread, 2 untrustworthy.
import { readFileSync, readdirSync, lstatSync, existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname, relative, posix } from "node:path";

const ID_SRC = String.raw`§[a-z][a-z-]*(?:\.[a-z][a-z-]*)?/[a-z][a-z-]*`;
const ID_RE = new RegExp(`^${ID_SRC}$`);
const KINDS = ["surface", "behavior", "section", "note"];
// Optional declared labels. Reported verbatim; never derived, never proof, never change the exit.
const LABELS = { authority: ["candidate", "migrated", "accepted"], evidence: ["unreviewed", "reviewed", "verified"] };
const DEFAULT_SPEC = ".sova/spec";
const NOTICE = "Known declared closure only. A behavior without requires is uninvestigated; [] means none declared. " +
  "Code paths are evidence locations, not specifications. Incumbent citations and hashes are provenance, never semantic coverage. " +
  "authority/evidence labels are declared status, never verified by this tool.";

// ---------------------------------------------------------------- findings
const findings = [];
const add = (severity, code, message, where = {}) => findings.push({ severity, code, message, ...where });
const exitOf = (fs) => (fs.some((f) => f.severity === "error") ? 2 : fs.some((f) => f.severity === "warn") ? 1 : 0);

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const o = { json: false, pos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--changed") o.changed = true;
    else if (a === "--root" || a === "--spec" || a === "--budget" || a === "--base") {
      if (i + 1 >= argv.length) { o.usage = `${a} needs a value`; break; }
      o[a.slice(2)] = argv[++i];
    } else if (a === "--help" || a === "-h") o.help = true;
    else if (a.startsWith("-")) o.usage ??= `unknown flag ${a}`;
    else o.pos.push(a);
  }
  if (o.usage || o.help) return o;
  const [cmd, ...rest] = o.pos;
  o.cmd = cmd;
  const arity = { check: 0, census: 0, scope: 1, impact: 1 }[cmd];
  if (arity === undefined) o.usage = cmd ? `unknown command ${cmd}` : "missing command";
  else if (rest.length !== arity) o.usage = `${cmd} takes ${arity ? "one §id" : "no arguments"}`;
  else if (arity && !ID_RE.test(rest[0])) o.usage = `not a § identifier: ${rest[0]}`;
  else o.id = rest[0];
  if (!o.usage && o.spec !== undefined) {
    const s = specDir(o.spec);
    if (s.why) o.usage = `--spec ${JSON.stringify(o.spec)}: ${s.why}`;
    else o.spec = s.rel;
  }
  if (!o.usage && o.budget !== undefined) {
    if (cmd !== "scope") o.usage = "--budget applies to scope only";
    else if (!/^\d+$/.test(o.budget) || !Number.isSafeInteger(Number(o.budget))) o.usage = "--budget takes a non-negative integer byte count";
    else o.budget = Number(o.budget);
  }
  if (!o.usage && o.base !== undefined && !o.changed) o.usage = "--base applies to census --changed only";
  if (!o.usage && o.changed && cmd !== "census") o.usage = "--changed applies to census only";
  return o;
}
const USAGE = "usage: sova-spec <check | scope §id | impact §id | census [--changed [--base REV]]> [--root DIR] [--spec DIR] [--json] [--budget BYTES]";

// --spec: a project-relative directory holding manifest.json (default .sova/spec). → {rel} | {why}
function specDir(raw) {
  if (typeof raw !== "string" || !raw || raw.includes("\0")) return { why: "not a path" };
  const t = toPosix(raw);
  if (t.startsWith("/") || /^[a-zA-Z]:/.test(t)) return { why: "must be relative to the project root" };
  if (t.split("/").includes("..")) return { why: "must not contain .." };
  const rel = posix.normalize(t).replace(/\/+$/, "");
  if (!rel || rel === ".") return { why: "must name a directory below the project root" };
  return { rel };
}

// ---------------------------------------------------------------- paths
const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const toPosix = (p) => p.split("\\").join("/");
// First symlinked segment of rel under root, or null.
const linkOnPath = (root, rel) => {
  let cur = root;
  for (const seg of rel.split("/").filter(Boolean)) { cur = join(cur, seg); if (isLink(cur)) return toPosix(relative(root, cur)); }
  return null;
};
const tryRead = (fn, onFail) => { try { return fn(); } catch (e) { onFail(e.code ?? e.message); return null; } };

// Resolve a project-relative path without leaving root or crossing a symlink.
// → {state: present|missing|refused|not-file, abs?, why?}
function safePath(root, rel) {
  if (typeof rel !== "string" || !rel || rel.includes("\0")) return { state: "refused", why: "not a path string" };
  if (rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) return { state: "refused", why: "absolute path" };
  const norm = posix.normalize(toPosix(rel));
  if (norm === ".." || norm.startsWith("../")) return { state: "refused", why: "leaves the project root" };
  let cur = root;
  for (const seg of norm.split("/").filter((s) => s && s !== ".")) {
    cur = join(cur, seg);
    let st;
    try { st = lstatSync(cur); } catch (e) { return e.code === "ENOENT" || e.code === "ENOTDIR" ? { state: "missing", abs: cur } : { state: "unreadable", why: e.code, abs: cur }; }
    if (st.isSymbolicLink()) return { state: "refused", why: "symlink", abs: cur };
  }
  try { if (!lstatSync(cur).isFile()) return { state: "not-file", abs: cur }; } catch { return { state: "missing", abs: cur }; }
  return { state: "present", abs: cur };
}

// foldaidev idToFile, with directory-deep kinds as data.
function idToFile(id, dirKinds) {
  const [ns, name] = id.slice(1).split("/");
  const parts = ns.split(".");
  if (dirKinds.includes(parts[0])) return { file: [...parts, `${name}.md`].join("/"), level: 1 };
  return parts.length > 1 ? { file: `${parts[0]}/${parts[1]}.md`, level: 2 } : { file: `${ns}/${name}.md`, level: 1 };
}
const parentOf = (id, dirKinds) => {
  const [ns] = id.slice(1).split("/");
  const parts = ns.split(".");
  return parts.length > 1 && !dirKinds.includes(parts[0]) ? `§${parts[0]}/${parts[1]}` : null;
};

// ---------------------------------------------------------------- load
function findSpec(opt) {
  if (opt.root !== undefined) return resolve(opt.root);
  for (let d = process.cwd(); ; d = dirname(d)) {
    if (existsSync(join(d, opt.spec, "manifest.json"))) return d;
    if (dirname(d) === d) return null;
  }
}

function loadManifest(root, specRel) {
  // Every ancestor of the manifest, not only the last segments, must be a real directory.
  const link = linkOnPath(root, `${specRel}/manifest.json`);
  if (link) { add("error", "symlink-refused", `${link} is a symlink`, { file: link }); return null; }
  const mPath = join(root, specRel, "manifest.json");
  if (!existsSync(mPath)) { add("error", "manifest-not-found", `no ${specRel}/manifest.json under ${root}`); return null; }
  let m;
  try { m = JSON.parse(readFileSync(mPath, "utf8")); } catch (e) {
    add("error", "manifest-unreadable", `manifest.json: ${e.message}`, { file: `${specRel}/manifest.json` }); return null;
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) { add("error", "manifest-unreadable", "manifest.json is not an object"); return null; }
  const v1 = m.formatVersion === 1 || (m.formatVersion === undefined && m.schema === "sova-spec/pilot-manifest" && m.version === 1);
  if (!v1) { add("error", "manifest-version", `unsupported format (formatVersion ${JSON.stringify(m.formatVersion ?? m.version)}); this core reads version 1`); return null; }
  const g = m.grammar ?? {};
  if (g.id !== undefined && g.id !== ID_SRC) add("error", "grammar-unsupported", "grammar.id differs from the fixed § grammar; custom grammars are not read");
  if (g.fullToken === false) add("error", "grammar-unsupported", "grammar.fullToken false is not supported");
  const claimsRoot = g.claimsRoot ?? "claims/";
  const dirKinds = g.directoryKinds ?? ["section"];
  const croot = typeof claimsRoot === "string" ? posix.normalize(toPosix(claimsRoot)).replace(/\/$/, "") : "";
  if (!croot || croot === "." || croot === ".." || croot.startsWith("../") || croot.startsWith("/") || /^[a-zA-Z]:/.test(croot))
    add("error", "grammar-invalid", "grammar.claimsRoot must be a relative directory inside .sova/spec");
  if (!Array.isArray(dirKinds) || !dirKinds.every((k) => typeof k === "string" && /^[a-z][a-z-]*$/.test(k)))
    add("error", "grammar-invalid", "grammar.directoryKinds must be an array of namespace names");
  if (m.resolution !== undefined) add("note", "resolution-ignored", "manifest `resolution` is derived data; it is ignored and recomputed from headings");
  if (!m.claims || typeof m.claims !== "object" || Array.isArray(m.claims)) { add("error", "manifest-unreadable", "manifest.claims must be an object"); return null; }
  return { m, specRel, claimsRel: `${specRel}/${croot}`, dirKinds: Array.isArray(dirKinds) ? dirKinds : [] };
}

function validateRecords(ctx) {
  const { m, dirKinds } = ctx;
  const claims = new Map();
  let ok;
  const bad = (code, msg, id) => { ok = false; add("error", code, msg, { id }); };
  const idList = (rec, key, id) => {
    if (rec[key] === undefined) return;
    if (!Array.isArray(rec[key])) return bad("record-invalid", `${key} must be an array`, id);
    for (const t of rec[key]) if (typeof t !== "string" || !ID_RE.test(t)) bad("id-invalid", `${key} entry ${JSON.stringify(t)} is not a § identifier`, id);
  };
  for (const id of Object.keys(m.claims).sort()) {
    const rec = m.claims[id];
    if (!ID_RE.test(id)) { add("error", "id-invalid", `record key ${JSON.stringify(id)} is not a § identifier`, { id }); continue; }
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) { add("error", "record-invalid", "record must be an object", { id }); continue; }
    if (!KINDS.includes(rec.kind)) { add("error", "kind-invalid", `kind must be one of ${KINDS.join("|")}`, { id }); continue; }
    ok = true;
    for (const [key, allowed] of Object.entries(LABELS))
      if (rec[key] !== undefined && !allowed.includes(rec[key])) bad("label-invalid", `${key} must be one of ${allowed.join("|")}`, id);
    const top = id.slice(1).split(/[./]/)[0];
    if ((dirKinds.includes(rec.kind) || dirKinds.includes(top)) && rec.kind !== top)
      bad("kind-mismatch", `kind ${rec.kind} does not match the ${dirKinds.includes(top) ? top : "surface"} namespace`, id);
    if (rec.kind === "surface" && idToFile(id, dirKinds).level !== 1) bad("kind-mismatch", "a surface must be an H1 identifier", id);
    idList(rec, "requires", id);
    idList(rec, "members", id);
    if (rec.members !== undefined && rec.kind !== "section") bad("record-invalid", "only sections have members", id);
    if (rec.code !== undefined && !(Array.isArray(rec.code) && rec.code.every((c) => typeof c === "string")))
      bad("record-invalid", "code must be an array of path strings", id);
    const span = (e) => e && typeof e.file === "string" && typeof (e.spanSha256 ?? e.hash) === "string" && Array.isArray(e.lines) &&
      e.lines.length === 2 && e.lines.every(Number.isInteger) && e.lines[0] >= 1 && e.lines[1] >= e.lines[0];
    if (rec.incumbent !== undefined && !(Array.isArray(rec.incumbent) && rec.incumbent.every(span)))
      bad("record-invalid", "incumbent must be an array of {file, lines: [a, b], spanSha256 | hash}", id);
    if (ok) claims.set(id, rec); // an invalid record never enters the graph; its error already makes the run exit 2
  }
  return claims;
}

// Walk claims/ and parse H1/H2 declarations. Fenced blocks never declare.
function scanDeclarations(root, ctx) {
  const decls = new Map();
  const croot = join(root, ctx.claimsRel);
  const link = linkOnPath(root, ctx.claimsRel);
  if (link) { add("error", "symlink-refused", `${link} is a symlink; claims are never read through links`, { file: link }); return decls; }
  if (!existsSync(croot)) { add("error", "claims-missing", `${ctx.claimsRel} does not exist`); return decls; }
  const files = [];
  const walk = (dir) => {
    const unreadable = (file) => (e) => add("error", "claims-unreadable", `${file}: ${e}`, { file });
    for (const n of tryRead(() => readdirSync(dir).sort(), unreadable(toPosix(relative(root, dir)))) ?? []) {
      const p = join(dir, n), rel = toPosix(relative(root, p)), st = tryRead(() => lstatSync(p), unreadable(rel));
      if (!st) continue;
      if (st.isSymbolicLink()) add("error", "symlink-refused", `${rel} is a symlink; claims are never read through links`, { file: rel });
      else if (st.isDirectory()) walk(p);
      else if (st.isFile() && n.endsWith(".md")) files.push(p);
    }
  };
  walk(croot);
  for (const abs of files) {
    const rel = toPosix(relative(root, abs));
    const inClaims = toPosix(relative(croot, abs));
    const body = tryRead(() => readFileSync(abs, "utf8"), (e) => add("error", "claims-unreadable", `${rel}: ${e}`, { file: rel }));
    if (body === null) continue;
    const lines = body.split(/\r?\n/);
    const heads = [];
    let fence = null;
    lines.forEach((ln, i) => {
      const f = /^ {0,3}(`{3,}|~{3,})/.exec(ln);
      if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !ln.trim().slice(f[1].length).trim()) fence = null; return; }
      if (f) { fence = f[1]; return; }
      const h = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/.exec(ln);
      if (!h) return;
      const level = h[1].length, line = i + 1, at = { file: rel, line };
      const tok = (h[2] ?? "").trim().split(/\s+/)[0];
      // H3+ is plain prose inside the enclosing H1/H2 span; it may never declare.
      if (level > 2) {
        if (tok.startsWith("§")) return add("error", "heading-level", `H${level} cannot declare ${tok}; only H1/H2 declare`, at);
        if (!heads.length) add("error", "heading-order", `H${level} precedes the file's H1 lede, so no passage contains it`, at);
        return;
      }
      if (!tok.startsWith("§")) return add("error", "heading-invalid", `H${level} does not declare a § identifier`, at);
      if (!ID_RE.test(tok)) return add("error", "id-invalid", `heading token ${tok} is not a full § identifier`, at);
      heads.push({ id: tok, level, line });
    });
    const first = lines.slice(0, (heads[0]?.line ?? lines.length + 1) - 1).findIndex((l) => l.trim());
    if (first >= 0) add("warn", "prose-outside-declaration", `text at line ${first + 1} precedes any § declaration, so no passage returns it`, { file: rel, line: first + 1 });
    const lede = heads[0]?.level === 1 ? heads[0].id : null;
    if (heads.length && !lede) add("error", "heading-order", "a claim file must open with its H1 lede", { file: rel, line: heads[0].line });
    heads.forEach((h, k) => {
      const at = { id: h.id, file: rel, line: h.line };
      const want = idToFile(h.id, ctx.dirKinds);
      if (want.file !== inClaims) add("error", "misfiled-declaration", `${h.id} resolves to ${ctx.claimsRel}/${want.file}`, at);
      else if (want.level !== h.level) add("error", "heading-level", `${h.id} must be an H${want.level}`, at);
      else if (h.level === 2 && parentOf(h.id, ctx.dirKinds) !== lede) add("error", "misfiled-declaration", `${h.id} is not a child of this file's lede`, at);
      if (decls.has(h.id)) return add("error", "duplicate-declaration", `${h.id} is also declared at ${decls.get(h.id).file}:${decls.get(h.id).line}`, at);
      // H1 lede ends before the first H2; an H2 ends before the next heading. Spans are disjoint.
      let end = (heads[k + 1]?.line ?? lines.length + 1) - 1;
      while (end > h.line && !lines[end - 1].trim()) end--;
      decls.set(h.id, { file: rel, line: h.line, level: h.level, lines: [h.line, end], text: lines.slice(h.line - 1, end).join("\n") + "\n" });
    });
  }
  return decls;
}

function load(root, specRel) {
  const ctx = loadManifest(root, specRel);
  if (!ctx) return null;
  ctx.root = root;
  ctx.claims = validateRecords(ctx);
  ctx.decls = scanDeclarations(root, ctx);
  for (const [id, d] of ctx.decls) if (!ctx.claims.has(id) && !Object.hasOwn(ctx.m.claims, id))
    add("error", "unrecorded-declaration", `${id} is declared but has no manifest record`, { id, file: d.file, line: d.line });
  for (const id of ctx.claims.keys()) if (!ctx.decls.has(id))
    add("error", "undeclared-record", `${id} has a record but no heading at ${ctx.claimsRel}/${idToFile(id, ctx.dirKinds).file}`, { id });
  ctx.children = new Map();
  for (const id of [...ctx.decls.keys()].sort()) {
    const p = ctx.decls.get(id).level === 2 ? parentOf(id, ctx.dirKinds) : null;
    if (p) ctx.children.set(p, [...(ctx.children.get(p) ?? []), id]);
  }
  return ctx;
}

// ---------------------------------------------------------------- per-record evidence
const sha = (s) => createHash("sha256").update(s).digest("hex");

function provenance(ctx, id) {
  const rec = ctx.claims.get(id);
  if (rec.incumbent === undefined) return { state: "unrecorded", entries: [] };
  const entries = rec.incumbent.map((e) => {
    const hash = e.spanSha256 ?? e.hash;
    const out = { file: e.file, lines: e.lines, ...(e.heading ? { heading: e.heading } : {}), ...(e.object ? { object: e.object } : {}) };
    const p = safePath(ctx.root, e.file);
    if (p.state !== "present") { add("warn", "provenance-stale", `incumbent ${e.file}: ${p.state}${p.why ? ` (${p.why})` : ""}`, { id }); return { ...out, state: p.state }; }
    const text = tryRead(() => readFileSync(p.abs, "utf8"), (err) => add("warn", "provenance-stale", `incumbent ${e.file}: unreadable (${err})`, { id }));
    if (text === null) return { ...out, state: "unreadable" };
    const cur = text.split(/\r?\n/);
    const [a, b] = e.lines, n = b - a + 1;
    if (b <= cur.length && sha(cur.slice(a - 1, b).join("\n")) === hash) return { ...out, state: "current-equal" };
    let best = null;
    for (let s = 0; s + n <= cur.length; s++)
      if (sha(cur.slice(s, s + n).join("\n")) === hash && (best === null || Math.abs(s + 1 - a) < Math.abs(best - a))) best = s + 1;
    if (best !== null) {
      add("warn", "provenance-moved", `incumbent ${e.file}:${a}-${b} text now at ${best}-${best + n - 1}`, { id });
      return { ...out, state: "span-moved", currentLines: [best, best + n - 1] };
    }
    add("warn", "provenance-stale", `incumbent ${e.file}:${a}-${b} no longer matches its recorded hash`, { id });
    return { ...out, state: "changed" };
  });
  return { state: entries.length ? "cited" : "uncited", entries, ...(rec.incumbentNote ? { note: rec.incumbentNote } : {}) };
}

// Union of code paths over ids, with safety state; each path checked once.
function codeUnion(ctx, ids) {
  const by = new Map();
  for (const id of ids) for (const c of ctx.claims.get(id)?.code ?? []) by.set(c, [...(by.get(c) ?? []), id]);
  return [...by.keys()].sort().map((path) => {
    const p = safePath(ctx.root, path);
    const claims = by.get(path);
    if (p.state !== "present") add("warn", `code-${p.state}`, `${path}: ${p.state}${p.why ? ` (${p.why})` : ""}`, { id: claims[0] });
    return { path, state: p.state, claims, ...(p.why ? { why: p.why } : {}) };
  });
}

// ---------------------------------------------------------------- commands
// {labels} only when the record declares one; absence is simply undeclared.
const labelsOf = (rec) => {
  const l = Object.fromEntries(Object.keys(LABELS).filter((k) => rec[k] !== undefined).map((k) => [k, rec[k]]));
  return Object.keys(l).length ? { labels: l } : {};
};

function scope(ctx, seed, budget) {
  const passages = new Map(), full = new Set(), frontier = [];
  const addFrontier = (f) => { if (!frontier.some((x) => x.id === f.id && x.reason === f.reason && x.of === f.of)) frontier.push(f); };
  const emit = (id, reason) => {
    if (!passages.has(id)) {
      const d = ctx.decls.get(id);
      passages.set(id, { id, kind: ctx.claims.get(id).kind, ...labelsOf(ctx.claims.get(id)), file: d.file, lines: d.lines, reasons: [], text: d.text });
    }
    const rs = passages.get(id).reasons;
    if (!rs.some((r) => r.reason === reason.reason && r.of === reason.of)) rs.push(reason);
  };
  const edge = (to, reason) => {
    if (!ctx.claims.has(to)) { add("warn", "dangling-edge", `${reason.of} → ${to} has no record`, { id: reason.of }); return addFrontier({ id: to, reason: "dangling", of: reason.of }); }
    visit(to, reason);
  };
  const visit = (id, reason) => {
    if (full.has(id)) return emit(id, reason);
    full.add(id);
    // The requested seed is always the first passage, so a budget can never spend it on orientation.
    // Any other child is preceded by its parent's orientation lede.
    const p = parentOf(id, ctx.dirKinds);
    if (reason.reason === "requested") emit(id, reason);
    if (p && ctx.claims.has(p) && !passages.has(p)) emit(p, { reason: "orientation", of: id });
    emit(id, reason);
    const rec = ctx.claims.get(id);
    if (rec.kind === "section") for (const m of [...(rec.members ?? [])].sort()) edge(m, { reason: "member", of: id });
    else for (const c of ctx.children.get(id) ?? []) visit(c, { reason: "child", of: id });
    if (rec.kind === "behavior" && rec.requires === undefined) {
      add("warn", "requires-uninvestigated", `${id} has no requires key: dependencies not investigated`, { id });
      addFrontier({ id, reason: "requires-uninvestigated" });
    }
    for (const r of [...(rec.requires ?? [])].sort()) edge(r, { reason: "requires", of: id });
  };
  visit(seed, { reason: "requested" });
  let list = [...passages.values()];
  for (const p of list) p.provenance = provenance(ctx, p.id);
  const code = codeUnion(ctx, list.map((p) => p.id));
  let used = 0;
  if (budget !== undefined) {
    const cut = list.findIndex((p) => (used + Buffer.byteLength(p.text) > budget ? true : ((used += Buffer.byteLength(p.text)), false)));
    if (cut >= 0) {
      const unread = list.slice(cut);
      list = list.slice(0, cut);
      for (const p of unread) addFrontier({ id: p.id, reason: "unread-budget", file: p.file, lines: p.lines, bytes: Buffer.byteLength(p.text) });
      add("warn", "budget-unread", `${unread.length} whole passage(s) left unread by --budget ${budget}`);
    }
  }
  return { passages: list, frontier, code, ...(budget !== undefined ? { budget: { bytes: budget, used } } : {}) };
}

function containersOf(ctx, ids) {
  const sections = [...ctx.claims].filter(([, r]) => r.kind === "section");
  const out = [], seen = new Set(), queue = [...ids];
  while (queue.length) {
    const id = queue.shift();
    const up = [];
    const p = parentOf(id, ctx.dirKinds);
    if (p && ctx.claims.has(p)) up.push({ id: p, relation: "parent", of: id });
    for (const [s, r] of sections) if ((r.members ?? []).includes(id)) up.push({ id: s, relation: "member", of: id });
    for (const c of up) {
      const k = `${c.id} ${c.relation} ${c.of}`;
      if (seen.has(k)) continue;
      seen.add(k); out.push(c); queue.push(c.id);
    }
  }
  return out;
}

function impact(ctx, seed) {
  const rev = new Map();
  for (const [id, r] of ctx.claims) for (const t of r.requires ?? []) rev.set(t, [...(rev.get(t) ?? []), id]);
  const depth = new Map([[seed, 0]]), consumers = [];
  for (let layer = [seed], d = 1; layer.length; d++) {
    const next = [];
    for (const t of layer) for (const c of (rev.get(t) ?? []).sort()) {
      if (depth.has(c)) { const x = consumers.find((k) => k.id === c); if (x && depth.get(t) === x.depth - 1 && !x.requires.includes(t)) x.requires.push(t); continue; }
      depth.set(c, d); next.push(c);
      const d0 = ctx.decls.get(c);
      consumers.push({ id: c, depth: d, requires: [t], ...labelsOf(ctx.claims.get(c)), file: d0?.file, lines: d0?.lines });
    }
    layer = next.sort();
  }
  consumers.sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : 1));
  const frontier = [];
  for (const [id, r] of ctx.claims) if (r.kind === "behavior" && r.requires === undefined && id !== seed) {
    frontier.push({ id, reason: "requires-uninvestigated", note: "undeclared dependencies: could be an unlisted consumer" });
    add("warn", "requires-uninvestigated", `${id} has no requires key; reverse impact cannot exclude it`, { id });
  }
  const ids = [seed, ...consumers.map((c) => c.id)];
  return { consumers, containers: containersOf(ctx, ids), frontier, code: codeUnion(ctx, ids) };
}

function check(ctx) {
  const frontier = [];
  for (const [id, r] of ctx.claims) {
    for (const key of ["requires", "members"]) for (const t of r[key] ?? []) if (!ctx.claims.has(t)) {
      add("warn", "dangling-edge", `${id} ${key} ${t}, which has no record`, { id });
      frontier.push({ id: t, reason: "dangling", of: id });
    }
    if (r.kind === "behavior" && r.requires === undefined) {
      add("warn", "requires-uninvestigated", `${id} has no requires key`, { id });
      frontier.push({ id, reason: "requires-uninvestigated" });
    }
    provenance(ctx, id);
  }
  const code = codeUnion(ctx, [...ctx.claims.keys()]);
  const kinds = {}, labels = { authority: {}, evidence: {}, unlabeled: 0 };
  for (const r of ctx.claims.values()) {
    kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
    for (const k of Object.keys(LABELS)) if (r[k] !== undefined) labels[k][r[k]] = (labels[k][r[k]] ?? 0) + 1;
    if (Object.keys(LABELS).every((k) => r[k] === undefined)) labels.unlabeled++;
  }
  const edges = [...ctx.claims.values()].reduce((n, r) => n + (r.requires?.length ?? 0), 0);
  // Every parsed declaration, so a caller can attribute prose changes to ids. textSha256 hashes exactly scope's text.
  const declarations = [...ctx.decls.keys()].sort().map((id) => {
    const d = ctx.decls.get(id);
    return { id, file: d.file, lines: d.lines, level: d.level, textSha256: sha(d.text) };
  });
  return { counts: { records: ctx.claims.size, declarations: ctx.decls.size, kinds, labels, requiresEdges: edges, codePaths: code.length }, declarations, frontier, code };
}

// The manifest boundary. → {include, exclude, skipped, inBoundary} | null (missing: warned) | false (invalid: error).
function readBoundary(ctx) {
  const b = ctx.m.boundary;
  if (b === undefined) { add("warn", "boundary-missing", "manifest has no boundary {include, exclude}; no file population is named, so nothing is counted"); return null; }
  const bad = !b || !Array.isArray(b.include) || !b.include.every((p) => typeof p === "string") ||
    (b.exclude !== undefined && !(Array.isArray(b.exclude) && b.exclude.every((e) => typeof e?.path === "string")));
  if (bad) { add("error", "boundary-invalid", "boundary needs include: [path] and exclude: [{path, reason}]"); return false; }
  const norm = (p) => posix.normalize(toPosix(p)).replace(/\/$/, "");
  const include = b.include.map(norm), exclude = (b.exclude ?? []).map((e) => ({ path: norm(e.path), reason: e.reason }));
  for (const e of exclude) if (typeof e.reason !== "string" || !e.reason.trim()) add("warn", "boundary-exclude-reason", `exclude ${e.path} states no reason`);
  const under = (p, dir) => dir === "." || p === dir || p.startsWith(dir + "/");
  // No spec graph is ever census population: all of .sova/spec (current, drafts, reviews) and the chosen --spec.
  const own = [DEFAULT_SPEC, ctx.specRel];
  const skipped = (p) => own.some((o) => under(p, o)) || exclude.some((e) => under(p, e.path));
  return { include, exclude, under, skipped, inBoundary: (p) => include.some((i) => under(p, i)) && !skipped(p) };
}

function census(ctx, changed) {
  const claimed = new Map();
  for (const [id, r] of ctx.claims) for (const c of r.code ?? []) claimed.set(posix.normalize(toPosix(c)), [...(claimed.get(posix.normalize(toPosix(c))) ?? []), id]);
  if (changed) return censusChanged(ctx, changed.base, claimed);
  const code = codeUnion(ctx, [...ctx.claims.keys()]);
  const bd = readBoundary(ctx);
  if (bd === null) return { census: { boundary: null, claimed: code.map((c) => c.path), unclaimed: null, outside: null }, code };
  if (bd === false) return { census: null, code };
  const { include, exclude, skipped, inBoundary } = bd;
  const files = [], symlinks = [];
  const walk = (rel) => {
    const abs = join(ctx.root, rel), fail = (e) => add("warn", "census-unreadable", `${rel}: ${e}; its files are not counted`, { file: rel });
    const st = tryRead(() => lstatSync(abs), fail);
    if (!st) return;
    if (st.isSymbolicLink()) return symlinks.push(rel);
    if (st.isFile()) return files.push(rel);
    if (st.isDirectory()) for (const n of tryRead(() => readdirSync(abs).sort(), fail) ?? []) { const c = rel === "." ? n : `${rel}/${n}`; if (!skipped(c)) walk(c); }
  };
  for (const inc of include) {
    const s = safePath(ctx.root, inc);
    if (s.state === "refused") { add("warn", "boundary-refused", `include ${inc}: ${s.why}`); continue; }
    if (!existsSync(join(ctx.root, inc))) { add("warn", "boundary-path-missing", `include ${inc} does not exist`); continue; }
    if (!skipped(inc)) walk(inc);
  }
  const uniq = [...new Set(files)].sort();
  if (symlinks.length) add("note", "census-symlinks", `${symlinks.length} symlink(s) inside the boundary were not followed`);
  return {
    census: {
      boundary: { include, exclude },
      files: uniq.length,
      claimed: uniq.filter((f) => claimed.has(f)),
      unclaimed: uniq.filter((f) => !claimed.has(f)),
      outside: [...claimed.keys()].filter((p) => !inBoundary(p)).sort(),
      symlinks: symlinks.sort(),
    },
    code,
  };
}

// ---------------------------------------------------------------- git (read-only plumbing, no shell)
function git(root, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const r = spawnSync("git", ["-c", "core.fsmonitor=false", "-C", root, ...args], {
    shell: false, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  return r.error ? { status: null, error: r.error.code } : { status: r.status, out: r.stdout, err: String(r.stderr ?? "") };
}
const nulList = (out) => out.split("\0").filter((p) => p && !p.endsWith("/"));

// Files the task changed: differing between base and the working tree, plus untracked non-ignored files.
// Deleted files are dropped (nothing to claim). Paths are relative to the project root. → {commit, paths} | null (error added)
function changedFiles(root, base) {
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) { add("error", "not-git", `census --changed needs a Git work tree: ${top.error ? `git cannot run (${top.error})` : top.err.trim()}`); return null; }
  const prefix = toPosix(relative(realpathSync(top.out.trim()), realpathSync(root)));
  if (prefix.startsWith("..")) { add("error", "not-git", "the project root is outside the Git work tree git reports"); return null; }
  // An enclosing repository that ignores this project and tracks nothing in it would report no changes, falsely.
  if (prefix && git(root, ["-C", top.out.trim(), "check-ignore", "-q", "--", `${prefix}/`]).status === 0 &&
      git(root, ["ls-files", "--", "."]).out === "") { add("error", "not-git", `the enclosing repository ${top.out.trim()} ignores this project`); return null; }
  const rev = git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${base}^{commit}`]);
  if (rev.status !== 0) { add("error", "bad-rev", `--base ${base} does not name a commit`); return null; }
  const commit = rev.out.trim();
  const diff = git(root, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--diff-filter=d", "--relative", commit, "--", "."]);
  const others = git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", "."]);
  for (const [r, what] of [[diff, "diff"], [others, "ls-files"]]) if (r.status !== 0) { add("error", "git-failed", `git ${what}: ${r.error ?? r.err.trim()}`); return null; }
  return { commit, paths: [...new Set([...nulList(diff.out), ...nulList(others.out)])].sort() };
}

function censusChanged(ctx, base, claimed) {
  const ch = changedFiles(ctx.root, base);
  if (!ch) return { census: null };
  const bd = readBoundary(ctx);
  if (bd === false) return { census: null };
  // The spec graph itself is never population, not even as outside.
  const paths = ch.paths.filter((p) => ![DEFAULT_SPEC, ctx.specRel].some((o) => p === o || p.startsWith(o + "/")));
  const files = [], symlinks = [];
  for (const p of paths) {
    if (bd && !bd.inBoundary(p)) continue;
    const s = safePath(ctx.root, p);
    if (s.state === "present") files.push(p);
    else if (s.why === "symlink") symlinks.push(p);
  }
  const entry = (p) => ({ path: p, claims: claimed.get(p) });
  const head = { mode: "changed", base: { rev: base, commit: ch.commit }, changed: ch.paths.length };
  // Without a boundary no population is named: claims are still shown, nothing is judged unclaimed.
  if (!bd) return { census: { ...head, boundary: null, claimed: files.filter((p) => claimed.has(p)).map(entry), unclaimed: null, outside: null } };
  const unclaimed = files.filter((p) => !claimed.has(p));
  for (const p of unclaimed) add("warn", "changed-unclaimed", `${p} changed and no record's code claims it`, { file: p });
  if (symlinks.length) add("note", "census-symlinks", `${symlinks.length} changed symlink(s) inside the boundary were not followed`);
  return {
    census: {
      ...head,
      boundary: { include: bd.include, exclude: bd.exclude },
      files: files.length,
      claimed: files.filter((p) => claimed.has(p)).map(entry),
      unclaimed,
      outside: paths.filter((p) => !bd.inBoundary(p)),
      symlinks,
    },
  };
}

// ---------------------------------------------------------------- output
function human(out) {
  const L = [];
  const where = (f) => [f.id, f.file && `${f.file}${f.line ? `:${f.line}` : ""}`].filter(Boolean).join(" ");
  if (out.passages) for (const p of out.passages) {
    const rs = p.reasons.map((r) => (r.of ? `${r.reason} of ${r.of}` : r.reason)).join("; ");
    const lb = p.labels ? `; ${Object.entries(p.labels).map(([k, v]) => `${k} ${v}`).join(", ")}` : "";
    L.push(`── ${p.id} [${p.kind}${lb}; ${rs}] ${p.file}:${p.lines[0]}-${p.lines[1]}`, p.text.trimEnd());
    if (p.provenance.entries.length) L.push(`   provenance: ${p.provenance.entries.map((e) => `${e.file}:${e.lines?.join("-")} ${e.state}`).join(", ")}`);
    L.push("");
  }
  if (out.consumers) L.push(`consumers (reverse requires): ${out.consumers.length ? "" : "none declared"}`, ...out.consumers.map((c) => `  ${"  ".repeat(c.depth - 1)}${c.id} (depth ${c.depth}, requires ${c.requires.join(", ")})`));
  if (out.containers?.length) L.push("containers (not consumers):", ...out.containers.map((c) => `  ${c.id} ${c.relation} of ${c.of}`));
  if (out.counts) {
    const lb = out.counts.labels, fmt = (o) => Object.entries(o).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
    L.push(`records ${out.counts.records}, declarations ${out.counts.declarations}, requires edges ${out.counts.requiresEdges}, code paths ${out.counts.codePaths}`,
      `labels: authority ${fmt(lb.authority)}; evidence ${fmt(lb.evidence)}; unlabeled ${lb.unlabeled} (declared, not verified)`);
  }
  if (out.census?.mode === "changed") {
    const c = out.census;
    L.push(`changed since ${c.base.rev} (${c.base.commit.slice(0, 12)}): ${c.changed} file(s)`);
    if (c.boundary) L.push(`boundary include ${c.boundary.include.join(", ")}; exclude ${c.boundary.exclude.map((e) => `${e.path} (${e.reason ?? "no reason"})`).join(", ") || "none"}`,
      `in boundary ${c.files}, claimed ${c.claimed.length}, unclaimed ${c.unclaimed.length}, outside ${c.outside.length}`);
    L.push(...c.claimed.map((e) => `  claimed ${e.path} (${e.claims.join(", ")})`), ...(c.unclaimed ?? []).map((f) => `  unclaimed ${f}`),
      ...(c.outside ?? []).map((f) => `  outside boundary ${f}`), ...(c.symlinks ?? []).map((f) => `  symlink not followed ${f}`));
  } else if (out.census) {
    const c = out.census;
    if (c.boundary) L.push(`boundary include ${c.boundary.include.join(", ")}; exclude ${c.boundary.exclude.map((e) => `${e.path} (${e.reason ?? "no reason"})`).join(", ") || "none"}`,
      `files ${c.files}, claimed ${c.claimed.length}, unclaimed ${c.unclaimed.length}`, ...c.unclaimed.map((f) => `  unclaimed ${f}`), ...c.outside.map((f) => `  mapped outside boundary ${f}`));
  }
  if (out.code?.length) L.push("code (evidence locations):", ...out.code.map((c) => `  ${c.path} ${c.state}`));
  if (out.frontier?.length) L.push("frontier:", ...out.frontier.map((f) => `  ${f.id} ${f.reason}${f.of ? ` (from ${f.of})` : ""}`));
  for (const f of out.findings) L.push(`${f.severity} ${f.code}: ${f.message}${where(f) ? ` [${where(f)}]` : ""}`);
  if (out.notice) L.push(`note: ${out.notice}`);
  L.push(`exit ${out.exit}`);
  return L.join("\n") + "\n";
}

function main(argv) {
  const opt = parseArgs(argv);
  let out = { tool: "sova-spec", command: opt.cmd ?? null };
  if (opt.help) { process.stdout.write(USAGE + "\n"); return 0; }
  if (opt.usage) add("error", "usage", `${opt.usage}. ${USAGE}`);
  else {
    opt.spec ??= DEFAULT_SPEC;
    out.spec = opt.spec;
    const root = findSpec(opt);
    if (!root) add("error", "manifest-not-found", `no ${opt.spec}/manifest.json in this directory or any parent`);
    else {
      out.root = root;
      const ctx = load(root, opt.spec);
      if (ctx) {
        const broken = exitOf(findings) === 2;
        if ((opt.cmd === "scope" || opt.cmd === "impact") && !ctx.claims.has(opt.id)) add("error", "unknown-id", `${opt.id} has no manifest record`, { id: opt.id });
        else if (broken && opt.cmd !== "check") add("note", "untrusted", "graph errors prevent a trustworthy result; fix them first");
        else {
          const run = { check: () => check(ctx), census: () => census(ctx, opt.changed && { base: opt.base ?? "HEAD" }), scope: () => scope(ctx, opt.id, opt.budget), impact: () => impact(ctx, opt.id) }[opt.cmd];
          out = { ...out, ...(opt.id ? { id: opt.id } : {}), ...run(), notice: NOTICE };
        }
      }
    }
  }
  out.exit = exitOf(findings);
  out.findings = findings;
  process.stdout.write(opt.json ? JSON.stringify(out, null, 2) + "\n" : human(out));
  return out.exit;
}

try { process.exitCode = main(process.argv.slice(2)); } catch (e) {
  add("error", "internal-error", String(e?.stack ?? e));
  process.stdout.write((process.argv.includes("--json") ? JSON.stringify({ tool: "sova-spec", exit: 2, findings }, null, 2) : `error internal-error: ${e?.message ?? e}\nexit 2`) + "\n");
  process.exitCode = 2;
}
