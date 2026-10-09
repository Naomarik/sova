// Run: node scripts/run-tests.mjs server/org-history-effects.test.ts. An effect's answer through the real engine
//: the operator merges a coding session's branch; the build statechart's
// `merge` effect is answered by build-loadout's own handler (its git step seeded with the commit it reports), the
// engine sends `effect/done`, and the org's history records the merge request and, apart from it, the observed
// merge with its commit, triggered by that request. No hand-built step. A throwaway agent dir and workspace.
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { scratchRoot } from "./test-scratch";

const tmp = scratchRoot("sova-org-history-effects-");
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
mkdirSync(join(tmp, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const engine = await import("./org-engine");
const { seedBuild } = await import("./org-test-fixtures");
const { settled } = await import("./workspace-git");

after(async () => {
  for (const o of orgs.readIndex().orgs) await settled(o.dir);
  rmSync(tmp, { recursive: true, force: true });
});

describe("an effect answered through the engine", async () => {
  const org = await orgs.createOrg({ name: "Gate", dir: join(tmp, "ws") });
  mkdirSync(join(tmp, "client"));
  const project = await orgs.addProject(org.id, { name: "Portal", root: join(tmp, "client") });

  test("a merge: merge.requested by the operator, then merge.observed with its commit, triggered by the request's effect", async () => {
    await seedBuild(org.id, project.id, { sessionId: "s-merge", kind: "coding", worktree: { branch: "feat/csv", base: "abc", target: "main" }, merged: { commit: "c0ffee1" } });
    const h = engine.hostOf(org.id).history;
    const records = h.search({ role: "operator" }, { kinds: ["merge.requested", "merge.observed"] }).items.map((i) => h.event({ role: "operator" }, i.id)!.record!);
    const req = records.find((r) => r.kind === "merge.requested");
    const obs = records.find((r) => r.kind === "merge.observed");
    assert.ok(req && obs, records.map((r) => r.kind).join(","));
    assert.deepEqual(req!.actors.decidedBy, { kind: "operator" });
    assert.equal(obs!.outcome, "observed");
    assert.deepEqual(obs!.triggeredBy, [{ event: req!.id, via: "effect" }]);
    assert.deepEqual(obs!.evidence, [{ n: 1, kind: "git", repo: "project", project: project.id, commit: "c0ffee1" }]);
    assert.equal((obs!.actors.decidedBy as { unknown?: boolean }).unknown, true, "an outside result decides nothing");
  });
});
