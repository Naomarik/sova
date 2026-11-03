#!/usr/bin/env node
// The builds of the m10-versions harness (§mesh/compatibility), as git commits on throwaway local
// branches lab/al_1-*. Made with plumbing only: a private index, no checkout, no worktree, so a
// shared checkout is never switched. Never merged; `delete` removes them.
//
//   node scripts/mesh-lab/e2e/versions-builds.mjs make [--from <rev>] [--legacy <rev>]
//   node scripts/mesh-lab/e2e/versions-builds.mjs list | delete
//
//   legacy     the fork point from master: lists no areas, same protocol fingerprint as base
//   legacy-skewed  legacy plus a comment in shared/protocol.ts: lists no areas, another fingerprint
//   base       <from>, default HEAD
//   base-merged  base's tree with legacy-skewed as a second parent: legacy-skewed has to be an older
//              build of something for Resync to offer it, and it can't be an ancestor of base
//   unrelated  base plus an unused exported type and a comment in shared/protocol.ts: the protocol
//              fingerprint differs and no area number does
//   composer, transcript, sessions, peer   base with that one number raised in shared/wire-areas.json

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "../../..");
const PREFIX = "lab/al_1-";
export const BUMPED = ["composer", "transcript", "sessions", "peer"];
export const BUILDS = ["legacy", "legacy-skewed", "base", "base-merged", "unrelated", ...BUMPED];
export const refOf = (name) => `${PREFIX}${name}`;

function git(args, { env, input, allowFail = false } = {}) {
  const r = spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8", input, env: { ...process.env, ...env }, maxBuffer: 64 << 20 });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.status === 0 ? r.stdout.trim() : null;
}

export const commitOf = (name) => git(["rev-parse", "--verify", "-q", `refs/heads/${refOf(name)}^{commit}`], { allowFail: true });

/** One commit on top of `parent` with `files` ({path: text}) replaced; moves the ref to it. */
function variant(name, parent, files, otherParent) {
  const dir = mkdtempSync(join(tmpdir(), "al1-index-"));
  const env = { GIT_INDEX_FILE: join(dir, "index") };
  try {
    git(["read-tree", parent], { env });
    for (const [path, text] of Object.entries(files)) {
      const blob = git(["hash-object", "-w", "--stdin"], { input: text });
      git(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
    }
    const tree = git(["write-tree"], { env });
    const commit = git(["commit-tree", tree, "-p", parent, ...(otherParent ? ["-p", otherParent] : []), "-m", `lab: throwaway build ${name}, never merged`]);
    git(["update-ref", `refs/heads/${refOf(name)}`, commit]);
    return commit;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function make({ from = "HEAD", legacy } = {}) {
  const base = git(["rev-parse", "--verify", `${from}^{commit}`]);
  const fork = legacy ? git(["rev-parse", "--verify", `${legacy}^{commit}`]) : git(["merge-base", base, "master"]);
  git(["update-ref", `refs/heads/${refOf("legacy")}`, fork]);
  git(["update-ref", `refs/heads/${refOf("base")}`, base]);
  const areas = JSON.parse(git(["show", `${base}:shared/wire-areas.json`]));
  const protocolAt = (rev) => spawnSync("git", ["-C", ROOT, "show", `${rev}:shared/protocol.ts`], { encoding: "utf8", maxBuffer: 64 << 20 }).stdout;
  const protocol = protocolAt(base);
  variant("legacy-skewed", fork, { "shared/protocol.ts": `${protocolAt(fork)}\n// lab: a legacy build on another fingerprint.\n` });
  variant("unrelated", base, { "shared/protocol.ts": `${protocol}\n// lab: an unrelated protocol change, in no area.\nexport interface LabUnrelatedChange {\n  labOnly?: string;\n}\n` });
  variant("base-merged", base, {}, commitOf("legacy-skewed"));
  for (const area of BUMPED) {
    if (typeof areas[area]?.version !== "number") throw new Error(`shared/wire-areas.json at ${base} has no version for ${area}`);
    const next = structuredClone(areas);
    next[area].version += 1;
    variant(area, base, { "shared/wire-areas.json": `${JSON.stringify(next, null, 2)}\n` });
  }
  return Object.fromEntries(BUILDS.map((b) => [b, commitOf(b)]));
}

export function list() {
  return Object.fromEntries(BUILDS.map((b) => [b, commitOf(b)]).filter(([, c]) => c));
}

export function remove() {
  const refs = git(["for-each-ref", "--format=%(refname)", `refs/heads/${PREFIX}*`]).split("\n").filter(Boolean);
  for (const r of refs) git(["update-ref", "-d", r]);
  return refs;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [cmd, ...args] = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  if (cmd === "make") console.log(JSON.stringify(make({ from: opt("--from"), legacy: opt("--legacy") }), null, 2));
  else if (cmd === "list") console.log(JSON.stringify(list(), null, 2));
  else if (cmd === "delete") console.log(remove().join("\n") || "no lab/al_1-* refs");
  else {
    console.error("usage: versions-builds.mjs make [--from <rev>] [--legacy <rev>] | list | delete");
    process.exit(2);
  }
}
