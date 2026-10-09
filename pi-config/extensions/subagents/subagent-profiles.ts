/**
 * Subagent profiles: the one reader and writer of `<agent dir>/subagent-profiles.json`, named
 * bundles of every model a session's subagents are given — Delegate's four work kinds, the team
 * coordinator, monitor and members default, the spec writer and (optional) the alignment reviewer. A chat picks one (its hidden
 * `subagent-profile` entry, newest on the branch wins); a chat with no pick follows this device's
 * default (`subagent-profiles-default.json`, its own tiny file so the mesh-synced library never
 * moves it); a missing pick target falls to the default, and an unusable library to the legacy
 * files (`mode-delegate.json`, `team-defaults.json`, `mode-spec.json`), which nothing here deletes.
 *
 * Node built-ins and builtins-only siblings only: the mode extension, the subagents extension and
 * Sova's server all import this file, so it must never import the pi runtime.
 *
 * Absent file = seeded on first read from the legacy files (one profile, "My setup", made the
 * default), so nothing changes until the user switches. Malformed = every error is returned, the
 * file is never overwritten by a reader, and resolution falls back to the legacy files.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	DELEGATE_FILE_NAME,
	DELEGATE_PROFILE_INFO,
	DELEGATE_PROFILES,
	loadDelegate,
	parseChoice,
	parseDelegate,
	type DelegateProfile,
	type DelegateProfileId,
	type DelegateSettings,
	type WorkerChoice,
} from "../mode/delegate.ts";
import { claudeName, latestClaude } from "../claude-code/catalog.ts";
import { parseAlignOverride, type AlignOverride } from "../mode/align-settings.ts";
import { loadSpec, parseSpec, SPEC_FILE_NAME, SPEC_WRITER_LABEL, specDefaults, type SpecSettings, type SpecWriter } from "../mode/spec.ts";
import {
	parseTeamDefaults,
	readTeamDefaults,
	type CoordinatorDefaults,
	type HandoverDefaults,
	type MonitorDefaults,
	type TeamDefaultsFile,
	type TeamDefaultsState,
} from "./team-defaults.ts";

export const SUBAGENT_PROFILES_FILE_NAME = "subagent-profiles.json";
/** This device's default (never synced): which library profile a chat with no pick follows. */
export const SUBAGENT_PROFILE_DEFAULT_FILE_NAME = "subagent-profiles-default.json";
/** The built-in profile that configures nothing: never stored, always first. */
export const OFF_PROFILE_ID = "off";
export const OFF_PROFILE_NAME = "Off";
/** The profile seeding writes; a fixed id, so two devices seeding apart agree on it. */
export const SEEDED_PROFILE_ID = "my-setup";
export const SEEDED_PROFILE_NAME = "My setup";
/** The reviewer's label, in Settings and in errors. */
export const REVIEWER_LABEL = "Reviewer";
/** The session's hidden custom entry carrying its pick: `{v: 1, profile}`. */
export const PICK_ENTRY_TYPE = "subagent-profile";
const MAX_NAME_CHARS = 48;
const ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export interface TeamsSetting {
	coordinator: CoordinatorDefaults;
	monitor: MonitorDefaults;
	handover: HandoverDefaults;
}
export interface SubagentProfile {
	id: string;
	name: string;
	delegate: Record<DelegateProfileId, DelegateProfile>;
	/** null: no standing coordinator or monitor. */
	teams: TeamsSetting | null;
	/** null: a member nobody gave a model runs on the parent's model. */
	members: WorkerChoice | null;
	/** null: the session writes the spec itself. */
	specWriter: SpecWriter | null;
	/**
	 * The alignment reviewer (adversarial review, behind the mode extension's `adversarial-review`
	 * flag): the same shape as the spec writer. null: None, no review. Absent: never set (an older
	 * profile), read as None; a parse never adds the key.
	 */
	reviewer?: ReviewerRoute | null;
	/**
	 * The align mode's writing style and Visuals for chats on this profile (§chat.alignment/settings-file):
	 * each field present only when it overrides the host's mode-align.json. Absent: both follow the host;
	 * a parse never adds the key.
	 */
	alignment?: AlignOverride;
}
/** The reviewer's route: exactly the spec writer's `{primary, fallback}`. */
export type ReviewerRoute = SpecWriter;
export interface SubagentProfilesFile {
	version: 1;
	profiles: SubagentProfile[];
}
/** The default file: this device's own choice, never synced (the library syncs). */
export interface SubagentProfilesDefault {
	version: 1;
	/** A profile's id, or "off". */
	default: string;
}
export interface PickEntryData {
	v: 1;
	profile: string;
}

