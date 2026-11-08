import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { profileNameIssue, profilesProblem, type LibraryDraft } from "./subagent-profiles-draft";
import type { SubagentProfile, TeamsSetting } from "../../shared/subagent-profiles";
import type { WorkerChoice } from "../../shared/protocol";

const worker = (model: string, effort = "medium"): WorkerChoice => ({ backend: "pi", model, effort });
const claude = (model: string, effort = "medium"): WorkerChoice => ({ backend: "claude-code", model, effort });
/** A teams tuple: like the wire's, effort is the union. */
type TupleEffort = TeamsSetting["coordinator"]["primary"]["effort"];
const tclaude = (model: string, effort: TupleEffort = "medium"): TeamsSetting["coordinator"]["primary"] => ({ backend: "claude-code", model, effort });
const tpi = (model: string, effort: TupleEffort = "medium"): TeamsSetting["coordinator"]["primary"] => ({ backend: "pi", model, effort });

/** A profile that passes: two profiles must differ ONLY in the field under test. */
function validProfile(over: Partial<SubagentProfile> = {}): SubagentProfile {
  return {
    id: "my-setup",
    name: "My setup",
    delegate: {
      planning: { primary: claude("opus[1m]", "medium"), fallback: claude("claude-fable-5-1[1m]", "medium") },
      investigation: { primary: claude("opus[1m]", "low"), fallback: null },
      routine: { primary: claude("opus[1m]", "low"), fallback: null },
      complex: { primary: claude("opus[1m]", "medium"), fallback: null },
    },
    teams: null,
    members: null,
    specWriter: null,
    ...over,
  };
}

const file = (profiles: SubagentProfile[], def = profiles[0]?.id ?? "off"): LibraryDraft => ({ version: 1, default: def, profiles });

test("a complete draft has no problem to say", () => {
  assert.equal(profilesProblem(file([validProfile()])), null);
  assert.equal(profilesProblem(file([] , "off")), null, "no profiles at all is a file the library allows (default off)");
});

test("names: unique, single-line, never Off — each form of badness is its own", () => {
  assert.equal(profilesProblem(file([validProfile({ name: "off" })])), `Profiles: Profile name can't be "Off", the built-in profile's.`);
  assert.match(profilesProblem(file([validProfile({ name: "  padded" })]))!, /one line, with no spaces/);
  assert.match(profilesProblem(file([validProfile({ name: "two\nlines" })]))!, /one line, with no spaces/);
  assert.equal(profilesProblem(file([validProfile({ name: "x".repeat(49) })])), "Profiles: Profile name can be at most 48 characters.");
  assert.equal(profilesProblem(file([validProfile({ name: "" })])), "Profiles: Profile name can't be empty.");
  const two = file([validProfile(), validProfile({ id: "other", name: "my SETUP" })]);
  assert.equal(profilesProblem(two), "Profiles: Another profile has this name.", "uniqueness ignores case, like the file's own rule");
});

test("a fallback that is its primary is refused in the form, as the server refuses it", () => {
  const p = validProfile();
  p.delegate.routine = { primary: claude("opus[1m]", "low"), fallback: claude("opus[1m]", "low") };
  assert.match(profilesProblem(file([p]))!, /fallback is its primary/);
  // A fallback that differs only in effort is a DIFFERENT worker choice and passes.
  const q = validProfile();
  q.delegate.routine = { primary: claude("opus[1m]", "low"), fallback: claude("opus[1m]", "high") };
  assert.equal(profilesProblem(file([q])), null);
});

test("every chosen row needs a model and an effort, whichever section it sits in", () => {
  const delegated = validProfile();
  delegated.delegate.complex.primary = claude("", "");
  assert.match(profilesProblem(file([delegated]))!, /model and an effort/);
  // Members have no row (they follow Delegate's work kinds): a saved incomplete value never holds Save.
  const members = validProfile({ members: { backend: "pi", model: "zai/glm-5.3", effort: "" } });
  assert.equal(profilesProblem(file([members])), null);
  const teams = validProfile({
    teams: {
      coordinator: { role: "coordinator", primary: tclaude("opus[1m]", "" as TupleEffort), fallback: null, instructions: "" },
      monitor: { role: "monitor", primary: tpi("zai/glm-5.3", "low"), fallback: null, contextPct: 60, everyMinutes: 10, usage: { enabled: true, pausePct: 90, resumeMarginMinutes: 5 }, instructions: "" },
      handover: { retireTimeoutMinutes: 10 },
    },
  });
  assert.match(profilesProblem(file([teams]))!, /Coordinator rows each need a model and an effort/);
});

