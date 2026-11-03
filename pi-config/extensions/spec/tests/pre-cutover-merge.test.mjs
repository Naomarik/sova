// BRIEF al_6 a4/a5: a branch cut before the cutover, with the merge helper configured per USAGE.md (a relative
// path, so Git runs the BRANCH'S OWN copy of sova-spec-draft.mjs), promotes one new claim; master converts to
// format 2; the branch merges master. The merge must not quietly drop records: either it stops, or the next
// `sova-spec.mjs check` exits non-zero with the mixed-layout error. Then the one documented command finishes it
// (format 2, the branch's claim and every master record kept). Run for both helpers a pre-cutover branch can have:
// the tools from before al_6 (git archive of the branch base) and landing 1's tools; and with no helper configured.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { cpSync, existsSync, readdirSync } from "node:fs";
import {
  META, RECORDS, CLAIMS, SPEC, REPO, CORE_DIR, project, put, read, tmp, git, gitTry, gitInit, hasGit, promoteChange, recordsOnDisk, layoutOnDisk,
  codes, messages, env,
} from "./layout/lib.mjs";

const OLD = "9b7297f8b805149e1042068f60b9297097d67961"; // feat/spec-store's base on master: the spec tools before al_6
const haveOld = hasGit && spawnSync("git", ["-C", REPO, "cat-file", "-e", `${OLD}^{commit}`]).status === 0;
const TOOLS = "pi-config/extensions/spec/core";

/** Put a copy of the spec core at the repo-relative path USAGE.md's driver lines name. */
function installTools(root, which) {
  if (which === "new") { cpSync(CORE_DIR, join(root, TOOLS), { recursive: true }); return; }
  const r = spawnSync("sh", ["-c", `git -C "$1" archive ${OLD} ${TOOLS} | tar -x -C "$2"`, "sh", REPO, root], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(root, TOOLS, "layout.mjs")), false, "the old tools predate layout.mjs");
}
/** The pre-cutover USAGE.md's two driver lines, as written there (node + the clone-relative path). */
function configureDrivers(root) {
  const usage = spawnSync("git", ["-C", REPO, "show", `${OLD}:.sova/spec/USAGE.md`], { encoding: "utf8" }).stdout;
  const lines = [...usage.matchAll(/git config (merge\.sova-spec-(?:manifest|claims)\.driver) \\\n\s*'([^']+)'/g)].map((m) => [m[1], m[2]]);
  assert.equal(lines.length, 2, "USAGE.md gives both driver lines");
  for (const [key, cmd] of lines) {
    assert.match(cmd, /^node pi-config\/extensions\/spec\/core\/sova-spec-draft\.mjs /, "a clone-relative path: each branch runs its own copy");
    git(root, "config", key, cmd.replace(/^node /, `"${process.execPath}" `));
  }
}

/**
 * main: c0 (format 1, tools `branchTools`) → [landing 1 tools] → cutover (migrate --write, attribute dropped).
 * branch "old" from c0: promotes §zz/branch with its own tools.
 */
