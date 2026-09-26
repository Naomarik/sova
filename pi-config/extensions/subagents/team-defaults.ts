/**
 * Team defaults: the one reader and writer of `<agent dir>/team-defaults.json`, the global file
 * that gives every coordinated team a coordinator and a monitor (index.ts applies it at
 * team_create). Sova's Settings writes it; this extension re-reads it at every team_create,
 * team_add, roster answer and team_succeed, and never snapshots it into a session.
 *
 * Node built-ins only: Sova's server imports this file directly (like ../mode/delegate.ts), so it
 * must never import the pi runtime or another pi-config module.
 *
 * Absent file = feature off. Malformed file = feature off plus the error list, and the file is
 * never overwritten by a reader. A key the file leaves out takes DEFAULT_TEAM_DEFAULTS' value;
 * a key it states must be valid, and an unknown key is an error.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const TEAM_DEFAULTS_FILE_NAME = "team-defaults.json";
export const TEAM_DEFAULT_BACKENDS = ["pi", "claude-code"] as const;
export const TEAM_DEFAULT_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const MAX_TEAM_DEFAULT_INSTRUCTIONS = 4000;
const MAX_ROLE_CHARS = 64;
const MAX_MODEL_CHARS = 200;
const MAX_MINUTES = 1440;

export type TeamDefaultBackend = (typeof TEAM_DEFAULT_BACKENDS)[number];
export type TeamDefaultEffort = (typeof TEAM_DEFAULT_EFFORTS)[number];
/** One worker the defaults may start: a member-tool backend, its model id, an optional effort. */
export interface WorkerTuple {
	backend: TeamDefaultBackend;
	model: string;
	effort?: TeamDefaultEffort;
}
export interface CoordinatorDefaults {
	enabled: boolean;
	role: string;
	primary: WorkerTuple;
	fallback: WorkerTuple | null;
	instructions: string;
}
export interface MonitorUsageDefaults {
	enabled: boolean;
	pausePct: number;
	resumeMarginMinutes: number;
}
export interface MonitorDefaults {
	enabled: boolean;
	role: string;
	primary: WorkerTuple;
	fallback: WorkerTuple | null;
	contextPct: number;
	everyMinutes: number;
	usage: MonitorUsageDefaults;
	instructions: string;
}
export interface HandoverDefaults {
	retireTimeoutMinutes: number;
}
export interface TeamDefaultsFile {
	version: 1;
	coordinator: CoordinatorDefaults;
	monitor: MonitorDefaults;
	handover: HandoverDefaults;
}

export const DEFAULT_TEAM_DEFAULTS: TeamDefaultsFile = {
	version: 1,
	coordinator: { enabled: true, role: "coordinator", primary: { backend: "claude-code", model: "opus[1m]", effort: "medium" }, fallback: null, instructions: "" },
	monitor: {
		enabled: true, role: "monitor", primary: { backend: "claude-code", model: "haiku", effort: "medium" }, fallback: null,
		contextPct: 60, everyMinutes: 10, usage: { enabled: true, pausePct: 90, resumeMarginMinutes: 5 }, instructions: "",
	},
	handover: { retireTimeoutMinutes: 10 },
};

export type TeamDefaultsParse = { ok: true; value: TeamDefaultsFile } | { ok: false; errors: string[] };
export type TeamDefaultsState =
	| { state: "absent"; file: string }
	| { state: "malformed"; file: string; errors: string[] }
	| { state: "ok"; file: string; value: TeamDefaultsFile };

// Single-line fields: no control characters at all. Instructions keep newlines and tabs.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_EXCEPT_NEWLINE_TAB = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const WORKER_ID = /^ag_\d+$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** `PI_CODING_AGENT_DIR` (a leading `~` expanded) when set, else `~/.pi/agent` — as pi resolves it. */
export function defaultAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const raw = env.PI_CODING_AGENT_DIR?.trim();
	if (!raw) return path.join(os.homedir(), ".pi", "agent");
	if (raw === "~") return os.homedir();
	return raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
}
export const teamDefaultsPath = (agentDir: string): string => path.join(agentDir, TEAM_DEFAULTS_FILE_NAME);

