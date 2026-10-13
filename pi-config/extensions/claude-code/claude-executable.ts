/**
 * Which Claude program every `claude` spawn runs. Builtins only: the server imports it.
 *
 * Resolved from the host's own environment, never from a chat's or worker's cwd. A bare `claude`
 * spawned in a project's folder went through PATH, where a mise shim picks the version per
 * directory: a project whose mise config names another claude (or none) changed or broke the
 * program that ran ("No version is set for shim: claude").
 *
 * Order:
 *   1. The first executable `claude` in an absolute directory of the host's PATH. A mise shim there
 *      is resolved to the program it stands for with `mise which claude`, asked from the host's cwd,
 *      then from this module's own directory (Sova's tree); a shim neither resolves is skipped.
 *   2. `~/.local/bin/claude`, where Claude Code's installer puts it.
 *
 * The path is kept as found, not followed through its link: the installer's link moves on update,
 * and the next launch should run the new version. The answer is cached per PATH and home, and
 * looked up again once it stops being executable.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const CLAUDE_PROGRAM = "claude";

/** Everything the resolver reads from the host, injectable for tests. */
export interface ClaudeExecutableHost {
	env: NodeJS.ProcessEnv;
	/** The home whose `.local/bin` is the fallback. */
	home: string;
	/** The host's cwd, where a mise shim is resolved first (never a chat's). */
	cwd: string;
	/** The directory a shim is resolved from next (this module's own: Sova's tree). */
	moduleDir: string;
	/** `mise which <name>` run in `cwd` with `mise` the given binary; undefined when it fails. */
	miseWhich?: (mise: string, name: string, cwd: string, env: NodeJS.ProcessEnv) => string | undefined;
}

export type ClaudeExecutableResult = { path: string } | { error: string };

function isExecutable(file: string): boolean {
	try {
		if (!fs.statSync(file).isFile()) return false;
		fs.accessSync(file, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function realpath(file: string): string {
	try {
		return fs.realpathSync(file);
	} catch {
		return file;
	}
}

/** A mise shim is a link to the mise binary itself. */
function isMiseShim(file: string): boolean {
	return /^mise(\.exe)?$/i.test(path.basename(realpath(file)));
}

function defaultMiseWhich(mise: string, name: string, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
	try {
		const out = execFileSync(mise, ["which", name], { cwd, env, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
		return out && path.isAbsolute(out) ? out : undefined;
	} catch {
		return undefined;
	}
}

function pathDirs(env: NodeJS.ProcessEnv): string[] {
	return (env.PATH ?? "").split(path.delimiter).filter((dir) => dir && path.isAbsolute(dir));
}

function candidateNames(env: NodeJS.ProcessEnv): string[] {
	return process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD").split(";").map((ext) => CLAUDE_PROGRAM + ext) : [CLAUDE_PROGRAM];
}

/** The Claude program as `host` finds it, or the plain-words reason it found none. Never throws. */
export function resolveClaudeExecutable(host: ClaudeExecutableHost): ClaudeExecutableResult {
	const dirs = pathDirs(host.env);
	for (const dir of dirs) {
		for (const name of candidateNames(host.env)) {
			const file = path.join(dir, name);
			if (!isExecutable(file)) continue;
			if (!isMiseShim(file)) return { path: file };
			for (const from of new Set([host.cwd, host.moduleDir])) {
				const real = (host.miseWhich ?? defaultMiseWhich)(realpath(file), CLAUDE_PROGRAM, from, host.env);
				if (real && isExecutable(real) && !isMiseShim(real)) return { path: real };
			}
		}
	}
	const fallback = path.join(host.home, ".local", "bin", CLAUDE_PROGRAM);
	if (isExecutable(fallback)) return { path: fallback };
	const looked = dirs.length ? dirs.join(path.delimiter) : "(empty)";
	return { error: `Claude program not found: no \`${CLAUDE_PROGRAM}\` on Sova's PATH (${looked}) or at ${fallback}. Install Claude Code, or start Sova with it on its PATH.` };
}

const cache = new Map<string, string>();

/**
 * This process's Claude program, an absolute path. Throws the not-found reason as an Error.
 * `env` is the environment the lookup reads (the host's own by default), never a child's.
 */
export function claudeExecutable(env: NodeJS.ProcessEnv = process.env): string {
	const home = os.homedir();
	const key = `${env.PATH ?? ""}\0${home}`;
	const kept = cache.get(key);
	if (kept && isExecutable(kept)) return kept;
	const found = resolveClaudeExecutable({ env, home, cwd: process.cwd(), moduleDir: path.dirname(fileURLToPath(import.meta.url)) });
	if ("error" in found) {
		cache.delete(key);
		throw new Error(found.error);
	}
	cache.set(key, found.path);
	return found.path;
}

/** @internal Tests: forget every kept answer. */
export function resetClaudeExecutable(): void {
	cache.clear();
}
