// A sent-back branch whose tip moved: why its newest commit isn't Ready to land, from the same reading the chat's
// worktree row shows (server/ready-to-land.ts newestBlockedOf, through QueueDeps.newestReading); git alone when no
// reading is there. Read only, and kept a few seconds: view() runs often.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { treeReadiness } from "../merge-readiness";
import { newestBlockedOf, newestReadingOf } from "../ready-to-land";
import type { WorktreeReadiness } from "../../shared/protocol";
import { stillSentBack } from "../../src/lib/merge-queue";
import { makeKit, until } from "./testing/queue-kit";

const facts = { path: "/wt/x", branch: "feat/x", tracked: "active" as const, readable: true, merged: false, dirty: false, ahead: 1 };
const idle = { running: false, openQuestions: 0, asks: false };
/** The tree as readiness publishes it, from the facts and the chat's own reading. */
const treeOf = (t: Partial<typeof facts & { conflicts: number; base: string; dirtyCount: number; tempCommit: string }>, s: Partial<Parameters<typeof treeReadiness>[1]>, more: Partial<WorktreeReadiness> = {}): WorktreeReadiness => {
  const r = treeReadiness({ ...facts, ...t }, { ...idle, ...s });
  return { path: "/wt/x", branch: "feat/x", state: r.state, ...(r.why ? { why: r.why } : {}), reason: r.reason, ...more };
};
const failed = { at: 1, ok: false, what: "test run", failed: "1 failing file, server/a.test.ts" };

describe("why the newest commit isn't Ready to land, from the readiness reading", () => {
  test("the chat's last check, a conflict, open questions, a busy session: said as readiness says them", () => {
    assert.equal(newestBlockedOf(treeOf({}, { lastCheck: failed }), "tip"), "this chat's last test run failed: 1 failing file, server/a.test.ts");
    assert.equal(newestBlockedOf(treeOf({ conflicts: 2, base: "master" }, {}), "tip"), "conflicts with master: 2 files");
    assert.equal(newestBlockedOf(treeOf({}, { openQuestions: 2 }), "tip"), "2 open questions");
    assert.equal(newestBlockedOf(treeOf({}, { running: true }), "tip"), "working now");
    assert.equal(newestBlockedOf(treeOf({ tempCommit: "WIP x" }, {}), "tip"), "temporary commit: WIP x");
  });

  test("Ready to land at that commit: nothing blocks it; ready at another commit: the reading is old, so no answer", () => {
    const at = (commit: string, state: "ready" | "specs" = "ready") => treeOf({}, {}, { landing: { state, commit } });
    assert.equal(newestBlockedOf(at("tip"), "tip"), null);
    assert.equal(newestBlockedOf(at("older"), "tip"), undefined);
    assert.equal(newestBlockedOf(at("tip", "specs"), "tip"), "its spec drafts don't fit");
  });

  test("code-ready but not Ready to land: a few uncommitted files, or its chat hasn't finished", () => {
    assert.equal(newestBlockedOf(treeOf({}, {}, { dirtyCount: 1, dirtyFiles: ["a"] }), "tip"), "1 uncommitted file in its folder: commit or remove them first");
    assert.equal(newestBlockedOf(treeOf({}, {}), "tip"), "its chat hasn't said the work is finished");
  });

  test("no reading, a merged or gone tree: no answer (the queue's own checks decide)", () => {
    assert.equal(newestBlockedOf(undefined, "tip"), undefined);
    assert.equal(newestBlockedOf(treeOf({}, {}, { merged: true }), "tip"), undefined);
  });
});

