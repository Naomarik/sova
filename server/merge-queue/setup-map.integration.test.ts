/**
 * The queue screen's setup reads (setup-map.ts) on a real repository: the main branch's setup and its versions, as
 * Git has them, and the Setup chat's proposal read live from that chat's own working copy, uncommitted edits too.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { realGit } from "../project-services/engine";
import { readSetupHistory, readSetupMap, type SetupChatFacts, type SetupMapDeps } from "./setup-map";
import { makeRepo, sh } from "./testing/queue-kit";

const check = (id: string, timeout = 600) => ({ id, label: id, run: ["true"], timeout });
const def = (checks: unknown[], extra: Record<string, unknown> = {}) => `${JSON.stringify({ version: 1, merge: { checks, ...extra } }, null, 2)}\n`;

const repo = makeRepo({ prefix: "mq-setup-map-" });
let chat: SetupChatFacts | null = null;
const deps: SetupMapDeps = {
  git: realGit,
  rootOf: async (id) => (id === "prj_map" ? repo.root : null),
  targetOf: async () => "master",
  namesOf: async () => "none",
  setupChat: async () => chat,
};

test("the setup in force, each version on the main branch, and the Setup chat's proposal as it is on disk", async () => {
  repo.commitOn(repo.root, { ".sova/project.json": def([check("unit")]) }, "set up the queue");
  repo.commitOn(repo.root, { "README.md": "unrelated\n" }, "readme");
  repo.commitOn(repo.root, { ".sova/project.json": def([check("unit", 900)]) }, "unit gets 15 minutes");

  const h = await readSetupHistory("prj_map", deps);
  assert.ok(h);
  assert.deepEqual(
    h.versions.map((v) => [v.n, v.subject, v.changes.map((c) => c.detail)]),
    [
      [2, "unit gets 15 minutes", ["time limit 10m → 15m"]],
      [1, "set up the queue", []],
    ],
  );

  // No Setup chat: nothing proposed.
  let a = await readSetupMap("prj_map", deps);
  assert.ok(a);
  assert.equal(a.main.target, "master");
  assert.equal(a.proposal, null);
  assert.deepEqual(a.version, { n: 2, at: h.versions[0]!.at, earlier: 1 });

  // A Setup chat whose working copy changes nothing yet proposes nothing.
  const wt = join(repo.scratch, "setup-wt");
  sh(repo.root, "worktree", "add", "-q", wt, "-b", "setup/queue");
  chat = { session: "s1", worktree: wt, branch: "setup/queue", state: "working" };
  a = await readSetupMap("prj_map", deps);
  assert.equal(a!.proposal, null);

  // An edit it hasn't committed shows at once, marked as being written.
  writeFileSync(join(wt, ".sova/project.json"), def([check("unit", 900), check("lint", 60)]));
  a = await readSetupMap("prj_map", deps);
  assert.equal(a!.proposal?.dirty, true);
  assert.deepEqual(a!.changes.map((c) => [c.tag, c.name]), [["add", "Check lint"]]);

  // A proposal that doesn't parse says so, and still counts as one.
  writeFileSync(join(wt, ".sova/project.json"), "{ not json");
  a = await readSetupMap("prj_map", deps);
  assert.ok(a!.proposal?.problem);

  // The main branch is read as Git has it: an edit in the main checkout's folder isn't the setup in force.
  writeFileSync(join(repo.root, ".sova/project.json"), def([check("other")]));
  a = await readSetupMap("prj_map", deps);
  assert.deepEqual(a!.main.checks.map((c) => c.id), ["unit"]);

  assert.equal(await readSetupMap("prj_none", deps), null);
});
