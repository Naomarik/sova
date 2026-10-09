import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DetachedDriver } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";
import { readRegistry } from "./store";

/**
 * A `dir` resource copied from main (`"from": "${main}/<path>"` with `path` the same folder): on the main checkout it
 * is its own source, so create, up and reset keep main's folder as it is, never copying it onto itself or removing it
 * (§app.project-services/contract, /reset); a worktree's copy still gets main's data. The copy is this host's
 * `cp` under real services here; the main checkout's cases run on a host in memory in data-own-source.test.ts.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-data-own-agent-"));

const op: Caller = { kind: "operator" };
let parent = "";
let project = "";
let engine: ProjectEngine;
const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project, encoding: "utf8" });
const DEF = {
  version: 1,
  data: { corpus: { kind: "dir", path: "public/corpus", from: "${main}/public/corpus" } },
  services: { web: { cmd: ["node", "web.mjs"] } },
};

before(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-data-own-proj-")));
  project = join(parent, "demo");
  mkdirSync(join(project, ".sova"), { recursive: true });
  writeFileSync(join(project, "web.mjs"), `console.log("up"); setInterval(() => {}, 1000);`);
  writeFileSync(join(project, ".gitignore"), "public/corpus/\n");
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(DEF, null, 2));
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "def"]);
  // Main's own data: ignored by git, never in a commit.
  mkdirSync(join(project, "public", "corpus"), { recursive: true });
  writeFileSync(join(project, "public", "corpus", "surah-1.json"), "main's data");
  engine = new ProjectEngine({ driver: new DetachedDriver(3_000), pollMs: 100 });
});

after(async () => {
  for (const i of readRegistry().instances) {
    if (i.slot !== 0) await engine.run("teardown", { instance: i.id }, op);
    else await engine.run("down", { instance: i.id }, op);
  }
  rmSync(parent, { recursive: true, force: true });
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
});

const mainFile = () => join(project, "public", "corpus", "surah-1.json");

test("a worktree's copy still gets a copy of main's data, and its reset copies it again", async () => {
  const w = await engine.run("up", { project, branch: "sova/w" }, op);
  assert.equal(w.ok, true, JSON.stringify(w.error));
  const copy = join(w.checkout!, "public", "corpus", "surah-1.json");
  assert.equal(readFileSync(copy, "utf8"), "main's data");
  writeFileSync(copy, "changed in the copy");
  const r = await engine.run("reset", { instance: w.instance }, op);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(readFileSync(copy, "utf8"), "main's data");
  assert.ok(existsSync(mainFile()));
});
