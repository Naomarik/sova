/**
 * Claude logins: the one reader and writer of `<agent dir>/claude-accounts.json` (the registry),
 * `<agent dir>/claude-accounts-state.json` (this host's standing of each login) and each login's
 * directory `<agent dir>/claude-accounts/<id>/`, plus the one resolver from a login to the
 * environment a `claude` process runs with.
 *
 * A LOGIN is one Claude Code config directory with its own `.credentials.json` (one refresh
 * chain). Several logins may share one Claude account (`accountUuid`). Claude Code's own
 * directory (`~/.claude`, or `$CLAUDE_CONFIG_DIR`) is the implicit login `default`: never stored,
 * never moved, never written here. Claude Code stays the only program that signs in, refreshes
 * and signs out; nothing here reads a token.
 *
 * Node built-ins only: Sova's server imports this file directly (server/claude-accounts.ts), so
 * it must never import the pi runtime or another pi-config module.
 *
 * Absent registry = only `default`. Malformed registry = only `default`, plus the error, and the
 * file is never overwritten by a reader.
 *
 * The pool (phase 2, while the mesh is on): a login's registry `device` is the device that HOLDS
 * it (`null` = kept here, free, for lending by this host as the keeper; never run here). Sova's
 * pool agent (server/claude-pool/) moves logins between devices; this file gives it what every
 * `claude` spawn must honour: `.sova-leaving` (a login on its way out is never chosen), the
 * per-process leases under `.sova-leases/` (which processes still run on a login), and the
 * borrow requests (`claude-pool/wants/`) a spawn with no usable login writes and waits on.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const ACCOUNTS_FILE_NAME = "claude-accounts.json";
export const ACCOUNTS_STATE_FILE_NAME = "claude-accounts-state.json";
export const ACCOUNTS_DEV_FILE_NAME = "claude-accounts-dev.json";
export const ACCOUNTS_DIR_NAME = "claude-accounts";
/** Claude Code's own directory, as a login. */
export const DEFAULT_LOGIN_ID = "default";
/** The device id of a host without a mesh id. */
export const LOCAL_DEVICE_ID = "local";
/** Enables the development switch (claude-accounts-dev.json). */
export const ACCOUNTS_DEV_ENV = "SOVA_CLAUDE_ACCOUNTS_DEV";
/** A limit with no reset time keeps its logins out this long. */
export const DEFAULT_LIMIT_COOLDOWN_MS = 15 * 60_000;
/** A login on its way to another device: `<login dir>/.sova-leaving` `{v: 1, at, reason}`. */
export const LEAVING_FILE_NAME = ".sova-leaving";
/** Per-process leases: `<login dir>/.sova-leases/<owner pid>.json`. */
export const LEASES_DIR_NAME = ".sova-leases";
/** `<agent dir>/claude-pool/`: the pool agent's heartbeat (`agent.json`) and borrow requests (`wants/`). */
export const POOL_DIR_NAME = "claude-pool";
/** A heartbeat older than this means no pool agent runs here: nothing waits for a borrow. */
export const POOL_AGENT_FRESH_MS = 30_000;
/** How long a spawn waits for its borrow. */
export const WANT_WAIT_MS = 30_000;
/** How often a process rewrites its leases and releases idle users of leaving logins. */
export const LEASE_TICK_MS = 5_000;
/** A lease its owner has not rewritten for this long has no owner (the pid is gone or reused): only its live `claude` children count. */
export const LEASE_STALE_MS = 60_000;
/** What the development switch's forced limit says about its reset. */
const DEV_LIMIT_RESET_MS = 60 * 60_000;
/** Entries symlinked from `default`'s directory into every login's, so all share them. */
export const SHARED_ENTRIES = ["projects", "settings.json", "CLAUDE.md", "agents", "commands", "skills", "plugins"] as const;
const LOGIN_ID_RE = /^l-[0-9a-f]{8}$/;
const DEVICE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_LABEL = 80;
const MAX_TEXT = 200;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Who a login is, from Claude Code's own `.claude.json` (`oauthAccount`). Never a token. */
export interface ClaudeLoginIdentity {
	accountUuid?: string;
	email?: string;
	orgUuid?: string;
	orgName?: string;
	/** subscriptionType / billing plan, as Claude Code names it. */
	plan?: string;
	rateLimitTier?: string;
}
export interface ClaudeLoginRecord {
	id: string;
	label?: string;
	addedAt: number;
	/** false: never chosen automatically. */
	enabled: boolean;
	/** The mesh device this login is assigned to (at most one); `local` = this host before it had a mesh id. */
	device: string | null;
	identity: ClaudeLoginIdentity | null;
}
export interface ClaudeDeviceEntry {
	/** Login ids in the order this device tries them; may include `default`. */
	order: string[];
	/** false: this device never chooses `default` automatically. Absent = true. */
	defaultEnabled?: boolean;
}
export interface ClaudeAccountsFile {
	version: 1;
	logins: ClaudeLoginRecord[];
	devices: Record<string, ClaudeDeviceEntry>;
}
export type ClaudeAccountsRead =
	| { state: "absent"; file: string; value: ClaudeAccountsFile }
	| { state: "ok"; file: string; value: ClaudeAccountsFile }
	| { state: "malformed"; file: string; value: ClaudeAccountsFile; errors: string[] };

