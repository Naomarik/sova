#!/usr/bin/env node
// Migration parity check. Migration mechanics only: it proves the migration output is a lossless,
// reversible transform of the retained legacy bytes. It says nothing about whether the product
// implements them, and it writes nothing in the project (the rebuild goes to a temp directory).
//   node verify.mjs [--current SPECDIR] [--draft SPECDIR] [--live]
// It rebuilds the migration output from the captured bytes (the record of the migration moment) and
// checks that. It then reports whether the live graphs (default .sova/spec and
// .sova/spec/drafts/legacy-working/spec) still equal that output. After a promotion or edit they
// won't, and that is expected: it is noted, not failed. The live graph's own validity is the core's check.
// --live (pre-move only): also compare the live spec/*.md with the capture, before redirects.
// Local-only inputs (legacy/worktree/, the draft, pilot/) may be absent, as in a public clone. Their
// checks are reported UNAVAILABLE, never as passed.
// Exit 0 everything checked and passed, 3 passed but some inputs unavailable, 1 live drift (--live),
// 2 a parity failure.
import { readFileSync, readdirSync, existsSync, lstatSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname, resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { inverse, headings } from "./transform.mjs";
import { FILES, SECTION_NUMBERS, SECTION_ALIASES, ABSENT, EDGES, fileMap, claimFileOf, buildVariants } from "./migrate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(HERE, "..");
const ROOT = resolve(HERE, "../../..");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const currentDir = resolve(ROOT, opt("--current", ".sova/spec"));
const draftDir = resolve(ROOT, opt("--draft", ".sova/spec/drafts/legacy-working/spec"));
const fails = [], drift = [], ok = [], unavailable = [], notes = [];
const fail = (m) => fails.push(m);

const inv = JSON.parse(readFileSync(join(HERE, "inventory.json"), "utf8"));
const map = JSON.parse(readFileSync(join(HERE, "legacy-map.json"), "utf8"));
const fm = fileMap();

const worktreeMissing = [];
// 1. Retained originals match the inventory, and HEAD bytes match the recorded Git blobs.
for (const e of inv.files) {
  if (e.retained.head) {
    if (!existsSync(join(SPEC, e.retained.head))) { fail(`${e.retained.head}: missing (HEAD originals are part of the published record)`); continue; }
    const b = readFileSync(join(SPEC, e.retained.head));
    if (sha(b) !== e.headSha256) fail(`${e.retained.head}: sha256 differs from inventory`);
    try {
      const blob = execFileSync("git", ["hash-object", "--stdin"], { input: b, cwd: ROOT, stdio: ["pipe", "pipe", "ignore"] }).toString().trim();
      if (blob !== e.headBlob) fail(`${e.retained.head}: Git blob ${blob} != recorded ${e.headBlob}`);
    } catch { /* no Git: the sha256 check stands */ }
  }
  if (e.retained.worktree) {
    if (!existsSync(join(SPEC, e.retained.worktree))) { worktreeMissing.push(e.retained.worktree); continue; }
    if (sha(readFileSync(join(SPEC, e.retained.worktree))) !== e.worktreeSha256) fail(`${e.retained.worktree}: sha256 differs from inventory`);
  }
}
const withDraft = !worktreeMissing.length;
if (!withDraft) unavailable.push(`worktree originals (${worktreeMissing.length} of ${inv.files.filter((e) => e.retained.worktree).length} absent): the draft variant is not rebuilt or checked`);
if (!fails.length) ok.push(`retained originals: ${inv.files.filter((e) => e.retained.head).length} HEAD, ${inv.files.filter((e) => e.retained.worktree).length - worktreeMissing.length} worktree`);

// 2. Each variant: inverse(claims) == retained bytes, byte for byte; no unmapped claim files; manifest records == headings.
function variant(name, dir, pick) {
  if (!existsSync(join(dir, "manifest.json"))) return fail(`${name}: no manifest at ${dir}`);
  const before = fails.length;
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const vmap = map.files[name];
  const expectIds = new Map();
  const onDisk = [];
  const walk = (d, rel = "") => { for (const n of readdirSync(d).sort()) { const p = join(d, n); const st = lstatSync(p); if (st.isSymbolicLink()) fail(`${name}: symlink ${rel}${n}`); else if (st.isDirectory()) walk(p, `${rel}${n}/`); else onDisk.push(`${rel}${n}`); } };
  walk(join(dir, "claims"));
  const mapped = new Set();
  let bytes = 0;
  for (const e of inv.files) {
    const src = pick(e);
    if (!src) { if (vmap[e.path]) fail(`${name}: map lists ${e.path} but the variant has no source`); continue; }
    const m = vmap[e.path];
    if (!m) { fail(`${name}: ${e.path} is not mapped`); continue; }
    const claimFile = claimFileOf(e.id);
    mapped.add(claimFile);
    for (const h of m.headings) expectIds.set(h.id, h.kind);
    const p = join(dir, "claims", claimFile);
    if (!existsSync(p)) { fail(`${name}: missing claims/${claimFile}`); continue; }
    const migrated = readFileSync(p, "utf8");
    if (sha(Buffer.from(migrated, "utf8")) !== m.claimSha256) fail(`${name}: claims/${claimFile} differs from the recorded migration output`);
    const original = readFileSync(join(SPEC, src));
    bytes += original.length;
    let back;
    try { back = inverse(migrated, { claimFile, fileMap: fm }); } catch (err) { fail(`${name}: ${err.message}`); continue; }
    if (sha(Buffer.from(back, "utf8")) !== sha(original)) {
      const a = back.split("\n"), b = original.toString("utf8").split("\n");
      const k = a.findIndex((l, i) => l !== b[i]);
      fail(`${name}: claims/${claimFile} does not invert to ${src} (first difference at line ${k + 1})`);
      continue;
    }
    // Declared ids are exactly the mapped headings, in order.
    const decl = headings(migrated.split("\n")).filter((h) => h.level <= 2).map((h) => h.text.split(" ")[0]);
    const want = m.headings.map((h) => h.id);
    if (decl.join() !== want.join()) fail(`${name}: claims/${claimFile} headings differ from the map`);
  }
  for (const f of onDisk) if (!mapped.has(f)) fail(`${name}: claims/${f} is not a migrated file (unmapped content)`);
  const recs = manifest.claims ?? {};
  for (const [id, kind] of expectIds) {
    if (!recs[id]) fail(`${name}: ${id} has no manifest record`);
    else if (recs[id].kind !== kind) fail(`${name}: ${id} kind ${recs[id].kind} != mapped ${kind}`);
  }
  for (const id of Object.keys(recs)) if (!expectIds.has(id)) fail(`${name}: record ${id} is not a migrated heading`);
  for (const [id, r] of Object.entries(recs)) if (r.requires !== undefined && r.requires.length === 0) fail(`${name}: ${id} has a fabricated requires: []`);
  // Relative links inside claims resolve to files of this variant.
  for (const f of mapped) {
    const t = readFileSync(join(dir, "claims", f), "utf8");
    for (const m2 of t.matchAll(/\]\(([^)\s#]+\.md)(#[^)\s]*)?\)/g)) {
      if (/^[a-z]+:/.test(m2[1])) continue;
      const target = posix.normalize(posix.join(posix.dirname(f), m2[1]));
      if (!mapped.has(target) && !existsSync(join(dir, "claims", target))) fail(`${name}: claims/${f} links to missing ${m2[1]}`);
    }
  }
  // requires: only the authored edges, each quoting its own source passage, each target declared.
  const passage = new Map();
  for (const f of mapped) {
    const lines = readFileSync(join(dir, "claims", f), "utf8").split("\n");
    const hs = headings(lines).filter((h) => h.level <= 2);
    hs.forEach((h, k) => passage.set(h.text.split(" ")[0], lines.slice(h.i, hs[k + 1]?.i ?? lines.length).join(" ").replace(/\s+/g, " ")));
  }
  let edges = 0;
  const edgeFails = fails.length;
  for (const [id, r] of Object.entries(recs)) {
    const authored = EDGES[id] ?? [];
    const want = [...new Set(authored.map(([t]) => t))].sort();
    if ((r.requires ?? null) === null ? authored.length : JSON.stringify(r.requires) !== JSON.stringify(want)) fail(`${name}: ${id} requires differ from the authored edges`);
    for (const [to, quote] of authored) {
      edges++;
      if (!recs[to]) fail(`${name}: ${id} → ${to}: target has no record`);
      if (!passage.get(id)?.includes(quote.replace(/\s+/g, " "))) fail(`${name}: ${id} → ${to}: quote not in the source passage: ${quote}`);
    }
  }
  if (fails.length === edgeFails) ok.push(`${name}: ${edges} authored requires edges, each quoted from its source passage`);
  // Retired pilot ids are never declared again.
  for (const [id, p] of Object.entries(map.pilotIds)) if (p.status === "retired" && recs[id]) fail(`${name}: retired pilot id ${id} is reused`);
  if (fails.length === before) ok.push(`${name}: ${mapped.size} files, ${Object.keys(recs).length} records, ${bytes} original bytes invert exactly`);
}
// 2a. Rebuild the migration output from the captured bytes and check it (the migration record).
const snap = mkdtempSync(join(tmpdir(), "sova-migration-verify-"));
const trees = {};
try {
  const retired = new Set(Object.entries(map.pilotIds).filter(([, p]) => p.status === "retired").map(([id]) => id));
  const built = buildVariants(inv, retired, withDraft);
  for (const [name, v] of Object.entries({ current: built.cur, draft: built.draft })) {
    if (!v) continue;
    const dir = join(snap, name);
    const files = { "manifest.json": JSON.stringify(v.manifest, null, 2) + "\n" };
    for (const [f, t] of Object.entries(v.files)) files[`claims/${f}`] = t;
    for (const [f, t] of Object.entries(files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), t); }
    trees[name] = files;
  }
} catch (err) { fail(`rebuild from the captured bytes failed: ${err.message}`); }
if (trees.current) variant("current", join(snap, "current"), (e) => e.retained.head);
if (trees.draft) variant("draft", join(snap, "draft"), (e) => (e.state === "deleted" ? null : e.retained.worktree ?? e.retained.head));

// 2b. Do the live graphs still equal the migration output? A difference is expected after a promotion
// or edit, so it is a note, not a parity result.
function compareLive(name, dir) {
  if (!trees[name]) return;
  if (!existsSync(join(dir, "manifest.json"))) return unavailable.push(`live ${name} graph (${dir}) is absent: not compared`);
  const live = new Set(["manifest.json"]);
  const walk = (d, rel) => { for (const n of readdirSync(d).sort()) { const p = join(d, n); if (lstatSync(p).isDirectory()) walk(p, `${rel}${n}/`); else live.add(`${rel}${n}`); } };
  if (existsSync(join(dir, "claims"))) walk(join(dir, "claims"), "claims/");
  const differ = [...new Set([...live, ...Object.keys(trees[name])])].sort()
    .filter((f) => !trees[name][f] || !live.has(f) || sha(readFileSync(join(dir, f))) !== sha(Buffer.from(trees[name][f], "utf8")));
  if (differ.length) notes.push(`live ${name} differs from the migration output in ${differ.length} file(s) (${differ.slice(0, 5).join(", ")}${differ.length > 5 ? ", …" : ""}). Expected after a promotion or edit; not a parity result. Its validity is the core's check.`);
  else ok.push(`live ${name} (${dir.slice(ROOT.length + 1) || dir}) equals the migration output`);
}
compareLive("current", currentDir);
compareLive("draft", draftDir);
rmSync(snap, { recursive: true, force: true });

// 3. Every §N citation in legacy text and in the code resolves (or is known absent / not a section).
const NOT_SECTIONS = new Set(["§N", "§REST"]); // overview's placeholder; protocol's REST block in shared/protocol.ts
const resolveN = (t) => { const n = SECTION_ALIASES[t] ?? t; return map.sections[n] ? n : null; };
const cites = new Map();
const scan = (label, text) => { for (const m of text.matchAll(/§([0-9][0-9]?[a-z]?|copy-deck|N|REST)\b/g)) cites.set(`§${m[1]}`, [...(cites.get(`§${m[1]}`) ?? []), label]); };
for (const e of inv.files) for (const src of Object.values(e.retained)) if (existsSync(join(SPEC, src))) scan(src, readFileSync(join(SPEC, src), "utf8"));
try {
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "src", "server", "shared"], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().split("\n").filter(Boolean);
  for (const f of files) { const p = join(ROOT, f); if (existsSync(p) && lstatSync(p).isFile()) scan(f, readFileSync(p, "utf8")); }
} catch { unavailable.push("§N citations in src/, server/ and shared/: no Git to list them, so only the legacy text was scanned"); }
const unresolved = [...cites.keys()].filter((c) => !NOT_SECTIONS.has(c) && !resolveN(c));
if (unresolved.length) fail(`unresolved §N: ${unresolved.map((c) => `${c} (${cites.get(c)[0]})`).join(", ")}`);
for (const n of Object.keys(SECTION_NUMBERS)) if (map.sections[n].id !== FILES[SECTION_NUMBERS[n]][0]) fail(`map: ${n} id drifted`);
ok.push(`§N citations: ${[...cites.keys()].length} distinct, all resolve (${Object.keys(ABSENT).join(", ")} known absent; ${[...NOT_SECTIONS].join(", ")} not sections)`);

// 4. The archived pilot graph is byte-exact.
if (!existsSync(join(HERE, "pilot/SHA256SUMS"))) unavailable.push("pilot archive (migration/pilot/) is absent: not checked");
else {
  for (const line of readFileSync(join(HERE, "pilot/SHA256SUMS"), "utf8").split("\n").filter(Boolean)) {
    const [h, f] = line.split(/\s+/);
    if (!existsSync(join(HERE, "pilot", f)) || sha(readFileSync(join(HERE, "pilot", f))) !== h) fail(`pilot archive ${f} changed or missing`);
  }
  if (!fails.some((f) => f.startsWith("pilot"))) ok.push("pilot archive: byte-exact");
}

// 5. Live legacy files versus the capture (before redirects are applied).
if (args.includes("--live")) {
  const live = readdirSync(join(ROOT, "spec")).filter((f) => f.endsWith(".md")).sort();
  for (const f of live) if (!FILES[f]) drift.push(`spec/${f}: new, uncaptured`);
  for (const e of inv.files) {
    const p = join(ROOT, e.path);
    const cur = existsSync(p) ? sha(readFileSync(p)) : null;
    if (cur !== (e.worktreeSha256 ?? null)) drift.push(`${e.path}: live bytes differ from the capture`);
  }
  ok.push(`live spec/: ${drift.length ? `${drift.length} drifted` : "identical to the capture"}`);
}

for (const m of ok) console.log(`ok    ${m}`);
for (const m of notes) console.log(`note  ${m}`);
for (const m of unavailable) console.log(`UNAVAILABLE ${m}`);
for (const m of drift) console.log(`DRIFT ${m}`);
for (const m of fails) console.log(`FAIL  ${m}`);
if (!fails.length && unavailable.length) console.log("partial: every available check passed, but the checks above marked UNAVAILABLE did not run");
process.exit(fails.length ? 2 : drift.length ? 1 : unavailable.length ? 3 : 0);
