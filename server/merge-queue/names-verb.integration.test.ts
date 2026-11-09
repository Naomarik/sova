// merge.names (names-verb.ts): Sova runs the names interview's writes on the project's own names file, the one the queue
// keeps; the sandboxed thread hands it names as text and never a path. The method's real script, on a home and an agent
// dir of the test's own (it never reads this machine's).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { runProc } from "./copy";
import { namesStep } from "./names-verb";
import { DEFAULT_PLAYBOOK_DIR } from "./thread";

test("add writes the user's names through a temp file Sova deletes; show lists them; the answer to add says kinds and counts, never a value", async () => {
  const dir = scratchRoot("names-verb-");
  const home = join(dir, "home");
  const agent = join(home, ".pi", "agent");
  const repo = join(dir, "repo");
  mkdirSync(agent, { recursive: true });
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo });
  const file = join(agent, "sova", "merge-queue", "k0", "names.json");
  const q = { root: repo, target: "master", names: () => ({ file, exists: existsSync(file) }) };
  const run: typeof runProc = (argv, o) => runProc(argv, { ...o, env: { ...o.env, HOME: home, PI_CODING_AGENT_DIR: agent } });
  const script = join(DEFAULT_PLAYBOOK_DIR, "scripts", "discover-names.mjs");
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith("sova-names-")).length;
  const added = await namesStep(q, "add", "client: Pelican Holdings\nserver: 203.0.114.5", script, run);
  assert.equal(added.action, "add");
  assert.ok(!added.summary.includes("Pelican") && !added.summary.includes("203.0.114.5"), added.summary);
  assert.equal(readdirSync(tmpdir()).filter((n) => n.startsWith("sova-names-")).length, before, "the list file is gone");
  assert.ok(readFileSync(file, "utf8").includes("Pelican Holdings"), "written to the queue's own file");
  const shown = await namesStep(q, "show", undefined, script, run);
  assert.match(shown.list ?? "", /Pelican Holdings/);
});