describe("the live reading: a worktree's owning chat, through its last readiness answer", () => {
  const tree = { ...treeOf({}, { lastCheck: failed }), path: "/real/wt" };
  const d = { owner: async () => ({ session: "s1" }), pathOf: async (id: string) => (id === "s1" ? "/s1.jsonl" : undefined), reading: () => ({ known: true as const, value: { trees: [tree] } }), canonical: () => "/real/wt" };
  test("finds the owner's tree by its canonical path and says why", async () => {
    assert.match((await newestReadingOf("/link/wt", "tip", d)) ?? "", /this chat's last test run failed/);
  });
  test("no answer: no owner, an archived or unlisted one, a chat never read, another tree", async () => {
    assert.equal(await newestReadingOf("/w", "tip", { ...d, owner: async () => null }), undefined);
    assert.equal(await newestReadingOf("/w", "tip", { ...d, owner: async () => { throw new Error("x"); } }), undefined);
    assert.equal(await newestReadingOf("/w", "tip", { ...d, owner: async () => ({ session: "s1", archived: true }) }), undefined);
    assert.equal(await newestReadingOf("/w", "tip", { ...d, owner: async () => ({ session: "gone" }) }), undefined);
    assert.equal(await newestReadingOf("/w", "tip", { ...d, reading: () => ({ known: false as const }) }), undefined);
    assert.equal(await newestReadingOf("/w", "tip", { ...d, canonical: () => "/other" }), undefined);
  });
});

// al_3: a branch sent back under the user's standing Land stays with its chat (with-chat) and is never offered Land at
// a newer commit: its checked fix goes back in line by itself (queue-standing.test.ts). The newest-commit reading below
// is for a hand-back that is final: an approval from before the standing Land.
describe("the sent-back row in the queue's view", () => {
  /** A branch sent back (approved before the standing Land, so the hand-back is final), then moved on by one commit. */
  async function sentBackMoved(deps: Parameters<typeof makeKit>[0]) {
    const k = makeKit(deps);
    k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit failed" }));
    const b = k.repo.branch("feat/x", { "x.txt": "x\n" });
    const q = await k.q();
    await q.pause("an approval from before the standing Land");
    const { entry } = await q.add({ branch: "feat/x", by: "land-button" });
    const legacy = q.entry(entry.id)!;
    delete legacy.approval.standing;
    delete legacy.approval.userCommit;
    q.save();
    await q.resume();
    await until(async () => (await k.entry(entry.id)).state === "needs-fix", "sent back");
    const tip = k.repo.commitOn(b.path, { "y.txt": "y\n" }, "the fix");
    return { k, q, b, tip, id: entry.id };
  }

  test("a chat whose last check failed: the row says so, stays on the Sent back list, and no Ready row stands in for it", async () => {
    const seen: [string, string][] = [];
    const reading = treeOf({}, { lastCheck: failed });
    const { k, q, b, tip, id } = await sentBackMoved({ deps: { newestReading: async (wt, t) => (seen.push([wt, t]), newestBlockedOf(reading, t)) } });
    try {
      const v = await q.view({ fresh: true });
      const e = v.needsFix.find((x) => x.id === id)!;
      assert.equal(e.newerCommits, 1);
      assert.match(e.newerBlocked ?? "", /this chat's last test run failed/);
      assert.ok(!(v.ready ?? []).some((r) => r.branch === "feat/x"), "not listed as Ready to land");
      assert.deepEqual(stillSentBack(v).map((x) => x.id), [id]);
      assert.deepEqual(seen, [[b.path, tip]]);
      // Kept a few seconds: another view, even at once, reads nothing again.
      await q.view({ fresh: true });
      assert.equal(seen.length, 1);
    } finally {
      await k.done();
    }
  });

  test("a reading that says Ready to land: nothing blocks it, and the Ready row stands for it", async () => {
    const { k, q, id } = await sentBackMoved({ deps: { newestReading: async () => null } });
    try {
      const v = await q.view({ fresh: true });
      assert.equal(v.needsFix.find((x) => x.id === id)!.newerBlocked, undefined);
      assert.ok((v.ready ?? []).some((r) => r.branch === "feat/x"));
      assert.deepEqual(stillSentBack(v), []);
    } finally {
      await k.done();
    }
  });

  test("no reading: the queue's own checks (a temporary commit) still answer", async () => {
    const { k, q, b, id } = await sentBackMoved({ deps: { newestReading: async () => undefined } });
    try {
      k.repo.commitOn(b.path, { "z.txt": "z\n" }, "temp: not done");
      const v = await q.view({ fresh: true });
      assert.match(v.needsFix.find((x) => x.id === id)!.newerBlocked ?? "", /temporary commit/);
    } finally {
      await k.done();
    }
  });

  test("a reading that throws never breaks the view: the queue's own checks answer", async () => {
    const { k, q, id } = await sentBackMoved({ deps: { newestReading: async () => { throw new Error("no sessions"); } } });
    try {
      const v = await q.view({ fresh: true });
      assert.equal(v.needsFix.find((x) => x.id === id)!.newerBlocked, undefined);
    } finally {
      await k.done();
    }
  });
});
