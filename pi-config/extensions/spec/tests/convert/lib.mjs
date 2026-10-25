// Helpers for the cutover tests (convert-*.test.mjs): al_6 landing 2 converts Sova's REAL spec to format 2 in one
// commit. These read the real repository's history, never a fixture: the cutover commit is found in HEAD's
// first-parent history as the commit whose .sova/spec/manifest.json is format 2 while its first parent's is format 1.
// SOVA_CONVERT_AT=<rev> points the tests at another candidate cutover commit (a regenerated one, say);
// SOVA_CONVERT_HEAD=<rev> searches another history (SOVA_CONVERT_HEAD=ca8ab14 shows the tests failing before it).
// Records are read here straight from Git objects (ls-tree + cat-file), independently of core/layout.mjs, so a
// reader bug and a conversion bug cannot cancel out.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { REPO, SPEC, tmp, hasGit } from "../layout/lib.mjs";

export { REPO, SPEC };
/** master when landing 2 was cut: the last commit with Sova's spec in format 1 (landing 1 on it). */
export const PRE_CUTOVER = "ca8ab14e5f71cb1b299cd1e56c39848335f20620";
/** feat/spec-store's base on master: the spec tools before al_6 (no layout.mjs, the old merge helper). */
export const PRE_AL6 = "9b7297f8b805149e1042068f60b9297097d67961";
export const TOOLS = "pi-config/extensions/spec/core";

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
 * The cutover commit in HEAD's first-parent history: { cutover, base } where base is its first parent, or null.
 * The oldest such commit wins (a rollback and a second cutover would make a later one; the first is the landing).
 */
export function findCutover(head = process.env.SOVA_CONVERT_HEAD || "HEAD") {
  if (process.env.SOVA_CONVERT_AT) { const c = revParse(process.env.SOVA_CONVERT_AT); return { cutover: c, base: revParse(`${c}^1`) }; }
  const revs = rgit("log", "--first-parent", "--format=%H", head, "--", `${SPEC}/manifest.json`).split("\n").filter(Boolean).reverse();
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

/** Skip reasons, so a skipped test says why (and a missing cutover is a failure, not a skip: see requireCutover). */
export const noGit = !hasGit ? "no git" : !hasRev(PRE_CUTOVER) ? `pre-cutover commit ${PRE_CUTOVER.slice(0, 12)} not in this clone` : false;

/** The cutover, asserted present: until landing 2's commit is on HEAD's history, every cutover test fails here. */
export function requireCutover() {
  const c = findCutover();
  assert.ok(c, `no cutover commit on ${process.env.SOVA_CONVERT_HEAD || "HEAD"}'s first-parent history (a commit whose ${SPEC}/manifest.json is formatVersion 2 while its first parent's is 1); its spec is format ${formatAt(process.env.SOVA_CONVERT_HEAD || "HEAD")}`);
  return c;
}