/** A turn's account failure, as the transport classifies it (transport.ts classifyClaudeFailure). */
export interface ClaudeAccountFailure {
	kind: "limit" | "auth";
	/** When the limit resets (ms epoch), when the stream said. */
	resetsAt?: number;
	/** `five_hour`, `seven_day`, … when the stream said. */
	window?: string;
	/** A short human reason, never a token. */
	message?: string;
}
export interface ClaudeLoginStanding {
	kind: "limit" | "auth";
	at: number;
	/** limit: out until then (ms epoch). */
	until?: number;
	window?: string;
	message?: string;
	/** auth: the credentials file's mtime at the failure; a newer file means it was signed in again. */
	credentialsMtime?: number;
	/** limit: recorded because another login of the same account hit it. */
	via?: string;
}
export interface ClaudeAccountsState {
	version: 1;
	logins: Record<string, ClaudeLoginStanding>;
}
/** A login as a spawn uses it. */
export interface ClaudeLoginChoice {
	id: string;
	/** What notices call it: its label, else its email, else its id. */
	label: string;
	/** Merged over the child's environment: `CLAUDE_CONFIG_DIR`, or nothing for `default`. */
	env: Record<string, string>;
	accountUuid?: string;
}
/** A failover, as a notice reports it. */
export interface ClaudeLoginSwitch {
	from: ClaudeLoginChoice;
	to: ClaudeLoginChoice;
	failure: ClaudeAccountFailure;
	/** "Claude: switched A → B (5h limit, resets 15:00)". */
	text: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** `PI_CODING_AGENT_DIR` (a leading `~` expanded) when set, else `~/.pi/agent` — as pi resolves it. */
export function defaultAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const raw = env.PI_CODING_AGENT_DIR?.trim();
	if (!raw) return path.join(os.homedir(), ".pi", "agent");
	if (raw === "~") return os.homedir();
	if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
	return raw;
}
/** Claude Code's own directory: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function defaultClaudeDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
}
/** Where Claude Code keeps `.claude.json` for a directory: inside it, except `~/.claude.json` for the unset default. */
export function claudeJsonPath(dir: string, isDefault: boolean, env: NodeJS.ProcessEnv = process.env): string {
	if (isDefault && !env.CLAUDE_CONFIG_DIR?.trim()) return path.join(os.homedir(), ".claude.json");
	return path.join(dir, ".claude.json");
}
export const accountsPath = (agentDir: string): string => path.join(agentDir, ACCOUNTS_FILE_NAME);
export const accountsStatePath = (agentDir: string): string => path.join(agentDir, ACCOUNTS_STATE_FILE_NAME);
export const accountsDevPath = (agentDir: string): string => path.join(agentDir, ACCOUNTS_DEV_FILE_NAME);
export function loginDir(agentDir: string, id: string): string {
	if (!LOGIN_ID_RE.test(id)) throw new Error(`Not a login id: ${id}`);
	return path.join(agentDir, ACCOUNTS_DIR_NAME, id);
}
export const isLoginId = (id: unknown): id is string => typeof id === "string" && LOGIN_ID_RE.test(id);
export const newLoginId = (): string => `l-${randomBytes(4).toString("hex")}`;

// ---------------------------------------------------------------------------
// Registry: parse, read, write
// ---------------------------------------------------------------------------

export const emptyAccounts = (): ClaudeAccountsFile => ({ version: 1, logins: [], devices: {} });

const str = (v: unknown, max = MAX_TEXT): string | undefined => typeof v === "string" && v.trim() && v.length <= max ? v : undefined;

function parseIdentity(v: unknown, errors: string[], at: string): ClaudeLoginIdentity | null {
	if (v === null || v === undefined) return null;
	if (typeof v !== "object" || Array.isArray(v)) { errors.push(`${at} must be an object or null`); return null; }
	const out: ClaudeLoginIdentity = {};
	for (const key of ["accountUuid", "email", "orgUuid", "orgName", "plan", "rateLimitTier"] as const) {
		const value = (v as Record<string, unknown>)[key];
		if (value === undefined) continue;
		const s = str(value);
		if (!s) { errors.push(`${at}.${key} must be a short string`); continue; }
		out[key] = s;
	}
	return out;
}

/** Strict parse. Unknown top-level or login keys are errors, so a newer writer's file is never half-read. */
export function parseAccounts(input: unknown): { value: ClaudeAccountsFile; errors: string[] } {
	const errors: string[] = [];
	const value = emptyAccounts();
	if (!input || typeof input !== "object" || Array.isArray(input)) return { value, errors: ["the file must be a JSON object"] };
	const r = input as Record<string, unknown>;
	if (r.version !== 1) errors.push("version must be 1");
	for (const key of Object.keys(r)) if (!["version", "logins", "devices"].includes(key)) errors.push(`unknown key ${key}`);
	if (r.logins !== undefined && !Array.isArray(r.logins)) errors.push("logins must be a list");
	const seen = new Set<string>();
	for (const [i, raw] of (Array.isArray(r.logins) ? r.logins : []).entries()) {
		const at = `logins[${i}]`;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) { errors.push(`${at} must be an object`); continue; }
		const l = raw as Record<string, unknown>;
		for (const key of Object.keys(l)) if (!["id", "label", "addedAt", "enabled", "device", "identity"].includes(key)) errors.push(`${at}: unknown key ${key}`);
		if (!isLoginId(l.id)) { errors.push(`${at}.id must look like l-0123abcd`); continue; }
		if (seen.has(l.id)) { errors.push(`${at}.id ${l.id} is listed twice`); continue; }
		seen.add(l.id);
		if (l.label !== undefined && !str(l.label, MAX_LABEL)) errors.push(`${at}.label must be a string of at most ${MAX_LABEL}`);
		if (typeof l.addedAt !== "number" || !Number.isFinite(l.addedAt)) errors.push(`${at}.addedAt must be a time`);
		if (typeof l.enabled !== "boolean") errors.push(`${at}.enabled must be true or false`);
		if (l.device !== null && l.device !== undefined && !(typeof l.device === "string" && DEVICE_ID_RE.test(l.device))) errors.push(`${at}.device must be a device id or null`);
		value.logins.push({
			id: l.id,
			...(str(l.label, MAX_LABEL) ? { label: l.label as string } : {}),
			addedAt: typeof l.addedAt === "number" ? l.addedAt : 0,
			enabled: l.enabled !== false,
			device: typeof l.device === "string" ? l.device : null,
			identity: parseIdentity(l.identity, errors, `${at}.identity`),
		});
	}
	if (r.devices !== undefined && (!r.devices || typeof r.devices !== "object" || Array.isArray(r.devices))) errors.push("devices must be an object");
	for (const [device, raw] of Object.entries(r.devices && typeof r.devices === "object" && !Array.isArray(r.devices) ? r.devices as Record<string, unknown> : {})) {
		const at = `devices.${device}`;
		if (!DEVICE_ID_RE.test(device)) { errors.push(`${at}: not a device id`); continue; }
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) { errors.push(`${at} must be an object`); continue; }
		const d = raw as Record<string, unknown>;
		for (const key of Object.keys(d)) if (!["order", "defaultEnabled"].includes(key)) errors.push(`${at}: unknown key ${key}`);
		if (!Array.isArray(d.order) || d.order.some((id) => id !== DEFAULT_LOGIN_ID && !isLoginId(id))) { errors.push(`${at}.order must be a list of login ids`); continue; }
		if (new Set(d.order).size !== d.order.length) { errors.push(`${at}.order lists a login twice`); continue; }
		if (d.defaultEnabled !== undefined && typeof d.defaultEnabled !== "boolean") errors.push(`${at}.defaultEnabled must be true or false`);
		value.devices[device] = { order: [...d.order as string[]], ...(typeof d.defaultEnabled === "boolean" ? { defaultEnabled: d.defaultEnabled } : {}) };
	}
	return { value, errors };
}

