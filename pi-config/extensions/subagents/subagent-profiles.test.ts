import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { delegateDefaults } from "../mode/delegate.ts";
import { DEFAULT_TEAM_DEFAULTS, writeTeamDefaults } from "./team-defaults.ts";
import {
	footprint,
	idFor,
	loadSubagentProfiles,
	OFF_PROFILE_ID,
	parseSubagentProfiles,
	PICK_ENTRY_TYPE,
	pickEntryFor,
	profileProviders,
	readSubagentProfiles,
	resolveSubagents,
	restorePick,
	SEEDED_PROFILE_ID,
	shortModel,
	subagentProfilesPath,
	writeSubagentProfiles,
	type SubagentProfile,
	type SubagentProfilesFile,
} from "./subagent-profiles.ts";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-profiles-"));
const claude = (model: string, effort = "low") => ({ backend: "claude-code" as const, model, effort });
const pi = (model: string, effort = "low") => ({ backend: "pi" as const, model, effort });

function profile(id: string, name: string, over: Partial<SubagentProfile> = {}): SubagentProfile {
	return { id, name, delegate: delegateDefaults().profiles, teams: null, members: null, specWriter: null, ...over };
}
const file = (profiles: SubagentProfile[], def = profiles[0]?.id ?? OFF_PROFILE_ID): SubagentProfilesFile => ({ version: 1, default: def, profiles });

test("subagent-profiles.ts imports only node built-ins and builtins-only siblings, so Sova's server can import it", () => {
	const source = fs.readFileSync(fileURLToPath(new URL("./subagent-profiles.ts", import.meta.url)), "utf8");
	const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
	assert.deepEqual([...new Set(specifiers.filter((s) => !s!.startsWith("node:")))].sort(), ["../mode/delegate.ts", "../mode/spec.ts", "./team-defaults.ts"]);
});

test("parse: a valid file round-trips; every error is collected, not the first", () => {
	const ok = parseSubagentProfiles(JSON.stringify(file([profile("a", "A", { members: claude("sonnet") })])));
	assert.equal(ok.ok, true);
	const bad = parseSubagentProfiles({
		version: 2,
		default: "nope",
		extra: 1,
		profiles: [
			profile("off", "Off"),
			{ ...profile("b", "B"), members: { backend: "pi", model: "no-slash", effort: "low" } },
			profile("c", "C"),
			profile("c", "c"),
		],
	});
	assert.equal(bad.ok, false);
	const errors = (bad as { errors: string[] }).errors.join("\n");
	for (const want of ["version: must be 1", "extra: unknown key", "profiles[0].id", "profiles[0].name", "profiles[1].members", 'the id "c" is used twice', 'the name "c" is used twice', "default: must be"])
		assert.ok(errors.includes(want), `missing ${want} in\n${errors}`);
});

test("parse: a teams section takes team-defaults' rules, and its defaults fill what it leaves out", () => {
	const parsed = parseSubagentProfiles(file([profile("a", "A", { teams: { coordinator: { ...DEFAULT_TEAM_DEFAULTS.coordinator }, monitor: { ...DEFAULT_TEAM_DEFAULTS.monitor }, handover: { retireTimeoutMinutes: 10 } } })]));
	assert.equal(parsed.ok, true);
	const bad = parseSubagentProfiles({ version: 1, default: "a", profiles: [{ ...profile("a", "A"), teams: { monitor: { contextPct: 0 } } }] });
	assert.equal(bad.ok, false);
	assert.match((bad as { errors: string[] }).errors.join(), /profiles\[0\]\.teams\.monitor\.contextPct/);
});

