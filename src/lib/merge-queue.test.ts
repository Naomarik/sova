// The merge queue's words: one vocabulary for the composer control, its modal, the pane and the tab.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MergeEntry, MergeRun, RunStep, WorktreeQueueInfo } from "../../shared/merge-queue";
import { attribution, clock, controlWords, mins, notesOf, pausedTitle, pushedWords, queueRow, queueStateChip, rowsSummary, runProgress, sourceTag, verdictChip, waitingHead, type QueueRowInput } from "./merge-queue";

const SHA = "a".repeat(40);
const wt = (x: Partial<QueueRowInput> = {}): QueueRowInput => ({ status: "active", exists: true, branch: "feat/x", readiness: undefined, ...x });
const q = (x: Partial<WorktreeQueueInfo>): WorktreeQueueInfo => ({ id: "me_1", state: "queued", commit: SHA, notes: [], project: "prj_1", ...x }) as WorktreeQueueInfo;
const ready = { path: "/w", branch: "feat/x", state: "ready" as const };

test("a clean worktree with commits, in a repo the queue serves, reads Ready, with Land", () => {
  const r = queueRow(wt({ readiness: ready, mergeServed: true }));
  assert.equal(r.label, "Ready");
  assert.equal(r.action, "land");
});

test("uncommitted files: Uncommitted, no Land, says how many", () => {
  const r = queueRow(wt({ readiness: { ...ready, state: "in-progress", dirtyCount: 3 } }));
  assert.equal(r.key, "uncommitted");
  assert.equal(r.action, "none");
  assert.match(r.detail!, /3 files not committed/);
});

test("a listed project with no merge setup: Ready to merge, merged from the chat, and it keeps Set Up Queue", () => {
  const r = queueRow(wt({ readiness: ready, mergeProject: { id: "prj_1", root: "/r", target: "main", checks: "unset", review: false } }));
  assert.equal(r.label, "Ready to merge");
  assert.equal(r.reason, "Say \u201cland it\u201d in the chat to merge it into main.");
  assert.equal(r.action, "setup");
});

test("a repo the queue doesn't serve: Ready to merge, the plain-merge line, never Land nor the queue's words", () => {
  // Off the Projects list: no mergeProject, no mergeServed. A listed project with checks but no mergeServed
  // (the server's answer wins) reads the same: Land keys on mergeServed alone.
  for (const x of [{}, { mergeProject: { id: "prj_1", root: "/r", target: "main", checks: "declared" as const, review: false } }]) {
    const r = queueRow(wt({ readiness: { ...ready, landing: { state: "ready", commit: SHA } }, ...x }));
    assert.equal(r.key, "ready");
    assert.equal(r.label, "Ready to merge");
    assert.equal(r.tone, "success");
    assert.equal(r.reason, "Say \u201cland it\u201d in the chat to merge it into main.");
    assert.equal(r.action, "none");
    assert.doesNotMatch(`${r.label} ${r.reason}`, /Ready to land|Landing specs|queue|Land\b/);
  }
  // The other states read as before.
  const dirty = queueRow(wt({ readiness: { ...ready, dirtyCount: 1 } }));
  assert.equal(dirty.key, "uncommitted");
  assert.equal(dirty.reason, "Commit it in its chat.");
  assert.equal(queueRow(wt({ readiness: { ...ready, dirtyCount: 1 }, mergeServed: true })).reason, "Commit it in its chat, then Land.");
  assert.equal(queueRow(wt({ readiness: { ...ready, noCommits: true } })).key, "no-commits");
  assert.equal(queueRow(wt({ status: "merged" })).key, "merged");
  assert.deepEqual(controlWords([queueRow(wt({ readiness: ready }))]), { text: "1 ready", n: 1, dot: "ok" });
});

test("queued: its place, its estimates, Cancel; a newer commit is said", () => {
  const r = queueRow(wt({ queue: q({ state: "queued", position: 2, eta: { startsInMs: 4 * 60_000, takesMs: 9 * 60_000 }, newerCommits: 1 }) }));
  assert.equal(r.label, "Queued · 2nd");
  assert.equal(r.detail, "starts in ~4 min · takes ~9 min");
  assert.equal(r.action, "cancel");
  assert.equal(r.newer, "1 newer commit not included");
});

test("checking pulses and has no action", () => {
  const r = queueRow(wt({ queue: q({ state: "checking" }) }));
  assert.equal(r.label, "Checking");
  assert.equal(r.live, true);
  assert.equal(r.action, "none");
});

