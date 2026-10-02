import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReadinessState, SessionReadiness, SpecAssessmentObservation, SpecAssessmentObservations } from "../../shared/protocol";
import { readinessBadge, readinessCount, readinessCountWords, readinessTitle, readinessWord, specObservationSummary } from "./readiness";
import { readinessChip, readinessReason } from "./worktrees";

const r = (over: Partial<SessionReadiness>): SessionReadiness => ({ trees: [{ path: "/wt/a", branch: "feat/a", state: "merged" }], since: 1, ...over });

test("the muted badge carries only what the count cannot: a restart, and named follow-up work", () => {
  assert.equal(readinessBadge(r({ badge: "restart" })), "restart pending");
  assert.equal(readinessBadge(r({ badge: "merged", followUps: 1 })), "1 follow-up");
  assert.equal(readinessBadge(r({ badge: "merged", followUps: 2 })), "2 follow-ups");
  assert.equal(readinessBadge(r({ badge: "merged" })), null, "the count already says merged");
  assert.equal(readinessBadge(r({ badge: "merged", cleanup: 3 })), null, "a leftover worktree is in the title, never counted");
  assert.equal(readinessBadge(r({ badge: "ready" })), null, "the count speaks instead, in success");
  assert.equal(readinessBadge(r({ badge: "waiting" })), null, "the count speaks instead, in success");
  assert.equal(readinessBadge(r({})), null);
  assert.equal(readinessBadge(undefined), null);
});

test("the row's worktree count: merged of the tracked set, lit while one is ready", () => {
  assert.equal(readinessCount(undefined), null);
  assert.equal(readinessCount(r({ trees: [] })), null, "a session that tracks none has no count");
  assert.deepEqual(readinessCount(r({})), { merged: 1, total: 1, ready: false });
  const three = r({
    trees: [
      { path: "/wt/a", branch: "feat/a", state: "merged" },
      { path: "/wt/b", branch: "feat/b", state: "in-progress" },
      { path: "/wt/c", branch: "feat/c", state: "ready" },
    ],
    badge: "ready",
  });
  assert.deepEqual(readinessCount(three), { merged: 1, total: 3, ready: true });
  // Stale is merged but dirty, and the spec says it is never merged; it is not ready either.
  assert.deepEqual(readinessCount(r({ trees: [{ path: "/wt/a", branch: "feat/a", state: "stale" }] })), { merged: 0, total: 1, ready: false });
  // Waiting for your OK is still mergeable, so the count lights up for it too.
  assert.equal(readinessCount(r({ trees: [{ path: "/wt/a", branch: "feat/a", state: "waiting-approval" }] }))?.ready, true);
  // A ready worktree lights the count even when the badge says something else (a stale sibling
  // hides the badge, §chat.worktrees/readiness), because the fact is the trees'.
  const hidden = r({
    trees: [
      { path: "/wt/a", branch: "feat/a", state: "stale" },
      { path: "/wt/b", branch: "feat/b", state: "ready" },
    ],
  });
  assert.equal(hidden.badge, undefined);
  assert.equal(readinessCount(hidden)?.ready, true);
  assert.equal(readinessCountWords({ merged: 2, total: 3, ready: false }), "2 of 3 worktrees merged");
  assert.equal(readinessCountWords({ merged: 2, total: 3, ready: true }), "2 of 3 worktrees merged, one is ready to merge");
});

test("the title names each worktree and every routine follow-up in words", () => {
  const title = readinessTitle(
    r({
      trees: [
        { path: "/wt/a", branch: "feat/a", state: "merged", why: "still tracked active" },
        { path: "/wt/b", branch: "feat/b", state: "in-progress", why: "uncommitted changes" },
      ],
      restartPending: true,
      pushPending: true,
      cleanup: 1,
      followUp: { weight: "small", cue: "groups don't nest" },
    }),
  );
  assert.equal(
    title,
    [
      "feat/a: merged, still tracked active",
      "feat/b: in progress, uncommitted changes",
      "A merge changed the server since it started: restart it to run the new code.",
      "The merge isn't pushed yet.",
      "1 merged worktree is still tracked active.",
      "Open work (small): groups don't nest",
    ].join("\n"),
  );
  assert.equal(readinessTitle(undefined), null);
});

test("the Session tab's chip: every state but merged, with its reason as the title", () => {
  assert.equal(readinessChip({}), null);
  assert.equal(readinessChip({ readiness: { path: "/p", branch: "b", state: "merged" } }), null, "the status chip already says merged");
  assert.deepEqual(readinessChip({ readiness: { path: "/p", branch: "b", state: "ready", why: "checks passed" } }), { label: "Ready to merge", tone: "success", title: "Checks passed." });
  assert.equal(readinessChip({ readiness: { path: "/p", branch: "b", state: "waiting-approval" } })?.label, "Waiting for your OK");
  assert.equal(readinessChip({ readiness: { path: "/p", branch: "b", state: "stale", why: "merged, with uncommitted changes" } })?.title, "Merged, with uncommitted changes.");
});

test("the Session tab's visible reason line: the server's reason, else state and why, else none", () => {
  assert.equal(readinessReason({ readiness: { path: "/p", branch: "b", state: "ready", why: "checks passed", reason: "Ready to merge · checks passed · 19 commits ahead" } }), "Ready to merge · checks passed · 19 commits ahead");
  assert.equal(readinessReason({ readiness: { path: "/p", branch: "b", state: "blocked", why: "2 open questions" } }), "Blocked · 2 open questions");
  assert.equal(readinessReason({ readiness: { path: "/p", branch: "b", state: "merged", why: "still tracked active" } }), "Merged · still tracked active");
  assert.equal(readinessReason({ readiness: { path: "/p", branch: "b", state: "ready" } }), null, "the chip alone already says it");
  assert.equal(readinessReason({}), null);
});

