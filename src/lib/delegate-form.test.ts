import assert from "node:assert/strict";
import { test } from "node:test";
import type { DelegateOptions, DelegateSettings, DelegateSettingsInfo } from "../../shared/protocol";
import {
  cloneSettings,
  draftComplete,
  draftConflicts,
  effortSelectOptions,
  fallbackFor,
  modelSelectOptions,
  sameSettings,
  slotIssue,
  withBackend,
  withModel,
  type DraftChoice,
} from "./delegate-form";

const claude = (model: string, effort: string): DraftChoice => ({ backend: "claude-code", model, effort });
const defaults: DelegateSettings = {
  version: 1,
  profiles: {
    planning: { primary: claude("claude-fable-5-1[1m]", "medium"), fallback: claude("opus[1m]", "high") },
    investigation: { primary: claude("opus[1m]", "low"), fallback: null },
    routine: { primary: claude("opus[1m]", "low"), fallback: null },
    complex: { primary: claude("opus[1m]", "medium"), fallback: null },
  },
};
const info: DelegateSettingsInfo = {
  settings: defaults,
  defaults,
  profiles: [],
  backends: [
    { id: "pi", label: "pi", efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
    { id: "claude-code", label: "Claude Code", efforts: ["low", "medium", "high", "xhigh", "max"] },
  ],
  file: "/home/u/.pi/agent/mode-delegate.json",
};
const options: DelegateOptions = {
  backends: [
    { id: "pi", label: "pi", models: [{ id: "zai/glm-5.3", name: "zai/glm-5.3", efforts: ["off", "low", "high"] }], sessionScopedProviders: ["claude-code-cli"] },
    {
      id: "claude-code",
      label: "Claude Code",
      models: [
        { id: "claude-fable-5-1[1m]", name: "Fable", efforts: ["low", "medium", "high"] },
        { id: "opus[1m]", name: "Opus", efforts: ["low", "medium", "high", "xhigh", "max"], denied: "claude-code is off for subagents in Settings → Models" },
      ],
    },
  ],
};
const claudeDown: DelegateOptions = {
  backends: [options.backends[0]!, { id: "claude-code", label: "Claude Code", models: null, error: "The Claude Code CLI did not list its models within 15s" }],
};

test("changing the backend never picks a model or an effort for the user", () => {
  assert.deepEqual(withBackend(claude("opus[1m]", "low"), "pi"), { backend: "pi", model: "", effort: "" });
  const same = claude("opus[1m]", "low");
  assert.equal(withBackend(same, "claude-code"), same, "the same backend changes nothing");
});

test("changing the model keeps the effort only when the new model takes it", () => {
  assert.equal(withModel(claude("opus[1m]", "medium"), "claude-fable-5-1[1m]", options).effort, "medium");
  assert.equal(withModel(claude("opus[1m]", "max"), "claude-fable-5-1[1m]", options).effort, "", "fable doesn't take max: blank, not clamped");
  assert.equal(withModel(claude("opus[1m]", "max"), "some-alias", claudeDown).effort, "max", "can't be checked: kept");
});

test("the model select always shows the stored pick, and never calls an unverified one gone", () => {
  assert.deepEqual(modelSelectOptions(options, claude("opus[1m]", "low")).map((o) => o.label), [
    "claude-fable-5-1[1m]",
    "opus[1m] — off for subagents",
  ]);
  assert.deepEqual(modelSelectOptions(options, claude("retired", "low"))[0], { value: "retired", label: "retired — not offered" });
  assert.deepEqual(modelSelectOptions(claudeDown, claude("opus[1m]", "low")), [{ value: "opus[1m]", label: "opus[1m] — not verified" }]);
  assert.deepEqual(modelSelectOptions(undefined, claude("opus[1m]", "low")), [{ value: "opus[1m]", label: "opus[1m] — not verified" }], "still asking");
  assert.deepEqual(modelSelectOptions(options, { backend: "pi", model: "", effort: "" }), [{ value: "zai/glm-5.3", label: "zai/glm-5.3" }], "nothing chosen: nothing injected");
});

test("the effort select offers what the model takes, else what the backend accepts", () => {
  assert.deepEqual(effortSelectOptions(info, options, claude("claude-fable-5-1[1m]", "medium")), ["low", "medium", "high"]);
  assert.deepEqual(effortSelectOptions(info, options, claude("claude-fable-5-1[1m]", "max")), ["max", "low", "medium", "high"], "the stored value stays visible");
  assert.deepEqual(effortSelectOptions(info, claudeDown, claude("opus[1m]", "low")), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(effortSelectOptions(info, options, { backend: "pi", model: "zai/glm-5.3", effort: "high" }), ["off", "low", "high"]);
});

test("each row says what the server's save check would", () => {
  const issue = (choice: DraftChoice, opts: DelegateOptions | undefined = options, other: DraftChoice | null = null, slot: "primary" | "fallback" = "primary") =>
    slotIssue(info, opts, choice, other, slot);
  assert.equal(issue(claude("claude-fable-5-1[1m]", "medium")), null);
  assert.deepEqual(issue(claude("gone", "low")), { tone: "error", text: "Claude Code doesn't offer gone." });
  assert.deepEqual(issue(claude("claude-fable-5-1[1m]", "max")), { tone: "error", text: "claude-fable-5-1[1m] doesn't take max effort." });
  assert.deepEqual(issue(claude("opus[1m]", "low")), { tone: "warn", text: "claude-code is off for subagents in Settings → Models. Delegate uses the fallback, or asks." });
  assert.deepEqual(issue(claude("gone", "low"), claudeDown), {
    tone: "muted",
    text: "Not verified: Claude Code couldn't list its models.",
  });
  assert.equal(slotIssue(info, undefined, claude("gone", "low"), null, "primary"), null, "while asking, nothing is claimed");
  assert.deepEqual(issue({ backend: "pi", model: "", effort: "" }), { tone: "muted", text: "Choose a model." });
  assert.deepEqual(issue({ backend: "pi", model: "zai/glm-5.3", effort: "" }), { tone: "muted", text: "Choose an effort." });
  const primary = claude("claude-fable-5-1[1m]", "medium");
  assert.equal(issue(primary, options, primary, "fallback")?.tone, "error", "a fallback identical to its primary");
  const scoped: DraftChoice = { backend: "pi", model: "claude-code-cli/claude-opus-5", effort: "high" };
  assert.deepEqual(issue(scoped), { tone: "muted", text: "Not verified: claude-code-cli models exist only in sessions started with that provider on." });
  assert.deepEqual(modelSelectOptions(options, scoped)[0], { value: scoped.model, label: `${scoped.model} — not verified` });
  assert.equal(issue({ backend: "pi", model: "zai/glm-9", effort: "high" })?.tone, "error", "other providers' absence is still an answer");
});

test("the form saves only when complete, and knows when it has changed", () => {
  const draft = cloneSettings(defaults);
  assert.notEqual(draft, defaults);
  assert.ok(sameSettings(draft, defaults));
  assert.ok(draftComplete(draft));
  draft.profiles.routine.primary = withBackend(draft.profiles.routine.primary, "pi");
  assert.ok(!sameSettings(draft, defaults));
  assert.ok(!draftComplete(draft), "a blank model blocks the save");
  draft.profiles.routine.primary = { backend: "pi", model: "zai/glm-5.3", effort: "low" };
  assert.ok(draftComplete(draft));
  draft.profiles.complex.fallback = fallbackFor(draft.profiles.complex.primary, true);
  assert.deepEqual(draft.profiles.complex.fallback, { backend: "claude-code", model: "", effort: "" }, "a new fallback starts blank on the primary's backend");
  assert.ok(!draftComplete(draft));
  draft.profiles.complex.fallback = fallbackFor(draft.profiles.complex.primary, false);
  assert.equal(draft.profiles.complex.fallback, null);
  assert.ok(draftComplete(draft));
  assert.deepEqual(draftConflicts(draft), []);
  draft.profiles.planning.fallback = { ...draft.profiles.planning.primary };
  assert.deepEqual(draftConflicts(draft), ["planning"], "a fallback that is its own primary blocks the save");
  draft.profiles.planning.fallback = { backend: "claude-code", model: "", effort: "" };
  assert.deepEqual(draftConflicts(draft), [], "a blank fallback is incomplete, not a conflict");
  assert.ok(!sameSettings(cloneSettings(defaults), { ...defaults, profiles: { ...defaults.profiles, planning: { ...defaults.profiles.planning, fallback: null } } }));
});
