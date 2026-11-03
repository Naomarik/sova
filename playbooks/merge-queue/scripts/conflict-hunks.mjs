#!/usr/bin/env node
// The conflicted hunks of a merge stopped on conflicts, for the merge thread to judge.
//
//   node conflict-hunks.mjs --repo <side worktree>
//
// Reads every unmerged file (`git diff --name-only --diff-filter=U`) and prints one JSON object:
// {"files":[{"file","hunks":[{"line","ours":[…],"base":[…]|null,"theirs":[…]}]}], "other":[…]}.
// `line` is the 1-based line of the hunk's `<<<<<<<` marker; `base` is null unless the merge used diff3
// markers. "other" lists unmerged paths with no markers (a delete, a mode or binary conflict): those
// are never "no behaviour change". Reads only; writes nothing.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The hunks of one file's text with conflict markers. */
export function hunksOf(text) {
  const lines = text.split("\n");
  const hunks = [];
  let cur = null;
  let part = null;
  lines.forEach((l, i) => {
    if (l.startsWith("<<<<<<< ") || l === "<<<<<<<") {
      cur = { line: i + 1, ours: [], base: null, theirs: [] };
      part = "ours";
    } else if (cur && (l.startsWith("||||||| ") || l === "|||||||")) {
      cur.base = [];
      part = "base";
    } else if (cur && l === "=======") part = "theirs";
    else if (cur && (l.startsWith(">>>>>>> ") || l === ">>>>>>>")) {
      hunks.push(cur);
      cur = null;
      part = null;
    } else if (cur && part) cur[part].push(l);
  });
  return hunks;
}

function main(argv) {
  const i = argv.indexOf("--repo");
  const repo = i >= 0 ? argv[i + 1] : ".";
  const names = execFileSync("git", ["-C", repo, "diff", "--name-only", "--diff-filter=U"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const files = [];
  const other = [];
  for (const file of names) {
    let text;
    try {
      text = readFileSync(join(repo, file), "utf8");
    } catch {
      other.push(file);
      continue;
    }
    const hunks = hunksOf(text);
    if (hunks.length) files.push({ file, hunks });
    else other.push(file);
  }
  process.stdout.write(`${JSON.stringify({ files, other }, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
