// The records-file ratchet's scanner, shared by tests/layout-guard.test.mjs (pi-config/extensions/**) and
// server/spec-layout-boundary.test.ts (the rest of the repo). Node stdlib only.
//
// Only core/layout.mjs may read the spec's records. Any other source line that names the records file
// (`manifest.json`, or a `MANIFEST` constant) or reads a `claims` key off a parsed manifest must be on an
// allowlist, by its exact (trimmed) text and rule, with a reason. The allowlist only shrinks:
//   - a hit that no entry covers fails (a new direct read, or an edited line: re-justify it);
//   - an entry that no hit uses fails (stale: delete it, so the list shrinks);
//   - an entry without a real reason fails;
//   - compared with the committed allowlist at the merge base with master, no entry may be added.
// Comment lines are skipped (they cannot read a file); test files, tests/ and fixtures/ directories are exempt
// (new tests use tests/spec-fixture.mjs).
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export const SOURCE = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
export const EXEMPT = [/\.test\.[^/]+$/, /(^|\/)tests?\//, /(^|\/)fixtures?\//, /(^|\/)node_modules\//, /\.d\.(?:m|c)?ts$/];
/** The one module allowed to read records from manifest.json. */
export const LAYOUT_MODULE = "pi-config/extensions/spec/core/layout.mjs";

// Rule forms (each is proved on fixtures in tests/layout-guard.test.mjs):
//   names-manifest: the records file's name, or a MANIFEST constant standing for it.
//   reads-claims:   `.claims` off something named like a parsed manifest (m, mf, man, manifest, *Manifest, *manifest),
//                   `["claims"]` in any quotes, or `{ claims } = JSON.parse(...)` / `.claims` straight off JSON.parse(...).
export const RULES = {
  "names-manifest": [/manifest\.json/, /\bMANIFEST\b/],
  "reads-claims": [
    /(?:^|[^\w$])(?:m|mf|man|manifest|[A-Za-z_$][\w$]*[Mm]anifest)\s*(?:\?\.|\.|!\.)\s*claims(?![\w$])/,
    /\[\s*(["'`])claims\1\s*\]/,
    /\{[^}]*\bclaims\b[^}]*\}\s*=\s*JSON\.parse\b/,
    /JSON\.parse\([^;]*\)\s*(?:\?\.|\.)\s*claims(?![\w$])/,
  ],
};

const isComment = (line) => /^\s*(?:\/\/|\/\*|\*|#)/.test(line);

/** Hits in one file's text: [{ line, rule, text }], one per (line, rule). */
export function scanText(text) {
  const hits = [];
  text.split("\n").forEach((raw, i) => {
    if (isComment(raw)) return;
    for (const [rule, forms] of Object.entries(RULES)) if (forms.some((re) => re.test(raw))) hits.push({ line: i + 1, rule, text: raw.trim() });
  });
  return hits;
}

export const isScanned = (rel) => SOURCE.test(rel) && !EXEMPT.some((re) => re.test(rel)) && rel !== LAYOUT_MODULE && rel !== LAYOUT_MODULE.replace(/\.mjs$/, ".d.mts");

/** Tracked files under the given repo-relative roots (git ls-files), filtered to scanned source. */
export function listSources(repo, roots) {
  const r = spawnSync("git", ["-C", repo, "ls-files", "-z", "--", ...roots], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
  return r.stdout.split("\0").filter(Boolean).filter(isScanned).sort();
}

/** Glob (`*` within a segment, `**` across) → RegExp over a repo-relative path. */
export const globRe = (g) => new RegExp(`^${g.split("**").map((p) => p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*")}$`);

/**
 * Compare hits with an allowlist. allow = { paths: [{ glob, reason }], lines: { file: [{ rule, text, reason }] } }.
 * scans = Map<file, hits>. → { problems: string[], used: number, unlisted: [{file, line, rule, text}] }
 */
export function compare(scans, allow) {
  const problems = [], unlisted = [];
  const bad = (reason) => typeof reason !== "string" || reason.trim().length < 12 || /\b(todo|tbd|fixme|xxx)\b/i.test(reason);
  for (const p of allow.paths ?? []) if (bad(p.reason)) problems.push(`allowlist path ${p.glob}: needs a real reason`);
  const usedPaths = new Set();
  let used = 0;
  const lines = allow.lines ?? {};
  for (const [f, entries] of Object.entries(lines)) for (const e of entries) if (bad(e.reason)) problems.push(`allowlist ${f} "${e.text}" (${e.rule}): needs a real reason`);
  for (const [f, hits] of scans) {
    if (!hits.length) continue;
    const p = (allow.paths ?? []).find((x) => globRe(x.glob).test(f));
    if (p) { usedPaths.add(p.glob); continue; }
    const pool = (lines[f] ?? []).map((e) => ({ ...e, left: true }));
    for (const h of hits) {
      const e = pool.find((x) => x.left && x.rule === h.rule && x.text === h.text);
      if (e) { e.left = false; used++; continue; }
      unlisted.push({ file: f, ...h });
      problems.push(`${f}:${h.line} (${h.rule}) reads the spec's records file directly: go through ${LAYOUT_MODULE} (or \`sova-spec.mjs records --json\`); \`${h.text.slice(0, 160)}\``);
    }
    for (const e of pool) if (e.left) problems.push(`allowlist ${f} "${e.text.slice(0, 120)}" (${e.rule}): no such line any more; delete the entry (the list only shrinks)`);
  }
  for (const f of Object.keys(lines)) if (!scans.has(f) || !scans.get(f).length) for (const e of lines[f]) problems.push(`allowlist ${f} "${e.text.slice(0, 120)}" (${e.rule}): ${scans.has(f) ? "no such line any more" : "file not scanned or gone"}; delete the entry (the list only shrinks)`);
  for (const p of allow.paths ?? []) if (!usedPaths.has(p.glob) && ![...scans.keys()].some((f) => globRe(p.glob).test(f) && scans.get(f).length)) problems.push(`allowlist path ${p.glob}: matches no file with a hit; delete it (the list only shrinks)`);
  return { problems, used, unlisted };
}

export function scanRepo(repo, files) {
  const scans = new Map();
  for (const f of files) scans.set(f, scanText(readFileSync(join(repo, f), "utf8")));
  return scans;
}

/** Entries of `after` that `before` lacks (by file, rule, text multiset; paths by glob). */
export function growth(before, after) {
  const out = [];
  const beforePaths = new Set((before.paths ?? []).map((p) => p.glob));
  for (const p of after.paths ?? []) if (!beforePaths.has(p.glob)) out.push(`path ${p.glob} added`);
  for (const [f, entries] of Object.entries(after.lines ?? {})) {
    const pool = [...(before.lines?.[f] ?? [])];
    for (const e of entries) {
      const i = pool.findIndex((x) => x.rule === e.rule && x.text === e.text);
      if (i >= 0) pool.splice(i, 1); else out.push(`${f} "${e.text.slice(0, 120)}" (${e.rule}) added`);
    }
  }
  return out;
}

/**
 * The allowlist as committed at the merge base of HEAD and master (or main), or null when that commit has none
 * (the branch that adds or first fills the list has nothing to grow past). HEAD is used only when there is no
 * master/main at all; never as a fallback, or a branch's own first commit would freeze its unfinished list.
 */
export function committedAllowlist(repo, rel) {
  const run = (...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  let at = null;
  for (const m of ["master", "main"]) { const r = run("merge-base", "HEAD", m); if (r.status === 0) { at = r.stdout.trim(); break; } }
  if (!at) at = "HEAD";
  const r = run("show", `${at}:${rel}`);
  if (r.status !== 0) return null;
  try { return { at, allow: JSON.parse(r.stdout) }; } catch { return null; }
}

/** A draft allowlist from the current hits (reasons empty: fill each in, or switch the reader). */
export function draftAllowlist(scans, keep = { paths: [] }) {
  const lines = {};
  for (const [f, hits] of scans) {
    if (!hits.length || (keep.paths ?? []).some((p) => globRe(p.glob).test(f))) continue;
    lines[f] = hits.map((h) => ({ rule: h.rule, text: h.text, reason: keep.lines?.[f]?.find((e) => e.rule === h.rule && e.text === h.text)?.reason ?? "" }));
  }
  return { ...keep, lines };
}

export const loadAllowlist = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { paths: [], lines: {} });
