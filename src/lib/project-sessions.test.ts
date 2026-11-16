import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueueRow } from "./merge-queue";
import {
  branchStateOf,
  GROUP_ORDER,
  groupCount,
  groupSessions,
  OLD_DAYS,
  recordedBranchState,
  sessionGroup,
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
  landed: (f) => f.stages.length > 0 && f.stages.every((s) => s === "landed"),
  old: (f) => f.lastActive > 0 && NOW - f.lastActive >= OLD_DAYS * DAY,
  idle: () => true,
};

// Every combination of the facts at their edges: the stage lists cover none, all landed, landed beside not landed,
// each stage on its way alone and beside a landed one; the times cover unknown, just under and exactly OLD_DAYS.
const STAGE_LISTS: BranchStage[][] = [[], ["landed"], ["landed", "landed"], ["landed", "other"], ["other"], ...ON_ITS_WAY.map((s) => [s]), ...ON_ITS_WAY.map((s) => ["landed", s] as BranchStage[])];
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
  assert.equal(recordedBranchState({ branch: "b", state: "merged", merged: true }, null).stage, "landed");
  assert.equal(recordedBranchState({ branch: "b", state: "open", dirty: true }, null).word, "Uncommitted changes");
  const line = branchStateOf("b", qrow("queued"), { position: 1 });
  assert.equal(recordedBranchState({ branch: "b", state: "open", dirty: true }, line), line);
});

test("up to 3 branches show, then +N more; opened, all", () => {
  assert.deepEqual(shownBranches([1, 2, 3], false), { shown: [1, 2, 3], more: 0 });
  assert.deepEqual(shownBranches([1, 2, 3, 4], false), { shown: [1, 2, 3], more: 1 });
  assert.deepEqual(shownBranches([1, 2, 3, 4], true), { shown: [1, 2, 3, 4], more: 0 });
});
