// Run: npx tsx --test server/delegate.test.ts (or npm test). Writes only under a mkdtemp dir; no CLI runs.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import type { DelegateSettings, ModelPolicy } from "../shared/protocol";
import type { ClaudeModel } from "./claude-models";
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
const claudeModels: ClaudeModel[] = [
  { id: "claude-fable-5-1[1m]", name: "Fable", efforts: ALL_CLAUDE },
  { id: "opus[1m]", name: "Opus", efforts: ALL_CLAUDE },
  { id: "sonnet", name: "Sonnet", efforts: ["low", "medium", "high", "future-effort"] },
  { id: "legacy", name: "Legacy" }, // reports no efforts
  { id: "bare", name: "Bare", efforts: [] }, // reports an empty list
  { id: "future", name: "Future", efforts: ["future-effort"] }, // reports only efforts the backend refuses
];
const piModels = [
  { ref: "zai/glm-5.3", id: "glm-5.3", provider: "zai", thinkingLevels: ["off", "minimal", "low", "medium", "high"] },
  { ref: "ollama/qwen3", id: "qwen3", provider: "ollama", thinkingLevels: ["off"] },
];
const sources = (over: Partial<DelegateSources> = {}): DelegateSources => ({
  piModels: async () => piModels,
  claudeModels: async () => claudeModels,
  policy: () => EMPTY,
  ...over,
});
const defaults = (): DelegateSettings => JSON.parse(JSON.stringify(delegateInfo(join(dir, "absent.json")).defaults));

describe("GET /api/settings/delegate", () => {
  test("a missing file reads as the defaults, and the screen gets everything it renders from", () => {
    const info = delegateInfo(join(dir, "absent.json"));
    assert.deepEqual(info.settings, info.defaults);
    assert.deepEqual(info.defaults.profiles.planning, {
      primary: { backend: "claude-code", model: "claude-fable-5-1[1m]", effort: "medium" },
      fallback: { backend: "claude-code", model: "opus[1m]", effort: "high" },
    });
    assert.deepEqual(info.defaults.profiles.investigation.primary, { backend: "claude-code", model: "opus[1m]", effort: "low" });
    assert.deepEqual(info.profiles.map((p) => p.label), ["Planning & specs", "Investigation", "Routine implementation", "Complex implementation"]);
    assert.deepEqual(info.backends.map((b) => [b.id, b.efforts]), [
      ["pi", ["off", "minimal", "low", "medium", "high", "xhigh", "max"]],
      ["claude-code", ALL_CLAUDE],
    ]);
  });
});

