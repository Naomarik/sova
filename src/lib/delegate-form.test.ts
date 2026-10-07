import assert from "node:assert/strict";
import { test } from "node:test";
import type { DelegateOptions, DelegateSettings, DelegateSettingsInfo } from "../../shared/protocol";
import {
  claudeDriftNotes,
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
    planning: { primary: claude("claude-fable-5-1", "medium"), fallback: claude("claude-opus-5-5", "high") },
    investigation: { primary: claude("claude-opus-5-5", "low"), fallback: null },
    routine: { primary: claude("claude-opus-5-5", "low"), fallback: null },
    complex: { primary: claude("claude-opus-5-5", "medium"), fallback: null },
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
        { id: "claude-fable-5-1", name: "Fable 5.1", efforts: ["low", "medium", "high"] },
        { id: "claude-opus-5-5", name: "Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"], denied: "claude-code is off for subagents in Settings → Models" },
      ],
    },
  ],
};
const claudeDown: DelegateOptions = {
  backends: [options.backends[0]!, { id: "claude-code", label: "Claude Code", models: null, error: "The Claude Code CLI did not list its models within 15s" }],
};

test("changing the backend never picks a model or an effort for the user", () => {
  assert.deepEqual(withBackend(claude("claude-opus-5-5", "low"), "pi"), { backend: "pi", model: "", effort: "" });
  const same = claude("claude-opus-5-5", "low");
  assert.equal(withBackend(same, "claude-code"), same, "the same backend changes nothing");
});

test("changing the model keeps the effort only when the new model takes it", () => {
  assert.equal(withModel(claude("claude-opus-5-5", "medium"), "claude-fable-5-1", options).effort, "medium");
  assert.equal(withModel(claude("claude-opus-5-5", "max"), "claude-fable-5-1", options).effort, "", "fable doesn't take max: blank, not clamped");
  assert.equal(withModel(claude("claude-opus-5-5", "max"), "some-id", claudeDown).effort, "max", "can't be checked: kept");
});

test("the model select always shows the stored pick, and never calls an unverified one gone", () => {
  // A Claude model reads its catalog name, its id in the title (§app.claude-code-provider/model-names).
  assert.deepEqual(modelSelectOptions(options, claude("claude-opus-5-5", "low")), [
    { value: "claude-fable-5-1", label: "Fable 5.1", title: "claude-fable-5-1" },
    { value: "claude-opus-5-5", label: "Opus 5.5 — off for subagents", title: "claude-opus-5-5" },
  ]);
  assert.deepEqual(modelSelectOptions(options, claude("retired", "low"))[0], { value: "retired", label: "retired — not verified" }, "an id the catalog doesn't know is not gone");
  assert.deepEqual(modelSelectOptions(options, claude("bad/alias", "low"))[0], { value: "bad/alias", label: "bad/alias — not offered" }, "a shape-invalid Claude id is");
  assert.deepEqual(modelSelectOptions(options, { backend: "pi", model: "zai/glm-9", effort: "low" })[0], { value: "zai/glm-9", label: "zai/glm-9 — not offered" }, "pi's registry is an answer");
  assert.deepEqual(modelSelectOptions(claudeDown, claude("claude-opus-5-5", "low")), [{ value: "claude-opus-5-5", label: "claude-opus-5-5 — not verified" }]);
  assert.deepEqual(modelSelectOptions(undefined, claude("claude-opus-5-5", "low")), [{ value: "claude-opus-5-5", label: "claude-opus-5-5 — not verified" }], "still asking");
  assert.deepEqual(modelSelectOptions(options, { backend: "pi", model: "", effort: "" }), [{ value: "zai/glm-5.3", label: "zai/glm-5.3" }], "nothing chosen: nothing injected");
});

