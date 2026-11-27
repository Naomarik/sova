import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultNotAppliedLine } from "./default-not-applied";

test("the line names the profile and the reason, ending in one period", () => {
  assert.equal(defaultNotAppliedLine({ profile: "Claude", reason: "Provider openai is turned off." }), "This chat didn't start on Claude: Provider openai is turned off.");
  assert.equal(defaultNotAppliedLine({ profile: "Night", reason: "its model (Provider openai is turned off) couldn't be set" }), "This chat didn't start on Night: its model (Provider openai is turned off) couldn't be set.");
});

test("with no reason it still says which profile", () => {
  assert.equal(defaultNotAppliedLine({ profile: "Claude", reason: "  " }), "This chat didn't start on Claude.");
});
