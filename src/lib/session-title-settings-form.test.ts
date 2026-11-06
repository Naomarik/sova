// Run: npx tsx --test src/lib/session-title-settings-form.test.ts — Settings → Summaries →
// Session titles' form rules: the minute fields, what holds Save, and the PUT body.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionTitleSettings } from "../../shared/protocol";
import { sameTitleSettings, titleDraftProblem, toTitleDraft, toTitleSettings, withoutSubagentMarks } from "./session-title-settings-form";

const saved: SessionTitleSettings = {
  version: 1,
  enabled: false,
  intervalMinutes: 5,
  quietMinutes: 5,
  primary: { backend: "pi", model: "ollama-cloud/deepseek-v4.1-flash", effort: "off" },
  fallback: { backend: "claude-code", model: "sonnet", effort: "low" },
};

test("minutes: whole numbers in range only, as typed, refused in the shared words (Settings QA D7)", () => {
  const d = toTitleDraft(saved);
  assert.equal(toTitleSettings({ ...d, intervalMinutes: "15" }).intervalMinutes, 15);
  assert.equal(toTitleSettings({ ...d, quietMinutes: " 0 " }).quietMinutes, 0);
  for (const bad of ["0", "2.5", "", "1e", "abc", "9999"]) assert.equal(titleDraftProblem({ ...d, intervalMinutes: bad }), "Minutes between checks must be a whole number from 1 to 1,440.", bad);
  assert.equal(titleDraftProblem({ ...d, quietMinutes: "1441" }), "Quiet minutes must be a whole number from 0 to 1,440.");
});

test("a draft round-trips, and only a real change is dirty", () => {
  const d = toTitleDraft(saved);
  assert.equal(sameTitleSettings(d, saved), true);
  assert.deepEqual(toTitleSettings(d), saved);
  assert.equal(sameTitleSettings({ ...d, enabled: true }, saved), false);
  assert.equal(sameTitleSettings({ ...d, quietMinutes: "05" }, saved), true);
  assert.equal(sameTitleSettings({ ...d, fallback: null }, saved), false);
});

test("Save waits for valid minutes, a model and an effort per row, and a fallback that isn't the primary", () => {
  const d = toTitleDraft(saved);
  assert.equal(titleDraftProblem(d), null);
  assert.match(titleDraftProblem({ ...d, intervalMinutes: "0" })!, /Minutes between checks/);
  assert.match(titleDraftProblem({ ...d, quietMinutes: "-1" })!, /Quiet minutes/);
  assert.match(titleDraftProblem({ ...d, primary: { backend: "pi", model: "", effort: "" } })!, /primary model/);
  assert.match(titleDraftProblem({ ...d, fallback: { backend: "claude-code", model: "sonnet", effort: "" } })!, /effort for the fallback/);
  assert.match(titleDraftProblem({ ...d, fallback: { ...d.primary } })!, /same as the primary/);
});

test("the offer drops Delegate's subagent marks: a title model obeys only the global policy", () => {
  const opts = { backends: [{ id: "pi" as const, label: "pi", models: [{ id: "a/b", efforts: ["off"], denied: "off for subagents" }] }, { id: "claude-code" as const, label: "Claude Code", models: null }] };
  const out = withoutSubagentMarks(opts as never)!;
  assert.deepEqual(out.backends[0]!.models, [{ id: "a/b", efforts: ["off"] }]);
  assert.equal(out.backends[1]!.models, null);
  assert.equal(withoutSubagentMarks(undefined), undefined);
});
