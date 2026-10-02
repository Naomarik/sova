#!/usr/bin/env node
// restore-general-projects: put back what backup-general-projects.mjs saved.
//
//   node scripts/restore-general-projects.mjs --backup <backup dir> [--write] [--unit <systemd unit>] [--port <live port>]
//
// Checks backup.tar against its recorded SHA-256, refuses while Sova runs on the backup's agent dir, and
// without --write only prints what it would do. With --write it moves every current root aside into
// <backup dir>/displaced-<time>/ (nothing is deleted; roots absent at backup time, like projects.json, are
// moved aside too), extracts the tar back to the same absolute paths, and checks every file against the
// manifest: the restored state equals the backup or the script exits non-zero.
// Throwaway: deleted with scripts/oneshot-general-projects.mjs after the live run.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertStopped, manifestDiff, manifestOf, parseArgs, present, sha256File, UNIT, LIVE_PORT } from "./general-projects-state.mjs";

function moveAside(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (err) {
    if (err?.code !== "EXDEV") throw err;
    cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    rmSync(from, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { backup: "value", write: "flag", unit: "value", port: "value" });
  if (!args.backup) throw new Error("--backup <backup dir> is required");
  const dir = resolve(args.backup);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  if (manifest.kind !== "pre-general-projects" || manifest.version !== 1) throw new Error(`${dir}/manifest.json is not a pre-general-projects backup`);
  const tar = join(dir, manifest.tar.file);
  const sha = sha256File(tar);
  if (sha !== manifest.tar.sha256) throw new Error(`${tar} has sha256 ${sha}, the manifest says ${manifest.tar.sha256}: the backup is damaged`);
  await assertStopped(manifest.agentDir, { unit: args.unit ?? UNIT, port: args.port ? Number(args.port) : LIVE_PORT });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const aside = join(dir, `displaced-${stamp}`);
  const now = manifest.roots.filter((r) => present(r.path));
  console.log(`restore ${dir} (backup.tar sha256 ${sha}, ok)`);
  for (const r of manifest.roots) console.log(`  ${present(r.path) ? "move aside" : "          "} ${r.path} → ${r.kind === "absent" ? "absent, as at backup" : `restored (${r.kind})`}`);
  if (!args.write) {
    console.log("dry run: nothing changed. Rerun with --write.");
    return;
  }

  for (const r of now) moveAside(r.path, join(aside, r.path));
  execFileSync("tar", ["--extract", "--file", tar, "--directory", "/", "--preserve-permissions"], { stdio: ["ignore", "inherit", "inherit"] });

  const got = manifestOf(manifest.roots);
  const diff = manifestDiff(manifest.files, got);
  if (diff.length) {
    console.error(`restore-general-projects: the restored files differ from the manifest:\n  ${diff.join("\n  ")}\nWhat was there before is in ${aside}`);
    process.exit(1);
  }
  const count = Object.values(got).filter((h) => h !== "d").length;
  console.log(`restored: ${count} files equal to the manifest (sha256 each). What was there before: ${now.length ? aside : "nothing"}`);
}

main().catch((err) => {
  console.error(`restore-general-projects: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
