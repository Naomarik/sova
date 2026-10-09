#!/usr/bin/env node
// sova-spec: read-only core for a project's .sova/spec. Node stdlib only; never writes.
// Commands: check | packet §id | scope §id | impact §id | census [--changed [--base REV] [--related] [--own-base REV]...] |
//   foreign --base REV [--head REV | --spec DIR] [--own-base REV]... [--landing [--drafts DIR]...].
// Flags: --root DIR, --spec DIR, --json, --budget BYTES; packet: --part PART, --cursor TOKEN.
// Exit: 0 usable known closure (never completeness), 1 relevant unknown/stale/unread, 2 untrustworthy.
import { readFileSync, readdirSync, lstatSync, existsSync, realpathSync, openSync, closeSync, fstatSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname, relative, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKET_PARTS, PACKET_HELP, packetBudget, packetError, packetOrder, packetPage, serializePacket } from "./packet.mjs";
import { tocMain, pullCommand } from "./toc.mjs";
import { readMain } from "./read.mjs";
import { fieldShape, checkFields, frameOf, frameFinding, aboutDelivered } from "./fields.mjs";
import { lookCommand, graphMain, nearMain } from "./graph.mjs";
import { mapMain } from "./map.mjs";
import { whereMain } from "./where.mjs";

const ID_SRC = String.raw`§[a-z][a-z-]*(?:\.[a-z][a-z-]*)?/[a-z][a-z-]*`;
const ID_RE = new RegExp(`^${ID_SRC}$`);
const KINDS = ["surface", "behavior", "section", "note"];
// Optional declared labels. Reported verbatim; never derived, never proof, never change the exit.
const LABELS = { authority: ["candidate", "migrated", "accepted"], evidence: ["unreviewed", "reviewed", "verified"] };
const DEFAULT_SPEC = ".sova/spec";
const NOTICE = "Known declared closure only. A behavior without requires is uninvestigated; [] means none declared. " +
  "Code paths are evidence locations, not specifications. Incumbent citations and hashes are provenance, never semantic coverage. " +
  "authority/evidence labels are declared status, never verified by this tool.";

const FOREIGN_NOTICE = "foreign lists every § whose prose span or manifest record changed, was deleted, or gained a new child, minus § created in the range. " +
  "It is computed from bytes, never meaning: whether a user sees the change is still read in each passage.";

// ---------------------------------------------------------------- findings
let findings = [];
let packetInputs = null, packetInvocation = false;
const add = (severity, code, message, where = {}) => findings.push({ severity, code, message, ...where });
const exitOf = (fs) => (fs.some((f) => f.severity === "error") ? 2 : fs.some((f) => f.severity === "warn") ? 1 : 0);

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const o = { json: false, pos: [], ownBase: [], drafts: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--changed") o.changed = true;
    else if (a === "--related") o.related = true;
    else if (a === "--landing") o.landing = true;
    else if (a === "--own-base" || a === "--drafts") { if (i + 1 >= argv.length) { o.usage = `${a} needs a value`; break; } o[a === "--drafts" ? "drafts" : "ownBase"].push(argv[++i]); }
    else if (a === "--root" || a === "--spec" || a === "--budget" || a === "--base" || a === "--head" || a === "--read-policy" || a === "--part" || a === "--cursor") {
      if (i + 1 >= argv.length) { o.usage = `${a} needs a value`; break; }
      o[a.slice(2)] = argv[++i];
    } else if (a === "--help" || a === "-h") o.help = true;
    else if (a.startsWith("-")) o.usage ??= `unknown flag ${a}`;
    else o.pos.push(a);
  }
  if (o.usage || o.help) return o;
  const [cmd, ...rest] = o.pos;
  o.cmd = cmd;
  const arity = { check: 0, census: 0, scope: 1, packet: 1, impact: 1, foreign: 0 }[cmd];
  if (arity === undefined) o.usage = cmd ? `unknown command ${cmd}` : "missing command";
  else if (rest.length !== arity) o.usage = `${cmd} takes ${arity ? "one §id" : "no arguments"}`;
  else if (arity && /^§[a-z][a-z-]*\.[a-z][a-z-]*$/.test(rest[0])) { o.alias = rest[0]; o.id = rest[0].replace(".", "/"); } // §app.shell names §app/shell
  else if (arity && !ID_RE.test(rest[0])) o.usage = `not a § identifier: ${rest[0]}`;
  else o.id = rest[0];
  if (!o.usage && o["read-policy"] !== undefined && o["read-policy"] !== "review") o.usage = "--read-policy accepts review only";
  if (!o.usage && o.spec !== undefined) {
    const s = specDir(o.spec);
    if (s.why) o.usage = `--spec ${JSON.stringify(o.spec)}: ${s.why}`;
    else o.spec = s.rel;
  }
  if (!o.usage && o.budget !== undefined) {
    if (cmd === "packet") {
      const budget = packetBudget(o.budget);
      if (budget === null) o.usage = "packet --budget takes an integer from 1024 to 32768";
      else o.budget = budget;
    } else if (cmd !== "scope") o.usage = "--budget applies to scope, packet, toc, read, map, where, impact --near and graph only";
    else if (!/^\d+$/.test(o.budget) || !Number.isSafeInteger(Number(o.budget))) o.usage = "--budget takes a non-negative integer byte count";
    else o.budget = Number(o.budget);
  }
  if (!o.usage && (o.part !== undefined || o.cursor !== undefined) && cmd !== "packet") o.usage = "--part and --cursor apply to packet only";
  if (!o.usage && o.part !== undefined && !PACKET_PARTS.includes(o.part)) o.usage = "unknown packet part";
  if (!o.usage && cmd === "foreign") {
    if (o.base === undefined) o.usage = "foreign needs --base REV";
    else if (o.spec !== undefined && o.head !== undefined) o.usage = "foreign --spec reads a draft in the working tree as the head; it does not combine with --head";
  } else if (!o.usage && o.head !== undefined) o.usage = "--head applies to foreign only";
  if (!o.usage && o.base !== undefined && !o.changed && cmd !== "foreign") o.usage = "--base applies to census --changed and foreign only";
  if (!o.usage && o.related && !o.changed) o.usage = "--related applies to census --changed only";
  if (!o.usage && o.changed && cmd !== "census") o.usage = "--changed applies to census only";
  if (!o.usage && o.landing && cmd !== "foreign") o.usage = "--landing applies to foreign only";
  if (!o.usage && o.drafts.length && !o.landing) o.usage = "--drafts applies to foreign --landing only";
  if (!o.usage && o.ownBase.length && !(cmd === "foreign" || o.changed)) o.usage = "--own-base applies to foreign and census --changed only";
  return o;
}
const USAGE = "usage: sova-spec <map [namespace | §id] | where <path|token> [--token] [--all] | toc §id --dir out|in|down|up|mentions | read §id [--whole] [--no-frame] | read --frame | impact §id --near | graph | " +
  `packet §id [--part ${PACKET_PARTS.join("|")}] | scope §id | impact §id | check | census [--changed [--base REV] [--related] [--own-base REV]...] | foreign --base REV [--head REV | --spec DIR] [--own-base REV]... [--landing [--drafts DIR]...]> [--root DIR] [--spec DIR] [--json] [--budget BYTES] [--cursor TOKEN]`;

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

