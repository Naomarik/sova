import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { delegateDefaults } from "../mode/delegate.ts";
import { ALIGN_STYLES } from "../mode/align-settings.ts";
import { defaultTeamDefaults, writeTeamDefaults } from "./team-defaults.ts";
import {
	footprint,
	idFor,
	legacyProfile,
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
	shortModel,
	helperProfileOf,
	NO_HELPER_PROFILE_ENV,
	pickableHelpers,
	subagentProfileDefaultPath,
	subagentProfilesPath,
	seedReviewer,
	defaultReviewer,
	writeProfilesDefault,
	writeSubagentProfiles,
	type SubagentProfile,
	type SubagentProfilesFile,
} from "./subagent-profiles.ts";
import { builtinHelpers, builtinsFor, builtinDefaultFor, readAccountsAt, accountPaths, BUILTIN_PROFILE_IDS, type ConnectedAccounts } from "./builtin-profiles.ts";

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
	assert.deepEqual([...new Set(specifiers.filter((s) => !s!.startsWith("node:")))].sort(), ["../claude-code/catalog.ts", "../mode/align-settings.ts", "../mode/delegate.ts", "../mode/spec.ts", "./builtin-profiles.ts", "./team-defaults.ts"]);
});

test("parse: a valid file round-trips; every error is collected, not the first", () => {
	const ok = parseSubagentProfiles(JSON.stringify(file([profile("a", "A")])));
	assert.equal(ok.ok, true);
	const bad = parseSubagentProfiles({
		version: 2,
		default: "a",
		extra: 1,
		profiles: [
			profile("off", "Off"),
			{ ...profile("b", "B"), teams: 1 },
			profile("c", "C"),
			profile("c", "c"),
		],
	});
	assert.equal(bad.ok, false);
	const errors = (bad as { errors: string[] }).errors.join("\n");
	for (const want of ["version: must be 1", "extra: unknown key", "default: the default is this device's own", "profiles[0].id", "profiles[0].name", "profiles[1].teams", 'the id "c" is used twice', 'the name "c" is used twice'])
		assert.ok(errors.includes(want), `missing ${want} in\n${errors}`);
});

test("the retired members key: what an older build wrote reads as that build reads it and is written back; absent reads null; nothing routes from it", () => {
	const raw = (members: unknown) => {
		const p: Record<string, unknown> = { ...profile("a", "A") };
		if (members === undefined) delete p.members;
		else p.members = members;
		return { version: 1, profiles: [p] };
	};
	const cases: [unknown, unknown][] = [
		[pi("zai/glm-5.3"), pi("zai/glm-5.3")],
		[claude("claude-sonnet-5-5"), claude("claude-sonnet-5-5")],
		[claude("opus[1m]"), claude("claude-opus-5-5")], // an older build reads its catalog id, and hashes that
		[null, null],
		[undefined, null],
	];
	for (const [members, read] of cases) {
		const label = JSON.stringify(members) ?? "absent";
		const parsed = parseSubagentProfiles(raw(members));
		assert.ok(parsed.ok, `${label}: ${!parsed.ok && parsed.errors.join("; ")}`);
		assert.deepEqual(parsed.value.profiles[0]!.members, read, label);
		const dir = tempDir();
		writeSubagentProfiles(dir, parsed.value);
		const [onDisk] = JSON.parse(fs.readFileSync(subagentProfilesPath(dir), "utf8")).profiles;
		assert.ok("members" in onDisk, `${label}: every profile carries the key an older reader requires`);
		assert.deepEqual(onDisk.members, read, `${label}: written back`);
		const again = readSubagentProfiles(dir);
		assert.deepEqual(again.state === "ok" && again.value.profiles[0]!.members, read, `${label}: round-trips`);
	}
	// A value an older build refuses would be refused there as soon as this host sent it.
	const refused = parseSubagentProfiles(raw({ backend: "pi", model: "no-slash", effort: "low" }));
	assert.ok(!refused.ok && refused.errors.some((e) => e.startsWith("profiles[0].members:")));
	// A new profile writes null.
	const fresh = tempDir();
	writeSubagentProfiles(fresh, { version: 1, profiles: [legacyProfile(fresh, "n", "N")] });
	assert.equal(JSON.parse(fs.readFileSync(subagentProfilesPath(fresh), "utf8")).profiles[0].members, null);
	// …and nothing resolves, counts or shows from a saved value.
	const dir = tempDir();
	const base = profile("b", "B");
	const held = { ...base, members: pi("zai/members-only") };
	writeSubagentProfiles(dir, { version: 1, profiles: [held] });
	assert.equal("members" in resolveSubagents(dir, "b"), false);
	assert.equal(footprint(held), footprint(base));
	assert.deepEqual(profileProviders(held), profileProviders(base));
	assert.deepEqual(profileSlots(held), profileSlots(base));
});

