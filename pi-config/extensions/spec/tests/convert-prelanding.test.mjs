// convert/lib.mjs findPreLanding on synthetic repos, in every shape the landing of the conversion can leave: not
// landed yet, landed by a merge, landed by a fast-forward (as landing 2 did), each with master moving on after; and
// the histories it must refuse (null: requireBases then fails hard, so nothing passes by skipping).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmp, put, git, gitInit, env } from "./layout/lib.mjs";
import { SPEC, findPreLanding } from "./convert/lib.mjs";

const V1 = JSON.stringify({ formatVersion: 1, claims: {} }, null, 2) + "\n";
const V2 = JSON.stringify({ formatVersion: 2, claims: "records live beside each claim file, in claims/**/*.json" }, null, 2) + "\n";
const runIn = (root) => (args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: env(root) });
const commit = (root, rel, text, msg) => { put(root, rel, text); git(root, "add", "-A"); git(root, "commit", "-qm", msg); return git(root, "rev-parse", "HEAD"); };

/** main: c0 → m1. feat from c0: b1, its merge of main (parents b1 and m1), the flip F (format 2), a changelog h. */
function history() {
  const root = tmp("spec-convert-prelanding-");
  put(root, `${SPEC}/manifest.json`, V1);
  gitInit(root);
  git(root, "checkout", "-qb", "feat");
  commit(root, "feat.txt", "b1\n", "b1");
  git(root, "checkout", "-q", "main");
  const m1 = commit(root, "main.txt", "m1\n", "m1");
  git(root, "checkout", "-q", "feat");
  git(root, "merge", "--no-ff", "-q", "-m", "merge main", "main");
  const F = commit(root, `${SPEC}/manifest.json`, V2, "flip");
  const h = commit(root, "CHANGELOG.md", "sizes\n", "changelog");
  git(root, "checkout", "-q", "main");
  return { root, m1, F, h, find: (branches = ["main"]) => findPreLanding(runIn(root), F, branches) };
}
/** Master moves on after the landing: another branch lands by a merge. */
function moveOn(root) {
  git(root, "checkout", "-qb", "other");
  commit(root, "other.txt", "o\n", "other");
  git(root, "checkout", "-q", "main");
  git(root, "merge", "--no-ff", "-q", "-m", "land other", "other");
}

test("not landed yet: the merge base of the flip with master", () => {
  const r = history();
  assert.equal(r.find(), r.m1);
});

test("landed by a merge: through the landing merge's first parent, also after master moves on", () => {
  const r = history();
  git(r.root, "merge", "--no-ff", "-q", "-m", "land feat", "feat");
  assert.equal(git(r.root, "rev-parse", "main^2"), r.h, "a landing merge");
  assert.equal(r.find(), r.m1);
  moveOn(r.root);
  assert.equal(r.find(), r.m1);
});

test("landed by a fast-forward: the second parent of the flip's parent merge, also after master moves on", () => {
  const r = history();
  git(r.root, "merge", "--ff-only", "-q", "feat");
  assert.equal(git(r.root, "rev-parse", "main"), r.h, "a fast-forward");
  assert.equal(r.find(), r.m1);
  moveOn(r.root);
  assert.equal(r.find(), r.m1);
});

test("neither shape: null, so requireBases fails hard", () => {
  // a fast-forwarded flip whose parent is no merge of master
  const root = tmp("spec-convert-prelanding-");
  put(root, `${SPEC}/manifest.json`, V1);
  gitInit(root);
  git(root, "checkout", "-qb", "feat");
  const F = commit(root, `${SPEC}/manifest.json`, V2, "flip");
  git(root, "checkout", "-q", "main");
  git(root, "merge", "--ff-only", "-q", "feat");
  assert.equal(findPreLanding(runIn(root), F, ["main"]), null);
  // no master or main to look in
  const r = history();
  assert.equal(r.find(["no-such-branch"]), null);
});
