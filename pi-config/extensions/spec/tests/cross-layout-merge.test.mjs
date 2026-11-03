// Merges across the cutover with landing 1's tools on both sides (al_6): a format 1 branch with promoted records
// merging a format 2 master (the cutover), and a format 2 branch merging a format 1 master (a rollback), each with
// the manifest merge attribute configured and without. Git stops (the driver's layout-mismatch, or the line merge),
// `merge-manifest --write` finishes it, and the result is the record-level three-way merge, written in the layout of
// the default branch's tip. The expected records are computed here from the three sides, not by the tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  META, RECORDS, SPEC, project, core, draft, codes, put, read, git, gitTry, gitInit, hasGit, promoteChange, recordsOnDisk, layoutOnDisk, recordFiles, textTree, notDrafts, env, DRAFT,
} from "./layout/lib.mjs";

const ATTR = ".sova/spec/manifest.json merge=sova-spec-manifest\n.sova/spec/claims/**/*.md merge=sova-spec-claims\n";
const ATTR_V2 = ".sova/spec/claims/**/*.md merge=sova-spec-claims\n";
function drivers(root) {
  git(root, "config", "merge.sova-spec-manifest.driver", `"${process.execPath}" "${DRAFT}" merge-manifest --root . --base %O --ours %A --theirs %B --write`);
  git(root, "config", "merge.sova-spec-claims.driver", `"${process.execPath}" "${DRAFT}" merge-claims --root . --base %O --ours %A --theirs %B --path %P --write`);
}
const BRANCH = {
  md: { "zz/branch.md": "# §zz/branch — Branch\n\nThe branch's note.\n" },
  edit: (r) => { r["§zz/branch"] = { kind: "note", authority: "accepted", requires: [] }; r["§ot/why"].about = ["§ed.seed/compose", "§ot/uses"]; },
  ids: ["§zz/branch", "§ot/why"],
};
const MASTER = {
  md: { "zz/master.md": "# §zz/master — Master\n\nMaster's note.\n", "ot/base.md": "# §ot/base — Base\n\nThe base, as master says.\n" },
  edit: (r) => { r["§zz/master"] = { kind: "note", authority: "accepted", requires: [] }; r["§ot/base"].requires = ["§ot/unrelated"]; },
  ids: ["§zz/master", "§ot/base"],
};
/** The record-level three-way merge of disjoint changes: base, plus each side's added or changed records. */
function threeWay(base, ours, theirs) {
  const out = structuredClone(base);
  for (const side of [ours, theirs]) for (const [id, r] of Object.entries(side)) if (JSON.stringify(r) !== JSON.stringify(base[id])) out[id] = r;
  return out;
}
const migrate = (root, ...a) => { const j = draft(root, ["migrate", ...a, "--write"]).j; assert.equal(j.exit, 0, JSON.stringify(j).slice(0, 500)); };

function run({ direction, attribute }) {
  const root = project(direction === "v1-branch" ? 1 : 2);
  put(root, ".gitattributes", attribute ? ATTR : ATTR_V2);
  gitInit(root);
  if (attribute) drivers(root);
  const c0 = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-qb", "branch");
  promoteChange(root, "b", BRANCH);
  const ours = recordsOnDisk(root).records;
  git(root, "checkout", "-q", "main");
  // the cutover drops the manifest attribute (the branch keeps its own copy, which Git reads during the merge)
  if (direction === "v1-branch") { migrate(root); put(root, ".gitattributes", ATTR_V2); git(root, "add", "-A"); git(root, "commit", "-qm", "cutover"); }
  else { migrate(root, "--reverse"); git(root, "add", "-A"); git(root, "commit", "-qm", "rollback"); }
  promoteChange(root, "m", MASTER);
  const theirs = recordsOnDisk(root).records, wantLayout = layoutOnDisk(root);
  git(root, "checkout", "-q", "branch");
  const base = RECORDS; // c0's records, in either layout
  void c0;
  const merge = gitTry(root, "merge", "main", "-m", "merge main");
  return { root, merge, want: threeWay(base, ours, theirs), wantLayout };
}

for (const direction of ["v1-branch", "v2-branch"]) for (const attribute of [true, false])
  test(`cross-layout merge, a ${direction === "v1-branch" ? "format 1 branch into the converted master" : "format 2 branch into the rolled-back master"}, attribute ${attribute ? "configured" : "absent"}: stops, then merge-manifest --write gives the three-way result in master's layout`, { skip: !hasGit }, () => {
    const { root, merge, want, wantLayout } = run({ direction, attribute });
    assert.notEqual(merge.status, 0, `Git must stop rather than merge two layouts: ${merge.stdout}${merge.stderr}`);
    const before = core(root, ["check"]).j;
    assert.equal(before.exit, 2, `the half-merged spec does not load: ${JSON.stringify(codes(before))}`);
    const fin = draft(root, ["merge-manifest", "--write"]).j;
    assert.equal(fin.exit, 0, JSON.stringify(fin).slice(0, 800));
    assert.equal(layoutOnDisk(root), wantLayout, "the default branch's layout");
    assert.deepEqual(recordsOnDisk(root).records, want, "the record-level three-way merge");
    if (wantLayout === 2) {
      const files = recordFiles(META, want);
      for (const [rel, text] of Object.entries(files)) assert.equal(read(root, `${SPEC}/${rel}`), text, `${rel}: canonical bytes`);
      assert.deepEqual(Object.keys(textTree(root, SPEC, { skip: notDrafts })).filter((r) => r.endsWith(".json") && r !== "manifest.json").sort(), Object.keys(files).sort(), "no stray record file");
    } else {
      assert.equal(Object.keys(textTree(root, SPEC, { skip: notDrafts })).filter((r) => r.endsWith(".json") && r !== "manifest.json").length, 0, "no record file left in format 1");
    }
    const c = core(root, ["check"]).j;
    assert.ok(c.exit <= 1, JSON.stringify(codes(c)));
    git(root, "add", "-A");
    assert.equal(gitTry(root, "diff", "--cached", "--name-only", "--diff-filter=U").stdout.trim(), "");
    git(root, "commit", "-qm", "finish");
    assert.ok(read(root, `${SPEC}/claims/zz/branch.md`).includes("branch's note") && read(root, `${SPEC}/claims/zz/master.md`).includes("Master's note"));
    void env;
  });
