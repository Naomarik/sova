// The merge queue's words: one vocabulary for the composer control, its modal, the pane and the tab.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MergeEntry, MergeRun, RunStep, WorktreeQueueInfo } from "../../shared/merge-queue";
import type { WorktreeReadiness } from "../../shared/protocol";
import { landConfirmWords, readyFactsWords, rehearsalWhy, readyRowChip, type RowKey, type Tone, entryLandBlock, SENT_BACK_LINE, stillSentBack, rowButtons, attribution, clock, controlWords, mins, notesOf, pausedTitle, pushedWords, queueRow, queueStateChip, rowsSummary, runProgress, sourceTag, stepCounts, stepDetail, stepMark, stepTime, tildeIn, verdictChip, waitingHead, type QueueRowInput } from "./merge-queue";

const SHA = "a".repeat(40);
const wt = (x: Partial<QueueRowInput> = {}): QueueRowInput => ({ status: "active", exists: true, branch: "feat/x", readiness: undefined, ...x });
const q = (x: Partial<WorktreeQueueInfo>): WorktreeQueueInfo => ({ id: "me_1", state: "queued", commit: SHA, notes: [], project: "prj_1", ...x }) as WorktreeQueueInfo;
const ready = { path: "/w", branch: "feat/x", state: "ready" as const };

test("Ready only when truly Ready to land; real work says its true state and keeps Land", () => {
  const finished = queueRow(wt({ readiness: { ...ready, landing: { state: "ready", commit: SHA } }, mergeServed: true }));
  assert.deepEqual([finished.key, finished.label, finished.action], ["ready", "Ready", "land"]);
  const cases: [Partial<WorktreeReadiness>, RowKey, string, Tone][] = [
    [{ state: "ready" }, "ready-to-merge", "Ready to merge", "success"],
    [{ state: "waiting-approval" }, "waiting-ok", "Waiting for your OK", "success"],
    [{ state: "in-progress", conflicts: 17, reason: "Conflicts with master · 17 files" }, "conflicting", "Conflicts with master", "warn"],
    [{ state: "in-progress", reason: "In progress · working now" }, "in-progress", "In progress", "neutral"],
    [{ state: "blocked", reason: "Blocked · 2 open questions" }, "blocked", "Blocked", "warn"],
    [{ state: "ready", landing: { state: "specs", commit: SHA } }, "landing-specs", "Landing specs", "info"],
  ];
  for (const [reading, key, label, tone] of cases) {
    const r = queueRow(wt({ readiness: { ...ready, ...reading }, mergeServed: true }));
    assert.deepEqual([r.key, r.label, r.tone, r.action], [key, label, tone, "land"], label);
    assert.equal(r.reason, reading.reason);
    assert.notEqual(r.label, "Ready");
    // Only a truly ready row counts in "{n} ready".
    assert.notEqual(controlWords([r])!.text, "1 ready");
  }
  assert.equal(controlWords([finished])!.text, "1 ready");
});

test("no reading never reads Ready: it says so; it keeps Land only where the queue serves the repo", () => {
  const served = queueRow(wt({ readiness: undefined, mergeServed: true }));
  assert.deepEqual([served.key, served.label, served.tone, served.action], ["no-reading", "No reading", "neutral", "land"]);
  const plain = queueRow(wt({ readiness: undefined }));
  assert.deepEqual([plain.key, plain.action], ["no-reading", "none"]);
});

test("a repo the queue doesn't serve: real work says its true state and offers nothing", () => {
  const r = queueRow(wt({ readiness: { ...ready, state: "in-progress", conflicts: 2, reason: "Conflicts with main · 2 files" } }));
  assert.deepEqual([r.label, r.action], ["Conflicts with main", "none"]);
  assert.equal(queueRow(wt({ readiness: { ...ready, state: "blocked" } })).label, "Blocked");
});

