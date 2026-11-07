// Run: pnpm test:int server/merge-queue/thread.integration.test.ts
// The merge thread's scripts as the thread runs them, as programs on a real repo: blast-radius.mjs
// finds the project's own map from --repo and picks statecharts for a branch touching them;
// conflict-hunks.mjs prints a stopped merge's hunks; the reviewer (no shell) gets the change written
// for it on a real repo (review-change.ts).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { removeReviewChange, reviewChangeDir, writeReviewChange } from "./review-change";

const REPO = join(import.meta.dirname, "..", "..");
const SCRIPTS = join(REPO, "playbooks", "merge-queue", "scripts");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function project(): string {
  const r = join(scratchRoot("mq-thread-int-"), "proj");
  mkdirSync(r, { recursive: true });
  git(r, "init", "-q", "-b", "master");
  git(r, "config", "user.email", "t@example.com");
  git(r, "config", "user.name", "t");
  return r;
}
function commit(r: string, file: string, text: string): string {
  mkdirSync(join(r, file, ".."), { recursive: true });
  writeFileSync(join(r, file), text);
  git(r, "add", file);
  git(r, "commit", "-q", "-m", file);
  return git(r, "rev-parse", "HEAD");
}

test("blast-radius.mjs reads the project's own map from --repo and picks statecharts with its reason; no map, no picks", () => {
  const r = project();
  commit(r, "README.md", "x\n");
  git(r, "checkout", "-q", "-b", "feat/charts");
  commit(r, "statecharts/src/org.cljs", "(ns org)\n");
  const run = () => JSON.parse(execFileSync("node", [join(SCRIPTS, "blast-radius.mjs"), "--base", "master", "--tip", "feat/charts", "--repo", r], { encoding: "utf8" }));
  const none = run();
  assert.deepEqual(none.picks, []);
  assert.equal(none.map, null);
  const own = join(r, ".sova", "playbooks", "merge-queue", "references");
  mkdirSync(own, { recursive: true });
  copyFileSync(join(REPO, ".sova", "playbooks", "merge-queue", "references", "blast-radius.json"), join(own, "blast-radius.json"));
  const out = run();
  assert.deepEqual(out.picks.map((p: { id: string }) => p.id), ["statecharts"]);
  assert.match(out.picks[0].why, /statecharts changed/);
  assert.equal(out.paths, 1);
  // The same from a list on stdin.
  const piped = JSON.parse(execFileSync("node", [join(SCRIPTS, "blast-radius.mjs"), "--map", join(own, "blast-radius.json")], { input: "statecharts/a.cljs\nREADME.md\n", encoding: "utf8" }));
  assert.deepEqual(piped.picks.map((p: { id: string }) => p.id), ["statecharts"]);
  const bad = spawnSync("node", [join(SCRIPTS, "blast-radius.mjs"), "--map", join(r, "missing.json")], { input: "", encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /can't read the map/);
});

test("conflict-hunks.mjs lists a stopped merge's hunks, with the base under diff3, and writes nothing", () => {
  const r = project();
  git(r, "config", "merge.conflictStyle", "diff3");
  commit(r, "list.txt", "alpha\nomega\n");
  git(r, "checkout", "-q", "-b", "feat/add");
  commit(r, "list.txt", "alpha\nbeta\nomega\n");
  git(r, "checkout", "-q", "master");
  commit(r, "list.txt", "alpha\ngamma\nomega\n");
  git(r, "checkout", "-q", "feat/add");
  assert.notEqual(spawnSync("git", ["-C", r, "merge", "--no-ff", "--no-commit", "master"]).status, 0);
  const before = readFileSync(join(r, "list.txt"), "utf8");
  const out = JSON.parse(execFileSync("node", [join(SCRIPTS, "conflict-hunks.mjs"), "--repo", r], { encoding: "utf8" }));
  assert.deepEqual(out, { files: [{ file: "list.txt", hunks: [{ line: 2, ours: ["beta"], base: [], theirs: ["gamma"] }] }], other: [] });
  assert.equal(readFileSync(join(r, "list.txt"), "utf8"), before);
});

test("the reviewer's change: the commits, the changed paths with their status and the whole diff, written to its run folder, then removed", async () => {
  const r = project();
  commit(r, "keep.txt", "one\n");
  commit(r, "gone.txt", "bye\n");
  const base = git(r, "rev-parse", "HEAD");
  git(r, "rm", "-q", "gone.txt");
  writeFileSync(join(r, "keep.txt"), "one\ntwo\n");
  writeFileSync(join(r, "new.txt"), "fresh\n");
  git(r, "add", "-A");
  git(r, "commit", "-q", "-m", "Change three files", "-m", "With a body line.");
  const tip = git(r, "rev-parse", "HEAD");
  const runDir = join(scratchRoot("mq-review-change-"), "run");
  const dir = reviewChangeDir(runDir);
  const change = await writeReviewChange(r, base, tip, dir);
  assert.equal(change.summary, join(dir, "change.txt"));
  const summary = readFileSync(change.summary, "utf8");
  assert.ok(summary.includes(`git diff ${base}...${tip}`));
  assert.match(summary, /Change three files\n\nWith a body line\./);
  assert.match(summary, /^D\tgone\.txt$/m);
  assert.match(summary, /^M\tkeep\.txt$/m);
  assert.match(summary, /^A\tnew\.txt$/m);
  assert.ok(summary.includes(change.diff), "the summary names the diff");
  // Exactly what git diff base...tip prints, byte for byte.
  assert.equal(readFileSync(change.diff, "utf8"), execFileSync("git", ["-C", r, "diff", "--no-color", "--no-ext-diff", `${base}...${tip}`], { encoding: "utf8" }));
  await assert.rejects(writeReviewChange(r, "0".repeat(40), tip, dir), /git log failed/);
  removeReviewChange(dir);
  assert.equal(existsSync(dir), false);
});

