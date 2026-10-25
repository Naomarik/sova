// Shared helpers for the record-layout tests (layout*.test.mjs, migrate, cross-layout-merge,
// pre-cutover-merge). Node stdlib only; Git fixtures use the git CLI.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync, cpSync, realpathSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { writeSpec, recordFiles, areaPathOf, byCodePoint, CLAIMS_POINTER } from "../spec-fixture.mjs";

export { writeSpec, recordFiles, areaPathOf, byCodePoint, CLAIMS_POINTER };
const HERE = dirname(fileURLToPath(import.meta.url));
export const CORE_DIR = resolve(HERE, "../../core");
export const CORE = join(CORE_DIR, "sova-spec.mjs");
export const DRAFT = join(CORE_DIR, "sova-spec-draft.mjs");
export const REPO = resolve(HERE, "../../../../..");
export const SPEC = ".sova/spec";
export const sha = (b) => createHash("sha256").update(b).digest("hex");
export const hasGit = spawnSync("git", ["--version"]).status === 0;

const roots = [];
process.on("exit", () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
export function tmp(prefix = "spec-layout-") { const r = mkdtempSync(join(tmpdir(), prefix)); roots.push(r); return r; }
export function put(root, rel, text) { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }
export const read = (root, rel) => readFileSync(join(root, rel), "utf8");
export const env = (root) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_") && k !== "SPEC_TEST_LAYOUT")), HOME: join(root, ".home"), XDG_CONFIG_HOME: join(root, ".home"), TZ: "UTC" });

// ---------------------------------------------------------------- the fixture spec
// Every record feature the loader knows (kinds, labels, requires across areas, embeds, about, notOwned,
// core, agreed, members, a directory kind two levels deep, a missing code path, a dangling requires),
// record keys in a non-alphabetical order (a serializer that sorts keys inside a record changes bytes),
// and ids whose code-point order differs from their declaration order (§ed.seed/* sort before §ed/seed).
export const META = {
  _: "Fixture documentation for the record-layout tests.",
  grammar: { claimsRoot: "claims/", directoryKinds: ["section"] },
  boundary: { include: ["src"], exclude: [{ path: "src/gen", reason: "generated" }] },
};
export const RECORDS = {
  "§ed/seed": { kind: "surface", authority: "accepted", evidence: "verified", requires: [], code: ["src/editor.ts"], notOwned: ["§ot/base"] },
  "§ed.seed/compose": { kind: "behavior", code: ["src/editor.ts", "src/shared.ts"], authority: "accepted", requires: ["§ot/base"], agreed: { by: "omar (t)", at: "2026-10-01T10:00Z" }, evidence: "verified" },
  "§ed.seed/save": { kind: "behavior", authority: "migrated", evidence: "unreviewed", code: ["src/save.ts"] },
  "§ot/base": { kind: "note", authority: "accepted", evidence: "reviewed", core: true, requires: [] },
  "§ot/uses": { kind: "behavior", authority: "accepted", requires: ["§ed.seed/compose"], embeds: ["§ed/seed"], code: ["src/other.ts"] },
  "§ot/why": { kind: "note", about: ["§ed.seed/compose"], authority: "accepted" },
  "§ot/second": { kind: "behavior", requires: ["§ot/uses"], authority: "accepted", code: ["src/missing.ts"] },
  "§ot/dangle": { kind: "behavior", requires: ["§zz/missing"], authority: "accepted" },
  "§ot/unrelated": { kind: "behavior", authority: "accepted" },
  "§section/bundle": { kind: "section", members: ["§ed.seed/save", "§ot/uses"], authority: "accepted" },
  "§section.ops/runbook": { kind: "section", members: ["§ot/base"], authority: "accepted" },
};
export const CLAIMS = {
  "ed/seed.md": [
    "# §ed/seed — Editor (`EditorPane`)", "", "The editor pane, where a draft is written.", "",
    "## §ed.seed/compose — Compose", "", "`Composer.send()` posts `POST /api/send` with the `draftId`. It builds on §ot/base.", "",
    "## §ed.seed/save — Save", "", "Saving keeps the draft; plain words like `save` are not tokens.", "",
  ].join("\n"),
  "ot/base.md": "# §ot/base — Base\n\nThe base everything stands on.\n",
  "ot/uses.md": "# §ot/uses — Uses\n\nIt sends through the composer (§ed.seed/compose). Then it reads `draftId`.\n",
  "ot/why.md": "# §ot/why — Why compose posts\n\nCompose posts because §ed.seed/compose must survive a reload.\n",
  "ot/second.md": "# §ot/second — Second\n\nBuilt on the user of the composer.\n",
  "ot/dangle.md": "# §ot/dangle — Dangle\n\nIt leans on something that is not written yet.\n",
  "ot/unrelated.md": "# §ot/unrelated — Unrelated\n\nNothing about editors at all.\n",
  "section/bundle.md": "# §section/bundle — Bundle\n\nA bundle of saves.\n",
  "section/ops/runbook.md": "# §section.ops/runbook — Runbook\n\nThe ops runbook groups the base.\n",
};
export const SOURCES = {
  "src/editor.ts": "export class EditorPane { send() { return Composer.send(); } } // POST /api/send with draftId\n",
  "src/shared.ts": "export const draftId = 1;\n",
  "src/save.ts": "export const save = 1;\n",
  "src/other.ts": "export const other = 1;\n",
  "src/unmapped.ts": "const x = draftId; // Composer.send()\n",
  "src/gen/out.ts": "export const generated = 1;\n",
};

/** A project with the fixture spec in one layout (or the given spec). */
export function project(layout, { meta = META, records = RECORDS, claims = CLAIMS, sources = SOURCES, root = tmp() } = {}) {
  writeSpec(root, { layout, meta, records, claims });
  for (const [rel, text] of Object.entries(sources)) put(root, rel, text);
  return root;
}

// ---------------------------------------------------------------- running the tools
function spawn(script, root, args, { cwd = root, extraEnv = {}, json = true } = {}) {
  const r = spawnSync(process.execPath, [script, ...args, "--root", root, ...(json ? ["--json"] : [])], { encoding: "utf8", cwd, env: { ...env(root), ...extraEnv }, maxBuffer: 256 * 1024 * 1024 });
  assert.equal(r.error, undefined, String(r.error));
  let j = null;
  if (json) {
    try { j = JSON.parse(r.stdout); } catch { assert.fail(`${args.join(" ")}: non-JSON stdout (status ${r.status}): ${r.stdout.slice(0, 2000)}\n${r.stderr.slice(0, 2000)}`); }
    if (j && typeof j.exit === "number") assert.equal(r.status, j.exit, `${args.join(" ")}: process status equals JSON exit`);
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, j };
}
export const core = (root, args, o) => spawn(CORE, root, args, o);
export const draft = (root, args, o) => spawn(DRAFT, root, args, o);
/** Every finding/refusal code of a core or draft-tool result. */
export const codes = (j) => [...(j?.findings ?? []).map((f) => f.code), ...(j?.refusals ?? []).map((r) => r.code), ...(j?.coreFindings ?? []).map((f) => f.code)];
export const messages = (j) => [...(j?.findings ?? []), ...(j?.refusals ?? []), ...(j?.coreFindings ?? [])].map((f) => f.message ?? "").join("\n");

/** Every page of a paged command, following next (each page's raw JSON). */
export function pages(root, args, { budget, max = 200 } = {}) {
  const out = [];
  let cursor;
  do {
    const { j } = core(root, [...args, ...(budget ? ["--budget", String(budget)] : []), ...(cursor ? ["--cursor", cursor] : [])]);
    out.push(j);
    cursor = j?.next ?? null;
    assert.ok(out.length < max, `${args.join(" ")}: more than ${max} pages`);
  } while (cursor);
  return out;
}

// ---------------------------------------------------------------- comparing outputs across layouts
// What may differ between two copies of one spec: the project root's path, commit ids (when the copies have
// their own histories), and the keys named in `opaque` (by default only the cursor tokens, which bind the raw
// input files and so differ by layout). Nothing else: ids, text, labels, edges, counts, findings, order, exit and
// status must be identical. A key listed as opaque still has to be present (or absent, or null) on both sides.
export const CURSOR_KEYS = ["next", "cursor"];
export function normalizer({ root, revs = {}, opaque = CURSOR_KEYS } = {}) {
  const keys = new Set(opaque);
  const subs = [];
  if (root) { subs.push([root, "<root>"]); try { const real = realpathSync(root); if (real !== root) subs.push([real, "<root>"]); } catch {} }
  for (const [sha, label] of Object.entries(revs)) { subs.push([sha, label]); subs.push([sha.slice(0, 12), `${label}:12`]); subs.push([sha.slice(0, 7), `${label}:7`]); }
  const str = (s) => { for (const [a, b] of subs) s = s.split(a).join(b); return s; };
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = keys.has(k) ? (x === null || x === undefined ? x : "<opaque>") : walk(x);
      return o;
    }
    return typeof v === "string" ? str(v) : v;
  };
  return walk;
}