test("teams thresholds and role names are checked before the server ever sees them", () => {
  const teams = {
    coordinator: { role: "coordinator", primary: tclaude("opus[1m]", "medium"), fallback: null, instructions: "" },
    monitor: { role: "monitor", primary: tpi("zai/glm-5.3", "low"), fallback: null, contextPct: 60, everyMinutes: 10, usage: { enabled: true, pausePct: 90, resumeMarginMinutes: 5 }, instructions: "" },
    handover: { retireTimeoutMinutes: 10 },
  };
  assert.equal(profilesProblem(file([validProfile({ teams: structuredClone(teams) })])), null, "the defaults themselves pass");
  for (const [path, bad] of [
    ["contextPct", 0],
    ["contextPct", 101],
    ["contextPct", 59.5],
    ["everyMinutes", 0],
    ["everyMinutes", 1441],
  ] as const) {
    const t = structuredClone(teams);
    (t.monitor as unknown as Record<string, number>)[path] = bad;
    assert.match(profilesProblem(file([validProfile({ teams: t })]))!, /must be a whole number from \d+ to [\d,]+\.$/, `${path}=${bad} is refused`);
  }
  const blank = structuredClone(teams);
  (blank.monitor as unknown as Record<string, string>).everyMinutes = ""; // the draft holds the box's text
  assert.equal(profilesProblem(file([validProfile({ teams: blank })])), "Profiles: Check every (minutes) must be a whole number from 1 to 1,440.");
  const role = structuredClone(teams);
  role.monitor.role = "  ";
  assert.equal(profilesProblem(file([validProfile({ teams: role })])), "Profiles: Name the role.");
  role.monitor.role = "x".repeat(65);
  assert.equal(profilesProblem(file([validProfile({ teams: role })])), "Profiles: Monitor role name can be at most 64 characters.");
  const same = structuredClone(teams);
  same.monitor.role = "Coordinator";
  assert.match(profilesProblem(file([validProfile({ teams: same })]))!, /different role names/, "coordinator and monitor are two roles, never one");
});

test("the editor's worker rows are wired live, never as a mount-time snapshot", () => {
  // Regression pin (e2e blocker): a <Show> callback body runs ONCE, so `tuple("members", c(), …)`
  // froze the row on the toggle's initial state — Effort stayed disabled and the draft never
  // updated. The factories take thunks, and the callbacks hand over the Show's accessor itself.
  const src = readFileSync(new URL("../components/SubagentProfilesSettings.tsx", import.meta.url), "utf8");
  assert.match(src, /const tuple = \(\s*role: string,\s*choice: \(\) => WorkerChoice/, "tuple's choice is a thunk");
  assert.match(src, /const pair = \(role: string, choice: \(\) => \{/, "pair's choice is a thunk");
  assert.doesNotMatch(src, /tuple\("members"|\.members\b|"Members"/, "no Members row, switch or read in the editor");
  assert.match(src, /\(w\) => \([^()]*?<>[\s\S]{0,400}?pair\("spec", w,/, "spec writer hands over the Show's accessor");
  assert.match(src, /\(f\) => \(\s*<>[\s\S]{0,120}?\{tuple\(role, f,/, "pair's fallback row hands over the Show's accessor");
  assert.doesNotMatch(src, /\((\w)\) => (?:tuple|pair)\([^)]*?\1\(\)/, "no callback reads its accessor at mount time");
});

test("the name box says why its name holds Save (Settings QA D11): the edited profile's name only", () => {
  const two = file([validProfile(), validProfile({ id: "other", name: "Other" })]);
  assert.equal(profileNameIssue(two, "my-setup"), null);
  for (const name of ["   ", "  padded", "off", "two\nlines", "other"]) {
    const d = file([validProfile({ name }), validProfile({ id: "other", name: "Other" })]);
    assert.notEqual(profileNameIssue(d, "my-setup"), null, JSON.stringify(name));
    assert.equal(profileNameIssue(d, "other") !== null, name === "other", `the other profile's box only for a clash: ${JSON.stringify(name)}`);
  }
});

test("a pasted name over 48 characters stays whole in the draft, and Save waits (Settings QA D10)", () => {
  const d = file([validProfile({ name: "x".repeat(300) })]);
  assert.equal(d.profiles[0]!.name.length, 300, "nothing cuts it");
  assert.equal(profilesProblem(d), "Profiles: Profile name can be at most 48 characters.");
  // The box is not capped by the browser: a cut there is silent.
  assert.doesNotMatch(readFileSync(new URL("../components/SubagentProfilesSettings.tsx", import.meta.url), "utf8"), /maxlength/);
});