export type ProfilesParse = { ok: true; value: SubagentProfilesFile } | { ok: false; errors: string[] };
export type ProfilesState =
	| { state: "absent"; file: string }
	| { state: "malformed"; file: string; errors: string[] }
	| { state: "ok"; file: string; value: SubagentProfilesFile; seeded?: boolean };
export type DefaultParse = { ok: true; value: SubagentProfilesDefault } | { ok: false; errors: string[] };
export type DefaultState =
	| { state: "absent"; file: string }
	| { state: "malformed"; file: string; errors: string[] }
	| { state: "ok"; file: string; value: SubagentProfilesDefault };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const subagentProfilesPath = (agentDir: string): string => path.join(agentDir, SUBAGENT_PROFILES_FILE_NAME);
export const subagentProfileDefaultPath = (agentDir: string): string => path.join(agentDir, SUBAGENT_PROFILE_DEFAULT_FILE_NAME);

/** A profile id's shape (the file's rule); "off" is never one. */
export const isProfileId = (value: unknown): value is string => typeof value === "string" && ID.test(value) && value !== OFF_PROFILE_ID;

/** A name's problem, or null. */
export function nameError(name: unknown): string | null {
	if (typeof name !== "string" || !name.trim()) return "must be a non-blank name";
	if (name.trim() !== name) return "must not start or end with spaces";
	if (name.length > MAX_NAME_CHARS) return `must be at most ${MAX_NAME_CHARS} characters`;
	if (CONTROL.test(name)) return "must be one line without control characters";
	if (name.toLowerCase() === OFF_PROFILE_NAME.toLowerCase()) return `"${OFF_PROFILE_NAME}" is the built-in profile's name`;
	return null;
}

/** An id for `name` not taken in `taken`: its slug, then -2, -3… */
export function idFor(name: string, taken: Iterable<string>): string {
	const used = new Set(taken);
	const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "profile";
	const safe = base === OFF_PROFILE_ID ? "off-profile" : base;
	if (!used.has(safe)) return safe;
	for (let n = 2; ; n++) if (!used.has(`${safe}-${n}`)) return `${safe}-${n}`;
}

