// Black-box tests for `sova-spec-draft.mjs refresh` (al_4): a draft moved onto the current spec. Its base/ becomes
// current; its spec/ is the per-declaration three-way merge promote computes; a declaration changed on both sides is
// written into the draft's spec/ with both texts in one marked block for the chat to rewrite. Both record layouts.
// Node stdlib only; Git fixtures use the git CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { areaPathOf, writeSpec } from "./spec-fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "../core/sova-spec-draft.mjs");
const fixtureEnv = (root) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_") && !k.startsWith("SPEC_AGREE"))), HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home") });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const roots = [];
process.on("exit", () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const put = (root, rel, text) => { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
const read = (root, rel) => readFileSync(join(root, rel), "utf8");
function git(root, ...a) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-C", root, ...a], { encoding: "utf8", env: fixtureEnv(root) });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function run(root, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--root", root, "--json"], { encoding: "utf8", cwd: root, env: fixtureEnv(root) });
  let j;
  try { j = JSON.parse(r.stdout); } catch { assert.fail(`non-JSON stdout (status ${r.status}): ${r.stdout}\n${r.stderr}`); }
  assert.equal(r.status, j.exit, "process status equals JSON exit");
  return j;
}
/** Files under `dir` (relative path → sha256), skipping `skip` path prefixes. */
function files(dir, skip = []) {
  const out = {};
  const walk = (d, rel) => { for (const e of readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (skip.some((s) => r === s || r.startsWith(`${s}/`))) continue; e.isDirectory() ? walk(join(d, e.name), r) : (out[r] = sha(readFileSync(join(d, e.name)))); } };
  if (existsSync(dir)) walk(dir, "");
  return out;
}
const official = (root) => files(join(root, ".sova/spec"), ["drafts", ".gitignore"]);

const BASE = { "§a/top": { kind: "behavior", authority: "accepted", requires: [], code: ["lib/top.txt"] } };
const TOP = "# §a/top\n\nThe top does X.\n";
function project(layout) {
  const root = mkdtempSync(join(tmpdir(), "sova-refresh-test-"));
  roots.push(root);
  writeSpec(root, { layout, records: BASE, claims: { "a/top.md": TOP } });
  put(root, ".sova/spec/.gitignore", "/drafts/\n");
  put(root, "lib/top.txt", "top v1\n");
  put(root, "lib/new.txt", "new v1\n");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}
