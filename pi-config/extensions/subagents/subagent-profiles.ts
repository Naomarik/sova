/**
 * Subagent profiles: the one reader and writer of `<agent dir>/subagent-profiles.json`, named
 * bundles of every model a session's subagents are given — Delegate's four work kinds, the team
 * coordinator, monitor and members default, and the spec writer. A chat picks one (its hidden
 * `subagent-profile` entry, newest on the branch wins); a chat with no pick follows the file's
 * `default`; a missing pick target falls to the default, and an unusable file to the legacy files
 * (`mode-delegate.json`, `team-defaults.json`, `mode-spec.json`), which nothing here deletes.
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
	DELEGATE_PROFILES,
	loadDelegate,
	parseChoice,
	parseDelegate,
	type DelegateProfile,
	type DelegateProfileId,
	type DelegateSettings,
	type WorkerChoice,
} from "../mode/delegate.ts";
import { loadSpec, parseSpec, SPEC_FILE_NAME, specDefaults, type SpecSettings, type SpecWriter } from "../mode/spec.ts";
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
/** The built-in profile that configures nothing: never stored, always first. */
export const OFF_PROFILE_ID = "off";
export const OFF_PROFILE_NAME = "Off";
/** The profile seeding writes; a fixed id, so two devices seeding apart agree on it. */
export const SEEDED_PROFILE_ID = "my-setup";
export const SEEDED_PROFILE_NAME = "My setup";
/** The session's hidden custom entry carrying its pick: `{v: 1, profile}`. */
export const PICK_ENTRY_TYPE = "subagent-profile";
export const MAX_PROFILES = 50;
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
}
export interface SubagentProfilesFile {
	version: 1;
	/** A profile's id, or "off". */
	default: string;
	profiles: SubagentProfile[];
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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const subagentProfilesPath = (agentDir: string): string => path.join(agentDir, SUBAGENT_PROFILES_FILE_NAME);

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
	const known = ["id", "name", "delegate", "teams", "members", "specWriter"];
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
	if (errors.length > before || "error" in delegate) return undefined;
	return { id: raw.id as string, name: raw.name as string, delegate: delegate.profiles, teams, members, specWriter };
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
	if (!isRecord(json)) return { ok: false, errors: ["must be an object { version: 1, default, profiles }"] };
	for (const key of Object.keys(json)) if (!["version", "default", "profiles"].includes(key)) errors.push(`${key}: unknown key`);
	if (json.version !== 1) errors.push("version: must be 1");
	if (!Array.isArray(json.profiles)) {
		errors.push("profiles: must be an array");
		return { ok: false, errors };
	}
	if (json.profiles.length > MAX_PROFILES) errors.push(`profiles: at most ${MAX_PROFILES}`);
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
	if (typeof json.default !== "string" || (json.default !== OFF_PROFILE_ID && !ids.has(json.default)))
		errors.push(`default: must be "${OFF_PROFILE_ID}" or the id of a profile in the file`);
	return errors.length ? { ok: false, errors } : { ok: true, value: { version: 1, default: json.default as string, profiles } };
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

/** A file holding exactly one profile seeded from the legacy files, and made the default. */
export function seededFile(agentDir: string): SubagentProfilesFile {
	return { version: 1, default: SEEDED_PROFILE_ID, profiles: [legacyProfile(agentDir)] };
}

/**
 * The file, seeding it first when it is absent. The seed is written without ever replacing a
 * file another process made meanwhile (a hard link of a temp file, which fails if the target
 * exists); if it can't be written at all (a read-only agent dir), the seed is still returned, so
 * behaviour matches the legacy files either way.
 */
export function loadSubagentProfiles(agentDir: string): ProfilesState {
	const state = readSubagentProfiles(agentDir);
	if (state.state !== "absent") return state;
	const value = seededFile(agentDir);
	const file = state.file;
	const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.seed`;
	try {
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
		fs.linkSync(tmp, file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			try { fs.rmSync(tmp, { force: true }); } catch { /* Best effort. */ }
			return readSubagentProfiles(agentDir);
		}
	} finally {
		try { fs.rmSync(tmp, { force: true }); } catch { /* Best effort. */ }
	}
	return { state: "ok", file, value, seeded: true };
}

/**
 * Validate, then write atomically (temp file + rename). Refuses a value that does not parse;
 * returns the normalized value it wrote.
 */
export function writeSubagentProfiles(agentDir: string, value: unknown): SubagentProfilesFile {
	const parsed = parseSubagentProfiles(clone(value));
	if (!parsed.ok) throw new Error(`Refusing to write ${SUBAGENT_PROFILES_FILE_NAME}: ${parsed.errors.join("; ")}`);
	const file = subagentProfilesPath(agentDir);
	fs.mkdirSync(agentDir, { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(parsed.value, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
		fs.renameSync(tmp, file);
	} catch (error) {
		try { fs.rmSync(tmp, { force: true }); } catch { /* Best effort. */ }
		throw error;
	}
	return parsed.value;
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
	/** Team defaults in the shape team_create reads; `absent` = no standing members. */
	teams: TeamDefaultsState;
	members: WorkerChoice | null;
	/** Why resolution fell past a step (a dangling pick, an unusable file), for status text. */
	note?: string;
}

/** The file's view of a profile's team section, as the subagents extension reads team-defaults.json. */
export function teamsState(file: string, label: string, teams: TeamsSetting | null): TeamDefaultsState {
	const where = `${file} (subagent profile "${label}")`;
	if (!teams) return { state: "absent", file: where };
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
		teams: { state: "absent", file: `${file} (subagent profile "${OFF_PROFILE_NAME}")` },
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
		teams: readTeamDefaults(agentDir),
		members: null,
		...(note ? { note } : {}),
	};
}

/**
 * The one resolution: the chat's pick, then the file's default, then the legacy files. `state` is
 * the file as already loaded (loadSubagentProfiles, which seeds an absent file); `agentDir` is
 * where the legacy files are.
 */
export function resolveSubagents(agentDir: string, pick: string | undefined, state: ProfilesState = loadSubagentProfiles(agentDir)): ResolvedSubagents {
	if (state.state !== "ok") {
		const why = state.state === "malformed" ? `${state.file} is malformed (${state.errors.join("; ")})` : `${state.file} is missing`;
		return legacyResolved(agentDir, `${why}; using the legacy settings files`);
	}
	const { value, file } = state;
	let note: string | undefined;
	if (pick === OFF_PROFILE_ID) return off(file, "pick");
	if (pick !== undefined) {
		const picked = value.profiles.find((p) => p.id === pick);
		if (picked) return fromProfile(file, picked, "pick");
		note = `this chat's subagent profile "${pick}" no longer exists; using the default`;
	}
	if (value.default === OFF_PROFILE_ID) return off(file, "default", note);
	const fallback = value.profiles.find((p) => p.id === value.default);
	return fallback ? fromProfile(file, fallback, "default", note) : legacyResolved(agentDir, note);
}