test("seed: an absent file is written once from the legacy files, made the default, and never replaces a newer file", () => {
	const dir = tempDir();
	fs.writeFileSync(path.join(dir, "mode-delegate.json"), JSON.stringify({ version: 1, profiles: { routine: { primary: pi("zai/glm-5.3"), fallback: null } } }));
	fs.writeFileSync(path.join(dir, "mode-spec.json"), JSON.stringify({ version: 1, writer: { primary: claude("sonnet", "medium"), fallback: null } }));
	writeTeamDefaults(dir, DEFAULT_TEAM_DEFAULTS);
	const state = loadSubagentProfiles(dir);
	assert.equal(state.state, "ok");
	const seeded = (state as { value: SubagentProfilesFile }).value;
	assert.equal(seeded.default, SEEDED_PROFILE_ID);
	assert.equal(seeded.profiles.length, 1);
	assert.deepEqual(seeded.profiles[0]!.delegate.routine.primary, pi("zai/glm-5.3"));
	assert.deepEqual(seeded.profiles[0]!.delegate.planning, delegateDefaults().profiles.planning, "a slot the legacy file leaves out takes its default, as Delegate read it");
	assert.equal(seeded.profiles[0]!.specWriter?.primary.model, "sonnet");
	assert.equal(seeded.profiles[0]!.teams?.coordinator.role, "coordinator");
	assert.equal(seeded.profiles[0]!.members, null);
	assert.equal(readSubagentProfiles(dir).state, "ok", "the seed is on disk");
	// A second read never re-seeds over what is there now.
	writeSubagentProfiles(dir, file([profile("x", "X")]));
	assert.equal((loadSubagentProfiles(dir) as { value: SubagentProfilesFile }).value.default, "x");
	// The legacy files are left alone.
	assert.ok(fs.existsSync(path.join(dir, "mode-delegate.json")) && fs.existsSync(path.join(dir, "team-defaults.json")) && fs.existsSync(path.join(dir, "mode-spec.json")));
});

test("seed: no legacy files seeds the built-in routing, no teams, no writer — what Delegate, teams and spec did without them", () => {
	const dir = tempDir();
	const seeded = (loadSubagentProfiles(dir) as { value: SubagentProfilesFile }).value.profiles[0]!;
	assert.deepEqual(seeded.delegate, delegateDefaults().profiles);
	assert.equal(seeded.teams, null);
	assert.equal(seeded.specWriter, null);
});

test("writer refuses an invalid value and never leaves a partial file", () => {
	const dir = tempDir();
	assert.throws(() => writeSubagentProfiles(dir, { version: 1, default: "missing", profiles: [] }), /Refusing to write/);
	assert.equal(fs.existsSync(subagentProfilesPath(dir)), false);
	assert.deepEqual(fs.readdirSync(dir), []);
});

test("pick: the newest valid entry on the branch wins; unknown shapes are skipped", () => {
	const entry = (data: unknown) => ({ type: "custom", customType: PICK_ENTRY_TYPE, data });
	assert.equal(restorePick([]), undefined);
	assert.equal(restorePick([entry({ v: 1, profile: "a" }), entry({ v: 1, profile: "off" })]), "off");
	assert.equal(restorePick([entry({ v: 1, profile: "a" }), entry({ v: 2, profile: "b" }), entry({ v: 1, profile: "Bad Id" })]), "a");
	assert.equal(pickEntryFor([entry({ v: 1, profile: "a" })], "a"), null);
	assert.deepEqual(pickEntryFor([entry({ v: 1, profile: "a" })], "b"), { customType: PICK_ENTRY_TYPE, data: { v: 1, profile: "b" } });
});