function parseProfile(at: string, raw: unknown, errors: string[]): SubagentProfile | undefined {
	if (!isRecord(raw)) {
		errors.push(`${at}: must be an object`);
		return undefined;
	}
	const known = ["id", "name", "delegate", "teams", "members", "specWriter", "reviewer", "alignment"];
	for (const key of Object.keys(raw)) if (!known.includes(key)) errors.push(`${at}.${key}: unknown key`);
	const before = errors.length;
	if (!isProfileId(raw.id)) errors.push(`${at}.id: must be lowercase letters, digits and dashes (at most 48), and not "${OFF_PROFILE_ID}"`);
	const nameProblem = nameError(raw.name);
	if (nameProblem) errors.push(`${at}.name: ${nameProblem}`);
	const delegate = parseDelegate({ version: 1, profiles: raw.delegate });
	if ("error" in delegate) errors.push(`${at}.delegate: ${delegate.error}`);
	let teams: TeamsSetting | null = null;
	if (raw.teams !== null) {
		if (!isRecord(raw.teams)) errors.push(`${at}.teams: must be { coordinator, monitor, handover } or null`);
		else {
			const parsed = parseTeamDefaults({ ...raw.teams, version: 1 });
			if (!parsed.ok) errors.push(...parsed.errors.map((e) => `${at}.teams.${e}`));
			else teams = { coordinator: parsed.value.coordinator, monitor: parsed.value.monitor, handover: parsed.value.handover };
		}
	}
	let members: WorkerChoice | null = null;
	if (raw.members !== null) {
		const parsed = parseChoice(raw.members);
		if ("error" in parsed) errors.push(`${at}.members: ${parsed.error} (or null for none)`);
		else members = parsed;
	}
	let specWriter: SpecWriter | null = null;
	if (raw.specWriter !== null) {
		const parsed = parseSpec({ version: 1, writer: raw.specWriter });
		if ("error" in parsed) errors.push(`${at}.specWriter: ${parsed.error}`);
		else specWriter = parsed.writer;
	}
	let reviewer: ReviewerRoute | null | undefined;
	if (raw.reviewer === null) reviewer = null;
	else if (raw.reviewer !== undefined) {
		const parsed = parseSpec({ version: 1, writer: raw.reviewer });
		if ("error" in parsed) errors.push(`${at}.reviewer: ${parsed.error.replaceAll(SPEC_WRITER_LABEL, REVIEWER_LABEL)}`);
		else reviewer = parsed.writer;
	}
	let alignment: AlignOverride | undefined;
	if (raw.alignment !== undefined) {
		const parsed = parseAlignOverride(raw.alignment, `${at}.alignment`);
		if ("error" in parsed) errors.push(parsed.error);
		else alignment = parsed;
	}
	if (errors.length > before || "error" in delegate) return undefined;
	return {
		id: raw.id as string,
		name: raw.name as string,
		delegate: delegate.profiles,
		teams,
		members,
		specWriter,
		...(reviewer === undefined ? {} : { reviewer }),
		...(alignment === undefined ? {} : { alignment }),
	};
}

/** Strict validation of the whole file (or its raw text). Every error is collected; on any, no value. */
export function parseSubagentProfiles(input: unknown): ProfilesParse {
	let json = input;
	if (typeof input === "string") {
		try {
			json = JSON.parse(input);
		} catch (error) {
			return { ok: false, errors: [`not valid JSON: ${(error as Error).message}`] };
		}
	}
	const errors: string[] = [];
	if (!isRecord(json)) return { ok: false, errors: ["must be an object { version: 1, profiles }"] };
	for (const key of Object.keys(json))
		if (!["version", "profiles"].includes(key))
			errors.push(
				key === "default"
					? `default: the default is this device's own — move it to ${SUBAGENT_PROFILE_DEFAULT_FILE_NAME} and remove it here`
					: `${key}: unknown key`,
			);
	if (json.version !== 1) errors.push("version: must be 1");
	if (!Array.isArray(json.profiles)) {
		errors.push("profiles: must be an array");
		return { ok: false, errors };
	}
	const profiles: SubagentProfile[] = [];
	json.profiles.forEach((raw, i) => {
		const profile = parseProfile(`profiles[${i}]`, raw, errors);
		if (profile) profiles.push(profile);
	});
	const ids = new Set<string>();
	const names = new Set<string>();
	for (const p of profiles) {
		if (ids.has(p.id)) errors.push(`profiles: the id "${p.id}" is used twice`);
		if (names.has(p.name.toLowerCase())) errors.push(`profiles: the name "${p.name}" is used twice`);
		ids.add(p.id);
		names.add(p.name.toLowerCase());
	}
	return errors.length ? { ok: false, errors } : { ok: true, value: { version: 1, profiles } };
}

/** The file as it stands now: absent, malformed (with every error) or ok. Never writes. */
export function readSubagentProfiles(agentDir: string): ProfilesState {
	const file = subagentProfilesPath(agentDir);
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent", file };
		return { state: "malformed", file, errors: [`cannot read: ${(error as Error).message}`] };
	}
	const parsed = parseSubagentProfiles(raw);
	return parsed.ok ? { state: "ok", file, value: parsed.value } : { state: "malformed", file, errors: parsed.errors };
}

