// Run: pnpm test server/merge-queue/reviewer.test.ts
// The review step's reviewer chat on the server: started in the merge copy with the step's own
// message and a title naming the branch, commit and attempt; archived once on stop; a start Sova
// refuses throws (the step counts it as the reviewer's failure, never the branch's).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewerStart } from "./review-step";
import { reviewerModel, reviewerStarter, reviewerTitle, sweepReviewers, type ReviewerDeps } from "./reviewer";

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
  const h = await reviewerStarter({ create: async () => ({ ok: true, id: "r2", path: "/p" }), archive: async () => Promise.reject(new Error("gone")), retire: { retryMs: 0, log: () => {} } })(o);
  await assert.doesNotReject(h.stop());
});

// ---- ending a reviewer chat: wait for its turn, else stop it, then archive (retire.ts) -------------

/** A fake clock and a chat that stays mid-turn until `idleAt` (never: Infinity); archive refuses while it is busy. */
function fakeChat(idleAt: number, archiveFails = 0) {
  let clock = 0;
  const calls: string[] = [];
  let aborted = false;
  const busy = () => !aborted && clock < idleAt;
  const deps: ReviewerDeps = {
    async create() {
      return { ok: true, id: "r9", path: "/sessions/r9.jsonl" };
    },
    busy: () => busy(),
    async abort() {
      calls.push(`abort@${clock}`);
      aborted = true;
    },
    async archive(path) {
      if (busy()) return calls.push(`refused@${clock}`), { ok: false, error: "The agent is mid-turn; abort or wait before archiving." };
      if (archiveFails-- > 0) return calls.push(`failed@${clock}`), { ok: false, error: "disk full" };
      calls.push(`archived ${path}@${clock}`);
      return { ok: true };
    },
    retire: { now: () => clock, sleep: async (ms) => void (clock += ms), log: (l) => calls.push(`log ${l}`), waitMs: 120_000, pollMs: 1_000, retryMs: 2_000 },
  };
  return { deps, calls, at: () => clock };
}

test("a reviewer still mid-turn when it answered: archived once, after its turn ends, never refused", async () => {
  const f = fakeChat(4_500);
  const h = await reviewerStarter(f.deps)(o);
  await h.stop();
  assert.deepEqual(f.calls, ["archived /sessions/r9.jsonl@5000"], "waited for the turn, then one archive");
});

test("a reviewer that never goes idle within the bound: stopped at 2 min, then archived", async () => {
  const f = fakeChat(Infinity);
  const h = await reviewerStarter(f.deps)(o);
  await h.stop();
  assert.deepEqual(f.calls, ["abort@120000", "archived /sessions/r9.jsonl@120000"]);
});

test("an archive that keeps failing: tried three times, one log line, stop never throws", async () => {
  const f = fakeChat(0, 99);
  const h = await reviewerStarter(f.deps)(o);
  await assert.doesNotReject(h.stop());
  assert.equal(f.calls.filter((c) => c.startsWith("failed")).length, 3);
  assert.deepEqual(f.calls.filter((c) => c.startsWith("log")), ["log /sessions/r9.jsonl not archived after 3 tries: disk full"]);
});

test("a second stop is a no-op: the first's retire is shared", async () => {
  const f = fakeChat(3_000);
  const h = await reviewerStarter(f.deps)(o);
  await Promise.all([h.stop(), h.stop()]);
  await h.stop();
  assert.equal(f.calls.filter((c) => c.startsWith("archived")).length, 1);
});

test("the startup sweep: every reviewer chat left open whose run nobody waits on, never one a review waits on, nor any other chat", async () => {
  const rows = [
    { id: "a", path: "/s/a.jsonl", archived: false, queueChat: { role: "reviewer" as const } },
    { id: "b", path: "/s/b.jsonl", archived: true, queueChat: { role: "reviewer" as const } },
    { id: "c", path: "/s/c.jsonl", archived: false, queueChat: { role: "reviewer" as const } },
    { id: "t", path: "/s/t.jsonl", archived: false, queueChat: { role: "thread" as const } },
    { id: "u", path: "/s/u.jsonl", archived: false },
  ];
  const retired: string[] = [];
  const done = await sweepReviewers(rows, new Set(["c"]), async (p) => (retired.push(p), "archived"));
  assert.deepEqual(retired, ["/s/a.jsonl"]);
  assert.deepEqual(done, ["/s/a.jsonl"]);
});

