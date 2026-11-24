/**
 * The built-in helper profiles: Claude, OpenAI and DeepSeek, each a whole helper setup named after the
 * account it runs on. Computed here, never stored in `subagent-profiles.json`, so they never sync and an
 * older reader never sees them. Each names fixed models: a newer model never moves them.
 *
 * Which ones a computer has, and which one a chat with no default falls back to, follow the accounts
 * connected here (`readConnectedAccounts`): a Claude sign-in, pi's own OpenAI sign-in, an Ollama Cloud key.
 * The order is Claude, then OpenAI, then DeepSeek; with none connected it is Claude.
 *
 * A profile of the user's takes a built-in one's place (`shadowOf`): one with the same id (a copy made
 * from it), else one with the same name, else, for Claude, the seeded starter (`my-setup`, which older
 * builds created for everyone), shown as "Claude".
 *
 * Node built-ins and type-only imports only: the mode engine, the subagents extension and Sova's server
 * all import this file.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SubagentProfile, TeamsSetting } from "./subagent-profiles.ts";
import type { DelegateProfile, WorkerChoice } from "../mode/delegate.ts";
import type { WorkerTuple } from "./team-defaults.ts";

export const BUILTIN_PROFILE_IDS = ["claude", "openai", "deepseek"] as const;
export type BuiltinProfileId = (typeof BUILTIN_PROFILE_IDS)[number];
export const BUILTIN_PROFILE_NAMES: Record<BuiltinProfileId, string> = { claude: "Claude", openai: "OpenAI", deepseek: "DeepSeek" };
/** The library id older builds seeded for everyone ("My setup"): it takes Claude's place. */
export const SEEDED_STARTER_ID = "my-setup";

export const isBuiltinProfileId = (v: unknown): v is BuiltinProfileId => typeof v === "string" && (BUILTIN_PROFILE_IDS as readonly string[]).includes(v);

const claude = (model: string, effort: string): WorkerChoice => ({ backend: "claude-code", model, effort });
const pi = (model: string, effort: string): WorkerChoice => ({ backend: "pi", model, effort });
const route = (primary: WorkerChoice): DelegateProfile => ({ primary, fallback: null });

/** The chat's own model and effort each built-in profile starts a chat on (its session half's). */
export const BUILTIN_CHAT_MODELS: Record<BuiltinProfileId, { model: string; thinking: string }> = {
	claude: { model: "claude-code-cli/claude-opus-5-5", thinking: "medium" },
	openai: { model: "openai-codex/gpt-6.2-sol", thinking: "medium" },
	deepseek: { model: "ollama-cloud/deepseek-v4.1-flash", thinking: "high" },
};

const tuple = (w: WorkerChoice): WorkerTuple => ({ backend: w.backend, model: w.model, effort: w.effort as WorkerTuple["effort"] });
function teams(coordinator: WorkerChoice, monitor: WorkerChoice): TeamsSetting {
	return {
		coordinator: { role: "coordinator", primary: tuple(coordinator), fallback: null, instructions: "" },
		monitor: {
			role: "monitor", primary: tuple(monitor), fallback: null,
			contextPct: 60, everyMinutes: 10, usage: { enabled: true, pausePct: 90, resumeMarginMinutes: 5 }, instructions: "",
		},
		handover: { retireTimeoutMinutes: 10 },
	};
}

/** A built-in profile's helper half, a fresh copy each call. */
export function builtinHelpers(id: BuiltinProfileId): SubagentProfile {
	const name = BUILTIN_PROFILE_NAMES[id];
	if (id === "claude")
		return {
			id, name,
			delegate: {
				planning: route(claude("claude-fable-5-2", "high")),
				investigation: route(claude("claude-opus-5-5", "medium")),
				routine: route(claude("claude-opus-5-5", "medium")),
				complex: route(claude("claude-opus-5-5", "high")),
			},
			teams: teams(claude("claude-opus-5-5", "medium"), claude("claude-haiku-5-5", "medium")),
			members: null,
			specWriter: null,
		};
	if (id === "openai") {
		const sol = (effort: string) => route(pi("openai-codex/gpt-6.2-sol", effort));
		return { id, name, delegate: { planning: sol("xhigh"), investigation: sol("low"), routine: sol("medium"), complex: sol("high") }, teams: null, members: null, specWriter: null };
	}
	const flash = (effort: string) => pi("ollama-cloud/deepseek-v4.1-flash", effort);
	return {
		id, name,
		delegate: { planning: route(flash("max")), investigation: route(flash("low")), routine: route(flash("high")), complex: route(flash("high")) },
		teams: teams(flash("high"), flash("low")),
		members: null,
		specWriter: null,
	};
}

/** The accounts the built-in profiles run on, as connected on this computer. */
export interface ConnectedAccounts {
	claude: boolean;
	openai: boolean;
	ollamaCloud: boolean;
}

/** The built-in profiles a computer with these accounts has, in order. With none connected, Claude alone. */
export function builtinsFor(c: ConnectedAccounts): BuiltinProfileId[] {
	const out = BUILTIN_PROFILE_IDS.filter((id) => (id === "claude" ? c.claude : id === "openai" ? c.openai : c.ollamaCloud));
	return out.length ? out : ["claude"];
}

/** The built-in profile a chat falls back to while no default is chosen: Claude, then OpenAI, then DeepSeek. */
export const builtinDefaultFor = (c: ConnectedAccounts): BuiltinProfileId => builtinsFor(c)[0]!;

