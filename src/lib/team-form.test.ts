import assert from "node:assert/strict";
import { test } from "node:test";
import type { TeamDefaults } from "../../shared/protocol";
import { cloneTeam, numberIssue, numberOf, sameTeam, teamDraftComplete, teamDraftConflict } from "./team-form";

const base: TeamDefaults = {
  version: 1,
  coordinator: { enabled: false, role: "coordinator", primary: { backend: "claude-code", model: "opus[1m]", effort: "medium" }, fallback: null, instructions: "" },
  monitor: {
    enabled: false,
    role: "monitor",
    primary: { backend: "claude-code", model: "haiku", effort: "medium" },
    fallback: null,
    contextPct: 60,
    everyMinutes: 10,
    usage: { enabled: true, pausePct: 90, resumeMarginMinutes: 5 },
    instructions: "",
  },
  handover: { retireTimeoutMinutes: 10 },
};

test("every field a user can change makes the draft differ from what's saved", () => {
  const edits: ((d: ReturnType<typeof cloneTeam>) => void)[] = [
    (d) => (d.coordinator.enabled = true),
    (d) => (d.coordinator.role = "lead"),
    (d) => (d.coordinator.instructions = "x"),
    (d) => (d.coordinator.primary = { ...d.coordinator.primary, effort: "high" }),
    (d) => (d.coordinator.fallback = { backend: "pi", model: "", effort: "" }),
    (d) => (d.monitor.enabled = true),
    (d) => (d.monitor.role = "watch"),
    (d) => (d.monitor.instructions = "x"),
    (d) => (d.monitor.primary = { ...d.monitor.primary, model: "sonnet" }),
    (d) => (d.monitor.contextPct = 70),
    (d) => (d.monitor.everyMinutes = 5),
    (d) => (d.monitor.usage.enabled = false),
    (d) => (d.monitor.usage.pausePct = 80),
    (d) => (d.monitor.usage.resumeMarginMinutes = 0),
    (d) => (d.handover.retireTimeoutMinutes = 20),
  ];
  assert.ok(sameTeam(cloneTeam(base), base));
  for (const [i, edit] of edits.entries()) {
    const d = cloneTeam(base);
    edit(d);
    assert.ok(!sameTeam(d, base), `edit ${i} is seen`);
  }
});

test("numbers: blank is NaN and never valid; bounds are whole and inclusive", () => {
  assert.ok(Number.isNaN(numberOf("")));
  assert.equal(numberIssue("contextPct", Number.NaN), "Enter a number.");
  assert.equal(numberIssue("contextPct", 60.5), "Use a whole number.");
  assert.equal(numberIssue("contextPct", 0), "Use 1 to 100.");
  assert.equal(numberIssue("contextPct", 100), null);
  assert.equal(numberIssue("resumeMarginMinutes", 0), null);
  assert.equal(numberIssue("everyMinutes", 0), "Use 1 to 1440.");
});

test("save waits for names, rows and numbers, and refuses a fallback equal to its primary or a shared role name", () => {
  assert.ok(teamDraftComplete(cloneTeam(base)));
  const blankRole = cloneTeam(base);
  blankRole.monitor.role = "  ";
  assert.ok(!teamDraftComplete(blankRole));
  const blankRow = cloneTeam(base);
  blankRow.coordinator.fallback = { backend: "pi", model: "", effort: "" };
  assert.ok(!teamDraftComplete(blankRow));
  const badNumber = cloneTeam(base);
  badNumber.handover.retireTimeoutMinutes = Number.NaN;
  assert.ok(!teamDraftComplete(badNumber));

  assert.equal(teamDraftConflict(cloneTeam(base)), null);
  const same = cloneTeam(base);
  same.monitor.fallback = { ...same.monitor.primary };
  assert.match(teamDraftConflict(same)!, /^Monitor:/);
  const shared = cloneTeam(base);
  shared.monitor.role = "Coordinator";
  assert.match(teamDraftConflict(shared)!, /different role names/);
});
