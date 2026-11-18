#!/usr/bin/env node
// Sova's own project.json setup step `node-modules`: a copy's packages, at its branch's versions.
//
//   node scripts/copy-node-modules.mjs <main>/node_modules node_modules
//
// 1. Copies the main checkout's node_modules over the copy's (scripts/copy-tree.mjs: clones or plain
//    copies, never hardlinks, so nothing done in the copy reaches the main checkout's files).
// 2. Drops a top-level `node_modules/node_modules` symlink the copy brought along (the main checkout's
//    holds one leading back into itself): an absolute link into the main checkout's packages.
// 3. Matches the packages to the copy's own lockfile: `pnpm install --frozen-lockfile` in the copy's
//    folder (the parent of <dst>). Packages the shared pnpm store lacks are downloaded; an unchanged
//    lockfile is a quick no-op.
//
// In the merge queue's landing copy (SOVA_VERB=merge, which every merge run step gets) step 3 is
// skipped: there the queue's own offline `merge.install` step is the one place a lockfile change is
// installed, and its failure is the branch's ("install it once in the project").
import { spawnSync } from "node:child_process";
import { lstatSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const [srcArg, dstArg] = process.argv.slice(2);
if (!srcArg || !dstArg) {
  console.error("usage: node scripts/copy-node-modules.mjs <src node_modules> <dst node_modules>");
  process.exit(2);
}
const dst = resolve(dstArg);

const copy = spawnSync(process.execPath, [join(import.meta.dirname, "copy-tree.mjs"), srcArg, dstArg], { stdio: "inherit" });
if (copy.error) console.error(`copy-node-modules: ${copy.error.message}`);
if (copy.status !== 0) process.exit(copy.status ?? 1);

const stray = join(dst, "node_modules");
try {
  if (lstatSync(stray).isSymbolicLink()) {
    rmSync(stray);
    console.log(`copy-node-modules: removed the symlink ${stray}`);
  }
} catch {
  // none
}

if (process.env.SOVA_VERB === "merge") {
  console.log("copy-node-modules: a landing copy: packages left as copied (the merge queue's own install step installs a lockfile change)");
  process.exit(0);
}

const argv = ["install", "--frozen-lockfile", "--config.confirmModulesPurge=false"];
console.log(`copy-node-modules: $ pnpm ${argv.join(" ")}`);
const inst = spawnSync("pnpm", argv, { cwd: dirname(dst), stdio: "inherit" });
if (inst.error) console.error(`copy-node-modules: pnpm: ${inst.error.message}`);
process.exit(inst.status ?? 1);
