// Helpers for the cutover tests (convert-*.test.mjs): al_6 landing 2 converts Sova's REAL spec to format 2 in one
// commit. These read the real repository's history, never a fixture, and pin no commit id (history may be rewritten
// and the conversion regenerated). Found in history:
//   - the cutover: the NEWEST non-merge commit whose .sova/spec/manifest.json is format 2 while its parent's is 1
//     (the conversion in force; an earlier one that a later merge took back to format 1 is superseded);
//   - the pre-landing master: the master (or main) commit the branch last merged before the cutover, format 1;
//   - the pre-al_6 tools: the parent of the commit that added core/layout.mjs.
// SOVA_CONVERT_AT=<rev>, SOVA_CONVERT_BASE=<rev> and SOVA_PRE_AL6=<rev> override each; SOVA_CONVERT_HEAD=<rev> searches
// another history (SOVA_CONVERT_HEAD=master, before landing 2, shows the tests failing). A commit the tests need and
// cannot find fails them; nothing skips but a missing git.
// Records are read here straight from Git objects (ls-tree + cat-file), independently of core/layout.mjs, so a
// reader bug and a conversion bug cannot cancel out.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { REPO, SPEC, tmp, hasGit } from "../layout/lib.mjs";

export { REPO, SPEC };
export const TOOLS = "pi-config/extensions/spec/core";
/**
 * The one pinned commit, by the main thread's decision: the master commit landing 2 merged before its conversion
 * (format 1). The flip's parent must contain it, so an older flip cut before that merge can never pass for the
 * conversion that lands. SOVA_CONVERT_MASTER=<rev> repins it after a history rewrite or a regenerated flip.
 */
export const MERGED_MASTER = process.env.SOVA_CONVERT_MASTER || "6f712fb84dbbc0673541998e4d8a24330ce08704";

