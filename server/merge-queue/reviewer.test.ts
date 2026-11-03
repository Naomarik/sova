// Run: pnpm test server/merge-queue/reviewer.test.ts
// The review step's reviewer chat on the server: started in the merge copy with the step's own
// message and a title naming the branch, commit and attempt; archived once on stop; a start Sova
// refuses throws (the step counts it as the reviewer's failure, never the branch's).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewerStart } from "./review-step";
import { reviewerStarter, reviewerTitle, type ReviewerDeps } from "./reviewer";

const o: ReviewerStart = {
  runId: "mr_7",
  projectId: "p1",
  root: "/w/sova",
  copy: "/w/.worktrees/sova-merge",
  base: "b".repeat(40),
  commit: "c".repeat(40),
  branch: "feat/x",
  kit: ".sova/playbooks/review",
  text: "Review one change before it lands…",
  attempt: 1,
};

test("titles name the branch, the commit and a retry's attempt", () => {
  assert.equal(reviewerTitle(o), "Review · feat/x · ccccccc");
  assert.equal(reviewerTitle({ ...o, attempt: 2 }), "Review · feat/x · ccccccc · attempt 2");
});

test("a reviewer chat starts in the merge copy with the step's message; stop archives it once", async () => {
  const created: { cwd: string; text: string; title: string; root: string }[] = [];
  const archived: string[] = [];
  const deps: ReviewerDeps = {
    async create(cwd, text, title, root) {
      created.push({ cwd, text, title, root });
      return { ok: true, id: "r1", path: "/sessions/r1.jsonl" };
    },
    async archive(path) {
      archived.push(path);
      return { ok: true };
    },
  };
  const h = await reviewerStarter(deps)(o);
  // The project's root rides along: its review model is the project's (models.ts), not the copy's.
  assert.deepEqual(created, [{ cwd: o.copy, text: o.text, title: "Review · feat/x · ccccccc", root: o.root }]);
  assert.equal(h.sessionId, "r1");
  await h.stop();
  await h.stop();
  assert.deepEqual(archived, ["/sessions/r1.jsonl"]);
});

test("a refused start throws; a failed archive is only logged", async () => {
  await assert.rejects(reviewerStarter({ create: async () => ({ ok: false, error: "no such profile" }), archive: async () => ({ ok: true }) })(o), /couldn't start the reviewer: no such profile/);
  const h = await reviewerStarter({ create: async () => ({ ok: true, id: "r2", path: "/p" }), archive: async () => Promise.reject(new Error("gone")) })(o);
  await assert.doesNotReject(h.stop());
});