/** The JSON paths where two values differ (for readable failures). */
export function diffPaths(a, b, path = "$", out = []) {
  if (out.length > 40) return out;
  if (a === b) return out;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], `${path}.${k}`, out);
    return out;
  }
  out.push(`${path}: ${JSON.stringify(a)?.slice(0, 200)} ≠ ${JSON.stringify(b)?.slice(0, 200)}`);
  return out;
}
/** deepEqual with the differing paths in the message. */
export function same(actual, expected, label) {
  const d = diffPaths(actual, expected);
  assert.ok(d.length === 0, `${label}: differs at\n  ${d.join("\n  ")}`);
}

/** Copy a tree (no symlinks followed). */
export const copyTree = (from, to) => cpSync(from, to, { recursive: true, verbatimSymlinks: true });

/** { relPath: sha256 } of every file under root/sub. */
export function hashTree(root, sub = SPEC, { skip = (rel) => false } = {}) {
  const out = {};
  const base = join(root, sub);
  const walk = (d) => { for (const n of readdirSync(d).sort()) { const p = join(d, n); const rel = relative(base, p); if (skip(rel)) continue; if (statSync(p).isDirectory()) walk(p); else out[rel] = sha(readFileSync(p)); } };
  if (existsSync(base)) walk(base);
  return out;
}
/** Every file's bytes under root/sub, as text: { relPath: text }. */
export function textTree(root, sub = SPEC, { skip = () => false } = {}) {
  const out = {};
  const base = join(root, sub);
  const walk = (d) => { for (const n of readdirSync(d).sort()) { const p = join(d, n); const rel = relative(base, p); if (skip(rel)) continue; if (statSync(p).isDirectory()) walk(p); else out[rel] = readFileSync(p, "utf8"); } };
  if (existsSync(base)) walk(base);
  return out;
}
export const notDrafts = (rel) => rel === "drafts" || rel.startsWith("drafts/");