/** Strict validation of the default file (or its raw text). */
export function parseProfilesDefault(input: unknown): DefaultParse {
	let json = input;
	if (typeof input === "string") {
		try {
			json = JSON.parse(input);
		} catch (error) {
			return { ok: false, errors: [`not valid JSON: ${(error as Error).message}`] };
		}
	}
	const errors: string[] = [];
	if (!isRecord(json)) return { ok: false, errors: ["must be an object { version: 1, default }"] };
	for (const key of Object.keys(json)) if (!["version", "default"].includes(key)) errors.push(`${key}: unknown key`);
	if (json.version !== 1) errors.push("version: must be 1");
	if (json.default !== OFF_PROFILE_ID && !isProfileId(json.default)) errors.push(`default: must be "${OFF_PROFILE_ID}" or a profile id`);
	return errors.length ? { ok: false, errors } : { ok: true, value: { version: 1, default: json.default as string } };
}

/** The default file as it stands now. Never writes; absent means Off. */
export function readProfilesDefault(agentDir: string): DefaultState {
	const file = subagentProfileDefaultPath(agentDir);
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent", file };
		return { state: "malformed", file, errors: [`cannot read: ${(error as Error).message}`] };
	}
	const parsed = parseProfilesDefault(raw);
	return parsed.ok ? { state: "ok", file, value: parsed.value } : { state: "malformed", file, errors: parsed.errors };
}

/**
 * Validate, then write atomically (temp file + rename). Refuses a value that does not parse;
 * returns the normalized value it wrote.
 */
