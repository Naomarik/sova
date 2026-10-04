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
	parseProfilesDefault,
	parseSubagentProfiles,
	PICK_ENTRY_TYPE,
	pickEntryFor,
	profileProviders,
	profileSlots,
	profilesDefaultOf,
	readProfilesDefault,
	readSubagentProfiles,
	resolveSubagents,
	restorePick,
	SEEDED_PROFILE_ID,
	shortModel,
	subagentProfileDefaultPath,
	subagentProfilesPath,
	seedReviewer,
	DEFAULT_REVIEWER,
	writeProfilesDefault,
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
const file = (profiles: SubagentProfile[]): SubagentProfilesFile => ({ version: 1, profiles });

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
		default: "a",
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
	for (const want of ["version: must be 1", "extra: unknown key", "default: the default is this device's own", "profiles[0].id", "profiles[0].name", "profiles[1].members", 'the id "c" is used twice', 'the name "c" is used twice'])
		assert.ok(errors.includes(want), `missing ${want} in\n${errors}`);
});

test("parse: the library has no artificial profile count limit", () => {
	const profiles = Array.from({ length: 101 }, (_, i) => profile(`p-${i}`, `Setup ${i}`));
	const parsed = parseSubagentProfiles(file(profiles));
	assert.equal(parsed.ok, true);
	if (parsed.ok) assert.equal(parsed.value.profiles.length, profiles.length);
});

test("parse: a teams section takes team-defaults' rules, and its defaults fill what it leaves out", () => {
	const parsed = parseSubagentProfiles(file([profile("a", "A", { teams: { coordinator: { ...DEFAULT_TEAM_DEFAULTS.coordinator }, monitor: { ...DEFAULT_TEAM_DEFAULTS.monitor }, handover: { retireTimeoutMinutes: 10 } } })]));
	assert.equal(parsed.ok, true);
	const bad = parseSubagentProfiles({ version: 1, profiles: [{ ...profile("a", "A"), teams: { monitor: { contextPct: 0 } } }] });
	assert.equal(bad.ok, false);
	assert.match((bad as { errors: string[] }).errors.join(), /profiles\[0\]\.teams\.monitor\.contextPct/);
});

test("the default file: strict parse, atomic write, never a partial file", () => {
	assert.deepEqual(parseProfilesDefault('{"version":1,"default":"off"}'), { ok: true, value: { version: 1, default: "off" } });
	for (const bad of ["{", '{"version":2,"default":"a"}', '{"version":1,"default":"A"}', '{"version":1,"default":"a","extra":1}', '{"version":1}'])
		assert.equal(parseProfilesDefault(bad).ok, false, bad);
	const dir = tempDir();
	assert.throws(() => writeProfilesDefault(dir, { version: 1, default: "Bad Id" }), /Refusing to write/);
	assert.equal(fs.existsSync(subagentProfileDefaultPath(dir)), false);
	writeProfilesDefault(dir, { version: 1, default: "a" });
	const state = readProfilesDefault(dir);
	assert.equal(state.state, "ok");
	assert.equal(state.state === "ok" && state.value.default, "a");
	fs.writeFileSync(subagentProfileDefaultPath(dir), "{ nope");
	assert.equal(readProfilesDefault(dir).state, "malformed");
	assert.match(fs.readFileSync(subagentProfileDefaultPath(dir), "utf8"), /nope/, "a malformed file is never overwritten by a reader");
});

test("the default as resolution uses it: file's choice; absent, malformed or dangling reads as Off with the reason", () => {
	const dir = tempDir();
	writeSubagentProfiles(dir, file([profile("a", "A")]));
	const lib = loadSubagentProfiles(dir);
	assert.equal(profilesDefaultOf(lib, readProfilesDefault(dir)).id, OFF_PROFILE_ID, "a library with no default file: no default");
	writeProfilesDefault(dir, { version: 1, default: "a" });
	assert.deepEqual(profilesDefaultOf(lib, readProfilesDefault(dir)), { id: "a" });
	writeProfilesDefault(dir, { version: 1, default: "gone" });
	const dangling = profilesDefaultOf(lib, readProfilesDefault(dir));
	assert.equal(dangling.id, OFF_PROFILE_ID);
	assert.match(dangling.note ?? "", /names no profile/);
});

