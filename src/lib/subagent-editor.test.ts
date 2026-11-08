import assert from "node:assert/strict";
import { test } from "node:test";
import type { SubagentProfile, TeamsSetting } from "../../shared/subagent-profiles";
import type { WorkerChoice } from "../../shared/protocol";
import { readFileSync } from "node:fs";
import type { TeamDefaults } from "../../shared/team-defaults";
import { delegateSummary, footprintModel, reviewerSummary, sectionProblems, specSummary, teamsSeed, teamsSummary, withChosenModels, withDefaultModel } from "./subagent-editor";

const claude = (model: string, effort = "medium"): WorkerChoice => ({ backend: "claude-code", model, effort });

const teams = (): TeamsSetting => ({
  coordinator: { role: "coordinator", primary: { backend: "claude-code", model: "opus[1m]", effort: "medium" }, fallback: null, instructions: "" },
  monitor: {
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
  assert.equal(delegateSummary(profile()), "Fable 5.1 · Opus 5.5 · 1 fallback");
  const none = profile();
  none.delegate.planning.fallback = null;
  assert.equal(delegateSummary(none), "Fable 5.1 · Opus 5.5 · no fallbacks");

  assert.equal(teamsSummary(profile()), "Coordinator + monitor on the default model · members on the lead's model");
  assert.equal(teamsSummary(profile({ teams: teams(), members: claude("sonnet") })), "Coordinator on Opus 5.5 · monitor on deepseek-v4.1-flash · members on Sonnet 5.5");
  const blank = teams();
  blank.monitor.primary = { backend: "pi", model: "", effort: "low" };
  assert.equal(teamsSummary(profile({ teams: blank })), "Coordinator on Opus 5.5 · monitor on a model not chosen yet · members on the lead's model");

  assert.equal(specSummary(profile()), "Off · the session writes it");
  assert.equal(specSummary(profile({ specWriter: { primary: claude("sonnet"), fallback: null } })), "Sonnet 5.5");
  assert.equal(specSummary(profile({ specWriter: { primary: claude("sonnet"), fallback: claude("opus[1m]") } })), "Sonnet 5.5 · 1 fallback");

  // A profile without the key and one with None read alike: nothing reviews.
  assert.equal(reviewerSummary(profile()), "Off · no review");
  assert.equal(reviewerSummary(profile({ reviewer: null })), "Off · no review");
  assert.equal(reviewerSummary(profile({ reviewer: { primary: { backend: "pi", model: "openai-codex/gpt-6.1-sol", effort: "high" }, fallback: claude("opus[1m]", "high") } })), "gpt-6.1-sol · 1 fallback");
});

test("a summary names a model the way the list's footprint does", () => {
  for (const [id, short] of ([["opus[1m]", "Opus 5.5"], ["claude-fable-5-1[1m]", "Fable 5.1"], ["claude-sonnet-4-6", "Sonnet 4.6"], ["claude-code-cli/claude-haiku-4-5", "Haiku 4.5"], ["claude-opus-6", "claude-opus-6"], ["zai/glm-5.3", "glm-5.3"], ["ollama-cloud/deepseek-v4.1-flash", "deepseek-v4.1-flash"]] as [string, string][]))
    assert.equal(footprintModel(id), short, id);
  // The copy is the extension's rule: pin the two bodies together so neither drifts alone.
  const ext = readFileSync(new URL("../../pi-config/extensions/subagents/subagent-profiles.ts", import.meta.url), "utf8");
  const body = /export function shortModel\(model: string\): string \{([\s\S]*?)\n\}/.exec(ext)?.[1] ?? "";
  for (const line of ["const name = claudeName(model);", "if (name) return name;", 'model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model']) assert.ok(body.includes(line), `the extension's shortModel still has ${line}`);
});

test("Choose Models seeds both roles; Use Default Model puts both back on the chat's model", () => {
  const legacy = { version: 1, ...teams() } as TeamDefaults;
  const seed = teamsSeed(null, legacy)!;
  assert.deepEqual(seed, teams(), "the legacy defaults' roles and handover, without the file's version");
  const chosen = withChosenModels(profile(), seed);
  assert.deepEqual(chosen.teams, teams());
  assert.ok(chosen.teams !== seed, "the seed itself is not shared");
  assert.equal(withChosenModels(profile(), null).teams, null, "with nothing to seed from, nothing is chosen");
  const saved = teams();
  saved.coordinator.instructions = "keep me";
  assert.equal(teamsSeed(saved, legacy)!.coordinator.instructions, "keep me", "the profile's saved roles come back before the legacy defaults");
  assert.equal(teamsSeed(undefined, undefined), null);
  const kept = withChosenModels(profile({ teams: saved }), seed);
  assert.equal(kept.teams!.coordinator.instructions, "keep me", "a profile that has its roles keeps them");
  const back = withDefaultModel(profile({ teams: teams(), members: claude("sonnet") }));
  assert.equal(back.teams, null);
  assert.deepEqual(back.members, claude("sonnet"), "only the roles go back");
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

test("Alignment: the summary says what the profile overrides; Use host default stores no field, both store no key", async () => {
  const { alignmentSummary, withAlignment, sectionProblems } = await import("./subagent-editor");
  const p = profile({ teams: null });
  assert.equal(alignmentSummary(p), "Host default");
  const pm = withAlignment(p, { style: "pm" });
  assert.deepEqual(pm.alignment, { style: "pm" });
  assert.equal(alignmentSummary(pm), "Project manager");
  const both = withAlignment(pm, { visuals: true });
  assert.equal(alignmentSummary(both), "Project manager · visuals on");
  assert.equal(alignmentSummary(withAlignment(p, { visuals: false })), "visuals off");
  const back = withAlignment(withAlignment(both, { style: "host" }), { visuals: "host" });
  assert.equal("alignment" in back, false, "both on Use host default: no key, as before the field existed");
  assert.equal("alignment" in p, false, "the input is never changed");
  assert.equal(sectionProblems(both).has("alignment"), false, "a choice is always valid: the section never holds Save");
  // Eagerness (§chat.alignment/eagerness): first in the summary, field by field like the others.
  const careful = withAlignment(both, { eagerness: "careful" });
  assert.deepEqual(careful.alignment, { style: "pm", visuals: true, eagerness: "careful" });
  assert.equal(alignmentSummary(careful), "Careful · Project manager · visuals on");
  assert.equal(alignmentSummary(withAlignment(p, { eagerness: "eager" })), "Eager", "Eager over a Careful host is an override too");
  const onlyEagerness = withAlignment(withAlignment(careful, { style: "host" }), { visuals: "host" });
  assert.deepEqual(onlyEagerness.alignment, { eagerness: "careful" }, "the Eagerness alone keeps the key");
  assert.equal("alignment" in withAlignment(onlyEagerness, { eagerness: "host" }), false, "all three on Use host default: no key");
});