test("Landed only while nothing is left: however old, a catch-up merge changes nothing, a real commit brings Land back", () => {
  const landed = q({ state: "landed", landed: { sha: SHA, at: "2026-01-01T00:00:00Z" } as WorktreeQueueInfo["landed"] });
  // Nothing left, with the entry in the window or out of it.
  const reading = { ...ready, state: "merged" as const, merged: true as const, left: "nothing" as const };
  const inWindow = queueRow(wt({ readiness: reading, queue: landed, mergeServed: true }));
  assert.deepEqual([inWindow.key, inWindow.label, inWindow.action, inWindow.newer], ["landed", "Landed", "none", undefined]);
  const outOfWindow = queueRow(wt({ readiness: reading, mergeServed: true }));
  assert.deepEqual([outOfWindow.key, outOfWindow.action], ["merged", "none"]);
  // A branch whose reading says nothing left, though the reading's own state hasn't caught up (a turn running).
  assert.equal(queueRow(wt({ readiness: { ...ready, state: "in-progress", left: "nothing" }, mergeServed: true })).key, "merged");
  // A real new commit: its own reading, Land, and the line saying what the landing left out.
  const again = queueRow(wt({ readiness: { ...ready, landing: { state: "ready", commit: "b".repeat(40) } }, queue: { ...landed, newerCommits: 1 }, mergeServed: true }));
  assert.deepEqual([again.key, again.label, again.action, again.newer], ["ready", "Ready", "land", "1 newer commit not included"]);
  const conflict = queueRow(wt({ readiness: { ...ready, state: "in-progress", conflicts: 1, reason: "Conflicts with master · 1 file" }, queue: { ...landed, newerCommits: 2 }, mergeServed: true }));
  assert.deepEqual([conflict.key, conflict.action, conflict.newer], ["conflicting", "land", "2 newer commits not included"]);
  // An entry with no reading of the branch (the Overseer's row): it did land; real commits past it keep Land.
  assert.deepEqual(((x) => [x.key, x.action, x.newer])(queueRow(wt({ queue: { ...landed, newerCommits: 1 }, mergeServed: true }))), ["landed", "land", "1 newer commit not included"]);
  assert.deepEqual(((x) => [x.key, x.action])(queueRow(wt({ queue: landed, mergeServed: true }))), ["landed", "none"]);
});

test("after retirement: Landed · cleaned up, with no Land; one with no commits reads Removed", () => {
  const landed = q({ state: "landed", landed: { sha: SHA, at: "2026-01-01T00:00:00Z" } as WorktreeQueueInfo["landed"], newerCommits: 3 });
  for (const w of [wt({ exists: false, gone: "merged", queue: landed, mergeServed: true }), wt({ exists: false, gone: "merged", mergeServed: true }), wt({ exists: false, readiness: { ...ready, state: "merged", merged: true, reason: "Landed · cleaned up" }, mergeServed: true })]) {
    const r = queueRow(w);
    assert.deepEqual([r.key, r.label, r.action, r.newer], ["cleaned-up", "Landed · cleaned up", "none", undefined]);
    assert.deepEqual(rowButtons(r, "prj_1"), []);
  }
  const empty = queueRow(wt({ exists: false, gone: "empty", readiness: { ...ready, state: "removed", reason: "Removed · no commits" } }));
  assert.deepEqual([empty.key, empty.label], ["removed", "Removed"]);
});

test("only drafts left: Drafts to land, with Land, even once git reads it merged or an entry says Landed", () => {
  const reading = { ...ready, state: "merged" as const, merged: true as const, left: "drafts" as const, draftsLeft: 2 };
  for (const x of [{}, { queue: q({ state: "landed" }) }, { mergedInto: { target: "master", sha: SHA } }]) {
    const r = queueRow(wt({ readiness: reading, mergeServed: true, ...x }));
    assert.deepEqual([r.key, r.label, r.tone, r.action], ["drafts-to-land", "Drafts to land", "info", "land"]);
    assert.equal(r.reason, "Code landed · 2 spec drafts not landed");
  }
  assert.equal(queueRow(wt({ readiness: { ...reading, draftsLeft: 1 }, mergeServed: true })).reason, "Code landed · 1 spec draft not landed");
  // A session list row carries the answer itself.
  assert.equal(queueRow(wt({ left: "drafts", draftsLeft: 1, mergeServed: true })).key, "drafts-to-land");
  assert.equal(queueRow(wt({ left: "nothing", mergeServed: true })).key, "merged");
  // A branch that never had a commit reads that, never Landed or Merged.
  assert.equal(queueRow(wt({ readiness: { ...ready, noCommits: true, left: "nothing" }, mergeServed: true })).key, "no-commits");
});

test("Land's confirm: only drafts left says the drafts, not commits", () => {
  assert.deepEqual(landConfirmWords("feat/x", 0, "master", undefined, undefined, 2), { title: "Land feat/x?", line: "2 spec drafts go to the merge queue; master moves once checks pass.", confirm: "Land 2 Drafts" });
  assert.equal(landConfirmWords("feat/x", 1, "master", undefined, undefined, 1).confirm, "Land 1 Draft");
  assert.equal(landConfirmWords("feat/x", 1, "master", undefined, undefined, 1).line, "1 spec draft goes to the merge queue; master moves once checks pass.");
  assert.equal(landConfirmWords("feat/x", 3, "master").confirm, "Land 3 Commits");
});

