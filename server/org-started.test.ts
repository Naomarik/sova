// Run: pnpm exec tsx --test server/org-started.test.ts. r11 (§app.organizations/org-sessions): a gathering or coding
// session its project retired past the 200-row cap (only once settled) is no longer the org's: it leaves the org's
// rows and the session list's Organizations region. The cap itself is the project statechart's (rules/started, its tests).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { OPERATOR } from "../shared/baton";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-org-started-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const { readBuilds } = await import("./build-loadout");
const { orgLookup, orgCodingIds } = await import("./org-sessions");
const { hostOf } = await import("./org-engine");
const { seedBuild } = await import("./org-test-fixtures");
const { settled } = await import("./workspace-git");

after(async () => {
  for (const o of orgs.orgsInfo().orgs) await settled(o.dir);
  rmSync(root, { recursive: true, force: true });
});

test("a retired gathering and a retired coding session are no longer the org's; a live one is never retired", async () => {
  const org = await orgs.createOrg({ name: "Started", dir: join(root, "ws") });
  mkdirSync(join(root, "proj"));
  const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
  const made = await baton.createBaton({ orgId: org.id, projectId: project.id, to: OPERATOR, publicTitle: "Old", goal: "g" });
  const retire = (sid: string) => hostOf(org.id).act(sid, "session/retire", {}, { by: "system" }, { settle: true });
  // Live: the statechart refuses to retire it.
  await retire(`baton/${org.id}/${made.sessionId}`);
  assert.ok(baton.batonById(made.sessionId), "an open gathering is never retired");
  await baton.closeBaton(made.sessionId);
  await retire(`baton/${org.id}/${made.sessionId}`);
  assert.equal(baton.batonById(made.sessionId), null, "retired: no longer one of the org's gatherings");
  assert.ok(!baton.allBatons().some((b) => b.sessionId === made.sessionId));
  assert.equal(orgLookup().of(made.path, made.sessionId), undefined, "no longer organizational");
  assert.ok(!(await orgs.orgDetail(org.id)).batons.some((b) => b.sessionId === made.sessionId));

  await seedBuild(org.id, project.id, { sessionId: "c-old", kind: "coding", worktree: { branch: "sova/old", base: "main", target: "main" } });
  assert.ok(orgCodingIds().has("c-old"));
  // Unmerged, the statechart refuses: a live build is never retired.
  assert.equal((await retire(`build/${org.id}/${project.id}/c-old`)).taken, false);
  await hostOf(org.id).act(`build/${org.id}/${project.id}/c-old`, "git/probe", { branch: "merged" }, { by: "system" }, { settle: true });
  assert.equal((await retire(`build/${org.id}/${project.id}/c-old`)).taken, true);
  assert.ok(!readBuilds(org.id, project.id).some((r) => r.sessionId === "c-old"));
  assert.ok(!orgCodingIds().has("c-old"), "a retired coding session is no longer organizational");
});
