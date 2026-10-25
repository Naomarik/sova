// A show_changes branch card opens pinned (§chat.changes/show-changes-card): after the branch moves
// on, the viewer's scope from the card's details (src/lib/changes-view.ts scopeFromDetails) makes the
// diff endpoint serve exactly the files and hunks the tool checked when it made the card.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { coverageRefusal, type DiffFileHunks } from "../pi-config/extensions/show-changes/coverage.ts";
import { normalizeShowChangesDetails } from "../pi-config/extensions/show-changes/details.ts";
import { runGit } from "../pi-config/extensions/show-changes/git.ts";
import { readHunks } from "../pi-config/extensions/show-changes/hunks.ts";
import { scopeFromDetails } from "../src/lib/changes-view";
import { GitDiffs, patchHunks } from "./git-diff";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-pinned-card-")));
after(() => rmSync(root, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const SESSION = "/fake/pinned.jsonl";

it("a branch card shows the diff the tool checked, after the branch moved on", async () => {
  const main = join(root, "main");
  const wt = join(root, "wt");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "master");
  writeFileSync(join(main, "a.txt"), lines(40));
  writeFileSync(join(main, "old.txt"), lines(5));
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "base");
  git(main, "worktree", "add", "-q", "-b", "feat/card", wt);
  writeFileSync(join(wt, "a.txt"), lines(40).replace("line 2\n", "line two\n").replace("line 30\n", "line thirty\n"));
  writeFileSync(join(wt, "new.txt"), "new\n");
  git(wt, "mv", "old.txt", "renamed.txt");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "card");

  // What the tool reads and checks when it makes the card.
  const head = git(wt, "rev-parse", "HEAD");
  const base = git(wt, "merge-base", "HEAD", "master");
  const scope = { kind: "worktree" as const, worktreePath: wt, root: wt, branch: "feat/card", head, base, baseRef: "master" };
  const checked = await readHunks(runGit, scope);
  const steps = [
    { title: "The edit", hunks: [{ path: "a.txt" }] },
    { title: "The rest", hunks: [{ path: "new.txt" }, { path: "renamed.txt" }] },
  ];
  assert.equal(coverageRefusal(steps, checked), undefined);
  const details = normalizeShowChangesDetails({ v: 1, scope, steps });
  assert.ok(details);

  // The branch moves on: more edits to the same file, and a new one.
  writeFileSync(join(wt, "a.txt"), lines(40).replace("line 2\n", "line 2 again\n").replace("line 10\n", "line ten\n"));
  writeFileSync(join(wt, "later.txt"), "later\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "later");

  // The viewer opens the card.
  const viewScope = scopeFromDetails(details, SESSION);
  const d = new GitDiffs({ sessionKnown: async (p) => (p === SESSION ? { roots: [wt], trees: [], merges: [] } : null) });
  const summary = await d.summary(viewScope);
  assert.equal(summary.head.oid, head);
  assert.equal(summary.base.oid, base);
  assert.deepEqual(
    summary.files.map((f) => f.path),
    checked.map((f) => f.path),
  );
  const shown: DiffFileHunks[] = [];
  for (const f of summary.files) {
    const p = await d.patch(viewScope, f.path, f.oldPath);
    shown.push({ path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), hunks: p.binary || p.tooLarge ? null : patchHunks(p.patch ?? "").map((h) => ({ oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, firstChanged: "" })) });
  }
  const headers = (fs: DiffFileHunks[]) => fs.map((f) => [f.path, (f.hunks ?? []).map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])]);
  assert.deepEqual(headers(shown), headers(checked));
  // The card's steps place every hunk of what the viewer shows, as they did for the tool.
  assert.equal(coverageRefusal(details.steps, shown), undefined);
});
