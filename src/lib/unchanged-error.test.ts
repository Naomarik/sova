import assert from "node:assert/strict";
import { test } from "node:test";
import { unchangedError } from "./unchanged-error";

test("the consequence is added once, never on top of a message that already says it", () => {
  assert.equal(unchangedError("Reconcile is off. Nothing was changed. Turn it on in Settings"), "Reconcile is off. Nothing was changed. Turn it on in Settings.");
  assert.equal(unchangedError("Nothing changed."), "Nothing changed.");
  assert.equal(unchangedError("No session was started: the budget is spent."), "No session was started: the budget is spent.");
  assert.equal(unchangedError("Turn on Reconcile decisions in Settings → Decisions."), "Turn on Reconcile decisions in Settings → Decisions. Nothing changed.");
  assert.equal(unchangedError("Not started: busy", "Nothing was sent."), "Not started: busy. Nothing was sent.");
  assert.equal(unchangedError(""), "Nothing changed.");
});