// The review companion's refusal policy must hold in this subprocess too, before contents are read.
const SECRET_DIRS = new Set([".git", ".hg", ".svn", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker"]);
const SECRET_FILE = /^(?:\.env(?:\..*)?|\.envrc|auth\.json|credentials(?:\.json)?|\.netrc|\.npmrc|\.pypirc|\.pgpass|\.git-credentials|\.htpasswd|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|secrets?(?:(?:[.-][a-z0-9_-]+)*\.(?:json|ya?ml|toml|ini|conf|cfg|env|txt|properties|xml|enc|age|asc))?|.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx|gpg))$/i;
let reviewPolicy = false, assessmentPolicy = false;
function reviewRefusal(rel) {
  if (!reviewPolicy) return null;
  const segs = toPosix(rel).split("/"), low = toPosix(rel).toLowerCase();
  if (assessmentPolicy && (low === `${DEFAULT_SPEC}/assessments` || low.startsWith(`${DEFAULT_SPEC}/assessments/`))) return "receipt/cache storage is not an input";
  if ([`${DEFAULT_SPEC}/reviews`, `${DEFAULT_SPEC}/.cache`].some((d) => low === d || low.startsWith(d + "/"))) return "review/cache storage is never its own input";
  if (segs.some((s) => SECRET_DIRS.has(s.toLowerCase()))) return "secret, config or runtime-state directory";
  return SECRET_FILE.test(segs.at(-1)) ? "secret or credential file" : null;
}
function openInput(root, rel) {
  const p = safePath(root, rel), why = reviewRefusal(rel);
  if (why || p.state !== "present") throw Object.assign(new Error(why ?? p.why ?? p.state), { code: why ? "refused" : p.state });
  if (reviewPolicy) {
    const st = lstatSync(p.abs);
    if (st.nlink > 1 || st.size > 2 * 1024 * 1024)
      throw Object.assign(new Error(st.nlink > 1 ? "hard-linked file" : "oversize"), { code: "refused" });
  }
  const fd = openSync(p.abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw Object.assign(new Error("not a regular file"), { code: "not-file" });
    if (reviewPolicy && (st.nlink > 1 || st.size > 2 * 1024 * 1024))
      throw Object.assign(new Error(st.nlink > 1 ? "hard-linked file" : "oversize"), { code: "refused" });
    return fd;
  } catch (e) { closeSync(fd); throw e; }
}
function readInput(root, rel) {
  const fd = openInput(root, rel);
  try {
    const b = readFileSync(fd);
    if (reviewPolicy && b.length > 2 * 1024 * 1024) throw Object.assign(new Error("oversize"), { code: "refused" });
    if (packetInputs) packetInputs.files.push([rel, sha(b)]);
    return b.toString("utf8");
  } finally { closeSync(fd); }
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
  const text = tryRead(() => readInput(root, `${specRel}/manifest.json`), (e) => add("error", "manifest-unreadable", `manifest.json: ${e}`));
  return text === null ? null : parseManifest(text, specRel);
}

// A manifest's text, from a file or a Git object. → ctx without root/claims/decls | null (error added)
function parseManifest(text, specRel) {
  let m;
  try { m = JSON.parse(text); } catch (e) {
    add("error", "manifest-unreadable", `manifest.json: ${e.message}`, { file: `${specRel}/manifest.json` }); return null;
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) { add("error", "manifest-unreadable", "manifest.json is not an object"); return null; }
  const v1 = m.formatVersion === 1 || (m.formatVersion === undefined && m.schema === "sova-spec/pilot-manifest" && m.version === 1);
  if (!v1) { add("error", "manifest-version", `unsupported format (formatVersion ${JSON.stringify(m.formatVersion ?? m.version)}); this core reads version 1`); return null; }
  const g = m.grammar ?? {};
  if (!g || typeof g !== "object" || Array.isArray(g)) { add("error", "grammar-invalid", "grammar must be an object"); return null; }
  if (g.id !== undefined && g.id !== ID_SRC) add("error", "grammar-unsupported", "grammar.id differs from the fixed § grammar; custom grammars are not read");
  if (g.fullToken === false) add("error", "grammar-unsupported", "grammar.fullToken false is not supported");
  const claimsRoot = g.claimsRoot ?? "claims/";
  const dirKinds = g.directoryKinds ?? ["section"];
  const croot = typeof claimsRoot === "string" ? posix.normalize(toPosix(claimsRoot)).replace(/\/$/, "") : "";
  if (!croot || claimsRoot.includes("\0") || toPosix(claimsRoot).split("/").includes("..") || croot === "." || croot === ".." || croot.startsWith("../") || croot.startsWith("/") || /^[a-zA-Z]:/.test(croot)) {
    add("error", "grammar-invalid", "grammar.claimsRoot must be a relative directory inside .sova/spec"); return null;
  }
  if (!Array.isArray(dirKinds) || !dirKinds.every((k) => typeof k === "string" && /^[a-z][a-z-]*$/.test(k))) {
    add("error", "grammar-invalid", "grammar.directoryKinds must be an array of namespace names"); return null;
  }
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
    fieldShape(rec, id, bad, ID_RE);
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
    const rel = toPosix(relative(root, dir)), why = reviewRefusal(rel);
    if (why) { add("error", "claims-unreadable", `${rel}: refused (${why})`, { file: rel }); return; }
    const unreadable = (file) => (e) => add("error", "claims-unreadable", `${file}: ${e}`, { file });
    for (const n of tryRead(() => readdirSync(dir).sort(), unreadable(toPosix(relative(root, dir)))) ?? []) {
      const p = join(dir, n), rel = toPosix(relative(root, p)), st = tryRead(() => lstatSync(p), unreadable(rel));
      if (!st) continue;
      if (packetInputs) packetInputs.tree.push([rel, st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "directory" : st.isFile() ? "file" : "other"]);
      if (st.isSymbolicLink()) add("error", "symlink-refused", `${rel} is a symlink; claims are never read through links`, { file: rel });
      else if (st.isDirectory()) walk(p);
      else if (st.isFile() && n.endsWith(".md")) files.push(p);
    }
  };
  walk(croot);
  const bodies = [];
  for (const abs of files) {
    const rel = toPosix(relative(root, abs));
    const body = tryRead(() => readInput(root, rel), (e) => add("error", "claims-unreadable", `${rel}: ${e}`, { file: rel }));
    if (body !== null) bodies.push({ rel, inClaims: toPosix(relative(croot, abs)), body });
  }
  return parseDeclarations(ctx, bodies, decls);
}

