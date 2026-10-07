// Run: npx tsx --test server/spec-settings.test.ts (or npm test). Writes only under a mkdtemp dir; no CLI runs.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { ModelPolicy, SpecSettings, WorkerChoice } from "../shared/protocol";
import type { DelegateSources } from "./delegate";
import { saveSpecSettings, specInfo, specOptions } from "./spec-settings";
import { claudeOffer } from "../pi-config/extensions/claude-code/catalog.ts";

const dir = mkdtempSync(join(tmpdir(), "sova-spec-settings-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => join(dir, `mode-spec-${++n}.json`);

const EMPTY: ModelPolicy = { disabledProviders: [], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [] };
const ALL_CLAUDE = ["low", "medium", "high", "xhigh", "max"];
const sources = (over: Partial<DelegateSources> = {}): DelegateSources => ({
  piModels: async () => [{ ref: "zai/glm-5.3", id: "glm-5.3", provider: "zai", thinkingLevels: ["off", "low", "medium", "high"] }],
  claudeModels: async () => [
    { id: "claude-opus-5-5", name: "Opus", efforts: ALL_CLAUDE },
    { id: "claude-sonnet-5-5", name: "Sonnet", efforts: ["low", "medium"] },
  ],
  policy: () => EMPTY,
  ...over,
});
const opus: WorkerChoice = { backend: "claude-code", model: "claude-opus-5-5", effort: "medium" };
const glm: WorkerChoice = { backend: "pi", model: "zai/glm-5.3", effort: "high" };
const writer = (primary: WorkerChoice, fallback: WorkerChoice | null = null): SpecSettings => ({ version: 1, writer: { primary, fallback } });

describe("GET /api/settings/spec", () => {
  test("a missing file reads as no writer, with what the screen renders from", () => {
    const f = join(dir, "absent.json");
    const info = specInfo(f);
    assert.deepEqual(info.settings, { version: 1, writer: null });
    assert.equal(info.writer.label, "Spec writer");
    assert.match(info.writer.description, /\.sova\/spec\/drafts\//);
    assert.deepEqual(info.backends.map((b) => b.id), ["pi", "claude-code"]);
    assert.deepEqual(info.backends.find((b) => b.id === "claude-code")?.efforts, ALL_CLAUDE);
    assert.equal(info.file, f);
    assert.ok(!existsSync(f), "reading never writes");
  });

  test("a corrupt file reads as no writer", () => {
    const f = file();
    writeFileSync(f, "{ nope");
    assert.deepEqual(specInfo(f).settings, { version: 1, writer: null });
  });
});

describe("GET /api/settings/spec/options", () => {
  test("is Delegate's: pi's registry, and Sova's Claude catalog", async () => {
    const options = await specOptions(sources());
    assert.deepEqual(options.backends.map((b) => [b.id, b.models?.map((m) => m.id)]), [
      ["pi", ["zai/glm-5.3"]],
      ["claude-code", claudeOffer().map((m) => m.id)],
    ]);
  });
});

describe("PUT /api/settings/spec", () => {
  test("saves a writer with its fallback, canonically, and reads it back", async () => {
    const f = file();
    const result = await saveSpecSettings(writer(opus, glm), sources(), f);
    assert.ok(!("error" in result), JSON.stringify(result));
    assert.deepEqual(result.settings, writer(opus, glm));
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), writer(opus, glm));
    assert.deepEqual(specInfo(f).settings, writer(opus, glm));
  });

  test("writer null clears it, without asking discovery", async () => {
    const f = file();
    await saveSpecSettings(writer(opus), sources(), f);
    const result = await saveSpecSettings({ version: 1, writer: null }, sources({ claudeModels: async () => { throw new Error("must not be asked"); } }), f);
    assert.ok(!("error" in result));
    assert.deepEqual(result.settings, { version: 1, writer: null });
    assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { version: 1, writer: null });
  });

  test("a bad shape is refused by the extension's strict parse, and nothing is written", async () => {
    const f = file();
    for (const [body, pattern] of [
      [null, /Expected/],
      [{ version: 2, writer: null }, /version must be 1/],
      [{ version: 1 }, /writer must be/],
      [{ version: 1, writer: { primary: { ...opus, effort: "off" }, fallback: null } }, /^Spec writer primary: effort for claude-code/],
      [{ version: 1, writer: { primary: opus, fallback: opus } }, /^Spec writer fallback: the same worker as the primary/],
    ] as const) {
      const result = await saveSpecSettings(body, sources(), f);
      assert.ok("error" in result, JSON.stringify(body));
      assert.match(result.error, pattern);
    }
    assert.ok(!existsSync(f));
  });

  test("a CHANGED tuple its backend can't run is refused; the same tuple already stored only warns", async () => {
    const f = file();
    // Opus 4.6 takes no xhigh (the catalog's efforts).
    const sonnetHigh: WorkerChoice = { backend: "claude-code", model: "claude-opus-4-6", effort: "xhigh" };
    const refused = await saveSpecSettings(writer(sonnetHigh), sources(), f);
    assert.ok("error" in refused);
    assert.match(refused.error, /^Spec writer primary: claude-opus-4-6 doesn't take effort "xhigh"/);
    assert.ok(!existsSync(f));
    const piMissing = await saveSpecSettings(writer({ backend: "pi", model: "zai/gone", effort: "high" }), sources(), f);
    assert.ok("error" in piMissing);
    assert.match(piMissing.error, /zai\/gone isn't offered by pi/);
    // Stored by hand (or before the model went away): re-saving it is not blocked.
    writeFileSync(f, JSON.stringify(writer(sonnetHigh)));
    const kept = await saveSpecSettings(writer(sonnetHigh, glm), sources(), f);
    assert.ok(!("error" in kept), JSON.stringify(kept));
    assert.match(kept.warnings.join(" "), /^Spec writer primary: claude-opus-4-6 doesn't take effort "xhigh"/);
  });

  test("unverifiable backends and policy denials save with a warning", async () => {
    const f = file();
    // The CLI's own list failing changes nothing: Claude Code's list is the catalog.
    const cliDown = await saveSpecSettings(writer(opus, glm), sources({ claudeModels: async () => { throw new Error("CLI missing"); } }), f);
    assert.ok(!("error" in cliDown));
    assert.deepEqual(cliDown.warnings, []);
    const down = await saveSpecSettings(writer(glm, opus), sources({ piModels: async () => { throw new Error("no registry"); } }), file());
    assert.ok(!("error" in down));
    assert.deepEqual(down.warnings, ["Not verified, because pi couldn't list its models (no registry): Spec writer primary"]);
    const denied = await saveSpecSettings(writer(opus, glm), sources({ policy: () => ({ ...EMPTY, subagentDisabledModels: ["claude-opus-5-5"] }) }), file());
    assert.ok(!("error" in denied));
    assert.deepEqual(denied.warnings, ["Spec writer primary: claude-opus-5-5 is off for subagents in Settings → Models; spec writing uses the fallback or asks"]);
  });
});
