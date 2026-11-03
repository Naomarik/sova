#!/usr/bin/env bun
// One-off: mark a branch folder's spec drafts landed, for a branch the merge queue landed before it wrote landing
// receipts (its Worktrees row says "its spec drafts didn't make it" though they did). Each draft the draft tool's own
// rule finds official in the spec at <commit> gets draft.json's `landed` receipt; nothing is deleted or moved, and a
// draft edited since (not official there) is left alone. Idempotent. Without --write it only says what it would do.
//
//   bun scripts/mark-landed-drafts.ts --worktree <branch folder> --commit <spec commit> [--target master] [--draft <name>]... [--write]
import { resolve } from "node:path";
import { backfillLandedDrafts } from "../server/merge-queue/landed-drafts";

const USAGE = "usage: bun scripts/mark-landed-drafts.ts --worktree <dir> --commit <sha> [--target master] [--draft <name>]... [--write]";
const args = process.argv.slice(2);
let worktree = "";
let commit = "";
let target = "master";
const names: string[] = [];
let write = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const val = () => {
    const v = args[++i];
    if (!v) {
      console.error(USAGE);
      process.exit(2);
    }
    return v;
  };
  if (a === "--worktree") worktree = resolve(val());
  else if (a === "--commit") commit = val();
  else if (a === "--target") target = val();
  else if (a === "--draft") names.push(val());
  else if (a === "--write") write = true;
  else {
    console.error(USAGE);
    process.exit(2);
  }
}
if (!worktree || !commit) {
  console.error(USAGE);
  process.exit(2);
}
try {
  const r = backfillLandedDrafts({ worktree, commit, target, names, write });
  for (const row of r.rows) console.log(`${row.draft}: ${row.state === "marked" && !write ? "would mark (dry run)" : row.state}${row.notOfficial?.length ? ` (not official at ${r.commit.slice(0, 9)}: ${row.notOfficial.join(", ")})` : ""}`);
  if (!r.rows.length) console.log("no drafts");
  if (!write && r.rows.some((x) => x.state === "marked")) console.log("dry run: add --write to write the receipts");
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