export function readAccounts(agentDir: string): ClaudeAccountsRead {
	const file = accountsPath(agentDir);
	let raw: string;
	try { raw = fs.readFileSync(file, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent", file, value: emptyAccounts() };
		return { state: "malformed", file, value: emptyAccounts(), errors: [(error as Error).message] };
	}
	let json: unknown;
	try { json = JSON.parse(raw); }
	catch (error) { return { state: "malformed", file, value: emptyAccounts(), errors: [`not JSON: ${(error as Error).message}`] }; }
	const parsed = parseAccounts(json);
	return parsed.errors.length
		? { state: "malformed", file, value: emptyAccounts(), errors: parsed.errors }
		: { state: "ok", file, value: parsed.value };
}

function writeJsonAtomic(file: string, value: unknown, mode: number): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
		fs.renameSync(tmp, file);
	} catch (error) {
		try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
		throw error;
	}
}

/** Validates, then writes atomically (0600). Throws on an invalid value; never writes over a malformed file. */
export function writeAccounts(agentDir: string, value: ClaudeAccountsFile): ClaudeAccountsFile {
	const parsed = parseAccounts(value);
	if (parsed.errors.length) throw new Error(`Invalid Claude accounts: ${parsed.errors.join("; ")}`);
	const current = readAccounts(agentDir);
	if (current.state === "malformed") throw new Error(`${current.file} is malformed and is never overwritten: ${current.errors.join("; ")}`);
	writeJsonAtomic(accountsPath(agentDir), parsed.value, 0o600);
	return parsed.value;
}

/** Read, change, write: throws on a malformed file, which stays as it is. */
export function updateAccounts(agentDir: string, change: (value: ClaudeAccountsFile) => void): ClaudeAccountsFile {
	const current = readAccounts(agentDir);
	if (current.state === "malformed") throw new Error(`${current.file} is malformed and is never overwritten: ${current.errors.join("; ")}`);
	const value = structuredClone(current.value);
	change(value);
	return writeAccounts(agentDir, value);
}

// ---------------------------------------------------------------------------
// Devices and order
// ---------------------------------------------------------------------------

/**
 * This host's device id: `SOVA_DEVICE_ID`, else the mesh id (`self.id` in `<agent dir>/sova/peers.json`),
 * else `local`.
 */
export function thisDeviceId(agentDir: string, env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.SOVA_DEVICE_ID?.trim();
	if (explicit && DEVICE_ID_RE.test(explicit)) return explicit;
	try {
		const peers = JSON.parse(fs.readFileSync(path.join(agentDir, "sova", "peers.json"), "utf8"));
		const id = peers?.self?.id;
		if (typeof id === "string" && DEVICE_ID_RE.test(id)) return id;
	} catch { /* no mesh */ }
	return LOCAL_DEVICE_ID;
}
/** Whether a login assigned to `assigned` belongs to this device (`local` always does). */
export const assignedHere = (assigned: string | null, device: string): boolean =>
	assigned !== null && (assigned === device || assigned === LOCAL_DEVICE_ID);
/**
 * Whether the pool is on: the mesh is on (`<agent dir>/sova/peers.json` lists a peer), the same
 * rule as the server's. Off, this host is its own keeper and holder: every login here is used.
 */
export function poolActive(agentDir: string): boolean {
	try {
		const peers = JSON.parse(fs.readFileSync(path.join(agentDir, "sova", "peers.json"), "utf8"));
		return Array.isArray(peers?.peers) && peers.peers.length > 0;
	} catch { return false; }
}
/** Whether this device may run a login whose registry `device` is `held`: held here, or (pool off) kept here. */
export const heldHere = (held: string | null, device: string, pool: boolean): boolean =>
	assignedHere(held, device) || (!pool && held === null);
/** This device's entry: under its id, else under `local` (written before it had a mesh id). */
export function deviceEntry(accounts: ClaudeAccountsFile, device: string): ClaudeDeviceEntry | undefined {
	return accounts.devices[device] ?? accounts.devices[LOCAL_DEVICE_ID];
}
/**
 * The ids this device tries, in order: its order's logins that it holds, then every other login it
 * holds, oldest first, then `default` — always last: Claude Code's own login is the last resort.
 * `pool` (the mesh is on): only logins held here count; off, logins kept here (`device: null`) too.
 */
export function deviceOrder(accounts: ClaudeAccountsFile, device: string, pool = false): string[] {
	const here = accounts.logins.filter((l) => heldHere(l.device, device, pool)).sort((a, b) => a.addedAt - b.addedAt).map((l) => l.id);
	const listed = (deviceEntry(accounts, device)?.order ?? []).filter((id) => id !== DEFAULT_LOGIN_ID && here.includes(id));
	const rest = here.filter((id) => !listed.includes(id));
	return [...listed, ...rest, DEFAULT_LOGIN_ID];
}
export function loginEnabled(accounts: ClaudeAccountsFile, device: string, id: string): boolean {
	if (id === DEFAULT_LOGIN_ID) return deviceEntry(accounts, device)?.defaultEnabled !== false;
	return accounts.logins.find((l) => l.id === id)?.enabled === true;
}

// ---------------------------------------------------------------------------
// A login's directory
// ---------------------------------------------------------------------------

/**
 * Create (0700) the login's directory and link the shared entries to `default`'s directory. Each
 * link is made only when its target exists, except `projects/`, which is created in `default`'s
 * directory if missing: every login must write its session records there. An existing link that
 * points elsewhere is replaced; a real file or directory is left alone.
 */
