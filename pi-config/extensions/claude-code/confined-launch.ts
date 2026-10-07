/**
 * A Claude Code worker confined by the sandbox: what its process needs besides the policy, as the
 * plain data the sandbox's generic launch seam takes (`sandbox/launch.ts` `LaunchNeeds`), and the
 * confined spawn itself. The sandbox knows nothing of Claude; this file knows nothing of the policy.
 *
 * The worker runs with its own Claude Code config directory, `<agentDir>/sova/sandbox/claude/<key>/`
 * (CLAUDE_CONFIG_DIR inside; kept across resumes), whose `projects/<slug>` is a link to the real
 * transcript folder of its cwd, so its records land where every reader looks. Its login's
 * credentials stay hidden: the access token (never the refresh token, accounts.ts accessTokenFor)
 * is read outside at every launch and handed over on fd 3 (CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR,
 * probed with CLI 2.1.282), so it is in no argv and no environment. Seen from outside, the process
 * still names its login's directory in CLAUDE_CONFIG_DIR (spawnEnv), so the pool's
 * /proc/<pid>/environ lookup (accounts.ts claudeRunsOn) keeps counting it on that login.
 *
 * Node builtins only, and the sandbox module is loaded by path (`confine.module`) at launch, never
 * imported: a hosting process (subagents/host.ts) runs the same steps with the serialized data.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultClaudeDir, type ClaudeLoginChoice } from "./accounts.ts";
import type { ConfineLaunchResult, LaunchCommand, LaunchNeeds } from "../sandbox/launch.ts";

/** The confinement a worker's every launch goes through (subagents passes it from workerLaunch). */
export interface ClaudeConfine {
	/** workerLaunch's opaque scope and the module that exports `confineLaunch` / `workerTmpDir`. */
	scope: string;
	module: string;
	/** The worker's session-qualified key (`<parent session>-<worker id>`): names its config dir. */
	key: string;
	/** The parent's agent dir, where the private config dirs live. */
	agentDir: string;
	/** Further paths the worker's own state needs writable: its team mailbox and spec-hook state dir. */
	writable?: string[];
	/** A hosted worker: the host process confines it and owns this tmp (never the parent's). */
	hostedTmpDir?: string;
	/**
	 * How the worker is confined, for its transcript's `[sandbox: confined — …]` line: "the session's
	 * sandbox", "the session's sandbox, narrowed to <root>" or "write-only to <root>".
	 */
	describe?: string;
}

/** The fd the access token arrives on inside. */
export const TOKEN_FD = 3;
export const TOKEN_FD_ENV = "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR";
/** The hosts a confined worker's proxy allows besides the policy's (under read-only, the only ones). */
export const CLAUDE_API_HOSTS = ["api.anthropic.com"];
/** Claude Code's own sandbox is off inside ours: one boundary, ours. */
export const CONFINED_SETTINGS = { sandbox: { enabled: false } } as const;
/** Credentials a confined worker never inherits: its login's token comes on the fd only. */
const SECRET_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", TOKEN_FD_ENV];
/** What a confined launch's source environment drops: the credentials and the login's directory (confinedSourceEnv). */
// CLAUDE_CODE_TMPDIR would win over the sandbox's TMPDIR (the worker's own tmp): an inherited one names
// a host path that is read-only inside (a write-only worker sees the host's /tmp read-only).
export const CONFINED_DROP_ENV: readonly string[] = [...SECRET_VARS, "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_TMPDIR"];
/** Entries of the login's directory the private one links to, read-only through their targets (user memory, agents, commands, skills). */
const LINKED = ["CLAUDE.md", "agents", "commands", "skills", "plugins"];
/** The CLI keeps a project slug whole up to this length; a longer one gets a hash suffix only it can compute. */
const SLUG_MAX = 200;
/** accounts.ts, for a hosting process that reads the token itself. */
export const ACCOUNTS_MODULE = fileURLToPath(new URL("./accounts.ts", import.meta.url));

/** `<agentDir>/sova/sandbox/claude/<key>/`: the worker's own Claude Code state, CLAUDE_CONFIG_DIR inside. */
export function privateConfigDir(agentDir: string, key: string): string {
	if (!/^[A-Za-z0-9._-]+$/.test(key) || key === "." || key === "..") throw new Error(`Not a worker key: ${key}`);
	return path.join(agentDir, "sova", "sandbox", "claude", key);
}
/** Remove a worker's private config dir (its registry entry is gone). Never throws. */
export function releasePrivateConfigDir(agentDir: string, key: string): void {
	try { fs.rmSync(privateConfigDir(agentDir, key), { recursive: true, force: true }); } catch { /* gone */ }
}
/** The directory a login's token and transcripts come from: its CLAUDE_CONFIG_DIR, else Claude Code's own. */
export function loginDirOf(login: Pick<ClaudeLoginChoice, "env"> | undefined): string {
	return login?.env.CLAUDE_CONFIG_DIR ?? defaultClaudeDir();
}
/** The CLI's project folder name for a cwd: every non-alphanumeric becomes `-` (provider/session-records.ts). */
const slugOf = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/**
 * Make the worker's private config dir (0700) and its links, and return the launch's `needs`: every
 * path absolute. `env` is the extra environment the launch was given (MCP_TOOL_TIMEOUT and the like);
 * the login's CLAUDE_CONFIG_DIR in it is replaced by the private dir inside and kept outside. Throws
 * with the reason when the worker cannot be set up (the caller refuses the launch).
 */
