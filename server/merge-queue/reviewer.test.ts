// Run: pnpm test server/merge-queue/reviewer.test.ts
// The review step's reviewer chat: started in the merge copy on the merge-reviewer profile with one
// message naming the kit, the exact commit and the verb to answer with; archived once on stop; a
// start Sova refuses throws (the step counts it as a reviewer failure, never the branch's).
import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewerText, startReviewer, type ReviewerDeps, type ReviewerInput } from "./reviewer";

const input: ReviewerInput = {
  root: "/w/sova",
  copy: "/w/.worktrees/sova-merge",
  commit: "c".repeat(40),
  base: "b".repeat(40),
  kitDir: "/w/.worktrees/sova-merge/.sova/playbooks/review",
  runId: "mr_7",
  changedFile: "/state/runs/mr_7/changed.txt",
};

test("the reviewer's message names the kit, the exact commit on its base, read-only, and merge.review for this run", () => {
  const t = reviewerText(input);
  assert.ok(t.includes("/w/.worktrees/sova-merge/.sova/playbooks/review/PLAYBOOK.md"));
  assert.ok(t.includes(`git diff ${input.base}...${input.commit}`));
  assert.ok(t.includes("/state/runs/mr_7/changed.txt"));
  assert.match(t, /Read only/);
  assert.match(t, /merge\.review \{run: "mr_7", verdict, text\}/);
  assert.doesNotMatch(reviewerText({ ...input, changedFile: undefined }), /changed paths are listed/);
});

test("startReviewer: a chat in the merge copy, titled for the commit; stop archives it once", async () => {
  const created: { cwd: string; title: string }[] = [];
  const archived: string[] = [];
  const deps: ReviewerDeps = {
    async create(cwd, _text, title) {
      created.push({ cwd, title });
      return { ok: true, id: "r1", path: "/sessions/r1.jsonl" };
    },
    async archive(path) {
      archived.push(path);
      return { ok: true };
    },
  };
  const r = await startReviewer(input, deps);
  assert.deepEqual(created, [{ cwd: "/w/.worktrees/sova-merge", title: "Review · sova · ccccccc" }]);
  assert.equal(r.sessionId, "r1");
  await r.stop();
  await r.stop();
  assert.deepEqual(archived, ["/sessions/r1.jsonl"]);
});

test("a refused start throws; a failed archive is only logged", async () => {
  await assert.rejects(startReviewer(input, { create: async () => ({ ok: false, error: "no such profile" }), archive: async () => ({ ok: true }) }), /couldn't start the reviewer: no such profile/);
  const r = await startReviewer(input, { create: async () => ({ ok: true, id: "r2", path: "/p" }), archive: async () => Promise.reject(new Error("gone")) });
  await assert.doesNotReject(r.stop());
});