const gitRaw = (args, opts = {}) => spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, ...opts });
export function rgit(...args) {
  const r = gitRaw(args);
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
export const hasRev = (rev) => hasGit && gitRaw(["cat-file", "-e", `${rev}^{commit}`]).status === 0;
export const revParse = (rev) => rgit("rev-parse", rev).trim();

/** A file's text at a commit, or null when it is absent. */
export function showAt(rev, rel) {
  const r = gitRaw(["show", `${rev}:${rel}`]);
  return r.status === 0 ? r.stdout : null;
}
export function formatAt(rev) {
  const t = showAt(rev, `${SPEC}/manifest.json`);
  if (t === null) return null;
  try { return JSON.parse(t).formatVersion ?? null; } catch { return "unreadable"; }
}

/**
 * The cutover commit in HEAD's history: { cutover, base } where base is its parent, or null. Only non-merge commits
 * count: the merge that lands the branch on master, and a pre-cutover branch's merge of the converted master, also
 * flip the format from their first parent, but they are not the cutover. The newest in topological order wins: when
 * a merge took the spec back to format 1 and it was converted again, the later conversion is the one that lands.
 */
export function findCutover(head = process.env.SOVA_CONVERT_HEAD || "HEAD") {
  if (process.env.SOVA_CONVERT_AT) { const c = revParse(process.env.SOVA_CONVERT_AT); return { cutover: c, base: revParse(`${c}^1`) }; }
  const revs = rgit("log", "--no-merges", "--topo-order", "--format=%H", head, "--", `${SPEC}/manifest.json`).split("\n").filter(Boolean);
  for (const c of revs) {
    if (formatAt(c) !== 2) continue;
    const p = gitRaw(["rev-parse", `${c}^1`]);
    if (p.status !== 0) continue;
    const base = p.stdout.trim();
    if (formatAt(base) === 1) return { cutover: c, base };
  }
  return null;
}

/** { path: blobSha } of every file under `prefix` at `rev` (repo-relative paths). */
export function lsTree(rev, prefix = SPEC) {
  const out = {};
  for (const line of rgit("ls-tree", "-r", "-z", rev, "--", prefix).split("\0").filter(Boolean)) {
    const [meta, path] = line.split("\t");
    out[path] = meta.split(" ")[2];
  }
  return out;
}
/** The bytes of many blobs in one cat-file --batch run: Map<sha, Buffer>. */
export function blobs(shas) {
  const uniq = [...new Set(shas)];
  const r = spawnSync("git", ["-C", REPO, "cat-file", "--batch"], { input: uniq.join("\n") + "\n", maxBuffer: 1024 * 1024 * 1024 });
  assert.equal(r.status, 0, String(r.stderr));
  const buf = r.stdout, out = new Map();
  let i = 0;
  for (const sha of uniq) {
    const nl = buf.indexOf(10, i);
    const [got, , size] = buf.subarray(i, nl).toString().split(" ");
    assert.equal(got, sha, "cat-file answers in order");
    const n = Number(size);
    out.set(sha, buf.subarray(nl + 1, nl + 1 + n));
    i = nl + 1 + n + 1;
  }
  return out;
}

/**
 * Every record of the spec at `rev`, read from Git objects in either layout, with the file each id came from.
 * Throws (via assert) on an id in two places: a mixed or duplicated layout must not read as a valid one.
 */
export function recordsAt(rev) {
  const tree = lsTree(rev);
  const b = blobs(Object.values(tree));
  const text = (rel) => b.get(tree[rel]).toString("utf8");
  const manifest = JSON.parse(text(`${SPEC}/manifest.json`));
  const croot = `${SPEC}/${String(manifest.grammar?.claimsRoot ?? "claims/").replace(/\/+$/, "")}/`;
  const records = {}, fileOf = {}, raw = {};
  if (manifest.claims && typeof manifest.claims === "object") for (const [id, r] of Object.entries(manifest.claims)) { records[id] = r; fileOf[id] = "manifest.json"; }
  const recordFiles = Object.keys(tree).filter((p) => p.startsWith(croot) && p.endsWith(".json")).sort();
  for (const p of recordFiles) {
    raw[p] = text(p);
    for (const [id, r] of Object.entries(JSON.parse(raw[p]))) {
      assert.ok(!(id in records), `${rev.slice(0, 12)}: ${id} in ${fileOf[id]} and ${p}`);
      records[id] = r; fileOf[id] = p.slice(SPEC.length + 1);
    }
  }
  const { claims, ...meta } = manifest;
  const md = Object.fromEntries(Object.keys(tree).filter((p) => p.startsWith(croot) && p.endsWith(".md")).map((p) => [p, tree[p]]));
  return { manifest, meta, claimsKey: claims, records, fileOf, recordFiles, raw, tree, md, manifestText: text(`${SPEC}/manifest.json`) };
}

/** Canonical JSON: object keys sorted by code point at every depth (arrays keep their order). */
export function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** Extract `paths` (default: the whole tree) at `rev` into dir (made if missing). */
export function archiveInto(rev, dir, paths = []) {
  mkdirSync(dir, { recursive: true });
  const a = spawnSync("git", ["-C", REPO, "archive", rev, ...(paths.length ? ["--", ...paths] : [])], { maxBuffer: 1024 * 1024 * 1024 });
  assert.equal(a.status, 0, `archive ${rev} ${paths.join(" ")}: ${a.stderr}`);
  const t = spawnSync("tar", ["-x", "-C", dir], { input: a.stdout, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(t.status, 0, `untar ${rev}: ${t.stderr}`);
  return dir;
}

/** A scratch directory under the system temp dir, removed at exit. */
export const scratch = (name) => tmp(`spec-convert-${name}-`);
export const exists = (root, rel) => existsSync(join(root, rel));

/** The one skip reason: no git at all. A commit the tests need and cannot find is a failure (see the finders). */
export const noGit = !hasGit ? "no git" : false;

const tryRev = (rev) => { const r = gitRaw(["rev-parse", "--verify", "-q", `${rev}^{commit}`]); return r.status === 0 ? r.stdout.trim() : null; };
export const isAncestor = (a, b) => gitRaw(["merge-base", "--is-ancestor", a, b]).status === 0;
const memo = new Map();
const once = (key, f) => { if (!memo.has(key)) memo.set(key, f()); return memo.get(key); };

/**
 * The master (or main) commit the branch last merged before the cutover: the tools and spec every chat had before
 * landing 2, format 1. Before landing that is the merge base of the cutover with master; after landing, master's
 * first-parent history holds the landing merge L (the cutover in L, not in L^1), and it is the merge base with L^1.
 */
export function preLandingMaster(cutover) {
  return once(`pre:${cutover}`, () => {
    if (process.env.SOVA_CONVERT_BASE) return revParse(process.env.SOVA_CONVERT_BASE);
    for (const m of ["master", "main", "origin/master", "origin/main"]) {
      const tip = tryRev(m);
      if (!tip) continue;
      let at = tip;
      if (isAncestor(cutover, tip)) {
        const landing = rgit("log", "--first-parent", "--merges", "--format=%H %P", tip).split("\n").filter(Boolean)
          .map((l) => l.split(" ")).find(([x, p1]) => isAncestor(cutover, x) && !isAncestor(cutover, p1));
        if (!landing) continue;
        at = landing[1];
      }
      const mb = gitRaw(["merge-base", cutover, at]);
      if (mb.status === 0 && formatAt(mb.stdout.trim()) === 1) return mb.stdout.trim();
    }
    return null;
  });
}
/** The cutover and the pre-landing master, asserted found. */
export function requireBases() {
  const c = requireCutover();
  const pre = preLandingMaster(c.cutover);
  assert.ok(pre, `no format 1 master commit before the cutover ${c.cutover.slice(0, 12)} (no master/main, or the branch never merged one); set SOVA_CONVERT_BASE`);
  return { ...c, pre };
}
/** The spec tools from before al_6: the parent of the commit that added core/layout.mjs (no layout.mjs, the old helper). */
export function preAl6(cutover) {
  return once(`al6:${cutover}`, () => {
    if (process.env.SOVA_PRE_AL6) return revParse(process.env.SOVA_PRE_AL6);
    const added = rgit("log", "--diff-filter=A", "--topo-order", "--format=%H", cutover, "--", `${TOOLS}/layout.mjs`).split("\n").filter(Boolean).pop();
    assert.ok(added, `no commit adds ${TOOLS}/layout.mjs before ${cutover.slice(0, 12)}; set SOVA_PRE_AL6`);
    const p = revParse(`${added}^1`);
    assert.equal(showAt(p, `${TOOLS}/layout.mjs`), null, `${p.slice(0, 12)} has no layout.mjs`);
    return p;
  });
}

/** The cutover, asserted present: until landing 2's commit is on HEAD's history, every cutover test fails here. */
export function requireCutover() {
  const c = findCutover();
  assert.ok(c, `no cutover commit in ${process.env.SOVA_CONVERT_HEAD || "HEAD"}'s history (a commit whose ${SPEC}/manifest.json is formatVersion 2 while its first parent's is 1); its spec is format ${formatAt(process.env.SOVA_CONVERT_HEAD || "HEAD")}`);
  return c;
}