test("behaviour differs: both sides in words, Accept and Send Back", () => {
  const r = queueRow(
    wt({ queue: q({ state: "behaviour-differs", conflict: { files: ["a.ts"], verdict: "behaviour-differs", ours: "Master retries twice.", theirs: "The branch never retries.", proposal: "Keep master's retry.", at: "" } }) }),
  );
  assert.equal(r.label, "Behaviour differs");
  assert.equal(r.action, "accept");
  assert.equal(r.sendBack, true);
  assert.equal(r.reason, "Target: Master retries twice.\nBranch: The branch never retries.\nProposed: Keep master's retry.");
});

test("review flagged: the review's words, Land Anyway and Send Back", () => {
  const r = queueRow(wt({ queue: q({ state: "review-flagged", review: { verdict: "blocking", text: "Leaves a TODO hack in land.ts.", commit: SHA, at: "" } }) }));
  assert.equal(r.action, "land-anyway");
  assert.equal(r.sendBack, true);
  assert.equal(r.reason, "Leaves a TODO hack in land.ts.");
});

test("needs a fix and drafts changed both ask for a new Land", () => {
  assert.equal(queueRow(wt({ queue: q({ state: "needs-fix", reason: "unit failed: a.test.ts", run: "mr_1" }) })).action, "land");
  const d = queueRow(wt({ queue: q({ state: "drafts-changed" }) }));
  assert.equal(d.label, "Drafts changed");
  assert.equal(d.action, "land");
});

test("landed: the sha it landed as and the merge thread's note", () => {
  const r = queueRow(
    wt({
      queue: q({
        state: "landed",
        landed: { sha: "b".repeat(40), from: SHA, at: "", pushed: "pushed" },
        notes: [{ kind: "thread", text: "Changes server code; restart Sova to pick it up.", at: "" }],
      }),
    }),
  );
  assert.equal(r.label, "Landed");
  assert.equal(r.detail, "as bbbbbbb");
  assert.deepEqual(r.notes, [{ label: "Merge thread", text: "Changes server code; restart Sova to pick it up." }]);
});

test("a cancelled entry reads as the worktree again", () => {
  assert.equal(queueRow(wt({ readiness: ready, queue: q({ state: "cancelled" }) })).key, "ready");
});

test("notes: the operator's replaces the thread's; the others follow", () => {
  const n = notesOf([
    { kind: "flaky", text: "unit passed on a rerun", at: "" },
    { kind: "thread", text: "old", at: "" },
    { kind: "operator", text: "mine", at: "" },
  ]);
  assert.deepEqual(n.map((x) => x.label), ["You", "Flaky"]);
});

test("the control: what needs you first, then a fix, then ready; hidden with none", () => {
  assert.equal(controlWords([]), null);
  assert.deepEqual(controlWords([{ key: "ready" }, { key: "ready" }, { key: "queued" }]), { text: "2 ready", n: 2, dot: "ok" });
  assert.deepEqual(controlWords([{ key: "ready" }, { key: "needs-fix" }]), { text: "1 needs a fix", n: 1, dot: "err" });
  assert.deepEqual(controlWords([{ key: "needs-fix" }, { key: "review-flagged" }]), { text: "1 needs you", n: 1, dot: "warn" });
  assert.deepEqual(controlWords([{ key: "landed" }, { key: "merged" }]), { text: "2 worktrees", n: 2, dot: null });
});

test("the summary counts in order", () => {
  assert.equal(rowsSummary([{ key: "landed" }, { key: "ready" }, { key: "ready" }, { key: "queued" }]), "2 ready · 1 queued · 1 landed");
});

test("tags, chips and the paused title", () => {
  assert.equal(sourceTag("picked")!.label, "Added by merge thread");
  assert.equal(sourceTag("trigger")!.label, "Triggered");
  assert.equal(queueStateChip({ state: "idle", checks: "unset" }).label, "Not set up");
  assert.equal(queueStateChip({ state: "paused", checks: "declared" }).label, "Paused");
  assert.equal(pausedTitle({ paused: { kind: "master-moved", why: "", at: "" } }), "Paused: the target moved outside the queue.");
  assert.equal(pausedTitle({ paused: { kind: "main-checkout-dirty", why: "", at: "" } }), "Paused: the project folder has uncommitted edits.");
  assert.equal(verdictChip({ verdict: "machine" }).label, "Setup failed · nobody blamed");
  assert.equal(pushedWords({ target: SHA, pushed: SHA }).label, "Pushed");
  assert.equal(pushedWords({ target: SHA, pushWhy: "held for a release" }).why, "held for a release");
  // Ahead of origin with no reason given still says so.
  assert.deepEqual(pushedWords({ target: SHA, pushed: "b".repeat(40) }), { label: "Not pushed", tone: "warn", why: "not pushed yet: goes out with the next landing" });
});

const step = (x: Partial<RunStep>): RunStep => ({ id: x.id ?? "s", kind: "check", label: "Unit", result: "pending", ms: 0, log: "", ...x });

