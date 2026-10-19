// Whole-tree `census` in a Git work tree leaves out what Git ignores (dependencies, build output), and nothing else:
// a tracked file stays counted even when an ignore pattern matches it, an untracked file Git does not ignore stays
// counted, and outside Git (or under an enclosing repository that ignores the whole project) every file is counted.
// Node stdlib and the git CLI only; every fixture is a temp directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(HERE, "../core/sova-spec.mjs");
const fixtureEnv = (root) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home") });

const roots = [];
process.on("exit", () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function write(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}
function ok(root, ...a) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=master", "-C", root, ...a], { encoding: "utf8", env: fixtureEnv(root) });
  assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
function census(root, home = root) {
  const r = spawnSync(process.execPath, [CORE, "census", "--root", root, "--json"], { encoding: "utf8", cwd: root, env: fixtureEnv(home) });
  let j;
  try { j = JSON.parse(r.stdout); } catch { assert.fail(`non-JSON stdout (status ${r.status}): ${r.stdout}\n${r.stderr}`); }
  assert.equal(r.status, j.exit, "process status equals JSON exit");
  return j;
}

const manifest = (code = ["src/list.ts"]) => JSON.stringify({
  formatVersion: 1,
  boundary: { include: ["src", "site"], exclude: [] },
  claims: { "§app/list": { kind: "surface", authority: "accepted", requires: [], code } },
}, null, 2) + "\n";

// The tree: a claimed file, a tracked unclaimed file, a tracked file an ignore pattern matches (force-added), an
// untracked file nothing ignores, and ignored dependency/build/cache trees, one of them ignored by a nested .gitignore.
function tree(root) {
  write(root, ".sova/spec/manifest.json", manifest());
  write(root, ".sova/spec/claims/app/list.md", "# §app/list\n\nThe session list.\n");
  write(root, ".gitignore", "node_modules/\ndist/\n*.log\n");
  write(root, "site/.gitignore", ".astro/\n");
  write(root, "src/list.ts", "v1\n");
  write(root, "src/rows.ts", "v1\n");
  write(root, "src/kept.log", "tracked although *.log matches\n");
  write(root, "site/page.astro", "page\n");
  write(root, "site/node_modules/pkg/index.js", "dep\n");
  write(root, "site/node_modules/pkg/package.json", "{}\n");
  write(root, "site/dist/index.html", "built\n");
  write(root, "site/dist/kept.html", "tracked inside an ignored directory\n");
  write(root, "site/.astro/types.d.ts", "cache\n");
  write(root, "src/debug.log", "ignored\n");
}
const TRACKED_GAPS = ["site/.gitignore", "site/dist/kept.html", "site/page.astro", "src/kept.log", "src/rows.ts"];
const IGNORED = ["site/.astro/types.d.ts", "site/dist/index.html", "site/node_modules/pkg/index.js", "site/node_modules/pkg/package.json", "src/debug.log"];

function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), "sova-census-ignored-"));
  roots.push(root);
  tree(root);
  ok(root, "init", "-q");
  ok(root, "add", ".gitignore", "site/.gitignore", "src/list.ts", "src/rows.ts", "site/page.astro", ".sova");
  ok(root, "add", "-f", "src/kept.log", "site/dist/kept.html");
  ok(root, "commit", "-qm", "base");
  write(root, "src/new.ts", "untracked, not ignored\n");
  return root;
}

test("in a Git work tree, ignored files are not counted; tracked and untracked-unignored gaps all are", () => {
  const root = gitRepo();
  const j = census(root);
  const c = j.census;
  assert.deepEqual(c.unclaimed, [...TRACKED_GAPS, "src/new.ts"].sort());
  assert.deepEqual(c.claimed, ["src/list.ts"]);
  assert.equal(c.files, TRACKED_GAPS.length + 2);
  assert.equal(c.ignored, IGNORED.length, "the count of files left out is reported");
  for (const f of IGNORED) assert.ok(!c.unclaimed.includes(f), `${f} is ignored`);
  assert.ok(j.findings.some((f) => f.code === "census-ignored"), "a note says ignored files were left out");
});

test("a claim that maps an ignored file still finds it claimed", () => {
  const root = gitRepo();
  write(root, ".sova/spec/manifest.json", manifest(["src/list.ts", "site/dist/index.html"]));
  const c = census(root).census;
  assert.ok(c.claimed.includes("site/dist/index.html"));
  assert.ok(!c.outside.includes("site/dist/index.html"));
});

test("outside Git every file in the boundary is counted (no ignore rules apply)", () => {
  const root = mkdtempSync(join(tmpdir(), "sova-census-plain-"));
  roots.push(root);
  tree(root);
  const c = census(root).census;
  assert.deepEqual(c.unclaimed, [...TRACKED_GAPS, ...IGNORED].sort());
  assert.equal(c.ignored, 0);
});

test("a project an enclosing repository ignores is counted in full, not emptied", () => {
  const outer = mkdtempSync(join(tmpdir(), "sova-census-outer-"));
  roots.push(outer);
  write(outer, ".gitignore", "proj/\n");
  ok(outer, "init", "-q");
  ok(outer, "add", ".gitignore");
  ok(outer, "commit", "-qm", "outer");
  const root = join(outer, "proj");
  tree(root);
  const c = census(root, outer).census;
  assert.deepEqual(c.unclaimed, [...TRACKED_GAPS, ...IGNORED].sort());
  assert.equal(c.ignored, 0);
});

test("a project root below the repository root applies the ignore rules relative to itself", () => {
  const outer = mkdtempSync(join(tmpdir(), "sova-census-sub-"));
  roots.push(outer);
  const root = join(outer, "pkg");
  tree(root);
  ok(outer, "init", "-q");
  ok(outer, "add", "pkg/.gitignore", "pkg/site/.gitignore", "pkg/src/list.ts", "pkg/src/rows.ts", "pkg/site/page.astro", "pkg/.sova");
  ok(outer, "add", "-f", "pkg/src/kept.log", "pkg/site/dist/kept.html");
  ok(outer, "commit", "-qm", "base");
  const c = census(root, outer).census;
  assert.deepEqual(c.unclaimed, TRACKED_GAPS);
  assert.equal(c.ignored, IGNORED.length);
});
