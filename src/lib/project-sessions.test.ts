import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueueRow } from "./merge-queue";
import {
  branchLines,
  branchStateOf,
  type BranchState,
  GROUP_ORDER,
  groupCount,
  groupSessions,
  OLD_DAYS,
  recordedBranchState,
  rowLand,
  sessionBranches,
  sessionGroup,
  startedWords,
  shownBranches,
  type BranchStage,
  type SessionFacts,
  type SessionGroupKey,
} from "./project-sessions";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-16T12:00:00Z");
const ON_ITS_WAY: BranchStage[] = ["ready", "in-line", "checking", "stuck"];

/** Each group's condition as the Sessions tab promises it; a session lists in the first one that holds. */
const HOLDS: Record<SessionGroupKey, (f: SessionFacts) => boolean> = {
  "needs-you": (f) => f.needsYou,
  working: (f) => f.working,
  ready: (f) => f.stages.some((s) => ON_ITS_WAY.includes(s)),
  // Finished: it has a branch and none is still live (each landed, or done: removed, missing, already in its target).
  landed: (f) => f.stages.length > 0 && f.stages.every((s) => s === "landed" || s === "done"),
  old: (f) => f.lastActive > 0 && NOW - f.lastActive >= OLD_DAYS * DAY,
  idle: () => true,
};

// Every combination of the facts at their edges: the stage lists cover none, all landed, landed beside not landed,
// each stage on its way alone and beside a landed or done one, done alone and beside landed or a live branch; the times
// cover unknown, just under and exactly OLD_DAYS.
const STAGE_LISTS: BranchStage[][] = [
  [], ["landed"], ["landed", "landed"], ["landed", "other"], ["other"], ["done"], ["done", "landed"], ["done", "other"],
  ...ON_ITS_WAY.map((s) => [s]), ...ON_ITS_WAY.map((s) => ["landed", s] as BranchStage[]), ...ON_ITS_WAY.map((s) => ["done", s] as BranchStage[]),
];
const TIMES = [0, NOW, NOW - OLD_DAYS * DAY + 1, NOW - OLD_DAYS * DAY, NOW - 30 * DAY];
const ALL: SessionFacts[] = [];
for (const needsYou of [false, true]) for (const working of [false, true]) for (const stages of STAGE_LISTS) for (const lastActive of TIMES) ALL.push({ needsYou, working, stages, lastActive });

test("a session lists in the first group, in the list's order, whose condition holds", () => {
  assert.deepEqual(GROUP_ORDER, ["needs-you", "working", "ready", "idle", "old", "landed"]);
  // The precedence differs from the display order: Landed beats Old and Idle, Old beats Idle.
  const order: SessionGroupKey[] = ["needs-you", "working", "ready", "landed", "old", "idle"];
  const expected = (f: SessionFacts) => order.find((k) => HOLDS[k](f))!;
  assert.equal(ALL.filter((f) => sessionGroup(f, NOW) !== expected(f)).length, 0);
  // The check catches a grouping that lets working beat Needs you.
  const broken = (f: SessionFacts, now: number) => (f.working ? "working" : sessionGroup(f, now));
  assert.ok(ALL.filter((f) => broken(f, NOW) !== expected(f)).length > 0);
});

test("Old starts at exactly OLD_DAYS without activity; an unknown time is never old", () => {
  const f = (lastActive: number): SessionFacts => ({ needsYou: false, working: false, stages: [], lastActive });
  assert.equal(sessionGroup(f(NOW - OLD_DAYS * DAY), NOW), "old");
  assert.equal(sessionGroup(f(NOW - OLD_DAYS * DAY + 1), NOW), "idle");
  assert.equal(sessionGroup(f(0), NOW), "idle");
});

test("groups come in the list's order, empty ones left out; Ready to land by stage then place, the rest newest first", () => {
  type S = { id: string } & SessionFacts & { position?: number };
  const s = (id: string, over: Partial<S>): S => ({ id, needsYou: false, working: false, stages: [], lastActive: NOW, ...over });
  const items = [
    s("stuck", { stages: ["stuck"], lastActive: NOW }),
    s("line2", { stages: ["in-line"], position: 2, lastActive: NOW }),
    s("line1", { stages: ["in-line"], position: 1, lastActive: NOW - DAY }),
    s("ready", { stages: ["ready"], lastActive: NOW - 2 * DAY }),
    s("checking", { stages: ["checking"], lastActive: NOW - 3 * DAY }),
    s("idle-old", { lastActive: NOW - 3 * DAY }),
    s("idle-new", { lastActive: NOW - DAY }),
    s("work", { working: true }),
  ];
  const g = groupSessions(items, (x) => x, NOW);
  assert.deepEqual(
    g.map((x) => [x.key, x.items.map((i) => i.id)]),
    [
      ["working", ["work"]],
      ["ready", ["ready", "checking", "line1", "line2", "stuck"]],
      ["idle", ["idle-new", "idle-old"]],
    ],
  );
});

