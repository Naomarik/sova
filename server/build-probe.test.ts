// Run: bun test server/build-probe.test.ts. A coding session's git probe (§app.project-overseer/coding-worktrees):
// the statechart hears git's facts only when they would change its reading, so the project page's refreshes add no
// "Git was checked" row for a branch that didn't move; whatever else moved the reading gets the next probe through.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-build-probe-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const { probeBuild, probeHeld, readBuild } = await import("./build-loadout");
const { hostOf } = await import("./org-engine");
const { seedBuild } = await import("./org-test-fixtures");
const { settled } = await import("./workspace-git");
type Reading = import("./project-worktrees").WorktreeReading;

after(async () => {
  for (const o of orgs.orgsInfo().orgs) await settled(o.dir);
  rmSync(root, { recursive: true, force: true });
});

const reading = (over: Partial<Reading> = {}): Reading => ({ state: "open", merged: false, branch: true, ahead: 0, unmerged: 0, dirty: false, worktree: null, ...over });

test("a probe the statechart's data already holds is held; any fact that differs, or no data, is not", () => {
  const data = { tree: "open", branchState: "unmerged", gitAhead: 2, gitDirty: false, gitBranchGone: false };
  const same = { tree: "open", branch: "unmerged", ahead: 2, dirty: false, branchGone: false };
  assert.equal(probeHeld(data, same), true);
  for (const [k, v] of Object.entries({ tree: "missing", branch: "merged", ahead: 3, dirty: true, branchGone: true, error: "git failed" }))
    assert.equal(probeHeld(data, { ...same, [k]: v }), false, `${k} changed`);
  assert.equal(probeHeld(data, { ...same, other: 1 }), false, "a key it doesn't know is never assumed held");
  assert.equal(probeHeld(null, same), false, "no data: delivered");
});

test("identical probes write one history row; a changed probe writes a new one", async () => {
  const org = await orgs.createOrg({ name: "Probes", dir: join(root, "ws1") });
  mkdirSync(join(root, "proj1"));
  const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj1") });
  await seedBuild(org.id, project.id, { sessionId: "c-same", kind: "coding", worktree: { branch: "sova/same", base: "main", target: "main" } });
  const sid = `build/${project.id}/c-same`;
  const row = readBuild(project.id, "c-same")!;
  const probes = () => hostOf(org.id).log.rows({ session: sid }).filter((r) => r.event === "git/probe").length;
  for (let i = 0; i < 5; i++) await probeBuild(project.id, sid, row, reading({ ahead: 1 }));
  assert.equal(probes(), 1, "five identical readings: one row");
  await probeBuild(project.id, sid, row, reading({ ahead: 1, dirty: true }));
  assert.equal(probes(), 2, "a changed reading: a new row");
  await probeBuild(project.id, sid, row, reading({ ahead: 1, dirty: true }));
  assert.equal(probes(), 2);
  assert.equal(hostOf(org.id).data(sid)?.["branchState"], "unmerged");
});

test("a probe is delivered again once something else moved the statechart's reading: merged, retired", async () => {
  const org = await orgs.createOrg({ name: "Reset", dir: join(root, "ws2") });
  mkdirSync(join(root, "proj2"));
  const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj2") });
  await seedBuild(org.id, project.id, { sessionId: "c-reset", kind: "coding", worktree: { branch: "sova/reset", base: "main", target: "main" } });
  const sid = `build/${project.id}/c-reset`;
  const host = hostOf(org.id);
  const row = readBuild(project.id, "c-reset")!;
  const merged = reading({ state: "merged", merged: true });
  await probeBuild(project.id, sid, row, merged);
  assert.equal(host.data(sid)?.["branchState"], "merged");
  // Something other than the page's read resets the reading (a direct act, as a replay or another caller sends one).
  await host.act(sid, "git/probe", { branch: "unmerged", ahead: 1 }, { by: "system" } as never, { settle: true });
  assert.equal(host.data(sid)?.["branchState"], "unmerged");
  await probeBuild(project.id, sid, row, merged);
  assert.equal(host.data(sid)?.["branchState"], "merged", "the same probe again reaches the statechart");
  assert.equal((await host.act(sid, "session/retire", {}, { by: "system" } as never, { settle: true })).taken, true);
});
