import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ProjectEngine, type Caller } from "./engine";
import { FakeHost } from "./fake-host";
import { readRegistry } from "./store";

/**
 * A `dir` resource copied from main (`"from": "${main}/<path>"` with `path` the same folder): on the main checkout it
 * is its own source, so create, up and reset keep main's folder as it is, never copying it onto itself or removing it
 * (§app.project-services/contract, /reset); a worktree's copy still gets main's data (in
 * data-own-source.integration.test.ts: it runs this host's `cp`). On a host in memory (fake-host.ts).
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
  engine = new ProjectEngine(new FakeHost().deps());
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

test("up of the main checkout keeps its own data folder: nothing is copied onto itself", async () => {
  const r = await engine.run("up", { project }, op);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.slot, 0);
  assert.equal(r.data.find((d) => d.name === "corpus")?.ref, join(project, "public", "corpus"));
  assert.equal(readFileSync(mainFile(), "utf8"), "main's data");
});

test("reset of the main checkout never removes its own data", async () => {
  const main = readRegistry().instances.find((i) => i.slot === 0)!;
  const r = await engine.run("reset", { instance: main.id }, op);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.match(r.steps.find((s) => s.id === "deprovision:corpus")?.detail ?? "", /kept .*public\/corpus: its from is the folder itself/);
  assert.equal(readFileSync(mainFile(), "utf8"), "main's data");
});