function scenario({ branchTools, drivers }) {
  const root = tmp("spec-precut-");
  project(1, { root });
  installTools(root, branchTools);
  put(root, ".gitattributes", ".sova/spec/manifest.json merge=sova-spec-manifest\n.sova/spec/claims/**/*.md merge=sova-spec-claims\n");
  gitInit(root);
  if (drivers) configureDrivers(root);
  const c0 = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-qb", "old");
  promoteChange(root, "branch", {
    tool: join(root, TOOLS, "sova-spec-draft.mjs"),
    md: { "zz/branch.md": "# §zz/branch — Branch\n\nThe branch's new note.\n" },
    edit: (r) => { r["§zz/branch"] = { kind: "note", authority: "accepted", requires: [] }; }, ids: ["§zz/branch"],
  });
  assert.equal(layoutOnDisk(root), 1);
  git(root, "checkout", "-q", "main");
  if (branchTools === "old") { installTools(root, "new"); git(root, "add", "-A"); git(root, "commit", "-qm", "landing 1: the tools"); }
  // master moves on in format 1 too (a record the branch must not lose), then converts
  promoteChange(root, "master", { tool: join(root, TOOLS, "sova-spec-draft.mjs"), md: { "ot/base.md": "# §ot/base — Base\n\nThe base, as master says.\n" }, edit: (r) => { r["§ot/base"].requires = ["§ot/unrelated"]; }, ids: ["§ot/base"] });
  const m = spawnSync(process.execPath, [join(root, TOOLS, "sova-spec-draft.mjs"), "migrate", "--write", "--root", root, "--json"], { encoding: "utf8", env: env(root) });
  assert.equal(m.status, 0, `master converts: ${m.stdout}`);
  put(root, ".gitattributes", ".sova/spec/claims/**/*.md merge=sova-spec-claims\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "cutover");
  assert.equal(layoutOnDisk(root), 2);
  git(root, "checkout", "-q", "old");
  return { root, c0 };
}
const repoCore = (root, args) => {
  const r = spawnSync(process.execPath, [join(root, TOOLS, "sova-spec.mjs"), ...args, "--root", root, "--json"], { encoding: "utf8", env: env(root) });
  return { status: r.status, j: JSON.parse(r.stdout) };
};
const repoDraft = (root, args) => {
  const r = spawnSync(process.execPath, [join(root, TOOLS, "sova-spec-draft.mjs"), ...args, "--root", root, "--json"], { encoding: "utf8", env: env(root) });
  return { status: r.status, j: JSON.parse(r.stdout) };
};

const CASES = [
  ["the pre-al_6 helper (the branch's own old copy)", { branchTools: "old", drivers: true }, haveOld],
  ["landing 1's helper", { branchTools: "new", drivers: true }, haveOld],
  ["no helper configured (Git's line merge)", { branchTools: "new", drivers: false }, haveOld],
];
for (const [name, opts, can] of CASES) test(`pre-cutover branch merges the converted master, ${name}: refused, never a quiet loss; one command finishes it`, { skip: !can }, () => {
  const { root } = scenario(opts);
  const merge = gitTry(root, "merge", "main", "-m", "merge main");
  const chk = repoCore(root, ["check"]);
  const mixed = codes(chk.j).includes("layout-mixed");
  // BRIEF a5: the merge or the next check exits non-zero with the mixed-layout error.
  assert.ok(merge.status !== 0 || (chk.status !== 0 && mixed), `merge ${merge.status}: ${merge.stdout}${merge.stderr}\ncheck ${chk.status}: ${JSON.stringify(codes(chk.j))}`);
  // Stronger: whatever Git did, the spec it left does not load as a valid spec.
  assert.notEqual(chk.status, 0, `the half-merged spec must not check clean: ${JSON.stringify(codes(chk.j))}`);
  if (opts.drivers) assert.ok(mixed, `with the helper configured the manifest is left as the branch had it, beside master's record files: layout-mixed, got ${JSON.stringify(codes(chk.j))}`);
  // With or without a helper (without one, Git's line merge leaves conflict markers in manifest.json), the next
  // check names the one command that finishes the merge.
  const msg = messages(chk.j) + JSON.stringify(chk.j.findings);
  assert.match(msg, /merge-manifest/, `mid-merge, check names merge-manifest: ${msg.slice(0, 600)}`);
  assert.match(msg, /--write/, "with --write");
  // the one command (landing 1's merge-manifest, in index mode) finishes the merge in master's layout
  const fin = repoDraft(root, ["merge-manifest", "--write"]);
  assert.equal(fin.status, 0, JSON.stringify(fin.j).slice(0, 800));
  assert.equal(layoutOnDisk(root), 2, "the default branch's layout");
  const recs = recordsOnDisk(root).records;
  assert.deepEqual(recs["§zz/branch"], { kind: "note", authority: "accepted", requires: [] }, "the branch's claim is kept");
  assert.deepEqual(recs["§ot/base"].requires, ["§ot/unrelated"], "master's change is kept");
  for (const id of Object.keys(RECORDS)) assert.ok(id in recs, `${id} kept`);
  const after = repoCore(root, ["check"]);
  assert.ok(after.status <= 1, JSON.stringify(codes(after.j)));
  git(root, "add", "-A");
  assert.equal(gitTry(root, "diff", "--name-only", "--diff-filter=U").stdout.trim(), "", "nothing left unmerged");
  git(root, "commit", "-qm", "finish merge");
  assert.equal(read(root, `${SPEC}/claims/zz/branch.md`), "# §zz/branch — Branch\n\nThe branch's new note.\n");
  void META; void CLAIMS; void readdirSync;
});

test("a pre-cutover branch that changed no records merges the converted master cleanly into format 2", { skip: !haveOld }, () => {
  const root = tmp("spec-precut-");
  project(1, { root });
  installTools(root, "old");
  put(root, ".gitattributes", ".sova/spec/manifest.json merge=sova-spec-manifest\n.sova/spec/claims/**/*.md merge=sova-spec-claims\n");
  gitInit(root);
  configureDrivers(root);
  git(root, "checkout", "-qb", "old");
  put(root, "src/other.ts", "export const other = 2;\n");
  git(root, "commit", "-qam", "code only");
  git(root, "checkout", "-q", "main");
  installTools(root, "new");
  assert.equal(spawnSync(process.execPath, [join(root, TOOLS, "sova-spec-draft.mjs"), "migrate", "--write", "--root", root, "--json"], { encoding: "utf8", env: env(root) }).status, 0);
  put(root, ".gitattributes", ".sova/spec/claims/**/*.md merge=sova-spec-claims\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "landing 1 + cutover");
  git(root, "checkout", "-q", "old");
  const merge = gitTry(root, "merge", "main", "-m", "merge main");
  assert.equal(merge.status, 0, merge.stdout + merge.stderr);
  assert.equal(layoutOnDisk(root), 2);
  const chk = repoCore(root, ["check"]);
  assert.ok(chk.status <= 1, JSON.stringify(codes(chk.j)));
  assert.deepEqual(recordsOnDisk(root).records, RECORDS);
});