// H1/H2 declarations of claim files [{rel (to the root), inClaims (to the claims root), body}], in order.
function parseDeclarations(ctx, bodies, decls = new Map()) {
  for (const { rel, inClaims, body } of bodies) {
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
  return linkGraph(ctx);
}

// Cross-checks records against declarations and indexes children.
function linkGraph(ctx) {
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
    let failure = "unreadable";
    const text = tryRead(() => readInput(ctx.root, e.file), (err) => { failure = err === "refused" ? "refused" : "unreadable"; add("warn", "provenance-stale", `incumbent ${e.file}: ${failure} (${err})`, { id }); });
    if (text === null) return { ...out, state: failure };
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
    if (p.state === "present") {
      try { closeSync(openInput(ctx.root, path)); }
      catch (e) { p.state = e.code === "refused" ? "refused" : "unreadable"; p.why = e.message; }
    }
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
    for (const e of [...(rec.embeds ?? [])].sort()) edge(e, { reason: "embeds", of: id });
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

// Reverse requires index: target → the ids that require it.
function reverseOf(ctx) {
  const rev = new Map();
  for (const [id, r] of ctx.claims) for (const t of [...(r.requires ?? []), ...(r.embeds ?? [])]) if (!(rev.get(t) ?? []).includes(id)) rev.set(t, [...(rev.get(t) ?? []), id]);
  return rev;
}

// Transitive reverse requires of seed, breadth-first with depth; sorted by depth, then id.
function consumersOf(ctx, rev, seed) {
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
  return consumers.sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : 1));
}