test("the tab's row with only drafts left says the drafts where the commits would be", () => {
  assert.equal(readyFactsWords({ ahead: 1, draftsOnly: 2 }), "2 spec drafts");
  assert.equal(readyFactsWords({ ahead: 1, draftsOnly: 1 }), "1 spec draft");
  assert.equal(readyRowChip({ branch: "feat/x", worktree: "/w", draftsOnly: 2 }, undefined).label, "Drafts to land");
});

test("every row state a branch can read, and whether it offers Land", () => {
  const landing = (state: "ready" | "specs") => ({ state, commit: SHA });
  const cases: [string, Partial<QueueRowInput>, RowKey, boolean][] = [
    ["truly ready", { readiness: { ...ready, landing: landing("ready") } }, "ready", true],
    ["ready to merge", { readiness: ready }, "ready-to-merge", true],
    ["its specs don't fit", { readiness: { ...ready, landing: landing("specs") } }, "landing-specs", true],
    ["no reading", {}, "no-reading", true],
    ["Git can't read it: an unknown answer keeps Land", { readiness: { ...ready, state: "in-progress", reason: "Git can't read this worktree" } }, "in-progress", true],
    ["drafts only", { readiness: { ...ready, state: "merged", merged: true, left: "drafts", draftsLeft: 1 } }, "drafts-to-land", true],
    ["uncommitted", { readiness: { ...ready, state: "in-progress", dirtyCount: 3 } }, "uncommitted", false],
    ["no commits", { readiness: { ...ready, state: "in-progress", noCommits: true, left: "nothing" } }, "no-commits", false],
    ["stale", { readiness: { ...ready, state: "stale", merged: true, left: "nothing" } }, "stale", false],
    ["nothing left, no entry", { readiness: { ...ready, state: "merged", merged: true, left: "nothing" } }, "merged", false],
    ["folder with no working branch, work landed", { exists: true, gone: "merged", readiness: { ...ready, state: "merged", merged: true, reason: "Landed · cleaned up" } }, "cleaned-up", false],
    ["folder gone, not merged", { exists: false, gone: "unmerged" }, "removed", false],
  ];
  for (const [name, x, key, land] of cases) {
    const r = queueRow(wt({ mergeServed: true, ...x }));
    assert.equal(r.key, key, name);
    assert.equal(rowButtons(r, "prj_1").includes("Land"), land, name);
  }
});

test("a landed entry whose branch has real work, or an unknown answer, reads the branch and keeps Land", () => {
  const landed = q({ state: "landed", landed: { sha: SHA, at: "2026-01-01T00:00:00Z" } as WorktreeQueueInfo["landed"] });
  const unknown = queueRow(wt({ readiness: { ...ready, state: "in-progress", reason: "Git can't read this worktree" }, queue: landed, mergeServed: true }));
  assert.deepEqual([unknown.key, unknown.action], ["in-progress", "land"]);
  assert.equal(unknown.reason, "Git can't read this worktree");
});

test("a repo the queue doesn't serve: a ready branch counts as ready and reads Ready to merge, with no Land", () => {
  const r = queueRow(wt({ readiness: ready }));
  assert.deepEqual([r.key, r.label, r.action], ["ready", "Ready to merge", "none"]);
  assert.equal(controlWords([r])!.text, "1 ready");
});

test("only drafts left: the row shows the drafts, never the commits' size", () => {
  const r = queueRow(wt({ readiness: { ...ready, state: "merged", merged: true, left: "drafts", draftsLeft: 2 }, mergeServed: true, mergeStats: { ahead: 1, added: 0, removed: 0 } as never }));
  assert.equal(r.size, undefined);
  assert.equal(r.reason, "Code landed · 2 spec drafts not landed");
});