class Checker {
	errors: string[] = [];
	fail(at: string, message: string): void { this.errors.push(`${at}: ${message}`); }
	/** An object's keys must all be known; returns the object, or undefined (error recorded) when it is not one. */
	object(at: string, value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
		if (!isRecord(value)) {
			this.fail(at || "team-defaults", "must be an object");
			return undefined;
		}
		for (const key of Object.keys(value)) if (!keys.includes(key)) this.fail(at ? `${at}.${key}` : key, "unknown key");
		return value;
	}
	boolean(at: string, value: unknown, fallback: boolean): boolean {
		if (value === undefined) return fallback;
		if (typeof value !== "boolean") this.fail(at, "must be true or false");
		return value === true;
	}
	number(at: string, value: unknown, fallback: number, min: number, max: number): number {
		if (value === undefined) return fallback;
		if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
			this.fail(at, `must be a number from ${min} to ${max}`);
			return fallback;
		}
		return value;
	}
	role(at: string, value: unknown, fallback: string): string {
		if (value === undefined) return fallback;
		if (typeof value !== "string" || !value.trim()) { this.fail(at, "must be a non-blank string"); return fallback; }
		const role = value.trim().replace(/\s+/g, " ");
		if (role.length > MAX_ROLE_CHARS) this.fail(at, `must be at most ${MAX_ROLE_CHARS} characters`);
		else if (CONTROL.test(role)) this.fail(at, "must be one line without control characters");
		else if (WORKER_ID.test(role)) this.fail(at, "looks like a worker ID; choose a descriptive role");
		return role;
	}
	instructions(at: string, value: unknown): string {
		if (value === undefined) return "";
		if (typeof value !== "string") { this.fail(at, "must be a string"); return ""; }
		if (value.length > MAX_TEAM_DEFAULT_INSTRUCTIONS) this.fail(at, `must be at most ${MAX_TEAM_DEFAULT_INSTRUCTIONS} characters`);
		else if (CONTROL_EXCEPT_NEWLINE_TAB.test(value)) this.fail(at, "must not contain control characters");
		return value.trim();
	}
	tuple(at: string, value: unknown, fallback: WorkerTuple): WorkerTuple {
		if (value === undefined) return clone(fallback);
		const t = this.object(at, value, ["backend", "model", "effort"]);
		if (!t) return clone(fallback);
		const backend = t.backend;
		if (typeof backend !== "string" || !(TEAM_DEFAULT_BACKENDS as readonly string[]).includes(backend))
			this.fail(`${at}.backend`, `must be one of ${TEAM_DEFAULT_BACKENDS.join(", ")} (only these load team member tools)`);
		const model = t.model;
		if (typeof model !== "string" || !model.trim()) this.fail(`${at}.model`, "must be a non-blank string");
		else if (model.length > MAX_MODEL_CHARS || CONTROL.test(model)) this.fail(`${at}.model`, `must be one line of at most ${MAX_MODEL_CHARS} characters`);
		else if (backend === "pi" && !/^[^/\s]+\/\S+$/.test(model.trim())) this.fail(`${at}.model`, "a pi model must be provider/id");
		const effort = t.effort;
		if (effort !== undefined && effort !== null && (typeof effort !== "string" || !(TEAM_DEFAULT_EFFORTS as readonly string[]).includes(effort)))
			this.fail(`${at}.effort`, `must be one of ${TEAM_DEFAULT_EFFORTS.join(", ")}`);
		const out: WorkerTuple = { backend: backend as TeamDefaultBackend, model: typeof model === "string" ? model.trim() : "" };
		if (typeof effort === "string") out.effort = effort as TeamDefaultEffort;
		return out;
	}
	fallbackTuple(at: string, value: unknown): WorkerTuple | null {
		if (value === undefined || value === null) return null;
		return this.tuple(at, value, DEFAULT_TEAM_DEFAULTS.coordinator.primary);
	}
}

/**
 * Strict validation plus default filling. `input` is the parsed JSON value, or the raw file text.
 * Every error is collected; on any error no value is returned, so a caller can never run a
 * half-valid configuration.
 */