function writeJsonAtomic<P>(file: string, parsed: P, dir: string): P {
	fs.mkdirSync(dir, { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
		fs.renameSync(tmp, file);
	} catch (error) {
		try { fs.rmSync(tmp, { force: true }); } catch { /* Best effort. */ }
		throw error;
	}
	return parsed;
}

/** What the legacy files say now, as one profile (seeding, and "Save current" on a legacy chat). */
export function legacyProfile(agentDir: string, id = SEEDED_PROFILE_ID, name = SEEDED_PROFILE_NAME): SubagentProfile {
	const delegate = loadDelegate(path.join(agentDir, DELEGATE_FILE_NAME));
	const team = readTeamDefaults(agentDir);
	const spec = loadSpec(path.join(agentDir, SPEC_FILE_NAME));
	return {
		id,
		name,
		delegate: clone(delegate.profiles),
		teams: team.state === "ok" ? { coordinator: team.value.coordinator, monitor: team.value.monitor, handover: team.value.handover } : null,
		members: null,
		specWriter: spec.writer ? clone(spec.writer) : null,
	};
}

/** A library holding exactly one profile seeded from the legacy files. */
export function seededFile(agentDir: string): SubagentProfilesFile {
	return { version: 1, profiles: [legacyProfile(agentDir)] };
}

/** The default a fresh seeding writes: the seeded profile. */
export function seededDefault(): SubagentProfilesDefault {
	return { version: 1, default: SEEDED_PROFILE_ID };
}

/**
 * The library, seeding it first when it is absent (unless team-defaults.json is malformed: then it
 * stays absent, so the legacy files and their warning keep applying): one profile from the legacy
 * files, plus the default file naming it. Each seed is written without ever replacing a file
 * another process made meanwhile (a hard link of a temp file, which fails if the target exists); if
 * one can't be written at all (a read-only agent dir), the seed is still returned, so behaviour
 * matches the legacy files either way. A library found with no default file is NOT re-seeded:
 * the default reads as Off until the user saves one.
 */
export function loadSubagentProfiles(agentDir: string): ProfilesState {
	const state = readSubagentProfiles(agentDir);
	if (state.state !== "absent") return state;
	// A malformed team-defaults.json is reported at every team_create today; seeding it as "no teams"
	// would hide that. Leave the file absent (resolution uses the legacy files) until it is fixed.
	if (readTeamDefaults(agentDir).state === "malformed") return state;
	const value = seededFile(agentDir);
	seedNew(state.file, `${JSON.stringify(value, null, 2)}\n`);
	seedNew(subagentProfileDefaultPath(agentDir), `${JSON.stringify(seededDefault(), null, 2)}\n`);
	return { state: "ok", file: state.file, value, seeded: true };
}

/** Write `text` at `file` only if `file` still doesn't exist (a hard link, which fails if it does). */
function seedNew(file: string, text: string): void {
	const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.seed`;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o644 });
		fs.linkSync(tmp, file);
	} catch {
		/* EEXIST (another process made it first) or an unwritable dir: the in-memory seed stands. */
	} finally {
		try { fs.rmSync(tmp, { force: true }); } catch { /* Best effort. */ }
	}
}

/**
 * Validate, then write atomically (temp file + rename). Refuses a value that does not parse;
 * returns the normalized value it wrote.
 */
export function writeSubagentProfiles(agentDir: string, value: unknown): SubagentProfilesFile {
	const parsed = parseSubagentProfiles(clone(value));
	if (!parsed.ok) throw new Error(`Refusing to write ${SUBAGENT_PROFILES_FILE_NAME}: ${parsed.errors.join("; ")}`);
	return writeJsonAtomic(subagentProfilesPath(agentDir), parsed.value, agentDir);
}

/** Validate, then write the device default atomically. Refuses a value that does not parse. */
export function writeProfilesDefault(agentDir: string, value: unknown): SubagentProfilesDefault {
	const parsed = parseProfilesDefault(clone(value));
	if (!parsed.ok) throw new Error(`Refusing to write ${SUBAGENT_PROFILE_DEFAULT_FILE_NAME}: ${parsed.errors.join("; ")}`);
	return writeJsonAtomic(subagentProfileDefaultPath(agentDir), parsed.value, agentDir);
}

// ── The reviewer's default (adversarial review) ──────────────────────────────

/** The reviewer the seeding writes: Sol on pi, with Claude Code's Opus as its fallback. */
export const DEFAULT_REVIEWER: ReviewerRoute = {
	primary: { backend: "pi", model: "openai-codex/gpt-6.1-sol", effort: "high" },
	fallback: { backend: "claude-code", model: latestClaude("opus").id, effort: "high" },
};

/**
 * Give every library profile WITHOUT a `reviewer` key the default reviewer, once adversarial review
 * is switched on (Sova's Settings → Alignment). An explicit null (None) or an existing route is
 * never touched, so a second run writes nothing. Through this module's own atomic writer, so the
 * mesh's watcher syncs the library like any save. A malformed library is left alone (`ok: false`):
 * the caller retries at a later save. Returns the ids it gave the default.
 */
export function seedReviewer(agentDir: string, reviewer: ReviewerRoute = DEFAULT_REVIEWER): { ok: boolean; seeded: string[] } {
	const state = loadSubagentProfiles(agentDir);
	if (state.state !== "ok") return { ok: false, seeded: [] };
	const seeded = state.value.profiles.filter((p) => !("reviewer" in p)).map((p) => p.id);
	if (seeded.length === 0) return { ok: true, seeded };
	const value: SubagentProfilesFile = { version: 1, profiles: state.value.profiles.map((p) => ("reviewer" in p ? p : { ...p, reviewer: clone(reviewer) })) };
	writeSubagentProfiles(agentDir, value);
	return { ok: true, seeded };
}

// ── A chat's pick ────────────────────────────────────────────────────────────

/** The pick a stored entry carries, or undefined for anything this version does not understand. */
export function normalizePick(value: unknown): string | undefined {
	if (!isRecord(value) || value.v !== 1) return undefined;
	return value.profile === OFF_PROFILE_ID || isProfileId(value.profile) ? (value.profile as string) : undefined;
}

/** The newest usable pick on a session branch, or undefined (the chat follows the default). Never throws. */
export function restorePick(entries: readonly { type: string; customType?: string; data?: unknown }[] | undefined): string | undefined {
	if (!Array.isArray(entries)) return undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || entry.type !== "custom" || entry.customType !== PICK_ENTRY_TYPE) continue;
		const pick = normalizePick(entry.data);
		if (pick) return pick;
	}
	return undefined;
}

/** The entry that pins a pick, or null when the branch's newest pick already is it. */
export function pickEntryFor(entries: readonly { type: string; customType?: string; data?: unknown }[], profile: string): { customType: string; data: PickEntryData } | null {
	if (restorePick(entries) === profile) return null;
	return { customType: PICK_ENTRY_TYPE, data: { v: 1, profile } };
}

// ── Resolution ───────────────────────────────────────────────────────────────

/** What a chat's subagents get now, from wherever it was resolved. */
export interface ResolvedSubagents {
	/** pick: the chat's own; default: the file's default; legacy: the legacy files. */
	source: "pick" | "default" | "legacy";
	/** The profile's id ("off" for Off), or null for the legacy files. */
	id: string | null;
	/** The profile's name, "Off", or "Legacy settings". */
	name: string;
	/** Delegate's routing; null under Off (the agent picks every worker). */
	delegate: DelegateSettings | null;
	spec: SpecSettings;
	/** The alignment reviewer; null: none (None, a profile without one, Off, or the legacy files). */
	reviewer: ReviewerRoute | null;
	/** The profile's align override (writing style, Visuals); null: the host's mode-align.json (no override, Off, legacy). */
	alignment: AlignOverride | null;
	/** Team defaults in the shape team_create reads; `absent` = no standing members. */
	teams: TeamDefaultsState;
	members: WorkerChoice | null;
	/** Why resolution fell past a step (a dangling pick, an unusable file), for status text. */
	note?: string;
}

/** The file's view of a profile's team section, as the subagents extension reads team-defaults.json. */
export function teamsState(file: string, label: string, teams: TeamsSetting | null): TeamDefaultsState {
	const where = `${file} (subagent profile "${label}")`;
	if (!teams) return { state: "absent", file: where, note: `the subagent profile "${label}" configures none` };
	const value: TeamDefaultsFile = { version: 1, coordinator: clone(teams.coordinator), monitor: clone(teams.monitor), handover: clone(teams.handover) };
	return { state: "ok", file: where, value };
}

function fromProfile(file: string, profile: SubagentProfile, source: "pick" | "default", note?: string): ResolvedSubagents {
	return {
		source,
		id: profile.id,
		name: profile.name,
		delegate: { version: 1, profiles: clone(profile.delegate) },
		spec: { version: 1, writer: profile.specWriter ? clone(profile.specWriter) : null },
		reviewer: profile.reviewer ? clone(profile.reviewer) : null,
		alignment: profile.alignment ? { ...profile.alignment } : null,
		teams: teamsState(file, profile.name, profile.teams),
		members: profile.members ? clone(profile.members) : null,
		...(note ? { note } : {}),
	};
}

function off(file: string, source: "pick" | "default", note?: string): ResolvedSubagents {
	return {
		source,
		id: OFF_PROFILE_ID,
		name: OFF_PROFILE_NAME,
		delegate: null,
		spec: specDefaults(),
		reviewer: null,
		alignment: null,
		teams: { state: "absent", file: `${file} (subagent profile "${OFF_PROFILE_NAME}")`, note: `the subagent profile "${OFF_PROFILE_NAME}" configures nothing` },
		members: null,
		...(note ? { note } : {}),
	};
}

/** The legacy files as resolution's last step. */
export function legacyResolved(agentDir: string, note?: string): ResolvedSubagents {
	return {
		source: "legacy",
		id: null,
		name: "Legacy settings",
		delegate: loadDelegate(path.join(agentDir, DELEGATE_FILE_NAME)),
		spec: loadSpec(path.join(agentDir, SPEC_FILE_NAME)),
		reviewer: null,
		alignment: null,
		teams: readTeamDefaults(agentDir),
		members: null,
		...(note ? { note } : {}),
	};
}

/**
 * The one resolution: the chat's pick, then this device's default, then the legacy files. `state` is
 * the library as already loaded (loadSubagentProfiles, which seeds an absent one) and `def` the
 * default file as already read; `agentDir` is where the legacy files are. One step at a time,
 * never a leap: a dangling pick falls to the default, a missing, malformed or dangling default
 * reads as Off (with the reason in `note`), and only an unusable library falls to the legacy files.
 */
export function resolveSubagents(
	agentDir: string,
	pick: string | undefined,
	state: ProfilesState = loadSubagentProfiles(agentDir),
	def: DefaultState = readProfilesDefault(agentDir),
): ResolvedSubagents {
	if (state.state !== "ok") {
		const why = state.state === "malformed" ? `${state.file} is malformed (${state.errors.join("; ")})` : `${state.file} is missing`;
		return legacyResolved(agentDir, `${why}; using the legacy settings files`);
	}
	const { file } = state;
	let note: string | undefined;
	if (pick === OFF_PROFILE_ID) return off(file, "pick");
	if (pick !== undefined) {
		const picked = state.value.profiles.find((p) => p.id === pick);
		if (picked) return fromProfile(file, picked, "pick");
		note = `this chat's subagent profile "${pick}" no longer exists; using the default`;
	}
	const d = profilesDefaultOf(state, def);
	if (d.note) note = note ? `${note} (${d.note})` : d.note;
	if (d.id === OFF_PROFILE_ID) return off(file, "default", note);
	const fallback = state.value.profiles.find((p) => p.id === d.id);
	return fallback ? fromProfile(file, fallback, "default", note) : legacyResolved(agentDir, note);
}

