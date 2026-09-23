// Run: npx tsx --test src/lib/provider-groups.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelInfo } from "../../shared/protocol";
import { EMPTY_POLICY, providerEnabled } from "./model-policy";
import { providerGrouper, type PolicyProviders } from "./provider-groups";

const model = (ref: string): ModelInfo => ({
  ref,
  provider: ref.slice(0, ref.indexOf("/")),
  id: ref.slice(ref.indexOf("/") + 1),
  favorite: false,
  thinkingLevels: ["off"],
});
const lead = { provider: "claude-code", models: [], note: "Claude Code workers" };
const policy = (over: Partial<PolicyProviders> = {}): PolicyProviders => ({
  disabledProviders: [],
  subagentDisabledProviders: [],
  ...over,
});
/** The row at `i`, which the test has just established is there. */
const row = <T>(rows: T[], i: number): T => {
  const r = rows[i];
  assert.ok(r, `no row ${i}`);
  return r;
};
const models = [model("zai/glm-5"), model("openai/gpt-5"), model("anthropic/opus"), model("openai/gpt-4")];

test("groups: Claude Code first, providers name-sorted with id-sorted models, then policy-only names", () => {
  const g = providerGrouper(lead);
  const rows = g.withPolicy(g.byModels(models), policy({ disabledProviders: ["Ollama"], subagentDisabledProviders: ["openai", "bedrock"] }));
  assert.deepEqual(
    rows.map((r) => [r.provider, r.models.map((m) => m.id), r.note]),
    [
      ["claude-code", [], "Claude Code workers"],
      ["anthropic", ["opus"], undefined],
      ["openai", ["gpt-4", "gpt-5"], undefined],
      ["zai", ["glm-5"], undefined],
      ["bedrock", [], "No models on this machine"],
      ["ollama", [], "No models on this machine"],
    ],
  );
});

test("a switch that turns one provider off keeps every group and models array the same object", () => {
  const g = providerGrouper(lead);
  const base = g.byModels(models);
  const before = g.withPolicy(base, policy());
  // The switch: the policy changes, the model list does not — so only the policy memo re-runs.
  const next = policy({ disabledProviders: ["openai"] });
  const after = g.withPolicy(g.byModels(models), next);
  // What the switch changed lives in the policy the rows read, not in the groups.
  assert.equal(providerEnabled({ ...EMPTY_POLICY, ...next }, "openai"), false);
  assert.equal(providerEnabled({ ...EMPTY_POLICY, ...next }, "anthropic"), true);
  assert.equal(after.length, before.length, "turning a provider with models off adds no row");
  for (let i = 0; i < before.length; i++) {
    assert.strictEqual(row(after, i), row(before, i), `group ${row(before, i).provider} was rebuilt by a policy change`);
    assert.strictEqual(row(after, i).models, row(before, i).models, `${row(before, i).provider}'s models array was rebuilt by a policy change`);
  }
});

test("a switch on a provider with no models changes only its own row; every other group keeps its identity", () => {
  const g = providerGrouper(lead);
  const off = policy({ disabledProviders: ["ollama"], subagentDisabledProviders: ["bedrock"] });
  const before = g.withPolicy(g.byModels(models), off);
  const after = g.withPolicy(g.byModels(models), policy({ subagentDisabledProviders: ["bedrock"] }));
  assert.deepEqual(before.map((r) => r.provider), ["claude-code", "anthropic", "openai", "zai", "bedrock", "ollama"]);
  assert.deepEqual(after.map((r) => r.provider), ["claude-code", "anthropic", "openai", "zai", "bedrock"], "turning ollama back on drops its policy-only row");
  for (let i = 0; i < after.length; i++) {
    assert.strictEqual(row(after, i), row(before, i), `group ${row(after, i).provider} was rebuilt by a policy change`);
    assert.strictEqual(row(after, i).models, row(before, i).models, `${row(after, i).provider}'s models array was rebuilt by a policy change`);
  }
});

test("a provider whose model list changes gets a new group and array; the others keep theirs", () => {
  const g = providerGrouper(lead);
  const before = g.byModels(models);
  const openai = before.findIndex((r) => r.provider === "openai");
  const grown = g.byModels([...models, model("openai/gpt-6")]);
  assert.notStrictEqual(row(grown, openai), row(before, openai), "openai gained a model but kept its stale group");
  assert.notStrictEqual(row(grown, openai).models, row(before, openai).models, "openai gained a model but kept its stale models array");
  assert.deepEqual(row(grown, openai).models.map((m) => m.id), ["gpt-4", "gpt-5", "gpt-6"]);
  for (let i = 0; i < before.length; i++)
    if (i !== openai) assert.strictEqual(row(grown, i), row(before, i), `group ${row(before, i).provider} was rebuilt though its models did not change`);

  // A refetch that hands back new objects for the same refs is fresh data, not the same list.
  const refetched = g.byModels(models.map((m) => (m.provider === "zai" ? { ...m } : m)));
  const zai = refetched.findIndex((r) => r.provider === "zai");
  assert.notStrictEqual(row(refetched, zai), row(grown, zai), "zai's models were replaced but its group was reused");
  assert.notStrictEqual(row(refetched, zai).models, row(grown, zai).models, "zai's models were replaced but its models array was reused");
});

test("a provider that leaves and returns is rebuilt, not revived from the cache", () => {
  const g = providerGrouper(lead);
  const before = g.byModels(models);
  const zai = before.findIndex((r) => r.provider === "zai");
  g.byModels(models.filter((m) => m.provider !== "zai"));
  const back = g.byModels(models);
  assert.notStrictEqual(row(back, zai), row(before, zai));
  assert.deepEqual(row(back, zai).models.map((m) => m.ref), ["zai/glm-5"]);
});