test("the effort select offers what the model takes, else what the backend accepts", () => {
  assert.deepEqual(effortSelectOptions(info, options, claude("claude-fable-5-1", "medium")), ["low", "medium", "high"]);
  assert.deepEqual(effortSelectOptions(info, options, claude("claude-fable-5-1", "max")), ["max", "low", "medium", "high"], "the stored value stays visible");
  assert.deepEqual(effortSelectOptions(info, claudeDown, claude("claude-opus-5-5", "low")), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(effortSelectOptions(info, options, { backend: "pi", model: "zai/glm-5.3", effort: "high" }), ["off", "low", "high"]);
});

test("each row says what the server's save check would", () => {
  const issue = (choice: DraftChoice, opts: DelegateOptions | undefined = options, other: DraftChoice | null = null, slot: "primary" | "fallback" = "primary") =>
    slotIssue(info, opts, choice, other, slot);
  assert.equal(issue(claude("claude-fable-5-1", "medium")), null);
  assert.deepEqual(issue(claude("gone", "low")), { tone: "muted", text: "Not verified: gone is not in Sova's Claude catalog. It will still be used." });
  assert.deepEqual(issue(claude("bad/alias", "low")), { tone: "error", text: "Claude Code doesn't offer bad/alias." }, "only a shape-invalid Claude id is an error");
  assert.deepEqual(issue(claude("claude-fable-5-1", "max")), { tone: "error", text: "claude-fable-5-1 doesn't take max effort." });
  assert.deepEqual(issue(claude("claude-opus-5-5", "low")), { tone: "warn", text: "claude-code is off for subagents in Settings → Models. Delegate uses the fallback, or asks." });
  assert.deepEqual(
    slotIssue(info, options, claude("claude-opus-5-5", "low"), null, "primary", "Exploring", false),
    { tone: "warn", text: "claude-code is off for subagents in Settings → Models." },
    "a row with no fallback never promises one",
  );
  assert.deepEqual(issue(claude("gone", "low"), claudeDown), {
    tone: "muted",
    text: "Not verified: Claude Code couldn't list its models.",
  });
  assert.equal(slotIssue(info, undefined, claude("gone", "low"), null, "primary"), null, "while asking, nothing is claimed");
  assert.deepEqual(issue({ backend: "pi", model: "", effort: "" }), { tone: "muted", text: "Choose a model." });
  assert.deepEqual(issue({ backend: "pi", model: "zai/glm-5.3", effort: "" }), { tone: "muted", text: "Choose an effort." });
  const primary = claude("claude-fable-5-1", "medium");
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

test("an old Claude id counts as listed when the catalog lists the model it means", () => {
  const listsBase: DelegateOptions = {
    backends: [
      { id: "pi", label: "pi", models: [{ id: "zai/glm-5.3", name: "zai/glm-5.3", efforts: ["low", "high"] }] },
      { id: "claude-code", label: "Claude Code", models: [{ id: "claude-opus-5-5", name: "Opus 5.5", efforts: ["low", "high"] }] },
    ],
  };
  const pick = claude("opus[1m]", "high");
  assert.equal(slotIssue(info, listsBase, pick, null, "primary"), null);
  assert.deepEqual(modelSelectOptions(listsBase, pick)[0], { value: "opus[1m]", label: "Opus 5.5", title: "opus[1m]" });
  assert.equal(withModel(claude("claude-opus-5-5", "high"), "opus[1m]", listsBase).effort, "high");
  // The catalog model's efforts still apply.
  assert.equal(slotIssue(info, listsBase, claude("opus[1m]", "max"), null, "primary")?.tone, "error");
  // An id the catalog doesn't know reads not verified.
  assert.equal(slotIssue(info, listsBase, claude("claude-opus-6", "high"), null, "primary")?.tone, "muted");
  assert.equal(modelSelectOptions(listsBase, claude("claude-opus-6", "high"))[0]!.label, "claude-opus-6 — not verified");
  // Only Claude Code: a pi ref ending in [1m] is not its base.
  const pi = { backend: "pi" as const, model: "zai/glm-5.3[1m]", effort: "low" };
  assert.equal(slotIssue(info, listsBase, pi, null, "primary")?.tone, "error");
  assert.equal(modelSelectOptions(listsBase, pi)[0]!.label, "zai/glm-5.3[1m] — not offered");
});

test("the CLI's drift is one quiet sentence each; nothing when it agrees or wasn't read", () => {
  assert.deepEqual(claudeDriftNotes(undefined), []);
  assert.deepEqual(claudeDriftNotes(options), []);
  const drifted: DelegateOptions = {
    backends: [options.backends[0]!, { ...options.backends[1]!, drift: { unknown: [{ id: "claude-opus-6", name: "Opus 6" }], moved: [{ family: "opus", id: "claude-opus-6", current: "claude-opus-5-5" }] } }],
  };
  assert.deepEqual(claudeDriftNotes(drifted), [
    "Claude Code offers Opus 6 (claude-opus-6), which Sova's catalog doesn't know yet.",
    "Claude Code now runs opus as claude-opus-6; Sova's catalog still says Opus 5.5.",
  ]);
});