/**
 * The profile of the user's that takes the built-in `id`'s place, or undefined: one with its id, else
 * one with its name (any case), else, for Claude, the seeded starter.
 */
export function shadowOf<P extends { id: string; name: string }>(id: BuiltinProfileId, profiles: readonly P[]): P | undefined {
	const name = BUILTIN_PROFILE_NAMES[id].toLowerCase();
	return (
		profiles.find((p) => p.id === id) ??
		profiles.find((p) => p.name.toLowerCase() === name) ??
		(id === "claude" ? profiles.find((p) => p.id === SEEDED_STARTER_ID) : undefined)
	);
}

/** The built-in a profile of the user's takes the place of, or undefined. */
export function shadowedBy(p: { id: string; name: string }, profiles: readonly { id: string; name: string }[]): BuiltinProfileId | undefined {
	return BUILTIN_PROFILE_IDS.find((id) => shadowOf(id, profiles) === p);
}

/** A library profile's name as every screen shows it: the seeded starter that takes Claude's place is "Claude". */
export function displayNameOf(p: { id: string; name: string }, profiles: readonly { id: string; name: string }[]): string {
	return p.id === SEEDED_STARTER_ID && shadowOf("claude", profiles) === p ? BUILTIN_PROFILE_NAMES.claude : p.name;
}

// ── Connected accounts ───────────────────────────────────────────────────────

/** Where the accounts are read from; tests pass their own. */
export interface AccountPaths {
	/** pi's auth.json (the OpenAI sign-in and the API keys). */
	piAuth: string;
	/** Claude Code's own directory's credentials file and `.claude.json`. */
	claudeCreds: string;
	claudeJson: string;
	/** Sova's added Claude logins: `claude-accounts.json` and their directories' parent. */
	claudeAccounts: string;
	claudeLoginsDir: string;
}

/** The paths for `agentDir`, Claude Code's directory as Claude Code finds it ($CLAUDE_CONFIG_DIR, else ~/.claude). */
export function accountPaths(agentDir: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): AccountPaths {
	const loginsDir = path.join(agentDir, "claude-accounts");
	const raw = env.CLAUDE_CONFIG_DIR?.trim();
	// A Sova-spawned process may inherit an added login's directory: that is not Claude Code's own.
	const own = raw && !path.resolve(raw).startsWith(path.resolve(loginsDir) + path.sep) ? raw : undefined;
	const dir = own ?? path.join(home, ".claude");
	return {
		piAuth: path.join(agentDir, "auth.json"),
		claudeCreds: path.join(dir, ".credentials.json"),
		claudeJson: own ? path.join(own, ".claude.json") : path.join(home, ".claude.json"),
		claudeAccounts: path.join(agentDir, "claude-accounts.json"),
		claudeLoginsDir: loginsDir,
	};
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const hasText = (v: unknown): boolean => typeof v === "string" && v.length > 0;
function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}
/** A Claude Code directory is signed in: a token in its credentials file, or (macOS keeps the token in the keychain) an account in its `.claude.json`. */
function claudeSignedIn(creds: string, claudeJson: string): boolean {
	const c = readJson(creds);
	if (isRecord(c) && isRecord(c.claudeAiOauth) && hasText(c.claudeAiOauth.accessToken)) return true;
	const j = readJson(claudeJson);
	return isRecord(j) && isRecord(j.oauthAccount);
}

/** Read the accounts now. Only reads, and keeps no secret. */
export function readAccountsAt(p: AccountPaths): ConnectedAccounts {
	const auth = readJson(p.piAuth);
	const entry = (key: string) => (isRecord(auth) && isRecord(auth[key]) ? auth[key] : undefined);
	const openai = hasText(entry("openai-codex")?.access);
	const ollamaCloud = hasText(entry("ollama-cloud")?.key);
	let claude = claudeSignedIn(p.claudeCreds, p.claudeJson);
	if (!claude) {
		const accounts = readJson(p.claudeAccounts);
		const logins = isRecord(accounts) && Array.isArray(accounts.logins) ? accounts.logins : [];
		claude = logins.some((l) => {
			const id = isRecord(l) && typeof l.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(l.id) ? l.id : undefined;
			if (!id) return false;
			const dir = path.join(p.claudeLoginsDir, id);
			return claudeSignedIn(path.join(dir, ".credentials.json"), path.join(dir, ".claude.json"));
		});
	}
	return { claude, openai, ollamaCloud };
}

const stamp = (file: string): string => {
	try {
		const s = fs.statSync(file);
		return `${s.mtimeMs}:${s.size}:${s.ino}`;
	} catch {
		return "-";
	}
};
const memo = new Map<string, { stamps: string; value: ConnectedAccounts }>();

/**
 * The accounts connected for `agentDir` now, re-read only when one of the files changed (a stat each per
 * call; an added login's directory is read again only when claude-accounts.json changes).
 */
export function readConnectedAccounts(agentDir: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): ConnectedAccounts {
	const p = accountPaths(agentDir, env, home);
	const stamps = [p.piAuth, p.claudeCreds, p.claudeJson, p.claudeAccounts].map(stamp).join("|");
	const key = JSON.stringify(p);
	const hit = memo.get(key);
	if (hit && hit.stamps === stamps) return hit.value;
	const value = readAccountsAt(p);
	memo.set(key, { stamps, value });
	return value;
}
