// Run: npx tsx --test server/subagent-profiles.test.ts. Writes only under a mkdtemp dir; no CLI runs.
// The server's half of subagent profiles: the info shape, the device default's own file,
// whole-library save validation, and the pick written into a header-only new session.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ModelPolicy } from "../shared/protocol";
import { requireSubagentProfile, saveSubagentProfileDefault, saveSubagentProfiles, subagentProfilesInfo } from "./subagent-profiles";
import type { DelegateSources } from "./delegate";
import { legacyProfile, restorePick, subagentProfileDefaultPath, subagentProfilesPath } from "../pi-config/extensions/subagents/subagent-profiles.ts";

const dir = mkdtempSync(join(tmpdir(), "sova-subagent-profiles-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const agentDir = () => {
  const d = join(dir, `agent-${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};

/** What an older build seeded on first read: one profile from the legacy files, "My setup", made the default. */
function olderStarter(d: string): void {
  writeFileSync(subagentProfilesPath(d), JSON.stringify({ version: 1, profiles: [legacyProfile(d)] }));
  writeFileSync(subagentProfileDefaultPath(d), JSON.stringify({ version: 1, default: "my-setup" }));
}

const EMPTY: ModelPolicy = { disabledProviders: [], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [] };
const piModels = [{ ref: "zai/glm-5.3", id: "glm-5.3", provider: "zai", thinkingLevels: ["off", "minimal", "low", "medium", "high"] }];
const sources = (over: Partial<DelegateSources> = {}): DelegateSources => ({
  piModels: async () => piModels,
  policy: () => EMPTY,
  ...over,
});

test("no seeding: an absent library writes nothing; info lists the built-in profile the accounts give and resolves to it", () => {
  const d = agentDir();
  writeFileSync(join(d, "mode-delegate.json"), JSON.stringify({ version: 1, profiles: { routine: { primary: { backend: "pi", model: "zai/glm-5.3", effort: "low" }, fallback: null } } }));
  const info = subagentProfilesInfo(undefined, d);
  assert.equal(info.error, undefined);
  assert.deepEqual(info.profiles.map((p) => p.id), ["claude"], "no account connected: Claude alone, and no Off");
  assert.equal(info.default, "claude");
  assert.deepEqual([info.current.id, info.current.source], ["claude", "default"]);
  assert.equal(info.template.delegate.planning.primary.model, "claude-fable-5-2", "New Profile starts from the default's helpers");
  assert.equal(existsSync(subagentProfilesPath(d)), false, "no library written");
  assert.equal(existsSync(subagentProfileDefaultPath(d)), false, "no default written");
  // With OpenAI signed in (pi's own sign-in), OpenAI is listed and is the default; Claude isn't listed.
  writeFileSync(join(d, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access: "t" } }));
  const openai = subagentProfilesInfo(undefined, d);
  assert.deepEqual([openai.profiles.map((p) => p.id), openai.default], [["openai"], "openai"]);
  // An older starter reads as Claude and takes its place; an older Off pick follows the default.
  olderStarter(d);
  const older = subagentProfilesInfo("off", d);
  assert.deepEqual(older.profiles.map((p) => [p.id, p.name]), [["my-setup", "Claude"], ["openai", "OpenAI"]]);
  assert.deepEqual([older.default, older.current.id, older.current.name, older.current.source], ["my-setup", "my-setup", "Claude", "default"]);
});

test("requireSubagentProfile: a library or built-in id passes; \"off\" answers with the profiles there are; an unusable library refuses", () => {
  const d = agentDir();
  assert.equal(requireSubagentProfile("claude", d), "claude");
  assert.equal(requireSubagentProfile("openai", d), "openai", "a built-in id is a pick even when its account isn't listed here");
  assert.throws(() => requireSubagentProfile("off", d), /^Error: No profile is named "off"; the profiles here are Claude\.$/);
  assert.throws(() => requireSubagentProfile("nope", d), /Unknown subagent profile/);
  assert.throws(() => requireSubagentProfile(42, d), /Unknown subagent profile/);
  writeFileSync(subagentProfilesPath(d), "{ nope");
  assert.throws(() => requireSubagentProfile("claude", d), /malformed|not valid JSON/);
});

test("saveSubagentProfileDefault writes only the default file — the library's bytes are untouched", () => {
  const d = agentDir();
  olderStarter(d);
  const before = readFileSync(subagentProfilesPath(d), "utf8");
  saveSubagentProfileDefault("openai", d);
  assert.equal(readFileSync(subagentProfilesPath(d), "utf8"), before);
  assert.equal(JSON.parse(readFileSync(subagentProfileDefaultPath(d), "utf8")).default, "openai");
  assert.equal(subagentProfilesInfo(undefined, d).default, "openai");
  saveSubagentProfileDefault("my-setup", d);
  assert.equal(subagentProfilesInfo(undefined, d).default, "my-setup");
  assert.throws(() => saveSubagentProfileDefault("off", d), /No profile is named "off"/);
});

test("PUT body: a library carrying a default key is refused, naming where the default lives now", async () => {
  const d = agentDir();
  olderStarter(d);
  const lib = JSON.parse(readFileSync(subagentProfilesPath(d), "utf8"));
  const result = await saveSubagentProfiles({ ...lib, default: "my-setup" }, sources(), d);
  assert.ok("error" in result && !("settings" in result));
  assert.match((result as { error: string }).error, /subagent-profiles-default\.json/);
});

test("save validation: every slot is checked — a disabled coordinator's tuple included", async () => {
  const d = agentDir();
  olderStarter(d);
  const lib = JSON.parse(readFileSync(subagentProfilesPath(d), "utf8"));
  lib.profiles[0].teams = {
    coordinator: { enabled: false, role: "coordinator", primary: { backend: "pi", model: "zai/gone", effort: "low" }, fallback: null, instructions: "" },
    monitor: { enabled: false, role: "monitor", primary: { backend: "claude-code", model: "claude-opus-5-5", effort: "medium" }, fallback: null, contextPct: 60, everyMinutes: 10, usage: { enabled: true, pausePct: 90, resumeMarginMinutes: 5 }, instructions: "" },
    handover: { retireTimeoutMinutes: 10 },
  };
  const refused = await saveSubagentProfiles(lib, sources(), d);
  assert.ok("error" in refused && !("settings" in refused), JSON.stringify(refused));
  assert.match((refused as { error: string }).error, /Coordinator primary/);
});

test("save validation: a tuple left as it was stored in ITS slot never blocks; the same tuple moved to another slot is checked as changed", async () => {
  const d = agentDir();
  // Legacy routing holds a model the current discovery can't run; an older build's seed stored it as-is.
  writeFileSync(join(d, "mode-delegate.json"), JSON.stringify({ version: 1, profiles: { routine: { primary: { backend: "pi", model: "zai/gone", effort: "low" }, fallback: null } } }));
  olderStarter(d);
  const seeded = subagentProfilesInfo(undefined, d);
  assert.equal(seeded.settings.profiles[0]?.delegate.routine.primary.model, "zai/gone");
  const kept = await saveSubagentProfiles(seeded.settings, sources(), d);
  assert.ok("settings" in kept, `unchanged slots save (with a warning at most): ${JSON.stringify(kept)}`);
  const moved = JSON.parse(JSON.stringify(seeded.settings));
  moved.profiles[0].delegate.routine.primary = { backend: "pi", model: "zai/glm-5.3", effort: "low" };
  moved.profiles[0].specWriter = { primary: { backend: "pi", model: "zai/gone", effort: "low" }, fallback: null };
  const refused = await saveSubagentProfiles(moved, sources(), d);
  assert.ok("error" in refused && !("settings" in refused), "the moved tuple is a changed slot and is refused");
  assert.match((refused as { error: string }).error, /Spec writer primary/);
});

test("the pick written into a header-only new session persists before any prompt, and survives a reopen", () => {
  const d = agentDir();
  const sm = SessionManager.create(join(d, "project"));
  const rawPath = sm.getSessionFile();
  const header = sm.getHeader();
  assert.ok(rawPath && header, "create yields a path and header");
  writeFileSync(rawPath, `${JSON.stringify(header)}\n`, { flag: "wx" });
  // Exactly what POST /api/sessions does with subagent_profile.
  writeFileSync(subagentProfilesPath(d), JSON.stringify({ version: 1, profiles: [] }));
  const opened = SessionManager.open(rawPath);
  const id = opened.appendCustomEntry("subagent-profile", { v: 1, profile: "off" });
  assert.ok(id, "append returned the entry id");
  const onDisk = readFileSync(rawPath, "utf8");
  assert.match(onDisk, /"customType":"subagent-profile"/, "the entry is in the file, not only in memory");
  const reopened = SessionManager.open(rawPath);
  assert.equal(restorePick(reopened.getBranch() as never), "off", "a reopen resolves the pick from the branch");
});