test("Ready to land's count names each session once, by its best stage", () => {
  assert.equal(groupCount("ready", [["ready"], ["in-line"], ["in-line", "stuck"], ["stuck"], ["stuck", "other"]]), "1 ready · 2 in line · 2 stuck");
  assert.equal(groupCount("idle", [[]]), "1 session");
});

const qrow = (key: QueueRow["key"], over: Partial<QueueRow> = {}): QueueRow => ({ key, label: `label of ${key}`, tone: "neutral", notes: [], action: "none", ...over });
const KEYS: QueueRow["key"][] = [
  "uncommitted", "no-commits", "ready", "ready-to-merge", "waiting-ok", "landing-specs", "conflicting", "in-progress", "blocked", "stale",
  "no-reading", "drafts-to-land", "queued", "checking", "conflict", "behaviour-differs", "review-flagged", "unattributed", "needs-fix",
  "with-chat", "needs-you", "drafts-changed", "landed", "request-review", "requested", "pushed", "closed", "merged", "cleaned-up", "dropped", "removed",
];

test("every branch state says itself in words: never empty, never a bare Not ready", () => {
  for (const k of KEYS) {
    const b = branchStateOf("feat/x", qrow(k));
    assert.ok(b.word && b.word !== "Not ready", k);
    if (b.stage === "stuck") assert.ok(b.why, `${k}: stuck says why`);
  }
  assert.equal(branchStateOf("b", qrow("queued"), { position: 2 }).word, "In line · 2nd");
  assert.equal(branchStateOf("b", qrow("uncommitted", { detail: "2 files not committed" })).word, "2 files not committed");
  assert.equal(branchStateOf("b", qrow("needs-fix", { label: "Needs a fix", reason: "The last check failed.\nmore" })).why, "Needs a fix: The last check failed.");
});

test("a ready branch carries Land only when the queue offers it and its folder is known", () => {
  assert.deepEqual(branchStateOf("b", qrow("ready", { action: "land" }), { worktree: "/w", commit: "abc" }).land, { worktree: "/w", commit: "abc" });
  assert.equal(branchStateOf("b", qrow("ready", { action: "none" }), { worktree: "/w" }).land, undefined);
  assert.equal(branchStateOf("b", qrow("ready", { action: "land" })).land, undefined);
});

test("a recorded branch falls back to git's facts; a queue stage wins over them", () => {
  // Git finding the tip in the target isn't a landing: a branch with no commit of its own that took master's newest reads so.
  assert.deepEqual(recordedBranchState({ branch: "b", state: "merged", merged: true, target: "master" }, null), { branch: "b", stage: "done", word: "Already in master", tone: "muted" });
  assert.equal(recordedBranchState({ branch: "b", state: "merged", merged: true, mergedAt: "2026-11-10T00:00:00Z" }, null).stage, "landed");
  assert.equal(recordedBranchState({ branch: "b", state: "open", dirty: true }, null).word, "Uncommitted changes");
  assert.equal(recordedBranchState({ branch: "b", state: "open", ahead: 1 }, null).word, "1 commit ahead");
  assert.equal(recordedBranchState({ branch: "b", state: "open", ahead: 3 }, null).word, "3 commits ahead");
  assert.equal(recordedBranchState({ branch: "b", state: "open", ahead: 0 }, null).word, "No commits yet");
  const line = branchStateOf("b", qrow("queued"), { position: 1 });
  assert.equal(recordedBranchState({ branch: "b", state: "open", dirty: true }, line), line);
});

test("a branch reads from its chat's own worktree row where the chat tracks it; the recorded branch only stands in where it doesn't", () => {
  const recorded = { branch: "sova/own", state: "open" as const, ahead: 2, target: "master", worktree: "/w/own" };
  const none = () => undefined;
  // What the session list carries for a chat's worktree that is Ready to land where the queue serves the repo.
  const tracks = (branch: string, path: string) => ({
    branches: [{ path, branch, status: "active" as const, exists: true, mergeServed: true as const, mergeProject: { target: "master", checks: "declared" as const } }],
    readiness: { badge: "ready", since: 0, trees: [{ path, branch, state: "ready", reason: "Ready to land", landing: { state: "ready", commit: "abc" } }] },
  });
  // No row from the session list (another host, before its first read, a session with no `worktrees` entry): recorded.
  for (const s of [undefined, {}, { branches: [] }]) assert.deepEqual(sessionBranches(recorded, s as never, none).map((b) => [b.branch, b.word]), [["sova/own", "2 commits ahead"]]);
  // The chat tracks the branch: its own reading, once, with the queue's Land; the recorded "2 commits ahead" is gone.
  const own = sessionBranches(recorded, tracks("sova/own", "/w/own") as never, none);
  assert.deepEqual(own.map((b) => [b.branch, b.stage, b.word]), [["sova/own", "ready", "Ready to land"]]);
  assert.deepEqual(own[0]!.land, { worktree: "/w/own", commit: "abc", target: "master" });
  // The chat tracks only another branch: the session's own recorded branch still lists, first.
  assert.deepEqual(sessionBranches(recorded, tracks("feat/other", "/w/other") as never, none).map((b) => [b.branch, b.word]), [["sova/own", "2 commits ahead"], ["feat/other", "Ready to land"]]);
  // A session in the project root with nothing tracked has no branch.
  assert.deepEqual(sessionBranches({ branch: null }, undefined, none), []);
});

