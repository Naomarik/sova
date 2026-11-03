// Per-area record files (al_6): two branches that promote into different areas, or into different records (or
// different details of one record, question 3) of one area, merge with Git's own line merge, no driver, no conflict,
// and the spec ends byte-identical whichever branch lands first. That final tree also equals what the independent
// writer (tests/spec-fixture.mjs) gives for the expected records, so "identical" cannot mean "identically wrong".
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  META, RECORDS, CLAIMS, SPEC, project, core, put, read, git, gitTry, gitInit, hasGit, promoteChange, recordsOnDisk, recordFiles, textTree, notDrafts,
} from "./layout/lib.mjs";

const LANDINGS = {
  "different areas": {
    a: { md: { "ot/alpha.md": "# §ot/alpha — Alpha\n\nA new note on the base.\n", "ot/base.md": "# §ot/base — Base\n\nThe base, as A sees it.\n" },
      edit: (r) => { r["§ot/alpha"] = { kind: "note", authority: "accepted", requires: [] }; r["§ot/base"].requires = ["§ot/unrelated"]; }, ids: ["§ot/alpha", "§ot/base"] },
    b: { md: { "zz/beta.md": "# §zz/beta — Beta\n\nAnother new note.\n", "ot/why.md": "# §ot/why — Why compose posts\n\nCompose posts because §ed.seed/compose and §ot/uses must survive a reload.\n" },
      edit: (r) => { r["§zz/beta"] = { kind: "note", authority: "accepted", requires: [] }; r["§ot/why"].about = ["§ed.seed/compose", "§ot/uses"]; }, ids: ["§zz/beta", "§ot/why"] },
    want: (r) => { r["§ot/alpha"] = { kind: "note", authority: "accepted", requires: [] }; r["§ot/base"].requires = ["§ot/unrelated"]; r["§zz/beta"] = { kind: "note", authority: "accepted", requires: [] }; r["§ot/why"].about = ["§ed.seed/compose", "§ot/uses"]; },
    touched: { a: ["claims/ot/alpha.json", "claims/ot/alpha.md", "claims/ot/base.json", "claims/ot/base.md"], b: ["claims/ot/why.json", "claims/ot/why.md", "claims/zz/beta.json", "claims/zz/beta.md"] },
  },
  "different records of one area file": {
    a: { edit: (r) => { r["§ed.seed/compose"].requires = ["§ot/base", "§ot/why"]; }, ids: ["§ed.seed/compose"] },
    b: { edit: (r) => { r["§ed/seed"].notOwned = ["§ot/base", "§ot/uses"]; }, ids: ["§ed/seed"] },
    want: (r) => { r["§ed.seed/compose"].requires = ["§ot/base", "§ot/why"]; r["§ed/seed"].notOwned = ["§ot/base", "§ot/uses"]; },
    touched: { a: ["claims/ed/seed.json"], b: ["claims/ed/seed.json"] },
  },
  "different details of one record (question 3)": {
    a: { edit: (r) => { r["§ed.seed/compose"].requires = ["§ot/base", "§ot/why"]; }, ids: ["§ed.seed/compose"] },
    b: { edit: (r) => { r["§ed.seed/compose"].evidence = "reviewed"; }, ids: ["§ed.seed/compose"] },
    want: (r) => { r["§ed.seed/compose"].requires = ["§ot/base", "§ot/why"]; r["§ed.seed/compose"].evidence = "reviewed"; },
    touched: { a: ["claims/ed/seed.json"], b: ["claims/ed/seed.json"] },
  },
};

function base() {
  const root = gitInit(project(2));
  put(root, ".gitattributes", ".sova/spec/claims/**/*.md merge=sova-spec-claims\n"); // format 2: no attribute for the records
  git(root, "add", "-A"); git(root, "commit", "-qm", "attributes");
  return root;
}
const specTree = (root, rev) => git(root, "ls-tree", "-r", rev, "--", SPEC);
const changedFiles = (root, from, to) => git(root, "diff", "--name-only", from, to, "--", SPEC).split("\n").filter(Boolean).map((p) => p.slice(SPEC.length + 1)).sort();

/** Land `first`, then `second` (which merges main first, as the merge round does), both on top of c0. */
function landInOrder(spec, first, second) {
  const root = base();
  const c0 = git(root, "rev-parse", "HEAD");
  for (const side of ["a", "b"]) {
    git(root, "checkout", "-qb", side, c0);
    promoteChange(root, `d-${side}`, spec[side]);
    assert.deepEqual(changedFiles(root, c0, "HEAD"), spec.touched[side], `branch ${side} writes only its areas' files`);
  }
  git(root, "checkout", "-q", "main");
  git(root, "merge", "-q", "--ff-only", first);
  git(root, "checkout", "-q", second);
  const m = gitTry(root, "merge", "main", "-m", `merge main into ${second}`);
  assert.equal(m.status, 0, `${second} merges main with Git's line merge, no conflict: ${m.stdout}${m.stderr}`);
  git(root, "checkout", "-q", "main");
  git(root, "merge", "-q", "--ff-only", second);
  return root;
}

for (const [name, spec] of Object.entries(LANDINGS)) test(`per-area writes, ${name}: byte-identical whichever branch lands first`, { skip: !hasGit }, () => {
  const ab = landInOrder(spec, "a", "b"), ba = landInOrder(spec, "b", "a");
  assert.equal(specTree(ab, "main"), specTree(ba, "main"), "the same blobs in .sova/spec either way");
  const want = structuredClone(RECORDS);
  spec.want(want);
  assert.deepEqual(recordsOnDisk(ab).records, want, "both changes landed");
  const files = recordFiles(META, want);
  for (const [rel, text] of Object.entries(files)) assert.equal(read(ab, `${SPEC}/${rel}`), text, `${rel}: canonical bytes`);
  assert.deepEqual(Object.keys(textTree(ab, SPEC, { skip: notDrafts })).filter((r) => r.endsWith(".json") && r !== "manifest.json").sort(), Object.keys(files).sort(), "no stray record file");
  const c = core(ab, ["check"]).j;
  assert.ok(c.exit <= 1, JSON.stringify(c.findings));
  void CLAIMS;
});

test("per-area writes: a promotion order inside one tree does not change the bytes either", { skip: !hasGit }, () => {
  const spec = LANDINGS["different areas"];
  const one = base(), two = base();
  promoteChange(one, "x", spec.a); promoteChange(one, "y", spec.b);
  promoteChange(two, "y", spec.b); promoteChange(two, "x", spec.a);
  assert.equal(specTree(one, "HEAD"), specTree(two, "HEAD"));
});