/**
 * A reader for a turn boundary: the file re-parsed only when its stat changes (one stat per call),
 * seeded on the first call that finds it absent.
 */
export function profilesReader(agentDir: string): () => ProfilesState {
	const file = subagentProfilesPath(agentDir);
	let cache: { stamp: string; value: ProfilesState } | undefined;
	return () => {
		let stamp: string;
		try {
			const stat = fs.statSync(file);
			stamp = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
		} catch {
			cache = undefined;
			return loadSubagentProfiles(agentDir);
		}
		if (cache?.stamp !== stamp) cache = { stamp, value: readSubagentProfiles(agentDir) };
		return cache.value;
	};
}

// ── Footprints ───────────────────────────────────────────────────────────────

/** A model's shortest readable form: `opus[1m]` → opus, `claude-fable-5-1[1m]` → fable, `zai/glm-5.3` → glm-5.3. */
export function shortModel(model: string): string {
	let m = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
	m = m.replace(/\[1m\]$/i, "");
	const claude = /^claude-(opus|sonnet|haiku|fable)\b/i.exec(m);
	if (claude) return claude[1]!.toLowerCase();
	return m;
}

/** Every worker a profile names, primaries first in a stable order, then fallbacks. */
export function profileWorkers(profile: SubagentProfile, fallbacks = true): WorkerChoice[] {
	const primaries: WorkerChoice[] = DELEGATE_PROFILES.map((id) => profile.delegate[id].primary);
	if (profile.members) primaries.push(profile.members);
	if (profile.teams?.coordinator.enabled) primaries.push(workerOf(profile.teams.coordinator.primary));
	if (profile.teams?.coordinator.enabled && profile.teams.monitor.enabled) primaries.push(workerOf(profile.teams.monitor.primary));
	if (profile.specWriter) primaries.push(profile.specWriter.primary);
	if (!fallbacks) return primaries;
	const rest: WorkerChoice[] = [];
	for (const id of DELEGATE_PROFILES) if (profile.delegate[id].fallback) rest.push(profile.delegate[id].fallback!);
	if (profile.teams?.coordinator.enabled && profile.teams.coordinator.fallback) rest.push(workerOf(profile.teams.coordinator.fallback));
	if (profile.teams?.coordinator.enabled && profile.teams.monitor.enabled && profile.teams.monitor.fallback) rest.push(workerOf(profile.teams.monitor.fallback));
	if (profile.specWriter?.fallback) rest.push(profile.specWriter.fallback);
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