export function parseTeamDefaults(input: unknown): TeamDefaultsParse {
	let json = input;
	if (typeof input === "string") {
		try {
			json = JSON.parse(input);
		} catch (error) {
			return { ok: false, errors: [`not valid JSON: ${(error as Error).message}`] };
		}
	}
	const c = new Checker();
	const d = DEFAULT_TEAM_DEFAULTS;
	const root = c.object("", json, ["version", "coordinator", "monitor", "handover"]);
	if (!root) return { ok: false, errors: c.errors };
	if (root.version !== 1) c.fail("version", "must be 1");
	const co = root.coordinator === undefined ? {} : c.object("coordinator", root.coordinator, ["enabled", "role", "primary", "fallback", "instructions"]) ?? {};
	const mo = root.monitor === undefined ? {} : c.object("monitor", root.monitor, ["enabled", "role", "primary", "fallback", "contextPct", "everyMinutes", "usage", "instructions"]) ?? {};
	const us = mo.usage === undefined ? {} : c.object("monitor.usage", mo.usage, ["enabled", "pausePct", "resumeMarginMinutes"]) ?? {};
	const ho = root.handover === undefined ? {} : c.object("handover", root.handover, ["retireTimeoutMinutes"]) ?? {};
	const value: TeamDefaultsFile = {
		version: 1,
		coordinator: {
			enabled: c.boolean("coordinator.enabled", co.enabled, d.coordinator.enabled),
			role: c.role("coordinator.role", co.role, d.coordinator.role),
			primary: c.tuple("coordinator.primary", co.primary, d.coordinator.primary),
			fallback: c.fallbackTuple("coordinator.fallback", co.fallback),
			instructions: c.instructions("coordinator.instructions", co.instructions),
		},
		monitor: {
			enabled: c.boolean("monitor.enabled", mo.enabled, d.monitor.enabled),
			role: c.role("monitor.role", mo.role, d.monitor.role),
			primary: c.tuple("monitor.primary", mo.primary, d.monitor.primary),
			fallback: c.fallbackTuple("monitor.fallback", mo.fallback),
			contextPct: c.number("monitor.contextPct", mo.contextPct, d.monitor.contextPct, 1, 100),
			everyMinutes: c.number("monitor.everyMinutes", mo.everyMinutes, d.monitor.everyMinutes, 1, MAX_MINUTES),
			usage: {
				enabled: c.boolean("monitor.usage.enabled", us.enabled, d.monitor.usage.enabled),
				pausePct: c.number("monitor.usage.pausePct", us.pausePct, d.monitor.usage.pausePct, 1, 100),
				resumeMarginMinutes: c.number("monitor.usage.resumeMarginMinutes", us.resumeMarginMinutes, d.monitor.usage.resumeMarginMinutes, 0, MAX_MINUTES),
			},
			instructions: c.instructions("monitor.instructions", mo.instructions),
		},
		handover: { retireTimeoutMinutes: c.number("handover.retireTimeoutMinutes", ho.retireTimeoutMinutes, d.handover.retireTimeoutMinutes, 1, MAX_MINUTES) },
	};
	if (value.coordinator.role.toLowerCase() === value.monitor.role.toLowerCase())
		c.fail("monitor.role", `must differ from coordinator.role (${value.coordinator.role})`);
	return c.errors.length ? { ok: false, errors: c.errors } : { ok: true, value };
}

/** The file as it stands now: absent, malformed (with every error) or ok. Never writes. */
export function readTeamDefaults(agentDir: string): TeamDefaultsState {
	const file = teamDefaultsPath(agentDir);
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent", file };
		return { state: "malformed", file, errors: [`cannot read: ${(error as Error).message}`] };
	}
	const parsed = parseTeamDefaults(raw);
	return parsed.ok ? { state: "ok", file, value: parsed.value } : { state: "malformed", file, errors: parsed.errors };
}

/**
 * Validate, then write atomically (a sibling temp file renamed over the target), so a reader sees
 * the old file or the new one, never a partial one. Refuses a value that does not parse; returns
 * the normalized value it wrote.
 */
export function writeTeamDefaults(agentDir: string, value: unknown): TeamDefaultsFile {
	const parsed = parseTeamDefaults(clone(value));
	if (!parsed.ok) throw new Error(`Refusing to write ${TEAM_DEFAULTS_FILE_NAME}: ${parsed.errors.join("; ")}`);
	const file = teamDefaultsPath(agentDir);
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

const tupleText = (t: WorkerTuple | null): string => (t ? `${t.backend} · ${t.model}${t.effort ? ` · ${t.effort}` : ""}` : "none");

/** What `/team defaults` prints: the effective defaults, or why they are off. */
export function describeTeamDefaults(state: TeamDefaultsState): string {
	if (state.state === "absent") return `Team defaults: off (no file at ${state.file}). Teams get no coordinator or monitor.`;
	if (state.state === "malformed")
		return [`Team defaults: off — ${state.file} is malformed (it is never overwritten here):`, ...state.errors.map((e) => `  - ${e}`)].join("\n");
	const { coordinator: c, monitor: m, handover: h } = state.value;
	return [
		`Team defaults (${state.file}):`,
		`  Coordinator: ${c.enabled ? `on — role "${c.role}", primary ${tupleText(c.primary)}, fallback ${tupleText(c.fallback)}` : "off"}${c.enabled && c.instructions ? " · extra instructions set" : ""}`,
		`  Monitor: ${m.enabled ? `on — role "${m.role}", primary ${tupleText(m.primary)}, fallback ${tupleText(m.fallback)}` : "off"}${m.enabled && m.instructions ? " · extra instructions set" : ""}`,
		...(m.enabled
			? [`    every ${m.everyMinutes} min · wrap-up at ${m.contextPct}% context · usage ${m.usage.enabled ? `pause at ${m.usage.pausePct}%, resume ${m.usage.resumeMarginMinutes} min after reset` : "not watched"}`]
			: []),
		`  Handover: a replaced member is retired when its successor confirms, or after ${h.retireTimeoutMinutes} min.`,
		"  Per team: team_create defaults.coordinator: false / defaults.monitor: false turn them off.",
	].join("\n");
}
