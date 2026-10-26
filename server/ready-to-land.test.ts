import assert from "node:assert/strict";
import test from "node:test";
import type { AskKind, TurnOutcome } from "../shared/protocol";
import { finishedFromOutcome } from "./ready-to-land";
import type { TurnOutcomeRecord } from "./turn-outcomes";

// The "work is finished" rule of Ready to land (§chat.worktrees/ready-to-land), on one turn outcome.

const REPLY = "reply-1";
const rec = (outcome?: TurnOutcome, askKind?: AskKind, turnId = REPLY): TurnOutcomeRecord => ({
  turnId,
  replyAt: 1,
  at: 2,
  provider: "pi",
  model: "m",
  ...(outcome ? { outcome } : {}),
  ...(askKind ? { askKind } : {}),
});

test("did what was asked is finished, whatever it asks", () => {
  assert.equal(finishedFromOutcome(rec("did-what-was-asked"), REPLY), "yes");
  assert.equal(finishedFromOutcome(rec("did-what-was-asked", "restart-or-merge-go"), REPLY), "yes");
  assert.equal(finishedFromOutcome(rec("did-what-was-asked", "none"), REPLY), "yes");
});

test("waiting only for the go-ahead to land, merge, push or restart is finished, from the user or the merge captain", () => {
  assert.equal(finishedFromOutcome(rec("waiting-on-user", "restart-or-merge-go"), REPLY), "yes");
  assert.equal(finishedFromOutcome(rec("waiting-on-team", "restart-or-merge-go"), REPLY), "yes");
});

test("a wait for anything else is not finished", () => {
  for (const outcome of ["waiting-on-user", "waiting-on-team"] as const) {
    for (const ask of ["choose-between-options", "approve-risky-action", "needs-info", "optional-offer", "none"] as const) {
      assert.equal(finishedFromOutcome(rec(outcome, ask), REPLY), "no", `${outcome} + ${ask}`);
    }
    assert.equal(finishedFromOutcome(rec(outcome), REPLY), "no", `${outcome} with no ask kind`);
  }
});

test("other outcomes are not finished, even with a merge go-ahead ask", () => {
  for (const outcome of ["partial-stopped", "hit-unfixed-failure", "progress-report"] as const) {
    assert.equal(finishedFromOutcome(rec(outcome), REPLY), "no", outcome);
    assert.equal(finishedFromOutcome(rec(outcome, "restart-or-merge-go"), REPLY), "no", `${outcome} + restart-or-merge-go`);
  }
  assert.equal(finishedFromOutcome(rec(undefined, "restart-or-merge-go"), REPLY), "no", "no outcome");
});

test("an outcome for another reply, or none, is not finished", () => {
  assert.equal(finishedFromOutcome(rec("did-what-was-asked", undefined, "older"), REPLY), "no");
  assert.equal(finishedFromOutcome(rec("waiting-on-user", "restart-or-merge-go", "older"), REPLY), "no");
  assert.equal(finishedFromOutcome(undefined, REPLY), "no");
  assert.equal(finishedFromOutcome(rec("did-what-was-asked"), undefined), "no");
});
