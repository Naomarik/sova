// Run: pnpm test -- server/test-repo-fence.test.ts. No test reaches a repository it didn't make: a
// TMPDIR inside a checkout once let tests register plain temp folders as that checkout's project and
// commit decision promotions on its master and cut sova/* worktrees beside it. Here a scratch
// repository (a main checkout and a linked worktree, as Sova's own are) holds TMPDIR, and must come out
// as it went in.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { resolveBun } from "./runtime-choice";
import { scratchRoot } from "./test-scratch";

const ROOT = resolve(import.meta.dirname, "..");
const PRELOAD = join(ROOT, "pi-config", "extensions", "claude-code", "tests", "hermetic-env.mjs");
/** The files that wrote into the enclosing repository: promotion commits, and sova/* branches with worktrees. */
const LEAKED = ["server/reconcile.test.ts", "server/project-coding-runtime.test.ts", "server/overseer-org-tools.test.ts", "server/org-about-privacy.test.ts"];

const base = scratchRoot("sova-fence-");
after(() => rmSync(base, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const main = join(base, "main");
const wt = join(base, "wt");
git(base, "init", "-q", "-b", "master", main);
git(main, "commit", "-q", "--allow-empty", "-m", "root");
git(main, "worktree", "add", "-q", "-b", "feat/x", wt);
const inside = join(wt, "tmp", "orch");
mkdirSync(inside, { recursive: true });

/** What a leak changes: every ref, the worktree list, and either checkout's files (ignored ones too;
    not the worktree's tmp/, the runs' own TMPDIR). */
const state = () =>
  [
    git(main, "for-each-ref", "--format=%(refname) %(objectname)"),
    git(main, "worktree", "list", "--porcelain"),
    git(main, "status", "--porcelain", "--ignored"),
    git(wt, "status", "--porcelain", "--ignored", "--", ".", ":(exclude)tmp"),
  ].join("\n");
const pristine = state();

describe("tests never reach a repository they didn't create", () => {
  test("pnpm test refuses a TMPDIR inside a linked worktree: exit 2, one line naming the repository and the fix, nothing run or changed", { timeout: 600_000 }, (t) => {
    const bun = process.versions.bun ? { path: process.execPath } : resolveBun();
    if (!("path" in bun)) return t.skip(`no Bun to run the runner on (${bun.missing})`);
    const env: NodeJS.ProcessEnv = { ...process.env, SOVA_BUN: bun.path, TMPDIR: inside, TMP: inside, TEMP: inside };
    delete env.SOVA_RUNTIME;
    const r = spawnSync("node", [join(ROOT, "scripts", "run-tests.mjs"), "--runtime", "bun", ...LEAKED], { cwd: ROOT, env, encoding: "utf8", timeout: 590_000 });
    assert.equal(state(), pristine, "the scratch repository gained no commit, branch, worktree or file");
    assert.equal(r.status, 2, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.equal(r.stdout, "", "no test file ran");
    const lines = r.stderr.split("\n").filter((l) => l && !/^mise /.test(l));
    assert.equal(lines.length, 1, r.stderr);
    assert.match(lines[0]!, /^run-tests: the temp dir .* is inside the git repository /);
    assert.ok(lines[0]!.includes(`git repository ${wt},`), lines[0]);
    assert.match(lines[0]!, /run with a TMPDIR outside every repository/);
  });

  test("the preload stops git's search at the temp dir: a plain folder there is its own project, even with GIT_DIR inherited", () => {
    // As the runner starts a file: its throwaway root is TMPDIR and holds HOME. Nothing inherited fences git.
    const root = mkdtempSync(join(inside, "sova-test-home-"));
    mkdirSync(join(root, "home"));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home"), SOVA_TEST_HOME: root, TMPDIR: root, TMP: root, TEMP: root };
    delete env.GIT_CEILING_DIRECTORIES;
    // A run from a git hook: these point every git at the repository whatever its cwd.
    env.GIT_DIR = join(main, ".git");
    env.GIT_WORK_TREE = main;
    const probe = join(base, "probe.ts");
    writeFileSync(
      probe,
      `import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { projectOf } = await import(${JSON.stringify(join(ROOT, "server", "project-root.ts"))});
const dir = join(mkdtempSync(join(tmpdir(), "plain-")), "client");
mkdirSync(dir);
let found = null;
try { found = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
console.log(JSON.stringify({ dir, found, project: await projectOf(dir) }));
`,
    );
    const args = process.versions.bun ? ["--preload", PRELOAD, probe] : ["--import", "tsx", "--import", PRELOAD, probe];
    const r = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1)!) as { dir: string; found: string | null; project: { state: string; root?: string; git?: boolean } };
    assert.equal(out.found, null, "git finds no repository from the plain folder");
    assert.deepEqual(out.project, { state: "ok", root: out.dir, name: "client", git: false }, "registered as itself, not as the main checkout");
    assert.equal(state(), pristine);
  });
});
