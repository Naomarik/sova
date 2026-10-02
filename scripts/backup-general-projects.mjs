#!/usr/bin/env node
// backup-general-projects: the known backup taken before the General Projects one-shot conversion.
//
//   node scripts/backup-general-projects.mjs [--agent-dir <dir>] [--out <parent dir>] [--unit <systemd unit>] [--port <live port>]
//
// Refuses while Sova runs on the agent dir (sova-runtime.service active, or a fresh live record). Then:
// - tags each org workspace repo's HEAD `pre-general-projects` (an existing tag must already be HEAD);
// - tars every file the cutover touches (orgs.json, projects.json, preview-links.json, preview-kept.json,
//   <stateRoot>/statecharts/, <stateRoot>/projects/, each org workspace with its .git, and the coding-session
//   transcripts the orgs' charts name), paths kept absolute so a restore puts them back where they were;
// - writes manifest.json (each root and what it was, a SHA-256 of every file) and SHA256SUMS;
// - extracts the tar into a scratch dir and checks it against the manifest before saying it's good.
// Prints the backup dir and the tar's checksum. Writes nothing in the agent dir except the git tags.
// Throwaway: deleted with scripts/oneshot-general-projects.mjs after the live run.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { agentDirOf, assertStopped, cutoverRoots, git, manifestDiff, manifestOf, orgsOf, parseArgs, sha256File, TAG, UNIT, LIVE_PORT } from "./general-projects-state.mjs";

async function main() {
  const args = parseArgs(process.argv.slice(2), { "agent-dir": "value", out: "value", unit: "value", port: "value" });
  const agentDir = agentDirOf(args);
  const stateRoot = join(agentDir, "sova");
  await assertStopped(agentDir, { unit: args.unit ?? UNIT, port: args.port ? Number(args.port) : LIVE_PORT });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = resolve(args.out ?? join(homedir(), "sova-backups"), `pre-general-projects-${stamp}`);
  const roots = cutoverRoots(agentDir);
  for (const r of roots) if (dir === r.path || dir.startsWith(r.path + "/")) throw new Error(`the backup dir ${dir} is inside ${r.path}; pick another --out`);

  // Tag first, so the tags are inside the tar too.
  const tags = [];
  for (const o of orgsOf(stateRoot)) {
    let head;
    try {
      head = git(o.dir, ["rev-parse", "--verify", "HEAD"]);
    } catch {
      console.log(`note: ${o.dir} has no commit to tag`);
      continue;
    }
    let tagged = null;
    try {
      tagged = git(o.dir, ["rev-parse", "--verify", `refs/tags/${TAG}^{commit}`]);
    } catch {}
    if (tagged && tagged !== head) throw new Error(`${o.dir} already has a ${TAG} tag at ${tagged.slice(0, 12)}, not HEAD ${head.slice(0, 12)}: an earlier backup? Look before deleting it`);
    if (!tagged) git(o.dir, ["tag", TAG, head]);
    const dirty = git(o.dir, ["--no-optional-locks", "status", "--porcelain"]).split("\n").filter(Boolean).length;
    tags.push({ org: o.id, dir: o.dir, tag: TAG, commit: head, uncommitted: dirty });
  }

  const files = manifestOf(roots);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const list = join(dir, "paths.txt");
  const present = roots.filter((r) => r.kind !== "absent");
  writeFileSync(list, present.map((r) => r.path.replace(/^\//, "")).join("\0"));
  const tar = join(dir, "backup.tar");
  execFileSync("tar", ["--create", "--file", tar, "--directory", "/", "--null", "--files-from", list], { stdio: ["ignore", "inherit", "inherit"] });
  rmSync(list);

  // Prove the tar holds exactly the manifest: extract it aside and compare, path for path.
  const scratch = join(dir, "verify");
  mkdirSync(scratch);
  try {
    execFileSync("tar", ["--extract", "--file", tar, "--directory", scratch], { stdio: ["ignore", "inherit", "inherit"] });
    const got = manifestOf(roots.map((r) => ({ ...r, path: join(scratch, r.path) })));
    const unprefixed = Object.fromEntries(Object.entries(got).map(([p, h]) => [p.slice(scratch.length), h]));
    const diff = manifestDiff(files, unprefixed);
    if (diff.length) throw new Error(`the tar doesn't match the files it was made from:\n  ${diff.join("\n  ")}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const tarSha = sha256File(tar);
  const manifest = { version: 1, kind: "pre-general-projects", createdAt: new Date().toISOString(), agentDir, stateRoot, roots, tags, tar: { file: "backup.tar", sha256: tarSha, bytes: statSync(tar).size }, files };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const manifestSha = sha256File(join(dir, "manifest.json"));
  writeFileSync(join(dir, "SHA256SUMS"), `${tarSha}  backup.tar\n${manifestSha}  manifest.json\n`, { mode: 0o600 });
  chmodSync(tar, 0o600);

  const count = Object.values(files).filter((h) => h !== "d").length;
  console.log(`backup: ${dir}`);
  console.log(`  backup.tar     sha256 ${tarSha} (${manifest.tar.bytes} bytes, ${count} files, verified by extraction)`);
  console.log(`  manifest.json  sha256 ${manifestSha}`);
  for (const r of roots) console.log(`  ${r.kind.padEnd(6)} ${r.path}`);
  for (const t of tags) console.log(`  tag ${t.tag} → ${t.commit.slice(0, 12)} in ${t.dir}${t.uncommitted ? ` (${t.uncommitted} uncommitted paths: in the tar only)` : ""}`);
  console.log(`check later with: (cd ${dir} && sha256sum -c SHA256SUMS)`);
}

main().catch((err) => {
  console.error(`backup-general-projects: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