test("structured observations word uncertainty and recorded verification inputs without changing readiness badges", () => {
  const old = r({ badge: "ready" });
  const observed = r({ badge: "ready", specObservations: { state: "incomplete", reasons: ["partial"], items: [{
    name: "receipt", worktree: "/wt/a", attribution: { ownerSessionId: null, sessionId: null, workerId: null, teamId: null, taskId: null, attemptId: null },
    applicability: "stale", attributionState: "unknown", assessmentState: "outstanding", unresolved: 1, reasons: [],
    verification: [{ kind: "test", revision: "old", result: "passed", summary: "recorder declaration", revisionBinding: { source: "recorder-declaration", revisionCommit: null, inputApplicability: "mismatched" } }],
  }] } });
  assert.deepEqual(readinessCount(observed), readinessCount(old));
  assert.equal(readinessBadge(observed), readinessBadge(old));
  const summary = specObservationSummary(observed)!;
  for (const fact of ["incomplete", "1 stale", "unknown attribution", "1 unresolved", "recorded verification: 1 passed", "verification inputs: 1 mismatched"]) assert.ok(summary.includes(fact), fact);
  assert.ok(readinessTitle(observed)?.endsWith(summary));
  assert.equal(specObservationSummary(old), null);
  const absent = specObservationSummary(r({ specObservations: { state: "absent", items: [], reasons: [] } }));
  assert.match(absent!, /no receipts.*applicability unknown.*verification unrecorded/);
});

test("adding observation classes preserves every count, accessible word, badge and old title line", () => {
  const item = (over: Partial<SpecAssessmentObservation>): SpecAssessmentObservation => ({
    name: "fixture", worktree: "/wt/a", attribution: { ownerSessionId: null, sessionId: null, workerId: null, teamId: null, taskId: null, attemptId: null },
    applicability: "current", attributionState: "matched", assessmentState: "recorded", unresolved: 0, verification: [], reasons: [], ...over,
  });
  const basis = (result: "passed" | "failed", inputApplicability: "matching" | "mismatched") => [{
    kind: "test" as const, revision: null, result, summary: "A recorder declaration, not a test run.",
    revisionBinding: { source: "recorder-declaration" as const, revisionCommit: null, inputApplicability },
  }];
  const observations: SpecAssessmentObservations[] = [
    { state: "absent", items: [], reasons: [] },
    { state: "incomplete", items: [], reasons: ["unread input"] },
    { state: "observed", items: [item({ verification: basis("passed", "matching") })], reasons: [] },
    { state: "observed", items: [item({ assessmentState: "outstanding", unresolved: 1, verification: basis("failed", "mismatched") })], reasons: [] },
    { state: "observed", items: [item({ applicability: "stale", verification: basis("passed", "mismatched") })], reasons: [] },
    { state: "incomplete", items: [item({ applicability: "unknown", attributionState: "unknown", assessmentState: "unknown", unresolved: null })], reasons: [] },
    { state: "observed", items: [item({ attributionState: "conflicting", assessmentState: "outstanding", unresolved: 1 })], reasons: [] },
  ];
  assert.equal(readinessCount(undefined), null);
  assert.equal(readinessBadge(undefined), null);
  assert.equal(readinessTitle(undefined), null);
  assert.equal(specObservationSummary(undefined), null);
  const states: ReadinessState[] = ["merged", "stale", "in-progress", "blocked", "ready", "waiting-approval"];
  const sets = [[], ...states.map(state => [{ path: "/wt/a", branch: "feat/a", state, why: "fixture reason" }]),
    ...states.map(state => [{ path: "/wt/a", branch: "feat/a", state, why: "fixture reason" }, { path: "/wt/b", branch: "feat/b", state: "merged" as const }])];
  const flagSets: Partial<SessionReadiness>[] = [{}, { restartPending: true, pushPending: true, cleanup: 2, followUps: 2, followUp: { weight: "significant", cue: "Recorded open work" } }];
  for (const trees of sets) for (const badge of [undefined, "ready", "waiting", "restart", "merged"] as const) for (const flags of flagSets) {
    const old = r({ trees, ...(badge ? { badge } : {}), ...flags });
    const before = structuredClone(old);
    const oldCount = readinessCount(old), oldBadge = readinessBadge(old), oldTitle = readinessTitle(old);
    const oldWords = oldCount ? readinessCountWords(oldCount) : null;
    const stateWords = old.trees.map(t => readinessWord(t.state));
    for (const specObservations of [undefined, ...observations]) {
      const observed: SessionReadiness = { ...structuredClone(old), ...(specObservations ? { specObservations: structuredClone(specObservations) } : {}) };
      const snapshot = structuredClone(observed), count = readinessCount(observed);
      assert.deepEqual(count, oldCount);
      assert.equal(count ? readinessCountWords(count) : null, oldWords);
      assert.equal(readinessBadge(observed), oldBadge);
      assert.deepEqual(observed.trees.map(t => readinessWord(t.state)), stateWords);
      const summary = specObservationSummary(observed);
      assert.equal(readinessTitle(observed), oldTitle === null ? null : summary ? `${oldTitle}\n${summary}` : oldTitle, "only the separate observation suffix may extend the old title");
      assert.deepEqual(observed, snapshot, "rendering observations must not rewrite readiness inputs");
    }
    assert.deepEqual(old, before, "the unobserved reference is not mutated");
  }
});