export function claudeNeeds(o: {
	confine: ClaudeConfine;
	cwd: string;
	login: Pick<ClaudeLoginChoice, "env"> | undefined;
	env?: Record<string, string>;
}): LaunchNeeds {
	const loginDir = loginDirOf(o.login);
	const home = privateConfigDir(o.confine.agentDir, o.confine.key);
	const slug = slugOf(o.cwd);
	if (slug.length > SLUG_MAX) throw new Error(`its working directory's path is too long for a confined Claude worker (${o.cwd.length} characters; the transcript folder name must stay under ${SLUG_MAX})`);
	fs.mkdirSync(home, { recursive: true, mode: 0o700 });
	try { fs.chmodSync(home, 0o700); } catch { /* best effort */ }
	// The transcripts: every login's projects/ is Claude Code's own (accounts.ts SHARED_ENTRIES).
	const projectsLink = path.join(loginDir, "projects");
	if (!fs.existsSync(projectsLink)) fs.mkdirSync(projectsLink, { recursive: true });
	const slugDir = path.join(fs.realpathSync(projectsLink), slug);
	fs.mkdirSync(slugDir, { recursive: true });
	fs.mkdirSync(path.join(home, "projects"), { recursive: true });
	link(slugDir, path.join(home, "projects", slug));
	for (const name of LINKED) {
		let target: string;
		try { target = fs.realpathSync(path.join(loginDir, name)); } catch { continue; }
		if (!target.startsWith(home + path.sep)) link(target, path.join(home, name));
	}
	const extra = { ...o.env };
	for (const name of [...SECRET_VARS, "CLAUDE_CONFIG_DIR"]) delete extra[name];
	return {
		writable: [home, slugDir, ...(o.confine.writable ?? [])],
		proxyHosts: [...CLAUDE_API_HOSTS],
		env: { ...extra, CLAUDE_CONFIG_DIR: home, [TOKEN_FD_ENV]: String(TOKEN_FD), DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
		...(o.login?.env.CLAUDE_CONFIG_DIR ? { spawnEnv: { CLAUDE_CONFIG_DIR: o.login.env.CLAUDE_CONFIG_DIR } } : {}),
		...(o.confine.hostedTmpDir ? { tmpDir: o.confine.hostedTmpDir } : {}),
	};
}
/** A symlink at `at` to `target`, replacing a stale link (never a real file or directory). */
function link(target: string, at: string): void {
	let stat: fs.Stats | undefined;
	try { stat = fs.lstatSync(at); } catch { stat = undefined; }
	if (stat && !stat.isSymbolicLink()) return;
	if (stat) {
		if (fs.readlinkSync(at) === target) return;
		fs.unlinkSync(at);
	}
	fs.symlinkSync(target, at);
}

/** The launch environment a confined claude is picked from: the unconfined one, without any credential or login dir. */
export function confinedSourceEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) if (typeof value === "string" && !CONFINED_DROP_ENV.includes(name)) out[name] = value;
	return out;
}

/** What the sandbox module exports (sandbox/launch.ts), as this file uses it. */
export interface LaunchModule {
	confineLaunch(scope: string, needs: LaunchNeeds, launch: LaunchCommand): Promise<ConfineLaunchResult>;
	workerTmpDir(scope: string, needs?: Pick<LaunchNeeds, "tmpDir">): { host: string; inside: string };
	releaseWorkerTmp?(scope: string): void;
}
const loaded = new Map<string, Promise<LaunchModule>>();
/** The sandbox's launch module, by the path workerLaunch named (loaded once per path). */
export function launchModule(file: string): Promise<LaunchModule> {
	let module = loaded.get(file);
	if (!module) {
		module = import(file) as Promise<LaunchModule>;
		loaded.set(file, module);
		module.catch(() => loaded.delete(file));
	}
	return module;
}

/** A private config dir untouched this long may be swept (a running worker's CLI writes there all the time). */
export const PRIVATE_DIR_IDLE_MS = 24 * 60 * 60_000;
/**
 * Delete the private config dirs whose worker is gone for good (§chat.sandbox/claude-state): the
 * owner session's file no longer exists under any of `sessionDirs` (an unsaved session: its process
 * is dead), or the owner is the current session (`current`) and no record of the worker is left in
 * it (`recorded`). Never a dir `keep` claims (a worker running here, or a hosted one whose host
 * lives), nor one touched in the last PRIVATE_DIR_IDLE_MS. Returns the keys removed. Never throws.
 */