test("seed: an absent library and default file are written once from the legacy files, never replacing newer files", () => {
	const dir = tempDir();
	fs.writeFileSync(path.join(dir, "mode-delegate.json"), JSON.stringify({ version: 1, profiles: { routine: { primary: pi("zai/glm-5.3"), fallback: null } } }));
	fs.writeFileSync(path.join(dir, "mode-spec.json"), JSON.stringify({ version: 1, writer: { primary: claude("sonnet", "medium"), fallback: null } }));
	writeTeamDefaults(dir, DEFAULT_TEAM_DEFAULTS);
	const state = loadSubagentProfiles(dir);
	assert.equal(state.state, "ok");
	const seeded = (state as { value: SubagentProfilesFile }).value;
	assert.equal(seeded.profiles.length, 1);
	assert.deepEqual(seeded.profiles[0]!.delegate.routine.primary, pi("zai/glm-5.3"));
	assert.deepEqual(seeded.profiles[0]!.delegate.planning, delegateDefaults().profiles.planning, "a slot the legacy file leaves out takes its default, as Delegate read it");
	assert.equal(seeded.profiles[0]!.specWriter?.primary.model, "sonnet");
	assert.equal(seeded.profiles[0]!.teams?.coordinator.role, "coordinator");
	assert.equal(seeded.profiles[0]!.members, null);
	assert.equal(readSubagentProfiles(dir).state, "ok", "the library seed is on disk");
	const def = readProfilesDefault(dir);
	assert.equal(def.state === "ok" && def.value.default, SEEDED_PROFILE_ID, "the seeded default names the seeded profile");
	// A second read never re-seeds over what is there now.
	writeSubagentProfiles(dir, file([profile("x", "X")]));
	assert.equal((loadSubagentProfiles(dir) as { value: SubagentProfilesFile }).value.profiles[0]!.id, "x");
	assert.equal(readProfilesDefault(dir).state === "ok" && (readProfilesDefault(dir) as { value: { default: string } }).value.default, SEEDED_PROFILE_ID, "the device default is left alone (it now dangles, which resolution reads as Off)");
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

test("seed: a malformed team-defaults.json is not seeded over: the legacy files, and their warning, keep applying", () => {
	const dir = tempDir();
	fs.writeFileSync(path.join(dir, "team-defaults.json"), "{ nope");
	assert.equal(loadSubagentProfiles(dir).state, "absent");
	assert.equal(fs.existsSync(subagentProfilesPath(dir)), false);
	assert.equal(fs.existsSync(subagentProfileDefaultPath(dir)), false, "the default file is not seeded either");
	const r = resolveSubagents(dir, undefined);
	assert.equal(r.source, "legacy");
	assert.equal(r.teams.state, "malformed");
	writeTeamDefaults(dir, DEFAULT_TEAM_DEFAULTS);
	assert.equal(loadSubagentProfiles(dir).state, "ok", "seeded once it is fixed");
});

test("writer refuses an invalid value and never leaves a partial file", () => {
	const dir = tempDir();
	assert.throws(() => writeSubagentProfiles(dir, { version: 1, default: "a", profiles: [] }), /Refusing to write/);
	assert.throws(() => writeSubagentProfiles(dir, { version: 1, profiles: [profile("off", "Off")] }), /Refusing to write/);
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

test("resolution order: the chat's pick, then this device's default, then the legacy files", () => {
	const dir = tempDir();
	fs.writeFileSync(path.join(dir, "mode-delegate.json"), JSON.stringify({ version: 1, profiles: { routine: { primary: pi("legacy/model"), fallback: null } } }));
	const a = profile("a", "A", { members: claude("sonnet") });
	const b = profile("b", "B", { delegate: { ...delegateDefaults().profiles, routine: { primary: pi("zai/glm-5.3"), fallback: null } } });
	writeSubagentProfiles(dir, file([a, b]));
	writeProfilesDefault(dir, { version: 1, default: "a" });
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
	// A dangling default reads as Off, saying so — never a leap to the legacy files while the library is fine.
	writeProfilesDefault(dir, { version: 1, default: "gone" });
	const orphan = resolveSubagents(dir, undefined);
	assert.equal(orphan.id, OFF_PROFILE_ID);
	assert.equal(orphan.source, "default");
	assert.match(orphan.note ?? "", /names no profile/);
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
	writeSubagentProfiles(dir, file([profile("a", "A", { members: claude("sonnet"), specWriter: { primary: claude("opus"), fallback: null } })]));
	writeProfilesDefault(dir, { version: 1, default: OFF_PROFILE_ID });
	for (const r of [resolveSubagents(dir, undefined), resolveSubagents(dir, OFF_PROFILE_ID)]) {
		assert.equal(r.id, OFF_PROFILE_ID);
		assert.equal(r.delegate, null);
		assert.equal(r.teams.state, "absent", "a team-defaults.json beside it is not read under Off");
		assert.match(r.teams.state === "absent" ? (r.teams.note ?? "") : "", /configures nothing/);
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
	const none = resolveSubagents(dir, "b").teams;
	assert.equal(none.state, "absent");
	assert.match(none.state === "absent" ? (none.note ?? "") : "", /profile "B" configures none/);
});

test("profileSlots enumerates every slot — a disabled coordinator and monitor included", () => {
	const teams = {
		coordinator: { ...DEFAULT_TEAM_DEFAULTS.coordinator, enabled: false },
		monitor: { ...DEFAULT_TEAM_DEFAULTS.monitor, enabled: false },
		handover: { retireTimeoutMinutes: 10 },
	};
	const p = profile("a", "A", { teams, members: claude("sonnet"), specWriter: { primary: claude("opus"), fallback: pi("zai/glm-5.3") } });
	const slots = profileSlots(p);
	const labels = slots.map((s) => s.label);
	for (const want of ["Planning & specs primary", "Planning & specs fallback", "Members default", "Coordinator primary", "Monitor primary", "Spec writer primary", "Spec writer fallback"])
		assert.ok(labels.includes(want), `missing ${want} in ${labels.join(", ")}`);
	assert.equal(profileSlots(profile("b", "B")).some((s) => s.label.startsWith("Coordinator")), false, "teams: null declares no teams slots at all");
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

test("reviewer (adversarial review): optional — an older profile without it parses and stays without it; null is None", () => {
	const reviewer = { primary: pi("openai-codex/gpt-6.1-sol", "high"), fallback: claude("opus[1m]", "high") };
	const parsed = parseSubagentProfiles(file([profile("old", "Old"), profile("none", "None", { reviewer: null }), profile("r", "R", { reviewer })]));
	assert.ok(parsed.ok);
	const [old, none, r] = parsed.value.profiles;
	assert.equal("reviewer" in old!, false, "a parse never adds the key");
	assert.equal(none!.reviewer, null);
	assert.deepEqual(r!.reviewer, reviewer);
	const dir = tempDir();
	writeSubagentProfiles(dir, file([profile("old", "Old")]));
	assert.equal(fs.readFileSync(subagentProfilesPath(dir), "utf8").includes("reviewer"), false, "nothing written for a profile without one");
	// Strict like the spec writer, named in the Settings words.
	const bad = parseSubagentProfiles(file([profile("r", "R", { reviewer: { primary: pi("no-slash"), fallback: null } })]));
	assert.ok(!bad.ok);
	assert.match(bad.errors.join("\n"), /^profiles\[0\]\.reviewer: Reviewer primary: /m);
	const same = parseSubagentProfiles(file([profile("r", "R", { reviewer: { primary: pi("a/b"), fallback: pi("a/b") } })]));
	assert.ok(!same.ok && /Reviewer fallback: the same worker/.test(same.errors.join("\n")));
	// Resolution carries it; Off and an older profile have none.
	writeSubagentProfiles(dir, file([profile("old", "Old"), profile("r", "R", { reviewer })]));
	writeProfilesDefault(dir, { version: 1, default: "r" });
	assert.deepEqual(resolveSubagents(dir, undefined).reviewer, reviewer);
	assert.equal(resolveSubagents(dir, "old").reviewer, null);
	assert.equal(resolveSubagents(dir, OFF_PROFILE_ID).reviewer, null);
	// Its slots are validated on save and counted in the providers.
	assert.deepEqual(profileSlots(profile("r", "R", { reviewer })).slice(-2).map((s) => s.label), ["Reviewer primary", "Reviewer fallback"]);
	assert.ok(profileProviders(profile("r", "R", { reviewer })).includes("openai-codex"));
});

test("seedReviewer: the default goes only to profiles without the key; None and routes stay; a second run writes nothing", () => {
	const dir = tempDir();
	const mine = { primary: claude("sonnet", "high"), fallback: null };
	writeSubagentProfiles(dir, file([profile("bare", "Bare"), profile("none", "None", { reviewer: null }), profile("mine", "Mine", { reviewer: mine })]));
	const first = seedReviewer(dir);
	assert.deepEqual(first, { ok: true, seeded: ["bare"] });
	const after = readSubagentProfiles(dir);
	assert.ok(after.state === "ok");
	const [bare, none, own] = after.value.profiles;
	assert.deepEqual(bare!.reviewer, DEFAULT_REVIEWER);
	assert.deepEqual(DEFAULT_REVIEWER, { primary: { backend: "pi", model: "openai-codex/gpt-6.1-sol", effort: "high" }, fallback: { backend: "claude-code", model: "opus[1m]", effort: "high" } });
	assert.equal(none!.reviewer, null, "an explicit None is never overwritten");
	assert.deepEqual(own!.reviewer, mine, "an existing route is never overwritten");
	const bytes = fs.readFileSync(subagentProfilesPath(dir), "utf8");
	const mtime = fs.statSync(subagentProfilesPath(dir)).mtimeMs;
	assert.deepEqual(seedReviewer(dir), { ok: true, seeded: [] }, "idempotent");
	assert.equal(fs.readFileSync(subagentProfilesPath(dir), "utf8"), bytes);
	assert.equal(fs.statSync(subagentProfilesPath(dir)).mtimeMs, mtime, "not even rewritten");
	// A malformed library is never overwritten.
	fs.writeFileSync(subagentProfilesPath(dir), "{ nope");
	assert.deepEqual(seedReviewer(dir), { ok: false, seeded: [] });
	assert.equal(fs.readFileSync(subagentProfilesPath(dir), "utf8"), "{ nope");
});
