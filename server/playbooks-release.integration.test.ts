import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The release playbooks' drivers as the agent runs them (the playbook bundle convention: a digest on stdout, exit 0 fine,
 * 1 something to act on, 2 couldn't tell): playbooks/release-maker/scripts/release-maker.mjs and
 * playbooks/release/scripts/release.mjs, in scratch repositories. Their logic is covered in-process by
 * release-playbooks.test.ts; this file holds only what needs the process: the exit codes and the digests.
 */

const MAKER = fileURLToPath(new URL("../playbooks/release-maker/scripts/release-maker.mjs", import.meta.url));
const REL = fileURLToPath(new URL("../playbooks/release/scripts/release.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "playbooks-release-int-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const env = { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent") };
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "init.defaultBranch=main", "-c", "tag.gpgSign=false", ...a], { cwd, stdio: "pipe", encoding: "utf8" });
const run = (script: string, cwd: string, ...a: string[]) => spawnSync(process.execPath, [script, ...a], { cwd, encoding: "utf8", env });

function project(name: string, tagged = true): string {
  const r = join(dir, name);
  mkdirSync(r, { recursive: true });
  git(r, "init", "-q");
  writeFileSync(join(r, "package.json"), JSON.stringify({ name: "demo", version: "1.2.3", scripts: { release: "touch RAN-RELEASE" } }, null, 2) + "\n");
  writeFileSync(join(r, ".gitignore"), "dist/\n");
  writeFileSync(join(r, "CHANGELOG.md"), "# Changelog\n\n## v1.2.3 — 2026-01-01\n\n- First.\n");
  git(r, "add", "-A");
  git(r, "commit", "-qm", "base");
  if (tagged) git(r, "tag", "-a", "v1.2.3", "-m", "v1.2.3");
  return r;
}

test("release-maker: candidates 0, init 0 then 1, check 1 before init and 0 after, fmt --check 0; nothing ran", () => {
  const r = project("maker");
  const c = run(MAKER, r, "candidates");
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /v\$\{version\}: 1 tag\(s\), newest v1\.2\.3/);
  assert.match(c.stdout, /package\.json script release: touch RAN-RELEASE/);
  assert.match(c.stdout, /Publish would push nothing/);
  assert.equal(run(MAKER, r, "check").status, 1, "no settings yet");
  const i = run(MAKER, r, "init", "--bump", "package.json");
  assert.equal(i.status, 0, i.stdout + i.stderr);
  assert.match(i.stdout, /wrote \.sova\/playbooks\/release\/PLAYBOOK\.md/);
  assert.equal(run(MAKER, r, "init").status, 1, "never overwrites");
  const ok = run(MAKER, r, "check");
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /release-maker check: .*: ok — \.sova\/playbooks\/release, tag v\$\{version\}, 4 step\(s\)/);
  assert.equal(run(MAKER, r, "fmt", "--check").status, 0);
  assert.equal(run(MAKER, r, "nonsense").status, 2);
  assert.ok(!existsSync(join(r, "RAN-RELEASE")), "no candidate ran");
});

test("release-maker check fails closed (2) outside a git checkout", () => {
  const plain = join(dir, "plain");
  mkdirSync(plain, { recursive: true });
  assert.equal(run(MAKER, plain, "check").status, 2);
});

test("release.mjs: status 0 with a previous release, 1 for a first; changelog 0/1; bump 1 on an unknown file; artifact 0/1/2", () => {
  const r = project("rel");
  git(r, "commit", "-q", "--allow-empty", "-m", "feat: a screen");
  const s = run(REL, r, "status");
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /previous release: v1\.2\.3/);
  assert.match(s.stdout, /suggested: v1\.3\.0 \(minor/);
  const first = project("first", false);
  assert.equal(run(REL, first, "status").status, 1);

  assert.equal(run(REL, r, "changelog", "--version", "1.2.3").status, 0);
  assert.equal(run(REL, r, "changelog", "--version", "9.9.9").status, 1);
  assert.equal(run(REL, r, "changelog").status, 2, "no --version");

  const notes = run(REL, r, "notes");
  assert.equal(notes.status, 0);
  const file = /material in (.+)$/m.exec(notes.stdout)?.[1];
  assert.ok(file && file.startsWith(join(dir, "agent", "sova", "playbooks", "release")), `notes under the state root: ${notes.stdout}`);

  assert.equal(run(REL, r, "bump", "--version", "1.3.0", "--file", "package.json", "--check").status, 0);
  assert.equal(run(REL, r, "bump", "--version", "1.3.0", "--file", "CHANGELOG.md").status, 1);
  assert.equal(run(REL, r, "bump", "--version", "1.3.0", "--file", "missing.json").status, 2);

  mkdirSync(join(r, "dist"));
  writeFileSync(join(r, "dist", "app.bin"), "x");
  writeFileSync(join(r, "loose.bin"), "x");
  const a = run(REL, r, "artifact", "dist/app.bin");
  assert.equal(a.status, 0, a.stdout);
  assert.match(a.stdout, /facts for release\.step: \["artifact=.*","sha256=[0-9a-f]{64}","size=1"\]/);
  assert.equal(run(REL, r, "artifact", "loose.bin").status, 1);
  assert.equal(run(REL, r, "artifact", "gone.bin").status, 2);
});
