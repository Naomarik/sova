import assert from "node:assert/strict";
import { test } from "node:test";
import type { SubagentProfile, TeamsSetting } from "../../shared/subagent-profiles";
import type { WorkerChoice } from "../../shared/protocol";
import { readFileSync } from "node:fs";
import { coordinatorOn, delegateSummary, footprintModel, monitorOn, reviewerSummary, roleProblem, sectionProblems, specSummary, teamsSummary, withCoordinator, withMonitor } from "./subagent-editor";

const claude = (model: string, effort = "medium"): WorkerChoice => ({ backend: "claude-code", model, effort });

const teams = (): TeamsSetting => ({
  coordinator: { enabled: true, role: "coordinator", primary: { backend: "claude-code", model: "opus[1m]", effort: "medium" }, fallback: null, instructions: "" },
  monitor: {
    enabled: true,
    role: "monitor",
    primary: { backend: "pi", model: "ollama-cloud/deepseek-v4.1-flash", effort: "low" },
    fallback: null,
    contextPct: 60,
    everyMinutes: 10,
    usage: { enabled: true, pausePct: 90, resumeMarginMinutes: 5 },
    instructions: "",
  },
  handover: { retireTimeoutMinutes: 10 },
});

function profile(over: Partial<SubagentProfile> = {}): SubagentProfile {
  return {
    id: "my-setup",
    name: "My setup",
    delegate: {
      planning: { primary: claude("claude-fable-5-1[1m]"), fallback: claude("opus[1m]", "high") },
      investigation: { primary: claude("opus[1m]", "low"), fallback: null },
      routine: { primary: claude("opus[1m]", "low"), fallback: null },
      complex: { primary: claude("opus[1m]"), fallback: null },
    },
    teams: null,
    members: null,
    specWriter: null,
    ...over,
  };
}

test("each closed section's summary says what is inside", () => {
  assert.equal(delegateSummary(profile()), "fable · opus · 1 fallback");
  const none = profile();
  none.delegate.planning.fallback = null;
  assert.equal(delegateSummary(none), "fable · opus · no fallbacks");

  assert.equal(teamsSummary(profile()), "No standing roles · members on the lead's model");
  assert.equal(teamsSummary(profile({ teams: teams(), members: claude("sonnet") })), "Coordinator + monitor · members on sonnet");
  const lone = teams();
  lone.monitor.enabled = false;
  assert.equal(teamsSummary(profile({ teams: lone })), "Coordinator only · members on the lead's model");
  // A stored shape with the coordinator off adds nobody, monitor included (teams.ts reads it so).
  const off = teams();
  off.coordinator.enabled = false;
  assert.equal(teamsSummary(profile({ teams: off })), "No standing roles · members on the lead's model");

  assert.equal(specSummary(profile()), "Off · the session writes it");
  assert.equal(specSummary(profile({ specWriter: { primary: claude("sonnet"), fallback: null } })), "sonnet");
  assert.equal(specSummary(profile({ specWriter: { primary: claude("sonnet"), fallback: claude("opus[1m]") } })), "sonnet · 1 fallback");

  // A profile without the key and one with None read alike: nothing reviews.
  assert.equal(reviewerSummary(profile()), "Off · no review");
  assert.equal(reviewerSummary(profile({ reviewer: null })), "Off · no review");
  assert.equal(reviewerSummary(profile({ reviewer: { primary: { backend: "pi", model: "openai-codex/gpt-6.1-sol", effort: "high" }, fallback: claude("opus[1m]", "high") } })), "gpt-6.1-sol · 1 fallback");
});

test("a summary names a model the way the list's footprint does", () => {
  for (const [id, short] of ([["opus[1m]", "opus"], ["claude-fable-5-1[1m]", "fable"], ["claude-sonnet-4-5", "sonnet"], ["zai/glm-5.3", "glm-5.3"], ["ollama-cloud/deepseek-v4.1-flash", "deepseek-v4.1-flash"]] as [string, string][]))
    assert.equal(footprintModel(id), short, id);
  // The copy is the extension's rule: pin the two bodies together so neither drifts alone.
  const ext = readFileSync(new URL("../../pi-config/extensions/subagents/subagent-profiles.ts", import.meta.url), "utf8");
  const body = /export function shortModel\(model: string\): string \{([\s\S]*?)\n\}/.exec(ext)?.[1] ?? "";
  for (const line of ['m.replace(/\\[1m\\]$/i, "")', "/^claude-(opus|sonnet|haiku|fable)\\b/i"]) assert.ok(body.includes(line), `the extension's shortModel still has ${line}`);
});

test("the coordinator switch: off stores no roles, on restores the seed with the coordinator on", () => {
  const seed = teams();
  seed.coordinator.enabled = false; // a seed whose coordinator was off still turns on
  const on = withCoordinator(profile(), true, seed);
  assert.ok(coordinatorOn(on) && monitorOn(on));
  assert.equal(on.teams!.monitor.everyMinutes, 10, "the seed's settings come back whole");
  assert.equal(seed.coordinator.enabled, false, "the seed itself is not touched");
  assert.equal(withCoordinator(on, false, seed).teams, null, "off is teams: null, the shape the old master switch stored");
  assert.equal(withCoordinator(profile(), true, null).teams, null, "with nothing to restore, nothing turns on");
  const stored = teams();
  stored.coordinator.enabled = false;
  stored.coordinator.instructions = "keep me";
  const back = withCoordinator(profile({ teams: stored }), true, seed);
  assert.equal(back.teams!.coordinator.instructions, "keep me", "a stored shape is turned on, not replaced by the seed");
});

test("the monitor switch needs a coordinator", () => {
  const p = profile({ teams: teams() });
  assert.equal(monitorOn(withMonitor(p, false)), false);
  assert.equal(withMonitor(p, false).teams!.coordinator.enabled, true, "the coordinator stays");
  assert.equal(withMonitor(profile(), true).teams, null, "no coordinator: nothing to turn on");
});

test("a section opens itself only for what Save waits for, and only that section", () => {
  assert.deepEqual([...sectionProblems(profile())], []);
  const d = profile();
  d.delegate.routine.primary = { ...d.delegate.routine.primary, model: "" };
  assert.deepEqual([...sectionProblems(d)], ["delegate"]);
  const t = teams();
  t.monitor.contextPct = 0;
  assert.deepEqual([...sectionProblems(profile({ teams: t }))], ["teams"]);
  assert.deepEqual([...sectionProblems(profile({ members: { backend: "pi", model: "", effort: "" } }))], ["teams"]);
  assert.deepEqual([...sectionProblems(profile({ specWriter: { primary: claude("sonnet"), fallback: claude("sonnet") } }))], ["spec"]);
  assert.deepEqual([...sectionProblems(profile({ reviewer: { primary: { backend: "pi", model: "", effort: "" }, fallback: null } }))], ["reviewer"]);
  assert.deepEqual([...sectionProblems(profile({ reviewer: null }))], [], "None waits for nothing");
  assert.deepEqual([...sectionProblems(profile({ name: "" }))], [], "the name sits above the sections");
});

test("a role whose fields need fixing is said per role", () => {
  const t = teams();
  t.monitor.role = " ";
  assert.equal(roleProblem(profile({ teams: t }), "monitor"), true);
  assert.equal(roleProblem(profile({ teams: t }), "coordinator"), false);
  const same = teams();
  same.monitor.role = "Coordinator";
  assert.equal(roleProblem(profile({ teams: same }), "coordinator"), true, "the clash is both roles'");
  assert.equal(roleProblem(profile({ teams: same }), "monitor"), true);
  assert.equal(roleProblem(profile(), "monitor"), false);
});
