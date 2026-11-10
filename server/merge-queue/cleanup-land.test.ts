import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { test } from "node:test";
import labJson from "../../shared/retire-lab.json";
import { stateRoot } from "../state-root";
import { scratchRoot } from "../test-scratch";
import { makeKit, sh, until } from "./testing/queue-kit";

// Land never waits for a cleanup rehearsal (§app.merge-queue/approve): a branch of Sova's own repository that changes
// the code retiring and removing worktrees queues and lands as any other, with no rehearsal record anywhere.
test("Land on a change to any cleanup trigger queues at once and lands, with no rehearsal recorded", async () => {
  const agentDir = scratchRoot("cleanup-land-agent-");
  const inherited = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const k = makeKit();
  try {
    mkdirSync(stateRoot(), { recursive: true });
    k.repo.commitOn(k.repo.root, { "shared/retire-lab.json": JSON.stringify(labJson) }, "Sova's own repository");
    sh(k.repo.root, "push", "-q", "origin", k.repo.target);
    // One file per trigger, from the same list the retire-lab group reads.
    const files = Object.fromEntries(labJson.triggers.filter((g) => g.includes("*")).map((g) => [g.replace(/\*/g, "-x.ts"), "x\n"]));
    const b = k.repo.branch("feat/cleanup", files);
    const q = await k.q();
    const ready = (await q.readyRows()).find((r) => r.branch === "feat/cleanup");
    assert.ok(ready, "offered as ready to land");
    assert.equal((ready as { rehearsal?: true }).rehearsal, undefined, "Land isn't marked as waiting for a rehearsal");
    const { entry } = await q.add({ branch: "feat/cleanup", by: "land-button" });
    assert.equal(entry.commit, b.head);
    await until(async () => (await k.entry(entry.id)).state === "landed", "landed");
  } finally {
    await k.done();
    if (inherited === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = inherited;
    rmSync(agentDir, { recursive: true, force: true });
  }
});
