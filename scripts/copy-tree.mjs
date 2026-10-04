#!/usr/bin/env node
// Copy a folder's contents into another (made when missing), as a clone where the file system has
// one, with the host's own cp: GNU's `--reflink=auto`, or macOS's `-c` (server/project-services/copy-tree.ts).
// Sova's own project.json setup step `node-modules` runs it, so a worktree copy works on both hosts:
//
//   node scripts/copy-tree.mjs <src> <dst>
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { copyContentsArgv } from "../server/project-services/copy-tree.ts";

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error("usage: node scripts/copy-tree.mjs <src> <dst>");
  process.exit(2);
}
mkdirSync(dst, { recursive: true });
const r = spawnSync("cp", copyContentsArgv(src, dst), { stdio: "inherit" });
process.exit(r.status ?? 1);