test("resolution order: the chat's pick, then the default, then the legacy files", () => {
	const dir = tempDir();
	fs.writeFileSync(path.join(dir, "mode-delegate.json"), JSON.stringify({ version: 1, profiles: { routine: { primary: pi("legacy/model"), fallback: null } } }));
	const a = profile("a", "A", { members: claude("sonnet") });
	const b = profile("b", "B", { delegate: { ...delegateDefaults().profiles, routine: { primary: pi("zai/glm-5.3"), fallback: null } } });
	writeSubagentProfiles(dir, file([a, b], "a"));
	const picked = resolveSubagents(dir, "b");
	assert.equal(picked.source, "pick");
	assert.equal(picked.delegate?.profiles.routine.primary.model, "zai/glm-5.3");
	const followed = resolveSubagents(dir, undefined);
	assert.equal(followed.source, "default");
	assert.equal(followed.id, "a");
	assert.deepEqual(followed.members, claude("sonnet"));
	const dangling = resolveSubagents(dir, "gone");
	assert.equal(dangling.id, "a", "a pick naming a deleted profile follows the default");
	assert.match(dangling.note ?? "", /no longer exists/);
	fs.writeFileSync(subagentProfilesPath(dir), "{ not json");
	const legacy = resolveSubagents(dir, "b");
	assert.equal(legacy.source, "legacy");
	assert.equal(legacy.delegate?.profiles.routine.primary.model, "legacy/model");
	assert.equal(legacy.members, null);
	assert.match(legacy.note ?? "", /malformed/);
});

test("Off configures nothing: no routing, no team members, no members default, no spec writer", () => {
	const dir = tempDir();
	writeTeamDefaults(dir, DEFAULT_TEAM_DEFAULTS);
	writeSubagentProfiles(dir, file([profile("a", "A", { members: claude("sonnet"), specWriter: { primary: claude("opus"), fallback: null } })], OFF_PROFILE_ID));
	for (const r of [resolveSubagents(dir, undefined), resolveSubagents(dir, OFF_PROFILE_ID)]) {
		assert.equal(r.id, OFF_PROFILE_ID);
		assert.equal(r.delegate, null);
		assert.equal(r.teams.state, "absent", "a team-defaults.json beside it is not read under Off");
		assert.equal(r.members, null);
		assert.equal(r.spec.writer, null);
	}
	assert.equal(resolveSubagents(dir, OFF_PROFILE_ID).source, "pick");
	assert.equal(resolveSubagents(dir, undefined).source, "default");
});

test("a profile's teams resolve in team-defaults' own shape; null is absent", () => {
	const dir = tempDir();
	const teams = { coordinator: { ...DEFAULT_TEAM_DEFAULTS.coordinator }, monitor: { ...DEFAULT_TEAM_DEFAULTS.monitor, contextPct: 42 }, handover: { retireTimeoutMinutes: 3 } };
	writeSubagentProfiles(dir, file([profile("a", "A", { teams }), profile("b", "B")]));
	const a = resolveSubagents(dir, "a").teams;
	assert.equal(a.state, "ok");
	assert.equal(a.state === "ok" && a.value.monitor.contextPct, 42);
	assert.match(a.file, /subagent profile "A"/);
	assert.equal(resolveSubagents(dir, "b").teams.state, "absent");
});

test("footprints and providers", () => {
	assert.equal(shortModel("opus[1m]"), "opus");
	assert.equal(shortModel("claude-fable-5-1[1m]"), "fable");
	assert.equal(shortModel("zai/glm-5.3"), "glm-5.3");
	assert.equal(shortModel("claude-code-cli/claude-sonnet-4-6"), "sonnet");
	const p = profile("a", "A", { members: claude("sonnet"), specWriter: { primary: pi("zai/glm-5.3"), fallback: null } });
	assert.equal(footprint(p), "fable · opus · sonnet · +1");
	assert.deepEqual(profileProviders(p).sort(), ["claude", "zai"]);
	assert.deepEqual(profileProviders(profile("z", "Z", { delegate: Object.fromEntries(Object.entries(delegateDefaults().profiles).map(([k]) => [k, { primary: pi("zai/glm-5.3"), fallback: null }])) as SubagentProfile["delegate"] })), ["zai"]);
});

test("idFor slugs a name and never takes off or a used id", () => {
	assert.equal(idFor("Codex Only!", []), "codex-only");
	assert.equal(idFor("Codex only", ["codex-only"]), "codex-only-2");
	assert.equal(idFor("off", []), "off-profile");
	assert.equal(idFor("!!!", []), "profile");
});
