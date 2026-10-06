#!/usr/bin/env node
// Build a replay tree from a Git ref: `git archive <commit> pi-config/extensions | tar -x -C <dest>`.
//
//   node make-tree.mjs <ref> <dest> [--repo <dir>]
//
// <dest> must be empty or absent. Writes <dest>/replay-source.json ({ ref, commit }), which run.mjs
// records in the scorecard, and prints the tree to pass as --baseline/--candidate:
// <dest>/pi-config/extensions. --repo defaults to the checkout holding this script.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function makeTree(ref, dest, repo = dirname(fileURLToPath(import.meta.url))) {
  const git = (args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  const top = git(["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) throw new Error(`${repo} is not in a Git checkout`);
  const commit = git(["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  if (commit.status !== 0) throw new Error(`${ref} is not a commit`);
  const sha = commit.stdout.trim();
  const out = resolve(dest);
  if (existsSync(out) && readdirSync(out).length) throw new Error(`${out} is not empty`);
  mkdirSync(out, { recursive: true });
  const archive = spawnSync("git", ["-C", top.stdout.trim(), "archive", "--format=tar", sha, "pi-config/extensions"], { maxBuffer: 512 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(`git archive failed: ${archive.stderr}`);
  const tar = spawnSync("tar", ["-x", "-C", out], { input: archive.stdout });
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  writeFileSync(join(out, "replay-source.json"), JSON.stringify({ ref, commit: sha }, null, 2) + "\n");
  return join(out, "pi-config/extensions");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--repo");
  const repo = at >= 0 ? args.splice(at, 2)[1] : undefined;
  if (args.length !== 2) { console.error("usage: node make-tree.mjs <ref> <dest> [--repo <dir>]"); process.exit(2); }
  try { console.log(makeTree(args[0], args[1], repo)); } catch (e) { console.error(e.message); process.exit(1); }
}