// ---- a reviewer with a shell, or the fixer: only ever confined (§app.merge-queue/review-kit) --------

/** A starter's deps that record every chat made (its profile and first message), every prompt and every retire. */
function shellDeps(confine: ReviewerDeps["confine"]) {
  const made: { profile: string; text: string }[] = [];
  const prompted: string[] = [];
  const archived: string[] = [];
  const deps: ReviewerDeps = {
    async create(_cwd, text, _title, _root, x) {
      made.push({ profile: x.profile, text });
      return { ok: true, id: `r${made.length}`, path: `/s/r${made.length}.jsonl`, model: "zai/glm-5.3" };
    },
    ...(confine ? { confine } : {}),
    async prompt(path, text) {
      prompted.push(`${path}: ${text}`);
      return { ok: true };
    },
    async archive(path) {
      archived.push(path);
      return { ok: true };
    },
    retire: { retryMs: 0, log: () => {} },
  };
  return { deps, made, prompted, archived };
}

const shellStart: ReviewerStart = { ...o, profile: "merge-reviewer-shell", text: "with a shell", readOnlyText: "read only" };

test("a shell reviewer starts with no message, its sandbox on, then its message: nothing runs before it is confined", async () => {
  const f = shellDeps(async () => ({ ok: true, status: "Sandbox on · full enforcement" }));
  const h = await reviewerStarter(f.deps)(shellStart);
  assert.deepEqual(f.made, [{ profile: "merge-reviewer-shell", text: "" }]);
  assert.deepEqual(f.prompted, ["/s/r1.jsonl: with a shell"]);
  assert.equal(h.limited, undefined);
  assert.equal(h.model, "zai/glm-5.3");
});

test("a shell its sandbox can't confine is never given: that chat goes, a read-only reviewer starts with the read-only message, and says why", async () => {
  for (const confine of [async () => ({ ok: false as const, why: "this runtime has no sandbox" }), async () => Promise.reject(new Error("boom")), undefined]) {
    const f = shellDeps(confine);
    const h = await reviewerStarter(f.deps)({ ...shellStart, profile: "merge-reviewer-fix" });
    assert.deepEqual(f.made, [{ profile: "merge-reviewer-fix", text: "" }, { profile: "merge-reviewer", text: "read only" }]);
    assert.deepEqual(f.prompted, [], "the unconfined chat never got its message");
    assert.equal(h.sessionId, "r2");
    assert.match(h.limited ?? "", /runs read-only: its sandbox couldn't be turned on/);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(f.archived, ["/s/r1.jsonl"], "the unconfined chat is retired");
  }
});

test("the reviewer's model: this computer's pick, else the kit's when usable here, else the new-chat default", async () => {
  const check = { defaults: () => ({ model: "zai/glm-5.3", thinking: "low" }), denial: (ref: string) => (ref === "off/model" ? "turned off" : null) };
  const none = async () => null;
  const pick = async () => ({ model: "a/pick", thinking: "high" });
  assert.deepEqual(await reviewerModel("/r", { model: "k/kit", thinking: "medium" }, { picked: pick, check }), { opening: { model: "a/pick", thinking: "high" }, ran: { model: "a/pick", thinking: "high" } });
  assert.deepEqual(await reviewerModel("/r", { model: "k/kit", thinking: "medium" }, { picked: none, check }), { opening: { model: "k/kit", thinking: "medium" }, ran: { model: "k/kit", thinking: "medium" } });
  assert.deepEqual(await reviewerModel("/r", { model: "off/model" }, { picked: none, check }), { opening: null, ran: { model: "zai/glm-5.3", thinking: "low" } }, "a kit model turned off here: the default");
  assert.deepEqual(await reviewerModel("/r", { thinking: "xhigh" }, { picked: none, check }), { opening: { model: "zai/glm-5.3", thinking: "xhigh" }, ran: { model: "zai/glm-5.3", thinking: "xhigh" } }, "effort alone: the default model at it");
  assert.deepEqual(await reviewerModel("/r", undefined, { picked: none, check }), { opening: null, ran: { model: "zai/glm-5.3", thinking: "low" } });
});
