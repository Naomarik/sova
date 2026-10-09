// Black-box checks for `census --changed --base` over a range in which the task promoted its own claim, and for a
// boundary that names a site/ directory. Node stdlib and the git CLI only; every fixture is a temp Git repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(HERE, "../core/sova-spec.mjs");
const DRAFT = resolve(HERE, "../core/sova-spec-draft.mjs");
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
function cli(tool, root, ...args) {
  const r = spawnSync(process.execPath, [tool, ...args, "--root", root, "--json"], { encoding: "utf8", cwd: root, env: fixtureEnv(root) });
  let j;
  try { j = JSON.parse(r.stdout); } catch { assert.fail(`non-JSON stdout (status ${r.status}): ${r.stdout}\n${r.stderr}`); }
  assert.equal(r.status, j.exit, "process status equals JSON exit");
  return j;
}
const core = (root, ...a) => cli(CORE, root, ...a);
const draft = (root, ...a) => cli(DRAFT, root, ...a);
const summaryIds = (j) => j.findings.find((f) => f.code === "foreign-summary")?.ids ?? [];
const editManifest = (root, rel, fn) => { const m = JSON.parse(readFileSync(join(root, rel), "utf8")); fn(m.claims, m); write(root, rel, JSON.stringify(m, null, 2) + "\n"); };

const CLAIMS = {
  "§app/list": { kind: "surface", authority: "accepted" },
  "§app.list/mark": { kind: "behavior", authority: "accepted", requires: [], code: ["src/list.ts"] },
  "§app.list/rows": { kind: "behavior", authority: "accepted", requires: [], code: ["src/list.ts"] },
};
const LIST = "# §app/list\n\nThe session list.\n\n## §app.list/mark\n\nA session that needs you shows a speech bubble.\n\n## §app.list/rows\n\nRows sort by recency.\n";
const M = (claims, boundary = { include: ["src"], exclude: [] }) => JSON.stringify({ formatVersion: 1, boundary, claims }, null, 2) + "\n";

function repo(claims = CLAIMS, boundary) {
  const root = mkdtempSync(join(tmpdir(), "sova-census-base-"));
  roots.push(root);
  write(root, ".sova/spec/manifest.json", M(claims, boundary));
  write(root, ".sova/spec/claims/app/list.md", LIST);
  write(root, ".gitignore", ".sova/spec/drafts/\n");
  write(root, "src/list.ts", "v1\n");
  ok(root, "init", "-q"); ok(root, "add", "-A"); ok(root, "commit", "-qm", "base");
  return root;
}

// The task's whole flow from `first`: a draft adds the H2 §app.list/filter (code src/filter.ts), the code is committed
// (src/list.ts too, so the pre-existing §app.list/mark and §app.list/rows are really touched), evidence names that
// commit, the claim is promoted and the claims committed. → { root, first }
function promotedRange() {
  const root = repo();
  const first = ok(root, "rev-parse", "HEAD");
  assert.equal(draft(root, "new", "feat", "--write").exit, 0);
  write(root, ".sova/spec/drafts/feat/spec/claims/app/list.md", LIST + "\n## §app.list/filter\n\nA filter narrows the rows.\n");
  editManifest(root, ".sova/spec/drafts/feat/spec/manifest.json", (c) => { c["§app.list/filter"] = { kind: "behavior", authority: "accepted", requires: [], code: ["src/filter.ts"] }; });
  write(root, "src/filter.ts", "v1\n"); write(root, "src/list.ts", "v2\n");
  ok(root, "add", "src"); ok(root, "commit", "-qm", "feat: filter");
  const impl = ok(root, "rev-parse", "HEAD");
  assert.equal(draft(root, "evidence", "feat", "--id", "§app.list/filter", "--by", "t", "--verification", "ran it", "--commit", impl, "--write").exit, 0);
  const p = draft(root, "promote", "feat", "--id", "§app.list/filter");
  assert.equal(p.exit, 0, JSON.stringify(p.refusals));
  assert.equal(draft(root, "promote", "feat", "--id", "§app.list/filter", "--plan", p.plan, "--write").exit, 0);
  ok(root, "add", ".sova/spec"); ok(root, "commit", "-qm", "spec: filter");
  return { root, first };
}