test("Ready list: a chat's lagging Merged is never said on a row with something left", () => {
  const chip = readyRowChip({ branch: "feat/x", worktree: "/w", session: "s1" }, [{ ...ready, state: "merged", merged: true }] as never);
  assert.deepEqual([chip.label, chip.tone], ["No reading", "neutral"]);
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
    const r = queueRow(wt({ readiness: { ...ready, landing: { state: "ready", commit: SHA } }, place: { target: "main" }, ...x }));
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

test("queued: its place, its estimates, Remove from Queue; a newer commit is said", () => {
  const r = queueRow(wt({ queue: q({ state: "queued", position: 2, eta: { startsInMs: 4 * 60_000, takesMs: 9 * 60_000 }, newerCommits: 1 }) }));
  assert.equal(r.label, "Queued · 2nd");
  assert.equal(r.detail, "starts in ~4 min · takes ~9 min");
  assert.deepEqual(rowButtons(r, "prj_1"), ["Remove from Queue"]);
  assert.equal(r.newer, "1 newer commit not included");
});

test("checking pulses and has no action", () => {
  const r = queueRow(wt({ queue: q({ state: "checking" }) }));
  assert.equal(r.label, "Checking");
  assert.equal(r.live, true);
  assert.equal(r.action, "none");
});

test("behaviour differs: both sides in words, Accept (a proposal), Answer in Chat and Remove from Queue; no Send Back", () => {
  const r = queueRow(
    wt({ queue: q({ state: "behaviour-differs", conflict: { files: ["a.ts"], verdict: "behaviour-differs", ours: "Master retries twice.", theirs: "The branch never retries.", proposal: "Keep master's retry.", at: "" } }) }),
  );
  assert.equal(r.label, "Behaviour differs");
  assert.equal(r.action, "accept");
  assert.deepEqual(rowButtons(r, "prj_1"), ["Accept", "Answer in Chat", "Remove from Queue"]);
  assert.equal(r.reason, "Target: Master retries twice.\nBranch: The branch never retries.\nProposed: Keep master's retry.");
});

test("review flagged: the review's words; it goes back to the chat by itself, so only Remove from Queue", () => {
  const r = queueRow(wt({ queue: q({ state: "review-flagged", review: { verdict: "blocking", text: "Leaves a TODO hack in land.ts.", commit: SHA, at: "" } }) }));
  assert.equal(r.action, "none");
  assert.deepEqual(rowButtons(r, "prj_1"), ["Remove from Queue"]);
  assert.equal(r.reason, "Leaves a TODO hack in land.ts.");
});

test("drafts changed asks for a new Land; needs a fix offers only Remove from Queue, never Land or a re-land (al_3)", () => {
  const nf = queueRow(wt({ queue: q({ state: "needs-fix", reason: "unit failed: a.test.ts", run: "mr_1" }) }));
  assert.equal(nf.action, "none");
  assert.deepEqual(rowButtons(nf, "prj_1"), ["Remove from Queue"]);
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
  assert.deepEqual(controlWords([{ key: "needs-fix" }, { key: "review-flagged" }]), { text: "2 need a fix", n: 2, dot: "err" }, "review findings go back to the chat by themselves");
  assert.deepEqual(controlWords([{ key: "needs-fix" }, { key: "with-chat" }, { key: "needs-you" }]), { text: "1 needs you", n: 1, dot: "warn" });
  assert.deepEqual(controlWords([{ key: "with-chat" }, { key: "ready" }]), { text: "1 needs a fix", n: 1, dot: "err" }, "back with the chat: its chat fixes it");
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

test("the strip says No remote only for a project with no origin", () => {
  // A fresh queue record on a project whose master matches origin: the view filled `pushed` from origin.
  assert.equal(pushedWords({ target: SHA, pushed: SHA, hasOrigin: true }).label, "Pushed");
  assert.equal(pushedWords({ target: SHA, hasOrigin: false }).label, "No remote");
  // An origin without the target branch: not pushed yet, never No remote.
  assert.equal(pushedWords({ target: SHA, hasOrigin: true }).label, "Not pushed");
  // A stray `pushed` on a project with no origin can't read Pushed.
  assert.equal(pushedWords({ target: SHA, pushed: SHA, hasOrigin: false }).label, "No remote");
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

test("not set up: unserved, or checks unset; an invalid definition is a setup, said as such", async () => {
  const { notSetUp } = await import("./merge-queue");
  assert.equal(notSetUp({ served: false, checks: "declared" }), true);
  assert.equal(notSetUp({ served: true, checks: "unset" }), true);
  assert.equal(notSetUp({ served: true, checks: "declared" }), false);
  assert.equal(notSetUp({ served: false, checks: "unset", invalid: "bad json" }), false);
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

test("can't tell whose failure: its words, the queue's why, Land Anyway, Try Again and Remove from Queue; it needs you", () => {
  const r = queueRow(wt({ queue: q({ state: "unattributed", reason: "build failed with this branch and on master alone" }) }));
  assert.equal(r.label, "Can't tell whose failure");
  assert.equal(r.action, "land-anyway");
  assert.deepEqual(rowButtons(r, "prj_1"), ["Land Anyway", "Try Again", "Remove from Queue"]);
  assert.equal(r.reason, "Build failed with this branch and on master alone.");
  assert.deepEqual(controlWords([{ key: "unattributed" }, { key: "ready" }]), { text: "1 needs you", n: 1, dot: "warn" });
  assert.equal(rowsSummary([{ key: "unattributed" }]), "1 can't tell whose failure");
});

// ---- the run page's Checks and why ----

const runStep = (x: Partial<RunStep>): RunStep => ({ id: "check:unit", kind: "check", label: "Unit tests", result: "passed", ms: 75_000, log: "check-unit.log", ...x });

test("a step's time: a finished one shows what it took; a running one counts up from its start; waiting and skipped show none", () => {
  const now = Date.parse("2026-11-03T10:01:42Z");
  assert.equal(stepTime(runStep({}), now), "1:15");
  assert.equal(stepTime(runStep({ result: "failed", ms: 57_000 }), now), "0:57");
  assert.equal(stepTime(runStep({ result: "running", ms: 0, startedAt: "2026-11-03T10:00:00Z" }), now), "1:42", "not 0:00");
  assert.equal(stepTime(runStep({ result: "running", ms: 0 }), now), "", "no start known: no made-up time");
  assert.equal(stepTime(runStep({ result: "pending", ms: 0 }), now), "");
  assert.equal(stepTime(runStep({ result: "skipped", ms: 3 }), now), "");
});

test("a check's counts go with its description: none on a skipped check, none when every count is zero; a failed count is marked", () => {
  assert.deepEqual(stepCounts(runStep({ counts: { passed: 11496, failed: 0, skipped: 5 } })), [{ text: "11496 passed" }, { text: "5 skipped" }]);
  assert.deepEqual(stepCounts(runStep({ result: "failed", counts: { passed: 10, failed: 2, skipped: null } })), [{ text: "10 passed" }, { text: "2 failed", failed: true }]);
  assert.deepEqual(stepCounts(runStep({ result: "skipped", counts: { passed: 0, failed: 0, skipped: 0 } })), [], "no stray '0 passed'");
  assert.deepEqual(stepCounts(runStep({ counts: { passed: 0, failed: null, skipped: null } })), []);
  assert.deepEqual(stepCounts(runStep({ counts: null })), []);
});

test("status marks: nothing that looks like it expands; skipped and unchanged setup get a dash, waiting an empty ring", () => {
  assert.equal(stepMark(runStep({ result: "passed" })).icon, "check");
  assert.equal(stepMark(runStep({ result: "failed" })).icon, "close");
  assert.equal(stepMark(runStep({ result: "running" })).icon, "clock");
  assert.equal(stepMark(runStep({ result: "skipped", kind: "setup", detail: "unchanged since the last run" })).icon, "minus");
  assert.deepEqual(stepMark(runStep({ result: "pending" })), { icon: null, cls: "mq-wait", word: "Waiting" });
  for (const r of ["passed", "failed", "running", "pending", "skipped"] as const) assert.notEqual(stepMark(runStep({ result: r })).icon, "chevron-right");
});

test("a step's detail: the home folder shortened, the copy's folder and commits in mono, anything else plain", () => {
  const home = "/home/me";
  assert.deepEqual(stepDetail(runStep({ id: "copy", kind: "copy", detail: "/home/me/webapps/.worktrees/x-merge at 0123abc" }), home), [{ text: "~/webapps/.worktrees/x-merge", mono: true }, { text: " at " }, { text: "0123abc", mono: true }]);
  assert.deepEqual(stepDetail(runStep({ id: "merge", kind: "merge", detail: "89abcde" }), home), [{ text: "89abcde", mono: true }]);
  assert.deepEqual(stepDetail(runStep({ result: "failed", detail: "exit 1: added /home/me/a.ts" }), home), [{ text: "exit 1: added ~/a.ts" }], "free text stays one plain part");
  assert.deepEqual(stepDetail(runStep({ detail: undefined }), home), []);
  assert.equal(tildeIn("/home/me2/x and /home/me/y", home), "/home/me2/x and ~/y", "only the home folder itself");
  assert.equal(tildeIn("/mnt/home/me/x", home), "/mnt/home/me/x", "a home path inside another path stays");
  assert.equal(tildeIn("copy /mnt/home/me/x to /home/me/x", home), "copy /mnt/home/me/x to ~/x");
  assert.equal(tildeIn("/home/me", home), "~", "the bare home folder, alone");
  assert.equal(tildeIn("cd /home/me && ls", home), "cd ~ && ls", "the bare home folder before a space");
  assert.equal(tildeIn("/home/me.bak/x", home), "/home/me.bak/x", "a sibling folder stays");
  assert.equal(tildeIn(`at "/home/me/a" (/home/me/b) cwd=/home/me/c PATH=/bin:/home/me/d, /home/me/e`, home), `at "~/a" (~/b) cwd=~/c PATH=/bin:~/d, ~/e`, "after a quote, bracket, =, : or comma");
  assert.equal(tildeIn("/home/me/x/home/me/y", home), "~/x/home/me/y", "only where a path starts");
  assert.equal(tildeIn("/home/me/x", "/home/me/"), "~/x", "a trailing slash on home is ignored");
  assert.equal(tildeIn("/a+b/x", "/a+b"), "~/x", "regex characters in home are literal");
  assert.equal(tildeIn("/aab/x", "/a+b"), "/aab/x");
});

// al_4: no Land at all while a sent-back branch is being fixed; the fixed, finished commit brings Land back.
const NEW = "b".repeat(40);
const sentBack = (x: Partial<QueueRowInput> = {}) =>
  wt({ mergeServed: true, mergeProject: { id: "prj_1", root: "/r", target: "main", checks: "declared", review: true }, queue: q({ state: "needs-fix", run: "mr_1" }), ...x });

test("a needs-fix row at its sent-back commit has no Land anywhere: no Land button, so no ▾ menu either", () => {
  for (const readiness of [undefined, { ...ready, state: "in-progress" as const, dirtyCount: 2 }, { ...ready, landing: { state: "ready" as const, commit: SHA } }]) {
    const r = queueRow(sentBack({ readiness }));
    assert.equal(r.key, "needs-fix");
    assert.equal(r.label, "Needs a fix");
    assert.equal(r.action, "none");
    assert.deepEqual(rowButtons(r, "prj_1"), ["Remove from Queue"], "no Land split (and so no ▾ menu), no re-land: the user's Land stands");
  }
  assert.equal(queueRow(sentBack()).reason, SENT_BACK_LINE);
  assert.equal(queueRow(sentBack({ queue: q({ state: "needs-fix", reason: "unit failed: a.test.ts" }) })).reason, "unit failed: a.test.ts", "the queue's reason, as today");
});

test("the same branch after a new commit, finished, reads Ready with Land", () => {
  const r = queueRow(sentBack({ readiness: { ...ready, landing: { state: "ready", commit: NEW } } }));
  assert.equal(r.key, "ready");
  assert.equal(r.label, "Ready");
  assert.equal(r.action, "land");
  assert.deepEqual(rowButtons(r, "prj_1"), ["Land"]);
  assert.equal(r.detail, NEW.slice(0, 7), "Land pins the new commit");
});

test("the tab's Sent back list drops an entry whose branch reads ready at a newer commit", () => {
  const e = { id: "me_1", branch: "feat/x", commit: SHA, state: "needs-fix" } as MergeEntry;
  const at = (commit: string) => ({ needsFix: [e], ready: [{ branch: "feat/x", commit } as never] });
  assert.deepEqual(stillSentBack({ needsFix: [e] }), [e]);
  assert.deepEqual(stillSentBack(at(SHA)), [e], "the sent-back commit itself: still sent back");
  assert.deepEqual(stillSentBack(at(NEW)), [], "fixed: the Ready to land row stands for it");
});

test("the Overseer's Land item (entry only, no readiness): off while sent back, off in line, on for drafts changed", () => {
  assert.equal(entryLandBlock(undefined), undefined);
  assert.equal(entryLandBlock({ state: "needs-fix" }), SENT_BACK_LINE);
  for (const state of ["queued", "checking", "conflict", "behaviour-differs", "review-flagged"] as const) assert.equal(entryLandBlock({ state }), "Already in the merge queue.", state);
  assert.equal(entryLandBlock({ state: "drafts-changed" }), undefined, "Land is how it's re-approved");
  assert.equal(entryLandBlock({ state: "landed" }), undefined);
  assert.equal(entryLandBlock({ state: "cancelled" }), undefined);
});

test("the tab's Sent back list shows only entries that still need a fix: settled ones leave, the cap counts current ones", () => {
  const fix = (id: string, settled?: MergeEntry["settled"]) => ({ id, branch: `feat/${id}`, commit: SHA, state: "needs-fix", ...(settled ? { settled } : {}) }) as MergeEntry;
  const current = fix("cur");
  for (const settled of ["superseded", "merged", "gone"] as const) assert.deepEqual(stillSentBack({ needsFix: [fix(settled, settled), current] }), [current], settled);
  const many = Array.from({ length: 25 }, (_, i) => fix(`c${i}`));
  const shown = stillSentBack({ needsFix: [fix("s1", "merged"), fix("s2", "gone"), ...many] });
  assert.equal(shown.length, 20);
  assert.ok(shown.every((e) => !e.settled));
});

test("a merged or removed worktree wins over Needs a fix", () => {
  const sent = q({ state: "needs-fix", commit: SHA });
  assert.equal(queueRow(wt({ queue: sent, mergeServed: true })).key, "needs-fix", "still current");
  assert.equal(queueRow(wt({ queue: sent, status: "merged" })).key, "merged");
  assert.equal(queueRow(wt({ queue: sent, mergedInto: { target: "master", sha: SHA } } as never)).key, "merged");
  assert.equal(queueRow(wt({ queue: sent, exists: false })).key, "removed");
  assert.equal(queueRow(wt({ queue: sent, gone: "unknown" } as never)).key, "removed");
});

test("a sent-back entry superseded by a later cancelled one no longer reads Needs a fix on its worktree row", async () => {
  const { buildView, worktreeQueueInfo } = await import("../../server/merge-queue/view");
  const base = { project: "p", target: "master", branch: "feat/x", commit: SHA, approval: { by: "land-button", at: "t", commit: SHA }, runs: [], picks: [], notes: [] };
  const a = { ...base, id: "mq_a", seq: 1, state: "needs-fix", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-03T00:00:00Z" };
  const b = { ...base, id: "mq_b", seq: 2, state: "cancelled", createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" };
  const q = { v: 1, project: "p", root: "/r", target: "master", entries: [a, b], landed: [], heads: {}, machineTries: {}, seq: 2 } as never;
  const v = buildView({ q, root: "/r", current: null, checks: "declared", review: false, head: "h", takesMs: null, now: 0, readRun: () => null });
  const info = worktreeQueueInfo(v, "feat/x");
  assert.equal(info?.id, "mq_a", "the cancelled entry isn't in the view: the old one is what the row sees");
  assert.equal(info?.settled, "superseded");
  assert.notEqual(queueRow(wt({ queue: info, mergeServed: true })).key, "needs-fix");
  assert.equal(queueRow(wt({ queue: { ...info!, settled: undefined }, mergeServed: true })).key, "needs-fix", "unsettled, it still would");
});

test("a live row's size carries when the branch last changed; a landed or merged row has no date", async () => {
  const { headWhen } = await import("./merge-queue");
  const at = new Date(Date.now() - 2 * 24 * 3600_000).toISOString();
  const stats = { head: SHA, ahead: 3, added: 40, removed: 2, headAt: at };
  for (const x of [wt({ readiness: ready, mergeServed: true, mergeStats: stats }), wt({ readiness: { ...ready, state: "in-progress", dirtyCount: 1 }, mergeStats: stats }), wt({ queue: q({ state: "checking" }), mergeStats: stats }), wt({ queue: q({ state: "needs-fix" }), mergeStats: stats })]) {
    const r = queueRow(x);
    assert.equal(r.size, "3 commits · +40 −2", r.key);
    assert.deepEqual(r.when, headWhen(at), r.key);
    assert.equal(r.when?.text, "2d ago");
    assert.equal(r.when?.iso, at);
  }
  for (const x of [wt({ queue: q({ state: "landed" }), mergeStats: stats }), wt({ status: "merged", mergeStats: stats }), wt({ exists: false, mergeStats: stats })]) {
    const r = queueRow(x);
    assert.equal(r.when, undefined, r.key);
    assert.equal(r.size, undefined, r.key);
  }
  // No date read: the size alone.
  assert.equal(queueRow(wt({ readiness: ready, mergeServed: true, mergeStats: { head: SHA, ahead: 1, added: 1, removed: 0 } })).when, undefined);
});

test("the date reads relative, then a date past a week; in full for hover and screen readers", async () => {
  const { headWhen } = await import("./merge-queue");
  const now = Date.parse("2026-11-05T15:00:00");
  assert.equal(headWhen(new Date(now - 2 * 3600_000).toISOString(), now)?.text, "2h ago");
  assert.equal(headWhen(new Date(now - 24 * 3600_000).toISOString(), now)?.text, "yesterday");
  assert.equal(headWhen(new Date(now - 3 * 24 * 3600_000).toISOString(), now)?.text, "3d ago");
  const old = headWhen("2026-10-02T13:43:00", now)!;
  assert.equal(old.text, "Oct 2");
  assert.equal(old.full, "Oct 2, 2026, 1:43 PM");
  assert.equal(headWhen(undefined, now), undefined);
  assert.equal(headWhen("not a date", now), undefined);
});

test("a Ready row's facts: commits ahead, lines, the date apart", async () => {
  const { readyFactsWords } = await import("./merge-queue");
  assert.equal(readyFactsWords({ ahead: 3, added: 1497, removed: 309 }), "3 commits ahead · +1497 −309");
  assert.equal(readyFactsWords({ ahead: 1 }), "1 commit ahead");
});

test("a Ready row's chip is its chat's readiness reading, in the Worktrees rows' words; no chat says so", async () => {
  const { readyRowChip, chatTreesOf } = await import("./merge-queue");
  const { readinessChip } = await import("./worktrees");
  const r = { branch: "feat/x", worktree: "/w", commit: SHA };
  assert.deepEqual(readyRowChip(r, undefined), { label: "No chat", tone: "neutral", title: "No chat works on this branch: nothing reads it as finished or not." });
  assert.equal(readyRowChip({ ...r, session: "s1" }, []).label, "No reading");
  const tree = (x: object) => [{ path: "/w", branch: "feat/x", state: "ready" as const, ...x }];
  const landing = tree({ landing: { state: "ready", commit: SHA } });
  // Every state the Worktrees readiness chip has: the same label and tone.
  for (const t of [landing, tree({}), tree({ state: "in-progress" }), tree({ state: "waiting-approval" }), tree({ state: "blocked" }), tree({ landing: { state: "specs", commit: SHA, drafts: ["d"] } })]) {
    const want = readinessChip({ readiness: t[0] as never })!;
    const got = readyRowChip({ ...r, session: "s1" }, t as never);
    assert.deepEqual([got.label, got.tone], [want.label, want.tone]);
  }
  assert.equal(readyRowChip({ ...r, session: "s1" }, landing as never).label, "Ready to land");
  assert.equal(readyRowChip({ ...r, session: "s1" }, tree({ state: "in-progress" }) as never).label, "In progress");
  const conflict = readyRowChip({ ...r, session: "s1" }, tree({ state: "in-progress", why: "conflicts with master: 2 files", reason: "Conflicts with master · 2 files", conflicts: 2 }) as never);
  assert.deepEqual([conflict.label, conflict.tone], ["Conflicts with master", "warn"]);
  // Matched by its worktree, else its branch; a worker's chat reads its top chat's readings too.
  const sessions = [
    { id: "top", path: "/s/top.jsonl", readiness: { trees: [{ path: "/w", branch: "feat/x", state: "waiting-approval" }], since: 0 } },
    { id: "wk", path: "/s/wk.jsonl", workerSession: true, workerOf: { id: "top", path: "/s/top.jsonl" } },
  ] as never;
  assert.equal(readyRowChip({ ...r, session: "wk" }, chatTreesOf("wk", sessions)).label, "Waiting for your OK");
  assert.equal(chatTreesOf("nobody", sessions), undefined);
});

test("Remove Worktree only where the server offers it, with no rule of the row's own", () => {
  const nothing = { ...ready, state: "merged" as const, merged: true as const, left: "nothing" as const };
  assert.deepEqual(rowButtons(queueRow(wt({ readiness: { ...nothing, removable: true }, mergeServed: true })), "prj_1"), ["Remove Worktree"]);
  assert.deepEqual(rowButtons(queueRow(wt({ removable: true, left: "nothing" })), undefined), ["Remove Worktree"]);
  // Nothing left and finished, with no field: the real install and test servers never show it.
  for (const w of [wt({ readiness: nothing, mergeServed: true }), wt({ readiness: { ...ready, landing: { state: "ready", commit: SHA } }, mergeServed: true }), wt({ exists: false, gone: "merged" })]) assert.equal(rowButtons(queueRow(w), "prj_1").includes("Remove Worktree"), false);
});

test("a row says when Remove Worktree keeps the branch, only as the server says", () => {
  assert.equal(queueRow(wt({ readiness: { ...ready, removeKeepsBranch: true } })).removeKeepsBranch, true);
  assert.equal(queueRow(wt({ removeKeepsBranch: true })).removeKeepsBranch, true);
  assert.equal(queueRow(wt({ readiness: ready })).removeKeepsBranch, undefined);
});

test("Rehearsal needed says what Land waits for, at the branch's short commit", () => {
  assert.equal(rehearsalWhy("a1b2c3d4e5f6"), "This branch changes automatic cleanup. Land opens once a rehearsal has passed at a1b2c3d on a copy of your state taken today.");
  assert.match(rehearsalWhy(undefined), /passed at its newest commit on a copy/);
});
