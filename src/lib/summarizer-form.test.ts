// Run: npx tsx --test src/lib/summarizer-form.test.ts
//
// The one rule here worth pinning: a summarizer obeys the policy's GLOBAL dimension only. A model
// that is off for subagents still summarizes, so the form must not warn about it — and a model
// turned off outright is skipped, so the form must.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DelegateOptions } from "../../shared/protocol";
import { EMPTY_POLICY } from "./model-policy";
import { summarizerDenial, summarizerIssue, summarizerModelOptions } from "./summarizer-form";

const OPTIONS: DelegateOptions = {
  backends: [
    {
      id: "pi",
      label: "pi",
      sessionScopedProviders: ["claude-code-cli"],
      models: [
        { id: "ollama-cloud/deepseek-v4.1-flash", name: "", efforts: [] },
        { id: "openai/gpt-x", name: "", efforts: [], denied: "openai/gpt-x is off for subagents in Settings → Models" },
      ],
    },
    { id: "claude-code", label: "Claude Code", models: [{ id: "haiku", name: "Haiku", efforts: [] }] },
  ],
};

test("off for subagents is not a summarizer denial; off outright is", () => {
  const subagentsOnly = { ...EMPTY_POLICY, subagentDisabledModels: ["openai/gpt-x"], subagentDisabledProviders: ["claude-code"] };
  assert.equal(summarizerDenial(subagentsOnly, { backend: "pi", model: "openai/gpt-x" }), null);
  assert.equal(summarizerDenial(subagentsOnly, { backend: "claude-code", model: "haiku" }), null);
  assert.equal(summarizerIssue(OPTIONS, subagentsOnly, { backend: "pi", model: "openai/gpt-x" }, null), null);

  assert.match(summarizerDenial({ ...EMPTY_POLICY, disabledModels: ["OpenAI/GPT-X"] }, { backend: "pi", model: "openai/gpt-x" }) ?? "", /turned off/);
  assert.match(summarizerDenial({ ...EMPTY_POLICY, disabledProviders: ["openai"] }, { backend: "pi", model: "openai/gpt-x" }) ?? "", /openai is turned off/);
  // A Claude Code model is off under its bare id, its prefixed ref, or the backend as a provider.
  for (const policy of [
    { ...EMPTY_POLICY, disabledModels: ["haiku"] },
    { ...EMPTY_POLICY, disabledModels: ["claude-code/haiku"] },
    { ...EMPTY_POLICY, disabledProviders: ["claude-code"] },
  ])
    assert.ok(summarizerDenial(policy, { backend: "claude-code", model: "haiku" }), JSON.stringify(policy));
  // A bare model id never matches a pi ref's model half.
  assert.equal(summarizerDenial({ ...EMPTY_POLICY, disabledModels: ["gpt-x"] }, { backend: "pi", model: "openai/gpt-x" }), null);
});

test("a denied pick says it's skipped", () => {
  const policy = { ...EMPTY_POLICY, disabledModels: ["haiku"] };
  const issue = summarizerIssue(OPTIONS, policy, { backend: "claude-code", model: "haiku" }, null);
  assert.equal(issue?.tone, "warn");
  assert.match(issue!.text, /skip it/);
  assert.deepEqual(
    summarizerModelOptions(OPTIONS, policy, { backend: "claude-code", model: "haiku" }).map((o) => o.label),
    ["haiku — turned off"],
  );
});

test("the stored pick is always in the select, and absence reads per backend", () => {
  const labels = (backend: "pi" | "claude-code", model: string) =>
    summarizerModelOptions(OPTIONS, EMPTY_POLICY, { backend, model }).map((o) => o.label);
  assert.equal(labels("pi", "gone/model")[0], "gone/model — not offered");
  assert.equal(labels("pi", "claude-code-cli/opus")[0], "claude-code-cli/opus — not verified");
  assert.equal(labels("claude-code", "opus[1m]")[0], "opus[1m] — not verified");
  assert.deepEqual(labels("pi", "ollama-cloud/deepseek-v4.1-flash"), ["ollama-cloud/deepseek-v4.1-flash", "openai/gpt-x"]);
  assert.equal(summarizerIssue(OPTIONS, EMPTY_POLICY, { backend: "pi", model: "gone/model" }, null)?.tone, "error");
  assert.equal(summarizerIssue(OPTIONS, EMPTY_POLICY, { backend: "claude-code", model: "opus" }, null)?.tone, "muted");
  // Before the options arrive nothing is claimed either way.
  assert.equal(summarizerIssue(undefined, EMPTY_POLICY, { backend: "pi", model: "gone/model" }, null), null);
});

test("a blank pick asks for a model; a fallback equal to the primary is refused", () => {
  assert.equal(summarizerIssue(OPTIONS, null, { backend: "pi", model: "" }, null)?.text, "Choose a model.");
  const primary = { backend: "claude-code" as const, model: "haiku" };
  assert.equal(summarizerIssue(OPTIONS, null, { ...primary }, primary)?.tone, "error");
});