/**
 * The default as resolution uses it: the file's choice when it names a library profile (or Off);
 * absent, malformed or dangling reads as Off with the reason. A seeded-but-unwritable pair still
 * means its seed, so a read-only agent dir behaves as if the seed had landed.
 */
export function profilesDefaultOf(state: ProfilesState, def: DefaultState): { id: string; note?: string } {
	if (def.state === "ok") {
		const id = def.value.default;
		if (id === OFF_PROFILE_ID) return { id };
		if (state.state === "ok" && state.value.profiles.some((p) => p.id === id)) return { id };
		return { id: OFF_PROFILE_ID, note: `the default "${id}" names no profile in the library; using Off` };
	}
	if (def.state === "malformed")
		return { id: OFF_PROFILE_ID, note: `the default file ${def.file} is malformed (${def.errors.join("; ")}); using Off` };
	if (state.state === "ok" && state.seeded) return { id: SEEDED_PROFILE_ID };
	return { id: OFF_PROFILE_ID };
}

/**
 * A reader for a turn boundary: the files re-parsed only when their stats change (one stat each per
 * call), the library seeded on the first call that finds it absent.
 */
export function profilesReader(agentDir: string): () => { profiles: ProfilesState; default: DefaultState } {
	const libFile = subagentProfilesPath(agentDir);
	const defFile = subagentProfileDefaultPath(agentDir);
	const stat = (f: string): string | null => {
		try {
			const s = fs.statSync(f);
			return `${s.mtimeMs}:${s.size}:${s.ino}`;
		} catch {
			return null;
		}
	};
	let cache: { libStamp: string | null; defStamp: string | null; value: { profiles: ProfilesState; default: DefaultState } } | undefined;
	return () => {
		const libStamp = stat(libFile);
		if (libStamp === null) {
			cache = undefined;
			return { profiles: loadSubagentProfiles(agentDir), default: readProfilesDefault(agentDir) };
		}
		const defStamp = stat(defFile);
		if (!cache || cache.libStamp !== libStamp || cache.defStamp !== defStamp)
			cache = { libStamp, defStamp, value: { profiles: readSubagentProfiles(agentDir), default: readProfilesDefault(agentDir) } };
		return cache.value;
	};
}