export function sweepPrivateConfigDirs(o: {
	agentDir: string;
	sessionDirs: string[];
	current?: { key: string; recorded: (workerId: string) => boolean };
	keep: (key: string) => boolean;
	now?: number;
	alive?: (pid: number) => boolean;
}): string[] {
	const root = path.join(o.agentDir, "sova", "sandbox", "claude");
	let names: string[];
	try { names = fs.readdirSync(root); } catch { return []; }
	const now = o.now ?? Date.now();
	let sessionFiles: Set<string> | undefined;
	const sessionExists = (id: string): boolean => {
		if (!sessionFiles) {
			sessionFiles = new Set();
			for (const dir of o.sessionDirs) {
				let entries: fs.Dirent[] = [];
				try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
				for (const entry of entries) {
					const names = entry.isDirectory() ? (() => { try { return fs.readdirSync(path.join(dir, entry.name)); } catch { return []; } })() : [entry.name];
					for (const name of names) { const m = /_([^_/]+)\.jsonl$/.exec(name); if (m) sessionFiles.add(m[1]!); }
				}
			}
		}
		return sessionFiles.has(id);
	};
	const alive = o.alive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } });
	const removed: string[] = [];
	for (const key of names) {
		const m = /^(.+)-(ag_\d+)$/.exec(key);
		if (!m || o.keep(key)) continue;
		const dir = path.join(root, key);
		let touched = 0;
		for (const p of [dir, path.join(dir, ".claude.json"), path.join(dir, "sessions")]) {
			try { touched = Math.max(touched, fs.statSync(p).mtimeMs); } catch { /* absent */ }
		}
		if (now - touched < PRIVATE_DIR_IDLE_MS) continue;
		const [, owner, workerId] = m;
		const unsaved = /^unsaved-(\d+)-/.exec(owner!);
		const gone = owner === o.current?.key ? !o.current.recorded(workerId!)
			: unsaved ? !alive(Number(unsaved[1])) : !sessionExists(owner!);
		if (!gone) continue;
		try { fs.rmSync(dir, { recursive: true, force: true }); removed.push(key); } catch { /* next time */ }
	}
	return removed;
}

/** Probes that passed, per platform, launch module and executable: a confined `--version` once per process. */
const probed = new Set<string>();
/**
 * The launch gate (§chat.sandbox/workers; the macOS rule): before the first confined launch of an
 * executable, run it confined with `--version` and require a version line; fail closed. Only a pass is
 * cached (a failure is tried again at the next launch). Resolves undefined when it passed, else why not.
 */
export async function confinedVersionProbe(o: {
	module: LaunchModule;
	moduleFile: string;
	scope: string;
	needs: LaunchNeeds;
	command: string;
	cwd: string;
	env: Record<string, string>;
	timeoutMs?: number;
}): Promise<string | undefined> {
	const key = `${process.platform}\u0000${o.moduleFile}\u0000${o.command}`;
	if (probed.has(key)) return undefined;
	const { fds: _fds, ...needs } = o.needs;
	let confined: Awaited<ReturnType<LaunchModule["confineLaunch"]>>;
	try { confined = await o.module.confineLaunch(o.scope, needs, { command: o.command, args: ["--version"], cwd: o.cwd, env: o.env }); }
	catch (error) { return `the confined launch probe could not be set up (${(error as Error).message})`; }
	if ("refused" in confined) return confined.refused;
	const verdict = await new Promise<string | undefined>((resolve) => {
		const stdio: ("pipe" | "ignore")[] = ["ignore", "pipe", "pipe"];
		for (const { fd } of confined.fds) { while (stdio.length < fd) stdio.push("ignore"); stdio[fd] = "pipe"; }
		let out = "";
		let child: ReturnType<typeof spawn>;
		try { child = spawn(confined.command, confined.args, { cwd: o.cwd, env: confined.spawnEnv, stdio, detached: process.platform !== "win32" }); }
		catch (error) { resolve(`the confined launch probe failed to start (${(error as Error).message})`); return; }
		for (const { fd, data } of confined.fds) {
			const pipe = child.stdio[fd] as NodeJS.WritableStream | null;
			pipe?.on("error", () => { /* the exit reports it */ });
			pipe?.end(data);
		}
		const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, o.timeoutMs ?? 20_000);
		child.stdout?.on("data", (chunk: Buffer) => { if (out.length < 4096) out += chunk.toString("utf8"); });
		child.on("error", (error) => { clearTimeout(timer); resolve(`the confined launch probe failed to start (${error.message})`); });
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolve(code === 0 && /\d+\.\d+\.\d+/.test(out) ? undefined : `a confined \`${path.basename(o.command)} --version\` did not run (${signal ?? `exit ${code}`})`);
		});
	});
	try { await confined.cleanup(); } catch { /* the proxy is gone either way */ }
	if (verdict === undefined) probed.add(key);
	return verdict;
}
/** @internal Forget the passed probes (tests). */
export function resetVersionProbes(): void { probed.clear(); }