/** The layout a spec dir is in, read straight from disk: 1, 2, or "mixed" (records in manifest.json AND a record file). */
export function layoutOnDisk(root, spec = SPEC) {
  const m = JSON.parse(read(root, `${spec}/manifest.json`));
  const inRoot = !!m.claims && typeof m.claims === "object";
  const croot = String(m.grammar?.claimsRoot ?? "claims/").replace(/\/+$/, "");
  const anyJson = (d) => existsSync(d) && readdirSync(d).some((n) => { const p = join(d, n); return statSync(p).isDirectory() ? anyJson(p) : n.endsWith(".json"); });
  const files = anyJson(join(root, spec, croot));
  return inRoot && files ? "mixed" : inRoot ? 1 : 2;
}

/**
 * Edit a spec dir's records in place, in whatever layout it is in (as an agent following the docs would):
 * fn(records) mutates the { id: record } object. Layout 1 rewrites manifest.json; layout 2 rewrites every record
 * file (deleting one that ends up empty) and leaves manifest.json alone.
 */
export function editRecords(root, spec, fn) {
  const layout = layoutOnDisk(root, spec);
  assert.notEqual(layout, "mixed", `${spec} is mixed`);
  const { manifest, records } = recordsOnDisk(root, spec);
  fn(records);
  if (layout === 1) { manifest.claims = records; put(root, `${spec}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n"); return; }
  const croot = String(manifest.grammar?.claimsRoot ?? "claims/").replace(/\/+$/, "");
  const drop = (d) => { if (!existsSync(d)) return; for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) drop(p); else if (n.endsWith(".json")) unlinkSync(p); } };
  drop(join(root, spec, croot));
  for (const [rel, text] of Object.entries(recordFiles(manifest, records))) put(root, `${spec}/${rel}`, text);
}

/** The records a spec dir holds, read straight from disk in either layout, independently of the tools. */
export function recordsOnDisk(root, spec = SPEC) {
  const m = JSON.parse(read(root, `${spec}/manifest.json`));
  const croot = String(m.grammar?.claimsRoot ?? "claims/").replace(/\/+$/, "");
  const recs = {};
  const files = {};
  if (m.claims && typeof m.claims === "object") for (const [id, r] of Object.entries(m.claims)) { recs[id] = r; files[id] = "manifest.json"; }
  const base = join(root, spec, croot);
  const walk = (d) => { if (!existsSync(d)) return; for (const n of readdirSync(d).sort()) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith(".json")) { const rel = relative(join(root, spec), p); for (const [id, r] of Object.entries(JSON.parse(readFileSync(p, "utf8")))) { assert.ok(!(id in recs), `${id} in ${files[id]} and ${rel}`); recs[id] = r; files[id] = rel; } } } };
  walk(base);
  return { manifest: m, records: recs, files };
}

// ---------------------------------------------------------------- promoting a change, as a chat would
/**
 * Promote a change through a draft with the given draft tool (default: this tree's), then commit it when the
 * project is a Git repo. md: { claimsRel: text }; edit(records) mutates the draft's records in its own layout;
 * ids: what changed. Notes get --doc-only evidence, other kinds --commit HEAD (their code is committed).
 */
export function promoteChange(root, name, { md = {}, edit = () => {}, ids, tool = DRAFT, commit = true, message = name } = {}) {
  const run = (args) => {
    const r = spawnSync(process.execPath, [tool, ...args, "--root", root, "--json"], { encoding: "utf8", cwd: root, env: env(root) });
    let j; try { j = JSON.parse(r.stdout); } catch { assert.fail(`${args.join(" ")}: ${r.stdout}${r.stderr}`); }
    return j;
  };
  rmSync(join(root, SPEC, "drafts", name), { recursive: true, force: true });
  const n = run(["new", name, "--write"]);
  assert.equal(n.exit, 0, `new ${name}: ${JSON.stringify(n).slice(0, 600)}`);
  const D = `${SPEC}/drafts/${name}/spec`;
  for (const [rel, text] of Object.entries(md)) put(root, `${D}/claims/${rel}`, text);
  editRecords(root, D, edit);
  const recs = recordsOnDisk(root, D).records;
  const notes = ids.filter((i) => recs[i]?.kind === "note" || recs[i] === undefined), others = ids.filter((i) => !notes.includes(i));
  const sel = (l) => l.flatMap((i) => ["--id", i]);
  if (notes.length) { const e = run(["evidence", name, ...sel(notes), "--by", "t", "--verification", "read", "--doc-only", "--write"]); assert.equal(e.exit, 0, `evidence ${name}: ${JSON.stringify(e).slice(0, 600)}`); }
  if (others.length) { const e = run(["evidence", name, ...sel(others), "--by", "t", "--verification", "ran", "--commit", "HEAD", "--write"]); assert.equal(e.exit, 0, `evidence ${name}: ${JSON.stringify(e).slice(0, 600)}`); }
  const p = run(["promote", name, ...sel(ids), "--write"]);
  assert.equal(p.exit, 0, `promote ${name}: ${JSON.stringify(p).slice(0, 800)}`);
  if (commit) { git(root, "add", "-A"); git(root, "commit", "-qm", message); }
  return p;
}

// ---------------------------------------------------------------- git
export function git(root, ...a) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-C", root, ...a], { encoding: "utf8", env: env(root) });
  assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}${r.stdout}`);
  return r.stdout.trim();
}
export function gitTry(root, ...a) {
  return spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", root, ...a], { encoding: "utf8", env: env(root) });
}
export function gitInit(root, { ignore = [".home/", ".sova/spec/drafts/"] } = {}) {
  put(root, ".gitignore", ignore.join("\n") + "\n");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return root;
}
