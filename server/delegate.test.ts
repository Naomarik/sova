// Run: npx tsx --test server/delegate.test.ts (or npm test). Writes only under a mkdtemp dir; no CLI runs.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import type { DelegateSettings, ModelPolicy } from "../shared/protocol";
import type { ClaudeModel } from "./claude-models";
import { claudeOffer } from "../pi-config/extensions/claude-code/catalog.ts";
import {
  cachedClaudeModels,
  checkChoice,
  delegateInfo,
  delegateOptions,
  resetClaudeCache,
  saveDelegateSettings,
  workerDenial,
  type DelegateSources,
} from "./delegate";

const dir = mkdtempSync(join(tmpdir(), "sova-delegate-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => join(dir, `mode-delegate-${++n}.json`);

const EMPTY: ModelPolicy = { disabledProviders: [], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [] };
const ALL_CLAUDE = ["low", "medium", "high", "xhigh", "max"];
/** The CLI's initialize list (claude 2.1.289): read for drift only, never offered. */
const cliList: ClaudeModel[] = [
  { id: "default", name: "Default (recommended)", resolvedModel: "claude-opus-5-5", efforts: ALL_CLAUDE },
  { id: "opus", name: "Opus", resolvedModel: "claude-opus-5-5", efforts: ALL_CLAUDE },
  { id: "fable", name: "Fable", resolvedModel: "claude-fable-5-1", efforts: ALL_CLAUDE },
  { id: "sonnet", name: "Sonnet", resolvedModel: "claude-sonnet-5-5", efforts: ALL_CLAUDE },
  { id: "haiku", name: "Haiku", resolvedModel: "claude-haiku-4-5-20251001" },
  { id: "claude-opus-4-8", name: "Opus 4.8", resolvedModel: "claude-opus-4-8", efforts: ALL_CLAUDE },
];
const piModels = [
  { ref: "zai/glm-5.3", id: "glm-5.3", provider: "zai", thinkingLevels: ["off", "minimal", "low", "medium", "high"] },
  { ref: "ollama/qwen3", id: "qwen3", provider: "ollama", thinkingLevels: ["off"] },
];
const sources = (over: Partial<DelegateSources> = {}): DelegateSources => ({
  piModels: async () => piModels,
  claudeModels: async () => cliList,
  policy: () => EMPTY,
  ...over,
});
const defaults = (): DelegateSettings => JSON.parse(JSON.stringify(delegateInfo(join(dir, "absent.json")).defaults));

describe("GET /api/settings/delegate", () => {
  test("a missing file reads as the defaults, the catalog's current models, and the screen gets everything it renders from", () => {
    const info = delegateInfo(join(dir, "absent.json"));
    assert.deepEqual(info.settings, info.defaults);
    assert.deepEqual(info.defaults.profiles.planning, {
      primary: { backend: "claude-code", model: "claude-fable-5-1", effort: "medium" },
      fallback: { backend: "claude-code", model: "claude-opus-5-5", effort: "high" },
    });
    assert.deepEqual(info.defaults.profiles.investigation.primary, { backend: "claude-code", model: "claude-opus-5-5", effort: "low" });
    assert.deepEqual(info.profiles.map((p) => p.label), ["Planning & specs", "Investigation", "Routine implementation", "Complex implementation"]);
    assert.deepEqual(info.backends.map((b) => [b.id, b.efforts]), [
      ["pi", ["off", "minimal", "low", "medium", "high", "xhigh", "max"]],
      ["claude-code", ALL_CLAUDE],
    ]);
  });

  test("a file naming old Claude ids reads them as their catalog models", () => {
    const f = file();
    const old = defaults();
    old.profiles.planning = { primary: { backend: "claude-code", model: "claude-fable-5-1[1m]", effort: "medium" }, fallback: { backend: "claude-code", model: "opus[1m]", effort: "high" } };
    old.profiles.routine.primary = { backend: "claude-code", model: "sonnet", effort: "low" };
    writeFileSync(f, JSON.stringify(old));
    const read = delegateInfo(f).settings;
    assert.deepEqual([read.profiles.planning.primary.model, read.profiles.planning.fallback?.model, read.profiles.routine.primary.model], ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5"]);
  });
});

describe("GET /api/settings/delegate/options", () => {
  test("pi's registry, and Sova's Claude catalog with each model's efforts", async () => {
    const options = await delegateOptions(sources());
    const [pi, claude] = options.backends;
    assert.equal(pi!.id, "pi");
    assert.deepEqual(pi!.models, [
      { id: "ollama/qwen3", name: "ollama/qwen3", efforts: ["off"] },
      { id: "zai/glm-5.3", name: "zai/glm-5.3", efforts: ["off", "minimal", "low", "medium", "high"] },
    ]);
    assert.equal(claude!.id, "claude-code");
    assert.deepEqual(claude!.models!.map((m) => [m.id, m.name]), claudeOffer().map((m) => [m.id, m.name]));
    assert.deepEqual(claude!.models!.find((m) => m.id === "claude-opus-4-6")!.efforts, ["low", "medium", "high", "max"]);
    assert.deepEqual(claude!.models!.find((m) => m.id === "claude-haiku-4-5")!.efforts, ALL_CLAUDE, "a model taking no effort control: what the backend accepts");
    for (const alias of ["opus", "opus[1m]", "sonnet", "haiku", "default"]) assert.ok(!claude!.models!.some((m) => m.id === alias), alias);
    assert.equal(claude!.drift, undefined, "the CLI's list of today agrees with the catalog");
    assert.deepEqual(pi!.sessionScopedProviders, ["claude-code-cli"]);
  });

  test("the CLI's list never removes, adds or renames a model; it only reports drift", async () => {
    for (const failing of [async () => Promise.reject(new Error("The Claude Code CLI did not list its models within 15s.")), async () => [] as ClaudeModel[]]) {
      const claude = (await delegateOptions(sources({ claudeModels: failing }))).backends.find((b) => b.id === "claude-code")!;
      assert.deepEqual(claude.models!.map((m) => m.id), claudeOffer().map((m) => m.id));
      assert.equal(claude.error, undefined);
      assert.equal(claude.drift, undefined);
    }
    const drifted = await delegateOptions(sources({ claudeModels: async () => [...cliList, { id: "claude-opus-6", name: "Opus 6" }, { id: "sonnet[1m]", name: "S", resolvedModel: "claude-sonnet-6" }] }));
    const claude = drifted.backends.find((b) => b.id === "claude-code")!;
    assert.deepEqual(claude.models!.map((m) => m.id), claudeOffer().map((m) => m.id), "a model it doesn't know is not offered");
    assert.deepEqual(claude.drift, { unknown: [{ id: "claude-opus-6", name: "Opus 6" }], moved: [{ family: "sonnet", id: "claude-sonnet-6", current: "claude-sonnet-5-5" }] });
  });

  test("the policy marks models (shown, still selectable)", async () => {
    const policy: ModelPolicy = { ...EMPTY, subagentDisabledModels: ["claude-code/claude-fable-5-1"], disabledProviders: ["ollama"] };
    const options = await delegateOptions(sources({ policy: () => policy }));
    const claude = options.backends.find((b) => b.id === "claude-code")!.models!;
    assert.equal(claude.find((m) => m.id === "claude-fable-5-1")!.denied, "claude-fable-5-1 is off for subagents in Settings → Models");
    assert.equal(claude.find((m) => m.id === "claude-opus-5-5")!.denied, undefined);
    assert.equal(options.backends.find((b) => b.id === "pi")!.models!.find((m) => m.id === "ollama/qwen3")!.denied, "ollama is turned off in Settings → Models");
  });

  test("workerDenial follows the subagent spawn rule", () => {
    assert.equal(workerDenial(EMPTY, "claude-code", "claude-opus-5-5"), null);
    assert.match(workerDenial({ ...EMPTY, subagentDisabledProviders: ["claude-code"] }, "claude-code", "claude-opus-5-5")!, /claude-code is off for subagents/);
    assert.match(workerDenial({ ...EMPTY, disabledModels: ["claude-opus-5-5"] }, "claude-code", "claude-opus-5-5")!, /turned off/, "bare id");
    assert.match(workerDenial({ ...EMPTY, subagentDisabledModels: ["ZAI/GLM-5.3"] }, "pi", "zai/glm-5.3")!, /off for subagents/, "case-insensitive");
    assert.equal(workerDenial({ ...EMPTY, disabledProviders: ["zai"] }, "claude-code", "zai"), null, "a pi provider never covers a Claude model");
  });

  test("the CLI's list (drift only) is cached, shared while in flight, and failures are not cached", async () => {
    resetClaudeCache();
    let runs = 0;
    const discover = async () => {
      runs++;
      return cliList;
    };
    await Promise.all([cachedClaudeModels(discover), cachedClaudeModels(discover)]);
    await cachedClaudeModels(discover);
    assert.equal(runs, 1);
    assert.deepEqual(await cachedClaudeModels(discover), cliList, "kept as listed, resolvedModel included");
    resetClaudeCache();
    let fails = 0;
    const failing = async () => {
      fails++;
      throw new Error("nope");
    };
    await assert.rejects(cachedClaudeModels(failing));
    await assert.rejects(cachedClaudeModels(failing));
    assert.equal(fails, 2);
    resetClaudeCache();
  });
});

describe("PUT /api/settings/delegate", () => {
  beforeEach(() => resetClaudeCache());

  test("a valid routing is saved and read back; the file is the extension's shape", async () => {
    const f = file();
    const next = defaults();
    next.profiles.investigation = { primary: { backend: "pi", model: "zai/glm-5.3", effort: "minimal" }, fallback: { backend: "claude-code", model: "claude-sonnet-5-5", effort: "low" } };
    const result = await saveDelegateSettings(next, sources(), f);
    assert.ok(!("error" in result), JSON.stringify(result));
    assert.deepEqual(result.settings, next);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), next);
    assert.deepEqual(delegateInfo(f).settings, next);
  });

  test("an old Claude id in a save is written as its catalog id", async () => {
    const f = file();
    const next = defaults();
    next.profiles.routine.primary = { backend: "claude-code", model: "opus[1m]", effort: "low" };
    const result = await saveDelegateSettings(next, sources(), f);
    assert.ok(!("error" in result), JSON.stringify(result));
    assert.deepEqual(result.warnings, []);
    assert.equal(JSON.parse(readFileSync(f, "utf8")).profiles.routine.primary.model, "claude-opus-5-5");
  });

  test("shape errors are refused with the slot named, and nothing is written", async () => {
    const f = file();
    for (const [body, pattern] of [
      [null, /^Expected/],
      [{ ...defaults(), version: 2 }, /version must be 1/],
      [{ version: 1, profiles: { ...defaults().profiles, extra: defaults().profiles.routine } }, /Unknown profile: extra/],
      [{ ...defaults(), profiles: { ...defaults().profiles, routine: { primary: { backend: "pi", model: "glm-5.3", effort: "low" }, fallback: null } } }, /^Routine implementation primary: a pi model is "provider\/modelId"$/],
      [{ ...defaults(), profiles: { ...defaults().profiles, complex: { primary: { backend: "claude-code", model: "claude-opus-5-5", effort: "off" }, fallback: null } } }, /^Complex implementation primary: effort for claude-code must be one of/],
      [{ ...defaults(), profiles: { ...defaults().profiles, planning: { primary: defaults().profiles.planning.primary, fallback: defaults().profiles.planning.primary } } }, /the same worker as the primary/],
    ] as const) {
      const result = await saveDelegateSettings(body, sources(), f);
      assert.ok("error" in result, JSON.stringify(body));
      assert.match(result.error, pattern);
    }
    assert.ok(!existsSync(f));
  });

  test("a changed tuple the backend can't run is refused — model or effort", async () => {
    const f = file();
    const absent = defaults();
    absent.profiles.routine.primary = { backend: "pi", model: "zai/glm-9", effort: "low" };
    const r1 = await saveDelegateSettings(absent, sources(), f);
    assert.ok("error" in r1);
    assert.equal(r1.error, "Routine implementation primary: zai/glm-9 isn't offered by pi.");
    const claudeEffort = defaults();
    claudeEffort.profiles.routine.primary = { backend: "claude-code", model: "claude-sonnet-4-6", effort: "xhigh" };
    const r0 = await saveDelegateSettings(claudeEffort, sources(), f);
    assert.ok("error" in r0);
    assert.equal(r0.error, 'Routine implementation primary: claude-sonnet-4-6 doesn\'t take effort "xhigh" (it takes low, medium, high, max).');
    const effort = defaults();
    effort.profiles.investigation.fallback = { backend: "pi", model: "ollama/qwen3", effort: "high" };
    const r2 = await saveDelegateSettings(effort, sources(), f);
    assert.ok("error" in r2);
    assert.equal(r2.error, 'Investigation fallback: ollama/qwen3 doesn\'t take effort "high" (it takes off).');
    assert.ok(!existsSync(f), "nothing written");
  });

  test("pi discovery failure is not absence: the save goes through, with a warning; the Claude CLI failing changes nothing", async () => {
    const next = defaults();
    next.profiles.complex.primary = { backend: "pi", model: "zai/glm-5.3", effort: "high" };
    const result = await saveDelegateSettings(next, sources({ piModels: async () => Promise.reject(new Error("no registry")) }), file());
    assert.ok(!("error" in result), JSON.stringify(result));
    assert.deepEqual(result.warnings, ["Not verified, because pi couldn't list its models (no registry): Complex implementation primary"], "one sentence per backend that couldn't answer, naming every slot on it");
    const cli = await saveDelegateSettings(defaults(), sources({ claudeModels: async () => Promise.reject(new Error("Could not run the Claude Code CLI; is it installed?")) }), file());
    assert.ok(!("error" in cli), JSON.stringify(cli));
    assert.deepEqual(cli.warnings, []);
  });

  test("a policy-denied tuple saves with a warning (spawn enforces, Delegate discloses)", async () => {
    const f = file();
    const policy: ModelPolicy = { ...EMPTY, subagentDisabledModels: ["claude-code/claude-fable-5-1"] };
    const result = await saveDelegateSettings(defaults(), sources({ policy: () => policy }), f);
    assert.ok(!("error" in result));
    assert.deepEqual(result.warnings, ["Planning & specs primary: claude-fable-5-1 is off for subagents in Settings → Models; Delegate uses the fallback or asks"]);
  });

  test("an untouched slot never blocks a save, even when the catalog doesn't know its model", async () => {
    const f = file();
    const stored = defaults();
    stored.profiles.routine.primary = { backend: "claude-code", model: "retired-id", effort: "low" };
    writeFileSync(f, JSON.stringify(stored));
    const next: DelegateSettings = JSON.parse(JSON.stringify(stored));
    next.profiles.complex.primary.effort = "high";
    const result = await saveDelegateSettings(next, sources(), f);
    assert.ok(!("error" in result), JSON.stringify(result));
    assert.deepEqual(result.warnings, ["Routine implementation primary: not verified — retired-id is not in Sova's Claude catalog; it will still be used"]);
    assert.equal(JSON.parse(readFileSync(f, "utf8")).profiles.complex.primary.effort, "high");
  });

  test("a Claude id the catalog doesn't know is saved with a note, never refused", async () => {
    const f = file();
    const next = defaults();
    next.profiles.routine.primary = { backend: "claude-code", model: "claude-opus-6", effort: "low" };
    const result = await saveDelegateSettings(next, sources(), f);
    assert.ok(!("error" in result), JSON.stringify(result));
    assert.deepEqual(result.warnings, ["Routine implementation primary: not verified — claude-opus-6 is not in Sova's Claude catalog; it will still be used"]);
    assert.equal(result.settings.profiles.routine.primary.model, "claude-opus-6");
  });

  test("Claude Code provider models (pi, session-scoped) are unverified when not listed, never refused", async () => {
    const f = file();
    const next = defaults();
    next.profiles.investigation.primary = { backend: "pi", model: "claude-code-cli/claude-opus-5", effort: "high" };
    const result = await saveDelegateSettings(next, sources(), f);
    assert.ok(!("error" in result), JSON.stringify(result));
    assert.deepEqual(result.warnings, ["Investigation primary: not verified — claude-code-cli models exist only in sessions started with that provider on"]);
    // Any other provider's missing model is still an authoritative answer.
    next.profiles.investigation.primary = { backend: "pi", model: "zai/glm-9", effort: "high" };
    const refused = await saveDelegateSettings(next, sources(), f);
    assert.ok("error" in refused);
    assert.match(refused.error, /zai\/glm-9 isn't offered by pi/);
  });

  test("checkChoice", async () => {
    const options = await delegateOptions(sources());
    assert.deepEqual(checkChoice({ backend: "claude-code", model: "claude-opus-5-5", effort: "max" }, options), {});
    assert.deepEqual(checkChoice({ backend: "claude-code", model: "claude-haiku-4-5", effort: "xhigh" }, options), {}, "no effort control: unconstrained");
    assert.match(checkChoice({ backend: "claude-code", model: "claude-opus-4-6", effort: "xhigh" }, options).error!, /doesn't take effort "xhigh"/);
    assert.match(checkChoice({ backend: "claude-code", model: "claude-opus-6", effort: "low" }, options).warning!, /^not verified — claude-opus-6 is not in Sova's Claude catalog/);
    assert.match(checkChoice({ backend: "pi", model: "zai/glm-9", effort: "low" }, options).error!, /isn't offered by pi/, "pi's registry is an answer");
  });
});