// ── Footprints ───────────────────────────────────────────────────────────────

/** A model's shortest readable form: a Claude model's catalog name (`opus[1m]` → Opus 5.5), else the id: `zai/glm-5.3` → glm-5.3. */
export function shortModel(model: string): string {
	const name = claudeName(model);
	if (name) return name;
	return model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
}

/** Every slot a profile declares, for save validation — including a disabled coordinator's or monitor's tuples. */
export function profileSlots(profile: SubagentProfile): { label: string; choice: WorkerChoice }[] {
	const out: { label: string; choice: WorkerChoice }[] = [];
	const push = (label: string, choice: WorkerChoice | null | undefined) => {
		if (choice) out.push({ label, choice });
	};
	for (const id of DELEGATE_PROFILES) {
		push(`${DELEGATE_PROFILE_INFO[id].label} primary`, profile.delegate[id].primary);
		push(`${DELEGATE_PROFILE_INFO[id].label} fallback`, profile.delegate[id].fallback);
	}
	push("Members default", profile.members);
	if (profile.teams) {
		push("Coordinator primary", workerOf(profile.teams.coordinator.primary));
		push("Coordinator fallback", profile.teams.coordinator.fallback ? workerOf(profile.teams.coordinator.fallback) : null);
		push("Monitor primary", workerOf(profile.teams.monitor.primary));
		push("Monitor fallback", profile.teams.monitor.fallback ? workerOf(profile.teams.monitor.fallback) : null);
	}
	push("Spec writer primary", profile.specWriter?.primary ?? null);
	push("Spec writer fallback", profile.specWriter?.fallback ?? null);
	push(`${REVIEWER_LABEL} primary`, profile.reviewer?.primary ?? null);
	push(`${REVIEWER_LABEL} fallback`, profile.reviewer?.fallback ?? null);
	return out;
}

