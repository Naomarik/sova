// Run: node --test .sova/playbooks/merge-round/tests/leak-scan.test.mjs
// The merge round's leak scan: it finds a planted private name without ever printing it, finds a
// secret, passes a clean range, and fails closed without its settings file.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCAN = fileURLToPath(new URL("../scripts/leak-scan.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "leak-scan-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const agent = join(dir, "agent");
const repo = join(dir, "repo");
mkdirSync(repo);
const git = (...a) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "init.defaultBranch=master", ...a], { cwd: repo, stdio: "pipe" });
git("init", "-q");
writeFileSync(join(repo, "a.txt"), "hello\n");
git("add", "a.txt");
git("commit", "-q", "-m", "base");

/** The term the settings file names; it must never appear in the scan's output. */
const TERM = "Zanzibar-Host-7";
const settings = (body) => {
  mkdirSync(join(agent, "sova"), { recursive: true });
  writeFileSync(join(agent, "sova", "merge-round.json"), body);
};
const scan = (range = "HEAD~1..HEAD") => spawnSync(process.execPath, [SCAN, "--range", range, "--repo", repo], { env: { ...process.env, PI_CODING_AGENT_DIR: agent }, encoding: "utf8" });

test("fails closed without its settings file, or with no private names", () => {
  let r = scan("HEAD");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /merge-round\.json is missing, so the private names can't be checked\. Push nothing and ask the user\./);
  settings(JSON.stringify({ v: 1, privateNames: [] }));
  r = scan("HEAD");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /lists no privateNames/);
});

test("a clean range passes", () => {
  settings(JSON.stringify({ v: 1, privateNames: ["other-name", TERM] }, null, 2));
  writeFileSync(join(repo, "b.txt"), "nothing here\n");
  git("add", "b.txt");
  git("commit", "-q", "-m", "clean change");
  const r = scan();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no private names or secrets in HEAD~1\.\.HEAD \(1 commit\)/);
});

test("a planted name is found in a diff line, a message and a file name, pointing at the list's line, never printing it", () => {
  writeFileSync(join(repo, "c.txt"), `line one\nsee ${TERM.toLowerCase()} here\n`);
  writeFileSync(join(repo, `notes-${TERM}.md`), "x\n");
  git("add", "c.txt", `notes-${TERM}.md`);
  git("commit", "-q", "-m", `touch ${TERM}`);
  const r = scan();
  assert.equal(r.status, 1);
  const out = r.stdout + r.stderr;
  assert.ok(!out.toLowerCase().includes(TERM.toLowerCase().slice(0, 8)), "the matched term is never printed");
  assert.match(out, / · message line 1 · private name #2 \(merge-round\.json line 5\)/);
  assert.match(out, / · c\.txt:2 · private name #2 \(merge-round\.json line 5\)/);
  assert.match(out, / · its name · private name #2/);
});

test("a secret is found by its pattern, never printed", () => {
  const key = `AKIA${"Q".repeat(16)}`;
  writeFileSync(join(repo, "d.txt"), `aws = ${key}\n`);
  git("add", "d.txt");
  git("commit", "-q", "-m", "config");
  const r = scan();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /d\.txt:1 · looks like a AWS access key/);
  assert.ok(!r.stdout.includes(key));
});