test("census --changed --base: a § created in the range is the task's own, never foreign (agrees with foreign --base)", () => {
  const { root, first } = promotedRange();
  const f = core(root, "foreign", "--base", first, "--head", "HEAD");
  assert.deepEqual(f.created, ["§app.list/filter"], "foreign --base: created in the range");
  const j = core(root, "census", "--changed", "--base", first);
  assert.deepEqual(j.census.claimed.find((e) => e.path === "src/filter.ts")?.claims, ["§app.list/filter"], "the new claim is touched");
  const ownListedForeign = j.census.foreign.filter((id) => f.created.includes(id));
  assert.deepEqual(ownListedForeign, [], "own new claims listed as foreign");
  assert.ok(!summaryIds(j).includes("§app.list/filter"), "the foreign-summary note leaves it out too");
});

test("census --changed --base guard: a really foreign touched § is still listed", () => {
  const { root, first } = promotedRange();
  const j = core(root, "census", "--changed", "--base", first);
  for (const id of ["§app.list/mark", "§app.list/rows"]) {
    assert.ok(j.census.foreign.includes(id), `${id} (pre-existing, its file changed) stays foreign`);
    assert.ok(summaryIds(j).includes(id), `${id} stays in the foreign-summary note`);
  }
});

test("census --changed --base guard: a § that existed at the base but was created again later is still foreign", () => {
  // Deleted then re-created in the range: it existed at the base, so the task didn't create it.
  const root = repo();
  const first = ok(root, "rev-parse", "HEAD");
  editManifest(root, ".sova/spec/manifest.json", (c) => { delete c["§app.list/rows"]; });
  write(root, ".sova/spec/claims/app/list.md", LIST.replace("\n## §app.list/rows\n\nRows sort by recency.\n", ""));
  ok(root, "add", "-A"); ok(root, "commit", "-qm", "drop rows");
  editManifest(root, ".sova/spec/manifest.json", (c) => { c["§app.list/rows"] = CLAIMS["§app.list/rows"]; });
  write(root, ".sova/spec/claims/app/list.md", LIST);
  write(root, "src/list.ts", "v2\n");
  ok(root, "add", "-A"); ok(root, "commit", "-qm", "rows back");
  const j = core(root, "census", "--changed", "--base", first);
  assert.ok(j.census.foreign.includes("§app.list/rows"), JSON.stringify(j.census.foreign));
  assert.ok(j.census.foreign.includes("§app.list/mark"));
});

// ---------------------------------------------------------------- a boundary that names site/
// The boundary is project data: a project whose site/ is data lists it in include, and census judges its files.
function siteRepo(include) {
  const root = repo({ ...CLAIMS, "§site/landing": { kind: "behavior", authority: "accepted", requires: [], code: ["site/src/pages/index.astro"] } }, { include, exclude: [] });
  write(root, ".sova/spec/claims/site/landing.md", "# §site/landing\n\nThe landing page.\n");
  write(root, "site/src/pages/index.astro", "v1\n"); write(root, "site/astro.config.mjs", "v1\n"); write(root, "tools/x.mjs", "v1\n");
  ok(root, "add", "-A"); ok(root, "commit", "-qm", "site");
  write(root, "site/src/pages/index.astro", "v2\n"); write(root, "site/astro.config.mjs", "v2\n"); write(root, "tools/x.mjs", "v2\n");
  return root;
}
const siteOutside = (j) => j.census.outside.filter((p) => p.startsWith("site/"));

test("census --changed: with site out of the boundary, site changes are outside (the tool judges nothing there)", () => {
  const j = core(siteRepo(["src"]), "census", "--changed");
  assert.deepEqual(siteOutside(j), ["site/astro.config.mjs", "site/src/pages/index.astro"]);
});

test("census --changed: with site in the boundary, site changes are judged: mapped → its §, unmapped → unclaimed; other outside files stay outside", () => {
  const j = core(siteRepo(["src", "site"]), "census", "--changed");
  assert.deepEqual(siteOutside(j), []);
  assert.deepEqual(j.census.claimed, [{ path: "site/src/pages/index.astro", claims: ["§site/landing"] }]);
  assert.deepEqual(j.census.unclaimed, ["site/astro.config.mjs"]);
  assert.deepEqual(j.census.outside, ["tools/x.mjs"], "guard: a file outside every include stays outside");
});
