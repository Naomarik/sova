#!/usr/bin/env node
// Make a folder an exact copy of another, as a clone where the file system has one, with the host's
// own cp: GNU's `--reflink=auto`, or macOS's `-c` (server/project-services/copy-tree.ts). Sova's own
// project.json setup step `node-modules` runs it, so a worktree copy works on both hosts:
//
//   node scripts/copy-tree.mjs <src> <dst>
//
// The copy goes into a fresh sibling `<dst>.copy-<pid>-<rand>`, which then replaces `<dst>` (moved
// aside first, then removed); a failed copy removes the sibling and leaves `<dst>` as it was.
// Copying over the old `<dst>` in place fails when it holds hardlinks of the source's files (two
// pnpm node_modules from one store: cp's "are the same file"), and would keep files the source lacks.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { copyContentsArgv } from "../server/project-services/copy-tree.ts";

const [srcArg, dstArg] = process.argv.slice(2);
if (!srcArg || !dstArg) {
  console.error("usage: node scripts/copy-tree.mjs <src> <dst>");
  process.exit(2);
}
const src = resolve(srcArg);
const dst = resolve(dstArg);
const tag = `${process.pid}-${randomBytes(4).toString("hex")}`;
const fresh = `${dst}.copy-${tag}`;
const old = `${dst}.old-${tag}`;

const exists = (p) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

mkdirSync(dirname(dst), { recursive: true });
mkdirSync(fresh);
let status = 1;
try {
  const r = spawnSync("cp", copyContentsArgv(src, fresh), { stdio: "inherit" });
  if (r.error) console.error(`copy-tree: cp: ${r.error.message}`);
  status = r.status ?? 1;
  if (status === 0) {
    const had = exists(dst);
    if (had) renameSync(dst, old);
    try {
      renameSync(fresh, dst);
    } catch (e) {
      if (had) renameSync(old, dst);
      throw e;
    }
    if (had) rmSync(old, { recursive: true, force: true });
  }
} catch (e) {
  console.error(`copy-tree: ${e instanceof Error ? e.message : e}`);
  status = 1;
} finally {
  if (existsSync(fresh)) rmSync(fresh, { recursive: true, force: true });
}
process.exit(status);
