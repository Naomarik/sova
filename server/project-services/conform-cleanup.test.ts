import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseDefinition } from "../../shared/project-contract";
import { conformer } from "./conform";
import { DetachedDriver } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";
import { readRegistry } from "./store";
import { approve, defHashOf } from "./trust";

/**
 * Conformance cleans up after itself on every outcome (§app.project-services/conform): the scratch
 * worktrees and `sova/conform-*` branches it cut are gone after a failed setup too, even one that left
 * files behind in its worktree.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-conform-cleanup-agent-"));

const op: Caller = { kind: "operator" };
let parent = "";
let project = "";
let engine: ProjectEngine;
const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project, encoding: "utf8" });

function commitDef(d: object) {
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(d, null, 2));
  const hash = defHashOf(parseDefinition(JSON.stringify(d)));
  approve(project, hash, hash);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "def"]);
}

/** Every scratch branch, every worktree besides the main checkout, and every folder beside it that conform cut. */
function leftovers(): string[] {
  const branches = git(["branch", "--list", "sova/conform-*"]).split("\n").map((s) => s.trim()).filter(Boolean);
  const trees = git(["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree ") && l.slice(9) !== project);
  const dir = join(parent, ".worktrees");
  const folders = existsSync(dir) ? readdirSync(dir) : [];
  return [...branches.map((b) => `branch ${b}`), ...trees, ...folders.map((f) => `folder ${f}`)];
}

before(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-conform-cleanup-proj-")));
  project = join(parent, "demo");
  mkdirSync(join(project, ".sova"), { recursive: true });
  // Leaves an untracked file in its worktree, then fails: the worktree is dirty.
  writeFileSync(join(project, "setup.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync("local.edn", "{}"); console.log("no config"); process.exit(3);`);
  writeFileSync(join(project, "fail.mjs"), `process.exit(2);`);
  writeFileSync(join(project, "web.mjs"), `console.log("web up"); setInterval(() => {}, 1000);`);
  git(["init", "-q", "-b", "main"]);
});

after(async () => {
  for (const i of readRegistry().instances) await engine.run("teardown", { instance: i.id }, op);
  rmSync(parent, { recursive: true, force: true });
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
});

before(() => {
  engine = new ProjectEngine({ driver: new DetachedDriver(3_000), pollMs: 100 });
  engine.conformer = conformer(engine);
});

test("a setup that fails after writing into its worktree: no scratch worktree, folder or sova/conform-* branch is left", async () => {
  commitDef({ version: 1, slots: { cap: 1 }, setup: [{ id: "locals", run: ["node", "setup.mjs"] }], services: { web: { cmd: ["node", "web.mjs"] } } });
  const r = await engine.run("conform", { project }, op);
  assert.equal(r.ok, false);
  assert.equal(r.conform?.checks.find((c) => !c.ok)?.id, "create-a");
  assert.deepEqual(leftovers(), []);
  assert.deepEqual(r.conform?.leaks, []);
  assert.equal(readRegistry().instances.length, 0);
});

test("a setup that fails cleanly: nothing is left either", async () => {
  commitDef({ version: 1, slots: { cap: 1 }, setup: [{ id: "fail", run: ["node", "fail.mjs"] }], services: { web: { cmd: ["node", "web.mjs"] } } });
  const r = await engine.run("conform", { project }, op);
  assert.equal(r.ok, false);
  assert.deepEqual(leftovers(), []);
});

test("a run that passes leaves nothing", async () => {
  commitDef({ version: 1, slots: { cap: 1 }, services: { web: { cmd: ["node", "web.mjs"] } } });
  const r = await engine.run("conform", { project }, op);
  assert.equal(r.ok, true, JSON.stringify(r.conform?.checks.filter((c) => !c.ok)));
  assert.deepEqual(leftovers(), []);
});