const D = (name, rel = "") => `.sova/spec/drafts/${name}/spec${rel ? `/${rel}` : ""}`;
const B = (name) => `.sova/spec/drafts/${name}/base`;
function addRecord(root, name, layout, id, rec, prose) {
  const spec = join(root, D(name));
  if (layout === 1) {
    const m = JSON.parse(readFileSync(join(spec, "manifest.json"), "utf8"));
    m.claims[id] = rec;
    writeFileSync(join(spec, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
  } else put(spec, `claims/${areaPathOf(id)}.json`, JSON.stringify({ [id]: rec }, null, 2) + "\n");
  put(spec, `claims/${areaPathOf(id)}.md`, prose);
}
const note = (root, name, id) => assert.equal(run(root, "evidence", name, "--id", id, "--by", "chat", "--verification", "checked", "--note", "--write").exit, 0);
const land = (root, ...more) => run(root, "land", "--commit", "HEAD", "--by", "land-it", "--verification", "refresh test", ...more);
const changedIds = (root, name) => run(root, "status", name).ids.map((i) => i.id).sort();
/** Master's docs move §a/top on: a commit on the current spec, as another branch's landing would make. */
const masterMoves = (root, text) => { put(root, ".sova/spec/claims/a/top.md", `# §a/top\n\n${text}\n`); git(root, "commit", "-q", "-am", "another landing: §a/top"); };

for (const layout of [1, 2]) {
  const L = `layout ${layout}:`;

  test(`${L} refresh with no overlap: base/ becomes current byte for byte, the draft keeps only its own change, its note still holds, and it lands`, () => {
    const root = project(layout);
    assert.equal(run(root, "new", "feat", "--write").exit, 0);
    addRecord(root, "feat", layout, "§b/new", { kind: "behavior", authority: "accepted", requires: [], code: ["lib/new.txt"] }, "# §b/new\n\nNew does one thing.\n");
    note(root, "feat", "§b/new");
    masterMoves(root, "The top does X, and Z since another landing.");
    const draftBefore = files(join(root, ".sova/spec/drafts/feat"));

    const pv = run(root, "refresh", "feat");
    assert.equal(pv.exit, 0, JSON.stringify(pv.findings));
    assert.equal(pv.written, false);
    assert.deepEqual(files(join(root, ".sova/spec/drafts/feat")), draftBefore, "the preview writes nothing");

    const w = run(root, "refresh", "feat", "--write");
    assert.equal(w.exit, 0, JSON.stringify(w.findings));
    assert.equal(w.written, true);
    assert.deepEqual(files(join(root, B("feat"))), official(root), "base/ is current, file for file");
    assert.equal(read(root, D("feat", "claims/a/top.md")), read(root, ".sova/spec/claims/a/top.md"), "master's §a/top taken into spec/");
    assert.equal(read(root, D("feat", `claims/${areaPathOf("§b/new")}.md`)), "# §b/new\n\nNew does one thing.\n", "the draft's own change kept");
    assert.deepEqual(changedIds(root, "feat"), ["§b/new"], "the draft changes only its own record now");
    const before = official(root);
    const l = land(root, "--write");
    assert.equal(l.exit, 0, `the note recorded before the refresh still covers §b/new: ${JSON.stringify(l.findings)}`);
    assert.notDeepEqual(official(root), before);
    assert.match(read(root, ".sova/spec/claims/a/top.md"), /Z since another landing/, "master's text survives the landing");
  });

  test(`${L} refresh where master changed the same declaration: both texts in one marked block in spec/, base/ current; land refuses until the chat rewrites it`, () => {
    const root = project(layout);
    assert.equal(run(root, "new", "edit", "--write").exit, 0);
    put(join(root, D("edit")), "claims/a/top.md", "# §a/top\n\nThe top does X, and Y on the branch.\n");
    note(root, "edit", "§a/top");
    masterMoves(root, "The top does X, and Z on master.");
    const officialBefore = official(root);
    assert.equal(land(root).exit, 1, "before the refresh the landing refuses: a clash");
    const draftBefore = files(join(root, ".sova/spec/drafts/edit"));
    assert.equal(run(root, "refresh", "edit").written, false);
    assert.deepEqual(files(join(root, ".sova/spec/drafts/edit")), draftBefore, "the preview writes nothing");

    const w = run(root, "refresh", "edit", "--write");
    assert.equal(w.written, true, JSON.stringify(w));
    assert.equal(w.exit, 1, "a conflict to rewrite is something to act on");
    assert.ok(JSON.stringify(w.conflicts ?? w.findings).includes("§a/top"), `names the declaration: ${JSON.stringify(w)}`);
    assert.deepEqual(official(root), officialBefore, "refresh never writes the current spec");
    assert.deepEqual(files(join(root, B("edit"))), official(root), "base/ is current");
    const block = read(root, D("edit", "claims/a/top.md"));
    assert.ok(block.includes("and Y on the branch") && block.includes("and Z on master"), `both texts:\n${block}`);
    assert.equal(block.split("and Y on the branch").length, 2, "the draft's text once");
    assert.equal(block.split("and Z on master").length, 2, "current's text once");

    // The block itself never lands as prose.
    const held = land(root, "--write");
    assert.equal(held.exit, 1, `a marked block doesn't land: ${JSON.stringify(held)}`);
    assert.ok(held.findings.some((f) => f.draft === "edit" && (f.id === "§a/top" || String(f.message).includes("§a/top"))), JSON.stringify(held.findings));
    assert.deepEqual(official(root), officialBefore);

    // The chat rewrites it into one text and checks it again: no clash any more (base is current), and it lands.
    put(join(root, D("edit")), "claims/a/top.md", "# §a/top\n\nThe top does X, Y and Z.\n");
    note(root, "edit", "§a/top");
    const ok = land(root, "--write");
    assert.equal(ok.exit, 0, JSON.stringify(ok.findings));
    assert.equal(read(root, ".sova/spec/claims/a/top.md"), "# §a/top\n\nThe top does X, Y and Z.\n");
  });
}