export function ensureLoginDir(agentDir: string, id: string, defaultDir: string): string {
	const dir = loginDir(agentDir, id);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
	for (const name of SHARED_ENTRIES) {
		const target = path.join(defaultDir, name);
		const link = path.join(dir, name);
		if (name === "projects" && !fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
		if (!fs.existsSync(target)) continue;
		let stat: fs.Stats | undefined;
		try { stat = fs.lstatSync(link); } catch { stat = undefined; }
		if (stat && !stat.isSymbolicLink()) continue;
		if (stat) {
			if (fs.readlinkSync(link) === target) continue;
			fs.rmSync(link, { force: true });
		}
		fs.symlinkSync(target, link);
	}
	return dir;
}
/** Links repaired this process, so a spawn pays for the check once per login. */
const repaired = new Set<string>();
function repairOnce(agentDir: string, id: string, defaultDir: string): void {
	const key = `${agentDir}\u0000${id}\u0000${defaultDir}`;
	if (repaired.has(key)) return;
	try { ensureLoginDir(agentDir, id, defaultDir); repaired.add(key); } catch { /* the spawn reports what is wrong */ }
}

/** `oauthAccount` of a `.claude.json`, as an identity, or null. Reads no token. */
export function readIdentityFile(file: string): ClaudeLoginIdentity | null {
	let json: any;
	try { json = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
	const a = json?.oauthAccount;
	if (!a || typeof a !== "object") return null;
	const identity: ClaudeLoginIdentity = {};
	const put = (key: keyof ClaudeLoginIdentity, value: unknown) => { const s = str(value); if (s) identity[key] = s; };
	put("accountUuid", a.accountUuid);
	put("email", a.emailAddress);
	put("orgUuid", a.organizationUuid);
	put("orgName", a.organizationName);
	// The plan as `claude auth status` names it ("max"): subscriptionType, else the organization's
	// type without its `claude_` prefix. `billingType` ("stripe_subscription") is how it is paid, not a plan.
	put("plan", a.subscriptionType ?? (typeof a.organizationType === "string" ? a.organizationType.replace(/^claude_/, "") : undefined));
	put("rateLimitTier", a.organizationRateLimitTier ?? a.userRateLimitTier ?? a.rateLimitTier);
	return Object.keys(identity).length ? identity : null;
}
/** `claude auth status --json` for a directory: the fallback identity (no account uuid there). */
export function readIdentityFromStatus(dir: string, executable = "claude", timeoutMs = 10_000): ClaudeLoginIdentity | null {
	try {
		const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: dir };
		delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
		const out = spawnSync(executable, ["auth", "status", "--json"], { env, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"] });
		const json = JSON.parse(out.stdout || "null");
		if (!json?.loggedIn) return null;
		const identity: ClaudeLoginIdentity = {};
		if (str(json.email)) identity.email = json.email;
		if (str(json.orgId)) identity.orgUuid = json.orgId;
		if (str(json.orgName)) identity.orgName = json.orgName;
		if (str(json.subscriptionType)) identity.plan = json.subscriptionType;
		return Object.keys(identity).length ? identity : null;
	} catch { return null; }
}
const PLAN_NAMES: Record<string, string> = { free: "Free", pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise" };
/**
 * A login's plan as people say it: "Max 20x" from a rate-limit tier (`default_claude_max_20x`),
 * else "Max" / "Pro" / … from the plan. Undefined for anything else (a billing type such as
 * `stripe_subscription`, which an older registry may hold as its plan).
 */
export function planLabel(identity: ClaudeLoginIdentity | null | undefined): string | undefined {
	const tier = identity?.rateLimitTier?.toLowerCase().match(/(?:^|_)(pro|max|team|enterprise)(?:_(\d+)x)?$/);
	if (tier) return `${PLAN_NAMES[tier[1]!]}${tier[2] ? ` ${tier[2]}x` : ""}`;
	const plan = identity?.plan?.toLowerCase().replace(/^claude_/, "");
	return plan ? PLAN_NAMES[plan] : undefined;
}
export function credentialsMtime(dir: string): number | undefined {
	try { return fs.statSync(path.join(dir, ".credentials.json")).mtimeMs; } catch { return undefined; }
}

// ---------------------------------------------------------------------------
// This host's standing of each login
// ---------------------------------------------------------------------------

export function readAccountsState(agentDir: string): ClaudeAccountsState {
	try {
		const json = JSON.parse(fs.readFileSync(accountsStatePath(agentDir), "utf8"));
		if (json?.version !== 1 || !json.logins || typeof json.logins !== "object") return { version: 1, logins: {} };
		const logins: Record<string, ClaudeLoginStanding> = {};
		for (const [id, s] of Object.entries(json.logins as Record<string, any>)) {
			if ((id !== DEFAULT_LOGIN_ID && !isLoginId(id)) || !s || (s.kind !== "limit" && s.kind !== "auth") || typeof s.at !== "number") continue;
			logins[id] = {
				kind: s.kind, at: s.at,
				...(typeof s.until === "number" ? { until: s.until } : {}),
				...(str(s.window) ? { window: s.window } : {}),
				...(str(s.message) ? { message: s.message } : {}),
				...(typeof s.credentialsMtime === "number" ? { credentialsMtime: s.credentialsMtime } : {}),
				...(str(s.via) ? { via: s.via } : {}),
			};
		}
		return { version: 1, logins };
	} catch { return { version: 1, logins: {} }; }
}
function updateAccountsState(agentDir: string, change: (state: ClaudeAccountsState) => void): ClaudeAccountsState {
	const state = readAccountsState(agentDir);
	change(state);
	writeJsonAtomic(accountsStatePath(agentDir), state, 0o600);
	return state;
}
export function clearStanding(agentDir: string, id: string): void {
	updateAccountsState(agentDir, (state) => { delete state.logins[id]; });
}

/** A login's standing now: ready, or out (limit until a time; auth until its credentials change). */
export type ClaudeLoginReadiness =
	| { state: "ready" }
	| { state: "limited"; until: number; window?: string; message?: string }
	| { state: "auth"; message?: string };
export function readiness(standing: ClaudeLoginStanding | undefined, dir: string, now = Date.now()): ClaudeLoginReadiness {
	if (!standing) return { state: "ready" };
	if (standing.kind === "limit") {
		const until = standing.until ?? standing.at + DEFAULT_LIMIT_COOLDOWN_MS;
		return until > now ? { state: "limited", until, ...(standing.window ? { window: standing.window } : {}), ...(standing.message ? { message: standing.message } : {}) } : { state: "ready" };
	}
	const mtime = credentialsMtime(dir);
	if (mtime !== undefined && standing.credentialsMtime !== undefined && mtime > standing.credentialsMtime) return { state: "ready" };
	if (mtime !== undefined && standing.credentialsMtime === undefined && mtime > standing.at) return { state: "ready" };
	return { state: "auth", ...(standing.message ? { message: standing.message } : {}) };
}

// ---------------------------------------------------------------------------
// The pool's marks on a login: leaving, leases, borrow requests
// ---------------------------------------------------------------------------

/** Why a login is leaving this device. */
export type LeavingReason = "limit" | "auth" | "user" | "pin" | "idle" | "keeper" | "removed" | "superseded";
export interface LoginLeaving { v: 1; at: number; reason: LeavingReason }
const LEAVING_REASONS: readonly LeavingReason[] = ["limit", "auth", "user", "pin", "idle", "keeper", "removed", "superseded"];

/** The login's `.sova-leaving` mark, or undefined. Unreadable = leaving (fail closed). */
export function readLeaving(agentDir: string, id: string): LoginLeaving | undefined {
	let raw: string;
	try { raw = fs.readFileSync(path.join(loginDir(agentDir, id), LEAVING_FILE_NAME), "utf8"); }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : { v: 1, at: 0, reason: "user" }; }
	try {
		const json = JSON.parse(raw);
		return { v: 1, at: typeof json?.at === "number" ? json.at : 0, reason: LEAVING_REASONS.includes(json?.reason) ? json.reason : "user" };
	} catch { return { v: 1, at: 0, reason: "user" }; }
}
/** Mark a login as leaving (kept if already marked: the first reason stands). */
export function markLeaving(agentDir: string, id: string, reason: LeavingReason, now = Date.now()): LoginLeaving {
	const existing = readLeaving(agentDir, id);
	if (existing) return existing;
	const mark: LoginLeaving = { v: 1, at: now, reason };
	const dir = loginDir(agentDir, id);
	if (fs.existsSync(dir)) writeJsonAtomic(path.join(dir, LEAVING_FILE_NAME), mark, 0o600);
	return mark;
}
export function clearLeaving(agentDir: string, id: string): void {
	try { fs.rmSync(path.join(loginDir(agentDir, id), LEAVING_FILE_NAME), { force: true }); } catch { /* gone */ }
}

/** Whether a process exists (a zombie counts; EPERM = someone else's, alive). */
export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** One process's use of one login: `<login dir>/.sova-leases/<owner pid>.json`. */
export interface LoginLease {
	v: 1;
	owner: number;
	/** Users registered (a chat child, a worker, a one-shot). */
	users: number;
	/** Of those, in a turn or task now. */
	busy: number;
	/** The `claude` process ids those users run. */
	children: number[];
	/** Last time any of them was busy (ms epoch). */
	lastActiveAt: number;
	/** When the owner last wrote this file. */
	at: number;
}
/** Every process's use of a login, as the pool agent reads it. */
export interface LoginUse {
	/** Some process on this host still runs (or keeps) `claude` on the login. */
	inUse: boolean;
	busy: boolean;
	lastActiveAt: number;
	/** Live `claude` pids on the login (orphans of a dead owner included). */
	children: number[];
}
/**
 * Whether `pid` is still a process on the login directory `dir`: alive, and (Linux) its environment
 * names `dir` as CLAUDE_CONFIG_DIR — a lease's child pid that has been reused by an unrelated
 * process is not, so it neither holds the login nor gets stopped at a drain's cut. Elsewhere,
 * liveness alone.
 */
export function claudeRunsOn(pid: number, dir: string): boolean {
	if (!pidAlive(pid)) return false;
	if (process.platform !== "linux") return true;
	let env: string;
	try { env = fs.readFileSync(`/proc/${pid}/environ`, "latin1"); } catch { return false; }
	return `\0${env}\0`.includes(`\0CLAUDE_CONFIG_DIR=${dir}\0`);
}
export function readLoginUse(
	agentDir: string, id: string, alive: (pid: number) => boolean = pidAlive, now = Date.now(),
	runsOn: (pid: number, dir: string) => boolean = claudeRunsOn,
): LoginUse {
	const home = loginDir(agentDir, id);
	const dir = path.join(home, LEASES_DIR_NAME);
	const use: LoginUse = { inUse: false, busy: false, lastActiveAt: 0, children: [] };
	let names: string[] = [];
	try { names = fs.readdirSync(dir); } catch { return use; }
	for (const name of names) {
		if (!/^\d+\.json$/.test(name)) continue;
		let lease: LoginLease;
		try { lease = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { continue; }
		const kids = Array.isArray(lease.children) ? [...new Set(lease.children)].filter((pid) => Number.isInteger(pid) && alive(pid) && runsOn(pid, home)) : [];
		const ownerAlive = typeof lease.at === "number" && now - lease.at <= LEASE_STALE_MS && alive(lease.owner);
		if (!ownerAlive && !kids.length) {
			try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* best effort */ }
			continue;
		}
		if (typeof lease.lastActiveAt === "number") use.lastActiveAt = Math.max(use.lastActiveAt, lease.lastActiveAt);
		if (ownerAlive && lease.users > 0) use.inUse = true;
		if (ownerAlive && lease.busy > 0) use.busy = true;
		if (kids.length) { use.inUse = true; use.children.push(...kids); }
	}
	return use;
}

/** Something in this process that runs `claude` on a login (a chat child, a worker, a one-shot). */
export interface LoginUser {
	busy(): boolean;
	/** Stop using the login (the login is leaving): called once, only while not busy. */
	release(): void | Promise<void>;
	/** The `claude` pid it runs now, if any. */
	pid(): number | undefined;
}
interface Registered { agentDir: string; login: string; user: LoginUser; lastActiveAt: number; released: boolean }

/**
 * This process's users of added logins, per login: writes their leases and, every LEASE_TICK_MS,
 * releases the idle users of a login that is leaving. One per process (a `globalThis` singleton,
 * like the bridge), so a `/reload` never forks it.
 */
export class LoginUsers {
	private readonly users = new Set<Registered>();
	private timer?: ReturnType<typeof setInterval>;
	private readonly now: () => number;
	private readonly tickMs: number;
	constructor(now: () => number = Date.now, tickMs = LEASE_TICK_MS) {
		this.now = now;
		this.tickMs = tickMs;
	}

	/** Register a user of `login` (never `default`); the returned function unregisters it. */
	add(agentDir: string, login: string, user: LoginUser): { done(): void; active(): void } {
		const entry: Registered = { agentDir, login, user, lastActiveAt: this.now(), released: false };
		this.users.add(entry);
		this.write(agentDir, login);
		this.arm();
		return {
			done: () => { if (this.users.delete(entry)) this.write(agentDir, login); if (!this.users.size) this.disarm(); },
			active: () => { entry.lastActiveAt = this.now(); this.write(agentDir, login); },
		};
	}
	/** Rewrite every lease and release idle users of leaving logins; the ticker calls it. */
	tick(): void {
		const keys = new Map<string, { agentDir: string; login: string }>();
		for (const entry of this.users) {
			keys.set(`${entry.agentDir}\u0000${entry.login}`, entry);
			if (entry.user.busy()) { entry.lastActiveAt = this.now(); continue; }
			if (entry.released) continue;
			let leaving: LoginLeaving | undefined;
			try { leaving = readLeaving(entry.agentDir, entry.login); } catch { leaving = undefined; }
			if (!leaving) continue;
			entry.released = true;
			try { void Promise.resolve(entry.user.release()).catch(() => { /* the owner reports it */ }); } catch { /* ditto */ }
		}
		for (const { agentDir, login } of keys.values()) this.write(agentDir, login);
	}
	private write(agentDir: string, login: string): void {
		const mine = [...this.users].filter((u) => u.agentDir === agentDir && u.login === login);
		let file: string;
		try { file = path.join(loginDir(agentDir, login), LEASES_DIR_NAME, `${process.pid}.json`); } catch { return; }
		try {
			if (!mine.length) { fs.rmSync(file, { force: true }); return; }
			if (!fs.existsSync(loginDir(agentDir, login))) return;
			const lease: LoginLease = {
				v: 1, owner: process.pid, users: mine.length,
				busy: mine.filter((u) => { try { return u.user.busy(); } catch { return false; } }).length,
				children: mine.map((u) => u.user.pid()).filter((pid): pid is number => typeof pid === "number"),
				lastActiveAt: Math.max(...mine.map((u) => u.lastActiveAt)),
				at: this.now(),
			};
			writeJsonAtomic(file, lease, 0o600);
		} catch { /* a lease we cannot write: the drain's bound still applies */ }
	}
	private arm(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.tick(), this.tickMs);
		this.timer.unref?.();
	}
	private disarm(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
	/** Tests: how many users are registered. */
	get size(): number { return this.users.size; }
}
const LOGIN_USERS = Symbol.for("pi-config.claude-code.login-users");
/** The process-wide LoginUsers. */
export function loginUsers(): LoginUsers {
	const host = globalThis as unknown as Record<symbol, LoginUsers | undefined>;
	return host[LOGIN_USERS] ??= new LoginUsers();
}

/** A borrow request: `<agent dir>/claude-pool/wants/<pid>-<rand>.json`. */
export interface LoginWant { v: 1; at: number; pid: number; excludeAccounts?: string[]; excludeLogins?: string[] }
export const wantsDir = (agentDir: string): string => path.join(agentDir, POOL_DIR_NAME, "wants");
export const poolAgentPath = (agentDir: string): string => path.join(agentDir, POOL_DIR_NAME, "agent.json");
/** Whether this host's pool agent (Sova's server, mesh on) is running: its heartbeat is fresh and its pid alive. */
export function poolAgentAlive(agentDir: string, now = Date.now()): boolean {
	try {
		const beat = JSON.parse(fs.readFileSync(poolAgentPath(agentDir), "utf8"));
		return typeof beat?.at === "number" && now - beat.at < POOL_AGENT_FRESH_MS && pidAlive(beat.pid);
	} catch { return false; }
}
export function readWants(agentDir: string): Array<{ file: string; want: LoginWant }> {
	const dir = wantsDir(agentDir);
	let names: string[] = [];
	try { names = fs.readdirSync(dir); } catch { return []; }
	const out: Array<{ file: string; want: LoginWant }> = [];
	for (const name of names.sort()) {
		if (!name.endsWith(".json")) continue;
		const file = path.join(dir, name);
		try {
			const w = JSON.parse(fs.readFileSync(file, "utf8"));
			if (typeof w?.at !== "number" || typeof w?.pid !== "number") continue;
			const list = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 64) : undefined;
			out.push({ file, want: { v: 1, at: w.at, pid: w.pid, ...(list(w.excludeAccounts) ? { excludeAccounts: list(w.excludeAccounts)! } : {}), ...(list(w.excludeLogins) ? { excludeLogins: list(w.excludeLogins)! } : {}) } });
		} catch { /* half-written or gone */ }
	}
	return out;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

const WINDOW_LABELS: Record<string, string> = {
	five_hour: "5h limit", seven_day: "weekly limit", seven_day_opus: "weekly Opus limit",
	seven_day_sonnet: "weekly Sonnet limit", seven_day_overage_included: "weekly limit", overage: "extra-usage limit",
};
function clock(ms: number, now: number): string {
	const d = new Date(ms);
	const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	if (ms - now < 20 * 3_600_000 && new Date(now).getDate() === d.getDate()) return hm;
	return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${hm}`;
}
/** "5h limit, resets 15:00" / "sign-in failed". */
export function failureReason(failure: ClaudeAccountFailure, now = Date.now()): string {
	if (failure.kind === "auth") return "sign-in failed";
	const what = (failure.window && WINDOW_LABELS[failure.window]) || "usage limit";
	return failure.resetsAt ? `${what}, resets ${clock(failure.resetsAt, now)}` : what;
}
export function switchText(from: ClaudeLoginChoice, to: ClaudeLoginChoice, failure: ClaudeAccountFailure, now = Date.now()): string {
	return `Claude: switched ${from.label} → ${to.label} (${failureReason(failure, now)})`;
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

export interface ClaudeLoginsOptions {
	agentDir?: string;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	/** How long a spawn waits for a borrow (WANT_WAIT_MS). */
	wantWaitMs?: number;
	/** How often it looks while it waits. */
	wantPollMs?: number;
	/** Where users are tracked (the process-wide loginUsers() by default). */
	users?: LoginUsers;
}

/**
 * The host's logins as spawns use them. Every call re-reads the registry and the state file (both
 * small), so a Settings change or another process's failure applies to the next spawn.
 */
export class ClaudeLogins {
	readonly agentDir: string;
	private readonly env: NodeJS.ProcessEnv;
	private readonly now: () => number;
	private readonly wantWaitMs: number;
	private readonly wantPollMs: number;
	private readonly users: () => LoginUsers;
	constructor(options: ClaudeLoginsOptions = {}) {
		this.env = options.env ?? process.env;
		this.agentDir = options.agentDir ?? defaultAgentDir(this.env);
		this.now = options.now ?? Date.now;
		this.wantWaitMs = options.wantWaitMs ?? WANT_WAIT_MS;
		this.wantPollMs = options.wantPollMs ?? 250;
		this.users = options.users ? () => options.users! : loginUsers;
	}
	/** Whether the pool is on here (the mesh is): only logins held here are used. */
	get pool(): boolean { return poolActive(this.agentDir); }
	get defaultDir(): string { return defaultClaudeDir(this.env); }
	get device(): string { return thisDeviceId(this.agentDir, this.env); }
	accounts(): ClaudeAccountsFile { return readAccounts(this.agentDir).value; }
	dirOf(id: string): string { return id === DEFAULT_LOGIN_ID ? this.defaultDir : loginDir(this.agentDir, id); }
	identityOf(id: string, accounts = this.accounts()): ClaudeLoginIdentity | null {
		if (id === DEFAULT_LOGIN_ID) return readIdentityFile(claudeJsonPath(this.defaultDir, true, this.env));
		return accounts.logins.find((l) => l.id === id)?.identity ?? null;
	}
	/** The choice for an id this host may use, or undefined. */
	choice(id: string, accounts = this.accounts()): ClaudeLoginChoice | undefined {
		const pool = this.pool;
		if (id !== DEFAULT_LOGIN_ID && !accounts.logins.some((l) => l.id === id && heldHere(l.device, this.device, pool))) return undefined;
		const identity = this.identityOf(id, accounts);
		const record = accounts.logins.find((l) => l.id === id);
		const label = record?.label ?? identity?.email ?? (id === DEFAULT_LOGIN_ID ? "default" : id);
		if (id !== DEFAULT_LOGIN_ID) repairOnce(this.agentDir, id, this.defaultDir);
		return {
			id, label,
			env: id === DEFAULT_LOGIN_ID ? {} : { CLAUDE_CONFIG_DIR: loginDir(this.agentDir, id) },
			...(identity?.accountUuid ? { accountUuid: identity.accountUuid } : {}),
		};
	}
	order(accounts = this.accounts()): string[] { return deviceOrder(accounts, this.device, this.pool); }
	/** Whether a login is on its way to another device (`.sova-leaving`): never chosen then. */
	leaving(id: string): boolean {
		if (id === DEFAULT_LOGIN_ID || !isLoginId(id)) return false;
		return readLeaving(this.agentDir, id) !== undefined;
	}
	/**
	 * Lease a short-lived `claude` (model discovery, the summarizer) spawned with `env`: it counts
	 * as busy on its login until it exits, so no login leaves under it. Nothing for `default`.
	 */
	leaseChild(env: Record<string, string | undefined>, child: { pid?: number; once(event: "exit", listener: () => void): unknown }): void {
		const dir = env.CLAUDE_CONFIG_DIR;
		if (!dir || path.dirname(dir) !== path.join(this.agentDir, ACCOUNTS_DIR_NAME) || !isLoginId(path.basename(dir))) return;
		try {
			const lease = this.track(path.basename(dir), { busy: () => true, release: () => { /* it ends by itself */ }, pid: () => child.pid });
			child.once("exit", () => lease.done());
		} catch { /* no lease: the drain's bound still applies */ }
	}
	/** Register a process's use of a login (a chat child, a worker): its lease, and its release when the login leaves. */
	track(id: string, user: LoginUser): { done(): void; active(): void } {
		if (id === DEFAULT_LOGIN_ID || !isLoginId(id)) return { done() { /* default never moves */ }, active() { /* ditto */ } };
		return this.users().add(this.agentDir, id, user);
	}
	readinessOf(id: string, state = readAccountsState(this.agentDir)): ClaudeLoginReadiness {
		return readiness(state.logins[id], this.dirOf(id), this.now());
	}
	private usable(id: string, accounts: ClaudeAccountsFile, state: ClaudeAccountsState): boolean {
		return loginEnabled(accounts, this.device, id) && this.readinessOf(id, state).state === "ready" && !this.leaving(id);
	}
	/**
	 * The login a spawn runs on: `current` while it is still usable here, else the first usable
	 * login in this device's order; with none usable, `current` if it is still here, else the
	 * order's first (as before: the failure it meets is the one it would have met).
	 */
	select(current?: string): ClaudeLoginChoice {
		const accounts = this.accounts();
		return this.choice(this.selectId(current, accounts), accounts) ?? this.choice(DEFAULT_LOGIN_ID, accounts)!;
	}
	/** The id `select` would run on, without touching the login's directory: what a display asks. */
	selectId(current?: string, accounts = this.accounts()): string {
		const state = readAccountsState(this.agentDir);
		const order = this.order(accounts);
		if (current && order.includes(current) && this.usable(current, accounts, state)) return current;
		const first = order.find((id) => this.usable(id, accounts, state));
		if (first) return first;
		return current && order.includes(current) ? current : order[0] ?? DEFAULT_LOGIN_ID;
	}
	/**
	 * Record `failure` for `from` (for a limit, also for every login here of the same account),
	 * then the next usable login in order, skipping — for a limit — every login of that account.
	 * Undefined when none is left.
	 */
	failover(from: ClaudeLoginChoice, failure: ClaudeAccountFailure): ClaudeLoginChoice | undefined {
		this.recordFailure(from, failure);
		const next = this.nextAfter(from, failure, true);
		return next ? this.choice(next) : undefined;
	}
	/** The next usable login after `from` in this device's order (`default` only when `withDefault`). */
	private nextAfter(from: ClaudeLoginChoice, failure: ClaudeAccountFailure, withDefault: boolean): string | undefined {
		const accounts = this.accounts();
		const state = readAccountsState(this.agentDir);
		const account = from.accountUuid;
		return this.order(accounts).find((id) => {
			if (id === from.id || !this.usable(id, accounts, state)) return false;
			if (!withDefault && id === DEFAULT_LOGIN_ID) return false;
			if (failure.kind === "limit" && account && this.identityOf(id, accounts)?.accountUuid === account) return false;
			return true;
		});
	}
	/** The first usable added login held here, not excluded; undefined when there is none. */
	private firstHeld(excludeAccounts: readonly string[] = [], excludeLogins: readonly string[] = []): string | undefined {
		const accounts = this.accounts();
		const state = readAccountsState(this.agentDir);
		return this.order(accounts).find((id) => id !== DEFAULT_LOGIN_ID && !excludeLogins.includes(id)
			&& this.usable(id, accounts, state)
			&& !(excludeAccounts.length && excludeAccounts.includes(this.identityOf(id, accounts)?.accountUuid ?? "\u0000")));
	}
	/**
	 * `select`, but a spawn that would fall back to `default` (no usable added login held here)
	 * first asks this host's pool agent to borrow one and waits for it (only while the pool is on
	 * and the agent runs). What chat children and workers start on.
	 */
	async acquire(current?: string): Promise<ClaudeLoginChoice> {
		const accounts = this.accounts();
		const id = this.selectId(current, accounts);
		if (id !== DEFAULT_LOGIN_ID && this.usable(id, accounts, readAccountsState(this.agentDir))) return this.select(current);
		if (this.firstHeld() === undefined && this.pool && poolAgentAlive(this.agentDir, this.now())) await this.borrow({});
		return this.select(current);
	}
	/**
	 * A failure on `from` while the pool is on: `from` goes back (it leaves this device, with its
	 * standing), and the turn moves to the next usable login held here, else to one borrowed now
	 * (not of the same account on a limit), else to `default`. With the pool off: `failover`.
	 */
	async failoverAsync(from: ClaudeLoginChoice, failure: ClaudeAccountFailure): Promise<ClaudeLoginChoice | undefined> {
		if (!this.pool) return this.failover(from, failure);
		this.recordFailure(from, failure);
		if (from.id !== DEFAULT_LOGIN_ID && isLoginId(from.id)) {
			try { markLeaving(this.agentDir, from.id, failure.kind, this.now()); } catch { /* the agent sees the standing */ }
		}
		const excludeAccounts = failure.kind === "limit" && from.accountUuid ? [from.accountUuid] : [];
		let next = this.nextAfter(from, failure, false);
		if (!next && poolAgentAlive(this.agentDir, this.now())) {
			await this.borrow({ excludeAccounts, excludeLogins: [from.id] });
			next = this.nextAfter(from, failure, false);
		}
		next ??= this.nextAfter(from, failure, true);
		return next ? this.choice(next) : undefined;
	}
	/** Write a borrow request and wait until a usable login is held here, the agent answered, or the wait ends. */
	private async borrow(want: { excludeAccounts?: string[]; excludeLogins?: string[] }): Promise<void> {
		const dir = wantsDir(this.agentDir);
		const file = path.join(dir, `${process.pid}-${randomBytes(4).toString("hex")}.json`);
		try {
			fs.mkdirSync(dir, { recursive: true });
			writeJsonAtomic(file, { v: 1, at: this.now(), pid: process.pid, ...want } satisfies LoginWant, 0o600);
		} catch { return; }
		const until = Date.now() + this.wantWaitMs;
		try {
			while (Date.now() < until) {
				if (this.firstHeld(want.excludeAccounts, want.excludeLogins) !== undefined) return;
				if (!fs.existsSync(file)) return; // the agent answered: borrowed (seen above next time) or none to lend
				await sleep(this.wantPollMs);
			}
		} finally {
			try { fs.rmSync(file, { force: true }); } catch { /* gone */ }
		}
	}
	recordFailure(from: ClaudeLoginChoice, failure: ClaudeAccountFailure): void {
		const now = this.now();
		try {
			const accounts = this.accounts();
			updateAccountsState(this.agentDir, (state) => {
				if (failure.kind === "auth") {
					const mtime = credentialsMtime(this.dirOf(from.id));
					state.logins[from.id] = { kind: "auth", at: now, ...(failure.message ? { message: failure.message.slice(0, MAX_TEXT) } : {}), ...(mtime !== undefined ? { credentialsMtime: mtime } : {}) };
					return;
				}
				const until = failure.resetsAt && failure.resetsAt > now ? failure.resetsAt : now + DEFAULT_LIMIT_COOLDOWN_MS;
				const standing: ClaudeLoginStanding = { kind: "limit", at: now, until, ...(failure.window ? { window: failure.window } : {}), ...(failure.message ? { message: failure.message.slice(0, MAX_TEXT) } : {}) };
				state.logins[from.id] = standing;
				if (!from.accountUuid) return;
				for (const id of this.order(accounts)) {
					if (id !== from.id && this.identityOf(id, accounts)?.accountUuid === from.accountUuid) state.logins[id] = { ...standing, via: from.id };
				}
			});
		} catch { /* a state file we cannot write: failover still skips `from` this time */ }
	}
	/** The development switch: the failure this login is forced to report, when enabled. */
	forcedFailure(id: string): ClaudeAccountFailure | undefined {
		if (this.env[ACCOUNTS_DEV_ENV] !== "1") return undefined;
		try {
			const dev = JSON.parse(fs.readFileSync(accountsDevPath(this.agentDir), "utf8"));
			if (Array.isArray(dev?.forceLimit) && dev.forceLimit.includes(id)) return { kind: "limit", resetsAt: this.now() + DEV_LIMIT_RESET_MS, window: "five_hour", message: "forced by claude-accounts-dev.json" };
			if (Array.isArray(dev?.forceAuth) && dev.forceAuth.includes(id)) return { kind: "auth", message: "forced by claude-accounts-dev.json" };
		} catch { /* no switch */ }
		return undefined;
	}
}

/** The process-wide resolver for the real agent dir; spawns that are not tests use this. */
export function hostLogins(): ClaudeLogins { return new ClaudeLogins(); }

/** The `claude-login` session entry: the login a session runs on, and the switch that put it there. */
export const CLAUDE_LOGIN_ENTRY = "claude-login";
export interface ClaudeLoginEntry {
	v: 1;
	login: string;
	label?: string;
	/** Present on a failover: the login it left. */
	from?: string;
	fromLabel?: string;
	reason?: "limit" | "auth";
	resetsAt?: number;
	/** The notice, as the chat shows it. */
	text?: string;
}
export function loginEntryFor(to: ClaudeLoginChoice, change?: ClaudeLoginSwitch): ClaudeLoginEntry {
	return {
		v: 1, login: to.id, label: to.label,
		...(change ? {
			from: change.from.id, fromLabel: change.from.label, reason: change.failure.kind,
			...(change.failure.resetsAt ? { resetsAt: change.failure.resetsAt } : {}),
			text: change.text,
		} : {}),
	};
}
/** The newest `claude-login` entry's login among `entries` (a session branch, oldest first). */
export function recordedLogin(entries: readonly unknown[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as { type?: unknown; customType?: unknown; data?: any };
		if (e?.type === "custom" && e.customType === CLAUDE_LOGIN_ENTRY && typeof e.data?.login === "string") return e.data.login;
	}
	return undefined;
}