test("parse: the library has no artificial profile count limit", () => {
	const profiles = Array.from({ length: 101 }, (_, i) => profile(`p-${i}`, `Setup ${i}`));
	const parsed = parseSubagentProfiles(file(profiles));
	assert.equal(parsed.ok, true);
	if (parsed.ok) assert.equal(parsed.value.profiles.length, profiles.length);
});

test("parse: a teams section takes team-defaults' rules, and its defaults fill what it leaves out", () => {
	const parsed = parseSubagentProfiles(file([profile("a", "A", { teams: { coordinator: { ...defaultTeamDefaults().coordinator }, monitor: { ...defaultTeamDefaults().monitor }, handover: { retireTimeoutMinutes: 10 } } })]));
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

test("the default as resolution uses it: the file's choice (a library or built-in profile); absent, \"off\", malformed or dangling reads as the fallback", () => {
	const dir = tempDir();
	writeSubagentProfiles(dir, file([profile("a", "A")]));
	const lib = loadSubagentProfiles(dir);
	// [what the default file holds (undefined: no file), the fallback, the default it reads as, its note]
	const cases: [string | undefined, "claude" | "openai" | null, string | null, RegExp | undefined][] = [
		[undefined, "openai", "openai", undefined],
		[undefined, null, null, undefined],
		["a", "openai", "a", undefined],
		["claude", "openai", "claude", undefined], // Make Default on a built-in profile
		[OFF_PROFILE_ID, "claude", "claude", undefined], // an older build's Off: no choice (q6)
		[OFF_PROFILE_ID, null, null, undefined],
		["gone", "claude", "claude", /names no profile/],
		["{ nope", "openai", "openai", /malformed/],
	];
	for (const [held, fallback, id, note] of cases) {
		fs.rmSync(subagentProfileDefaultPath(dir), { force: true });
		if (held === "{ nope") fs.writeFileSync(subagentProfileDefaultPath(dir), held);
		else if (held !== undefined) writeProfilesDefault(dir, { version: 1, default: held });
		const d = profilesDefaultOf(lib, readProfilesDefault(dir), fallback);
		const label = `${held} with fallback ${fallback}`;
		assert.equal(d.id, id, label);
		if (note) assert.match(d.note ?? "", note, label);
		else assert.equal(d.note, undefined, label);
	}
});

test("no seeding (b1): a missing library reads as an empty one, writes nothing, and the built-in default resolves before the legacy files", () => {
	const dir = tempDir();
	// Legacy files that an older build would have seeded from: no longer read while the library is fine.
	fs.writeFileSync(path.join(dir, "mode-delegate.json"), JSON.stringify({ version: 1, profiles: { routine: { primary: pi("legacy/model"), fallback: null } } }));
	writeTeamDefaults(dir, defaultTeamDefaults());
	const before = fs.readdirSync(dir).sort();
	// This process may run the team tests, which run with no helper profile: not here (synchronous, so nothing interleaves).
	const held = process.env[NO_HELPER_PROFILE_ENV];
	delete process.env[NO_HELPER_PROFILE_ENV];
	const r = resolveSubagents(dir, undefined);
	if (held !== undefined) process.env[NO_HELPER_PROFILE_ENV] = held;
	const state = loadSubagentProfiles(dir);
	assert.equal(state.state, "ok");
	assert.deepEqual(state.state === "ok" && state.value.profiles, []);
	assert.notEqual(r.source, "legacy");
	assert.equal(r.id, "claude", "no account connected: the built-in Claude profile");
	assert.deepEqual(r.delegate?.profiles, builtinHelpers("claude").delegate);
	assert.deepEqual(fs.readdirSync(dir).sort(), before, "nothing written: no library, no default file");
	// A malformed team-defaults.json beside it changes nothing either.
	fs.writeFileSync(path.join(dir, "team-defaults.json"), "{ nope");
	assert.equal(resolveSubagents(dir, undefined, undefined, undefined, "openai").id, "openai");
	assert.equal(fs.existsSync(subagentProfilesPath(dir)), false);
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

test("resolution order: the chat's pick, then this device's default, then the built-in fallback; only a malformed library reads the legacy files", () => {
	const dir = tempDir();
	fs.writeFileSync(path.join(dir, "mode-delegate.json"), JSON.stringify({ version: 1, profiles: { routine: { primary: pi("legacy/model"), fallback: null } } }));
	const a = profile("a", "A");
	const b = profile("b", "B", { delegate: { ...delegateDefaults().profiles, routine: { primary: pi("zai/glm-5.3"), fallback: null } } });
	writeSubagentProfiles(dir, file([a, b]));
	writeProfilesDefault(dir, { version: 1, default: "a" });
	const picked = resolveSubagents(dir, "b");
	assert.equal(picked.source, "pick");
	assert.equal(picked.delegate?.profiles.routine.primary.model, "zai/glm-5.3");
	const followed = resolveSubagents(dir, undefined);
	assert.equal(followed.source, "default");
	assert.equal(followed.id, "a");
	const dangling = resolveSubagents(dir, "gone");
	assert.equal(dangling.id, "a", "a pick naming a deleted profile follows the default");
	assert.match(dangling.note ?? "", /no longer exists/);
	// A dangling default reads as the built-in fallback, saying so — never a leap to the legacy files while the library is fine.
	writeProfilesDefault(dir, { version: 1, default: "gone" });
	const orphan = resolveSubagents(dir, undefined, undefined, undefined, "openai");
	assert.equal(orphan.id, "openai");
	assert.equal(orphan.source, "default");
	assert.match(orphan.note ?? "", /names no profile/);
	fs.writeFileSync(subagentProfilesPath(dir), "{ not json");
	const legacy = resolveSubagents(dir, "b");
	assert.equal(legacy.source, "legacy");
	assert.equal(legacy.delegate?.profiles.routine.primary.model, "legacy/model");
	assert.match(legacy.note ?? "", /malformed/);
});

test("an older build's Off (a pick, a default) follows this computer's default (q6); only Sova's own chats (fallback null) get no helper profile (b3)", () => {
	const dir = tempDir();
	writeTeamDefaults(dir, defaultTeamDefaults());
	writeSubagentProfiles(dir, file([profile("a", "A", { specWriter: { primary: claude("claude-opus-5-5"), fallback: null } })]));
	writeProfilesDefault(dir, { version: 1, default: "a" });
	assert.equal(resolveSubagents(dir, OFF_PROFILE_ID).id, "a", "an Off pick reads as no pick");
	assert.equal(resolveSubagents(dir, OFF_PROFILE_ID).source, "default");
	writeProfilesDefault(dir, { version: 1, default: OFF_PROFILE_ID });
	assert.equal(resolveSubagents(dir, undefined, undefined, undefined, "openai").id, "openai", "an Off default reads as not chosen");
	// Sova's own chats: no default chosen gives no helper profile, as before built-in profiles existed.
	fs.rmSync(subagentProfileDefaultPath(dir));
	for (const pick of [undefined, OFF_PROFILE_ID]) {
		const r = resolveSubagents(dir, pick, undefined, undefined, null);
		assert.equal(r.delegate, null);
		assert.equal(r.reviewer, null);
		assert.equal(r.spec.writer, null);
		assert.equal(r.teams.state, "absent", "a team-defaults.json beside it is not read");
	}
	// …but a default the computer chose still applies to them, as it always did.
	writeProfilesDefault(dir, { version: 1, default: "a" });
	assert.equal(resolveSubagents(dir, undefined, undefined, undefined, null).id, "a");
	// And nothing here was rewritten.
	assert.equal(readProfilesDefault(dir).state === "ok" && (readProfilesDefault(dir) as { value: { default: string } }).value.default, "a");
});

test("built-in profiles: each resolves by its id; a profile of yours takes its place by id, then name, then (Claude) the seeded starter shown as Claude", () => {
	const dir = tempDir();
	for (const id of BUILTIN_PROFILE_IDS) assert.deepEqual(resolveSubagents(dir, id).delegate?.profiles, builtinHelpers(id).delegate, id);
	const routine = (model: string) => ({ ...delegateDefaults().profiles, routine: { primary: pi(model), fallback: null } });
	// [the library, the built-in, the profile that takes its place (undefined: the built-in itself), its name]
	const cases: [SubagentProfile[], "claude" | "openai", string | undefined, string][] = [
		[[], "claude", undefined, "Claude"],
		[[profile("my-setup", "My setup")], "claude", "my-setup", "Claude"],
		[[profile("my-setup", "My setup"), profile("work", "claude")], "claude", "work", "claude"],
		[[profile("my-setup", "My setup"), profile("claude", "Mine")], "claude", "claude", "Mine"],
		[[profile("my-setup", "My setup")], "openai", undefined, "OpenAI"],
		[[profile("x", "OpenAI")], "openai", "x", "OpenAI"],
	];
	for (const [profiles, id, by, name] of cases) {
		const lib = profiles.map((p, i) => ({ ...p, delegate: routine(`own/${i}`) }));
		const label = `${profiles.map((p) => `${p.id}:${p.name}`).join(",") || "none"} → ${id}`;
		const got = helperProfileOf(id, lib)!;
		assert.equal(got.id, by ?? id, label);
		assert.equal(got.name, name, label);
		writeSubagentProfiles(dir, file(lib));
		assert.equal(resolveSubagents(dir, undefined, undefined, undefined, id).name, name, `${label}: the default`);
		const listed = pickableHelpers(lib, { claude: true, openai: true, ollamaCloud: false });
		assert.equal(listed.filter((p) => p.name.toLowerCase() === name.toLowerCase()).length, 1, `${label}: listed once`);
	}
	// The seeded starter's file is not rewritten: the name is how it is shown.
	writeSubagentProfiles(dir, file([profile("my-setup", "My setup")]));
	const raw = fs.readFileSync(subagentProfilesPath(dir), "utf8");
	resolveSubagents(dir, undefined, undefined, undefined, "claude");
	assert.equal(fs.readFileSync(subagentProfilesPath(dir), "utf8"), raw);
	assert.match(raw, /"My setup"/);
});

test("the built-in default by connected accounts (b2): Claude, then OpenAI, then DeepSeek; none: Claude; each listed only when connected", () => {
	for (const claudeOn of [false, true])
		for (const openai of [false, true])
			for (const ollamaCloud of [false, true]) {
				const c: ConnectedAccounts = { claude: claudeOn, openai, ollamaCloud };
				const want = claudeOn ? "claude" : openai ? "openai" : ollamaCloud ? "deepseek" : "claude";
				assert.equal(builtinDefaultFor(c), want, JSON.stringify(c));
				const listed = builtinsFor(c);
				assert.deepEqual(listed, claudeOn || openai || ollamaCloud ? BUILTIN_PROFILE_IDS.filter((id) => (id === "claude" ? claudeOn : id === "openai" ? openai : ollamaCloud)) : ["claude"], JSON.stringify(c));
			}
	// The accounts as read from their files: a Claude sign-in (credentials, or an account in .claude.json as on macOS),
	// pi's own OpenAI sign-in, an Ollama Cloud key; nothing else counts (a Z.ai or DeepSeek key, local Ollama).
	const home = tempDir();
	const agent = path.join(home, "agent");
	fs.mkdirSync(agent);
	const paths = accountPaths(agent, {}, home);
	const read = () => readAccountsAt(paths);
	assert.deepEqual(read(), { claude: false, openai: false, ollamaCloud: false });
	fs.writeFileSync(paths.piAuth, JSON.stringify({ zai: { type: "api_key", key: "k" }, deepseek: { type: "api_key", key: "k" }, ollama: { type: "api_key", key: "k" } }));
	assert.deepEqual(read(), { claude: false, openai: false, ollamaCloud: false });
	fs.writeFileSync(paths.piAuth, JSON.stringify({ "openai-codex": { type: "oauth", access: "t" }, "ollama-cloud": { type: "api_key", key: "k" } }));
	assert.deepEqual(read(), { claude: false, openai: true, ollamaCloud: true });
	fs.writeFileSync(paths.claudeJson, JSON.stringify({ oauthAccount: { emailAddress: "a@b.c" } }));
	assert.equal(read().claude, true, "macOS keeps the token in the keychain: the account in .claude.json says it is signed in");
	fs.rmSync(paths.claudeJson);
	fs.mkdirSync(path.dirname(paths.claudeCreds), { recursive: true });
	fs.writeFileSync(paths.claudeCreds, JSON.stringify({ claudeAiOauth: { accessToken: "t" } }));
	assert.equal(read().claude, true);
});

test("a profile's teams resolve in team-defaults' own shape; null is absent", () => {
	const dir = tempDir();
	const teams = { coordinator: { ...defaultTeamDefaults().coordinator }, monitor: { ...defaultTeamDefaults().monitor, contextPct: 42 }, handover: { retireTimeoutMinutes: 3 } };
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
		coordinator: { ...defaultTeamDefaults().coordinator, enabled: false },
		monitor: { ...defaultTeamDefaults().monitor, enabled: false },
		handover: { retireTimeoutMinutes: 10 },
	};
	const p = profile("a", "A", { teams, specWriter: { primary: claude("claude-opus-5-5"), fallback: pi("zai/glm-5.3") } });
	const slots = profileSlots(p);
	const labels = slots.map((s) => s.label);
	for (const want of ["Planning & specs primary", "Planning & specs fallback", "Coordinator primary", "Monitor primary", "Spec writer primary", "Spec writer fallback"])
		assert.ok(labels.includes(want), `missing ${want} in ${labels.join(", ")}`);
	assert.equal(profileSlots(profile("b", "B")).some((s) => s.label.startsWith("Coordinator")), false, "teams: null declares no teams slots at all");
	assert.equal(labels.some((l) => /member/i.test(l)), false, "no members slot: members run on their kind's route");
});

test("footprints and providers", () => {
	// A Claude model reads its catalog name, under any id it was stored as (§app.claude-code-provider/model-names).
	assert.equal(shortModel("claude-opus-5-5"), "Opus 5.5");
	assert.equal(shortModel("opus[1m]"), "Opus 5.5");
	assert.equal(shortModel("claude-fable-5-1"), "Fable 5.1");
	assert.equal(shortModel("zai/glm-5.3"), "glm-5.3");
	assert.equal(shortModel("claude-code-cli/claude-sonnet-4-6"), "Sonnet 4.6");
	const p = profile("a", "A", { specWriter: { primary: pi("zai/glm-5.3"), fallback: null } });
	assert.equal(footprint(p), "Fable 5.2 · Opus 5.5 · glm-5.3");
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
	const reviewer = { primary: pi("openai-codex/gpt-6.1-sol", "high"), fallback: claude("claude-opus-5-5", "high") };
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
	// Resolution carries it; no helper profile and an older profile have none.
	writeSubagentProfiles(dir, file([profile("old", "Old"), profile("r", "R", { reviewer })]));
	writeProfilesDefault(dir, { version: 1, default: "r" });
	assert.deepEqual(resolveSubagents(dir, undefined).reviewer, reviewer);
	assert.equal(resolveSubagents(dir, "old").reviewer, null);
	writeProfilesDefault(dir, { version: 1, default: OFF_PROFILE_ID });
	assert.equal(resolveSubagents(dir, undefined, undefined, undefined, null).reviewer, null);
	// Its slots are validated on save and counted in the providers.
	assert.deepEqual(profileSlots(profile("r", "R", { reviewer })).slice(-2).map((s) => s.label), ["Reviewer primary", "Reviewer fallback"]);
	assert.ok(profileProviders(profile("r", "R", { reviewer })).includes("openai-codex"));
});

test("seedReviewer: the default goes only to profiles without the key; None and routes stay; a second run writes nothing", () => {
	const dir = tempDir();
	const mine = { primary: claude("claude-sonnet-5-5", "high"), fallback: null };
	writeSubagentProfiles(dir, file([profile("bare", "Bare"), profile("none", "None", { reviewer: null }), profile("mine", "Mine", { reviewer: mine })]));
	const first = seedReviewer(dir);
	assert.deepEqual(first, { ok: true, seeded: ["bare"] });
	const after = readSubagentProfiles(dir);
	assert.ok(after.state === "ok");
	const [bare, none, own] = after.value.profiles;
	assert.deepEqual(bare!.reviewer, defaultReviewer());
	assert.deepEqual(defaultReviewer(), { primary: { backend: "pi", model: "openai-codex/gpt-6.2-sol", effort: "high" }, fallback: { backend: "claude-code", model: "claude-opus-5-5", effort: "high" } });
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

test("alignment (Eagerness, writing style, Visuals): optional, field by field over the host's mode-align.json; no override reads as before", () => {
	const parsed = parseSubagentProfiles(file([profile("old", "Old"), profile("pm", "PM", { alignment: { style: "pm" } }), profile("vis", "Vis", { alignment: { visuals: true } }), profile("careful", "Careful", { alignment: { eagerness: "careful" } })]));
	assert.ok(parsed.ok);
	const [old, pm, vis] = parsed.value.profiles;
	assert.equal("alignment" in old!, false, "a parse never adds the key");
	assert.deepEqual(pm!.alignment, { style: "pm" });
	assert.deepEqual(vis!.alignment, { visuals: true });
	assert.deepEqual(parsed.value.profiles[3]!.alignment, { eagerness: "careful" }, "an Eagerness override parses");
	const dir = tempDir();
	writeSubagentProfiles(dir, file([profile("old", "Old")]));
	assert.equal(fs.readFileSync(subagentProfilesPath(dir), "utf8").includes("alignment"), false, "a profile without one writes none");
	// Strict: never empty, nothing unknown, each value checked, named under the profile.
	for (const [alignment, error] of [
		[{}, /^profiles\[0\]\.alignment must set eagerness, style or visuals/m],
		[{ eagerness: "bold" }, /^profiles\[0\]\.alignment\.eagerness must be one of eager, careful/m],
		[{ style: "expert" }, new RegExp(`^profiles\\[0\\]\\.alignment\\.style must be one of ${ALIGN_STYLES.join(", ")}$`, "m")],
		[{ visuals: "on" }, /^profiles\[0\]\.alignment\.visuals must be true or false/m],
		[{ review: true }, /^profiles\[0\]\.alignment: unknown field "review"/m],
	] as const) {
		const bad = parseSubagentProfiles(file([profile("p", "P", { alignment: alignment as never })]));
		assert.ok(!bad.ok && error.test(bad.errors.join("\n")), JSON.stringify(bad));
	}
	// Resolution order: the chat's pick, then this device's default; no helper profile and the legacy files have none.
	writeSubagentProfiles(dir, file([profile("old", "Old"), profile("pm", "PM", { alignment: { style: "pm", visuals: false } })]));
	writeProfilesDefault(dir, { version: 1, default: "pm" });
	assert.deepEqual(resolveSubagents(dir, undefined).alignment, { style: "pm", visuals: false }, "the default's");
	assert.equal(resolveSubagents(dir, "old").alignment, null, "a pick with no override: the host's file");
	assert.deepEqual(resolveSubagents(dir, "gone").alignment, { style: "pm", visuals: false }, "a dangling pick follows the default");
	assert.deepEqual(resolveSubagents(dir, OFF_PROFILE_ID).alignment, { style: "pm", visuals: false }, "an older Off pick follows the default");
	fs.writeFileSync(subagentProfilesPath(dir), "{ not json");
	assert.equal(resolveSubagents(dir, "pm").alignment, null, "an unusable library: the legacy files, no override");
	// A profile with no override reads byte-identical to one from before the field existed.
	const before = profile("old", "Old");
	writeSubagentProfiles(dir, file([before]));
	assert.equal(fs.readFileSync(subagentProfilesPath(dir), "utf8"), `${JSON.stringify(file([before]), null, 2)}\n`);
});