/** Every worker a profile names, primaries first in a stable order, then fallbacks. */
export function profileWorkers(profile: SubagentProfile, fallbacks = true): WorkerChoice[] {
	const primaries: WorkerChoice[] = DELEGATE_PROFILES.map((id) => profile.delegate[id].primary);
	if (profile.members) primaries.push(profile.members);
	if (profile.teams?.coordinator.enabled) primaries.push(workerOf(profile.teams.coordinator.primary));
	if (profile.teams?.coordinator.enabled && profile.teams.monitor.enabled) primaries.push(workerOf(profile.teams.monitor.primary));
	if (profile.specWriter) primaries.push(profile.specWriter.primary);
	if (profile.reviewer) primaries.push(profile.reviewer.primary);
	if (!fallbacks) return primaries;
	const rest: WorkerChoice[] = [];
	for (const id of DELEGATE_PROFILES) if (profile.delegate[id].fallback) rest.push(profile.delegate[id].fallback!);
	if (profile.teams?.coordinator.enabled && profile.teams.coordinator.fallback) rest.push(workerOf(profile.teams.coordinator.fallback));
	if (profile.teams?.coordinator.enabled && profile.teams.monitor.enabled && profile.teams.monitor.fallback) rest.push(workerOf(profile.teams.monitor.fallback));
	if (profile.specWriter?.fallback) rest.push(profile.specWriter.fallback);
	if (profile.reviewer?.fallback) rest.push(profile.reviewer.fallback);
	return [...primaries, ...rest];
}
const workerOf = (t: { backend: WorkerChoice["backend"]; model: string; effort?: string }): WorkerChoice => ({ backend: t.backend, model: t.model, effort: t.effort ?? "" });

/** The short footprint a list shows: distinct primary models, first-seen order, at most `max`, then "+N". */
export function footprint(profile: SubagentProfile, max = 3): string {
	const names: string[] = [];
	for (const w of profileWorkers(profile, false)) {
		const short = shortModel(w.model);
		if (!names.includes(short)) names.push(short);
	}
	return names.length > max ? `${names.slice(0, max).join(" · ")} · +${names.length - max}` : names.join(" · ");
}
export const OFF_FOOTPRINT = "the agent picks";

/**
 * The provider a worker spends: Claude Code (and pi's claude-code-cli provider) is `claude`, a pi
 * model its provider. What a usage limit is checked against.
 */
export function workerProvider(w: Pick<WorkerChoice, "backend" | "model">): string {
	if (w.backend === "claude-code") return "claude";
	const provider = w.model.slice(0, Math.max(0, w.model.indexOf("/"))).toLowerCase();
	return provider === "claude-code-cli" ? "claude" : provider;
}

/** Every provider a profile's workers spend, fallbacks included. */
export const profileProviders = (profile: SubagentProfile): string[] => [...new Set(profileWorkers(profile).map(workerProvider))];
