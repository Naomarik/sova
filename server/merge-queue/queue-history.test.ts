import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SETTLED_CHECKED } from "./settled";
import { KEEP_FINAL } from "./store";
import { makeKit, sh } from "./testing/queue-kit";

describe("the hourly sweep files every sent-back entry git says is done (the queue's history)", () => {
  test("a sent-back entry whose branch is gone, past the view's window, is filed and trimmed; one whose branch is here waits on its chat", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      const t0 = Date.UTC(2026, 9, 1);
      let n = 0;
      const add = (branch: string, state: "needs-fix" | "landed") => {
        const iso = new Date(t0 + ++n * 60_000).toISOString();
        const id = `mq_h${n.toString().padStart(4, "0")}`;
        q.file.entries.push({
          id,
          project: q.file.project,
          target: "master",
          branch,
          commit: "f".repeat(40),
          state,
          approval: { commit: "f".repeat(40), by: "land-button", at: iso },
          ...(state === "landed" ? { landed: { sha: "e".repeat(40), from: "0".repeat(40), at: iso, pushed: "pushed" as const } } : {}),
          picks: [],
          notes: [],
          runs: [],
          createdAt: iso,
          updatedAt: iso,
          seq: ++q.file.seq,
        } as (typeof q.file.entries)[number]);
        return id;
      };
      // The oldest two: one whose branch was deleted, one whose branch is still here (its chat still owes the fix).
      // A commit of its own, not on the target (a branch at the target's head reads as merged).
      const side = k.repo.branch("feat/side", { "side.txt": "side\n" }).head;
      const gone = add("feat/deleted", "needs-fix");
      sh(k.repo.root, "branch", "feat/waiting", side);
      const waiting = add("feat/waiting", "needs-fix");
      // Newer sent-back entries, branches here, so the view's own check (the newest SETTLED_CHECKED) never reaches the two.
      for (let i = 0; i < SETTLED_CHECKED + 2; i++) {
        sh(k.repo.root, "branch", `feat/newer${i}`, side);
        add(`feat/newer${i}`, "needs-fix");
      }
      for (let i = 0; i < KEEP_FINAL + 1; i++) add(`feat/landed${i}`, "landed");
      q.save();
      await q.view({ fresh: true });
      assert.equal(q.settled().has(gone), false, "the view's check doesn't reach it");
      assert.ok(q.entry(gone), "not yet known as done: kept");
      await q.refreshSettled();
      assert.equal(q.settled().get(gone), "gone");
      assert.equal(q.entry(gone), undefined, "gone counts as truly final: trimmed from the working list");
      assert.equal(q.store.historyRow(gone)?.state, "needs-fix", "and filed in the history");
      assert.ok(q.entry(waiting), "its branch still exists: it waits on its chat");
      assert.equal(q.store.history.has(waiting), false);
      assert.equal(q.entries().filter((e) => e.state === "needs-fix").length, SETTLED_CHECKED + 3, "every waiting one kept");
    } finally {
      await k.done();
    }
  });
});
