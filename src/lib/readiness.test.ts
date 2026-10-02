import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReadinessState, SessionReadiness } from "../../shared/protocol";
import { readinessBadge, readinessCount, readinessCountWords, readinessTitle, readinessWord } from "./readiness";
import { readinessChip, readinessReason } from "./worktrees";

const r = (over: Partial<SessionReadiness>): SessionReadiness => ({ trees: [{ path: "/wt/a", branch: "feat/a", state: "merged" }], since: 1, ...over });

test("the muted badge carries only a restart and named follow-up work", () => {
  assert.equal(readinessBadge(r({ badge: "restart" })), "restart pending");
  assert.equal(readinessBadge(r({ badge: "merged", followUps: 1 })), "1 follow-up");
  assert.equal(readinessBadge(r({ badge: "merged", followUps: 2 })), "2 follow-ups");
  for (const value of [undefined, r({}), r({ badge: "merged" }), r({ badge: "merged", cleanup: 3 }), r({ badge: "ready" }), r({ badge: "waiting" })]) assert.equal(readinessBadge(value), null);
});

test("worktree counts and accessible words retain all ordinary states", () => {
  assert.equal(readinessCount(undefined), null);
  assert.equal(readinessCount(r({ trees: [] })), null);
  const states: ReadinessState[] = ["merged", "stale", "in-progress", "blocked", "ready", "waiting-approval"];
  for (const state of states) {
    const count = readinessCount(r({ trees: [{ path: "/wt/a", branch: "feat/a", state }, { path: "/wt/b", branch: "feat/b", state: "merged" }] }))!;
    const ready = state === "ready" || state === "waiting-approval";
    assert.deepEqual(count, { merged: state === "merged" ? 2 : 1, total: 2, ready });
    assert.equal(readinessCountWords(count), `${count.merged} of 2 worktrees merged${ready ? ", one is ready to merge" : ""}`);
    assert.ok(readinessWord(state));
  }
  assert.deepEqual(readinessCount(r({})), { merged: 1, total: 1, ready: false });
  assert.equal(readinessCount(r({ trees: [{ path: "/wt/a", branch: "a", state: "stale" }, { path: "/wt/b", branch: "b", state: "ready" }] }))?.ready, true, "a stale sibling cannot hide a ready count");
});

test("titles retain every ordinary follow-up and ignore legacy spec observations", () => {
  const value = r({ trees: [{ path: "/wt/a", branch: "feat/a", state: "merged", why: "still tracked active" }, { path: "/wt/b", branch: "feat/b", state: "in-progress", why: "uncommitted changes" }], restartPending: true, pushPending: true, cleanup: 1, followUp: { weight: "small", cue: "groups don't nest" } });
  const expected = ["feat/a: merged, still tracked active", "feat/b: in progress, uncommitted changes", "A merge changed the server since it started: restart it to run the new code.", "The merge isn't pushed yet.", "1 merged worktree is still tracked active.", "Open work (small): groups don't nest"].join("\n");
  assert.equal(readinessTitle(value), expected);
  const legacy = { ...value, specObservations: { state: "incomplete", items: [], reasons: ["fixture"] } };
  assert.equal(readinessTitle(legacy), expected, "old wire data must not revive the removed display");
  assert.deepEqual(readinessCount(legacy), readinessCount(value));
  assert.equal(readinessBadge(legacy), readinessBadge(value));
  assert.equal(readinessTitle(undefined), null);
});

test("Session tab chips and visible reasons remain ordinary readiness", () => {
  assert.equal(readinessChip({}), null);
  assert.equal(readinessChip({ readiness: { path: "/p", branch: "b", state: "merged" } }), null);
  assert.deepEqual(readinessChip({ readiness: { path: "/p", branch: "b", state: "ready", why: "checks passed" } }), { label: "Ready to merge", tone: "success", title: "Checks passed." });
  assert.equal(readinessChip({ readiness: { path: "/p", branch: "b", state: "waiting-approval" } })?.label, "Waiting for your OK");
  assert.equal(readinessChip({ readiness: { path: "/p", branch: "b", state: "stale", why: "merged, with uncommitted changes" } })?.title, "Merged, with uncommitted changes.");
  assert.equal(readinessReason({ readiness: { path: "/p", branch: "b", state: "ready", why: "checks passed", reason: "Ready to merge · checks passed · 19 commits ahead" } }), "Ready to merge · checks passed · 19 commits ahead");
  assert.equal(readinessReason({ readiness: { path: "/p", branch: "b", state: "blocked", why: "2 open questions" } }), "Blocked · 2 open questions");
  assert.equal(readinessReason({ readiness: { path: "/p", branch: "b", state: "merged", why: "still tracked active" } }), "Merged · still tracked active");
  assert.equal(readinessReason({ readiness: { path: "/p", branch: "b", state: "ready" } }), null);
  assert.equal(readinessReason({}), null);
});