test("progress counts checks only, and names the running one", () => {
  const p = runProgress({
    steps: [step({ kind: "copy", result: "passed" }), step({ id: "a", result: "passed" }), step({ id: "b", label: "Integration", result: "running" }), step({ id: "c" }), step({ id: "d", result: "skipped" })],
  });
  assert.deepEqual(p, { label: "Integration", index: 2, of: 3, done: 1 });
});

test("whose failure: a branch's (passes on master, fails again on the tip)", () => {
  const a = attribution({ verdict: "failed", blame: "branch", steps: [step({ kind: "rerun-tip", result: "failed" }), step({ kind: "rerun-master", result: "passed" })] } as MergeRun)!;
  assert.deepEqual(a.map((x) => x.result), ["ok", "ok", "failed"]);
  assert.equal(a[1]!.answer, "No: it passes on the target");
  assert.equal(attribution({ verdict: "passed", steps: [] } as unknown as MergeRun), null);
});

test("the onboarding's check list: Name: command per line, the rest named back", async () => {
  const { parseCheckList } = await import("./merge-queue");
  assert.deepEqual(parseCheckList("Typecheck: npm run typecheck\n\nUnit tests: npm test -- --ci\nbroken line\n: no name"), {
    checks: [
      { label: "Typecheck", command: "npm run typecheck" },
      { label: "Unit tests", command: "npm test -- --ci" },
    ],
    bad: [4, 5],
  });
});

test("row numbers: on live rows only; Land pins the head they were read at", async () => {
  const { sizeWords, shownCommit } = await import("./merge-queue");
  const stats = { ahead: 1, added: 5, removed: 0, head: "h0" };
  assert.equal(sizeWords(stats), "1 commit · +5 −0");
  assert.equal(queueRow(wt({ readiness: ready, mergeStats: stats })).size, "1 commit · +5 −0");
  assert.equal(queueRow(wt({ mergeStats: stats, queue: q({ state: "landed" }) })).size, undefined);
  assert.equal(shownCommit({ mergeStats: { ...stats, head: "h1" }, readiness: { ...ready, landing: { state: "ready", commit: "h2" } } }), "h1");
  assert.equal(shownCommit({ readiness: { ...ready, landing: { state: "ready", commit: "h2" } } }), "h2");
  assert.equal(shownCommit({}), undefined);
});

test("times and the waiting head", () => {
  assert.equal(clock(48_000), "0:48");
  assert.equal(clock(3_725_000), "1:02:05");
  assert.equal(mins(10), "1 min");
  assert.equal(waitingHead([{ eta: { startsInMs: 0, takesMs: 60_000 } }, { eta: { startsInMs: 60_000, takesMs: 120_000 } }] as Pick<MergeEntry, "eta">[]), "Waiting · 2 · the last one done in ~3 min");
});

test("a queue line as a sentence: capitalised and stopped once", async () => {
  const { sentence } = await import("./merge-queue");
  assert.equal(sentence("unit tests failed (passes on master alone)"), "Unit tests failed (passes on master alone).");
  assert.equal(sentence("Done."), "Done.");
  assert.equal(sentence(undefined), "");
});

test("an invalid definition is said as such: never Not set up; a row keeps Land (a fix can land), never Set Up", () => {
  const bad = '$.merge.checks[0].run[2]: a lone "$"';
  assert.deepEqual(queueStateChip({ state: "idle", checks: "unset", invalid: bad }), { label: "Definition invalid", tone: "error" });
  // A broken setup is still a setup: the repo is served (mergeServed), said, never bypassed.
  const r = queueRow(wt({ readiness: ready, mergeServed: true, mergeProject: { id: "prj_1", root: "/r", target: "main", checks: "unset", review: false, invalid: bad } }));
  assert.equal(r.action, "land");
  assert.equal(r.reason, `This project's .sova/project.json doesn't parse: ${bad}. Fix it on the target, or land a branch that fixes it; nothing else lands until it parses.`);
});

test("can't tell whose failure: its words, the queue's why, Land Anyway and Send Back; it needs you", () => {
  const r = queueRow(wt({ queue: q({ state: "unattributed", reason: "build failed with this branch and on master alone" }) }));
  assert.equal(r.label, "Can't tell whose failure");
  assert.equal(r.action, "land-anyway");
  assert.equal(r.sendBack, true);
  assert.equal(r.reason, "Build failed with this branch and on master alone.");
  assert.deepEqual(controlWords([{ key: "unattributed" }, { key: "ready" }]), { text: "1 needs you", n: 1, dot: "warn" });
  assert.equal(rowsSummary([{ key: "unattributed" }]), "1 can't tell whose failure");
});