function impact(ctx, seed) {
  const consumers = consumersOf(ctx, reverseOf(ctx), seed);
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
  checkFields(ctx, add);
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
  const paths = [...b.include, ...(b.exclude ?? []).map((e) => e.path)];
  if (paths.some((p) => !p || p.includes("\0") || toPosix(p).startsWith("/") || /^[a-zA-Z]:/.test(p) || toPosix(p).split("/").includes(".."))) {
    add("error", "boundary-refused", "boundary paths must stay relative to the project root, without .."); return false;
  }
  const norm = (p) => posix.normalize(toPosix(p)).replace(/\/$/, "");
  const include = b.include.map(norm), exclude = (b.exclude ?? []).map((e) => ({ path: norm(e.path), reason: e.reason }));
  for (const inc of include) {
    const s = safePath(ctx.root, inc);
    if (s.state === "refused") { add("error", "boundary-refused", `include ${inc}: ${s.why}`); return false; }
  }
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
  if (changed) return censusChanged(ctx, changed, claimed);
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
function git(root, args, input) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const r = spawnSync("git", ["-c", "core.fsmonitor=false", "-C", root, ...args], {
    shell: false, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  return r.error ? { status: null, error: r.error.code } : { status: r.status, out: r.stdout, err: String(r.stderr ?? "") };
}
// Working-tree diff can invoke clean/process filters even with no-ext-diff/no-textconv.
// Refuse this executable configuration; this is not a claim that arbitrary Git is nonexecuting.
function filterFree(root, base) {
  // Inspect attribute-selected drivers over index + base candidates without comparing working bytes.
  // Unused configured drivers (for example global LFS) do not limit inspection availability.
  const cached = git(root, ["ls-files", "--cached", "-z", "--", "."]);
  const tree = git(root, ["ls-tree", "--name-only", "-r", "-z", base, "--", "."]);
  if (cached.status !== 0 || tree.status !== 0) { add("error", "git-failed", "cannot enumerate filter candidates"); return false; }
  const paths = [...new Set([...nulList(cached.out), ...nulList(tree.out)])];
  if (!paths.length) return true;
  const attrs = git(root, ["check-attr", "--all", "-z", "--stdin"], paths.join("\0") + "\0");
  if (attrs.status !== 0) { add("error", "git-failed", "cannot inspect filter attributes"); return false; }
  const fields = attrs.out.split("\0"), drivers = new Set();
  if (fields.pop() !== "" || fields.length % 3 !== 0) { add("error", "git-failed", "unexpected Git filter attribute output"); return false; }
  // --all omits absent/unspecified attributes, unlike a literal driver named unspecified.
  // Boolean filter/-filter still render like literal set/unset drivers: refuse executable ambiguity.
  for (let i = 0; i + 2 < fields.length; i += 3) if (fields[i + 1] === "filter") drivers.add(fields[i + 2]);
  for (const driver of drivers) for (const kind of ["clean", "process"]) {
    const r = git(root, ["config", "--get", `filter.${driver}.${kind}`]);
    if (r.status === 1) continue;
    if (r.status !== 0) { add("error", "git-failed", "cannot inspect selected filter configuration"); return false; }
    if (r.out.trim()) {
      add("error", "git-filter-refused", "a tracked path's filter attribute names or is ambiguous with a configured Git clean/process filter; working-tree inspection is unsupported and no diff was run"); return false;
    }
  }
  return true;
}
const nulList = (out) => out.split("\0").filter((p) => p && !p.endsWith("/"));

// Files the task changed: differing between base and the working tree, plus untracked non-ignored files.
// Deleted files are kept (a deleted mapped file still lands in its claim). Paths are relative to the project root. → {commit, paths} | null (error added)
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
  if (!filterFree(root, commit)) return null;
  const diff = git(root, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--relative", commit, "--", "."]);
  const others = git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", "."]);
  for (const [r, what] of [[diff, "diff"], [others, "ls-files"]]) if (r.status !== 0) { add("error", "git-failed", `git ${what}: ${r.error ?? r.err.trim()}`); return null; }
  return { commit, paths: [...new Set([...nulList(diff.out), ...nulList(others.out)])].sort() };
}

// Ids the current spec already records, read only to tell a draft's new ids from foreign ones; its own findings are dropped.
function currentIds(root) {
  const n = findings.length, cur = loadManifest(root, DEFAULT_SPEC);
  findings.length = n;
  return new Set(cur ? Object.keys(cur.m.claims) : []);
}

// Every § a changed file lands in is foreign unless the task created it (only a draft read with --spec can).
// With --related, each also gets its declared requires and transitive consumers, and a note. No flags are judged here.
function relatedOf(ctx, hits, related, own = () => false) {
  const files = new Map(), childUnderForeign = [];
  const cur0 = ctx.specRel !== DEFAULT_SPEC ? currentIds(ctx.root) : new Set(ctx.claims.keys());
  // The task's own claims (absent at every --own-base) are never foreign, even once current has them.
  const cur = new Set([...cur0].filter((id) => !own(id)));
  for (const e of hits) for (const id of e.claims) files.set(id, [...(files.get(id) ?? []), e.path]);
  const ids = [...files.keys()].sort(), rev = related && reverseOf(ctx);
  const touched = related && ids.map((id) => {
    const rec = ctx.claims.get(id), d = ctx.decls.get(id);
    if (rec.kind === "behavior" && rec.requires === undefined)
      add("note", "touched-uninvestigated", `${id} is touched and has no requires key: dependencies not investigated`, { id });
    if (cur.has(id))
      add("note", "touched-foreign", `${id} is foreign (the task didn't create it) and ${files.get(id).join(", ")} changed: read it with read '${id}'; if a user sees a change there, even one your new claim describes, update it in your draft without asking and list it; a gap it already had never counts, even one you now rely on`, { id });
    return { id, kind: rec.kind, ...labelsOf(rec), created: !cur.has(id), file: d?.file, lines: d?.lines, files: files.get(id),
      requires: rec.requires ?? null, consumers: consumersOf(ctx, rev, id).map((c) => ({ id: c.id, depth: c.depth })) };
  });
  if (ctx.specRel !== DEFAULT_SPEC) for (const [p, kids] of ctx.children) if (cur.has(p)) for (const id of kids) if (!cur.has(id)) {
    add("note", "child-under-foreign", `${id} is new under foreign ${p}: a user-visible addition there is ${p}'s change too: update ${p} in your draft without asking and list it, even though ${id} describes it`, { id, parent: p });
    childUnderForeign.push({ id, parent: p });
  }
  // Surfaces first: they are the few that usually carry a visible change.
  const foreign = ids.filter((id) => cur.has(id)), surface = (id) => ctx.claims.get(id).kind === "surface";
  return { touched, foreign: [...foreign.filter(surface), ...foreign.filter((id) => !surface(id))], childUnderForeign, touchedIds: ids };
}
const FOREIGN_RULE = "update any where a user sees a change, even one your new claim describes, wherever you put it, in your draft without asking, and list it; plumbing (a request, hook, helper or CSS class) never counts, nor a gap it already had, even one you now rely on";
// Pushed last, so a truncated tail of the findings still carries it; the rule leads, so a byte cut keeps it.
const foreignSummary = (foreign) => foreign.length && add("note", "foreign-summary",
  `${FOREIGN_RULE.replace("any", "any foreign §")}: ${foreign.length} touched (${foreign.join(", ")})`, { ids: foreign });

// Evidence commits the project's drafts name that HEAD no longer contains: a rebase (or reset) rewrote them.
// Read-only: each draft.json, then `git merge-base --is-ancestor`. → [{draft, commit, ids}], one note each.
function draftInventory(root, scan, code, limit = Infinity) {
  const dirRel = `${DEFAULT_SPEC}/drafts`, dir = join(root, dirRel), items = [];
  const unread = (reason, draft) => {
    scan.complete = false; scan.unread.push({ ...(draft ? { draft } : {}), worktree: root, reason });
    add("warn", code, `${draft ? `draft ${draft}` : "draft inventory"} in ${root}: ${reason}`);
  };
  if (linkOnPath(root, dirRel)) { unread("symlink on drafts path"); return items; }
  let names;
  try { names = readdirSync(dir).filter((n) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(n)).sort(); }
  catch (e) { if (e.code !== "ENOENT") unread(`cannot list drafts (${e.code})`); return items; }
  for (const draft of names) {
    if (scan.scanned >= limit) {
      scan.complete = false; scan.capped = true;
      add("note", "landing-drafts-capped", `more than ${limit} drafts; the rest were not read`); break;
    }
    scan.scanned++;
    try {
      const rel = `${dirRel}/${draft}/draft.json`;
      const d = JSON.parse(readInput(root, rel));
      if (!d || typeof d !== "object" || Array.isArray(d) || !Array.isArray(d.evidence) || (d.promotions !== undefined && !Array.isArray(d.promotions)) ||
          d.evidence.some((e) => !e || typeof e !== "object" || !Array.isArray(e.ids) || e.ids.some((i) => typeof i?.id !== "string")))
        throw new Error("malformed draft metadata");
      items.push({ draft, d });
    } catch (e) { unread(e.message, draft); }
  }
  return items;
}
const newDraftScan = () => ({ complete: true, scanned: 0, capped: false, unread: [] });
function orphaned(root) {
  const out = [], draftScan = newDraftScan();
  for (const { draft, d } of draftInventory(root, draftScan, "evidence-draft-unread")) {
    // The latest entry naming each ID is active, even if it is invalid. Never fall back.
    const active = new Map(), by = new Map();
    for (const e of d.evidence) for (const i of Array.isArray(e?.ids) ? e.ids : []) if (typeof i?.id === "string") active.set(i.id, e);
    for (const [id, e] of active)
      if (e?.mode === "commit" && /^[0-9a-f]{40,64}$/.test(e.commit ?? "")) by.set(e.commit, [...(by.get(e.commit) ?? []), id]);
    for (const [commit, ids] of by) {
      if (git(root, ["merge-base", "--is-ancestor", commit, "HEAD"]).status === 0) continue;
      out.push({ draft, commit, ids: [...new Set(ids)].sort() });
      add("note", "evidence-orphaned", `draft ${draft}'s evidence commit ${commit.slice(0, 12)} (${[...new Set(ids)].sort().join(", ")}) is not in HEAD: a rebase rewrote it; never rebase after evidence (merge master in instead), and re-record evidence on the commit HEAD has`, { file: `${DEFAULT_SPEC}/drafts/${draft}/draft.json` });
    }
  }
  return { orphanedEvidence: out, draftScan };
}

function censusChanged(ctx, { base, related, ownBase }, claimed) {
  const bd = readBoundary(ctx);
  if (bd === false) return { census: null };
  const ch = changedFiles(ctx.root, base);
  if (!ch) return { census: null };
  const own = ownOf(ctx.root, ownBase);
  if (!own) return { census: null };
  // The spec graph itself is never population, not even as outside.
  const paths = ch.paths.filter((p) => ![DEFAULT_SPEC, ctx.specRel].some((o) => p === o || p.startsWith(o + "/")));
  const files = [], symlinks = [], mappedOutside = [], deleted = [], gone = new Set();
  const entry = (p) => ({ path: p, claims: claimed.get(p), ...(gone.has(p) ? { deleted: true } : {}) });
  for (const p of paths) {
    const s = safePath(ctx.root, p);
    if (s.state === "missing") { deleted.push(p); gone.add(p); }
    // Outside the boundary nothing is judged unclaimed, but a file a claim maps still lands in that claim, deleted or not.
    if (bd && !bd.inBoundary(p)) { if (claimed.has(p) && (s.state === "present" || gone.has(p))) mappedOutside.push(entry(p)); continue; }
    if (s.state === "present") files.push(p);
    else if (s.why === "symlink") symlinks.push(p);
  }
  // A deleted in-boundary file a claim maps lands in that claim; an unclaimed one has nothing to claim.
  const deletedClaimed = deleted.filter((p) => claimed.has(p) && (!bd || bd.inBoundary(p)));
  const head = { mode: "changed", base: { rev: base, commit: ch.commit }, changed: ch.paths.length };
  const { orphanedEvidence, draftScan } = orphaned(ctx.root);
  // Without a boundary no population is named: claims are still shown, nothing is judged unclaimed.
  const hits = [...files, ...deletedClaimed].sort().filter((p) => claimed.has(p)).map(entry);
  const rel = relatedOf(ctx, [...hits, ...mappedOutside], related, own.is);
  // The rule, then the foreign ids, near the top, so a truncated head still carries both.
  Object.assign(head, { foreignNote: FOREIGN_RULE.replace("any", "any of these"), foreign: rel.foreign, childUnderForeign: rel.childUnderForeign,
    ...(own.bases.length ? { own: own.list([...rel.touchedIds]), ownBases: own.bases } : {}) });
  const touched = related ? { touched: rel.touched } : {};
  if (!bd) { foreignSummary(rel.foreign); return { census: { ...head, boundary: null, claimed: hits, unclaimed: null, outside: null, deleted, orphanedEvidence, draftScan, ...touched } }; }
  const unclaimed = files.filter((p) => !claimed.has(p));
  for (const p of unclaimed) add("warn", "changed-unclaimed", `${p} changed and no record's code claims it`, { file: p });
  if (symlinks.length) add("note", "census-symlinks", `${symlinks.length} changed symlink(s) inside the boundary were not followed`);
  foreignSummary(rel.foreign);
  return {
    census: {
      ...head,
      boundary: { include: bd.include, exclude: bd.exclude },
      files: files.length,
      claimed: hits,
      unclaimed,
      outside: paths.filter((p) => !bd.inBoundary(p)),
      mappedOutside,
      deleted,
      orphanedEvidence,
      draftScan,
      symlinks,
      ...touched,
    },
  };
}

// ---------------------------------------------------------------- foreign: § a range of history changes
// The project root relative to the Git work tree top. → prefix ("" at the top) | null (error added)
function gitPrefix(root, what) {
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) { add("error", "not-git", `${what} needs a Git work tree: ${top.error ? `git cannot run (${top.error})` : top.err.trim()}`); return null; }
  const prefix = toPosix(relative(realpathSync(top.out.trim()), realpathSync(root)));
  if (prefix.startsWith("..")) { add("error", "not-git", "the project root is outside the Git work tree git reports"); return null; }
  return prefix;
}
function resolveRev(root, rev, flag) {
  const r = git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]);
  if (r.status !== 0) { add("error", "bad-rev", `${flag} ${rev} does not name a commit`); return null; }
  return r.out.trim();
}
// Blobs by "commit:path", read in one `git cat-file --batch`. → Map(spec → string | null)
function blobs(root, specs) {
  const out = new Map();
  if (!specs.length) return out;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const r = spawnSync("git", ["-c", "core.fsmonitor=false", "-C", root, "cat-file", "--batch"], {
    shell: false, input: specs.map((x) => `${x}\n`).join(""), maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
    env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  if (r.error || r.status !== 0) { add("error", "git-failed", `git cat-file: ${r.error?.code ?? String(r.stderr).trim()}`); return null; }
  const buf = r.stdout;
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
// The spec graph as committed at `commit`, read from Git objects. No spec there → an empty graph.
function loadAt(root, prefix, commit) {
  const spec = prefix ? `${prefix}/${DEFAULT_SPEC}` : DEFAULT_SPEC;
  const man = blobs(root, [`${commit}:${spec}/manifest.json`]);
  if (!man) return null;
  const text = man.get(`${commit}:${spec}/manifest.json`);
  const empty = { m: { claims: {} }, specRel: DEFAULT_SPEC, claimsRel: `${DEFAULT_SPEC}/claims`, dirKinds: ["section"], root, claims: new Map(), decls: new Map(), children: new Map() };
  if (text == null) return empty;
  const ctx = parseManifest(text, DEFAULT_SPEC);
  if (!ctx) return null;
  ctx.root = root;
  ctx.claims = validateRecords(ctx);
  const ls = git(root, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", `${prefix ? `${prefix}/` : ""}${ctx.claimsRel}/`]);
  if (ls.status !== 0) { add("error", "git-failed", `git ls-tree: ${ls.error ?? ls.err.trim()}`); return null; }
  const files = [];
  for (const e of ls.out.split("\0").filter(Boolean)) {
    const [meta, full] = e.split("\t"), rel = prefix ? full.slice(prefix.length + 1) : full;
    if (meta.startsWith("120000")) add("error", "symlink-refused", `${rel} is a symlink at ${commit.slice(0, 12)}; claims are never read through links`, { file: rel });
    else if (meta.split(" ")[1] === "blob" && rel.endsWith(".md")) files.push(rel);
  }
  files.sort();
  const got = blobs(root, files.map((f) => `${commit}:${prefix ? `${prefix}/` : ""}${f}`));
  if (!got) return null;
  ctx.decls = parseDeclarations(ctx, files.map((rel) => ({ rel, inClaims: rel.slice(ctx.claimsRel.length + 1), body: got.get(`${commit}:${prefix ? `${prefix}/` : ""}${rel}`) ?? "" })));
  return linkGraph(ctx);
}
// The task's own claims: ids absent from the spec at EVERY --own-base revision (its fork point, the default branch's
// tip when it started, a worktree's recorded base). Master's own new claims exist on its tip, so they stay foreign.
// → {is(id), list(ids), bases} | null (error added)
function ownOf(root, revs = []) {
  const none = { is: () => false, list: () => [], bases: [] };
  if (!revs.length) return none;
  const prefix = gitPrefix(root, "--own-base");
  if (prefix === null) return null;
  const sets = [], bases = [];
  for (const rev of revs) {
    const commit = resolveRev(root, rev, "--own-base");
    if (!commit) return null;
    const g = loadAt(root, prefix, commit);
    if (!g) return null;
    sets.push(new Set(Object.keys(g.m.claims)));
    bases.push({ rev, commit });
  }
  const is = (id) => sets.every((k) => !k.has(id));
  return { is, list: (ids) => [...new Set(ids)].filter(is).sort(), bases };
}
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
const canonRec = (v) => (v === undefined ? null : JSON.stringify(sortKeys(v)));

// § whose prose or record changed from base to head (a revision, or the working tree), plus deletions and existing
// H1s that gained an H2; minus § created in between. That list is the foreign § a change touched.
function foreign(root, opt) {
  const prefix = gitPrefix(root, "foreign");
  if (prefix === null) return {};
  const base = resolveRev(root, opt.base, "--base");
  const head = opt.head !== undefined ? resolveRev(root, opt.head, "--head") : undefined;
  if (!base || head === null) return {};
  const b = loadAt(root, prefix, base);
  const h = head ? loadAt(root, prefix, head) : load(root, opt.spec ?? DEFAULT_SPEC);
  const range = { base: { rev: opt.base, commit: base }, head: head ? { rev: opt.head, commit: head } : { rev: null, worktree: true, spec: opt.spec ?? DEFAULT_SPEC } };
  if (!b || !h || exitOf(findings) === 2) return { ...range, foreign: null, changes: null, created: null };
  const has = (ctx, id) => Object.hasOwn(ctx.m.claims, id);
  const all = [...new Set([...Object.keys(b.m.claims), ...Object.keys(h.m.claims)])].sort();
  const created = all.filter((id) => !has(b, id) && has(h, id));
  const kinds = new Map(), mark = (id, k) => kinds.set(id, [...(kinds.get(id) ?? []), k]);
  for (const id of all) {
    if (!has(h, id)) { if (has(b, id)) mark(id, "deleted"); continue; }
    if (!has(b, id)) continue;
    if ((b.decls.get(id)?.text ?? null) !== (h.decls.get(id)?.text ?? null)) mark(id, "text");
    if (canonRec(b.m.claims[id]) !== canonRec(h.m.claims[id])) mark(id, "record");
  }
  const children = new Map();
  for (const id of created) {
    const p = parentOf(id, h.dirKinds);
    if (p && has(b, p) && has(h, p)) children.set(p, [...(children.get(p) ?? []), id]);
  }
  for (const p of children.keys()) mark(p, "child-added");
  const own = ownOf(root, opt.ownBase);
  if (!own) return { ...range, foreign: null, changes: null, created: null };
  // A deleted § whose body (all but its heading) reappears under a created id was renamed; it stays foreign.
  const body = (ctx, id) => { const t = ctx.decls.get(id)?.text; return t ? t.split("\n").slice(1).join("\n").trim() : null; };
  const renamedTo = (id) => { const t = body(b, id); return t ? created.find((c) => body(h, c) === t) : undefined; };
  const changes = [...kinds.keys()].sort().filter((id) => !own.is(id)).map((id) => {
    const r = kinds.get(id).includes("deleted") ? renamedTo(id) : undefined;
    return { id, change: kinds.get(id).join("+"), ...(children.has(id) ? { children: children.get(id) } : {}), ...(r ? { renamedTo: r } : {}) };
  });
  const out = { ...range, foreign: changes.map((c) => c.id), changes, created };
  if (own.bases.length) Object.assign(out, { own: own.list([...kinds.keys(), ...created]), ownBases: own.bases });
  if (opt.landing) Object.assign(out, landing(root, prefix, { base, head, b, h, changes, created, own, spec: opt.spec ?? DEFAULT_SPEC, drafts: opt.drafts }));
  return out;
}

// ---------------------------------------------------------------- landing: what a merge or promote lands besides §
// (a) unmappedChanged: files the range changed (deletions too) that no claim's `code` maps in the head spec;
// (b) mappedUntouched: § whose mapped code changed while their text and record didn't (advisory);
// (c) unpromotedDrafts: draft records left unpromoted in worktrees the range brings in;
// handResolved: when head is a merge commit, § whose text or record differs from every parent's (a hand resolution).
const MAX_LANDING_DRAFTS = 20;
const DRAFT_TOOL = join(dirname(fileURLToPath(import.meta.url)), "sova-spec-draft.mjs");
function landing(root, prefix, { base, head, b, h, changes, created, own, spec, drafts }) {
  if (!head && !filterFree(root, base)) return {};
  const diff = git(root, ["diff", "--name-status", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--relative", base, ...(head ? [head] : []), "--", "."]);
  if (diff.status !== 0) { add("error", "git-failed", `git diff: ${diff.error ?? diff.err.trim()}`); return {}; }
  const status = new Map(), parts = diff.out.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) status.set(parts[i + 1], parts[i][0]);
  if (!head) {
    const others = git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", "."]);
    if (others.status === 0) for (const p of nulList(others.out)) status.set(p, "A");
  }
  // The spec graph is never code, nor is anything under .sova/.
  const paths = [...status.keys()].filter((p) => !(p === ".sova" || p.startsWith(".sova/") || p === spec || p.startsWith(spec + "/"))).sort();
  const norm = (c) => posix.normalize(toPosix(c));
  const mapped = new Map();
  for (const [id, r] of h.claims) for (const c of r.code ?? []) mapped.set(norm(c), [...(mapped.get(norm(c)) ?? []), id]);
  const bd = h.m.boundary && Array.isArray(h.m.boundary.include) ? (() => { const n = findings.length, x = readBoundary(h); findings.length = n; return x || null; })() : null;
  const unmappedChanged = paths.filter((p) => !mapped.has(p)).map((p) => ({ path: p, status: status.get(p), inBoundary: bd ? bd.inBoundary(p) : false }));
  const listed = new Set([...changes.map((c) => c.id), ...created]);
  const hit = new Map();
  for (const p of paths) for (const id of mapped.get(p) ?? []) if (!listed.has(id) && !own.is(id)) hit.set(id, [...(hit.get(id) ?? []), p]);
  const mappedUntouched = [...hit.keys()].sort().map((id) => ({ id, files: hit.get(id) }));
  const scan = unpromotedDrafts(root, prefix, base, head, drafts);
  return { unmappedChanged, mappedUntouched, ...scan, handResolved: head ? handResolved(root, prefix, head, h) : [] };
}

// Draft records not yet promoted, in every worktree whose HEAD the range brings in (an ancestor of head, not of base),
// never the default branch's own checkout; with no --head, the root's own drafts too; and each --drafts DIR (a project
// root) the caller names. A record in conflict that its
// draft already promoted (current moved on since) is not unpromoted. → [{draft, worktree, ids}]
function unpromotedDrafts(root, prefix, base, head, extra = []) {
  const out = [], trees = [];
  const list = git(root, ["worktree", "list", "--porcelain", "-z"]);
  const target = defaultBranchOf(root);
  if (list.status === 0) {
    let cur = {};
    for (const f of [...list.out.split("\0"), ""]) {
      if (!f) { if (cur.path) trees.push(cur); cur = {}; continue; }
      const sp = f.indexOf(" "), k = sp < 0 ? f : f.slice(0, sp), v = sp < 0 ? "" : f.slice(sp + 1);
      if (k === "worktree") cur.path = v; else if (k === "HEAD") cur.head = v; else if (k === "branch") cur.branch = v.replace(/^refs\/heads\//, "");
    }
  }
  const here = realpathSync(root);
  const pick = [];
  for (const t of trees) {
    const proot = prefix ? join(t.path, prefix) : t.path;
    let same = false;
    try { same = realpathSync(proot) === here; } catch { continue; }
    if (!head) { if (same) pick.push(proot); continue; }
    if (!t.head || (target && t.branch === target)) continue;
    const anc = (a, d) => git(root, ["merge-base", "--is-ancestor", a, d]).status === 0;
    if (anc(t.head, head) && !anc(t.head, base)) pick.push(proot);
  }
  if (!head && !pick.length) pick.push(root);
  for (const d of extra) { const a = resolve(d); if (!pick.some((p) => { try { return realpathSync(p) === realpathSync(a); } catch { return false; } })) pick.push(a); }
  const draftScan = newDraftScan(), start = findings.length;
  if (list.status !== 0) {
    draftScan.complete = false; draftScan.unread.push({ worktree: root, reason: "cannot list worktrees" });
    add("warn", "landing-draft-unread", "cannot list worktrees; draft inventory is incomplete");
  }
  for (const proot of pick) {
    for (const { draft, d } of draftInventory(proot, draftScan, "landing-draft-unread", MAX_LANDING_DRAFTS)) {
      const promoted = new Set((Array.isArray(d?.promotions) ? d.promotions : []).flatMap((x) => (Array.isArray(x?.ids) ? x.ids : [])));
      const r = spawnSync(process.execPath, [DRAFT_TOOL, "status", draft, "--root", proot, "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
      let s;
      try { s = JSON.parse(r.stdout); } catch { s = null; }
      if (r.status === 2 || !Array.isArray(s?.ids)) {
        const reason = s?.findings?.map?.((f) => f.message).join("; ") || "status printed no usable IDs";
        draftScan.complete = false; draftScan.unread.push({ draft, worktree: proot, reason });
        add("warn", "landing-draft-unread", `draft ${draft} in ${proot}: ${reason}`); continue;
      }
      const ids = s.ids.filter((i) => i.current === "pending" || (i.current === "conflict" && !promoted.has(i.id))).map((i) => i.id).sort();
      if (ids.length) out.push({ draft, worktree: proot, ids });
    }
  }
  return { unpromotedDrafts: out, draftScan, complete: draftScan.complete,
    incomplete: [...new Set(findings.slice(start).filter((f) => ["landing-draft-unread", "landing-drafts-capped"].includes(f.code)).map((f) => f.code))] };
}

// The default branch: origin/HEAD, else master, else main (the branch a merge lands on). → name | null
function defaultBranchOf(root) {
  const o = git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (o.status === 0 && o.out.trim()) return o.out.trim().replace(/^origin\//, "");
  for (const b of ["master", "main"]) if (git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]).status === 0) return b;
  return null;
}

// § of a merge commit whose text or record differs from EVERY parent's: a hand resolution (an evil merge). → [{commit, ids}]
function handResolved(root, prefix, head, h) {
  const ps = git(root, ["rev-list", "--parents", "-n", "1", head]);
  const parents = ps.status === 0 ? ps.out.trim().split(/\s+/).slice(1) : [];
  if (parents.length < 2) return [];
  const gs = parents.map((p) => loadAt(root, prefix, p));
  if (gs.some((g) => !g)) return [];
  const has = (ctx, id) => Object.hasOwn(ctx.m.claims, id);
  const ids = [...new Set([h, ...gs].flatMap((g) => Object.keys(g.m.claims)))].sort();
  const same = (g, id) => has(g, id) === has(h, id) && (g.decls.get(id)?.text ?? null) === (h.decls.get(id)?.text ?? null) && canonRec(g.m.claims[id]) === canonRec(h.m.claims[id]);
  const hit = ids.filter((id) => gs.every((g) => !same(g, id)));
  return hit.length ? [{ commit: head, ids: hit }] : [];
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
      ...(c.outside ?? []).map((f) => `  outside boundary ${f}`), ...(c.mappedOutside ?? []).map((e) => `  mapped outside boundary ${e.path} (${e.claims.join(", ")})`),
      ...(c.deleted ?? []).map((f) => `  deleted ${f}`), ...(c.symlinks ?? []).map((f) => `  symlink not followed ${f}`), ...(c.orphanedEvidence ?? []).map((e) => `  orphaned evidence ${e.commit.slice(0, 12)} (draft ${e.draft}: ${e.ids.join(", ")})`));
    const sum = out.findings.find((f) => f.code === "foreign-summary");
    if (sum) L.push(`${sum.severity} ${sum.code}: ${sum.message}`);
    if (c.touched) L.push("touched § (read each; update and list only a visible change in its area):", ...c.touched.map((t) => {
      const lb = t.labels ? `; ${[t.labels.authority, t.labels.evidence].map((v) => v ?? "-").join("/")}` : "";
      const rq = t.requires === null ? "uninvestigated" : t.requires.join(", ") || "none declared";
      const cs = t.consumers.map((k) => `${k.id} (${k.depth})`).join(", ") || "none declared";
      const cr = t.created ? "; created" : "; foreign";
      return `  ${t.id} [${t.kind}${lb}${cr}] ${t.file}:${t.lines.join("-")} ← ${t.files.join(", ")}; requires: ${rq}; consumers: ${cs}`;
    }));
  } else if (out.census) {
    const c = out.census;
    if (c.boundary) L.push(`boundary include ${c.boundary.include.join(", ")}; exclude ${c.boundary.exclude.map((e) => `${e.path} (${e.reason ?? "no reason"})`).join(", ") || "none"}`,
      `files ${c.files}, claimed ${c.claimed.length}, unclaimed ${c.unclaimed.length}`, ...c.unclaimed.map((f) => `  unclaimed ${f}`), ...c.outside.map((f) => `  mapped outside boundary ${f}`));
  }
  if (out.command === "foreign" && out.changes) {
    L.push(`§ changed from ${out.base.rev} (${out.base.commit.slice(0, 12)}) to ${out.head.rev ? `${out.head.rev} (${out.head.commit.slice(0, 12)})` : "the working tree"}; created there: ${out.created.join(", ") || "none"}`,
      ...out.changes.map((c) => `  ${c.id} ${c.change}${c.children ? ` (${c.children.join(", ")})` : ""}${c.renamedTo ? ` → ${c.renamedTo}` : ""}`));
    if (out.own) L.push(`the task's own § (absent at ${out.ownBases.map((x) => x.rev).join(", ")}): ${out.own.join(", ") || "none"}`);
    if (out.unmappedChanged) L.push(...out.unmappedChanged.map((f) => `  unmapped ${f.status} ${f.path}${f.inBoundary ? " (in boundary)" : ""}`),
      ...out.mappedUntouched.map((m) => `  mapped code changed, prose not: ${m.id} (${m.files.join(", ")})`),
      ...out.unpromotedDrafts.map((d) => `  unpromoted in draft ${d.draft} (${d.worktree}): ${d.ids.join(", ")}`),
      ...out.handResolved.map((x) => `  hand-resolved in merge ${x.commit.slice(0, 12)}: ${x.ids.join(", ")}`));
  }
  if (out.code?.length) L.push("code (evidence locations):", ...out.code.map((c) => `  ${c.path} ${c.state}`));
  if (out.frontier?.length) L.push("frontier:", ...out.frontier.map((f) => `  ${f.id} ${f.reason}${f.of ? ` (from ${f.of})` : ""}`));
  for (const f of out.findings) L.push(`${f.severity} ${f.code}: ${f.message}${where(f) ? ` [${where(f)}]` : ""}`);
  if (out.notice) L.push(`note: ${out.notice}`);
  if (out.command === "foreign" && out.foreign) L.push(`Foreign § changed: ${out.foreign.join(", ") || "none"}`);
  L.push(`exit ${out.exit}`);
  return L.join("\n") + "\n";
}

function packetMain(opt) {
  const budget = packetBudget(opt.budget);
  const write = (out) => { process.stdout.write(serializePacket(out)); return out.exit; };
  if (budget === null) return write(packetError("usage"));
  if (opt.usage) return write(packetError("usage", budget));
  if (opt.help) return write({ tool: "sova-spec", command: "packet", exit: 0, status: "done", budget, help: PACKET_HELP });
  opt.spec ??= DEFAULT_SPEC;
  packetInputs = { files: [], tree: [] };
  const root = findSpec(opt);
  if (!root) return write({ ...packetError("graph-untrusted", budget), cause: "manifest-not-found" });
  const ctx = load(root, opt.spec);
  if (!ctx || exitOf(findings) === 2 || !ctx.claims.has(opt.id)) return write({ ...packetError("graph-untrusted", budget),
    ...(findings.some((f) => f.code === "manifest-not-found") ? { cause: "manifest-not-found" } : {}) });
  if (opt.alias) add("note", "id-alias", `${opt.alias} is not a § identifier; read as ${opt.id} (did you mean ${opt.id}?)`, { id: opt.id });
  const result = scope(ctx, opt.id);
  const passages = packetOrder(ctx, opt.id, result.passages, parentOf);
  // Notes about any claim the closure delivers travel with it, after the closure, each once.
  for (const { id, targets } of aboutDelivered(ctx, new Set(passages.map((p) => p.id)))) {
    const reasons = targets.map((t) => ({ reason: "about", of: t })), known = passages.find((p) => p.id === id);
    if (known) { for (const r of reasons) if (!known.reasons.some((k) => k.reason === "about" && k.of === r.of)) known.reasons.push(r); continue; }
    const d = ctx.decls.get(id), rec = ctx.claims.get(id);
    const p = { id, kind: rec.kind, ...labelsOf(rec), file: d.file, lines: d.lines, reasons, text: d.text, provenance: provenance(ctx, id) };
    passages.push(p); result.passages.push(p);
  }
  const frame = frameOf(ctx);
  frameFinding(frame, add);
  return write(packetPage({ identity: { root, spec: opt.spec, id: opt.id, readPolicy: reviewPolicy ? "review" : "default" },
    inputs: packetInputs, result, findings, passages, part: opt.part, cursor: opt.cursor, budget, frame }));
}

// The pull commands (toc, read) live in their own modules and reach the graph only through the core's own loader.
const pullCore = () => ({ findSpec, load, specDir, parentOf, exitOf, findings: () => findings, DEFAULT_SPEC, codeState: (root, p) => safePath(root, p).state });
// The look commands (map, where, graph, impact --near) also read one source file, through the core's refusal rules.
const lookCore = () => ({ ...pullCore(), readSource: (root, rel) => readInput(root, rel) });

function main(argv) {
  const pull = pullCommand(argv);
  if (pull?.command === "toc") return tocMain(pull.rest, pullCore());
  if (pull?.command === "read") return readMain(pull.rest, pullCore());
  const look = lookCommand(argv);
  if (look?.command === "map") return mapMain(look.rest, lookCore());
  if (look?.command === "where") return whereMain(look.rest, lookCore());
  if (look?.command === "graph") return graphMain(look.rest, lookCore());
  if (look?.command === "impact-near") return nearMain(look.rest, lookCore());
  const opt = parseArgs(argv);
  packetInvocation = argv[0] === "packet" || opt.pos[0] === "packet";
  reviewPolicy = opt["read-policy"] === "review"; assessmentPolicy = false;
  if (packetInvocation) return packetMain(opt);
  let out = { tool: "sova-spec", command: opt.cmd ?? null };
  if (opt.help) { process.stdout.write(USAGE + "\n"); return 0; }
  if (opt.usage) add("error", "usage", `${opt.usage}. ${USAGE}`);
  else {
    const draftSpec = opt.spec;
    opt.spec ??= DEFAULT_SPEC;
    out.spec = opt.spec;
    const root = findSpec(opt) ?? (opt.cmd === "foreign" ? process.cwd() : null);
    if (root && opt.cmd === "foreign") out = { ...out, root, ...foreign(root, { ...opt, spec: draftSpec }), notice: FOREIGN_NOTICE };
    else if (!root) add("error", "manifest-not-found", `no ${opt.spec}/manifest.json in this directory or any parent`);
    else {
      out.root = root;
      const ctx = load(root, opt.spec);
      if (ctx) {
        const broken = exitOf(findings) === 2;
        if (opt.alias) add("note", "id-alias", `${opt.alias} is not a § identifier; read as ${opt.id} (did you mean ${opt.id}?)`, { id: opt.id });
        if ((opt.cmd === "scope" || opt.cmd === "impact") && !ctx.claims.has(opt.id)) add("error", "unknown-id", `${opt.id} has no manifest record${opt.alias ? ` (read from ${opt.alias})` : ""}`, { id: opt.id });
        else if (broken && opt.cmd !== "check") add("note", "untrusted", "graph errors prevent a trustworthy result; fix them first");
        else {
          const run = { check: () => check(ctx), census: () => census(ctx, opt.changed && { base: opt.base ?? "HEAD", related: opt.related, ownBase: opt.ownBase }), scope: () => scope(ctx, opt.id, opt.budget), impact: () => impact(ctx, opt.id) }[opt.cmd];
          out = { ...out, ...(opt.id ? { id: opt.id } : {}), ...run(), notice: NOTICE };
        }
      }
    }
  }
  out.exit = exitOf(findings);
  out.findings = findings;
  process.stdout.write(opt.json ? JSON.stringify(out, null, 2) + "\n" : human(out));
  // Mirrored on stderr, which pipes that filter stdout (grep, head, a JSON key-pick) leave alone.
  const sum = findings.find((f) => f.code === "foreign-summary");
  if (sum && !process.stdout.isTTY) process.stderr.write(`sova-spec: ${sum.message}\n`);
  return out.exit;
}

// Internal stdlib reader for companions: one graph per capture, existing command semantics.
// Every synchronous query scopes all module state and JSON-detaches its result, like a CLI child.
// No reader or source cache is shared across captures or status invocations.
export function createInspection(root, { spec = DEFAULT_SPEC, readPolicy = "default" } = {}) {
  root = resolve(root);
  let ctx = null, loaded = [], selected = spec, sourceFiles = [], sourceConflict = false;
  const within = (base, fn) => {
    const saved = { findings, reviewPolicy, assessmentPolicy, packetInputs, packetInvocation };
    findings = [...base]; reviewPolicy = readPolicy !== "default"; assessmentPolicy = readPolicy === "assessment"; packetInputs = null; packetInvocation = false;
    try { return fn(); } finally {
      ({ findings, reviewPolicy, assessmentPolicy, packetInputs, packetInvocation } = saved);
    }
  };
  within([], () => {
    const choice = specDir(spec);
    if (choice.why || !["default", "review", "assessment"].includes(readPolicy)) add("error", "usage", "invalid inspection spec or read policy");
    else {
      selected = choice.rel;
      // Reuse raw-byte hashing at the actual read, not re-encoded parsed text or a second open.
      packetInputs = { files: [], tree: [] };
      ctx = load(root, selected);
      const seen = new Map();
      sourceFiles = packetInputs.files.map(([path, sha256]) => {
        if (seen.has(path) && seen.get(path) !== sha256) sourceConflict = true;
        if (!seen.has(path)) seen.set(path, sha256); // never overwrite the first parsed version
        return { path, sha256 };
      });
    }
    loaded = [...findings];
  });
  const query = (command, id, changed) => within(loaded, () => {
    let out = { tool: "sova-spec", command, spec: selected, root };
    if (ctx) {
      const broken = exitOf(findings) === 2;
      if ((command === "scope" || command === "impact") && !ctx.claims.has(id)) add("error", "unknown-id", `${id} has no manifest record`, { id });
      else if (broken && command !== "check") add("note", "untrusted", "graph errors prevent a trustworthy result; fix them first");
      else {
        const run = { check: () => check(ctx), census: () => census(ctx, changed), scope: () => scope(ctx, id), impact: () => impact(ctx, id) }[command];
        out = { ...out, ...(id ? { id } : {}), ...run(), notice: NOTICE };
      }
    }
    out.exit = exitOf(findings); out.findings = findings;
    return JSON.parse(JSON.stringify(out));
  });
  return Object.freeze({
    sourceHashes: () => JSON.parse(JSON.stringify({ files: sourceFiles, conflict: sourceConflict })),
    check: () => query("check"),
    scope: (id) => query("scope", id),
    impact: (id) => query("impact", id),
    census: ({ base, related = false } = {}) => query("census", undefined, base === undefined ? false : { base, related, ownBase: [] }),
  });
}

// The installed agent entrypoint is often reached through directory symlinks. Import is silent;
// realpath comparison also keeps --preserve-symlinks-main direct CLI launches working.
const direct = (() => {
  try { return !!process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (direct) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) {
    if (packetInvocation) {
      process.stdout.write(serializePacket(packetError("graph-untrusted")));
      process.exitCode = 2;
    } else {
      add("error", "internal-error", String(e?.stack ?? e));
      process.stdout.write((process.argv.includes("--json") ? JSON.stringify({ tool: "sova-spec", exit: 2, findings }, null, 2) : `error internal-error: ${e?.message ?? e}\nexit 2`) + "\n");
      process.exitCode = 2;
    }
  }
}