test("a finished session's age cell says its start date once", () => {
  const date = () => "Nov 5";
  // The two lines never repeat a date or the word "started": the first names the day, the second only the age.
  assert.deepEqual(startedWords("2026-11-05T09:00:00Z", NOW, date), { started: "started Nov 5", age: "11d old" });
  assert.deepEqual(startedWords("2026-11-15T11:00:00Z", NOW, date), { started: "started Nov 5", age: "1d old" });
  assert.deepEqual(startedWords("2026-11-16T09:00:00Z", NOW, date), { started: "started today", age: "" });
  assert.deepEqual(startedWords("not a date", NOW, date), { started: "", age: "" });
});

test("up to 3 branches show, then +N more; opened, all", () => {
  assert.deepEqual(shownBranches([1, 2, 3], false), { shown: [1, 2, 3], more: 0 });
  assert.deepEqual(shownBranches([1, 2, 3, 4], false), { shown: [1, 2, 3], more: 1 });
  assert.deepEqual(shownBranches([1, 2, 3, 4], true), { shown: [1, 2, 3, 4], more: 0 });
});

const bs = (branch: string, stage: BranchState["stage"], land = false): BranchState => ({ branch, stage, word: stage, tone: "muted", ...(land ? { land: { worktree: `/w/${branch}` } } : {}) });

test("the branch column names each branch once: words first for those on their way, then names, 3 while closed", () => {
  const all = [bs("a", "other"), bs("b", "ready"), bs("c", "other"), bs("d", "in-line"), bs("e", "other")];
  const closed = branchLines(all, false);
  assert.deepEqual(closed.lines.map((l) => [l.b.branch, l.said]), [["b", true], ["d", true], ["a", false]]);
  assert.equal(closed.more, 2);
  const open = branchLines(all, true);
  assert.deepEqual(open.lines.map((l) => l.b.branch).sort(), ["a", "b", "c", "d", "e"]);
  // None on its way: the first still says its state, so the row always has words.
  assert.deepEqual(branchLines([bs("a", "other"), bs("b", "other")], false).lines.map((l) => l.said), [true, false]);
  assert.deepEqual(branchLines([bs("a", "other")], false).lines.map((l) => l.said), [true]);
});

test("the row carries Land only when exactly one branch is ready to land", () => {
  assert.equal(rowLand([bs("a", "ready", true), bs("b", "other")])?.branch, "a");
  assert.equal(rowLand([bs("a", "ready", true), bs("b", "ready", true)]), undefined);
  assert.equal(rowLand([bs("a", "ready")]), undefined);
});

test("a session with a branch and none still live is finished: Landed, whether its branches landed, were removed, went missing or are already in their target", () => {
  const idle = (stages: BranchStage[], lastActive = NOW): SessionFacts => ({ needsYou: false, working: false, stages, lastActive });
  const removed = recordedBranchState({ branch: "b", state: "removed", ahead: 2 }, null);
  const missing = recordedBranchState({ branch: "b", state: "missing", ahead: 2 }, null);
  const inTarget = recordedBranchState({ branch: "b", state: "merged", merged: true, ahead: 2, target: "master" }, null);
  const live = recordedBranchState({ branch: "c", state: "open", ahead: 2 }, null);
  for (const done of [removed, missing, inTarget]) {
    assert.equal(sessionGroup(idle([done.stage]), NOW), "landed", done.word);
    assert.equal(sessionGroup(idle([done.stage], NOW - 30 * DAY), NOW), "landed", `${done.word}: never Old`);
    // Its own words, never "Landed {time}".
    assert.notEqual(done.word, "Landed");
    assert.equal(done.landedAt, undefined);
    // One live branch beside it keeps the session in its live group.
    assert.equal(sessionGroup(idle([done.stage, live.stage]), NOW), "idle");
    assert.equal(sessionGroup(idle([done.stage, live.stage], NOW - 30 * DAY), NOW), "old");
  }
  assert.equal(removed.word, "Removed");
  assert.equal(inTarget.word, "Already in master");
  assert.equal(branchStateOf("b", qrow("removed", { label: "Removed" })).stage, "done");
  // No branch at all is not finished.
  assert.equal(sessionGroup(idle([]), NOW), "idle");
  assert.equal(sessionGroup(idle([], NOW - 30 * DAY), NOW), "old");
});