describe("GET /api/settings/delegate/options", () => {
  test("each backend's models with the efforts each takes", async () => {
    const options = await delegateOptions(sources());
    const [pi, claude] = options.backends;
    assert.equal(pi!.id, "pi");
    assert.deepEqual(pi!.models, [
      { id: "ollama/qwen3", name: "ollama/qwen3", efforts: ["off"] },
      { id: "zai/glm-5.3", name: "zai/glm-5.3", efforts: ["off", "minimal", "low", "medium", "high"] },
    ]);
    assert.equal(claude!.id, "claude-code");
    assert.deepEqual(claude!.models!.find((m) => m.id === "sonnet")!.efforts, ["low", "medium", "high"], "an effort the backend would refuse is not offered");
    assert.deepEqual(claude!.models!.find((m) => m.id === "legacy")!.efforts, ALL_CLAUDE, "unreported: what the backend accepts");
    assert.deepEqual(claude!.models!.find((m) => m.id === "bare")!.efforts, ALL_CLAUDE, "an empty list constrains nothing — never an empty select");
    assert.deepEqual(claude!.models!.find((m) => m.id === "future")!.efforts, ALL_CLAUDE, "nothing usable left after the cut: same");
    assert.deepEqual(pi!.sessionScopedProviders, ["claude-code-cli"]);
  });

  test("a failed discovery is models:null with the reason — never an empty list", async () => {
    const options = await delegateOptions(sources({ claudeModels: async () => Promise.reject(new Error("The Claude Code CLI did not list its models within 15s.")) }));
    const claude = options.backends.find((b) => b.id === "claude-code")!;
    assert.equal(claude.models, null);
    assert.equal(claude.error, "The Claude Code CLI did not list its models within 15s");
    assert.ok(options.backends.find((b) => b.id === "pi")!.models!.length > 0, "one backend failing leaves the other");
  });

  test("the policy marks models (shown, still selectable)", async () => {
    const policy: ModelPolicy = { ...EMPTY, subagentDisabledModels: ["claude-code/claude-fable-5-1[1m]"], disabledProviders: ["ollama"] };
    const options = await delegateOptions(sources({ policy: () => policy }));
    const claude = options.backends.find((b) => b.id === "claude-code")!.models!;
    assert.equal(claude.find((m) => m.id === "claude-fable-5-1[1m]")!.denied, "claude-fable-5-1[1m] is off for subagents in Settings → Models");
    assert.equal(claude.find((m) => m.id === "opus[1m]")!.denied, undefined);
    assert.equal(options.backends.find((b) => b.id === "pi")!.models!.find((m) => m.id === "ollama/qwen3")!.denied, "ollama is turned off in Settings → Models");
  });

  test("workerDenial follows the subagent spawn rule", () => {
    assert.equal(workerDenial(EMPTY, "claude-code", "opus[1m]"), null);
    assert.match(workerDenial({ ...EMPTY, subagentDisabledProviders: ["claude-code"] }, "claude-code", "opus[1m]")!, /claude-code is off for subagents/);
    assert.match(workerDenial({ ...EMPTY, disabledModels: ["opus[1m]"] }, "claude-code", "opus[1m]")!, /turned off/, "bare id");
    assert.match(workerDenial({ ...EMPTY, subagentDisabledModels: ["ZAI/GLM-5.3"] }, "pi", "zai/glm-5.3")!, /off for subagents/, "case-insensitive");
    assert.equal(workerDenial({ ...EMPTY, disabledProviders: ["zai"] }, "claude-code", "zai"), null, "a pi provider never covers a Claude model");
  });

  test("Claude discovery is cached, shared while in flight, and failures are not cached", async () => {
    resetClaudeCache();
    let runs = 0;
    const discover = async () => {
      runs++;
      return claudeModels;
    };
    await Promise.all([cachedClaudeModels(discover), cachedClaudeModels(discover)]);
    await cachedClaudeModels(discover);
    assert.equal(runs, 1);
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
    next.profiles.investigation = { primary: { backend: "pi", model: "zai/glm-5.3", effort: "minimal" }, fallback: { backend: "claude-code", model: "sonnet", effort: "low" } };
    const result = await saveDelegateSettings(next, sources(), f);
    assert.ok(!("error" in result), JSON.stringify(result));
    assert.deepEqual(result.settings, next);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), next);
    assert.deepEqual(delegateInfo(f).settings, next);
  });

  test("shape errors are refused with the slot named, and nothing is written", async () => {
    const f = file();
    for (const [body, pattern] of [
      [null, /^Expected/],
      [{ ...defaults(), version: 2 }, /version must be 1/],
      [{ version: 1, profiles: { ...defaults().profiles, extra: defaults().profiles.routine } }, /Unknown profile: extra/],
      [{ ...defaults(), profiles: { ...defaults().profiles, routine: { primary: { backend: "pi", model: "glm-5.3", effort: "low" }, fallback: null } } }, /^Routine implementation primary: a pi model is "provider\/modelId"$/],
      [{ ...defaults(), profiles: { ...defaults().profiles, complex: { primary: { backend: "claude-code", model: "opus[1m]", effort: "off" }, fallback: null } } }, /^Complex implementation primary: effort for claude-code must be one of/],
      [{ ...defaults(), profiles: { ...defaults().profiles, planning: { primary: defaults().profiles.planning.primary, fallback: defaults().profiles.planning.primary } } }, /the same worker as the primary/],
    ] as const) {
      const result = await saveDelegateSettings(body, sources(), f);
      assert.ok("error" in result, JSON.stringify(body));
      assert.match(result.error, pattern);
    }
    assert.ok(!existsSync(f));
  });

  test("a changed tuple the backend answered it can't run is refused — model or effort", async () => {
    const f = file();
    const absent = defaults();
    absent.profiles.routine.primary = { backend: "claude-code", model: "gpt-9", effort: "low" };
    const r1 = await saveDelegateSettings(absent, sources(), f);
    assert.ok("error" in r1);
    assert.equal(r1.error, "Routine implementation primary: gpt-9 isn't offered by Claude Code.");
    const effort = defaults();
    effort.profiles.investigation.fallback = { backend: "pi", model: "ollama/qwen3", effort: "high" };
    const r2 = await saveDelegateSettings(effort, sources(), f);
    assert.ok("error" in r2);
    assert.equal(r2.error, 'Investigation fallback: ollama/qwen3 doesn\'t take effort "high" (it takes off).');
    assert.ok(!existsSync(f), "nothing written");
  });

  test("discovery failure is not absence: the save goes through, with a warning", async () => {
    const f = file();
    const next = defaults();
    next.profiles.complex.primary = { backend: "claude-code", model: "some-new-alias", effort: "high" };
    const result = await saveDelegateSettings(next, sources({ claudeModels: async () => Promise.reject(new Error("Could not run the Claude Code CLI; is it installed?")) }), f);
    assert.ok(!("error" in result), JSON.stringify(result));
    assert.equal(result.settings.profiles.complex.primary.model, "some-new-alias");
    assert.deepEqual(
      result.warnings,
      [
        "Not verified, because Claude Code couldn't list its models (Could not run the Claude Code CLI; is it installed?): Planning & specs primary, Planning & specs fallback, Investigation primary, Routine implementation primary, Complex implementation primary",
      ],
      "one sentence per backend that couldn't answer, naming every slot on it",
    );
  });

  test("a policy-denied tuple saves with a warning (spawn enforces, Delegate discloses)", async () => {
    const f = file();
    const policy: ModelPolicy = { ...EMPTY, subagentDisabledModels: ["claude-code/claude-fable-5-1[1m]"] };
    const result = await saveDelegateSettings(defaults(), sources({ policy: () => policy }), f);
    assert.ok(!("error" in result));
    assert.deepEqual(result.warnings, ["Planning & specs primary: claude-fable-5-1[1m] is off for subagents in Settings → Models; Delegate uses the fallback or asks"]);
  });

  test("an untouched slot never blocks a save, even when its model has gone", async () => {
    const f = file();
    const stored = defaults();
    stored.profiles.routine.primary = { backend: "claude-code", model: "retired-alias", effort: "low" };
    writeFileSync(f, JSON.stringify(stored));
    const next: DelegateSettings = JSON.parse(JSON.stringify(stored));
    next.profiles.complex.primary.effort = "high";
    const result = await saveDelegateSettings(next, sources(), f);
    assert.ok(!("error" in result), JSON.stringify(result));
    assert.deepEqual(result.warnings, ["Routine implementation primary: retired-alias isn't offered by Claude Code"]);
    assert.equal(JSON.parse(readFileSync(f, "utf8")).profiles.complex.primary.effort, "high");
  });

  test("empty effort lists: the save accepts what routing would run", async () => {
    const f = file();
    const next = defaults();
    next.profiles.routine.primary = { backend: "claude-code", model: "bare", effort: "max" };
    next.profiles.complex.primary = { backend: "claude-code", model: "future", effort: "low" };
    const result = await saveDelegateSettings(next, sources(), f);
    assert.ok(!("error" in result), JSON.stringify(result));
    assert.deepEqual(result.warnings, []);
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
    assert.deepEqual(checkChoice({ backend: "claude-code", model: "opus[1m]", effort: "max" }, options), {});
    assert.deepEqual(checkChoice({ backend: "claude-code", model: "legacy", effort: "xhigh" }, options), {});
    assert.match(checkChoice({ backend: "claude-code", model: "sonnet", effort: "max" }, options).error!, /doesn't take effort "max"/);
  });
});
