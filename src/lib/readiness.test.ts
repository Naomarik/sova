import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionReadiness } from "../../shared/protocol";
import { readinessBadge, readinessTitle } from "./readiness";
import { readinessChip } from "./worktrees";

const r = (over: Partial<SessionReadiness>): SessionReadiness => ({ trees: [{ path: "/wt/a", branch: "feat/a", state: "merged" }], since: 1, ...over });

test("the badge: terse, lowercase, one per session; none without one", () => {
  assert.equal(readinessBadge(r({ badge: "waiting" })), "waiting for your OK");
  assert.equal(readinessBadge(r({ badge: "ready" })), "ready ✓");
  assert.equal(readinessBadge(r({ badge: "restart" })), "restart pending");
  assert.equal(readinessBadge(r({ badge: "merged" })), "merged");
  assert.equal(readinessBadge(r({ badge: "merged", followUps: 1 })), "merged · 1 follow-up");
  assert.equal(readinessBadge(r({ badge: "merged", followUps: 2 })), "merged · 2 follow-ups");
  assert.equal(readinessBadge(r({})), null);
  assert.equal(readinessBadge(undefined), null);
  for (const b of ["waiting", "ready", "restart", "merged"] as const) assert.ok(readinessBadge(r({ badge: b }))!.length <= 20, "fits line 3 on a phone");
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
  assert.deepEqual(readinessChip({ readiness: { path: "/p", branch: "b", state: "ready", why: "checks passed" } }), { label: "Ready", tone: "success", title: "Checks passed." });
  assert.equal(readinessChip({ readiness: { path: "/p", branch: "b", state: "waiting-approval" } })?.label, "Waiting for your OK");
  assert.equal(readinessChip({ readiness: { path: "/p", branch: "b", state: "stale", why: "merged, with uncommitted changes" } })?.title, "Merged, with uncommitted changes.");
});
