// The branch status line's spec part (§chat.worktrees/readiness): a draft counts as promoted when
// every spec file it changed reads the same in the worktree's current spec. Plain temp folders.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { scratchRoot } from "./test-scratch";
import { unpromotedDrafts } from "./spec-drafts-state";

const root = scratchRoot("sova-spec-drafts-state-");
after(() => rmSync(root, { recursive: true, force: true }));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function draft(dir: string, name: string, base: Record<string, string>, files: Record<string, string>) {
  const d = join(dir, ".sova", "spec", "drafts", name);
  mkdirSync(join(d, "spec", "claims"), { recursive: true });
  writeFileSync(join(d, "draft.json"), JSON.stringify({ format: "sova-spec-draft/1", name, base: { files: Object.fromEntries(Object.entries(base).map(([k, v]) => [k, sha(v)])) } }));
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(d, "spec", rel), text);
}

test("no drafts folder: undefined; a changed file not yet current: unpromoted; once current: promoted", () => {
  const wt = join(root, "wt");
  mkdirSync(join(wt, ".sova", "spec", "claims"), { recursive: true });
  assert.equal(unpromotedDrafts(wt), undefined);
  writeFileSync(join(wt, ".sova", "spec", "claims", "a.md"), "old a");
  writeFileSync(join(wt, ".sova", "spec", "manifest.json"), "{}");
  draft(wt, "feat", { "claims/a.md": "old a", "manifest.json": "{}" }, { "claims/a.md": "new a", "manifest.json": "{}" });
  assert.equal(unpromotedDrafts(wt), 1, "a.md changed in the draft, not in the current spec");
  writeFileSync(join(wt, ".sova", "spec", "claims", "a.md"), "new a");
  assert.equal(unpromotedDrafts(wt), 0, "promoted: the current file now reads as the draft's");
  draft(wt, "other", { "manifest.json": "{}" }, { "manifest.json": '{"x":1}' });
  assert.equal(unpromotedDrafts(wt), 1);
});
